'use client';
/* Bet ledger — open + settled bets with stake entry, settlement and
   closing-line capture for CLV tracking. A KPI strip keeps the headline
   numbers next to the tables instead of in a separate view. */
import React from "react";
import { Check, ClipboardList, Trash2, X } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import { clvEv, num, payoutMult, type Bet } from "@/lib/model";
import { Badge, Card, CardHeader, Empty, Stat, StatStrip, iconBtn, tdR } from "@/components/ui";

type SetBets = React.Dispatch<React.SetStateAction<Bet[]>>;

export default function BetLogger({ bets, setBets }: { bets: Bet[]; setBets: SetBets }) {
  const settle = (id: string, outcome: Bet["outcome"]) => setBets((prev) => prev.map((b) => {
    if (b.id !== id) return b;
    const stake = num(b.stake);
    const profit = outcome === "Win" ? stake * payoutMult(b.odds) : outcome === "Loss" ? -stake : 0;
    return { ...b, outcome, profit: +profit.toFixed(2) };
  }));
  const setStake = (id: string, stake: string) => setBets((prev) => prev.map((b) => (b.id === id ? { ...b, stake } : b)));
  const setClose = (id: string, field: "close_side" | "close_other", val: string) =>
    setBets((prev) => prev.map((b) => (b.id === id ? { ...b, [field]: val } : b)));
  const remove = (id: string) => setBets((p) => p.filter((b) => b.id !== id));

  const open = bets.filter((b) => b.outcome === "Pending");
  const closed = bets.filter((b) => b.outcome !== "Pending");
  const staked = closed.filter((b) => num(b.stake) > 0);
  const totalStake = staked.reduce((a, b) => a + num(b.stake), 0);
  const totalProfit = staked.reduce((a, b) => a + num(b.profit), 0);
  const roi = totalStake ? (totalProfit / totalStake) * 100 : 0;

  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      <Card>
        <CardHeader icon={<ClipboardList size={15} />} title="Bet ledger"
          sub={<>Bets logged from the Analyzer land here. Set your stake, settle Win / Loss / Push, and enter the <b style={{ color: C.accent }}>closing line</b> to track CLV — beating the close is the durable proxy for long-run +EV.</>} />
        {bets.length > 0 && (
          <StatStrip>
            <Stat label="Open" value={open.length} />
            <Stat label="Settled" value={closed.length} />
            <Stat label="Staked" value={`${totalStake.toFixed(1)}u`} />
            <Stat label="Net profit" value={`${totalProfit >= 0 ? "+" : ""}${totalProfit.toFixed(2)}u`} tone={totalProfit >= 0 ? C.pos : C.neg} />
            <Stat label="ROI" value={`${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%`} tone={roi >= 0 ? C.pos : C.neg} />
          </StatStrip>
        )}
      </Card>

      {bets.length === 0 ? (
        <Card><Empty icon={<ClipboardList size={26} color={C.muted} />} title="No bets yet"
          body="Run a matchup in the Analyzer and hit “Log” on any market to start tracking." /></Card>
      ) : (
        <>
          {open.length > 0 && <BetTable title={`Open · ${open.length}`} rows={open} settle={settle} setStake={setStake} setClose={setClose} remove={remove} />}
          {closed.length > 0 && <BetTable title={`Settled · ${closed.length}`} rows={closed} settle={settle} setStake={setStake} setClose={setClose} remove={remove} settled />}
        </>
      )}
    </div>
  );
}

function BetTable({ title, rows, settle, setStake, setClose, remove, settled }: {
  title: string; rows: Bet[]; settled?: boolean;
  settle: (id: string, outcome: Bet["outcome"]) => void;
  setStake: (id: string, stake: string) => void;
  setClose: (id: string, field: "close_side" | "close_other", val: string) => void;
  remove: (id: string) => void;
}) {
  const miniInp: React.CSSProperties = {
    width: 52, background: C.bg, border: `1px solid ${C.border}`, color: C.text,
    borderRadius: RADIUS.sm, padding: "4px 5px", textAlign: "right", fontFamily: FONT.mono, fontSize: 11,
  };
  return (
    <Card flush>
      <div style={{ padding: `${SP.md}px ${SP.lg}px`, fontWeight: 800, fontSize: 14, borderBottom: `1px solid ${C.border}` }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: FONT.mono }}>
          <thead>
            <tr style={{ color: C.muted }}>
              {["When", "Matchup", "Type", "Selection", "Odds", "Model%", "Stake", "Profit", "Close (you / other)", "CLV", "", ""].map((h, i) => (
                <th key={i} style={{ padding: "10px 12px", textAlign: [4, 5, 6, 7, 9].includes(i) ? "right" : "left",
                  borderBottom: `1px solid ${C.border}`, fontWeight: 700, whiteSpace: "nowrap", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const clv = clvEv(b.odds, b.close_side, b.close_other);
              return (
                <tr key={b.id} style={{ borderBottom: `1px solid ${C.border}55` }}>
                  <td style={{ padding: "8px 12px", color: C.faint, whiteSpace: "nowrap" }}>
                    {new Date(b.timestamp).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </td>
                  <td style={{ padding: "8px 12px", color: C.text, fontFamily: FONT.ui, whiteSpace: "nowrap" }}>{b.matchup}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <Badge tone={b.bet_type === "Total" ? "blue" : b.bet_type === "ML" ? "amber" : "muted"}>{b.bet_type}</Badge>
                  </td>
                  <td style={{ padding: "8px 12px", color: C.text, whiteSpace: "nowrap" }}>{b.line}</td>
                  <td style={tdR}>{b.odds > 0 ? "+" : ""}{b.odds}</td>
                  <td style={tdR}>{b.model_prob ?? "—"}</td>
                  <td style={{ ...tdR, width: 90 }}>
                    {settled ? num(b.stake).toFixed(2) : (
                      <input aria-label="Stake" value={String(b.stake ?? "")} onChange={(e) => setStake(b.id, e.target.value)} placeholder="0"
                        style={{ ...miniInp, width: 64, fontSize: 12, padding: "4px 6px" }} />
                    )}
                  </td>
                  <td style={{ ...tdR, color: b.profit > 0 ? C.pos : b.profit < 0 ? C.neg : C.muted, fontWeight: 700 }}>
                    {b.outcome === "Pending" ? "—" : `${b.profit >= 0 ? "+" : ""}${b.profit.toFixed(2)}`}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                    <input aria-label="Closing odds, your side" value={String(b.close_side ?? "")} onChange={(e) => setClose(b.id, "close_side", e.target.value)} placeholder="-110" style={miniInp} />
                    <span style={{ color: C.faint, margin: "0 3px" }}>/</span>
                    <input aria-label="Closing odds, other side" value={String(b.close_other ?? "")} onChange={(e) => setClose(b.id, "close_other", e.target.value)} placeholder="opp" style={miniInp} />
                  </td>
                  <td style={{ ...tdR, fontWeight: 700, color: clv == null ? C.faint : clv > 0 ? C.pos : C.neg }}>
                    {clv == null ? "—" : `${clv >= 0 ? "+" : ""}${(clv * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ padding: "8px 6px", textAlign: "right" }}>
                    {settled ? (
                      <Badge tone={b.outcome === "Win" ? "pos" : b.outcome === "Loss" ? "neg" : "muted"}>{b.outcome}</Badge>
                    ) : (
                      <div style={{ display: "flex", gap: SP.xs, justifyContent: "flex-end" }}>
                        <button onClick={() => settle(b.id, "Win")} title="Win" style={{ ...iconBtn, color: C.pos }}><Check size={14} /></button>
                        <button onClick={() => settle(b.id, "Loss")} title="Loss" style={{ ...iconBtn, color: C.neg }}><X size={14} /></button>
                        <button onClick={() => settle(b.id, "Push")} title="Push" style={{ ...iconBtn, color: C.muted }}>=</button>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px 8px 0", textAlign: "right" }}>
                    <button onClick={() => remove(b.id)} title="Delete bet" style={{ ...iconBtn, color: C.neg }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
