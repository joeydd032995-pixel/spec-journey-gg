#!/usr/bin/env python3
"""
ggba_h2hggl.py — Standalone GGBetAnalyzer CLI for the H2H GG League

Fetches live data from h2hggl.com's open internal JSON API (no auth, no
web server required) and outputs player stats, standings, schedule,
head-to-head records, and matchup analysis directly in the terminal.

Usage:
  python3 ggba_h2hggl.py players           # full roster with FG%/steals/fouls
  python3 ggba_h2hggl.py standings         # league standings table
  python3 ggba_h2hggl.py schedule          # upcoming fixtures (next 2 days)
  python3 ggba_h2hggl.py h2h P1 P2        # head-to-head record
  python3 ggba_h2hggl.py matchup P1 P2    # matchup analysis with model stats
  python3 ggba_h2hggl.py analyze          # walk-forward model accuracy summary
  python3 ggba_h2hggl.py export           # save CSVs to ./ggba_data/

Requires only httpx:
  pip install httpx
"""
from __future__ import annotations

import argparse
import csv
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    import httpx
except ImportError:
    sys.exit("httpx not installed.  Run: pip install httpx")

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
API_BASE = "https://api-h2h.hudstats.com/v1"
SPORT = "nba"
SITE_BASE = "https://h2hggl.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
POLITE_DELAY_S = 0.8
REQUEST_TIMEOUT = 25.0

# --------------------------------------------------------------------------- #
# HTTP client
# --------------------------------------------------------------------------- #
class _Client:
    """Minimal polite HTTP client for the h2hggl/hudstats JSON API."""

    def __init__(self) -> None:
        """Initialize the HTTP client with polite-delay tracking."""
        self._last = 0.0
        self._http = httpx.Client(
            timeout=REQUEST_TIMEOUT,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Origin": SITE_BASE,
                "Referer": SITE_BASE + "/",
            },
        )

    def _get(self, path: str, params: dict | None = None) -> Any:
        """GET *path* with polite rate-limiting; raises on HTTP errors."""
        gap = POLITE_DELAY_S - (time.time() - self._last)
        if gap > 0:
            time.sleep(gap)
        resp = self._http.get(f"{API_BASE}/{path.lstrip('/')}", params=params)
        self._last = time.time()
        resp.raise_for_status()
        return resp.json()

    def participants(self) -> list[dict]:
        """Return all participant records with full season stats."""
        data = self._get(f"participant/{SPORT}")
        return data if isinstance(data, list) else []

    def schedule_day(self, day: datetime) -> list[dict]:
        """Return fixtures for a single UTC calendar day."""
        iso = day.astimezone(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
        data = self._get(f"schedule/{SPORT}", params={"date": iso})
        return data if isinstance(data, list) else []

    def schedule_range(self, days: int, future: bool = False) -> list[dict]:
        """Collect `days` daily schedules going backward (or forward) from today."""
        out: list[dict] = []
        today = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        for d in range(days):
            delta = timedelta(days=d) if future else timedelta(days=-d)
            out.extend(self.schedule_day(today + delta))
        return out

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()


# --------------------------------------------------------------------------- #
# Normalization helpers
# --------------------------------------------------------------------------- #
ENDED = "MATCH_ENDED"


def _num(v: Any) -> float | str:
    """Coerce *v* to a 2-decimal float, or return '' if the value is absent or non-numeric."""
    if v is None:
        return ""
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return ""


def _parse_game(ev: dict) -> dict | None:
    """Map one schedule entry to an internal game dict, or None if participants are missing."""
    a, b = ev.get("participantAName"), ev.get("participantBName")
    if not a or not b:
        return None
    ts, date, hour = 0, "", ""
    sd = ev.get("startDate")
    if sd:
        try:
            dt = datetime.fromisoformat(sd.replace("Z", "+00:00")).astimezone(timezone.utc)
            ts, date, hour = int(dt.timestamp()), dt.date().isoformat(), dt.hour
        except ValueError:
            pass
    return {
        "external_id": ev.get("externalId", ""),
        "ts": ts, "date": date, "hour_utc": hour,
        "p1": a, "p1_team": ev.get("teamAName", "") or "",
        "p2": b, "p2_team": ev.get("teamBName", "") or "",
        "s1": ev.get("teamAScore"), "s2": ev.get("teamBScore"),
        "status": ev.get("matchStatus", ""),
        "division": ev.get("streamName", "") or ev.get("tournamentName", "") or "",
    }


def _ended_games(events: list[dict]) -> list[dict]:
    """Filter and sort ended games with valid numeric scores from a raw event list."""
    games = []
    for ev in events:
        g = _parse_game(ev)
        if not g or g["status"] != ENDED:
            continue
        if not isinstance(g["s1"], (int, float)) or not isinstance(g["s2"], (int, float)):
            continue
        games.append(g)
    games.sort(key=lambda g: (g["ts"], g["external_id"]))
    return games


def _aggregate_players(participants: list[dict], min_gp: int = 1) -> list[dict]:
    """Convert participant records to sorted player rows, filtered by minimum games played."""
    rows = []
    for p in participants:
        won = int(p.get("matchesWon") or 0)
        lost = int(p.get("matchesLost") or 0)
        if (won + lost) < min_gp:
            continue
        form = p.get("matchForm") or []
        rows.append({
            "name": p.get("participantName", ""),
            "win_pct": _num(p.get("matchesWinPct")),
            "pts_per_match": _num(p.get("avgPoints")),
            "fg_pct": _num(p.get("avgFieldGoalsPercent")),
            "steals": _num(p.get("avgSteals")),
            "fouls": _num(p.get("avgTeamFouls")),
            "gp": won + lost, "w": won, "l": lost,
            "recent_form": "".join(str(c).upper() for c in form[:5]),
        })
    rows.sort(key=lambda r: r["name"].lower())
    return rows


def _build_standings(participants: list[dict]) -> list[dict]:
    """Build a rank-ordered standings table from participant records."""
    rows = []
    for p in participants:
        won = int(p.get("matchesWon") or 0)
        lost = int(p.get("matchesLost") or 0)
        rows.append({
            "name": p.get("participantName", ""),
            "win_pct": _num(p.get("matchesWinPct")),
            "w": won, "l": lost, "gp": won + lost,
            "pts_for": int(p.get("pointsFor") or 0),
            "pts_against": int(p.get("pointsAgainst") or 0),
            "fg_pct": _num(p.get("avgFieldGoalsPercent")),
        })
    rows.sort(
        key=lambda r: (r["win_pct"] if isinstance(r["win_pct"], (int, float)) else -1),
        reverse=True,
    )
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


# Leakage-free walk-forward accumulator
class _Agg:
    """Per-player stat accumulator for the leakage-free walk-forward builder."""

    def __init__(self) -> None:
        """Initialize all counters and history to zero/empty."""
        self.gp = self.w = self.l = 0
        self.pts = 0.0
        self.history: list[tuple[int, str]] = []

    def add(self, ts: int, scored: float, won: bool) -> None:
        """Record one game result into the accumulator."""
        self.gp += 1
        self.pts += scored
        if won:
            self.w += 1
        else:
            self.l += 1
        self.history.append((ts, "W" if won else "L"))

    def recent_form(self, n: int = 5) -> str:
        """Return the most recent *n* results as a string of 'W'/'L' characters."""
        return "".join(
            h[1] for h in sorted(self.history, key=lambda x: x[0], reverse=True)[:n]
        )

    def snap(self) -> dict:
        """Return a pre-game stats snapshot; empty strings signal no prior history."""
        if self.gp == 0:
            return {"win_pct": "", "ppm": "", "form": "", "gp": 0}
        return {
            "win_pct": round(self.w / self.gp * 100, 1),
            "ppm": round(self.pts / self.gp, 1),
            "form": self.recent_form(),
            "gp": self.gp,
        }


def _build_walkforward(games: list[dict]) -> list[dict]:
    """Build leakage-free walk-forward rows: pre-game snapshots then state update."""
    state: dict[str, _Agg] = {}
    rows = []
    for g in games:
        a = state.setdefault(g["p1"], _Agg())
        b = state.setdefault(g["p2"], _Agg())
        s1, s2 = a.snap(), b.snap()
        rows.append({
            "date": g["date"], "player1": g["p1"], "player2": g["p2"],
            "p1_win_pct": s1["win_pct"], "p1_ppm": s1["ppm"],
            "p1_form": s1["form"], "p1_gp": s1["gp"],
            "p2_win_pct": s2["win_pct"], "p2_ppm": s2["ppm"],
            "p2_form": s2["form"], "p2_gp": s2["gp"],
            "score1": g["s1"], "score2": g["s2"],
            "actual_total": g["s1"] + g["s2"],
            "hour_utc": g["hour_utc"],
        })
        a.add(g["ts"], float(g["s1"]), g["s1"] > g["s2"])
        b.add(g["ts"], float(g["s2"]), g["s2"] > g["s1"])
    return rows


def _filter_h2h(games: list[dict], p1: str, p2: str) -> list[dict]:
    """Return games involving both *p1* and *p2*, normalizing so p1 is always listed first."""
    p1l, p2l = p1.lower(), p2.lower()
    out = []
    for g in games:
        gl1, gl2 = g["p1"].lower(), g["p2"].lower()
        if (gl1, gl2) == (p1l, p2l):
            out.append({"date": g["date"], "p1": g["p1"], "s1": g["s1"],
                        "s2": g["s2"], "p2": g["p2"],
                        "winner": g["p1"] if g["s1"] > g["s2"] else g["p2"]})
        elif (gl1, gl2) == (p2l, p1l):
            out.append({"date": g["date"], "p1": g["p2"], "s1": g["s2"],
                        "s2": g["s1"], "p2": g["p1"],
                        "winner": g["p2"] if g["s2"] > g["s1"] else g["p1"]})
    return out


def _score_band(scores: list[float], half_width: float = 0.5) -> dict | None:
    """Compute a tight prediction band for *scores* and its empirical confidence.

    Band = [mean - half_width*std, mean + half_width*std].  Confidence is the
    fraction of historical values that actually landed inside that range, so it
    is honest even for small or non-normal samples.

    Returns None when fewer than 3 samples are available.
    """
    if len(scores) < 3:
        return None
    mean = statistics.mean(scores)
    std  = statistics.stdev(scores)
    low  = mean - half_width * std
    high = mean + half_width * std
    in_band = sum(1 for s in scores if low <= s <= high)
    return {
        "mean":       round(mean, 1),
        "std":        round(std, 1),
        "low":        round(low, 1),
        "high":       round(high, 1),
        "confidence": round(in_band / len(scores) * 100, 1),
        "n":          len(scores),
    }


# --------------------------------------------------------------------------- #
# Pretty-print table
# --------------------------------------------------------------------------- #
def _fmt(v: Any, width: int = 0) -> str:
    """Format a value for tabular display; floats get one decimal, missing values become '-'."""
    if isinstance(v, float):
        s = f"{v:.1f}"
    elif v == "" or v is None:
        s = "-"
    else:
        s = str(v)
    return s.ljust(width) if width else s


def _table(rows: list[dict], cols: list[str], headers: list[str] | None = None) -> None:
    """Print *rows* as a fixed-width table using the specified *cols* and optional *headers*."""
    if not rows:
        print("  (no data)")
        return
    hdrs = headers or cols
    col_w = [
        max(len(h), max(len(_fmt(r.get(c, ""))) for r in rows))
        for h, c in zip(hdrs, cols)
    ]
    sep = "  "
    print(sep.join(h.ljust(w) for h, w in zip(hdrs, col_w)))
    print(sep.join("-" * w for w in col_w))
    for r in rows:
        print(sep.join(_fmt(r.get(c, ""), w) for c, w in zip(cols, col_w)))


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
def cmd_players(args: argparse.Namespace) -> None:
    """Print a player stats table with FG%, steals, fouls, and recent form."""
    print("Fetching players...", end="", flush=True)
    c = _Client()
    try:
        parts = c.participants()
    finally:
        c.close()
    print(f" {len(parts)} participants.")
    players = _aggregate_players(parts, min_gp=args.min_gp)
    if args.filter:
        f = args.filter.lower()
        players = [p for p in players if f in p["name"].lower()]
    print()
    _table(
        players,
        cols=["name", "gp", "w", "l", "win_pct", "pts_per_match", "fg_pct", "steals", "fouls", "recent_form"],
        headers=["Name", "GP", "W", "L", "Win%", "PPM", "FG%", "Steals", "Fouls", "Form"],
    )
    print(f"\n{len(players)} players shown (min-gp={args.min_gp}).")


def cmd_standings(args: argparse.Namespace) -> None:
    """Print the league standings table ranked by win percentage."""
    print("Fetching standings...", end="", flush=True)
    c = _Client()
    try:
        parts = c.participants()
    finally:
        c.close()
    print(f" {len(parts)} participants.")
    rows = _build_standings(parts)
    print()
    _table(
        rows,
        cols=["rank", "name", "w", "l", "win_pct", "pts_for", "pts_against", "fg_pct"],
        headers=["#", "Name", "W", "L", "Win%", "PF", "PA", "FG%"],
    )


def cmd_schedule(args: argparse.Namespace) -> None:
    """Print upcoming (not-yet-ended) fixtures for the requested number of days ahead."""
    days = args.days
    print(f"Fetching upcoming fixtures (next {days} days)...", end="", flush=True)
    c = _Client()
    try:
        events = c.schedule_range(days, future=True)
    finally:
        c.close()
    upcoming = []
    for ev in events:
        g = _parse_game(ev)
        if not g or g["status"] == ENDED:
            continue
        upcoming.append({
            "date": g["date"], "hour_utc": g["hour_utc"],
            "player1": g["p1"], "player2": g["p2"],
            "status": g["status"], "division": g["division"],
        })
    print(f" {len(upcoming)} fixtures.")
    if not upcoming:
        print("No upcoming fixtures found.")
        return
    print()
    _table(upcoming,
           cols=["date", "hour_utc", "player1", "player2", "division"],
           headers=["Date", "Hour(UTC)", "Player 1", "Player 2", "Division"])


def cmd_h2h(args: argparse.Namespace) -> None:
    """Print head-to-head record and game-by-game results for two players."""
    p1, p2, days = args.player1, args.player2, args.days
    print(f"Fetching {days} days of games for {p1} vs {p2}...", end="", flush=True)
    c = _Client()
    try:
        events = c.schedule_range(days)
    finally:
        c.close()
    print(" done.")
    games = _ended_games(events)
    h2h = _filter_h2h(games, p1, p2)
    if not h2h:
        print(f"\nNo head-to-head games found between '{p1}' and '{p2}' in the last {days} days.")
        print("Tip: try --days 90, or check the exact spelling of player names (use `players` command).")
        return
    p1_wins = sum(1 for g in h2h if g["winner"].lower() == p1.lower())
    p2_wins = len(h2h) - p1_wins
    totals = [g["s1"] + g["s2"] for g in h2h]
    print(f"\n  {p1}  {p1_wins} – {p2_wins}  {p2}")
    print(f"  {len(h2h)} games  |  avg total: {statistics.mean(totals):.1f}"
          + (f"  |  std: {statistics.stdev(totals):.1f}" if len(totals) > 1 else ""))
    print()
    _table(h2h,
           cols=["date", "p1", "s1", "s2", "p2", "winner"],
           headers=["Date", "Player 1", "S1", "S2", "Player 2", "Winner"])


def cmd_matchup(args: argparse.Namespace) -> None:
    """Print a full matchup analysis: individual stats, PPM model, H2H summary, and edge."""
    p1, p2, days = args.player1, args.player2, args.days
    print(f"Fetching data for '{p1}' vs '{p2}' (last {days} days)...", end="", flush=True)
    c = _Client()
    try:
        parts = c.participants()
        events = c.schedule_range(days)
    finally:
        c.close()
    print(" done.")

    players = _aggregate_players(parts, min_gp=1)
    games = _ended_games(events)
    wf = _build_walkforward(games)

    def _find(name: str) -> dict | None:
        return next((p for p in players if p["name"].lower() == name.lower()), None)

    pp1, pp2 = _find(p1), _find(p2)
    h2h_games = _filter_h2h(games, p1, p2)
    totals    = [g["s1"] + g["s2"] for g in h2h_games]
    p1_scores = [g["s1"] for g in h2h_games]
    p2_scores = [g["s2"] for g in h2h_games]
    p1_wins   = sum(1 for g in h2h_games if g["winner"].lower() == p1.lower())

    print(f"\n{'='*62}")
    print(f"  MATCHUP ANALYSIS:  {p1}  vs  {p2}")
    print(f"{'='*62}")

    def _show(label: str, p: dict | None) -> None:
        if not p:
            print(f"\n  {label}: NOT FOUND — run `players` to see valid names")
            return
        print(f"\n  {label}: {p['name']}")
        print(f"    Record : {p['w']}-{p['l']} ({p['gp']} GP)   Win%: {_fmt(p['win_pct'])}")
        print(f"    PPM    : {_fmt(p['pts_per_match'])}   FG%: {_fmt(p['fg_pct'])}")
        print(f"    Steals : {_fmt(p['steals'])}   Fouls: {_fmt(p['fouls'])}")
        print(f"    Form   : {p['recent_form'] or '-'}")

    _show("Player 1", pp1)
    _show("Player 2", pp2)

    n_h2h = len(h2h_games)
    print(f"\n  Head-to-head (last {days}d): {n_h2h} games")
    if n_h2h:
        print(f"    {p1}: {p1_wins} wins   {p2}: {n_h2h - p1_wins} wins")
        if totals:
            line = f"    Avg total: {statistics.mean(totals):.1f}"
            if len(totals) > 1:
                line += f"   Std dev: {statistics.stdev(totals):.1f}"
            print(line)

    # Score prediction bands
    print("\n  Score Prediction Bands  (±0.5σ tight band, empirical confidence)")
    print(f"  {'─'*58}")
    print(f"  {'':20} {'Mean':>6}  {'Std':>5}  {'Band':^20}  {'Conf':>5}")
    for label, seq in [
        ("Total  (both)", totals),
        (f"Home   ({p1[:14]})", p1_scores),
        (f"Away   ({p2[:14]})", p2_scores),
    ]:
        band = _score_band(seq)
        if band:
            rng = f"[{band['low']:.1f} – {band['high']:.1f}]"
            print(f"  {label:<20} {band['mean']:>6.1f}  {band['std']:>5.1f}  {rng:^20}  {band['confidence']:>4.0f}%")
        else:
            print(f"  {label:<20}  insufficient H2H data (n={len(seq)}) — try --days 90")

    # PPM-based expected totals
    if pp1 and pp2:
        p1_ppm = pp1.get("pts_per_match")
        p2_ppm = pp2.get("pts_per_match")
        if isinstance(p1_ppm, (int, float)) and isinstance(p2_ppm, (int, float)):
            exp = p1_ppm + p2_ppm
            print(f"\n  PPM Model  (season scoring averages)")
            print(f"  {'─'*58}")
            print(f"  {'':20} {'PPM':>6}  {'H2H Avg':>8}  {'Diff':>6}")
            ppm_rows = [
                ("Total  (both)",       exp,    statistics.mean(totals)    if totals    else None),
                (f"Home   ({p1[:14]})", p1_ppm, statistics.mean(p1_scores) if p1_scores else None),
                (f"Away   ({p2[:14]})", p2_ppm, statistics.mean(p2_scores) if p2_scores else None),
            ]
            for label, ppm_val, h2h_avg in ppm_rows:
                if h2h_avg is not None:
                    print(f"  {label:<20} {ppm_val:>6.1f}  {h2h_avg:>8.1f}  {ppm_val - h2h_avg:>+6.1f}")
                else:
                    print(f"  {label:<20} {ppm_val:>6.1f}  {'—':>8}")

    # Win% edge
    if pp1 and pp2:
        wp1 = pp1.get("win_pct")
        wp2 = pp2.get("win_pct")
        if isinstance(wp1, (int, float)) and isinstance(wp2, (int, float)):
            edge = abs(wp1 - wp2)
            favored = p1 if wp1 > wp2 else p2
            print(f"\n  Win%-based edge: {favored} favored (+{edge:.1f}%)")

    print()


def cmd_analyze(args: argparse.Namespace) -> None:
    """Print walk-forward model accuracy summary: total distribution and win%-model accuracy."""
    days = args.days
    print(f"Fetching {days} days of walk-forward data...", end="", flush=True)
    c = _Client()
    try:
        events = c.schedule_range(days)
    finally:
        c.close()
    print(" done.")
    games = _ended_games(events)
    if not games:
        print("No completed games found.")
        return
    wf = _build_walkforward(games)
    totals = [
        float(r["actual_total"])
        for r in wf
        if isinstance(r.get("actual_total"), (int, float))
    ]
    print(f"\n  Walk-forward summary — {len(wf)} games over {days} days")
    print(f"  {'─'*50}")
    if totals:
        print(f"  Combined score (total):  avg={statistics.mean(totals):.1f}"
              f"  std={statistics.stdev(totals) if len(totals) > 1 else 0:.1f}"
              f"  min={min(totals):.0f}  max={max(totals):.0f}")
        med = statistics.median(totals)
        over = sum(1 for t in totals if t > med)
        print(f"  Median total:            {med:.1f}  ({over}/{len(totals)} games over)")

    # Win%-model accuracy
    correct = usable = 0
    for r in wf:
        wp1, wp2 = r["p1_win_pct"], r["p2_win_pct"]
        if not isinstance(wp1, float) or not isinstance(wp2, float):
            continue
        if wp1 == wp2:
            continue
        usable += 1
        p1_favored = wp1 > wp2
        p1_won = float(r["score1"]) > float(r["score2"])
        if p1_favored == p1_won:
            correct += 1
    if usable:
        acc = correct / usable * 100
        print(f"  Win%-model accuracy:     {acc:.1f}%  ({correct}/{usable} games with unequal win%)")
    print()


def cmd_export(args: argparse.Namespace) -> None:
    """Export players, standings, walk-forward, and matches to CSV files for offline analysis."""
    days, out_dir, min_gp = args.days, args.out, args.min_gp
    os.makedirs(out_dir, exist_ok=True)
    print(f"Fetching {days} days of data...", end="", flush=True)
    c = _Client()
    try:
        parts = c.participants()
        events = c.schedule_range(days)
    finally:
        c.close()
    print(" done.")

    players = _aggregate_players(parts, min_gp=min_gp)
    games = _ended_games(events)
    wf = _build_walkforward(games)
    standings = _build_standings(parts)
    matches = [
        {
            "date": g["date"], "player1": g["p1"], "player2": g["p2"],
            "score1": g["s1"], "score2": g["s2"],
            "total": g["s1"] + g["s2"], "division": g["division"],
        }
        for g in games
    ]

    def _save(fname: str, rows: list[dict]) -> None:
        if not rows:
            print(f"  {fname}: no data")
            return
        path = os.path.join(out_dir, fname)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"  {fname}: {len(rows)} rows  →  {path}")

    print("Saving CSVs:")
    _save("ggba_players.csv", players)
    _save("ggba_standings.csv", standings)
    _save("ggba_walkforward.csv", wf)
    _save("ggba_matches.csv", matches)
    print(f"\nDone.  Import via Data Manager → 'Import CSV' in the web app, "
          "or use ggba model.py for offline backtesting.")


# --------------------------------------------------------------------------- #
# Argument parser
# --------------------------------------------------------------------------- #
def _build_parser() -> argparse.ArgumentParser:
    """Build and return the CLI argument parser with all subcommands."""
    parser = argparse.ArgumentParser(
        prog="ggba_h2hggl",
        description="GGBetAnalyzer CLI — live H2H GG League stats, no web server needed.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python3 ggba_h2hggl.py players --min-gp 5
  python3 ggba_h2hggl.py standings
  python3 ggba_h2hggl.py schedule --days 3
  python3 ggba_h2hggl.py h2h "PlayerA" "PlayerB" --days 60
  python3 ggba_h2hggl.py matchup "PlayerA" "PlayerB"
  python3 ggba_h2hggl.py analyze --days 30
  python3 ggba_h2hggl.py export --days 30 --out ./ggba_data
""",
    )
    subs = parser.add_subparsers(dest="cmd", required=True)

    sp = subs.add_parser("players", help="List all players with stats (FG%%, steals, fouls, …)")
    sp.add_argument("--min-gp", type=int, default=1, dest="min_gp",
                    help="Minimum games played filter (default: 1)")
    sp.add_argument("--filter", default="", help="Filter by name substring")
    sp.set_defaults(func=cmd_players)

    sp = subs.add_parser("standings", help="League standings ranked by win %%")
    sp.set_defaults(func=cmd_standings)

    sp = subs.add_parser("schedule", help="Upcoming fixtures")
    sp.add_argument("--days", type=int, default=2, help="Days ahead to look (default: 2)")
    sp.set_defaults(func=cmd_schedule)

    sp = subs.add_parser("h2h", help="Head-to-head record between two players")
    sp.add_argument("player1", help="First player name (exact, case-insensitive)")
    sp.add_argument("player2", help="Second player name (exact, case-insensitive)")
    sp.add_argument("--days", type=int, default=60, help="Days of history to search (default: 60)")
    sp.set_defaults(func=cmd_h2h)

    sp = subs.add_parser("matchup", help="Full matchup analysis: stats, model, H2H summary")
    sp.add_argument("player1", help="First player name")
    sp.add_argument("player2", help="Second player name")
    sp.add_argument("--days", type=int, default=30,
                    help="Days of history for H2H and walk-forward (default: 30)")
    sp.set_defaults(func=cmd_matchup)

    sp = subs.add_parser("analyze", help="Walk-forward model accuracy summary")
    sp.add_argument("--days", type=int, default=30, help="Days of history (default: 30)")
    sp.set_defaults(func=cmd_analyze)

    sp = subs.add_parser("export", help="Export all data to CSV files for offline analysis")
    sp.add_argument("--days", type=int, default=30, help="Days of history (default: 30)")
    sp.add_argument("--min-gp", type=int, default=1, dest="min_gp",
                    help="Minimum GP filter for players CSV (default: 1)")
    sp.add_argument("--out", default="./ggba_data", help="Output directory (default: ./ggba_data)")
    sp.set_defaults(func=cmd_export)

    return parser


def main() -> None:
    """Entry point: parse CLI arguments and dispatch to the requested subcommand."""
    args = _build_parser().parse_args()
    try:
        args.func(args)
    except httpx.HTTPStatusError as e:
        sys.exit(f"API error {e.response.status_code}: {e.request.url}")
    except httpx.HTTPError as e:
        sys.exit(f"Network error: {e}")
    except KeyboardInterrupt:
        print("\nInterrupted.")


if __name__ == "__main__":
    main()
