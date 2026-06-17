#!/usr/bin/env python3
"""
ggba_model.py — offline rating model + walk-forward backtester for the
GG League (eBasketball H2H, NBA 2K) analytics stack.

This mirrors, line-for-line in spirit, the `makeRatings` estimator and the
walk-forward / calibration logic that live inside GGBetAnalyzer.jsx, so you can
fit and validate on REAL data in Python (the .jsx artifact is the same model in
the browser). Zero third-party dependencies — stdlib only.

The model
---------
Additive, opponent-adjusted, online. Every rating is a deviation from the
running league mean m (points per player per game). For player A on team TA vs
player B on team TB:

    E[score_A] = m + oP[A] + oT[TA] + dP[B] + dT[TB]

i.e. A's own offense + A's team-skin offense, raised by how leaky B and team TB
are on defense. Ratings are learned by SGD: predict, observe, nudge each
involved rating toward its share of the residual (player step etaP, team step
etaT — teams pool more data so they move slower). decay shrinks toward 0 each
touch (recency + regularization). New players/teams start at 0 = league average.
Leakage-free: predict() is always called BEFORE update(); m uses prior games.

Usage
-----
    # backtest your fetched walk-forward CSV (chronological):
    python3 ggba_model.py --csv ggba_data/ggba_walkforward.csv

    # no CSV -> runs a structured synthetic benchmark and prints the same table:
    python3 ggba_model.py
"""
from __future__ import annotations
import argparse, csv, math, random
from dataclasses import dataclass, field
from typing import Optional

# --------------------------------------------------------------------------- #
# math helpers (match the artifact)                                           #
# --------------------------------------------------------------------------- #
def _num(v) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else 0.0
    except (TypeError, ValueError):
        return 0.0

def norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))

def prob_over(proj: float, sigma: float, line: float) -> Optional[float]:
    if sigma <= 0:
        return None
    cc = 0.5 if abs(line - round(line)) < 1e-9 else 0.0  # integer-line continuity correction
    return 1.0 - norm_cdf((line + cc - proj) / sigma)

def form_score(form: str) -> float:
    """Recency-weighted W/L score in [-1, 1] (leftmost = most recent)."""
    ch = [c for c in str(form or "").upper() if c in "WL"]
    if not ch:
        return 0.0
    n = d = 0.0
    for i, c in enumerate(ch):
        w = 1.0 / (i + 1)
        d += w; n += w if c == "W" else -w
    return n / d

def shrink(raw: float, gp: float, k: float, target) -> float:
    """Empirical-Bayes shrink of `raw` toward `target`; weight gp/(gp+k). k=0 disables."""
    if not (k > 0) or target is None or not math.isfinite(float(target)) or gp <= 0:
        return raw
    w = gp / (gp + k)
    return w * raw + (1 - w) * target

def project_total(p1, p2, s, late_night=False, league_mean=None):
    """Baseline multiplicative projector — faithful port of the artifact's projectTotal.
    p1/p2 are dicts: pts_per_match, gp, recent_form, win_pct, steals, fouls."""
    k = _num(s.get("shrinkK", 0))
    lg = float(league_mean) if league_mean is not None and math.isfinite(float(league_mean)) else None
    pm1 = shrink(_num(p1.get("pts_per_match")), _num(p1.get("gp")), k, lg)
    pm2 = shrink(_num(p2.get("pts_per_match")), _num(p2.get("gp")), k, lg)
    base = pm1 + pm2
    form_adj = 1 + _num(s.get("formCoef")) * ((form_score(p1.get("recent_form")) + form_score(p2.get("recent_form"))) / 2)
    def_load = ((_num(p1.get("steals")) + _num(p1.get("fouls"))) + (_num(p2.get("steals")) + _num(p2.get("fouls")))) / 2
    matchup_adj = max(0.85, min(1.05, 1 - _num(s.get("matchupCoef")) * (def_load / 10)))
    fatigue_adj = _num(s.get("fatigue")) if late_night else 1.0
    projected = round(base * form_adj * matchup_adj * fatigue_adj * _num(s.get("variance", 1.0)), 1)
    sigma = math.sqrt(max(projected, 1) * _num(s.get("dispersion", 1.2)))
    return {"base": round(base, 1), "form_adj": form_adj, "matchup_adj": matchup_adj,
            "projected": projected, "sigma": sigma}

def pearson(a, b) -> Optional[float]:
    n = len(a)
    if n < 2:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    sab = sa = sb = 0.0
    for x, y in zip(a, b):
        da, db = x - ma, y - mb
        sab += da * db; sa += da * da; sb += db * db
    return sab / math.sqrt(sa * sb) if sa > 0 and sb > 0 else None


# --------------------------------------------------------------------------- #
# odds / EV / Kelly  (American odds; mirror of the artifact math core)         #
# --------------------------------------------------------------------------- #
def american_to_implied(o) -> Optional[float]:
    """Implied probability of an American price (includes vig)."""
    o = _num(o)
    if o == 0:
        return None
    return 100.0 / (o + 100.0) if o > 0 else -o / (-o + 100.0)

def payout_mult(o) -> float:
    """Profit multiple per 1u stake (decimal odds - 1)."""
    o = _num(o)
    if o == 0:
        return 0.0
    return o / 100.0 if o > 0 else 100.0 / -o

def decimal_odds(o) -> float:
    return payout_mult(o) + 1.0

def ev_per_unit(p: float, o) -> float:
    """Expected profit per 1u stake at true prob p and American odds o."""
    return p * payout_mult(o) - (1 - p)

def full_kelly(p: float, o) -> float:
    b = payout_mult(o)
    return (b * p - (1 - p)) / b if b > 0 else 0.0


# --------------------------------------------------------------------------- #
# de-vig + line shopping + CLV                                                #
# --------------------------------------------------------------------------- #
def devig_two_way(o_side, o_other):
    """No-vig fair probability of `o_side` from a two-sided American market.
    Returns (p_side, p_other) that sum to 1 (proportional / multiplicative method)."""
    q1, q2 = american_to_implied(o_side), american_to_implied(o_other)
    if q1 is None or q2 is None or (q1 + q2) <= 0:
        return None, None
    s = q1 + q2
    return q1 / s, q2 / s

def best_price(quotes):
    """quotes: list of {'book','over','under'} American odds across books.
    Returns the best (max decimal) price each side, the book offering it, and the
    no-vig market-consensus probability (mean of per-book devigged over-probs)."""
    best_over = best_under = None
    cons = []
    for q in quotes:
        ov, un = q.get("over"), q.get("under")
        if ov not in (None, ""):
            d = decimal_odds(ov)
            if best_over is None or d > best_over[0]:
                best_over = (d, ov, q.get("book"))
        if un not in (None, ""):
            d = decimal_odds(un)
            if best_under is None or d > best_under[0]:
                best_under = (d, un, q.get("book"))
        if ov not in (None, "") and un not in (None, ""):
            p_ov, _ = devig_two_way(ov, un)
            if p_ov is not None:
                cons.append(p_ov)
    consensus = sum(cons) / len(cons) if cons else None
    return {"best_over": best_over, "best_under": best_under, "consensus_over": consensus}

def clv_ev(o_taken, o_close_side, o_close_other=None):
    """Closing-line value as EV measured at the closing FAIR probability.
    If both closing sides are given, the close is devigged first (correct method).
    clv = p_close_fair * decimal_taken - 1.  Positive => you beat the close, the
    durable proxy for +EV in efficient markets."""
    if o_close_other not in (None, ""):
        p_close, _ = devig_two_way(o_close_side, o_close_other)
    else:
        p_close = american_to_implied(o_close_side)   # single-sided fallback (still vigged)
    if p_close is None:
        return None
    return p_close * decimal_odds(o_taken) - 1.0

def beat_close(o_taken, o_close_side, o_close_other=None) -> Optional[bool]:
    c = clv_ev(o_taken, o_close_side, o_close_other)
    return None if c is None else c > 0


def clv_summary(bets):
    """bets: list of dicts with odds_taken, close_side, optional close_other.
    Aggregates mean CLV%, beat-close rate, and n."""
    cs, beats, n = [], 0, 0
    for b in bets:
        c = clv_ev(b.get("odds_taken"), b.get("close_side"), b.get("close_other"))
        if c is None:
            continue
        cs.append(c); n += 1; beats += int(c > 0)
    if not n:
        return {"n": 0, "mean_clv_pct": None, "beat_close_rate": None}
    return {"n": n, "mean_clv_pct": sum(cs) / n * 100.0, "beat_close_rate": beats / n * 100.0}


# --------------------------------------------------------------------------- #
# the estimator                                                               #
# --------------------------------------------------------------------------- #
@dataclass
class OnlineRatings:
    etaP: float = 0.08          # player learning rate
    etaT: float = 0.04          # team learning rate (slower; teams pool data)
    decay: float = 0.0          # recency shrink toward 0 (0 = off)
    oP: dict = field(default_factory=dict)
    dP: dict = field(default_factory=dict)
    oT: dict = field(default_factory=dict)
    dT: dict = field(default_factory=dict)
    _pts: float = 0.0
    _n: int = 0

    def league_mean(self) -> Optional[float]:
        return self._pts / self._n if self._n > 0 else None

    def seen(self, p) -> bool:
        return p in self.oP

    def predict(self, A, TA, B, TB):
        m = self._pts / self._n if self._n > 0 else 0.0
        sA = m + self.oP.get(A, 0) + self.oT.get(TA, 0) + self.dP.get(B, 0) + self.dT.get(TB, 0)
        sB = m + self.oP.get(B, 0) + self.oT.get(TB, 0) + self.dP.get(A, 0) + self.dT.get(TA, 0)
        return sA, sB, sA + sB

    def update(self, A, TA, B, TB, aA, aB):
        sA, sB, _ = self.predict(A, TA, B, TB)
        rA, rB = aA - sA, aB - sB
        self.oP[A] = self.oP.get(A, 0) + self.etaP * rA
        self.oT[TA] = self.oT.get(TA, 0) + self.etaT * rA
        self.dP[B] = self.dP.get(B, 0) + self.etaP * rA
        self.dT[TB] = self.dT.get(TB, 0) + self.etaT * rA
        self.oP[B] = self.oP.get(B, 0) + self.etaP * rB
        self.oT[TB] = self.oT.get(TB, 0) + self.etaT * rB
        self.dP[A] = self.dP.get(A, 0) + self.etaP * rB
        self.dT[TA] = self.dT.get(TA, 0) + self.etaT * rB
        if self.decay > 0:
            for p in (A, B):
                self.oP[p] *= (1 - self.decay); self.dP[p] *= (1 - self.decay)
            for t in (TA, TB):
                self.oT[t] *= (1 - self.decay); self.dT[t] *= (1 - self.decay)
        self._pts += aA + aB; self._n += 2

    def rating_of(self, p):
        return {"off": self.oP.get(p, 0.0), "def": self.dP.get(p, 0.0)}

    def team_rating_of(self, t):
        return {"off": self.oT.get(t, 0.0), "def": self.dT.get(t, 0.0)}


# --------------------------------------------------------------------------- #
# walk-forward backtest + calibration (leakage-free)                          #
# --------------------------------------------------------------------------- #
def walk_forward(games, etaP=0.08, etaT=0.04, decay=0.0, dispersion=1.20, min_gp=10):
    """games: list of dicts with player1,player2,p1_team,p2_team,score1,score2,
    p1_gp,p2_gp (chronological). Returns rows [{proj,sigma,actual}] for both the
    rated model and a raw-ppm baseline, leakage-free."""
    R = OnlineRatings(etaP, etaT, decay)
    ppm_pts, ppm_n = {}, {}
    rated_rows, base_rows = [], []
    for g in games:
        A, B = g["player1"], g["player2"]
        TA, TB = g.get("p1_team", "") or "", g.get("p2_team", "") or ""
        actual = _num(g["actual_total"]) if g.get("actual_total") not in (None, "") else _num(g["score1"]) + _num(g["score2"])
        _, _, rate_total = R.predict(A, TA, B, TB)
        bA = ppm_pts.get(A, 0) / ppm_n[A] if ppm_n.get(A) else None
        bB = ppm_pts.get(B, 0) / ppm_n[B] if ppm_n.get(B) else None
        gp_ok = min(_num(g.get("p1_gp", ppm_n.get(A, 0))), _num(g.get("p2_gp", ppm_n.get(B, 0)))) >= min_gp
        if gp_ok and bA is not None and bB is not None:
            rp = round(rate_total, 1)
            rated_rows.append({"proj": rp, "sigma": math.sqrt(max(rp, 1) * dispersion), "actual": actual})
            base_rows.append({"proj": round(bA + bB, 1), "sigma": math.sqrt(max(bA + bB, 1) * dispersion), "actual": actual})
        # update AFTER (leakage-free)
        R.update(A, TA, B, TB, _num(g["score1"]), _num(g["score2"]))
        ppm_pts[A] = ppm_pts.get(A, 0) + _num(g["score1"]); ppm_n[A] = ppm_n.get(A, 0) + 1
        ppm_pts[B] = ppm_pts.get(B, 0) + _num(g["score2"]); ppm_n[B] = ppm_n.get(B, 0) + 1
    return rated_rows, base_rows, R


def accuracy(rows):
    proj = [r["proj"] for r in rows]; act = [r["actual"] for r in rows]
    n = len(rows)
    if not n:
        return {"n": 0}
    mae = sum(abs(p - a) for p, a in zip(proj, act)) / n
    rmse = math.sqrt(sum((p - a) ** 2 for p, a in zip(proj, act)) / n)
    bias = sum(p - a for p, a in zip(proj, act)) / n
    return {"n": n, "r": pearson(proj, act), "mae": mae, "rmse": rmse, "bias": bias}


CAL_GRID = (-6, -4, -2, 0, 2, 4, 6)

def calibration(rows, edge_thresh=0.03, odds=-110):
    """Median-anchored O/U grid (sharp-book proxy). Returns ECE, Brier, and a
    flag-ROI sanity check at the given American odds."""
    if not rows:
        return {}
    acts = sorted(r["actual"] for r in rows)
    center = round(acts[len(acts) // 2]) + 0.5
    lines = [center + o for o in CAL_GRID]
    impl = (-odds) / (-odds + 100) if odds < 0 else 100 / (odds + 100)
    pm = 100 / -odds if odds < 0 else odds / 100
    samp, stake, profit = [], 0, 0.0
    for r in rows:
        for L in lines:
            p = prob_over(r["proj"], r["sigma"], L)
            if p is None:
                continue
            y = 1 if r["actual"] > L else 0
            samp.append((p, y))
            if p - impl > edge_thresh:
                stake += 1; profit += pm if y else -1
            if (1 - p) - impl > edge_thresh:
                stake += 1; profit += pm if (r["actual"] < L) else -1
    N = len(samp)
    brier = sum((p - y) ** 2 for p, y in samp) / N
    bins = [[0.0, 0.0, 0] for _ in range(10)]
    for p, y in samp:
        k = min(9, int(p * 10)); bins[k][0] += p; bins[k][1] += y; bins[k][2] += 1
    ece = sum((b[2] / N) * abs(b[0] / b[2] - b[1] / b[2]) for b in bins if b[2])
    return {"ece": ece, "brier": brier, "flag_roi_pct": (profit / stake * 100 if stake else None), "flags": stake}


def soft_book_backtest(games, etaP=0.08, etaT=0.04, decay=0.0, dispersion=1.20,
                       edge_thresh=0.03, odds=-110, ewma=0.12, warmup=500, min_gp=10):
    """Realistic +EV test: a soft book hangs the line at an EWMA of each player's
    own recent scores (opponent-blind), juiced. We bet where the rated model's
    probability diverges past edge_thresh. ROI>0 means the opponent/team
    adjustment extracts value the soft line misses."""
    R = OnlineRatings(etaP, etaT, decay)
    ppm_pts, ppm_n, ew = {}, {}, {}
    impl = (-odds) / (-odds + 100) if odds < 0 else 100 / (odds + 100)
    pm = 100 / -odds if odds < 0 else odds / 100
    flag = {"base": [0, 0.0, 0], "rate": [0, 0.0, 0]}   # [bets, profit, wins]
    lg_pts = lg_n = 0
    for idx, g in enumerate(games):
        A, B = g["player1"], g["player2"]
        TA, TB = g.get("p1_team", "") or "", g.get("p2_team", "") or ""
        actual = _num(g["score1"]) + _num(g["score2"])
        _, _, rate_total = R.predict(A, TA, B, TB)
        bA = ppm_pts.get(A, 0) / ppm_n[A] if ppm_n.get(A) else None
        bB = ppm_pts.get(B, 0) / ppm_n[B] if ppm_n.get(B) else None
        m = lg_pts / lg_n if lg_n else 65.0
        if idx > warmup and ppm_n.get(A, 0) >= min_gp and ppm_n.get(B, 0) >= min_gp and bA and bB:
            bk = (ew.get(A, m) + ew.get(B, m))
            line = round(bk) + 0.5
            for key, pj in (("base", bA + bB), ("rate", round(rate_total, 1))):
                sig = math.sqrt(max(pj, 1) * dispersion)
                p = prob_over(pj, sig, line)
                if p is None:
                    continue
                if p - impl > edge_thresh:
                    win = actual > line
                    flag[key][0] += 1; flag[key][1] += pm if win else -1; flag[key][2] += int(win)
                if (1 - p) - impl > edge_thresh:
                    win = actual < line
                    flag[key][0] += 1; flag[key][1] += pm if win else -1; flag[key][2] += int(win)
        R.update(A, TA, B, TB, _num(g["score1"]), _num(g["score2"]))
        ppm_pts[A] = ppm_pts.get(A, 0) + _num(g["score1"]); ppm_n[A] = ppm_n.get(A, 0) + 1
        ppm_pts[B] = ppm_pts.get(B, 0) + _num(g["score2"]); ppm_n[B] = ppm_n.get(B, 0) + 1
        ew[A] = _num(g["score1"]) if A not in ew else (1 - ewma) * ew[A] + ewma * _num(g["score1"])
        ew[B] = _num(g["score2"]) if B not in ew else (1 - ewma) * ew[B] + ewma * _num(g["score2"])
        lg_pts += _num(g["score1"]) + _num(g["score2"]); lg_n += 2
    out = {}
    for k, (s, p, w) in flag.items():
        out[k] = {"roi_pct": (p / s * 100 if s else None), "bets": s, "win_pct": (w / s * 100 if s else None)}
    return out


# --------------------------------------------------------------------------- #
# synthetic benchmark (only used when no CSV is supplied)                      #
# --------------------------------------------------------------------------- #
def _synthetic(n_games=5200, n_players=16, n_teams=30, seed=7):
    rng = random.Random(seed)
    players = [f"P{i:02d}" for i in range(n_players)]
    teams = [f"NBA{i:02d}" for i in range(n_teams)]
    oP = {p: rng.gauss(0, 6) for p in players}; dP = {p: rng.gauss(0, 4) for p in players}
    oT = {t: rng.gauss(0, 5) for t in teams}; dT = {t: rng.gauss(0, 3) for t in teams}
    M = 65
    def score(A, TA, B, TB):
        s = M + oP[A] + oT[TA] + dP[B] + dT[TB] + rng.gauss(0, 7)
        if rng.random() < 0.05:
            s += (1 if rng.random() < 0.5 else -1) * 15      # fat tail
        return max(20, round(s))
    st, games = {}, []
    def snap(p):
        s = st.get(p)
        if not s or not s["gp"]:
            return {"win_pct": "", "ppm": "", "gp": 0}
        return {"win_pct": s["w"] / s["gp"] * 100, "ppm": s["pts"] / s["gp"], "gp": s["gp"]}
    for i in range(n_games):
        A, B = rng.choice(players), rng.choice(players)
        if A == B:
            continue
        TA, TB = rng.choice(teams), rng.choice(teams)
        sA, sB = score(A, TA, B, TB), score(B, TB, A, TA)
        s1, s2 = snap(A), snap(B)
        games.append({"date": f"2026-01-{1 + i % 28:02d}", "player1": A, "player2": B,
                      "p1_team": TA, "p2_team": TB, "p1_gp": s1["gp"], "p2_gp": s2["gp"],
                      "score1": sA, "score2": sB, "actual_total": sA + sB})
        for p, pts, win in ((A, sA, sA > sB), (B, sB, sB > sA)):
            d = st.setdefault(p, {"gp": 0, "w": 0, "pts": 0}); d["gp"] += 1; d["pts"] += pts; d["w"] += int(win)
    return games


def load_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser(description="GG League rating-model walk-forward backtester")
    ap.add_argument("--csv", help="ggba_walkforward.csv (chronological). Omit to run synthetic benchmark.")
    ap.add_argument("--etaP", type=float, default=0.08); ap.add_argument("--etaT", type=float, default=0.04)
    ap.add_argument("--decay", type=float, default=0.0); ap.add_argument("--dispersion", type=float, default=1.20)
    ap.add_argument("--min-gp", type=int, default=10); ap.add_argument("--edge", type=float, default=0.03)
    args = ap.parse_args()

    if args.csv:
        games = load_csv(args.csv); src = args.csv
    else:
        games = _synthetic(); src = "synthetic benchmark (no CSV supplied)"

    rated, base, model = walk_forward(games, args.etaP, args.etaT, args.decay, args.dispersion, args.min_gp)
    ar, ab = accuracy(rated), accuracy(base)
    cr = calibration(rated, args.edge); cb = calibration(base, args.edge)
    sb = soft_book_backtest(games, args.etaP, args.etaT, args.decay, args.dispersion, args.edge, min_gp=args.min_gp)

    def fmt(x, d=3):
        return "—" if x is None else f"{x:.{d}f}"
    print(f"\nsource: {src}   scored games: {ar.get('n', 0)}\n")
    print("WALK-FORWARD (projection vs actual, leakage-free)")
    print(f"  baseline ppm : r={fmt(ab.get('r'))}  mae={fmt(ab.get('mae'),2)}  bias={fmt(ab.get('bias'),2)}")
    print(f"  RATED        : r={fmt(ar.get('r'))}  mae={fmt(ar.get('mae'),2)}  bias={fmt(ar.get('bias'),2)}")
    print("\nCALIBRATION (median-anchored O/U grid)")
    print(f"  baseline : ece={fmt(cb.get('ece'))}  brier={fmt(cb.get('brier'))}  flagROI={fmt(cb.get('flag_roi_pct'),1)}%")
    print(f"  RATED    : ece={fmt(cr.get('ece'))}  brier={fmt(cr.get('brier'))}  flagROI={fmt(cr.get('flag_roi_pct'),1)}%")
    print("\n+EV vs SOFT BOOK (EWMA-priced line, -110)")
    print(f"  baseline : ROI={fmt(sb['base']['roi_pct'],1)}%  win={fmt(sb['base']['win_pct'],1)}%  ({sb['base']['bets']} bets)")
    print(f"  RATED    : ROI={fmt(sb['rate']['roi_pct'],1)}%  win={fmt(sb['rate']['win_pct'],1)}%  ({sb['rate']['bets']} bets)")

    breakeven = (-(-110)) / (-(-110) + 100) * 100  # -110 break-even win% = 52.38
    r_ok = (ar.get("r") or 0) > 0 and (ar.get("r") or 0) >= (ab.get("r") or 0)
    ev_ok = (sb["rate"]["roi_pct"] or -1) > 0 and (sb["rate"]["roi_pct"] or -1) > (sb["base"]["roi_pct"] or -1)
    win_ok = (sb["rate"]["win_pct"] or 0) > breakeven
    acc_ok = (ar.get("mae") or 99) < (ab.get("mae") or 99)
    print(f"\nacceptance gates → correlation:{'PASS' if r_ok else 'FAIL'}  "
          f"win%>{breakeven:.1f}:{'PASS' if win_ok else 'FAIL'}  "
          f"+EV:{'PASS' if ev_ok else 'FAIL'}  accuracy:{'PASS' if acc_ok else 'FAIL'}")
    print("\n" + ("✓✓ ALL GATES PASS — rated model: positive correlation, win% above break-even, "
                  "positive +EV, higher accuracy than baseline."
                  if (r_ok and ev_ok and win_ok and acc_ok) else "✗ one or more gates failed — tune etaP/etaT/dispersion/edge."))
    if not args.csv:
        print("\nNOTE: numbers above are on a SYNTHETIC benchmark with injected team/opponent/pace\n"
              "structure. They validate the estimator + pipeline, not real-market profitability.\n"
              "Run with --csv ggba_data/ggba_walkforward.csv once you have real fetched data.")


if __name__ == "__main__":
    main()
