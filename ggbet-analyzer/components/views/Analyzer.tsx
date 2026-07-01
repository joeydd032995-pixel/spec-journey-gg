'use client';
/* Matchup Analyzer — pick two players, get projections, probabilities and
   edge across Total / Moneyline / Spread, with line shopping.
   Layout: setup strip on top, projection panel left, markets rail right. */
import React, { useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { Crosshair, Gauge, Percent, Search, Target } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import {
  americanStr, bestPrice, buildRatingsModel, computeProjection, efficiency, evPerUnit,
  fullKelly, h2hDominance, impliedProb, leagueMeanPpm, marginRatioFrom, normCdf, num,
  payoutMult, probOver, winProb,
  type Bet, type BookQuote, type MatchResult, type Player, type Settings, type WalkForwardRow,
} from "@/lib/model";
import {
  Badge, Btn, Card, CardHeader, Empty, FactorPill, Field, Hint, Label,
  PlayerSelect, Stat, StatStrip, inputStyle, selStyle, tipStyle,
} from "@/components/ui";

export default function Analyzer({ players, settings, lateNight, matches, wf, onLog }: {
  players: Player[]; settings: Settings; lateNight: boolean;
  matches: MatchResult[]; wf: WalkForwardRow[]; onLog: (b: Bet) => void;
}) {
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [t1Sel, setT1Sel] = useState(""); // "" = auto (modal team)
  const [t2Sel, setT2Sel] = useState("");
  const [totalLine, setTotalLine] = useState("");
  const [overOdds, setOverOdds] = useState("-110");
  const [underOdds, setUnderOdds] = useState("-110");
  const [mlOdds1, setMlOdds1] = useState("");
  const [mlOdds2, setMlOdds2] = useState("");
  const [spreadLine, setSpreadLine] = useState("");
  const [spreadOdds, setSpreadOdds] = useState("-110");
  const [books, setBooks] = useState<BookQuote[]>([
    { book: "Book A", over: "", under: "" }, { book: "Book B", over: "", under: "" }, { book: "Book C", over: "", under: "" },
  ]);
  const [logged, setLogged] = useState(false);

  const p1 = players.find((p) => p.name === n1);
  const p2 = players.find((p) => p.name === n2);

  const wfGames = wf || [];
  const ratings = useMemo(() => buildRatingsModel(
    wfGames.map((r) => ({ p1: r.player1, t1: r.p1_team || "", p2: r.player2, t2: r.p2_team || "", s1: r.score1, s2: r.score2 })),
    settings), [wfGames, settings]);
  const marginRatio = useMemo(() => marginRatioFrom(wfGames), [wfGames]);

  // modal (most-frequent) team per player + dropdown options, from walk-forward history
  const { modalTeam, teamOpts } = useMemo(() => {
    const cnt: Record<string, Record<string, number>> = {}; const set = new Set<string>();
    wfGames.forEach((r) => {
      if (r.p1_team) { set.add(r.p1_team); (cnt[r.player1] ??= {})[r.p1_team] = (cnt[r.player1]?.[r.p1_team] || 0) + 1; }
      if (r.p2_team) { set.add(r.p2_team); (cnt[r.player2] ??= {})[r.p2_team] = (cnt[r.player2]?.[r.p2_team] || 0) + 1; }
    });
    const modal: Record<string, string> = {};
    Object.entries(cnt).forEach(([p, ts]) => { modal[p] = Object.entries(ts).sort((a, b) => b[1] - a[1])[0]?.[0] || ""; });
    return { modalTeam: modal, teamOpts: [...set].sort() };
  }, [wfGames]);

  const effT1 = t1Sel || (p1 ? modalTeam[p1.name] : "") || (p1 ? p1.nba_team : "") || "";
  const effT2 = t2Sel || (p2 ? modalTeam[p2.name] : "") || (p2 ? p2.nba_team : "") || "";
  const ratedLive = settings.modelMode === "rated" && p1 && p2 && ratings.seen(p1.name) && ratings.seen(p2.name);

  const lgMean = useMemo(() => leagueMeanPpm(players), [players]);
  const proj = useMemo(() => computeProjection(p1, p2, settings, lateNight, { leagueMean: lgMean, ratings, team1: effT1, team2: effT2 }),
    [p1, p2, settings, lateNight, lgMean, ratings, effT1, effT2]);

  const h2hPenalty = useMemo(() => (p1 && p2 ? h2hDominance(p1.name, p2.name, matches) : 0), [p1, p2, matches]);
  const wp = useMemo(() => (p1 && p2 ? winProb(p1, p2, h2hPenalty, settings) : null), [p1, p2, h2hPenalty, settings]);

  // totals edge
  const pOver = proj && totalLine !== "" ? probOver(proj.projected, proj.sigma, totalLine) : null;
  const pUnder = pOver == null ? null : 1 - pOver;
  const overEdge = pOver == null ? null : pOver - (impliedProb(overOdds) ?? 0);
  const underEdge = pUnder == null ? null : pUnder - (impliedProb(underOdds) ?? 0);

  // spread: margin ~ Normal(p1_proj - p2_proj, sigma_margin)
  const margin = proj ? proj.p1_proj - proj.p2_proj : null;
  const sigmaMargin = proj ? proj.sigma * marginRatio : null;
  const pCover = proj && margin != null && sigmaMargin != null && spreadLine !== ""
    ? (1 - normCdf((-num(spreadLine) - margin) / sigmaMargin)) : null;
  const spreadEdge = pCover == null ? null : pCover - (impliedProb(spreadOdds) ?? 0);

  // distribution curve for chart
  const dist = useMemo(() => {
    if (!proj) return [];
    const out: Array<{ x: number; d: number }> = [];
    for (let x = proj.projected - 3.2 * proj.sigma; x <= proj.projected + 3.2 * proj.sigma; x += proj.sigma / 8) {
      const d = Math.exp(-0.5 * ((x - proj.projected) / proj.sigma) ** 2) / (proj.sigma * Math.sqrt(2 * Math.PI));
      out.push({ x: Math.round(x * 10) / 10, d: d * 1000 });
    }
    return out;
  }, [proj]);

  function flash() { setLogged(true); setTimeout(() => setLogged(false), 1500); }

  function logTotal(side: "Over" | "Under", oddsOverride?: string | number) {
    if (!p1 || !p2 || !proj) return;
    const p = side === "Over" ? pOver : pUnder;
    if (p == null) return;
    const odds = oddsOverride != null && oddsOverride !== "" ? oddsOverride : (side === "Over" ? overOdds : underOdds);
    onLog({
      id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      matchup: `${p1.name} vs ${p2.name}`, bet_type: "Total", line: `${side} ${totalLine}`,
      proj_value: proj.projected, model_prob: +(p * 100).toFixed(1), odds: num(odds),
      close_side: "", close_other: "",
      stake: "", outcome: "Pending", profit: 0, notes: `edge ${((p - (impliedProb(odds) ?? 0)) * 100).toFixed(1)}%`,
    });
    flash();
  }

  function mlBet(who: string, prob: number, odds: string): Bet {
    return {
      id: crypto.randomUUID(), timestamp: new Date().toISOString(), matchup: `${p1!.name} vs ${p2!.name}`,
      bet_type: "ML", line: who, proj_value: +(prob * 100).toFixed(1), model_prob: +(prob * 100).toFixed(1),
      odds: num(odds), close_side: "", close_other: "", stake: "", outcome: "Pending", profit: 0,
      notes: `edge ${((prob - (impliedProb(odds) ?? 0)) * 100).toFixed(1)}%`,
    };
  }

  const need = !p1 || !p2;

  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      {/* setup strip */}
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: settings.modelMode === "rated" && teamOpts.length > 0 ? "2fr 1fr 2fr 1fr" : "1fr 1fr", gap: SP.md, alignItems: "end" }}>
          <PlayerSelect label="Player 1 (home line)" players={players} value={n1} onChange={setN1} />
          {settings.modelMode === "rated" && teamOpts.length > 0 && (
            <div>
              <Label>Skin (P1)</Label>
              <select value={t1Sel} onChange={(e) => setT1Sel(e.target.value)} style={selStyle}>
                <option value="">auto · {effT1 || "—"}</option>
                {teamOpts.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
          <PlayerSelect label="Player 2" players={players} value={n2} onChange={setN2} />
          {settings.modelMode === "rated" && teamOpts.length > 0 && (
            <div>
              <Label>Skin (P2)</Label>
              <select value={t2Sel} onChange={(e) => setT2Sel(e.target.value)} style={selStyle}>
                <option value="">auto · {effT2 || "—"}</option>
                {teamOpts.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>
        {players.length < 2 && (
          <div style={{ marginTop: SP.md }}><Badge tone="amber">Add at least 2 players in the Data view to analyze.</Badge></div>
        )}
        {!need && proj && (
          <div style={{ marginTop: SP.md, display: "flex", gap: SP.sm, flexWrap: "wrap" }}>
            <Badge tone={ratedLive ? "pos" : "muted"}>
              {ratedLive ? "opponent + team rating model" : settings.modelMode === "rated" ? "baseline (player unseen in walk-forward — load history)" : "baseline ppm model"}
            </Badge>
            {proj.confidence === "Low" && <Badge tone="amber">Low sample (min GP {proj.minGp}) — treat projections as soft.</Badge>}
          </div>
        )}
      </Card>

      {need || !proj || !wp || margin == null || sigmaMargin == null ? (
        <Card><Empty icon={<Crosshair size={26} color={C.muted} />} title="Pick a matchup"
          body="Select two players above to generate total, moneyline and spread projections with edge detection." /></Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(300px, 2fr)", gap: SP.lg, alignItems: "start" }}>
          {/* projection panel */}
          <div style={{ display: "grid", gap: SP.lg, minWidth: 0 }}>
            <Card glow>
              <CardHeader
                title={<span style={{ fontSize: 16, fontWeight: 900 }}>{p1.name} <span style={{ color: C.faint, fontWeight: 400 }}>vs</span> {p2.name}</span>}
                actions={<Badge tone={proj.confidence === "High" ? "pos" : proj.confidence === "Med" ? "amber" : "neg"}>{proj.confidence} confidence</Badge>} />
              <StatStrip>
                <Stat label="Projected total" value={proj.projected} tone={C.accent} sub={`σ ±${proj.sigma.toFixed(1)}`} />
                <Stat label={`${p1.name} pts`} value={proj.p1_proj} />
                <Stat label={`${p2.name} pts`} value={proj.p2_proj} />
                <Stat label="Proj. margin" value={(margin > 0 ? "+" : "") + margin.toFixed(1)} tone={margin > 0 ? C.pos : C.neg} sub={`${p1.name} perspective`} />
                <Stat label={`P(${p1.name} win)`} value={wp.adjusted.toFixed(0) + "%"} tone={C.blue} sub={`base ${wp.baseWp.toFixed(0)}% · h2h ${h2hPenalty.toFixed(2)}`} />
              </StatStrip>

              {/* breakdown — rating contributions when rated, multiplicative factors when baseline */}
              <div style={{ display: "flex", gap: SP.sm, flexWrap: "wrap", marginTop: SP.lg }}>
                {proj.rated ? (() => {
                  const lm = ratings.leagueMean(); const r1o = ratings.ratingOf(p1.name), r2o = ratings.ratingOf(p2.name);
                  const tt1 = ratings.teamRatingOf(effT1), tt2 = ratings.teamRatingOf(effT2);
                  const sg = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
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
              <div style={{ height: 190, marginTop: SP.lg }}>
                <ResponsiveContainer>
                  <AreaChart data={dist} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                    <defs>
                      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.accent} stopOpacity={0.5} />
                        <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.border} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="x" stroke={C.faint} tick={{ fontSize: 10, fontFamily: FONT.mono }} />
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

            {/* line shopping */}
            <Card>
              <CardHeader icon={<Search size={15} />} title="Line shopping · totals"
                sub={`Same line (${totalLine || "set a book line first"}) across books — the durable edge in fast micro-markets is taking the best available number, then tracking CLV in the ledger.`} />
              {(() => {
                const bp = bestPrice(books);
                const modelP = pOver;
                const evAt = (p: number, o: number | null) => (o == null ? null : p * payoutMult(o) - (1 - p));
                const bestOverEV = modelP != null && bp.bestOver ? evAt(modelP, bp.bestOver.o) : null;
                const bestUnderEV = modelP != null && bp.bestUnder ? evAt(1 - modelP, bp.bestUnder.o) : null;
                return (
                  <>
                    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr auto", gap: SP.sm, alignItems: "center" }}>
                      <Label>Book</Label><Label>Over</Label><Label>Under</Label><span />
                      {books.map((b, i) => (
                        <React.Fragment key={i}>
                          <input aria-label={`Book ${i + 1} name`} value={b.book} onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, book: e.target.value } : x))} style={inputStyle} />
                          <input aria-label={`Book ${i + 1} over odds`} value={b.over} placeholder="-110" onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, over: e.target.value } : x))}
                            style={{ ...inputStyle, ...(bp.bestOver && num(b.over) === bp.bestOver.o && b.over !== "" ? { borderColor: C.accent, color: C.accent } : {}) }} />
                          <input aria-label={`Book ${i + 1} under odds`} value={b.under} placeholder="-110" onChange={(e) => setBooks((p) => p.map((x, j) => j === i ? { ...x, under: e.target.value } : x))}
                            style={{ ...inputStyle, ...(bp.bestUnder && num(b.under) === bp.bestUnder.o && b.under !== "" ? { borderColor: C.accent, color: C.accent } : {}) }} />
                          <button title="Remove book" onClick={() => setBooks((p) => p.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 16, padding: SP.xs }}>×</button>
                        </React.Fragment>
                      ))}
                    </div>
                    <button onClick={() => setBooks((p) => [...p, { book: `Book ${String.fromCharCode(65 + p.length)}`, over: "", under: "" }])}
                      style={{ marginTop: SP.sm, background: "none", border: `1px dashed ${C.border}`, color: C.muted, borderRadius: RADIUS.md, padding: "6px 10px", cursor: "pointer", fontSize: 11, fontFamily: FONT.ui }}>+ book</button>

                    <div style={{ marginTop: SP.lg }}>
                      <StatStrip>
                        <Stat label="Best Over" value={bp.bestOver ? americanStr(bp.bestOver.o) : "—"} sub={bp.bestOver ? bp.bestOver.book : "enter odds"} tone={C.accent} />
                        <Stat label="Best Under" value={bp.bestUnder ? americanStr(bp.bestUnder.o) : "—"} sub={bp.bestUnder ? bp.bestUnder.book : "enter odds"} tone={C.accent} />
                        <Stat label="Market P(Over)" value={bp.consensusOver != null ? `${(bp.consensusOver * 100).toFixed(1)}%` : "—"} sub="no-vig consensus" />
                        <Stat label="Model P(Over)" value={modelP != null ? `${(modelP * 100).toFixed(1)}%` : "—"} sub="needs a line" />
                      </StatStrip>
                    </div>
                    {modelP != null && (bp.bestOver || bp.bestUnder) && (
                      <div style={{ marginTop: SP.md, display: "grid", gap: SP.sm }}>
                        {bp.bestOver && <BestPriceRow side="Over" odds={bp.bestOver.o} book={bp.bestOver.book} ev={bestOverEV} onLog={() => logTotal("Over", bp.bestOver!.o)} />}
                        {bp.bestUnder && <BestPriceRow side="Under" odds={bp.bestUnder.o} book={bp.bestUnder.book} ev={bestUnderEV} onLog={() => logTotal("Under", bp.bestUnder!.o)} />}
                        {bp.consensusOver != null && (
                          <div style={{ fontSize: 11, color: C.muted, fontFamily: FONT.mono, lineHeight: 1.5 }}>
                            model vs market: <b style={{ color: modelP > bp.consensusOver ? C.pos : C.neg }}>{((modelP - bp.consensusOver) * 100 >= 0 ? "+" : "") + ((modelP - bp.consensusOver) * 100).toFixed(1)}%</b> on Over — your disagreement with the no-vig consensus is the model&apos;s claimed edge; the best-price row is what you can actually take.
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </Card>
          </div>

          {/* markets rail */}
          <div style={{ display: "grid", gap: SP.lg, minWidth: 0 }}>
            <Card>
              <CardHeader icon={<Target size={15} />} title="Total (Over / Under)" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: SP.sm }}>
                <Field label="Book line" value={totalLine} onChange={setTotalLine} placeholder="130.5" />
                <Field label="Over odds" value={overOdds} onChange={setOverOdds} />
                <Field label="Under odds" value={underOdds} onChange={setUnderOdds} />
              </div>
              {pOver != null && pUnder != null ? (
                <div style={{ marginTop: SP.md, display: "grid", gap: SP.sm }}>
                  <EdgeRow side="Over" prob={pOver} odds={overOdds} edge={overEdge} settings={settings} onLog={() => logTotal("Over")} />
                  <EdgeRow side="Under" prob={pUnder} odds={underOdds} edge={underEdge} settings={settings} onLog={() => logTotal("Under")} />
                </div>
              ) : <Hint>Enter a book line to compute Over/Under edge.</Hint>}
            </Card>

            <Card>
              <CardHeader icon={<Percent size={15} />} title="Moneyline" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SP.sm }}>
                <Field label={`${p1.name} odds`} value={mlOdds1} onChange={setMlOdds1} placeholder="-120" />
                <Field label={`${p2.name} odds`} value={mlOdds2} onChange={setMlOdds2} placeholder="+105" />
              </div>
              <div style={{ marginTop: SP.md, display: "grid", gap: SP.sm }}>
                <EdgeRow side={p1.name} prob={wp.adjusted / 100} odds={mlOdds1} disabled={mlOdds1 === ""}
                  edge={mlOdds1 === "" ? null : wp.adjusted / 100 - (impliedProb(mlOdds1) ?? 0)} settings={settings} compact
                  onLog={() => { onLog(mlBet(p1.name, wp.adjusted / 100, mlOdds1)); flash(); }} />
                <EdgeRow side={p2.name} prob={1 - wp.adjusted / 100} odds={mlOdds2} disabled={mlOdds2 === ""}
                  edge={mlOdds2 === "" ? null : (1 - wp.adjusted / 100) - (impliedProb(mlOdds2) ?? 0)} settings={settings} compact
                  onLog={() => { onLog(mlBet(p2.name, 1 - wp.adjusted / 100, mlOdds2)); flash(); }} />
              </div>
            </Card>

            <Card>
              <CardHeader icon={<Gauge size={15} />} title={`Spread · ${p1.name}`} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SP.sm }}>
                <Field label="Spread (P1)" value={spreadLine} onChange={setSpreadLine} placeholder="-3.5" />
                <Field label="Odds" value={spreadOdds} onChange={setSpreadOdds} />
              </div>
              {pCover != null ? (
                <div style={{ marginTop: SP.md }}>
                  <EdgeRow side={`${p1.name} ${Number(spreadLine) > 0 ? "+" : ""}${spreadLine}`} prob={pCover} odds={spreadOdds} edge={spreadEdge} settings={settings}
                    onLog={() => {
                      onLog({
                        id: crypto.randomUUID(), timestamp: new Date().toISOString(),
                        matchup: `${p1.name} vs ${p2.name}`, bet_type: "Spread", line: `${p1.name} ${spreadLine}`,
                        proj_value: margin, model_prob: +(pCover * 100).toFixed(1), odds: num(spreadOdds), stake: "",
                        outcome: "Pending", profit: 0, notes: `edge ${((spreadEdge ?? 0) * 100).toFixed(1)}%`,
                      }); flash();
                    }} />
                  <div style={{ marginTop: SP.sm, fontSize: 11, color: C.faint, fontFamily: FONT.mono }}>
                    proj margin {margin.toFixed(1)} · σ {sigmaMargin.toFixed(1)}
                  </div>
                </div>
              ) : <Hint>Enter a spread (negative = P1 favored).</Hint>}
            </Card>
          </div>
        </div>
      )}

      {logged && (
        <div style={{ position: "fixed", bottom: SP.xl, left: "50%", transform: "translateX(-50%)", zIndex: 50 }}>
          <Badge tone="pos">✓ Logged to ledger</Badge>
        </div>
      )}
    </div>
  );
}

/* ── edge / best-price rows ──────────────────────────────────────────────── */
function EdgeRow({ side, prob, odds, edge, settings, onLog, compact, disabled }: {
  side: string; prob: number; odds: string; edge: number | null; settings: Settings;
  onLog: () => void; compact?: boolean; disabled?: boolean;
}) {
  if (disabled) return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px",
      background: C.surface2, border: `1px solid ${C.border}`, borderRadius: RADIUS.md, opacity: 0.6 }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{side}</span>
      <span style={{ fontSize: 11, color: C.faint }}>enter odds</span>
    </div>
  );
  const ev = evPerUnit(prob, odds);
  const kq = Math.max(0, 0.25 * fullKelly(prob, odds)); // conservative quarter-Kelly
  const good = edge != null && edge >= settings.edgeThresh;
  const bad = edge != null && edge < 0;
  const tone = good ? C.pos : bad ? C.neg : C.amber;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: SP.sm, padding: "8px 10px",
      background: good ? C.accentBg : C.surface2, border: `1px solid ${good ? C.accentDim : bad ? C.neg + "44" : C.border}`, borderRadius: RADIUS.md }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{side}</div>
        <div style={{ fontFamily: FONT.mono, fontSize: 11, color: C.muted, marginTop: 2 }}>
          model {(prob * 100).toFixed(1)}% · impl {((impliedProb(odds) ?? 0) * 100).toFixed(1)}%
        </div>
      </div>
      <div style={{ textAlign: "right", fontFamily: FONT.mono, flexShrink: 0 }}>
        <div style={{ color: tone, fontWeight: 700, fontSize: 14 }}>{edge == null ? "—" : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`}</div>
        {!compact && <div style={{ fontSize: 10, color: C.faint }}>EV {ev >= 0 ? "+" : ""}{ev.toFixed(2)}u · ¼K {(kq * 100).toFixed(1)}%</div>}
      </div>
      <Btn kind={good ? "primary" : "ghost"} onClick={onLog} style={{ padding: "6px 10px", fontSize: 12, minHeight: 32 }}>Log</Btn>
    </div>
  );
}

function BestPriceRow({ side, odds, book, ev, onLog }: {
  side: string; odds: number; book: string; ev: number | null; onLog: () => void;
}) {
  const good = ev != null && ev > 0;
  const tone = good ? C.pos : ev != null && ev < 0 ? C.neg : C.amber;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: SP.sm, padding: "8px 10px",
      background: good ? C.accentBg : C.surface2, border: `1px solid ${good ? C.accentDim : C.border}`, borderRadius: RADIUS.md }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 13 }}>{side} <span style={{ color: C.accent, fontFamily: FONT.mono }}>{americanStr(odds)}</span></div>
        <div style={{ fontFamily: FONT.mono, fontSize: 11, color: C.muted, marginTop: 2 }}>best price · {book || "—"}</div>
      </div>
      <div style={{ textAlign: "right", fontFamily: FONT.mono, flexShrink: 0 }}>
        <div style={{ color: tone, fontWeight: 700, fontSize: 14 }}>{ev == null ? "—" : `${ev >= 0 ? "+" : ""}${ev.toFixed(2)}u EV`}</div>
        <div style={{ fontSize: 10, color: C.faint }}>at best available number</div>
      </div>
      <Btn kind={good ? "primary" : "ghost"} onClick={onLog} style={{ padding: "6px 10px", fontSize: 12, minHeight: 32 }}>Log</Btn>
    </div>
  );
}
