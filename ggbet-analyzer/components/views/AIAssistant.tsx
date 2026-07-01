'use client';
/* AI Analyst — contextual matchup chat. The model sees the live projection
   for the selected matchup via a system prompt built from lib/model.ts, and
   calls go through /api/assistant so no key ever reaches the browser. */
import React, { useEffect, useRef, useState } from "react";
import { Bot, Send } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import {
  buildRatingsModel, computeProjection, efficiency, leagueMeanPpm, winProb,
  type Player, type Settings, type WalkForwardRow,
} from "@/lib/model";
import { STORAGE_KEYS as K, loadKey } from "@/lib/storage";
import { Btn, Card, PlayerSelect } from "@/components/ui";

interface ChatMessage { role: "user" | "assistant"; content: string }

export default function AIAssistant({ players, settings, lateNight, wf }: {
  players: Player[]; settings: Settings; lateNight: boolean; wf: WalkForwardRow[];
}) {
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [q, setQ] = useState("");
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" }); }, [msgs, busy]);

  const p1 = players.find((p) => p.name === n1);
  const p2 = players.find((p) => p.name === n2);

  function buildContext(): string {
    const lines: string[] = [];
    lines.push("You are GGBetAnalyzer's analyst for eBasketball H2H GG League (4x5 min format). Be concise, quantitative, and honest about uncertainty. Never guarantee outcomes; flag low-sample data. Frame everything as +EV reasoning, not advice to bet.");
    lines.push(`Model params: ${JSON.stringify(settings)}. Late-night fatigue active: ${lateNight}. Active projection model: ${settings.modelMode}.`);
    const fmt = (p: Player) => `${p.name}: win%=${p.win_pct}, ppm=${p.pts_per_match}, fg%=${p.fg_pct}, stl=${p.steals}, pf=${p.fouls}, gp=${p.gp}, form=${p.recent_form || "n/a"}, eff=${efficiency(p).toFixed(1)}`;
    if (p1) lines.push("P1 " + fmt(p1));
    if (p2) lines.push("P2 " + fmt(p2));
    if (p1 && p2) {
      const games = (wf || []).map((r) => ({ p1: r.player1, t1: r.p1_team || "", p2: r.player2, t2: r.p2_team || "", s1: r.score1, s2: r.score2 }));
      const ratings = buildRatingsModel(games, settings);
      const pr = computeProjection(p1, p2, settings, lateNight, { leagueMean: leagueMeanPpm(players), ratings, team1: "", team2: "" });
      const wp = winProb(p1, p2, 0, settings);
      if (pr) lines.push(`Model output (${pr.rated ? "opponent+team ratings" : "baseline ppm"}): projected_total=${pr.projected} (sigma ${pr.sigma.toFixed(1)}), ${p1.name}_pts=${pr.p1_proj}, ${p2.name}_pts=${pr.p2_proj}, P(${p1.name} win)=${wp.adjusted.toFixed(0)}%, confidence=${pr.confidence}.`);
    }
    if (!players.length) lines.push("NOTE: roster is empty; the user must import real data first.");
    return lines.join("\n");
  }

  async function ask(prefill?: string) {
    const question = (prefill ?? q).trim();
    if (!question || busy) return;
    const next: ChatMessage[] = [...msgs, { role: "user", content: question }];
    setMsgs(next); setQ(""); setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // apiKey: the user's own key from Settings; ignored when the server has one
        body: JSON.stringify({ system: buildContext(), messages: next, apiKey: loadKey<string>(K.anthropicKey, "") }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsgs((m) => [...m, { role: "assistant", content: data.text || "No response." }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `⚠ ${e instanceof Error ? e.message : "Could not reach the model."}` }]);
    } finally {
      setBusy(false);
    }
  }

  const suggestions = p1 && p2 ? [
    `Analyze ${p1.name} vs ${p2.name} for tonight's total — where's the edge?`,
    `Is ${p1.name} a live moneyline dog at +110?`,
    `What would make me fade the Over here?`,
  ] : ["Pick two players above, then ask about the matchup."];

  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SP.md }}>
          <PlayerSelect label="Player 1" players={players} value={n1} onChange={setN1} />
          <PlayerSelect label="Player 2" players={players} value={n2} onChange={setN2} />
        </div>
        <div style={{ marginTop: SP.md, fontSize: 12, color: C.muted }}>
          The assistant sees your live model output for the selected matchup and reasons over it. It won&apos;t invent stats.
        </div>
      </Card>

      <Card flush style={{ display: "flex", flexDirection: "column", height: 480 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: SP.lg, display: "flex", flexDirection: "column", gap: SP.md }}>
          {msgs.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center", color: C.muted }}>
              <Bot size={30} color={C.faint} />
              <div style={{ marginTop: SP.sm, fontSize: 13 }}>Ask anything about the selected matchup.</div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div style={{ fontSize: 10, color: C.faint, marginBottom: 3, textAlign: m.role === "user" ? "right" : "left", textTransform: "uppercase", letterSpacing: 1 }}>
                {m.role === "user" ? "You" : "Analyst"}
              </div>
              <div style={{ background: m.role === "user" ? C.accent : C.surface2, color: m.role === "user" ? "#04130c" : C.text,
                border: `1px solid ${m.role === "user" ? C.accent : C.border}`, borderRadius: RADIUS.lg, padding: "10px 13px",
                fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
            </div>
          ))}
          {busy && <div style={{ alignSelf: "flex-start", color: C.muted, fontSize: 13 }}><span className="live">▍ analyzing…</span></div>}
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, padding: SP.md }}>
          <div style={{ display: "flex", gap: SP.xs, flexWrap: "wrap", marginBottom: SP.sm }}>
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => p1 && p2 && ask(s)} disabled={!p1 || !p2}
                style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 999,
                  padding: "5px 11px", fontSize: 11, cursor: p1 && p2 ? "pointer" : "default", fontFamily: FONT.ui }}>{s}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: SP.sm }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()}
              placeholder="Ask about totals, ML value, what to fade…" aria-label="Ask the analyst"
              style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: RADIUS.md, padding: "10px 13px",
                color: C.text, fontSize: 13, fontFamily: FONT.ui, outline: "none" }} />
            <Btn kind="primary" onClick={() => ask()} disabled={busy || !q.trim()} title="Send"><Send size={15} /></Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}
