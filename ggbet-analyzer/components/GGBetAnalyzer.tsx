'use client';
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Papa from "papaparse";
import {
  AreaChart, Area, LineChart, Line, ScatterChart, Scatter, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, ZAxis, Cell,
} from "recharts";
import {
  Database, Crosshair, ClipboardList, LineChart as LineIcon, Bot, Upload, Plus,
  Download, Trash2, RefreshCw, Send, AlertTriangle, TrendingUp, Activity, Moon, Sun,
  Edit3, X, Check, Target, Percent, DollarSign, Gauge, Search,
  Calendar, ChevronDown, ChevronUp,
} from "lucide-react";

/* ============================================================================
   GGBetAnalyzer v1.0  —  eBasketball H2H GG League (4x5) analytics terminal
   ----------------------------------------------------------------------------
   Player-centric projections for Moneyline / Totals / Spreads, with edge (EV),
   quarter-Kelly staking, a bet ledger, ROI + backtest analytics, and an AI
   assistant. Data is YOURS: import a CSV that matches the h2hggl stat schema,
   or enter players by hand. Records persist across sessions. No seeded/fake
   players — the terminal ships empty and aggregates whatever real data you load.
   ========================================================================== */

/* ----------------------------- palette ----------------------------------- */
const C = {
  // Base
  bg:               "#04060d",
  bgAlt:            "#070a14",
  // Glass surface fills — backdrop-filter does the heavy lifting
  glass:            "rgba(255,255,255,0.055)",
  glassHi:          "rgba(255,255,255,0.09)",
  glassBorder:      "rgba(255,255,255,0.10)",
  glassSpec:        "rgba(255,255,255,0.18)",   // specular top-edge highlight
  glassInner:       "rgba(255,255,255,0.06)",   // inner ambient glow
  // Accent-tinted glass (active / selected states)
  glassAccent:      "rgba(61,245,160,0.10)",
  glassAccentBorder:"rgba(61,245,160,0.28)",
  glassAccentSpec:  "rgba(61,245,160,0.22)",
  // Semantic tokens (unchanged)
  text:       "#e9f1ec",
  muted:      "#7a8c84",
  faint:      "#54635d",
  accent:     "#3df5a0",
  accentDim:  "#1c6b48",
  pos:        "#3df5a0",
  neg:        "#ff5d52",
  amber:      "#ffc24b",
  blue:       "#5fb0ff",
  // Aliased for any legacy references
  surface:    "rgba(255,255,255,0.055)",
  surface2:   "rgba(255,255,255,0.08)",
  border:     "rgba(255,255,255,0.09)",
  borderHi:   "rgba(255,255,255,0.18)",
};

/* ----------------------------- glass mixins ------------------------------ */
const GLASS: React.CSSProperties = {
  background:              C.glass,
  backdropFilter:          "blur(24px) saturate(180%)",
  WebkitBackdropFilter:    "blur(24px) saturate(180%)",
  border:                  `1px solid ${C.glassBorder}`,
  boxShadow: [
    `inset 0 1px 0 ${C.glassSpec}`,
    `inset 0 0 0 1px ${C.glassInner}`,
    "0 8px 32px rgba(0,0,0,0.40)",
    "0 2px 8px rgba(0,0,0,0.20)",
  ].join(", "),
  borderRadius: 16,
};
const GLASS_ACTIVE: React.CSSProperties = {
  ...GLASS,
  background:  C.glassAccent,
  border:      `1px solid ${C.glassAccentBorder}`,
  boxShadow: [
    `inset 0 1px 0 ${C.glassAccentSpec}`,
    "inset 0 0 0 1px rgba(61,245,160,0.08)",
    "0 8px 32px rgba(0,0,0,0.40)",
    "0 0 20px rgba(61,245,160,0.12)",
  ].join(", "),
};
const GLASS_INPUT: React.CSSProperties = {
  background:           "rgba(0,0,0,0.30)",
  backdropFilter:       "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border:               `1px solid ${C.glassBorder}`,
  boxShadow:            "inset 0 2px 4px rgba(0,0,0,0.20)",
};

/* ----------------------------- math core --------------------------------- */
// All model math is pure + documented so it can be lifted into a Python module.
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
// Pearson correlation of two equal-length arrays (null if degenerate)
function pearson(a: number[], b: number[]) {
  const n = a.length; if (n < 2) return null;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
  return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : null;
}

// erf (Abramowitz & Stegun 7.1.26) — verified to ~1e-7 vs scipy.
function erf(x: number) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

// recent_form "WWLWL" -> weighted score in [-1,+1] (leftmost = most recent).
function formScore(formStr: string) {
  const ch = String(formStr || "").toUpperCase().replace(/[^WL]/g, "").split("");
  if (!ch.length) return 0;
  let num_ = 0, den = 0;
  ch.forEach((c, i) => { const w = 1 / (i + 1); den += w; num_ += c === "W" ? w : -w; });
  return num_ / den;
}

// efficiency metric = pts_per_match + steals - fouls*0.5
const efficiency = (p: Record<string, unknown>) => num(p.pts_per_match) + num(p.steals) - num(p.fouls) * 0.5;

// American odds helpers
const impliedProb = (o: unknown) => { const ov = num(o); if (!ov) return null; return ov > 0 ? 100 / (ov + 100) : -ov / (-ov + 100); };
const payoutMult = (o: unknown) => { const ov = num(o); if (!ov) return 0; return ov > 0 ? ov / 100 : 100 / -ov; };
const evPerUnit = (p: number, o: unknown) => p * payoutMult(o) - (1 - p);
const fullKelly = (p: number, o: unknown) => { const b = payoutMult(o); if (b <= 0) return 0; return (b * p - (1 - p)) / b; };
const decimalOdds = (o: unknown) => payoutMult(o) + 1;
const americanStr = (o: unknown) => { const ov = num(o); return ov > 0 ? `+${ov}` : `${ov}`; };

// --- de-vig + line shopping + CLV (mirrors ggba_model.py, unit-tested) ---
// No-vig fair prob of `side` from a two-sided American market (proportional method).
function devigTwoWay(oSide: unknown, oOther: unknown) {
  const q1 = impliedProb(oSide), q2 = impliedProb(oOther);
  if (q1 == null || q2 == null || q1 + q2 <= 0) return [null, null];
  const s = q1 + q2; return [q1 / s, q2 / s];
}
// CLV as EV measured at the closing FAIR prob. Two-sided close -> devigged first.
// >0 means you beat the close (the durable +EV proxy in efficient markets).
function clvEv(oTaken: unknown, oCloseSide: unknown, oCloseOther?: unknown) {
  let pClose: number | null;
  if (oCloseOther !== undefined && oCloseOther !== null && oCloseOther !== "") [pClose] = devigTwoWay(oCloseSide, oCloseOther) as [number | null, number | null];
  else pClose = impliedProb(oCloseSide);
  if (pClose == null) return null;
  return pClose * decimalOdds(oTaken) - 1;
}
// Best available price each side across books + no-vig market consensus over-prob.
function bestPrice(quotes: Array<{ over: unknown; under: unknown; book: string }>) {
  let bestOver: { d: number; o: number; book: string } | null = null;
  let bestUnder: { d: number; o: number; book: string } | null = null;
  const cons: number[] = [];
  quotes.forEach((q) => {
    if (q.over !== "" && q.over != null) { const d = decimalOdds(q.over); if (!bestOver || d > bestOver.d) bestOver = { d, o: num(q.over), book: q.book }; }
    if (q.under !== "" && q.under != null) { const d = decimalOdds(q.under); if (!bestUnder || d > bestUnder.d) bestUnder = { d, o: num(q.under), book: q.book }; }
    if (q.over !== "" && q.over != null && q.under !== "" && q.under != null) { const [pv] = devigTwoWay(q.over, q.under); if (pv != null) cons.push(pv as number); }
  });
  return { bestOver, bestUnder, consensusOver: cons.length ? cons.reduce((a, b) => a + b, 0) / cons.length : null };
}

/* ---- Total Score Projector (primary edge tool) ---------------------------
   base_total   = p1.ppm + p2.ppm
   form_adj     = 1 + formCoef * mean(formScore p1, p2)          (±formCoef)
   matchup_adj  = 1 - matchupCoef * (avg(steals+fouls)/10)       (defensive suppression, clamped)
   fatigue_adj  = fatigue if late-night else 1.0
   projected    = base * form_adj * matchup_adj * fatigue_adj * variance
   split by win_pct; O/U prob from Normal(projected, sqrt(projected*dispersion)) */
/* ---- empirical-Bayes shrinkage -------------------------------------------
   Pull a noisy low-sample stat toward a league mean:  shrunk = w·raw + (1−w)·target,
   with w = gp/(gp+k). k = "pseudo-games" of prior; k=0 disables. The pull is
   strongest at low gp and fades smoothly to the raw value as games accumulate —
   no hard cutoff, so no discontinuity. In the walk-forward backtest the target is
   a running league mean built only from prior games, so this adds NO leakage. */
function shrink(raw: number, gp: number, k: number, target: number | null) {
  if (!(k > 0) || target == null || !Number.isFinite(target) || gp <= 0) return raw;
  const w = gp / (gp + k);
  return w * raw + (1 - w) * target;
}

// gp-weighted league mean ppm = total points / total player-games (live/roster target)
function leagueMeanPpm(players: unknown[]) {
  let pts = 0, gp = 0;
  (players || []).forEach((p) => { const g = num((p as Record<string, unknown>).gp), m = num((p as Record<string, unknown>).pts_per_match); if (g > 0 && m > 0) { pts += g * m; gp += g; } });
  return gp > 0 ? pts / gp : null;
}

function projectTotal(p1: Record<string, unknown>, p2: Record<string, unknown>, s: Record<string, unknown>, lateNight: boolean, ctx: Record<string, unknown> | null) {
  if (!p1 || !p2) return null;
  const k = num(s.shrinkK);
  const lg = ctx && ctx.leagueMean != null && Number.isFinite(Number(ctx.leagueMean)) ? Number(ctx.leagueMean) : null;
  const pm1 = shrink(num(p1.pts_per_match), num(p1.gp), k, lg);   // ppm -> league mean (target supplied per-context)
  const pm2 = shrink(num(p2.pts_per_match), num(p2.gp), k, lg);
  const base = pm1 + pm2;
  const f1 = formScore(String(p1.recent_form ?? "")), f2 = formScore(String(p2.recent_form ?? ""));
  const form_adj = 1 + num(s.formCoef) * ((f1 + f2) / 2);
  const defLoad = ((num(p1.steals) + num(p1.fouls)) + (num(p2.steals) + num(p2.fouls))) / 2;
  const matchup_adj = clamp(1 - num(s.matchupCoef) * (defLoad / 10), 0.85, 1.05);
  const fatigue_adj = lateNight ? num(s.fatigue) : 1.0;
  const projected = r1(base * form_adj * matchup_adj * fatigue_adj * num(s.variance));

  const w1 = shrink(num(p1.win_pct), num(p1.gp), k, 50);          // win% -> 50 (league win% is 50 by definition)
  const w2 = shrink(num(p2.win_pct), num(p2.gp), k, 50);
  const wsum = w1 + w2 || 1;
  const p1_proj = r1(projected * (w1 / wsum));
  const p2_proj = r1(projected - p1_proj);

  const sigma = Math.sqrt(Math.max(projected, 1) * num(s.dispersion));
  const minGp = Math.min(num(p1.gp), num(p2.gp));
  const confidence = minGp > 50 ? "High" : minGp > 20 ? "Med" : "Low";

  return { base: r1(base), form_adj, matchup_adj, fatigue_adj, f1, f2,
    projected, p1_proj, p2_proj, sigma, confidence, minGp };
}

// P(total > line) with 0.5 continuity correction for integer lines
function probOver(projected: number, sigma: number, line: unknown) {
  const L = Number(line);
  if (!Number.isFinite(L) || sigma <= 0) return null;
  const isInt = Math.abs(L - Math.round(L)) < 1e-9;
  const cc = isInt ? 0.5 : 0;
  return 1 - normCdf((L + cc - projected) / sigma);
}

/* ---- Win Probability -----------------------------------------------------
   wp = p1.win_pct/(p1.win_pct+p2.win_pct)
   adjusted = wp + 5*form_diff - 3*h2h_penalty   (clamped 5–95%)
   win% is shrunk toward 50 below the sample cutoff when settings provided. */
function winProb(p1: Record<string, unknown>, p2: Record<string, unknown>, h2hPenalty = 0, s: Record<string, unknown> | null = null) {
  const k = s ? num(s.shrinkK) : 0;
  const w1 = shrink(num(p1.win_pct), num(p1.gp), k, 50);
  const w2 = shrink(num(p2.win_pct), num(p2.gp), k, 50);
  const baseWp = (w1 / (w1 + w2 || 1)) * 100;
  const formDiff = formScore(String(p1.recent_form ?? "")) - formScore(String(p2.recent_form ?? ""));
  const adj = clamp(baseWp + 5 * formDiff - 3 * h2hPenalty, 5, 95);
  return { baseWp, formDiff, adjusted: adj };
}

/* ============================================================================
   ONLINE OPPONENT-ADJUSTED RATING MODEL  (the edge layer)
   ----------------------------------------------------------------------------
   Additive model. Every rating is a deviation from the running league mean m
   (points per player per game). For player A on team TA vs player B on team TB:
       E[score_A] = m + oP[A] + oT[TA] + dP[B] + dT[TB]
   i.e. A's own offense + A's team's offense, raised by how leaky B and team TB
   are on defense. Ratings are learned ONLINE by SGD: predict, observe, nudge
   each involved rating toward its share of the residual (player rate etaP,
   team rate etaT, since teams pool more data they move slower). Optional decay
   shrinks toward 0 each touch (recency + regularization). Brand-new players and
   teams start at 0 = league average, so there is no cold-start blow-up.
   Leakage-free: predict() is always called BEFORE update(); m uses prior games
   only. This single estimator subsumes opponent adjustment, team-skin effects,
   and scoring-form (recent games move the ratings).
   ========================================================================== */
function makeRatings(params: Record<string, unknown> | null) {
  const etaP = num(params?.etaP) || 0.08;
  const etaT = num(params?.etaT) || 0.04;
  const decay = num(params?.ratingDecay) || 0;
  const oP: Record<string, number> = {}, dP: Record<string, number> = {}, oT: Record<string, number> = {}, dT: Record<string, number> = {};
  let mPts = 0, mN = 0;
  const g = (o: Record<string, number>, k: string) => o[k] || 0;
  const mean = () => (mN > 0 ? mPts / mN : null);
  return {
    leagueMean: mean,
    seen: (p: string) => (p in oP),
    predict(A: string, TA: string, B: string, TB: string) {
      const m = mN > 0 ? mPts / mN : 0;
      const sA = m + g(oP, A) + g(oT, TA) + g(dP, B) + g(dT, TB);
      const sB = m + g(oP, B) + g(oT, TB) + g(dP, A) + g(dT, TA);
      return { sA, sB, total: sA + sB, m };
    },
    update(A: string, TA: string, B: string, TB: string, aA: number, aB: number) {
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
    ratingOf(p: string) { return { off: g(oP, p), def: g(dP, p) }; },
    teamRatingOf(t: string) { return { off: g(oT, t), def: g(dT, t) }; },
  };
}

// Train a rating model over chronologically-sorted games (each: {p1,t1,p2,t2,s1,s2}).
// Returns the trained estimator (final ratings, for live projection).
function buildRatingsModel(games: Array<Record<string, unknown>>, params: Record<string, unknown> | null) {
  const R = makeRatings(params);
  games.forEach((g) => R.update(String(g.p1), String(g.t1 ?? ""), String(g.p2), String(g.t2 ?? ""), num(g.s1), num(g.s2)));
  return R;
}

// Unified projection: routes to the rating model when selected + both players are known,
// else the baseline ppm projector. Returns the SAME shape so the UI is model-agnostic.
function computeProjection(p1: Record<string, unknown>, p2: Record<string, unknown>, s: Record<string, unknown>, lateNight: boolean, ctx: Record<string, unknown> | null) {
  if (!p1 || !p2) return null;
  const sCtx = ctx as (Record<string, unknown> & { ratings?: { seen: (n: string) => boolean; predict: (a: string, ta: string, b: string, tb: string) => { total: number; sA: number; sB: number } } }) | null;
  if (s.modelMode === "rated" && sCtx?.ratings?.seen(String(p1.name)) && sCtx.ratings.seen(String(p2.name))) {
    const pred = sCtx.ratings.predict(String(p1.name), String(sCtx.team1 || ""), String(p2.name), String(sCtx.team2 || ""));
    const projected = r1(pred.total);
    const sigma = Math.sqrt(Math.max(projected, 1) * num(s.dispersion));
    const minGp = Math.min(num(p1.gp), num(p2.gp));
    return { projected, p1_proj: r1(pred.sA), p2_proj: r1(pred.sB), sigma, rated: true,
      confidence: minGp > 50 ? "High" : minGp > 20 ? "Med" : "Low", minGp,
      base: projected, form_adj: 1, matchup_adj: 1, fatigue_adj: 1,
      f1: formScore(String(p1.recent_form ?? "")), f2: formScore(String(p2.recent_form ?? "")) };
  }
  return projectTotal(p1, p2, s, lateNight, ctx);
}

// Empirical margin/total σ ratio from games (independent scores -> 1.0; correlated -> <1).
function marginRatioFrom(games: unknown[]) {
  if (!games || games.length < 12) return 1.0;
  const tot: number[] = [], mar: number[] = [];
  games.forEach((g) => { const gv = g as Record<string, unknown>; tot.push(num(gv.s1) + num(gv.s2)); mar.push(num(gv.s1) - num(gv.s2)); });
  const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const st = sd(tot), sm = sd(mar);
  return st > 0 ? clamp(sm / st, 0.5, 1.6) : 1.0;
}

/* ----------------------------- storage ----------------------------------- */
const K = { players: "ggba:players", matches: "ggba:matches", bets: "ggba:bets", settings: "ggba:settings", walkforward: "ggba:walkforward" };
// localStorage-backed persistence (works on Vercel; falls back to in-memory)
const mem: Record<string, unknown> = {};
async function loadKey(key: string, fallback: unknown) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const v = localStorage.getItem(key);
      return v != null ? JSON.parse(v) : fallback;
    }
  } catch (_) {}
  return key in mem ? mem[key] : fallback;
}
async function saveKey(key: string, val: unknown) {
  mem[key] = val;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      localStorage.setItem(key, JSON.stringify(val));
    }
  } catch (_) {}
}

const DEFAULT_SETTINGS = { formCoef: 0.10, matchupCoef: 0.05, fatigue: 0.92, variance: 1.00, dispersion: 1.20, edgeThresh: 0.03, shrinkK: 4,
  modelMode: "rated", etaP: 0.08, etaT: 0.04, ratingDecay: 0 };
const CSV_COLS = ["name","win_pct","pts_per_match","fg_pct","steals","fouls","gp","w","l","recent_form","nba_team"];

/* ----------------------------- upcoming types ---------------------------- */
interface ScoreBand {
  mean: number; std: number; low: number; high: number;
  confidence: number; n: number;
}
interface UpcomingGame {
  external_id: string; date: string; hour_utc: number; minute_utc?: number;
  player1: string; player2: string;
  p1_team: string; p2_team: string; division: string;
  p1_stats: { win_pct: number | null; pts_per_match: number | null; gp: number; recent_form: string } | null;
  p2_stats: { win_pct: number | null; pts_per_match: number | null; gp: number; recent_form: string } | null;
  h2h: { total_games: number; p1_wins: number; p2_wins: number; avg_total: number | null; recent: Record<string, unknown>[] } | null;
  analysis: {
    score_bands: { total: ScoreBand | null; p1: ScoreBand | null; p2: ScoreBand | null } | null;
    ppm_model: { total: number; p1: number; p2: number; vs_h2h_diff: number | null } | null;
    win_edge: { favored: string; edge_pct: number } | null;
  } | null;
}

/* ============================================================================
   ATOMS
   ========================================================================== */
const Card = ({ children, style, glow }: { children?: React.ReactNode; style?: React.CSSProperties; glow?: boolean }) => (
  <div style={{
    ...GLASS,
    borderRadius: 16,
    padding: 18,
    ...(glow ? {
      background:  C.glassAccent,
      border:      `1px solid ${C.glassAccentBorder}`,
      boxShadow: [
        `inset 0 1px 0 ${C.glassAccentSpec}`,
        "0 8px 32px rgba(0,0,0,0.40)",
        "0 0 24px rgba(61,245,160,0.10)",
      ].join(", "),
    } : {}),
    ...style,
  }}>{children}</div>
);

const Label = ({ children }: { children?: React.ReactNode }) => (
  <div style={{ fontSize: 10.5, letterSpacing: 1.4, textTransform: "uppercase", color: C.muted, fontWeight: 700, marginBottom: 6 }}>{children}</div>
);

const Badge = ({ tone = "muted", children }: { tone?: string; children?: React.ReactNode }) => {
  const map: Record<string, string> = { pos: C.pos, neg: C.neg, amber: C.amber, blue: C.blue, muted: C.muted };
  const fg = map[tone] || C.muted;
  return (
    <span style={{
      color: fg,
      background: `${fg}1a`,
      border: `1px solid ${fg}40`,
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      boxShadow: `inset 0 1px 0 ${fg}22`,
      padding: "2px 9px",
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace",
      whiteSpace: "nowrap",
    }}>{children}</span>
  );
};

const selStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box",
  ...GLASS_INPUT,
  borderRadius: 9, color: C.text, padding: "9px 10px",
  fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: "none",
};

const Field = ({ label, value, onChange, type = "text", placeholder, step, mono = true, width }: { label?: string; value?: string | number; onChange: (v: string) => void; type?: string; placeholder?: string; step?: string | number; mono?: boolean; width?: string | number }) => (
  <div style={{ width }}>
    {label && <Label>{label}</Label>}
    <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} type={type} step={step} placeholder={placeholder}
      style={{ width: "100%", boxSizing: "border-box", ...GLASS_INPUT,
        borderRadius: 9, padding: "9px 11px", color: C.text, fontSize: 13.5,
        fontFamily: mono ? "'JetBrains Mono', monospace" : "'Archivo', sans-serif", outline: "none" }}
      onFocus={(e) => { e.target.style.borderColor = C.glassAccentBorder; e.target.style.boxShadow = `inset 0 2px 4px rgba(0,0,0,0.20), 0 0 0 1px ${C.glassAccentBorder}`; }}
      onBlur={(e) => { e.target.style.borderColor = C.glassBorder; e.target.style.boxShadow = "inset 0 2px 4px rgba(0,0,0,0.20)"; }} />
  </div>
);

const Btn = ({ children, onClick, kind = "ghost", disabled, style }: { children?: React.ReactNode; onClick?: () => void; kind?: string; disabled?: boolean; style?: React.CSSProperties }) => {
  const kinds: Record<string, React.CSSProperties> = {
    primary: {
      background: "rgba(61,245,160,0.14)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(61,245,160,0.32)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 0 14px rgba(61,245,160,0.12)",
      color: C.accent,
      fontWeight: 700,
    },
    ghost: {
      ...GLASS_INPUT,
      color: C.muted,
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10)",
    },
    danger: {
      background: "rgba(255,93,82,0.12)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      border: "1px solid rgba(255,93,82,0.28)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10)",
      color: C.neg,
    },
  };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 9,
        fontSize: 13, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
        fontFamily: "'Archivo', sans-serif", letterSpacing: 0.3, transition: "transform .08s ease, background 180ms ease, border-color 180ms ease, box-shadow 180ms ease",
        ...kinds[kind], ...style }}
      onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.98)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}>{children}</button>
  );
};

const Stat = ({ label, value, sub, tone }: { label?: React.ReactNode; value?: React.ReactNode; sub?: React.ReactNode; tone?: string }) => (
  <div style={{ flex: "1 1 0", minWidth: 110 }}>
    <Label>{label}</Label>
    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 26, fontWeight: 700,
      color: tone || C.text, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: C.faint, marginTop: 5 }}>{sub}</div>}
  </div>
);

const Empty = ({ icon, title, body }: { icon?: React.ReactNode; title?: React.ReactNode; body?: React.ReactNode }) => (
  <div style={{ ...GLASS, borderRadius: 16, padding: "48px 32px", textAlign: "center", color: C.muted }}>
    <div style={{ display: "inline-flex", padding: 20, borderRadius: "50%", ...GLASS, marginBottom: 18 }}>{icon}</div>
    <div style={{ fontSize: 16, color: C.text, fontWeight: 700, marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 13, maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>{body}</div>
  </div>
);

/* ============================================================================
   MAIN
   ========================================================================== */
export default function GGBetAnalyzer() {
  const [tab, setTab] = useState("analyze");
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [wf, setWf] = useState([]);
  const [bets, setBets] = useState<Record<string, unknown>[]>([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [lateNight, setLateNight] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [upcoming, setUpcoming] = useState<UpcomingGame[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);

  // hydrate
  useEffect(() => {
    (async () => {
      setPlayers(await loadKey(K.players, []));
      setMatches(await loadKey(K.matches, []));
      setWf(await loadKey(K.walkforward, []));
      setBets(await loadKey(K.bets, []));
      setSettings({ ...DEFAULT_SETTINGS, ...(await loadKey(K.settings, {})) });
      const h = new Date().getHours();
      setLateNight(h >= 23 || h < 5);
      setLoaded(true);
    })();
  }, []);
  // persist
  useEffect(() => { if (loaded) saveKey(K.players, players); }, [players, loaded]);
  useEffect(() => { if (loaded) saveKey(K.matches, matches); }, [matches, loaded]);
  useEffect(() => { if (loaded) saveKey(K.walkforward, wf); }, [wf, loaded]);
  useEffect(() => { if (loaded) saveKey(K.bets, bets); }, [bets, loaded]);
  useEffect(() => { if (loaded) saveKey(K.settings, settings); }, [settings, loaded]);
  // clock
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);

  // upcoming fetch — uses a generation counter so stale in-flight responses are discarded
  const upcomingGenRef = React.useRef(0);
  async function fetchUpcomingFeed() {
    const gen = ++upcomingGenRef.current;
    setUpcomingLoading(true);
    setUpcomingError(null);
    try {
      const res = await fetch("/api/upcoming-feed?days=2&history=60");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (gen === upcomingGenRef.current) setUpcoming(data.upcoming || []);
    } catch (e: unknown) {
      if (gen === upcomingGenRef.current) setUpcomingError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === upcomingGenRef.current) setUpcomingLoading(false);
    }
  }
  useEffect(() => {
    if (tab !== "upcoming") return;
    fetchUpcomingFeed();
    const iv = setInterval(fetchUpcomingFeed, 5 * 60 * 1000);
    return () => { clearInterval(iv); upcomingGenRef.current++; /* invalidate any in-flight fetch */ };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const TABS = [
    { id: "data", label: "Data Manager", icon: <Database size={16} /> },
    { id: "analyze", label: "Matchup Analyzer", icon: <Crosshair size={16} /> },
    { id: "upcoming", label: "Upcoming Games", icon: <Calendar size={16} /> },
    { id: "log", label: "Bet Logger", icon: <ClipboardList size={16} /> },
    { id: "insights", label: "Historical Insights", icon: <LineIcon size={16} /> },
    { id: "ai", label: "AI Assistant", icon: <Bot size={16} /> },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Archivo', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; transition: background 180ms ease, border-color 180ms ease, box-shadow 180ms ease; }
        ::-webkit-scrollbar { width: 9px; height: 9px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 9px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::selection { background: ${C.accent}33; }
        input::placeholder { color: ${C.faint}; }
        :focus-visible { outline: 2px solid rgba(61,245,160,0.60); outline-offset: 2px; }
        @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .rise { animation: rise .4s ease both; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .live { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        select { -webkit-appearance:none; appearance:none; }
        button:not(:disabled):hover { filter: brightness(1.08); }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      {/* atmospheric backdrop */}
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none",
        background: `
          radial-gradient(ellipse 1400px 700px at 80% -20%, rgba(61,245,160,0.09), transparent 65%),
          radial-gradient(ellipse 1000px 600px at 0% 110%, rgba(95,176,255,0.07), transparent 60%),
          radial-gradient(ellipse 900px 500px at 50% 50%, rgba(61,245,160,0.025), transparent 70%)
        ` }} />

      {/* header */}
      <header style={{ position: "sticky", top: 0, zIndex: 20,
        background: "rgba(4,6,13,0.72)",
        backdropFilter: "blur(32px) saturate(180%)",
        WebkitBackdropFilter: "blur(32px) saturate(180%)",
        borderBottom: `1px solid ${C.glassBorder}`,
        boxShadow: `inset 0 -1px 0 ${C.glassInner}, 0 1px 0 rgba(255,255,255,0.04)`,
        padding: "14px 22px",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: C.accent, color: "#04130c",
            display: "grid", placeItems: "center", fontWeight: 900, fontSize: 18, fontFamily: "'Archivo'" }}>G</div>
          <div>
            <div style={{ fontWeight: 900, letterSpacing: 1, fontSize: 18 }}>
              GGBET<span style={{ color: C.accent }}>//</span>ANALYZER
            </div>
            <div style={{ fontSize: 10.5, color: C.muted, letterSpacing: 1.5, textTransform: "uppercase" }}>
              eBasketball H2H GG League · 4×5
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "'JetBrains Mono'", fontSize: 13 }}>
            <span className="live" style={{ width: 7, height: 7, borderRadius: 99, background: C.accent }} />
            {clock.toLocaleTimeString([], { hour12: false })}
          </div>
          <button onClick={() => setLateNight((v) => !v)} title="Toggle late-night fatigue model"
            style={{ display: "inline-flex", alignItems: "center", gap: 6,
              background: lateNight ? "rgba(255,194,75,0.12)" : C.glass,
              backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
              color: lateNight ? C.amber : C.muted,
              border: `1px solid ${lateNight ? "rgba(255,194,75,0.30)" : C.glassBorder}`,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10)",
              borderRadius: 9, padding: "7px 11px", cursor: "pointer", fontSize: 12, fontFamily: "'Archivo'",
              transition: "background 180ms ease, border-color 180ms ease" }}>
            {lateNight ? <Moon size={14} /> : <Sun size={14} />}{lateNight ? "Late-night" : "Daytime"}
          </button>
        </div>
      </header>

      {/* tab nav */}
      <nav style={{ padding: "16px 22px 0" }}>
        <div style={{
          display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 4,
          background: "rgba(255,255,255,0.04)",
          backdropFilter: "blur(16px) saturate(150%)",
          WebkitBackdropFilter: "blur(16px) saturate(150%)",
          border: `1px solid ${C.glassBorder}`,
          boxShadow: `inset 0 1px 0 ${C.glassSpec}, inset 0 0 0 1px ${C.glassInner}, 0 8px 32px rgba(0,0,0,0.40)`,
          borderRadius: 14,
        }}>
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 16px",
                  borderRadius: 10,
                  ...(on ? {
                    background: C.glassAccent,
                    border: `1px solid ${C.glassAccentBorder}`,
                    boxShadow: [
                      `inset 0 1px 0 ${C.glassAccentSpec}`,
                      "inset 0 0 0 1px rgba(61,245,160,0.08)",
                      "0 4px 12px rgba(0,0,0,0.30)",
                      "0 0 16px rgba(61,245,160,0.10)",
                    ].join(", "),
                    color: C.text,
                  } : {
                    background: "transparent",
                    border: "1px solid transparent",
                    color: C.muted,
                  }),
                  cursor: "pointer", fontSize: 13, fontWeight: on ? 700 : 500, fontFamily: "'Archivo'",
                  transition: "background 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease" }}>
                <span style={{ color: on ? C.accent : C.faint }}>{t.icon}</span>{t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <main style={{ position: "relative", padding: "22px", maxWidth: 1180, margin: "0 auto" }}>
        {!loaded ? (
          <div style={{ color: C.muted, padding: 40, textAlign: "center" }}>Loading terminal…</div>
        ) : tab === "data" ? (
          <DataManager players={players} setPlayers={setPlayers} matches={matches} setMatches={setMatches}
            wf={wf} setWf={setWf} settings={settings} setSettings={setSettings} />
        ) : tab === "analyze" ? (
          <Analyzer players={players} settings={settings} lateNight={lateNight} matches={matches} wf={wf}
            onLog={(b: Record<string, unknown>) => setBets((p) => [b, ...p])} />
        ) : tab === "upcoming" ? (
          <UpcomingGamesFeed upcoming={upcoming} loading={upcomingLoading} error={upcomingError} onRefresh={fetchUpcomingFeed} />
        ) : tab === "log" ? (
          <BetLogger bets={bets} setBets={setBets} players={players} />
        ) : tab === "insights" ? (
          <Insights bets={bets} matches={matches} players={players} settings={settings} lateNight={lateNight} wf={wf} />
        ) : (
          <AIAssistant players={players} settings={settings} lateNight={lateNight} bets={bets} matches={matches} wf={wf} />
        )}
      </main>

      <footer style={{ position: "relative", textAlign: "center", padding: "26px 18px 40px", color: C.faint, fontSize: 11.5, lineHeight: 1.6 }}>
        Models are estimates from your own data — not guarantees. Bet only what you can afford to lose · 21+ ·
        Help: 1-800-522-4700.<br />Collect public stats yourself and import them; respect h2hggl.com's terms.
      </footer>
    </div>
  );
}

/* ============================================================================
   DATA MANAGER  — CSV import / manual entry / model params (no fake data)
   ========================================================================== */
function DataManager({ players, setPlayers, matches, setMatches, wf, setWf, settings, setSettings }) {
  const [draft, setDraft] = useState(blankPlayer());
  const [editIdx, setEditIdx] = useState(-1);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  function upsert() {
    if (!draft.name?.trim()) { setMsg({ t: "neg", m: "Player name required." }); return; }
    const clean = { ...draft, name: draft.name.trim(), last_updated: new Date().toISOString() };
    setPlayers((prev) => {
      const i = prev.findIndex((p) => p.name.toLowerCase() === clean.name.toLowerCase());
      if (i >= 0) { const cp = [...prev]; cp[i] = { ...cp[i], ...clean }; return cp; }
      return [...prev, clean].sort((a, b) => a.name.localeCompare(b.name));
    });
    setDraft(blankPlayer()); setEditIdx(-1);
    setMsg({ t: "pos", m: `Saved ${clean.name}.` });
  }

  function importCsv(text) {
    const res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    let added = 0, updated = 0;
    const rows = res.data.filter((r) => (r.name || "").trim());
    setPlayers((prev) => {
      const map = new Map(prev.map((p) => [p.name.toLowerCase(), p]));
      rows.forEach((r) => {
        const rec = {
          name: r.name.trim(),
          win_pct: num(r.win_pct), pts_per_match: num(r.pts_per_match), fg_pct: num(r.fg_pct),
          steals: num(r.steals), fouls: num(r.fouls), gp: num(r.gp), w: num(r.w), l: num(r.l),
          recent_form: (r.recent_form || "").toString().toUpperCase().replace(/[^WL]/g, ""),
          nba_team: (r.nba_team || "").toString(), last_updated: new Date().toISOString(),
        };
        const key = rec.name.toLowerCase();
        if (map.has(key)) { map.set(key, { ...map.get(key), ...rec }); updated++; }
        else { map.set(key, rec); added++; }
      });
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
    setMsg({ t: "pos", m: `Imported ${added} new · updated ${updated}.` });
  }

  function onFile(e) {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importCsv(String(reader.result));
    reader.readAsText(f); e.target.value = "";
  }

  function downloadTemplate() {
    const csv = CSV_COLS.join(",") + "\n"; // header only — you fill it with real numbers
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ggba_players_template.csv"; a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportPlayers() {
    if (!players.length) return;
    const csv = Papa.unparse(players.map((p) => { const o = {}; CSV_COLS.forEach((c) => (o[c] = p[c] ?? "")); return o; }));
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ggba_players_export.csv"; a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      {/* acquisition note */}
      <Card>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <AlertTriangle size={18} color={C.amber} style={{ marginTop: 2, flexShrink: 0 }} />
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.55 }}>
            <b style={{ color: C.text }}>Real data in, no fabricated rows.</b> The terminal aggregates and models the
            stats <i>you</i> provide. Pull the public figures from h2hggl.com / leaderboards yourself (per their terms),
            then import the CSV below or add players by hand. Columns mirror the h2hggl player schema:
            <span style={{ fontFamily: "'JetBrains Mono'", color: C.faint }}> {CSV_COLS.join(" · ")}</span>.
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 18 }}>
        {/* import / actions */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Roster · <span style={{ fontFamily: "'JetBrains Mono'", color: C.accent }}>{players.length}</span> players</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input ref={fileRef} type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
              <Btn onClick={() => fileRef.current?.click()}><Upload size={15} />Import CSV</Btn>
              <Btn onClick={downloadTemplate}><Download size={15} />Template</Btn>
              <Btn onClick={exportPlayers} disabled={!players.length}><Download size={15} />Export</Btn>
            </div>
          </div>
          {msg && <div style={{ marginBottom: 12 }}><Badge tone={msg.t}>{msg.m}</Badge></div>}

          {/* manual entry */}
          <Label>Add / update a player</Label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, marginBottom: 12 }}>
            <Field label="Name" mono={false} value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="e.g. LANES" />
            <Field label="Win %" value={draft.win_pct} onChange={(v) => setDraft({ ...draft, win_pct: v })} placeholder="0–100" />
            <Field label="Pts/Match" value={draft.pts_per_match} onChange={(v) => setDraft({ ...draft, pts_per_match: v })} />
            <Field label="FG %" value={draft.fg_pct} onChange={(v) => setDraft({ ...draft, fg_pct: v })} />
            <Field label="Steals" value={draft.steals} onChange={(v) => setDraft({ ...draft, steals: v })} />
            <Field label="Fouls" value={draft.fouls} onChange={(v) => setDraft({ ...draft, fouls: v })} />
            <Field label="GP" value={draft.gp} onChange={(v) => setDraft({ ...draft, gp: v })} />
            <Field label="W" value={draft.w} onChange={(v) => setDraft({ ...draft, w: v })} />
            <Field label="L" value={draft.l} onChange={(v) => setDraft({ ...draft, l: v })} />
            <Field label="Form" value={draft.recent_form} onChange={(v) => setDraft({ ...draft, recent_form: v })} placeholder="WWLWL" />
            <Field label="NBA Team" mono={false} value={draft.nba_team} onChange={(v) => setDraft({ ...draft, nba_team: v })} placeholder="optional" />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="primary" onClick={upsert}><Plus size={15} />Save player</Btn>
            {editIdx >= 0 && <Btn onClick={() => { setDraft(blankPlayer()); setEditIdx(-1); }}><X size={15} />Cancel</Btn>}
          </div>
        </Card>

        {/* roster table */}
        <Card style={{ padding: 0, overflow: "hidden" }}>
          {players.length === 0 ? (
            <Empty icon={<Database size={26} color={C.muted} />} title="No players yet"
              body="Import a CSV of real stats or add a player above. The model needs at least the two competitors you want to analyze." />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono'" }}>
                <thead>
                  <tr style={{ color: C.muted, textAlign: "right" }}>
                    {["Player","Win%","PPM","FG%","STL","PF","GP","Form","Eff","",""].map((h, i) => (
                      <th key={i} style={{ padding: "11px 12px", textAlign: i === 0 || i === 7 ? "left" : "right",
                        borderBottom: `1px solid ${C.border}`, fontWeight: 700, letterSpacing: 0.5, position: "sticky", top: 0, background: C.surface }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => {
                    const low = num(p.gp) < 20;
                    return (
                      <tr key={p.name} style={{ borderBottom: `1px solid ${C.border}55` }}>
                        <td style={{ padding: "9px 12px", color: C.text, fontWeight: 700, fontFamily: "'Archivo'" }}>
                          {p.name}{low && <span title="Low sample" style={{ color: C.amber, marginLeft: 6 }}>⚠</span>}
                          {p.nba_team && <span style={{ color: C.faint, fontWeight: 400, marginLeft: 6, fontFamily: "'Archivo'" }}>{p.nba_team}</span>}
                        </td>
                        <td style={tdR}>{num(p.win_pct).toFixed(1)}</td>
                        <td style={tdR}>{num(p.pts_per_match).toFixed(1)}</td>
                        <td style={tdR}>{num(p.fg_pct).toFixed(1)}</td>
                        <td style={tdR}>{num(p.steals).toFixed(1)}</td>
                        <td style={tdR}>{num(p.fouls).toFixed(1)}</td>
                        <td style={tdR}>{num(p.gp)}</td>
                        <td style={{ ...tdR, textAlign: "left" }}>{(p.recent_form || "—").split("").map((c, k) =>
                          <span key={k} style={{ color: c === "W" ? C.pos : c === "L" ? C.neg : C.faint }}>{c}</span>)}</td>
                        <td style={{ ...tdR, color: C.accent }}>{efficiency(p).toFixed(1)}</td>
                        <td style={{ padding: "9px 6px", textAlign: "right" }}>
                          <button title="Edit" onClick={() => { setDraft({ ...p }); setEditIdx(i); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                            style={iconBtn}><Edit3 size={14} /></button>
                        </td>
                        <td style={{ padding: "9px 10px 9px 0", textAlign: "right" }}>
                          <button title="Delete" onClick={() => setPlayers((pp) => pp.filter((x) => x.name !== p.name))}
                            style={{ ...iconBtn, color: C.neg }}><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* match results (for in-sample probe) */}
        <MatchEntry matches={matches} setMatches={setMatches} players={players} />

        {/* walk-forward snapshots (for out-of-sample backtest + calibration) */}
        <BetsAPIFetch setPlayers={setPlayers} setMatches={setMatches} setWf={setWf} />
        <WalkForwardImport wf={wf} setWf={setWf} />

        {/* model params */}
        <Card>
          <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Model parameters</div>
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Tune the projector. Changes persist and feed every tab.</div>

          {/* model selector */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: C.muted }}>Projection model</span>
            {[["rated", "Opponent + team ratings"], ["baseline", "Baseline ppm"]].map(([m, lab]) => (
              <button key={m} onClick={() => setSettings((s) => ({ ...s, modelMode: m }))}
                style={{ padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 700,
                  border: `1px solid ${settings.modelMode === m ? C.accent : C.border}`,
                  background: settings.modelMode === m ? C.accentDim : "transparent",
                  color: settings.modelMode === m ? C.text : C.muted }}>{lab}</button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
            {[
              ["dispersion", "Total dispersion", "σ = √(proj × this) · both models", 0.05],
              ["edgeThresh", "Edge alert threshold", "min edge to flag +EV", 0.005],
              ...(settings.modelMode === "rated"
                ? [["etaP", "Player learn rate", "ratings: per-player step", 0.01],
                   ["etaT", "Team learn rate", "ratings: per-team step (slower)", 0.01],
                   ["ratingDecay", "Rating decay", "recency shrink (0=off)", 0.005]]
                : [["formCoef", "Form coefficient", "±this at WWW/LLL", 0.01],
                   ["matchupCoef", "Matchup coefficient", "needs steals/fouls (feed=0)", 0.01],
                   ["variance", "Global scale ×", "1.00 = unbiased", 0.01],
                   ["shrinkK", "Shrinkage k", "regress low-GP → league mean", 1]]),
            ].map(([k, lab, sub, step]) => (
              <div key={k}>
                <Field label={lab} type="number" step={step} value={settings[k]}
                  onChange={(v) => setSettings((s) => ({ ...s, [k]: num(v) }))} />
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 4 }}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <Btn onClick={() => setSettings(DEFAULT_SETTINGS)}><RefreshCw size={14} />Reset to defaults</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

const MATCH_COLS = ["date", "player1", "player2", "score1", "score2", "total", "division"];
const matchKey = (m) => `${m.date}|${String(m.player1).toLowerCase()}|${String(m.player2).toLowerCase()}|${m.score1}|${m.score2}`;

function MatchEntry({ matches, setMatches, players }) {
  const [d, setD] = useState({ date: new Date().toISOString().slice(0, 10), player1: "", player2: "", score1: "", score2: "", division: "" });
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  function add() {
    if (!d.player1 || !d.player2 || d.score1 === "" || d.score2 === "") return;
    const m = { id: crypto.randomUUID(), ...d, score1: num(d.score1), score2: num(d.score2), total: num(d.score1) + num(d.score2) };
    setMatches((p) => [m, ...p]);
    setD({ ...d, player1: "", player2: "", score1: "", score2: "" });
  }

  function importCsv(text) {
    const res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const rows = res.data
      .filter((r) => (r.player1 || "").trim() && (r.player2 || "").trim() && r.score1 !== "" && r.score2 !== "")
      .map((r) => ({
        id: crypto.randomUUID(),
        date: (r.date || "").trim() || new Date().toISOString().slice(0, 10),
        player1: r.player1.trim(), player2: r.player2.trim(),
        score1: num(r.score1), score2: num(r.score2),
        total: r.total !== undefined && r.total !== "" ? num(r.total) : num(r.score1) + num(r.score2),
        division: (r.division || "").toString(),
      }));
    if (!rows.length) { setMsg({ t: "neg", m: "No valid rows. Need player1, player2, score1, score2." }); return; }
    let added = 0;
    setMatches((prev) => {
      const seen = new Set(prev.map(matchKey));   // dedup vs existing + within file
      const next = [...prev];
      rows.forEach((m) => { const k = matchKey(m); if (!seen.has(k)) { seen.add(k); next.push(m); added++; } });
      next.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return next;
    });
    setMsg({ t: "pos", m: `Imported ${added} · skipped ${rows.length - added} duplicate(s).` });
  }

  function onFile(e) {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importCsv(String(reader.result));
    reader.readAsText(f); e.target.value = "";
  }

  function downloadTemplate() {
    const blob = new Blob([MATCH_COLS.join(",") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ggba_matches_template.csv"; a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>Match results <span style={{ color: C.faint, fontWeight: 400, fontSize: 12 }}>· {matches.length} loaded · feeds backtest</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
          <Btn onClick={() => fileRef.current?.click()}><Upload size={15} />Import CSV</Btn>
          <Btn onClick={downloadTemplate}><Download size={15} />Template</Btn>
          {matches.length > 0 && <Btn kind="danger" onClick={() => { if (window.confirm("Clear all match results?")) { setMatches([]); setMsg(null); } }}><Trash2 size={15} />Clear</Btn>}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 10, fontFamily: "'JetBrains Mono'" }}>
        columns: {MATCH_COLS.join(" · ")} — drop in ggba_matches.csv from the BetsAPI fetcher
      </div>
      {msg && <div style={{ marginBottom: 12 }}><Badge tone={msg.t}>{msg.m}</Badge></div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 10, margin: "0 0 12px" }}>
        <Field label="Date" type="date" value={d.date} onChange={(v) => setD({ ...d, date: v })} />
        <div><Label>Player 1</Label><PlayerSelect players={players} value={d.player1} onChange={(v) => setD({ ...d, player1: v })} /></div>
        <div><Label>Player 2</Label><PlayerSelect players={players} value={d.player2} onChange={(v) => setD({ ...d, player2: v })} /></div>
        <Field label="Score 1" value={d.score1} onChange={(v) => setD({ ...d, score1: v })} />
        <Field label="Score 2" value={d.score2} onChange={(v) => setD({ ...d, score2: v })} />
        <Field label="Division" mono={false} value={d.division} onChange={(v) => setD({ ...d, division: v })} placeholder="optional" />
      </div>
      <Btn kind="primary" onClick={add}><Plus size={15} />Add result manually</Btn>
      {matches.length > 0 && (
        <div style={{ marginTop: 14, maxHeight: 180, overflowY: "auto" }}>
          {matches.slice(0, 30).map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "7px 0", borderBottom: `1px solid ${C.border}55`, fontSize: 12.5, fontFamily: "'JetBrains Mono'" }}>
              <span style={{ color: C.muted }}>{m.date}</span>
              <span style={{ color: C.text }}>{m.player1} {m.score1}–{m.score2} {m.player2}</span>
              <span style={{ color: C.accent }}>Σ{m.total}</span>
              <button onClick={() => setMatches((p) => p.filter((x) => x.id !== m.id))} style={{ ...iconBtn, color: C.neg }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---- walk-forward snapshot importer ------------------------------------- */
const WF_COLS = ["date","player1","player2","p1_team","p2_team","p1_win_pct","p1_ppm","p1_form","p1_gp","p2_win_pct","p2_ppm","p2_form","p2_gp","score1","score2","actual_total","hour_utc"];
const wfKey = (r) => `${r.date}|${String(r.player1).toLowerCase()}|${String(r.player2).toLowerCase()}|${r.score1}|${r.score2}`;

function WalkForwardImport({ wf, setWf }) {
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  function importCsv(text) {
    const res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    const rows = res.data
      .filter((r) => (r.player1 || "").trim() && (r.player2 || "").trim() && r.actual_total !== undefined && r.actual_total !== "")
      .map((r) => ({
        date: (r.date || "").trim(), player1: r.player1.trim(), player2: r.player2.trim(),
        p1_team: (r.p1_team || "").trim(), p2_team: (r.p2_team || "").trim(),
        p1_win_pct: r.p1_win_pct, p1_ppm: r.p1_ppm, p1_form: (r.p1_form || "").toUpperCase().replace(/[^WL]/g, ""), p1_gp: num(r.p1_gp),
        p2_win_pct: r.p2_win_pct, p2_ppm: r.p2_ppm, p2_form: (r.p2_form || "").toUpperCase().replace(/[^WL]/g, ""), p2_gp: num(r.p2_gp),
        score1: num(r.score1), score2: num(r.score2), actual_total: num(r.actual_total), hour_utc: r.hour_utc,
      }));
    if (!rows.length) { setMsg({ t: "neg", m: "No valid rows (need player1/2 + actual_total)." }); return; }
    let added = 0;
    setWf((prev) => {
      const seen = new Set(prev.map(wfKey)); const next = [...prev];
      rows.forEach((r) => { const k = wfKey(r); if (!seen.has(k)) { seen.add(k); next.push(r); added++; } });
      next.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      return next;
    });
    setMsg({ t: "pos", m: `Imported ${added} · skipped ${rows.length - added} dup(s).` });
  }
  function onFile(e) { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => importCsv(String(rd.result)); rd.readAsText(f); e.target.value = ""; }
  function template() {
    const blob = new Blob([WF_COLS.join(",") + "\n"], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ggba_walkforward_template.csv"; a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>Walk-forward snapshots <span style={{ color: C.faint, fontWeight: 400, fontSize: 12 }}>· {wf.length} loaded · out-of-sample backtest + calibration</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
          <Btn onClick={() => fileRef.current?.click()}><Upload size={15} />Import CSV</Btn>
          <Btn onClick={template}><Download size={15} />Template</Btn>
          {wf.length > 0 && <Btn kind="danger" onClick={() => { if (window.confirm("Clear walk-forward data?")) { setWf([]); setMsg(null); } }}><Trash2 size={15} />Clear</Btn>}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 10, lineHeight: 1.5 }}>
        Drop in <span style={{ fontFamily: "'JetBrains Mono'" }}>ggba_walkforward.csv</span> from the fetcher. Each row carries the players' pre-match stats
        (computed only from earlier games) so the backtest projects every game using nothing it couldn't have known at tip-off — no leakage.
      </div>
      {msg && <Badge tone={msg.t}>{msg.m}</Badge>}
    </Card>
  );
}

// ── BetsAPI live fetch card (calls Next.js /api/fetch-games) ──────────────────
function BetsAPIFetch({ setPlayers, setMatches, setWf }: {
  setPlayers: (fn: (prev: unknown[]) => unknown[]) => void;
  setMatches: (fn: (prev: unknown[]) => unknown[]) => void;
  setWf: (fn: (prev: unknown[]) => unknown[]) => void;
}) {
  const [days, setDays] = React.useState("14");
  const [minGp, setMinGp] = React.useState("1");
  const [source, setSource] = React.useState<"h2hggl" | "betsapi">("h2hggl");
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<{ t: "pos"|"neg"|"amber"; m: string } | null>(null);

  const endpoint = source === "h2hggl" ? "/api/h2hggl-games" : "/api/fetch-games";

  async function fetchData() {
    setLoading(true); setResult(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: parseInt(days, 10), minGp: parseInt(minGp, 10) }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "API error");

      const { walkforward, players: newPlayers, matches: newMatches, meta } = data;

      // Merge walk-forward rows (dedup by wfKey)
      setWf((prev: unknown[]) => {
        const prevRows = prev as Array<Record<string, unknown>>;
        const wfRows = walkforward as Array<Record<string, unknown>>;
        const seen = new Set(prevRows.map(wfKey));
        const next = [...prevRows];
        let added = 0;
        wfRows.forEach((r) => {
          const k = wfKey(r);
          if (!seen.has(k)) { seen.add(k); next.push(r); added++; }
        });
        next.sort((a, b) => ((a.date as string) || "").localeCompare((b.date as string) || ""));
        return next;
      });

      // Merge players (upsert by name)
      setPlayers((prev: unknown[]) => {
        const prevPlayers = prev as Array<Record<string, unknown>>;
        const map = new Map(prevPlayers.map((p) => [(p.name as string).toLowerCase(), p]));
        (newPlayers as Array<Record<string, unknown>>).forEach((p) => {
          const rec = { ...p, last_updated: new Date().toISOString() };
          map.set((p.name as string).toLowerCase(), rec);
        });
        return [...map.values()].sort((a, b) =>
          (a.name as string).localeCompare(b.name as string));
      });

      // Merge matches
      setMatches((prev: unknown[]) => {
        const prevMatches = prev as Array<Record<string, unknown>>;
        const key = (m: Record<string, unknown>) => `${m.date}|${m.player1}|${m.player2}`;
        const seen = new Set(prevMatches.map(key));
        const next = [...prevMatches];
        (newMatches as Array<Record<string, unknown>>).forEach((m) => { if (!seen.has(key(m))) { seen.add(key(m)); next.push(m); } });
        return next;
      });

      setResult({ t: "pos", m: `✓ Fetched ${meta.games} games (${days}d) → ${walkforward.length} WF rows, ${newPlayers.length} players.` });
    } catch (e) {
      setResult({ t: "neg", m: `Error: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card style={{ borderColor: C.accentDim }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 15 }}>
          <span style={{ color: C.accent }}>⬇ Fetch live data</span>
          <span style={{ color: C.faint, fontWeight: 400, fontSize: 12, marginLeft: 10 }}>server-side · no keys leak to the browser</span>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 12, lineHeight: 1.5 }}>
        {source === "h2hggl" ? (
          <>Pulls GG League games + players from the free self-hosted <strong>H2H GG League</strong> scraper, builds walk-forward snapshots, and populates players + matches (including FG%, steals &amp; fouls) — all in one click. Requires the scraper running with <code style={{ fontFamily: "'JetBrains Mono'", background: C.surface2, padding: "1px 5px", borderRadius: 4 }}>H2HGGL_API_URL</code> set (see <code style={{ fontFamily: "'JetBrains Mono'", background: C.surface2, padding: "1px 5px", borderRadius: 4 }}>/scraper</code>).</>
        ) : (
          <>Pulls ended GG League events from BetsAPI (optional paid fallback). Requires <code style={{ fontFamily: "'JetBrains Mono'", background: C.surface2, padding: "1px 5px", borderRadius: 4 }}>BETSAPI_TOKEN</code>. Note: FG%, steals &amp; fouls are not in the BetsAPI feed.</>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <Label>Source</Label>
          <select value={source} onChange={(e) => setSource(e.target.value as "h2hggl" | "betsapi")} style={selStyle}>
            <option value="h2hggl">H2H GG League (free)</option>
            <option value="betsapi">BetsAPI (fallback)</option>
          </select>
        </div>
        <div>
          <Label>Days of history</Label>
          <select value={days} onChange={(e) => setDays(e.target.value)} style={selStyle}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </div>
        <div>
          <Label>Min GP to include player</Label>
          <select value={minGp} onChange={(e) => setMinGp(e.target.value)} style={selStyle}>
            {[1, 3, 5, 10, 20].map((g) => <option key={g} value={g}>{g} games</option>)}
          </select>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          style={{
            background: loading ? C.surface2 : C.accent,
            color: loading ? C.muted : "#000",
            border: "none", borderRadius: 10, padding: "10px 22px",
            fontFamily: "'Archivo'", fontWeight: 800, fontSize: 13.5,
            cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6,
          }}
        >
          {loading ? "Fetching…" : "Fetch data"}
        </button>
      </div>
      {result && <div style={{ marginTop: 10 }}><Badge tone={result.t}>{result.m}</Badge></div>}
    </Card>
  );
}

function Analyzer({ players, settings, lateNight, matches, wf, onLog }) {
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [t1Sel, setT1Sel] = useState(""); // "" = auto (modal team)
  const [t2Sel, setT2Sel] = useState("");
  const [totalLine, setTotalLine] = useState("");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");
  const [mlOdds1, setMlOdds1] = useState("");
  const [mlOdds2, setMlOdds2] = useState("");
  const [spreadLine, setSpreadLine] = useState(""); // points for player 1 (negative = favored)
  const [spreadOdds, setSpreadOdds] = useState("-110");
  const [books, setBooks] = useState([{ book: "Book A", over: "", under: "" }, { book: "Book B", over: "", under: "" }, { book: "Book C", over: "", under: "" }]);
  const [logged, setLogged] = useState(false);

  const p1 = players.find((p) => p.name === n1);
  const p2 = players.find((p) => p.name === n2);

  const wfGames = wf || [];
  // train the rating model on all loaded walk-forward games (chronological)
  const ratings = useMemo(() => buildRatingsModel(
    wfGames.map((r) => ({ p1: r.player1, t1: r.p1_team || "", p2: r.player2, t2: r.p2_team || "", s1: r.score1, s2: r.score2 })),
    settings), [wfGames, settings]);
  const marginRatio = useMemo(() => marginRatioFrom(wfGames), [wfGames]);
  // modal (most-frequent) team per player + dropdown options, from walk-forward history
  const { modalTeam, teamOpts } = useMemo(() => {
    const cnt = {}, set = new Set();
    wfGames.forEach((r) => {
      if (r.p1_team) { set.add(r.p1_team); (cnt[r.player1] ??= {})[r.p1_team] = (cnt[r.player1]?.[r.p1_team] || 0) + 1; }
      if (r.p2_team) { set.add(r.p2_team); (cnt[r.player2] ??= {})[r.p2_team] = (cnt[r.player2]?.[r.p2_team] || 0) + 1; }
    });
    const modal = {};
    Object.entries(cnt).forEach(([p, ts]) => { modal[p] = Object.entries(ts).sort((a, b) => b[1] - a[1])[0]?.[0] || ""; });
    return { modalTeam: modal, teamOpts: [...set].sort() };
  }, [wfGames]);

  const effT1 = t1Sel || (p1 ? modalTeam[p1.name] : "") || (p1 ? p1.nba_team : "") || "";
  const effT2 = t2Sel || (p2 ? modalTeam[p2.name] : "") || (p2 ? p2.nba_team : "") || "";
  const ratedLive = settings.modelMode === "rated" && p1 && p2 && ratings.seen(p1.name) && ratings.seen(p2.name);

  const lgMean = useMemo(() => leagueMeanPpm(players), [players]);
  const proj = useMemo(() => computeProjection(p1, p2, settings, lateNight, { leagueMean: lgMean, ratings, team1: effT1, team2: effT2 }),
    [p1, p2, settings, lateNight, lgMean, ratings, effT1, effT2]);

  // head-to-head penalty from stored matches (dominance of p2 over p1 in their meetings)
  const h2hPenalty = useMemo(() => {
    if (!p1 || !p2) return 0;
    const games = matches.filter((m) =>
      [m.player1, m.player2].includes(p1.name) && [m.player1, m.player2].includes(p2.name));
    if (!games.length) return 0;
    let p2wins = 0;
    games.forEach((m) => {
      const p1score = m.player1 === p1.name ? m.score1 : m.score2;
      const p2score = m.player1 === p2.name ? m.score1 : m.score2;
      if (p2score > p1score) p2wins++;
    });
    return (p2wins / games.length - 0.5) * 2; // -1..+1, positive => p2 dominates p1
  }, [p1, p2, matches]);

  const wp = useMemo(() => (p1 && p2 ? winProb(p1, p2, h2hPenalty, settings) : null), [p1, p2, h2hPenalty, settings]);

  // totals edge
  const pOver = proj && totalLine !== "" ? probOver(proj.projected, proj.sigma, totalLine) : null;
  const pUnder = pOver == null ? null : 1 - pOver;
  const overEdge = pOver == null ? null : pOver - (impliedProb(overOdds) ?? 0);
  const underEdge = pUnder == null ? null : pUnder - (impliedProb(underOdds) ?? 0);

  // spread: margin ~ Normal(p1_proj - p2_proj, sigma_margin)
  const margin = proj ? proj.p1_proj - proj.p2_proj : null;
  const sigmaMargin = proj ? proj.sigma * marginRatio : null;
  const pCover = proj && spreadLine !== "" ? (1 - normCdf((-num(spreadLine) - margin) / sigmaMargin)) : null;
  const spreadEdge = pCover == null ? null : pCover - (impliedProb(spreadOdds) ?? 0);

  // distribution curve for chart
  const dist = useMemo(() => {
    if (!proj) return [];
    const out = [];
    for (let x = proj.projected - 3.2 * proj.sigma; x <= proj.projected + 3.2 * proj.sigma; x += proj.sigma / 8) {
      const d = Math.exp(-0.5 * ((x - proj.projected) / proj.sigma) ** 2) / (proj.sigma * Math.sqrt(2 * Math.PI));
      out.push({ x: r1(x), d: d * 1000 });
    }
    return out;
  }, [proj]);

  function logTotal(side, oddsOverride) {
    const p = side === "Over" ? pOver : pUnder;
    const odds = oddsOverride != null && oddsOverride !== "" ? oddsOverride : (side === "Over" ? overOdds : underOdds);
    onLog({
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      matchup: `${p1.name} vs ${p2.name}`, bet_type: "Total", line: `${side} ${totalLine}`,
      proj_value: proj.projected, model_prob: +(p * 100).toFixed(1), odds: num(odds),
      close_side: "", close_other: "",                 // fill at close for CLV tracking
      stake: "", outcome: "Pending", profit: 0, notes: `edge ${(((p) - (impliedProb(odds) ?? 0)) * 100).toFixed(1)}%`,
    });
    flash();
  }
  function flash() { setLogged(true); setTimeout(() => setLogged(false), 1500); }

  const need = !p1 || !p2;

  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      {/* selectors */}
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 14, alignItems: "end" }}>
          <div>
            <Label>Player 1 (home line)</Label>
            <PlayerSelect players={players} value={n1} onChange={setN1} />
          </div>
          <div style={{ fontFamily: "'Archivo'", fontWeight: 900, color: C.faint, fontSize: 20, paddingBottom: 6 }}>VS</div>
          <div>
            <Label>Player 2</Label>
            <PlayerSelect players={players} value={n2} onChange={setN2} />
          </div>
        </div>
        {settings.modelMode === "rated" && teamOpts.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 14, alignItems: "end", marginTop: 10 }}>
            <div>
              <Label>Team skin (P1)</Label>
              <select value={t1Sel} onChange={(e) => setT1Sel(e.target.value)} style={selStyle}>
                <option value="">auto · {effT1 || "—"}</option>
                {teamOpts.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 10, color: C.faint, paddingBottom: 8 }}>skins</div>
            <div>
              <Label>Team skin (P2)</Label>
              <select value={t2Sel} onChange={(e) => setT2Sel(e.target.value)} style={selStyle}>
                <option value="">auto · {effT2 || "—"}</option>
                {teamOpts.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        )}
        {players.length < 2 && (
          <div style={{ marginTop: 12 }}><Badge tone="amber">Add at least 2 players in Data Manager to analyze.</Badge></div>
        )}
        {!need && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge tone={ratedLive ? "pos" : "muted"}>
              {ratedLive ? "opponent + team rating model" : settings.modelMode === "rated" ? "baseline (player unseen in walk-forward — load history)" : "baseline ppm model"}
            </Badge>
            {proj.confidence === "Low" && <Badge tone="amber">Low sample (min GP {proj.minGp}). Treat projections as soft.</Badge>}
          </div>
        )}
      </Card>

      {need ? (
        <Card><Empty icon={<Crosshair size={26} color={C.muted} />} title="Pick a matchup"
          body="Select two players above to generate total, moneyline and spread projections with edge detection." /></Card>
      ) : (
        <>
          {/* projection headline */}
          <Card glow>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
              <div style={{ fontWeight: 900, fontSize: 17 }}>{p1.name} <span style={{ color: C.faint }}>vs</span> {p2.name}</div>
              <Badge tone={proj.confidence === "High" ? "pos" : proj.confidence === "Med" ? "amber" : "neg"}>{proj.confidence} confidence</Badge>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 18 }}>
              <Stat label="Projected total" value={proj.projected} tone={C.accent} sub={`σ ±${proj.sigma.toFixed(1)}`} />
              <Stat label={`${p1.name} pts`} value={proj.p1_proj} />
              <Stat label={`${p2.name} pts`} value={proj.p2_proj} />
              <Stat label="Proj. margin" value={(margin > 0 ? "+" : "") + margin.toFixed(1)} tone={margin > 0 ? C.pos : C.neg} sub={`${p1.name} perspective`} />
              <Stat label={`P(${p1.name} win)`} value={wp.adjusted.toFixed(0) + "%"} tone={C.blue} sub={`base ${wp.baseWp.toFixed(0)}% · h2h ${h2hPenalty.toFixed(2)}`} />
            </div>

            {/* breakdown — rating contributions when rated, multiplicative factors when baseline */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "'JetBrains Mono'", fontSize: 11.5 }}>
              {proj.rated ? (() => {
                const lm = ratings.leagueMean(); const r1o = ratings.ratingOf(p1.name), r2o = ratings.ratingOf(p2.name);
                const tt1 = ratings.teamRatingOf(effT1), tt2 = ratings.teamRatingOf(effT2);
                const sg = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
                return (<>
                  <FactorPill k="league μ" v={lm == null ? "—" : lm.toFixed(1)} />
                  <FactorPill k={`${p1.name} off`} v={sg(r1o.off)} tone={r1o.off >= 0 ? C.pos : C.neg} />
                  <FactorPill k={`${p2.name} off`} v={sg(r2o.off)} tone={r2o.off >= 0 ? C.pos : C.neg} />
                  <FactorPill k={`${p1.name} def`} v={sg(r1o.def)} tone={r1o.def <= 0 ? C.pos : C.neg} />
                  <FactorPill k={`${p2.name} def`} v={sg(r2o.def)} tone={r2o.def <= 0 ? C.pos : C.neg} />
                  {effT1 && <FactorPill k={`${effT1} o/d`} v={`${sg(tt1.off)}/${sg(tt1.def)}`} />}
                  {effT2 && <FactorPill k={`${effT2} o/d`} v={`${sg(tt2.off)}/${sg(tt2.def)}`} />}
                </>);
              })() : (<>
                <FactorPill k="base" v={proj.base} />
                <FactorPill k="form ×" v={proj.form_adj.toFixed(3)} tone={proj.form_adj >= 1 ? C.pos : C.neg} />
                <FactorPill k="matchup ×" v={proj.matchup_adj.toFixed(3)} />
                <FactorPill k="fatigue ×" v={proj.fatigue_adj.toFixed(2)} tone={proj.fatigue_adj < 1 ? C.amber : C.muted} />
                <FactorPill k="variance ×" v={settings.variance} />
                <FactorPill k={`eff ${p1.name}`} v={efficiency(p1).toFixed(1)} />
                <FactorPill k={`eff ${p2.name}`} v={efficiency(p2).toFixed(1)} />
              </>)}
            </div>

            {/* distribution chart */}
            <div style={{ height: 180, marginTop: 18 }}>
              <ResponsiveContainer>
                <AreaChart data={dist} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.accent} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="x" stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
                  <YAxis hide />
                  <Tooltip contentStyle={tipStyle} formatter={() => null} labelFormatter={(l) => `total ${l}`} />
                  <Area type="monotone" dataKey="d" stroke={C.accent} strokeWidth={2} fill="url(#g)" />
                  <ReferenceLine x={proj.projected} stroke={C.accent} strokeDasharray="4 3" label={{ value: "proj", fill: C.accent, fontSize: 10 }} />
                  {totalLine !== "" && <ReferenceLine x={Number(totalLine)} stroke={C.amber} strokeWidth={2}
                    label={{ value: `line ${totalLine}`, fill: C.amber, fontSize: 10, position: "top" }} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* markets grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(290px,1fr))", gap: 18 }}>
            {/* TOTALS */}
            <Card>
              <MarketHead icon={<Target size={15} />} title="Total (Over / Under)" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <Field label="Book line" value={totalLine} onChange={setTotalLine} placeholder="130.5" />
                <Field label="Over odds" value={overOdds} onChange={setOverOdds} />
                <Field label="Under odds" value={underOdds} onChange={setUnderOdds} />
              </div>
              {pOver != null ? (
                <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                  <EdgeRow side="Over" prob={pOver} odds={overOdds} edge={overEdge} settings={settings} onLog={() => logTotal("Over")} />
                  <EdgeRow side="Under" prob={pUnder} odds={underOdds} edge={underEdge} settings={settings} onLog={() => logTotal("Under")} />
                </div>
              ) : <Hint text="Enter a book line to compute Over/Under edge." />}
            </Card>

            {/* LINE SHOPPING — best price across books + market-consensus edge */}
            <Card>
              <MarketHead icon={<Search size={15} />} title="Line shopping · totals" />
              <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>
                Same line ({totalLine || "set a book line above"}) across books. The durable edge in fast micro-markets is taking the best available number — and tracking whether it beats the close (CLV, in the Bet Logger).
              </div>
              {(() => {
                const bp = bestPrice(books);
                const modelP = pOver;  // model P(over) at the entered line
                const evAt = (p, o) => o == null ? null : p * payoutMult(o) - (1 - p);
                const bestOverEV = modelP != null && bp.bestOver ? evAt(modelP, bp.bestOver.o) : null;
                const bestUnderEV = modelP != null && bp.bestUnder ? evAt(1 - modelP, bp.bestUnder.o) : null;
                return (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr auto", gap: 8, alignItems: "center" }}>
                      <div style={{ fontSize: 10.5, color: C.muted }}>Book</div>
                      <div style={{ fontSize: 10.5, color: C.muted }}>Over</div>
                      <div style={{ fontSize: 10.5, color: C.muted }}>Under</div><div />
                      {books.map((b, i) => (
                        <React.Fragment key={i}>
                          <input value={b.book} onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, book: e.target.value } : x))} style={selStyle} />
                          <input value={b.over} placeholder="-110" onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, over: e.target.value } : x))}
                            style={{ ...selStyle, ...(bp.bestOver && num(b.over) === bp.bestOver.o && b.over !== "" ? { borderColor: C.accent, color: C.accent } : {}) }} />
                          <input value={b.under} placeholder="-110" onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, under: e.target.value } : x))}
                            style={{ ...selStyle, ...(bp.bestUnder && num(b.under) === bp.bestUnder.o && b.under !== "" ? { borderColor: C.accent, color: C.accent } : {}) }} />
                          <button onClick={() => setBooks((p) => p.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 16 }}>×</button>
                        </React.Fragment>
                      ))}
                    </div>
                    <button onClick={() => setBooks((p) => [...p, { book: `Book ${String.fromCharCode(65 + p.length)}`, over: "", under: "" }])}
                      style={{ marginTop: 8, background: "none", border: `1px dashed ${C.border}`, color: C.muted, borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 11 }}>+ book</button>

                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 14 }}>
                      <Stat label="Best Over" value={bp.bestOver ? americanStr(bp.bestOver.o) : "—"} sub={bp.bestOver ? bp.bestOver.book : "enter odds"} tone={C.accent} />
                      <Stat label="Best Under" value={bp.bestUnder ? americanStr(bp.bestUnder.o) : "—"} sub={bp.bestUnder ? bp.bestUnder.book : "enter odds"} tone={C.accent} />
                      <Stat label="Market no-vig P(Over)" value={bp.consensusOver != null ? `${(bp.consensusOver * 100).toFixed(1)}%` : "—"} sub="two-sided consensus" />
                      <Stat label="Model P(Over)" value={modelP != null ? `${(modelP * 100).toFixed(1)}%` : "—"} sub="needs a line above" />
                    </div>
                    {modelP != null && (bp.bestOver || bp.bestUnder) && (
                      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                        {bp.bestOver && <BestPriceRow side="Over" odds={bp.bestOver.o} book={bp.bestOver.book} ev={bestOverEV} settings={settings} onLog={() => logTotal("Over", bp.bestOver.o)} />}
                        {bp.bestUnder && <BestPriceRow side="Under" odds={bp.bestUnder.o} book={bp.bestUnder.book} ev={bestUnderEV} settings={settings} onLog={() => logTotal("Under", bp.bestUnder.o)} />}
                        {bp.consensusOver != null && modelP != null && (
                          <div style={{ fontSize: 11, color: C.muted, fontFamily: "'JetBrains Mono'" }}>
                            model vs market: <b style={{ color: modelP > bp.consensusOver ? C.pos : C.neg }}>{((modelP - bp.consensusOver) * 100 >= 0 ? "+" : "") + ((modelP - bp.consensusOver) * 100).toFixed(1)}%</b> on Over — your disagreement with the no-vig consensus is the model's claimed edge; the best-price row is what you can actually take.
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </Card>

            {/* MONEYLINE */}
            <Card>
              <MarketHead icon={<Percent size={15} />} title="Moneyline" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label={`${p1.name} odds`} value={mlOdds1} onChange={setMlOdds1} placeholder="-120" />
                <Field label={`${p2.name} odds`} value={mlOdds2} onChange={setMlOdds2} placeholder="+105" />
              </div>
              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                <EdgeRow side={p1.name} prob={wp.adjusted / 100} odds={mlOdds1} disabled={mlOdds1 === ""}
                  edge={mlOdds1 === "" ? null : wp.adjusted / 100 - (impliedProb(mlOdds1) ?? 0)} settings={settings} compact
                  onLog={() => { onLog(mlBet(p1, p2, p1.name, wp.adjusted / 100, mlOdds1)); flash(); }} />
                <EdgeRow side={p2.name} prob={1 - wp.adjusted / 100} odds={mlOdds2} disabled={mlOdds2 === ""}
                  edge={mlOdds2 === "" ? null : (1 - wp.adjusted / 100) - (impliedProb(mlOdds2) ?? 0)} settings={settings} compact
                  onLog={() => { onLog(mlBet(p1, p2, p2.name, 1 - wp.adjusted / 100, mlOdds2)); flash(); }} />
              </div>
            </Card>

            {/* SPREAD */}
            <Card>
              <MarketHead icon={<Gauge size={15} />} title={`Spread · ${p1.name}`} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Spread (P1)" value={spreadLine} onChange={setSpreadLine} placeholder="-3.5" />
                <Field label="Odds" value={spreadOdds} onChange={setSpreadOdds} />
              </div>
              {pCover != null ? (
                <div style={{ marginTop: 14 }}>
                  <EdgeRow side={`${p1.name} ${Number(spreadLine) > 0 ? "+" : ""}${spreadLine}`} prob={pCover} odds={spreadOdds} edge={spreadEdge} settings={settings}
                    onLog={() => { onLog({ id: crypto.randomUUID(), timestamp: new Date().toISOString(),
                      matchup: `${p1.name} vs ${p2.name}`, bet_type: "Spread", line: `${p1.name} ${spreadLine}`,
                      proj_value: margin, model_prob: +(pCover * 100).toFixed(1), odds: num(spreadOdds), stake: "",
                      outcome: "Pending", profit: 0, notes: `edge ${(spreadEdge * 100).toFixed(1)}%` }); flash(); }} />
                  <div style={{ marginTop: 8, fontSize: 11, color: C.faint, fontFamily: "'JetBrains Mono'" }}>
                    proj margin {margin.toFixed(1)} · σ {sigmaMargin.toFixed(1)}
                  </div>
                </div>
              ) : <Hint text="Enter a spread (negative = P1 favored)." />}
            </Card>
          </div>

          {logged && (
            <div style={{ position: "fixed", bottom: 26, left: "50%", transform: "translateX(-50%)", zIndex: 50 }}>
              <Badge tone="pos">✓ Logged to ledger</Badge>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const FactorPill = ({ k, v, tone }) => (
  <span style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "5px 9px", color: C.muted }}>
    {k} <b style={{ color: tone || C.text }}>{v}</b>
  </span>
);
const MarketHead = ({ icon, title }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, color: C.text, fontWeight: 800, fontSize: 14.5 }}>
    <span style={{ color: C.accent }}>{icon}</span>{title}
  </div>
);
const Hint = ({ text }) => <div style={{ marginTop: 12, fontSize: 12, color: C.faint }}>{text}</div>;

function EdgeRow({ side, prob, odds, edge, settings, onLog, compact, disabled }) {
  if (disabled) return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px",
      background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, opacity: 0.6 }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{side}</span>
      <span style={{ fontSize: 11.5, color: C.faint }}>enter odds</span>
    </div>
  );
  const ev = evPerUnit(prob, odds);
  const kq = Math.max(0, 0.25 * fullKelly(prob, odds)); // conservative quarter-Kelly
  const good = edge != null && edge >= settings.edgeThresh;
  const bad = edge != null && edge < 0;
  const tone = good ? C.pos : bad ? C.neg : C.amber;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 11px",
      background: good ? "#0c2a1d" : C.surface2, border: `1px solid ${good ? C.accentDim : bad ? C.neg + "44" : C.border}`, borderRadius: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 13.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{side}</div>
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.muted, marginTop: 2 }}>
          model {(prob * 100).toFixed(1)}% · impl {((impliedProb(odds) ?? 0) * 100).toFixed(1)}%
        </div>
      </div>
      <div style={{ textAlign: "right", fontFamily: "'JetBrains Mono'", flexShrink: 0 }}>
        <div style={{ color: tone, fontWeight: 700, fontSize: 14 }}>{edge == null ? "—" : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`}</div>
        {!compact && <div style={{ fontSize: 10.5, color: C.faint }}>EV {ev >= 0 ? "+" : ""}{ev.toFixed(2)}u · ¼K {(kq * 100).toFixed(1)}%</div>}
      </div>
      <Btn kind={good ? "primary" : "ghost"} onClick={onLog} style={{ padding: "6px 10px", fontSize: 12 }}>Log</Btn>
    </div>
  );
}

function BestPriceRow({ side, odds, book, ev, settings, onLog }) {
  const good = ev != null && ev > 0;
  const tone = good ? C.pos : ev != null && ev < 0 ? C.neg : C.amber;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "9px 11px",
      background: good ? "#0c2a1d" : C.surface2, border: `1px solid ${good ? C.accentDim : C.border}`, borderRadius: 10 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 13.5 }}>{side} <span style={{ color: C.accent, fontFamily: "'JetBrains Mono'" }}>{americanStr(odds)}</span></div>
        <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.muted, marginTop: 2 }}>best price · {book || "—"}</div>
      </div>
      <div style={{ textAlign: "right", fontFamily: "'JetBrains Mono'", flexShrink: 0 }}>
        <div style={{ color: tone, fontWeight: 700, fontSize: 14 }}>{ev == null ? "—" : `${ev >= 0 ? "+" : ""}${ev.toFixed(2)}u EV`}</div>
        <div style={{ fontSize: 10.5, color: C.faint }}>at best available number</div>
      </div>
      <Btn kind={good ? "primary" : "ghost"} onClick={onLog} style={{ padding: "6px 10px", fontSize: 12 }}>Log</Btn>
    </div>
  );
}

function mlBet(p1, p2, who, prob, odds) {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), matchup: `${p1.name} vs ${p2.name}`,
    bet_type: "ML", line: who, proj_value: +(prob * 100).toFixed(1), model_prob: +(prob * 100).toFixed(1),
    odds: num(odds), close_side: "", close_other: "", stake: "", outcome: "Pending", profit: 0, notes: `edge ${((prob - (impliedProb(odds) ?? 0)) * 100).toFixed(1)}%` };
}

/* ============================================================================
   BET LOGGER  — ledger w/ settlement
   ========================================================================== */
function BetLogger({ bets, setBets, players }) {
  const settle = (id, outcome) => setBets((prev) => prev.map((b) => {
    if (b.id !== id) return b;
    const stake = num(b.stake);
    let profit = 0;
    if (outcome === "Win") profit = stake * payoutMult(b.odds);
    else if (outcome === "Loss") profit = -stake;
    else profit = 0; // push
    return { ...b, outcome, profit: +profit.toFixed(2) };
  }));
  const setStake = (id, stake) => setBets((prev) => prev.map((b) => b.id === id ? { ...b, stake } : b));
  const setClose = (id, field, val) => setBets((prev) => prev.map((b) => b.id === id ? { ...b, [field]: val } : b));

  const open = bets.filter((b) => b.outcome === "Pending");
  const closed = bets.filter((b) => b.outcome !== "Pending");

  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      <Card>
        <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>Bet ledger</div>
        <div style={{ fontSize: 12, color: C.muted }}>Bets logged from the analyzer land here. Set your stake, settle Win / Loss / Push, and enter the <b style={{ color: C.accent }}>closing line</b> to track CLV — beating the close is the durable proxy for long-run +EV.</div>
      </Card>

      {bets.length === 0 ? (
        <Card><Empty icon={<ClipboardList size={26} color={C.muted} />} title="No bets yet"
          body="Run a matchup in the Analyzer and hit “Log” on any market to start tracking." /></Card>
      ) : (
        <>
          {open.length > 0 && <BetTable title={`Open · ${open.length}`} rows={open} settle={settle} setStake={setStake} setClose={setClose} remove={(id) => setBets((p) => p.filter((b) => b.id !== id))} />}
          {closed.length > 0 && <BetTable title={`Settled · ${closed.length}`} rows={closed} settle={settle} setStake={setStake} setClose={setClose} remove={(id) => setBets((p) => p.filter((b) => b.id !== id))} settled />}
        </>
      )}
    </div>
  );
}

function BetTable({ title, rows, settle, setStake, setClose, remove, settled }) {
  const miniInp = { width: 52, background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: "4px 5px", textAlign: "right", fontFamily: "'JetBrains Mono'", fontSize: 11 };
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "14px 18px", fontWeight: 800, fontSize: 14, borderBottom: `1px solid ${C.border}` }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono'" }}>
          <thead>
            <tr style={{ color: C.muted }}>
              {["When","Matchup","Type","Selection","Odds","Model%","Stake","Profit","Close (you / other)","CLV","",""].map((h, i) =>
                <th key={i} style={{ padding: "10px 12px", textAlign: [4,5,6,7,9].includes(i) ? "right" : "left", borderBottom: `1px solid ${C.border}`, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const clv = clvEv(b.odds, b.close_side, b.close_other);
              return (
              <tr key={b.id} style={{ borderBottom: `1px solid ${C.border}55` }}>
                <td style={{ padding: "8px 12px", color: C.faint }}>{new Date(b.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}</td>
                <td style={{ padding: "8px 12px", color: C.text, fontFamily: "'Archivo'" }}>{b.matchup}</td>
                <td style={{ padding: "8px 12px" }}><Badge tone={b.bet_type === "Total" ? "blue" : b.bet_type === "ML" ? "amber" : "muted"}>{b.bet_type}</Badge></td>
                <td style={{ padding: "8px 12px", color: C.text }}>{b.line}</td>
                <td style={tdR}>{b.odds > 0 ? "+" : ""}{b.odds}</td>
                <td style={tdR}>{b.model_prob ?? "—"}</td>
                <td style={{ ...tdR, width: 90 }}>
                  {settled ? num(b.stake).toFixed(2) :
                    <input value={b.stake} onChange={(e) => setStake(b.id, e.target.value)} placeholder="0"
                      style={{ width: 64, background: C.bg, border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: "4px 6px", textAlign: "right", fontFamily: "'JetBrains Mono'", fontSize: 12 }} />}
                </td>
                <td style={{ ...tdR, color: b.profit > 0 ? C.pos : b.profit < 0 ? C.neg : C.muted, fontWeight: 700 }}>
                  {b.outcome === "Pending" ? "—" : `${b.profit >= 0 ? "+" : ""}${b.profit.toFixed(2)}`}
                </td>
                <td style={{ padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <input value={b.close_side ?? ""} onChange={(e) => setClose(b.id, "close_side", e.target.value)} placeholder="-110" style={miniInp} />
                  <span style={{ color: C.faint, margin: "0 3px" }}>/</span>
                  <input value={b.close_other ?? ""} onChange={(e) => setClose(b.id, "close_other", e.target.value)} placeholder="opp" style={miniInp} />
                </td>
                <td style={{ ...tdR, fontWeight: 700, color: clv == null ? C.faint : clv > 0 ? C.pos : C.neg }}>
                  {clv == null ? "—" : `${clv >= 0 ? "+" : ""}${(clv * 100).toFixed(1)}%`}
                </td>
                <td style={{ padding: "8px 6px", textAlign: "right" }}>
                  {settled ? <Badge tone={b.outcome === "Win" ? "pos" : b.outcome === "Loss" ? "neg" : "muted"}>{b.outcome}</Badge> :
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button onClick={() => settle(b.id, "Win")} title="Win" style={{ ...iconBtn, color: C.pos }}><Check size={14} /></button>
                      <button onClick={() => settle(b.id, "Loss")} title="Loss" style={{ ...iconBtn, color: C.neg }}><X size={14} /></button>
                      <button onClick={() => settle(b.id, "Push")} title="Push" style={{ ...iconBtn, color: C.muted }}>=</button>
                    </div>}
                </td>
                <td style={{ padding: "8px 10px 8px 0", textAlign: "right" }}>
                  <button onClick={() => remove(b.id)} style={{ ...iconBtn, color: C.neg }}><Trash2 size={13} /></button>
                </td>
              </tr>
            );})}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ============================================================================
   HISTORICAL INSIGHTS  — ROI + backtest (MAE / hit-rate) + accuracy scatter
   ========================================================================== */
/* build a pre-match player object from a walk-forward snapshot (steals/fouls/fg absent in feed -> 0) */
function wfPair(row) {
  const mk = (wp, ppm, form, gp) => ({ win_pct: num(wp), pts_per_match: num(ppm), recent_form: form || "", gp: num(gp), steals: 0, fouls: 0, fg_pct: 0 });
  return [mk(row.p1_win_pct, row.p1_ppm, row.p1_form, row.p1_gp), mk(row.p2_win_pct, row.p2_ppm, row.p2_form, row.p2_gp)];
}
const CAL_GRID = [-6, -4, -2, 0, 2, 4, 6]; // O/U line offsets from the realized-median total (sharp-book proxy)

function Insights({ bets, matches, players, settings, lateNight, wf }) {
  const [minGp, setMinGp] = useState(10);
  const [assumedOdds, setAssumedOdds] = useState("-110");

  // ---- real betting performance (from ledger) ----
  const settled = bets.filter((b) => b.outcome !== "Pending" && b.outcome !== "Push");
  const staked = bets.filter((b) => num(b.stake) > 0 && b.outcome !== "Pending");
  const totalStake = staked.reduce((a, b) => a + num(b.stake), 0);
  const totalProfit = staked.reduce((a, b) => a + num(b.profit), 0);
  const roi = totalStake ? (totalProfit / totalStake) * 100 : 0;
  const wins = settled.filter((b) => b.outcome === "Win").length;
  const hitRate = settled.length ? (wins / settled.length) * 100 : 0;
  const curve = useMemo(() => {
    const s = [...staked].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    let cum = 0; return s.map((b, i) => { cum += num(b.profit); return { i: i + 1, cum: +cum.toFixed(2) }; });
  }, [staked]);

  // ---- CLV dashboard (closing-line value across the ledger) ----
  const clvStats = useMemo(() => {
    const withClv = bets
      .map((b) => ({ b, clv: clvEv(b.odds, b.close_side, b.close_other) }))
      .filter((x) => x.clv != null)
      .sort((a, b) => new Date(a.b.timestamp) - new Date(b.b.timestamp));
    const n = withClv.length;
    if (!n) return { n: 0 };
    const vals = withClv.map((x) => x.clv * 100);
    const mean = vals.reduce((a, v) => a + v, 0) / n;
    const beats = vals.filter((v) => v > 0).length;
    // cumulative CLV curve + a small distribution histogram
    let cum = 0;
    const curveC = withClv.map((x, i) => { cum += x.clv * 100; return { i: i + 1, cum: +cum.toFixed(2), clv: +(x.clv * 100).toFixed(2) }; });
    const edges = [-Infinity, -4, -2, -1, 0, 1, 2, 4, Infinity];
    const labels = ["<-4", "-4..-2", "-2..-1", "-1..0", "0..1", "1..2", "2..4", ">4"];
    const hist = labels.map((label, k) => ({ label, n: vals.filter((v) => v > edges[k] && v <= edges[k + 1]).length }));
    return { n, mean, beatRate: (beats / n) * 100, curveC, hist };
  }, [bets]);

  // ---- WALK-FORWARD backtest (headline, out-of-sample) ----
  // One chronological pass builds BOTH models leakage-free: the baseline ppm projector
  // and the online opponent+team rating model. Each game is projected from state that
  // used only earlier games, then the rating model is updated with the result.
  const wfb = useMemo(() => {
    const rated = makeRatings(settings);
    const rows = [];
    const bP = [], rP = [], aAll = [];                            // for correlation (all qualifying rows)
    let lgPts = 0, lgPg = 0;
    wf.forEach((r) => {
      const lgMean = lgPg > 0 ? lgPts / lgPg : null;
      const actual = num(r.actual_total);
      const t1 = r.p1_team || "", t2 = r.p2_team || "";
      const pred = rated.predict(r.player1, t1, r.player2, t2);   // PRE-update -> leakage-free
      if (Math.min(num(r.p1_gp), num(r.p2_gp)) >= minGp) {
        const [p1, p2] = wfPair(r);
        const base = projectTotal(p1, p2, settings, false, { leagueMean: lgMean });
        const baseProj = base ? base.projected : null;
        const rateProj = r1(pred.total);
        const rateSig = Math.sqrt(Math.max(rateProj, 1) * settings.dispersion);
        if (baseProj != null && rateProj > 0) {
          const useRate = settings.modelMode === "rated";
          rows.push({
            actual, baseProj, rateProj,
            proj: useRate ? rateProj : baseProj,
            sigma: useRate ? rateSig : base.sigma,
            err: (useRate ? rateProj : baseProj) - actual,
          });
          bP.push(baseProj); rP.push(rateProj); aAll.push(actual);
        }
      }
      rated.update(r.player1, t1, r.player2, t2, num(r.score1), num(r.score2)); // update AFTER
      lgPts += num(r.score1) + num(r.score2); lgPg += 2;
    });
    const n = rows.length;
    const stat = (sel) => {
      if (!n) return { mae: null, rmse: null, bias: null };
      let mae = 0, sse = 0, bias = 0;
      rows.forEach((r) => { const e = r[sel] - r.actual; mae += Math.abs(e); sse += e * e; bias += e; });
      return { mae: mae / n, rmse: Math.sqrt(sse / n), bias: bias / n };
    };
    return {
      rows, n,
      ...stat("proj"),                                            // active-model headline metrics
      r: pearson(rows.map((r) => r.proj), aAll),
      cmp: { baseR: pearson(bP, aAll), rateR: pearson(rP, aAll),
        baseMae: n ? bP.reduce((a, x, i) => a + Math.abs(x - aAll[i]), 0) / n : null,
        rateMae: n ? rP.reduce((a, x, i) => a + Math.abs(x - aAll[i]), 0) / n : null },
    };
  }, [wf, settings, minGp]);

  // ---- CALIBRATION (out-of-sample O/U probabilities across a line grid) ----
  const cal = useMemo(() => {
    const samples = []; // {p, y}
    // Anchor O/U lines to the realized MEDIAN total (a stand-in for where a sharp book sits),
    // NOT the model's own projection — a projection-centered grid self-hedges and hides mean bias.
    const acts = wfb.rows.map((r) => r.actual).slice().sort((a, b) => a - b);
    const center = acts.length ? Math.round(acts[Math.floor(acts.length / 2)]) + 0.5 : 0;
    const lines = CAL_GRID.map((o) => center + o);
    wfb.rows.forEach((r) => {
      lines.forEach((line) => {
        const p = probOver(r.proj, r.sigma, line);
        if (p == null) return;
        samples.push({ p, y: r.actual > line ? 1 : 0 });
      });
    });
    const N = samples.length;
    const brier = N ? samples.reduce((a, s) => a + (s.p - s.y) ** 2, 0) / N : null;
    // 10 equal-width reliability bins
    const bins = Array.from({ length: 10 }, () => ({ sp: 0, sy: 0, n: 0 }));
    samples.forEach((s) => { const k = Math.min(9, Math.floor(s.p * 10)); bins[k].sp += s.p; bins[k].sy += s.y; bins[k].n++; });
    const binData = bins.filter((b) => b.n > 0).map((b) => ({ pred: b.sp / b.n, obs: b.sy / b.n, n: b.n }));
    const ece = N ? bins.reduce((a, b) => a + (b.n ? (b.n / N) * Math.abs(b.sp / b.n - b.sy / b.n) : 0), 0) : null;

    // realized ROI of +EV flags, assuming `assumedOdds` market both ways
    const impl = impliedProb(assumedOdds) ?? 0.5;
    const pm = payoutMult(assumedOdds);
    let stake = 0, profit = 0, flags = 0;
    samples.forEach((s) => {
      if (s.p - impl > settings.edgeThresh) { stake++; profit += s.y ? pm : -1; flags++; }            // back Over
      if ((1 - s.p) - impl > settings.edgeThresh) { stake++; profit += s.y ? -1 : pm; flags++; }      // back Under
    });
    const flagRoi = stake ? (profit / stake) * 100 : null;
    return { N, brier, ece, binData, flagRoi, flags, flagProfit: profit, flagStake: stake };
  }, [wfb, settings.edgeThresh, assumedOdds]);

  // ---- in-sample probe (LEAKY — kept only for multiplier tuning) ----
  const insample = useMemo(() => {
    const lg = leagueMeanPpm(players);
    const rows = [];
    matches.forEach((m) => {
      const p1 = players.find((p) => p.name === m.player1);
      const p2 = players.find((p) => p.name === m.player2);
      if (!p1 || !p2) return;
      const pr = projectTotal(p1, p2, settings, lateNight, { leagueMean: lg });
      if (!pr) return;
      rows.push({ proj: pr.projected, actual: m.total, err: pr.projected - m.total });
    });
    const n = rows.length;
    return { rows, n, mae: n ? rows.reduce((a, r) => a + Math.abs(r.err), 0) / n : null,
      bias: n ? rows.reduce((a, r) => a + r.err, 0) / n : null };
  }, [matches, players, settings, lateNight]);

  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      {/* real money */}
      <Card>
        <MarketHead icon={<DollarSign size={15} />} title="Realized betting performance (your ledger)" />
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <Stat label="ROI" value={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`} tone={roi >= 0 ? C.pos : C.neg} sub={`${staked.length} settled, staked`} />
          <Stat label="Net profit" value={`${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)}u`} tone={totalProfit >= 0 ? C.pos : C.neg} />
          <Stat label="Hit rate" value={`${hitRate.toFixed(0)}%`} sub={`${wins}/${settled.length} ex-push`} />
          <Stat label="Total staked" value={`${totalStake.toFixed(1)}u`} />
        </div>
      </Card>

      {/* CLV DASHBOARD — closing-line value, the north-star metric */}
      <Card glow>
        <MarketHead icon={<TrendingUp size={15} />} title="Closing line value (CLV) · north-star" />
        <div style={{ fontSize: 11.5, color: C.faint, margin: "2px 0 14px" }}>
          For each bet, enter the closing line in the Bet Logger (your side, and the other side for a true no-vig devig). Beating the close consistently is the most reliable evidence of a real edge — independent of short-run win/loss variance.
        </div>
        {clvStats.n ? (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
              <Stat label="Mean CLV" value={`${clvStats.mean >= 0 ? "+" : ""}${clvStats.mean.toFixed(2)}%`} tone={clvStats.mean > 0 ? C.pos : C.neg} sub="EV at closing fair prob" />
              <Stat label="Beat-close rate" value={`${clvStats.beatRate.toFixed(0)}%`} tone={clvStats.beatRate > 50 ? C.pos : C.amber} sub="bets that beat the close" />
              <Stat label="Bets w/ close" value={clvStats.n} sub={`of ${bets.length} logged`} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 }}>
              <div style={{ height: 190 }}>
                <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 4 }}>Cumulative CLV (units of %)</div>
                <ResponsiveContainer>
                  <AreaChart data={clvStats.curveC} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
                    <defs><linearGradient id="clvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.accent} stopOpacity={0.4} /><stop offset="100%" stopColor={C.accent} stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                    <XAxis dataKey="i" stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
                    <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
                    <Tooltip contentStyle={tipStyle} />
                    <ReferenceLine y={0} stroke={C.faint} strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="cum" stroke={C.accent} strokeWidth={2} fill="url(#clvg)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ height: 190 }}>
                <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 4 }}>CLV distribution (%)</div>
                <ResponsiveContainer>
                  <BarChart data={clvStats.hist} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                    <XAxis dataKey="label" stroke={C.faint} tick={{ fontSize: 8.5, fontFamily: "'JetBrains Mono'" }} interval={0} angle={-30} textAnchor="end" height={42} />
                    <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} allowDecimals={false} />
                    <Tooltip contentStyle={tipStyle} cursor={{ fill: C.surface2 }} />
                    <Bar dataKey="n">{clvStats.hist.map((h, i) => <Cell key={i} fill={h.label.startsWith("-") || h.label === "<-4" ? C.neg : C.accent} fillOpacity={0.8} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 10, fontFamily: "'JetBrains Mono'" }}>
              positive mean CLV with a beat-close rate above 50% is the signal that the line-shopping + model edge is real, even before the bets settle.
            </div>
          </>
        ) : <Empty icon={<TrendingUp size={24} color={C.muted} />} title="No closing lines entered yet"
          body="In the Bet Logger, fill the Close (you / other) cells on any bet to start tracking CLV. This is the metric that separates real edge from variance." />}
      </Card>

      {/* WALK-FORWARD headline */}
      <Card glow>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <MarketHead icon={<Activity size={15} />} title="Walk-forward backtest · out-of-sample" />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: C.muted, fontFamily: "'JetBrains Mono'" }}>min GP {minGp}</span>
            <input type="range" min={0} max={40} value={minGp} onChange={(e) => setMinGp(num(e.target.value))} style={{ accentColor: C.accent }} />
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: C.faint, margin: "2px 0 14px" }}>
          Active model: <b style={{ color: C.accent }}>{settings.modelMode === "rated" ? "opponent + team ratings" : "baseline ppm"}</b>.
          Each game projected from state built only from earlier games (no leakage). Switch models in Data Manager → Model parameters.
        </div>
        {wfb.n ? (
          <>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
              <Stat label="Correlation r" value={wfb.r == null ? "—" : wfb.r.toFixed(3)} tone={wfb.r > 0.3 ? C.pos : wfb.r > 0 ? C.amber : C.neg} sub="proj vs actual" />
              <Stat label="MAE" value={wfb.mae.toFixed(1)} tone={C.amber} sub="mean abs error" />
              <Stat label="RMSE" value={wfb.rmse.toFixed(1)} />
              <Stat label="Bias" value={`${wfb.bias >= 0 ? "+" : ""}${wfb.bias.toFixed(1)}`} tone={Math.abs(wfb.bias) < 2 ? C.pos : C.neg} sub="proj − actual" />
              <Stat label="Games" value={wfb.n} sub={`of ${wf.length} loaded`} />
            </div>
            {wfb.cmp.baseR != null && wfb.cmp.rateR != null && (
              <div style={{ fontSize: 11, color: C.muted, fontFamily: "'JetBrains Mono'", marginBottom: 12, padding: "8px 10px", background: C.surface2, borderRadius: 8, border: `1px solid ${C.border}` }}>
                model comparison ·&nbsp;
                <span style={{ color: settings.modelMode === "baseline" ? C.accent : C.faint }}>baseline r={wfb.cmp.baseR.toFixed(3)} mae={wfb.cmp.baseMae.toFixed(1)}</span>
                &nbsp;→&nbsp;
                <span style={{ color: settings.modelMode === "rated" ? C.accent : C.faint }}>rated r={wfb.cmp.rateR.toFixed(3)} mae={wfb.cmp.rateMae.toFixed(1)}</span>
                {wfb.cmp.rateR > wfb.cmp.baseR && <span style={{ color: C.pos }}>&nbsp;· ratings lift +{((wfb.cmp.rateR - wfb.cmp.baseR)).toFixed(3)} r</span>}
              </div>
            )}
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis type="number" dataKey="actual" name="actual" stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} domain={["dataMin - 5", "dataMax + 5"]} />
                  <YAxis type="number" dataKey="proj" name="proj" stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} domain={["dataMin - 5", "dataMax + 5"]} />
                  <ZAxis range={[28, 28]} />
                  <Tooltip contentStyle={tipStyle} cursor={{ strokeDasharray: "3 3" }} />
                  <Scatter data={wfb.rows} fill={C.accent} fillOpacity={0.55} />
                  {(() => { const xs = wfb.rows.flatMap((r) => [r.actual, r.proj]); const lo = Math.min(...xs), hi = Math.max(...xs);
                    return <ReferenceLine segment={[{ x: lo, y: lo }, { x: hi, y: hi }]} stroke={C.amber} strokeDasharray="5 4" />; })()}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : <Empty icon={<Activity size={24} color={C.muted} />} title="No walk-forward data"
          body={`Import ggba_walkforward.csv in Data Manager. ${wf.length ? `(${wf.length} rows loaded, but none have ≥${minGp} prior games for both players — lower the min-GP slider.)` : ""}`} />}
      </Card>

      {/* CALIBRATION */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <MarketHead icon={<Gauge size={15} />} title="Probability calibration · O/U" />
          <div style={{ width: 120 }}><Field label="Assumed odds" value={assumedOdds} onChange={setAssumedOdds} /></div>
        </div>
        <div style={{ fontSize: 11.5, color: C.faint, margin: "2px 0 14px", lineHeight: 1.5 }}>
          Does “55% Over” land ~55%? Points on the diagonal = calibrated; ECE is the calibration gap. Lines are anchored near the realized
          median total (a sharp-book stand-in) so the read reflects mean bias, not just spread. Flag ROI assumes both sides priced at {assumedOdds} —
          a sanity check, not a profitability promise; swap in real closing odds when you have them.
        </div>
        {cal.N ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 18, alignItems: "center" }}>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 8, right: 14, left: -8, bottom: 4 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis type="number" dataKey="pred" name="predicted" domain={[0, 1]} stroke={C.faint}
                    tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} tickFormatter={(v) => `${(v * 100) | 0}%`} label={{ value: "predicted P(over)", fill: C.muted, fontSize: 10, dy: 14 }} />
                  <YAxis type="number" dataKey="obs" name="observed" domain={[0, 1]} stroke={C.faint}
                    tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} tickFormatter={(v) => `${(v * 100) | 0}%`} />
                  <ZAxis dataKey="n" range={[30, 260]} />
                  <Tooltip contentStyle={tipStyle} formatter={(v, n) => [`${(v * 100).toFixed(0)}%`, n]} cursor={{ strokeDasharray: "3 3" }} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={C.amber} strokeDasharray="5 4" />
                  <Scatter data={cal.binData} fill={C.blue} fillOpacity={0.75} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <Stat label="Brier score" value={cal.brier.toFixed(3)} tone={cal.brier < 0.25 ? C.pos : C.amber} sub="lower = sharper+calibrated" />
              <Stat label="ECE" value={cal.ece.toFixed(3)} tone={cal.ece < 0.05 ? C.pos : cal.ece < 0.1 ? C.amber : C.neg} sub="avg calibration gap" />
              <Stat label="+EV flag ROI" value={cal.flagRoi == null ? "—" : `${cal.flagRoi >= 0 ? "+" : ""}${cal.flagRoi.toFixed(1)}%`}
                tone={cal.flagRoi == null ? C.muted : cal.flagRoi >= 0 ? C.pos : C.neg} sub={`${cal.flags} flagged @ ${assumedOdds}`} />
              <Stat label="Samples" value={cal.N} sub="line-grid evaluations" />
            </div>
          </div>
        ) : <Empty icon={<Gauge size={24} color={C.muted} />} title="No calibration yet" body="Load walk-forward data and lower the min-GP slider until games qualify." />}
      </Card>

      {/* bankroll + in-sample probe */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 18 }}>
        <Card>
          <MarketHead icon={<TrendingUp size={15} />} title="Bankroll curve" />
          {curve.length ? (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={curve} margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="i" stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
                  <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
                  <Tooltip contentStyle={tipStyle} />
                  <ReferenceLine y={0} stroke={C.faint} />
                  <Line type="monotone" dataKey="cum" stroke={C.accent} strokeWidth={2.5} dot={{ r: 2.5, fill: C.accent }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty icon={<TrendingUp size={24} color={C.muted} />} title="No settled stakes" body="Settle staked bets in the ledger to chart your bankroll." />}
        </Card>

        <Card>
          <MarketHead icon={<AlertTriangle size={15} />} title="In-sample probe · leaky" />
          <div style={{ fontSize: 11.5, color: C.faint, marginBottom: 12, lineHeight: 1.5 }}>
            Uses each player's <i>current</i> full-sample stats — optimistic by construction. Don't trust the absolute numbers;
            use it only to tune the multipliers (variance / fatigue / matchup) and watch how bias moves.
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Stat label="MAE" value={insample.mae == null ? "—" : insample.mae.toFixed(1)} sub="leaky — ref only" />
            <Stat label="Bias" value={insample.bias == null ? "—" : `${insample.bias >= 0 ? "+" : ""}${insample.bias.toFixed(1)}`} sub="proj − actual" />
            <Stat label="Games" value={insample.n} />
          </div>
        </Card>
      </div>

      {staked.length > 0 && <ByTypeCard bets={staked} />}
    </div>
  );
}

function ByTypeCard({ bets }) {
  const types = ["Total", "ML", "Spread"];
  const data = types.map((t) => {
    const rows = bets.filter((b) => b.bet_type === t);
    const stake = rows.reduce((a, b) => a + num(b.stake), 0);
    const profit = rows.reduce((a, b) => a + num(b.profit), 0);
    return { type: t, roi: stake ? +(profit / stake * 100).toFixed(1) : 0, n: rows.length };
  }).filter((d) => d.n > 0);
  return (
    <Card>
      <MarketHead icon={<LineIcon size={15} />} title="ROI by market" />
      <div style={{ height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="type" stroke={C.faint} tick={{ fontSize: 11, fontFamily: "'JetBrains Mono'" }} />
            <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: "'JetBrains Mono'" }} />
            <Tooltip contentStyle={tipStyle} formatter={(v, n, p) => [`${v}% (${p.payload.n} bets)`, "ROI"]} />
            <ReferenceLine y={0} stroke={C.faint} />
            <Bar dataKey="roi" radius={[6, 6, 0, 0]}>
              {data.map((d, i) => <Cell key={i} fill={d.roi >= 0 ? C.pos : C.neg} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/* ============================================================================
   AI ASSISTANT  — contextual matchup analysis via Anthropic API
   ========================================================================== */
function AIAssistant({ players, settings, lateNight, bets, matches, wf }) {
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" }); }, [msgs, busy]);

  const p1 = players.find((p) => p.name === n1);
  const p2 = players.find((p) => p.name === n2);

  function buildContext() {
    const lines = [];
    lines.push("You are GGBetAnalyzer's analyst for eBasketball H2H GG League (4x5 min format). Be concise, quantitative, and honest about uncertainty. Never guarantee outcomes; flag low-sample data. Frame everything as +EV reasoning, not advice to bet.");
    lines.push(`Model params: ${JSON.stringify(settings)}. Late-night fatigue active: ${lateNight}. Active projection model: ${settings.modelMode}.`);
    const fmt = (p) => p ? `${p.name}: win%=${p.win_pct}, ppm=${p.pts_per_match}, fg%=${p.fg_pct}, stl=${p.steals}, pf=${p.fouls}, gp=${p.gp}, form=${p.recent_form || "n/a"}, eff=${efficiency(p).toFixed(1)}` : null;
    if (p1) lines.push("P1 " + fmt(p1));
    if (p2) lines.push("P2 " + fmt(p2));
    if (p1 && p2) {
      const g = (wf || []).map((r) => ({ p1: r.player1, t1: r.p1_team || "", p2: r.player2, t2: r.p2_team || "", s1: r.score1, s2: r.score2 }));
      const ratings = buildRatingsModel(g, settings);
      const pr = computeProjection(p1, p2, settings, lateNight, { leagueMean: leagueMeanPpm(players), ratings, team1: "", team2: "" });
      const wp = winProb(p1, p2, 0, settings);
      lines.push(`Model output (${pr.rated ? "opponent+team ratings" : "baseline ppm"}): projected_total=${pr.projected} (sigma ${pr.sigma.toFixed(1)}), ${p1.name}_pts=${pr.p1_proj}, ${p2.name}_pts=${pr.p2_proj}, P(${p1.name} win)=${wp.adjusted.toFixed(0)}%, confidence=${pr.confidence}.`);
    }
    if (!players.length) lines.push("NOTE: roster is empty; the user must import real data first.");
    return lines.join("\n");
  }

  async function ask(prefill) {
    const question = (prefill ?? q).trim();
    if (!question || busy) return;
    const next = [...msgs, { role: "user", content: question }];
    setMsgs(next); setQ(""); setBusy(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 1000,
          system: buildContext(),
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      setMsgs((m) => [...m, { role: "assistant", content: text || "No response." }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: "⚠ Could not reach the model. Check connectivity and try again." }]);
    } finally { setBusy(false); }
  }

  const suggestions = p1 && p2 ? [
    `Analyze ${p1.name} vs ${p2.name} for tonight's total — where's the edge?`,
    `Is ${p1.name} a live moneyline dog at +110?`,
    `What would make me fade the Over here?`,
  ] : ["Pick two players above, then ask about the matchup."];

  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div><Label>Player 1</Label><PlayerSelect players={players} value={n1} onChange={setN1} /></div>
          <div><Label>Player 2</Label><PlayerSelect players={players} value={n2} onChange={setN2} /></div>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: C.muted }}>
          The assistant sees your live model output for the selected matchup and reasons over it. It won't invent stats.
        </div>
      </Card>

      <Card style={{ display: "flex", flexDirection: "column", height: 460, padding: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {msgs.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: C.muted }}>
              <Bot size={30} color={C.faint} />
              <div style={{ marginTop: 10, fontSize: 13 }}>Ask anything about the selected matchup.</div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div style={{ fontSize: 10, color: C.faint, marginBottom: 3, textAlign: m.role === "user" ? "right" : "left", textTransform: "uppercase", letterSpacing: 1 }}>
                {m.role === "user" ? "You" : "Analyst"}
              </div>
              <div style={{ background: m.role === "user" ? C.accent : C.surface2, color: m.role === "user" ? "#04130c" : C.text,
                border: `1px solid ${m.role === "user" ? C.accent : C.border}`, borderRadius: 12, padding: "10px 13px",
                fontSize: 13.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
            </div>
          ))}
          {busy && <div style={{ alignSelf: "flex-start", color: C.muted, fontSize: 13 }}><span className="live">▍ analyzing…</span></div>}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, padding: 14 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => p1 && p2 && ask(s)} disabled={!p1 || !p2}
                style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 999,
                  padding: "5px 11px", fontSize: 11.5, cursor: p1 && p2 ? "pointer" : "default", fontFamily: "'Archivo'" }}>{s}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()}
              placeholder="Ask about totals, ML value, what to fade…"
              style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "11px 13px",
                color: C.text, fontSize: 13.5, fontFamily: "'Archivo'", outline: "none" }} />
            <Btn kind="primary" onClick={() => ask()} disabled={busy || !q.trim()}><Send size={15} /></Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------- shared bits ------------------------------- */
function PlayerSelect({ players, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9, padding: "9px 11px",
        color: value ? C.text : C.faint, fontSize: 13.5, fontFamily: "'Archivo'", cursor: "pointer",
        backgroundImage: `linear-gradient(45deg, transparent 50%, ${C.muted} 50%), linear-gradient(135deg, ${C.muted} 50%, transparent 50%)`,
        backgroundPosition: "right 14px center, right 9px center", backgroundSize: "5px 5px, 5px 5px", backgroundRepeat: "no-repeat" }}>
      <option value="">— select —</option>
      {players.map((p) => <option key={p.name} value={p.name} style={{ background: C.surface }}>{p.name}</option>)}
    </select>
  );
}

function blankPlayer() {
  return { name: "", win_pct: "", pts_per_match: "", fg_pct: "", steals: "", fouls: "", gp: "", w: "", l: "", recent_form: "", nba_team: "" };
}

const tdR = { padding: "9px 12px", textAlign: "right", color: C.text };
const iconBtn = { background: "transparent", border: "none", color: C.muted, cursor: "pointer", padding: 4, display: "inline-flex" };
const tipStyle = { background: C.surface, border: `1px solid ${C.borderHi}`, borderRadius: 8, fontSize: 12, fontFamily: "'JetBrains Mono'", color: C.text };

/* ============================================================================
   UPCOMING GAMES FEED
   ========================================================================== */
function UpcomingGamesFeed({ upcoming, loading, error, onRefresh }: {
  upcoming: UpcomingGame[]; loading: boolean; error: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="rise" style={{ display: "grid", gap: 18 }}>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>
            Upcoming Matchups
            {upcoming.length > 0 && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: C.muted }}>
                {upcoming.length} game{upcoming.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <Btn onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
            {loading ? "Loading…" : "Refresh"}
          </Btn>
        </div>

        {error && (
          <div style={{ color: C.neg, fontSize: 13, marginBottom: 12, padding: "8px 12px",
            background: "#2e121033", borderRadius: 8, border: `1px solid ${C.neg}44` }}>
            {error} — is the scraper running?
          </div>
        )}

        {!loading && upcoming.length === 0 && !error ? (
          <Empty
            icon={<Calendar size={28} color={C.muted} />}
            title="No upcoming games found"
            body="Check back soon, or increase the days window. Make sure the scraper is running."
          />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {upcoming.map((game) => (
              <UpcomingGameCard key={game.external_id} game={game} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function UpcomingGameCard({ game }: { game: UpcomingGame }) {
  const [expanded, setExpanded] = React.useState<"h2h" | "analysis" | null>(null);
  const toggle = (section: "h2h" | "analysis") =>
    setExpanded((prev) => (prev === section ? null : section));

  const mm = String(game.minute_utc ?? 0).padStart(2, "0");
  const timeStr = `${game.date}  ${String(game.hour_utc).padStart(2, "0")}:${mm} UTC`;
  const edge = game.analysis?.win_edge;
  const bands = game.analysis?.score_bands;
  const ppm = game.analysis?.ppm_model;
  const h2h = game.h2h;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      {/* Header row */}
      <div style={{ padding: "12px 16px", background: C.surface2, display: "grid",
        gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 3, fontFamily: "'JetBrains Mono'" }}>
            {timeStr}  ·  {game.division}
          </div>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>
            {game.player1}
            <span style={{ color: C.faint, fontWeight: 400, margin: "0 8px" }}>vs</span>
            {game.player2}
          </div>
          {edge && (
            <div style={{ marginTop: 5 }}>
              <Badge tone="pos">{edge.favored} edge +{edge.edge_pct}%</Badge>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn kind="ghost" onClick={() => toggle("h2h")} style={{ fontSize: 12, padding: "4px 10px" }}>
            H2H {expanded === "h2h" ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Btn>
          <Btn kind="ghost" onClick={() => toggle("analysis")} style={{ fontSize: 12, padding: "4px 10px" }}>
            Analysis {expanded === "analysis" ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Btn>
        </div>
      </div>

      {/* Player stats bar */}
      {(game.p1_stats || game.p2_stats) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: C.border }}>
          {[
            { label: game.player1, stats: game.p1_stats },
            { label: game.player2, stats: game.p2_stats },
          ].map(({ label, stats }) => (
            <div key={label} style={{ padding: "10px 14px", background: C.surface }}>
              <Label>{label}</Label>
              {stats ? (
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>Win%</div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: C.text }}>
                      {stats.win_pct != null ? `${(+stats.win_pct).toFixed(1)}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>PPM</div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: C.accent }}>
                      {stats.pts_per_match != null ? (+stats.pts_per_match).toFixed(1) : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>Form</div>
                    <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 12, letterSpacing: 2 }}>
                      {(stats.recent_form || "—").split("").map((c, i) => (
                        <span key={i} style={{ color: c === "W" ? C.pos : C.neg }}>{c}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : <div style={{ fontSize: 12, color: C.faint }}>No stats</div>}
            </div>
          ))}
        </div>
      )}

      {/* H2H section */}
      {expanded === "h2h" && (
        <div style={{ padding: "12px 16px", background: C.surface, borderTop: `1px solid ${C.border}` }}>
          <Label>Head-to-Head Record</Label>
          {h2h ? (
            <>
              <div style={{ display: "flex", gap: 20, marginBottom: 10, flexWrap: "wrap" }}>
                <Stat label="Total Games" value={h2h.total_games} />
                <Stat label={`${game.player1} Wins`} value={h2h.p1_wins} tone={C.pos} />
                <Stat label={`${game.player2} Wins`} value={h2h.p2_wins} tone={C.neg} />
                {h2h.avg_total != null && <Stat label="Avg Total" value={h2h.avg_total.toFixed(1)} />}
              </div>
              {h2h.recent.length > 0 && (
                <div style={{ fontSize: 12, color: C.muted }}>
                  <div style={{ display: "grid",
                    gridTemplateColumns: "100px 80px 80px 60px", gap: "4px 12px",
                    fontFamily: "'JetBrains Mono'", marginBottom: 4 }}>
                    <span style={{ color: C.faint }}>Date</span>
                    <span style={{ color: C.faint }}>{game.player1}</span>
                    <span style={{ color: C.faint }}>{game.player2}</span>
                    <span style={{ color: C.faint }}>Winner</span>
                  </div>
                  {h2h.recent.slice(0, 8).map((g: Record<string, unknown>, i: number) => (
                    <div key={i} style={{ display: "grid",
                      gridTemplateColumns: "100px 80px 80px 60px", gap: "4px 12px" }}>
                      <span>{String(g.date ?? "")}</span>
                      <span style={{ color: C.text }}>{String(g.p1_score ?? "")}</span>
                      <span style={{ color: C.text }}>{String(g.p2_score ?? "")}</span>
                      <span style={{ color: g.winner === game.player1 ? C.pos : C.neg }}>
                        {String(g.winner ?? "")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : <div style={{ color: C.faint, fontSize: 13 }}>No H2H history found.</div>}
        </div>
      )}

      {/* Analysis section */}
      {expanded === "analysis" && (
        <div style={{ padding: "12px 16px", background: C.surface, borderTop: `1px solid ${C.border}` }}>
          {bands ? (
            <>
              <Label>Score Prediction Bands (±0.5σ)</Label>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 12, marginBottom: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 60px 60px 140px 50px",
                  gap: "4px 8px", color: C.faint, marginBottom: 4 }}>
                  <span></span><span>Mean</span><span>Std</span><span>Band</span><span>Conf</span>
                </div>
                {[
                  { label: "Total (both)", band: bands.total },
                  { label: `Home (${game.player1.slice(0, 10)})`, band: bands.p1 },
                  { label: `Away (${game.player2.slice(0, 10)})`, band: bands.p2 },
                ].map(({ label, band }) => (
                  <div key={label} style={{ display: "grid",
                    gridTemplateColumns: "120px 60px 60px 140px 50px", gap: "4px 8px" }}>
                    <span style={{ color: C.muted }}>{label}</span>
                    {band ? (
                      <>
                        <span style={{ color: C.text }}>{band.mean}</span>
                        <span style={{ color: C.text }}>{band.std}</span>
                        <span style={{ color: C.accent }}>[{band.low} – {band.high}]</span>
                        <span style={{ color: band.confidence >= 60 ? C.pos : C.amber }}>
                          {band.confidence.toFixed(0)}%
                        </span>
                      </>
                    ) : <span style={{ color: C.faint, gridColumn: "span 4" }}>insufficient data</span>}
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {ppm && (
            <>
              <Label>PPM Model (season averages)</Label>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 70px 70px 80px",
                  gap: "4px 8px", color: C.faint, marginBottom: 4 }}>
                  <span></span><span>PPM</span><span>H2H Avg</span><span>Diff</span>
                </div>
                {[
                  { label: "Total (both)", ppmVal: ppm.total, h2hAvg: h2h?.avg_total ?? null },
                  { label: `${game.player1.slice(0, 10)}`, ppmVal: ppm.p1, h2hAvg: null },
                  { label: `${game.player2.slice(0, 10)}`, ppmVal: ppm.p2, h2hAvg: null },
                ].map(({ label, ppmVal, h2hAvg }) => (
                  <div key={label} style={{ display: "grid",
                    gridTemplateColumns: "120px 70px 70px 80px", gap: "4px 8px" }}>
                    <span style={{ color: C.muted }}>{label}</span>
                    <span style={{ color: C.text }}>{ppmVal.toFixed(1)}</span>
                    <span style={{ color: C.faint }}>{h2hAvg != null ? h2hAvg.toFixed(1) : "—"}</span>
                    <span style={{ color: ppm.vs_h2h_diff != null
                      ? (ppm.vs_h2h_diff >= 0 ? C.pos : C.neg) : C.faint }}>
                      {h2hAvg != null && ppm.vs_h2h_diff != null
                        ? (ppm.vs_h2h_diff >= 0 ? "+" : "") + ppm.vs_h2h_diff.toFixed(1)
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!bands && !ppm && (
            <div style={{ color: C.faint, fontSize: 13 }}>No analysis data available.</div>
          )}
        </div>
      )}
    </div>
  );
}
