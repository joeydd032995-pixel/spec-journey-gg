'use client';
/* Historical insights — one KPI strip up top (ledger ROI, CLV, backtest
   headline), then a two-column grid of charts. All estimators are the shared
   lib/model.ts functions, so the numbers here match the Analyzer exactly. */
import React, { useMemo, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, ScatterChart, Scatter, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, ZAxis, Cell,
} from "recharts";
import { Activity, AlertTriangle, DollarSign, Gauge, LineChart as LineIcon, TrendingUp } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import {
  clvEv, impliedProb, leagueMeanPpm, makeRatings, num, payoutMult, pearson,
  probOver, projectTotal, r1,
  type Bet, type MatchResult, type Player, type Settings, type WalkForwardRow,
} from "@/lib/model";
import { Card, CardHeader, Empty, Field, Stat, StatStrip, tipStyle } from "@/components/ui";

/* build a pre-match player object from a walk-forward snapshot (steals/fouls/fg absent in feed -> 0) */
function wfPair(row: WalkForwardRow): [Player, Player] {
  const mk = (wp: unknown, ppm: unknown, form: string, gp: unknown): Player => ({
    name: "", win_pct: num(wp), pts_per_match: num(ppm), recent_form: form || "", gp: num(gp),
    steals: 0, fouls: 0, fg_pct: 0,
  });
  return [mk(row.p1_win_pct, row.p1_ppm, row.p1_form, row.p1_gp), mk(row.p2_win_pct, row.p2_ppm, row.p2_form, row.p2_gp)];
}

const CAL_GRID = [-6, -4, -2, 0, 2, 4, 6]; // O/U line offsets from the realized-median total (sharp-book proxy)

interface WfbRow { actual: number; baseProj: number; rateProj: number; proj: number; sigma: number; err: number }

export default function Insights({ bets, matches, players, settings, lateNight, wf }: {
  bets: Bet[]; matches: MatchResult[]; players: Player[]; settings: Settings; lateNight: boolean; wf: WalkForwardRow[];
}) {
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
    const s = [...staked].sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp));
    let cum = 0; return s.map((b, i) => { cum += num(b.profit); return { i: i + 1, cum: +cum.toFixed(2) }; });
  }, [staked]);

  // ---- CLV dashboard ----
  const clvStats = useMemo(() => {
    const withClv = bets
      .map((b) => ({ b, clv: clvEv(b.odds, b.close_side, b.close_other) }))
      .filter((x): x is { b: Bet; clv: number } => x.clv != null)
      .sort((a, b) => +new Date(a.b.timestamp) - +new Date(b.b.timestamp));
    const n = withClv.length;
    if (!n) return { n: 0 as const };
    const vals = withClv.map((x) => x.clv * 100);
    const mean = vals.reduce((a, v) => a + v, 0) / n;
    const beats = vals.filter((v) => v > 0).length;
    let cum = 0;
    const curveC = withClv.map((x, i) => { cum += x.clv * 100; return { i: i + 1, cum: +cum.toFixed(2), clv: +(x.clv * 100).toFixed(2) }; });
    const edges = [-Infinity, -4, -2, -1, 0, 1, 2, 4, Infinity];
    const labels = ["<-4", "-4..-2", "-2..-1", "-1..0", "0..1", "1..2", "2..4", ">4"];
    const hist = labels.map((label, k) => ({ label, n: vals.filter((v) => v > edges[k] && v <= edges[k + 1]).length }));
    return { n, mean, beatRate: (beats / n) * 100, curveC, hist };
  }, [bets]);

  // ---- WALK-FORWARD backtest (headline, out-of-sample) ----
  // One chronological pass builds BOTH models leakage-free: predict pre-update.
  const wfb = useMemo(() => {
    const rated = makeRatings(settings);
    const rows: WfbRow[] = [];
    const bP: number[] = [], rP: number[] = [], aAll: number[] = [];
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
            sigma: useRate ? rateSig : base!.sigma,
            err: (useRate ? rateProj : baseProj) - actual,
          });
          bP.push(baseProj); rP.push(rateProj); aAll.push(actual);
        }
      }
      rated.update(r.player1, t1, r.player2, t2, num(r.score1), num(r.score2)); // update AFTER
      lgPts += num(r.score1) + num(r.score2); lgPg += 2;
    });
    const n = rows.length;
    let mae = 0, sse = 0, bias = 0;
    rows.forEach((row) => { const e = row.err; mae += Math.abs(e); sse += e * e; bias += e; });
    return {
      rows, n,
      mae: n ? mae / n : null, rmse: n ? Math.sqrt(sse / n) : null, bias: n ? bias / n : null,
      r: pearson(rows.map((row) => row.proj), aAll),
      cmp: {
        baseR: pearson(bP, aAll), rateR: pearson(rP, aAll),
        baseMae: n ? bP.reduce((a, x, i) => a + Math.abs(x - aAll[i]), 0) / n : null,
        rateMae: n ? rP.reduce((a, x, i) => a + Math.abs(x - aAll[i]), 0) / n : null,
      },
    };
  }, [wf, settings, minGp]);

  // ---- CALIBRATION (out-of-sample O/U probabilities across a line grid) ----
  const cal = useMemo(() => {
    const samples: Array<{ p: number; y: 0 | 1 }> = [];
    // Anchor lines to the realized MEDIAN total (a sharp-book stand-in), not the
    // model's own projection — a projection-centered grid self-hedges and hides bias.
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
    const bins = Array.from({ length: 10 }, () => ({ sp: 0, sy: 0, n: 0 }));
    samples.forEach((s) => { const k = Math.min(9, Math.floor(s.p * 10)); bins[k].sp += s.p; bins[k].sy += s.y; bins[k].n++; });
    const binData = bins.filter((b) => b.n > 0).map((b) => ({ pred: b.sp / b.n, obs: b.sy / b.n, n: b.n }));
    const ece = N ? bins.reduce((a, b) => a + (b.n ? (b.n / N) * Math.abs(b.sp / b.n - b.sy / b.n) : 0), 0) : null;

    const impl = impliedProb(assumedOdds) ?? 0.5;
    const pm = payoutMult(assumedOdds);
    let stake = 0, profit = 0, flags = 0;
    samples.forEach((s) => {
      if (s.p - impl > settings.edgeThresh) { stake++; profit += s.y ? pm : -1; flags++; }            // back Over
      if ((1 - s.p) - impl > settings.edgeThresh) { stake++; profit += s.y ? -1 : pm; flags++; }      // back Under
    });
    const flagRoi = stake ? (profit / stake) * 100 : null;
    return { N, brier, ece, binData, flagRoi, flags };
  }, [wfb, settings.edgeThresh, assumedOdds]);

  // ---- in-sample probe (LEAKY — kept only for multiplier tuning) ----
  const insample = useMemo(() => {
    const lg = leagueMeanPpm(players);
    const rows: Array<{ proj: number; actual: number; err: number }> = [];
    matches.forEach((m) => {
      const p1 = players.find((p) => p.name === m.player1);
      const p2 = players.find((p) => p.name === m.player2);
      if (!p1 || !p2) return;
      const pr = projectTotal(p1, p2, settings, lateNight, { leagueMean: lg });
      if (!pr) return;
      rows.push({ proj: pr.projected, actual: m.total, err: pr.projected - m.total });
    });
    const n = rows.length;
    return {
      rows, n,
      mae: n ? rows.reduce((a, r) => a + Math.abs(r.err), 0) / n : null,
      bias: n ? rows.reduce((a, r) => a + r.err, 0) / n : null,
    };
  }, [matches, players, settings, lateNight]);

  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      {/* headline KPI strip */}
      <Card>
        <CardHeader icon={<DollarSign size={15} />} title="Performance at a glance"
          sub="Realized ledger results, closing-line value, and the out-of-sample backtest headline — one row." />
        <StatStrip>
          <Stat label="ROI" value={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`} tone={roi >= 0 ? C.pos : C.neg} sub={`${staked.length} settled, staked`} />
          <Stat label="Net profit" value={`${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)}u`} tone={totalProfit >= 0 ? C.pos : C.neg} />
          <Stat label="Hit rate" value={`${hitRate.toFixed(0)}%`} sub={`${wins}/${settled.length} ex-push`} />
          <Stat label="Mean CLV" value={clvStats.n ? `${clvStats.mean! >= 0 ? "+" : ""}${clvStats.mean!.toFixed(2)}%` : "—"}
            tone={clvStats.n && clvStats.mean! > 0 ? C.pos : clvStats.n ? C.neg : C.muted} sub={clvStats.n ? `${clvStats.n} bets w/ close` : "enter closes"} />
          <Stat label="Backtest r" value={wfb.r == null ? "—" : wfb.r.toFixed(3)} tone={wfb.r != null && wfb.r > 0.3 ? C.pos : wfb.r != null && wfb.r > 0 ? C.amber : C.neg} sub="proj vs actual" />
          <Stat label="Backtest MAE" value={wfb.mae == null ? "—" : wfb.mae.toFixed(1)} sub={`${wfb.n} games`} />
        </StatStrip>
      </Card>

      {/* CLV dashboard */}
      <Card glow>
        <CardHeader icon={<TrendingUp size={15} />} title="Closing line value · north-star"
          sub="Enter the closing line on each bet in the ledger (your side + the other side for a true no-vig devig). Beating the close consistently is the most reliable evidence of a real edge — independent of short-run variance." />
        {clvStats.n ? (
          <>
            <div style={{ display: "flex", gap: SP.lg, flexWrap: "wrap", marginBottom: SP.md }}>
              <Stat label="Mean CLV" value={`${clvStats.mean! >= 0 ? "+" : ""}${clvStats.mean!.toFixed(2)}%`} tone={clvStats.mean! > 0 ? C.pos : C.neg} sub="EV at closing fair prob" />
              <Stat label="Beat-close rate" value={`${clvStats.beatRate!.toFixed(0)}%`} tone={clvStats.beatRate! > 50 ? C.pos : C.amber} sub="bets that beat the close" />
              <Stat label="Bets w/ close" value={clvStats.n} sub={`of ${bets.length} logged`} />
            </div>
            <div className="ggba-cols" style={{ "--cols": "1.4fr 1fr", gap: SP.md } as React.CSSProperties}>
              <div style={{ height: 190 }}>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: SP.xs }}>Cumulative CLV (units of %)</div>
                <ResponsiveContainer>
                  <AreaChart data={clvStats.curveC} margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
                    <defs><linearGradient id="clvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.accent} stopOpacity={0.4} /><stop offset="100%" stopColor={C.accent} stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                    <XAxis dataKey="i" stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
                    <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
                    <Tooltip contentStyle={tipStyle} />
                    <ReferenceLine y={0} stroke={C.faint} strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="cum" stroke={C.accent} strokeWidth={2} fill="url(#clvg)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ height: 190 }}>
                <div style={{ fontSize: 10, color: C.muted, marginBottom: SP.xs }}>CLV distribution (%)</div>
                <ResponsiveContainer>
                  <BarChart data={clvStats.hist} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                    <XAxis dataKey="label" stroke={C.faint} tick={{ fontSize: 8.5, fontFamily: FONT.mono }} interval={0} angle={-30} textAnchor="end" height={42} />
                    <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} allowDecimals={false} />
                    <Tooltip contentStyle={tipStyle} cursor={{ fill: C.surface2 }} />
                    <Bar dataKey="n">{clvStats.hist!.map((h, i) => <Cell key={i} fill={h.label.startsWith("-") || h.label === "<-4" ? C.neg : C.accent} fillOpacity={0.8} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        ) : <Empty icon={<TrendingUp size={24} color={C.muted} />} title="No closing lines entered yet"
          body="In the Bet Ledger, fill the Close (you / other) cells on any bet to start tracking CLV. This is the metric that separates real edge from variance." />}
      </Card>

      {/* walk-forward backtest */}
      <Card glow>
        <CardHeader icon={<Activity size={15} />} title="Walk-forward backtest · out-of-sample"
          sub={<>Active model: <b style={{ color: C.accent }}>{settings.modelMode === "rated" ? "opponent + team ratings" : "baseline ppm"}</b>. Each game projected from state built only from earlier games (no leakage). Switch models in Data → Model parameters.</>}
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: SP.sm }}>
              <span style={{ fontSize: 11, color: C.muted, fontFamily: FONT.mono }}>min GP {minGp}</span>
              <input aria-label="Minimum games played filter" type="range" min={0} max={40} value={minGp}
                onChange={(e) => setMinGp(num(e.target.value))} style={{ accentColor: C.accent }} />
            </div>
          } />
        {wfb.n ? (
          <>
            <StatStrip>
              <Stat label="Correlation r" value={wfb.r == null ? "—" : wfb.r.toFixed(3)} tone={wfb.r != null && wfb.r > 0.3 ? C.pos : wfb.r != null && wfb.r > 0 ? C.amber : C.neg} sub="proj vs actual" />
              <Stat label="MAE" value={wfb.mae!.toFixed(1)} tone={C.amber} sub="mean abs error" />
              <Stat label="RMSE" value={wfb.rmse!.toFixed(1)} />
              <Stat label="Bias" value={`${wfb.bias! >= 0 ? "+" : ""}${wfb.bias!.toFixed(1)}`} tone={Math.abs(wfb.bias!) < 2 ? C.pos : C.neg} sub="proj − actual" />
              <Stat label="Games" value={wfb.n} sub={`of ${wf.length} loaded`} />
            </StatStrip>
            {wfb.cmp.baseR != null && wfb.cmp.rateR != null && (
              <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT.mono, margin: `${SP.md}px 0`, padding: "8px 10px",
                background: C.surface2, borderRadius: RADIUS.md, border: `1px solid ${C.border}` }}>
                model comparison ·&nbsp;
                <span style={{ color: settings.modelMode === "baseline" ? C.accent : C.faint }}>baseline r={wfb.cmp.baseR.toFixed(3)} mae={wfb.cmp.baseMae!.toFixed(1)}</span>
                &nbsp;→&nbsp;
                <span style={{ color: settings.modelMode === "rated" ? C.accent : C.faint }}>rated r={wfb.cmp.rateR.toFixed(3)} mae={wfb.cmp.rateMae!.toFixed(1)}</span>
                {wfb.cmp.rateR > wfb.cmp.baseR && <span style={{ color: C.pos }}>&nbsp;· ratings lift +{(wfb.cmp.rateR - wfb.cmp.baseR).toFixed(3)} r</span>}
              </div>
            )}
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis type="number" dataKey="actual" name="actual" stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} domain={["dataMin - 5", "dataMax + 5"]} />
                  <YAxis type="number" dataKey="proj" name="proj" stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} domain={["dataMin - 5", "dataMax + 5"]} />
                  <ZAxis range={[28, 28]} />
                  <Tooltip contentStyle={tipStyle} cursor={{ strokeDasharray: "3 3" }} />
                  <Scatter data={wfb.rows} fill={C.accent} fillOpacity={0.55} />
                  {(() => {
                    const xs = wfb.rows.flatMap((r) => [r.actual, r.proj]); const lo = Math.min(...xs), hi = Math.max(...xs);
                    return <ReferenceLine segment={[{ x: lo, y: lo }, { x: hi, y: hi }]} stroke={C.amber} strokeDasharray="5 4" />;
                  })()}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : <Empty icon={<Activity size={24} color={C.muted} />} title="No walk-forward data"
          body={`Import ggba_walkforward.csv in the Data view. ${wf.length ? `(${wf.length} rows loaded, but none have ≥${minGp} prior games for both players — lower the min-GP slider.)` : ""}`} />}
      </Card>

      {/* calibration */}
      <Card>
        <CardHeader icon={<Gauge size={15} />} title="Probability calibration · O/U"
          sub={`Does "55% Over" land ~55%? Points on the diagonal = calibrated; ECE is the calibration gap. Lines are anchored near the realized median total (a sharp-book stand-in). Flag ROI assumes both sides priced at ${assumedOdds} — a sanity check, not a profitability promise.`}
          actions={<div style={{ width: 120 }}><Field label="Assumed odds" value={assumedOdds} onChange={setAssumedOdds} /></div>} />
        {cal.N ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: SP.lg, alignItems: "center" }}>
            <div style={{ height: 240 }}>
              <ResponsiveContainer>
                <ScatterChart margin={{ top: 8, right: 14, left: -8, bottom: 4 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" />
                  <XAxis type="number" dataKey="pred" name="predicted" domain={[0, 1]} stroke={C.faint}
                    tick={{ fontSize: 10, fontFamily: FONT.mono }} tickFormatter={(v: number) => `${(v * 100) | 0}%`}
                    label={{ value: "predicted P(over)", fill: C.muted, fontSize: 10, dy: 14 }} />
                  <YAxis type="number" dataKey="obs" name="observed" domain={[0, 1]} stroke={C.faint}
                    tick={{ fontSize: 10, fontFamily: FONT.mono }} tickFormatter={(v: number) => `${(v * 100) | 0}%`} />
                  <ZAxis dataKey="n" range={[30, 260]} />
                  <Tooltip contentStyle={tipStyle} formatter={(v: number, n: string) => [`${(v * 100).toFixed(0)}%`, n]} cursor={{ strokeDasharray: "3 3" }} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={C.amber} strokeDasharray="5 4" />
                  <Scatter data={cal.binData} fill={C.blue} fillOpacity={0.75} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <StatStrip>
              <Stat label="Brier score" value={cal.brier!.toFixed(3)} tone={cal.brier! < 0.25 ? C.pos : C.amber} sub="lower = sharper" />
              <Stat label="ECE" value={cal.ece!.toFixed(3)} tone={cal.ece! < 0.05 ? C.pos : cal.ece! < 0.1 ? C.amber : C.neg} sub="avg calibration gap" />
              <Stat label="+EV flag ROI" value={cal.flagRoi == null ? "—" : `${cal.flagRoi >= 0 ? "+" : ""}${cal.flagRoi.toFixed(1)}%`}
                tone={cal.flagRoi == null ? C.muted : cal.flagRoi >= 0 ? C.pos : C.neg} sub={`${cal.flags} flagged @ ${assumedOdds}`} />
              <Stat label="Samples" value={cal.N} sub="line-grid evals" />
            </StatStrip>
          </div>
        ) : <Empty icon={<Gauge size={24} color={C.muted} />} title="No calibration yet" body="Load walk-forward data and lower the min-GP slider until games qualify." />}
      </Card>

      {/* bankroll + in-sample probe + ROI by market */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: SP.lg }}>
        <Card>
          <CardHeader icon={<TrendingUp size={15} />} title="Bankroll curve" />
          {curve.length ? (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={curve} margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="i" stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
                  <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
                  <Tooltip contentStyle={tipStyle} />
                  <ReferenceLine y={0} stroke={C.faint} />
                  <Line type="monotone" dataKey="cum" stroke={C.accent} strokeWidth={2.5} dot={{ r: 2.5, fill: C.accent }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty icon={<TrendingUp size={24} color={C.muted} />} title="No settled stakes" body="Settle staked bets in the ledger to chart your bankroll." />}
        </Card>

        <Card>
          <CardHeader icon={<AlertTriangle size={15} />} title="In-sample probe · leaky"
            sub="Uses each player's current full-sample stats — optimistic by construction. Use it only to tune the multipliers (variance / fatigue / matchup) and watch how bias moves." />
          <StatStrip>
            <Stat label="MAE" value={insample.mae == null ? "—" : insample.mae.toFixed(1)} sub="leaky — ref only" />
            <Stat label="Bias" value={insample.bias == null ? "—" : `${insample.bias >= 0 ? "+" : ""}${insample.bias.toFixed(1)}`} sub="proj − actual" />
            <Stat label="Games" value={insample.n} />
          </StatStrip>
        </Card>

        {staked.length > 0 && <ByTypeCard bets={staked} />}
      </div>
    </div>
  );
}

function ByTypeCard({ bets }: { bets: Bet[] }) {
  const types: Array<Bet["bet_type"]> = ["Total", "ML", "Spread"];
  const data = types.map((t) => {
    const rows = bets.filter((b) => b.bet_type === t);
    const stake = rows.reduce((a, b) => a + num(b.stake), 0);
    const profit = rows.reduce((a, b) => a + num(b.profit), 0);
    return { type: t, roi: stake ? +((profit / stake) * 100).toFixed(1) : 0, n: rows.length };
  }).filter((d) => d.n > 0);
  return (
    <Card>
      <CardHeader icon={<LineIcon size={15} />} title="ROI by market" />
      <div style={{ height: 200 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 14, left: -16, bottom: 0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="type" stroke={C.faint} tick={{ fontSize: 11, fontFamily: FONT.mono }} />
            <YAxis stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
            <Tooltip contentStyle={tipStyle} formatter={(v: number, _n: string, p: { payload?: { n?: number } }) => [`${v}% (${p.payload?.n} bets)`, "ROI"]} />
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
