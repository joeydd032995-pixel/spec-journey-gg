/* ============================================================================
   GGBetAnalyzer model core — pure, side-effect-free, fully unit-tested.
   Mirrors `ggba model.py` so the browser and the Python backtester agree.
   ========================================================================== */

/* ----------------------------- types ------------------------------------- */
export interface Player {
  name: string;
  win_pct: number | string;
  pts_per_match: number | string;
  fg_pct: number | string;
  steals: number | string;
  fouls: number | string;
  gp: number | string;
  w?: number | string;
  l?: number | string;
  recent_form: string;
  nba_team?: string;
  last_updated?: string;
}

export interface Settings {
  formCoef: number;
  matchupCoef: number;
  fatigue: number;
  variance: number;
  dispersion: number;
  edgeThresh: number;
  shrinkK: number;
  modelMode: "rated" | "baseline";
  etaP: number;
  etaT: number;
  ratingDecay: number;
}

export interface MatchResult {
  id: string;
  date: string;
  player1: string;
  player2: string;
  score1: number;
  score2: number;
  total: number;
  division?: string;
}

export interface WalkForwardRow {
  date: string;
  player1: string;
  player2: string;
  p1_team: string;
  p2_team: string;
  p1_win_pct: number | string;
  p1_ppm: number | string;
  p1_form: string;
  p1_gp: number;
  p2_win_pct: number | string;
  p2_ppm: number | string;
  p2_form: string;
  p2_gp: number;
  score1: number;
  score2: number;
  actual_total: number;
  hour_utc?: number | string;
}

export interface Bet {
  id: string;
  timestamp: string;
  matchup: string;
  bet_type: "Total" | "ML" | "Spread";
  line: string;
  proj_value: number;
  model_prob: number;
  odds: number;
  close_side?: string | number;
  close_other?: string | number;
  stake: string | number;
  outcome: "Pending" | "Win" | "Loss" | "Push";
  profit: number;
  notes?: string;
}

export interface Projection {
  base: number;
  form_adj: number;
  matchup_adj: number;
  fatigue_adj: number;
  f1: number;
  f2: number;
  projected: number;
  p1_proj: number;
  p2_proj: number;
  sigma: number;
  confidence: "High" | "Med" | "Low";
  minGp: number;
  rated?: boolean;
}

export interface BookQuote {
  book: string;
  over: string | number;
  under: string | number;
}

export const DEFAULT_SETTINGS: Settings = {
  formCoef: 0.10, matchupCoef: 0.05, fatigue: 0.92, variance: 1.00,
  dispersion: 1.20, edgeThresh: 0.03, shrinkK: 4,
  modelMode: "rated", etaP: 0.08, etaT: 0.04, ratingDecay: 0,
};

export const CSV_COLS = ["name", "win_pct", "pts_per_match", "fg_pct", "steals", "fouls", "gp", "w", "l", "recent_form", "nba_team"] as const;
export const MATCH_COLS = ["date", "player1", "player2", "score1", "score2", "total", "division"] as const;
export const WF_COLS = ["date", "player1", "player2", "p1_team", "p2_team", "p1_win_pct", "p1_ppm", "p1_form", "p1_gp", "p2_win_pct", "p2_ppm", "p2_form", "p2_gp", "score1", "score2", "actual_total", "hour_utc"] as const;

/* ----------------------------- math core --------------------------------- */
export const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Pearson correlation of two equal-length arrays (null if degenerate). */
export function pearson(a: number[], b: number[]): number | null {
  const n = a.length; if (n < 2) return null;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
  return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : null;
}

/** erf (Abramowitz & Stegun 7.1.26) — accurate to ~1e-7 vs scipy. */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
export const normCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/** recent_form "WWLWL" -> weighted score in [-1,+1] (leftmost = most recent). */
export function formScore(formStr: string): number {
  const ch = String(formStr || "").toUpperCase().replace(/[^WL]/g, "").split("");
  if (!ch.length) return 0;
  let acc = 0, den = 0;
  ch.forEach((c, i) => { const w = 1 / (i + 1); den += w; acc += c === "W" ? w : -w; });
  return acc / den;
}

/** efficiency metric = pts_per_match + steals - fouls*0.5 */
export const efficiency = (p: Pick<Player, "pts_per_match" | "steals" | "fouls">): number =>
  num(p.pts_per_match) + num(p.steals) - num(p.fouls) * 0.5;

/* ----------------------------- odds helpers ------------------------------ */
export const impliedProb = (o: unknown): number | null => { const ov = num(o); if (!ov) return null; return ov > 0 ? 100 / (ov + 100) : -ov / (-ov + 100); };
export const payoutMult = (o: unknown): number => { const ov = num(o); if (!ov) return 0; return ov > 0 ? ov / 100 : 100 / -ov; };
export const evPerUnit = (p: number, o: unknown): number => p * payoutMult(o) - (1 - p);
export const fullKelly = (p: number, o: unknown): number => { const b = payoutMult(o); if (b <= 0) return 0; return (b * p - (1 - p)) / b; };
export const decimalOdds = (o: unknown): number => payoutMult(o) + 1;
export const americanStr = (o: unknown): string => { const ov = num(o); return ov > 0 ? `+${ov}` : `${ov}`; };

/* --- de-vig + line shopping + CLV (mirrors ggba_model.py) ----------------- */
/** No-vig fair probs of both sides of a two-sided American market (proportional method). */
export function devigTwoWay(oSide: unknown, oOther: unknown): [number | null, number | null] {
  const q1 = impliedProb(oSide), q2 = impliedProb(oOther);
  if (q1 == null || q2 == null || q1 + q2 <= 0) return [null, null];
  const s = q1 + q2; return [q1 / s, q2 / s];
}

/**
 * CLV as EV measured at the closing FAIR prob. Two-sided close -> devigged first.
 * >0 means you beat the close (the durable +EV proxy in efficient markets).
 */
export function clvEv(oTaken: unknown, oCloseSide: unknown, oCloseOther?: unknown): number | null {
  let pClose: number | null;
  if (oCloseOther !== undefined && oCloseOther !== null && oCloseOther !== "") [pClose] = devigTwoWay(oCloseSide, oCloseOther);
  else pClose = impliedProb(oCloseSide);
  if (pClose == null) return null;
  return pClose * decimalOdds(oTaken) - 1;
}

export interface BestPriceResult {
  bestOver: { d: number; o: number; book: string } | null;
  bestUnder: { d: number; o: number; book: string } | null;
  consensusOver: number | null;
}

/** Best available price each side across books + no-vig market consensus over-prob. */
export function bestPrice(quotes: BookQuote[]): BestPriceResult {
  let bestOver: BestPriceResult["bestOver"] = null;
  let bestUnder: BestPriceResult["bestUnder"] = null;
  const cons: number[] = [];
  quotes.forEach((q) => {
    const hasOver = q.over !== "" && q.over != null;
    const hasUnder = q.under !== "" && q.under != null;
    if (hasOver) { const d = decimalOdds(q.over); if (!bestOver || d > bestOver.d) bestOver = { d, o: num(q.over), book: q.book }; }
    if (hasUnder) { const d = decimalOdds(q.under); if (!bestUnder || d > bestUnder.d) bestUnder = { d, o: num(q.under), book: q.book }; }
    if (hasOver && hasUnder) { const [pv] = devigTwoWay(q.over, q.under); if (pv != null) cons.push(pv); }
  });
  return { bestOver, bestUnder, consensusOver: cons.length ? cons.reduce((a, b) => a + b, 0) / cons.length : null };
}

/* ---- empirical-Bayes shrinkage -------------------------------------------
   Pull a noisy low-sample stat toward a league mean: shrunk = w·raw + (1−w)·target,
   with w = gp/(gp+k). k = "pseudo-games" of prior; k=0 disables. */
export function shrink(raw: number, gp: number, k: number, target: number | null): number {
  if (!(k > 0) || target == null || !Number.isFinite(target) || gp <= 0) return raw;
  const w = gp / (gp + k);
  return w * raw + (1 - w) * target;
}

/** gp-weighted league mean ppm = total points / total player-games. */
export function leagueMeanPpm(players: Array<Pick<Player, "gp" | "pts_per_match">>): number | null {
  let pts = 0, gp = 0;
  (players || []).forEach((p) => { const g = num(p.gp), m = num(p.pts_per_match); if (g > 0 && m > 0) { pts += g * m; gp += g; } });
  return gp > 0 ? pts / gp : null;
}

/* ---- Total Score Projector (baseline ppm model) -------------------------- */
export interface ProjectionContext {
  leagueMean?: number | null;
  ratings?: RatingsModel;
  team1?: string;
  team2?: string;
}

export function projectTotal(p1: Player | undefined, p2: Player | undefined, s: Settings, lateNight: boolean, ctx: ProjectionContext | null): Projection | null {
  if (!p1 || !p2) return null;
  const k = num(s.shrinkK);
  const lg = ctx && ctx.leagueMean != null && Number.isFinite(Number(ctx.leagueMean)) ? Number(ctx.leagueMean) : null;
  const pm1 = shrink(num(p1.pts_per_match), num(p1.gp), k, lg);
  const pm2 = shrink(num(p2.pts_per_match), num(p2.gp), k, lg);
  const base = pm1 + pm2;
  const f1 = formScore(String(p1.recent_form ?? "")), f2 = formScore(String(p2.recent_form ?? ""));
  const form_adj = 1 + num(s.formCoef) * ((f1 + f2) / 2);
  const defLoad = ((num(p1.steals) + num(p1.fouls)) + (num(p2.steals) + num(p2.fouls))) / 2;
  const matchup_adj = clamp(1 - num(s.matchupCoef) * (defLoad / 10), 0.85, 1.05);
  const fatigue_adj = lateNight ? num(s.fatigue) : 1.0;
  const projected = r1(base * form_adj * matchup_adj * fatigue_adj * num(s.variance));

  const w1 = shrink(num(p1.win_pct), num(p1.gp), k, 50);   // win% shrinks toward 50 by definition
  const w2 = shrink(num(p2.win_pct), num(p2.gp), k, 50);
  const wsum = w1 + w2 || 1;
  const p1_proj = r1(projected * (w1 / wsum));
  const p2_proj = r1(projected - p1_proj);

  const sigma = Math.sqrt(Math.max(projected, 1) * num(s.dispersion));
  const minGp = Math.min(num(p1.gp), num(p2.gp));
  const confidence = minGp > 50 ? "High" : minGp > 20 ? "Med" : "Low";

  return { base: r1(base), form_adj, matchup_adj, fatigue_adj, f1, f2, projected, p1_proj, p2_proj, sigma, confidence, minGp };
}

/** P(total > line) with 0.5 continuity correction for integer lines. */
export function probOver(projected: number, sigma: number, line: unknown): number | null {
  if (line === "" || line == null) return null; // Number("") is 0 — an empty line is "no line", not 0
  const L = Number(line);
  if (!Number.isFinite(L) || sigma <= 0) return null;
  const isInt = Math.abs(L - Math.round(L)) < 1e-9;
  const cc = isInt ? 0.5 : 0;
  return 1 - normCdf((L + cc - projected) / sigma);
}

/* ---- Win Probability ------------------------------------------------------
   wp = p1.win_pct/(p1.win_pct+p2.win_pct); adjusted by form diff and h2h
   dominance penalty, clamped 5–95%. */
export interface WinProbResult { baseWp: number; formDiff: number; adjusted: number }

export function winProb(p1: Player, p2: Player, h2hPenalty = 0, s: Settings | null = null): WinProbResult {
  const k = s ? num(s.shrinkK) : 0;
  const w1 = shrink(num(p1.win_pct), num(p1.gp), k, 50);
  const w2 = shrink(num(p2.win_pct), num(p2.gp), k, 50);
  const baseWp = (w1 / (w1 + w2 || 1)) * 100;
  const formDiff = formScore(String(p1.recent_form ?? "")) - formScore(String(p2.recent_form ?? ""));
  const adjusted = clamp(baseWp + 5 * formDiff - 3 * h2hPenalty, 5, 95);
  return { baseWp, formDiff, adjusted };
}

/** H2H dominance of p2 over p1 in their recorded meetings, in [-1, +1]. */
export function h2hDominance(p1Name: string, p2Name: string, matches: MatchResult[]): number {
  const games = matches.filter((m) =>
    [m.player1, m.player2].includes(p1Name) && [m.player1, m.player2].includes(p2Name));
  if (!games.length) return 0;
  let p2wins = 0;
  games.forEach((m) => {
    const s1 = m.player1 === p1Name ? m.score1 : m.score2;
    const s2 = m.player1 === p2Name ? m.score1 : m.score2;
    if (s2 > s1) p2wins++;
  });
  return (p2wins / games.length - 0.5) * 2;
}

/* ============================================================================
   ONLINE OPPONENT-ADJUSTED RATING MODEL (the edge layer)
   Additive; every rating is a deviation from the running league mean m.
   E[score_A] = m + oP[A] + oT[TA] + dP[B] + dT[TB]. Learned online by SGD;
   predict() is always called BEFORE update(), so it is leakage-free.
   ========================================================================== */
export interface RatingsModel {
  leagueMean(): number | null;
  seen(p: string): boolean;
  predict(A: string, TA: string, B: string, TB: string): { sA: number; sB: number; total: number; m: number };
  update(A: string, TA: string, B: string, TB: string, aA: number, aB: number): void;
  ratingOf(p: string): { off: number; def: number };
  teamRatingOf(t: string): { off: number; def: number };
}

export function makeRatings(params: Partial<Settings> | null): RatingsModel {
  const etaP = num(params?.etaP) || 0.08;
  const etaT = num(params?.etaT) || 0.04;
  const decay = num(params?.ratingDecay) || 0;
  const oP: Record<string, number> = {}, dP: Record<string, number> = {};
  const oT: Record<string, number> = {}, dT: Record<string, number> = {};
  let mPts = 0, mN = 0;
  const g = (o: Record<string, number>, k: string) => o[k] || 0;
  return {
    leagueMean: () => (mN > 0 ? mPts / mN : null),
    seen: (p: string) => (p in oP),
    predict(A, TA, B, TB) {
      const m = mN > 0 ? mPts / mN : 0;
      const sA = m + g(oP, A) + g(oT, TA) + g(dP, B) + g(dT, TB);
      const sB = m + g(oP, B) + g(oT, TB) + g(dP, A) + g(dT, TA);
      return { sA, sB, total: sA + sB, m };
    },
    update(A, TA, B, TB, aA, aB) {
      const pr = this.predict(A, TA, B, TB);
      const rA = aA - pr.sA, rB = aB - pr.sB;
      oP[A] = g(oP, A) + etaP * rA; oT[TA] = g(oT, TA) + etaT * rA; dP[B] = g(dP, B) + etaP * rA; dT[TB] = g(dT, TB) + etaT * rA;
      oP[B] = g(oP, B) + etaP * rB; oT[TB] = g(oT, TB) + etaT * rB; dP[A] = g(dP, A) + etaP * rB; dT[TA] = g(dT, TA) + etaT * rB;
      if (decay > 0) {
        [A, B].forEach((p) => { oP[p] *= (1 - decay); dP[p] *= (1 - decay); });
        [TA, TB].forEach((t) => { oT[t] *= (1 - decay); dT[t] *= (1 - decay); });
      }
      mPts += aA + aB; mN += 2;
    },
    ratingOf(p) { return { off: g(oP, p), def: g(dP, p) }; },
    teamRatingOf(t) { return { off: g(oT, t), def: g(dT, t) }; },
  };
}

export interface RatingGame { p1: string; t1: string; p2: string; t2: string; s1: number; s2: number }

/** Train a rating model over chronologically-sorted games. */
export function buildRatingsModel(games: RatingGame[], params: Partial<Settings> | null): RatingsModel {
  const R = makeRatings(params);
  games.forEach((g) => R.update(String(g.p1), String(g.t1 ?? ""), String(g.p2), String(g.t2 ?? ""), num(g.s1), num(g.s2)));
  return R;
}

/** Unified projection: rating model when selected + both players known, else baseline ppm. */
export function computeProjection(p1: Player | undefined, p2: Player | undefined, s: Settings, lateNight: boolean, ctx: ProjectionContext | null): Projection | null {
  if (!p1 || !p2) return null;
  if (s.modelMode === "rated" && ctx?.ratings?.seen(String(p1.name)) && ctx.ratings.seen(String(p2.name))) {
    const pred = ctx.ratings.predict(String(p1.name), String(ctx.team1 || ""), String(p2.name), String(ctx.team2 || ""));
    const projected = r1(pred.total);
    const sigma = Math.sqrt(Math.max(projected, 1) * num(s.dispersion));
    const minGp = Math.min(num(p1.gp), num(p2.gp));
    return {
      projected, p1_proj: r1(pred.sA), p2_proj: r1(pred.sB), sigma, rated: true,
      confidence: minGp > 50 ? "High" : minGp > 20 ? "Med" : "Low", minGp,
      base: projected, form_adj: 1, matchup_adj: 1, fatigue_adj: 1,
      f1: formScore(String(p1.recent_form ?? "")), f2: formScore(String(p2.recent_form ?? "")),
    };
  }
  return projectTotal(p1, p2, s, lateNight, ctx);
}

/** Empirical margin/total σ ratio from games (independent scores -> 1.0). */
export function marginRatioFrom(games: Array<Pick<MatchResult, "score1" | "score2"> | Pick<WalkForwardRow, "score1" | "score2">>): number {
  if (!games || games.length < 12) return 1.0;
  const tot: number[] = [], mar: number[] = [];
  games.forEach((g) => { tot.push(num(g.score1) + num(g.score2)); mar.push(num(g.score1) - num(g.score2)); });
  const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const st = sd(tot), sm = sd(mar);
  return st > 0 ? clamp(sm / st, 0.5, 1.6) : 1.0;
}

/* ----------------------------- dedup keys --------------------------------- */
export const matchKey = (m: Pick<MatchResult, "date" | "player1" | "player2" | "score1" | "score2">): string =>
  `${m.date}|${String(m.player1).toLowerCase()}|${String(m.player2).toLowerCase()}|${m.score1}|${m.score2}`;

export const wfKey = (r: Pick<WalkForwardRow, "date" | "player1" | "player2" | "score1" | "score2">): string =>
  `${r.date}|${String(r.player1).toLowerCase()}|${String(r.player2).toLowerCase()}|${r.score1}|${r.score2}`;
