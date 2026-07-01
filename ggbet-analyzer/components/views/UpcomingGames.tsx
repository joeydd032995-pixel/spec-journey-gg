'use client';
/* Upcoming games feed — schedule from the scraper with per-game stats,
   H2H history and model analysis in expandable rows. */
import React, { useState } from "react";
import { Calendar, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import type { UpcomingGame } from "@/lib/upcoming";
import { Badge, Btn, Card, CardHeader, Empty, FormDots, Label, Stat } from "@/components/ui";

export default function UpcomingGamesFeed({ upcoming, loading, error, onRefresh }: {
  upcoming: UpcomingGame[]; loading: boolean; error: string | null; onRefresh: () => void;
}) {
  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      <Card>
        <CardHeader icon={<Calendar size={15} />}
          title={<>Upcoming matchups{upcoming.length > 0 && <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: C.muted }}>{upcoming.length} game{upcoming.length !== 1 ? "s" : ""}</span>}</>}
          actions={
            <Btn onClick={onRefresh} disabled={loading}>
              <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
              {loading ? "Loading…" : "Refresh"}
            </Btn>
          } />

        {error && (
          <div style={{ color: C.neg, fontSize: 13, marginBottom: SP.md, padding: "8px 12px",
            background: `${C.negBg}33`, borderRadius: RADIUS.md, border: `1px solid ${C.neg}44` }}>
            {error} — is the scraper running?
          </div>
        )}

        {!loading && upcoming.length === 0 && !error ? (
          <Empty icon={<Calendar size={28} color={C.muted} />} title="No upcoming games found"
            body="Check back soon, or increase the days window. Make sure the scraper is running." />
        ) : (
          <div style={{ display: "grid", gap: SP.sm }}>
            {upcoming.map((game) => <UpcomingGameCard key={game.external_id} game={game} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function UpcomingGameCard({ game }: { game: UpcomingGame }) {
  const [expanded, setExpanded] = useState<"h2h" | "analysis" | null>(null);
  const toggle = (section: "h2h" | "analysis") => setExpanded((prev) => (prev === section ? null : section));

  const mm = String(game.minute_utc ?? 0).padStart(2, "0");
  const timeStr = `${game.date}  ${String(game.hour_utc).padStart(2, "0")}:${mm} UTC`;
  const edge = game.analysis?.win_edge;
  const bands = game.analysis?.score_bands;
  const ppm = game.analysis?.ppm_model;
  const h2h = game.h2h;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: RADIUS.md, overflow: "hidden" }}>
      {/* header row */}
      <div style={{ padding: "12px 16px", background: C.surface2, display: "grid", gridTemplateColumns: "1fr auto", gap: SP.md, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, fontFamily: FONT.mono }}>
            {timeStr}  ·  {game.division}
          </div>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>
            {game.player1}
            <span style={{ color: C.faint, fontWeight: 400, margin: "0 8px" }}>vs</span>
            {game.player2}
          </div>
          {edge && (
            <div style={{ marginTop: SP.xs }}>
              <Badge tone="pos">{edge.favored} edge +{edge.edge_pct}%</Badge>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: SP.xs }}>
          <Btn kind="ghost" onClick={() => toggle("h2h")} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>
            H2H {expanded === "h2h" ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Btn>
          <Btn kind="ghost" onClick={() => toggle("analysis")} style={{ fontSize: 12, padding: "4px 10px", minHeight: 32 }}>
            Analysis {expanded === "analysis" ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Btn>
        </div>
      </div>

      {/* player stats bar */}
      {(game.p1_stats || game.p2_stats) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: C.border }}>
          {[
            { label: game.player1, stats: game.p1_stats },
            { label: game.player2, stats: game.p2_stats },
          ].map(({ label, stats }) => (
            <div key={label} style={{ padding: "10px 14px", background: C.surface }}>
              <Label>{label}</Label>
              {stats ? (
                <div style={{ display: "flex", gap: SP.lg, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>Win%</div>
                    <div style={{ fontFamily: FONT.mono, fontWeight: 700, color: C.text }}>
                      {stats.win_pct != null ? `${(+stats.win_pct).toFixed(1)}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>PPM</div>
                    <div style={{ fontFamily: FONT.mono, fontWeight: 700, color: C.accent }}>
                      {stats.pts_per_match != null ? (+stats.pts_per_match).toFixed(1) : "—"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted }}>Form</div>
                    <div style={{ fontSize: 12 }}><FormDots form={stats.recent_form} /></div>
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
          <Label>Head-to-head record</Label>
          {h2h ? (
            <>
              <div style={{ display: "flex", gap: SP.xl, marginBottom: SP.sm, flexWrap: "wrap" }}>
                <Stat label="Total games" value={h2h.total_games} />
                <Stat label={`${game.player1} wins`} value={h2h.p1_wins} tone={C.pos} />
                <Stat label={`${game.player2} wins`} value={h2h.p2_wins} tone={C.neg} />
                {h2h.avg_total != null && <Stat label="Avg total" value={h2h.avg_total.toFixed(1)} />}
              </div>
              {h2h.recent.length > 0 && (
                <div style={{ fontSize: 12, color: C.muted }}>
                  <div style={{ display: "grid", gridTemplateColumns: "100px 80px 80px 60px", gap: "4px 12px", fontFamily: FONT.mono, marginBottom: SP.xs }}>
                    <span style={{ color: C.faint }}>Date</span>
                    <span style={{ color: C.faint }}>{game.player1}</span>
                    <span style={{ color: C.faint }}>{game.player2}</span>
                    <span style={{ color: C.faint }}>Winner</span>
                  </div>
                  {h2h.recent.slice(0, 8).map((g, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 80px 80px 60px", gap: "4px 12px" }}>
                      <span>{String(g.date ?? "")}</span>
                      <span style={{ color: C.text }}>{String(g.p1_score ?? "")}</span>
                      <span style={{ color: C.text }}>{String(g.p2_score ?? "")}</span>
                      <span style={{ color: g.winner === game.player1 ? C.pos : C.neg }}>{String(g.winner ?? "")}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : <div style={{ color: C.faint, fontSize: 13 }}>No H2H history found.</div>}
        </div>
      )}

      {/* analysis section */}
      {expanded === "analysis" && (
        <div style={{ padding: "12px 16px", background: C.surface, borderTop: `1px solid ${C.border}` }}>
          {bands && (
            <>
              <Label>Score prediction bands (±0.5σ)</Label>
              <div style={{ fontFamily: FONT.mono, fontSize: 12, marginBottom: SP.md }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 60px 60px 140px 50px", gap: "4px 8px", color: C.faint, marginBottom: SP.xs }}>
                  <span></span><span>Mean</span><span>Std</span><span>Band</span><span>Conf</span>
                </div>
                {[
                  { label: "Total (both)", band: bands.total },
                  { label: `Home (${game.player1.slice(0, 10)})`, band: bands.p1 },
                  { label: `Away (${game.player2.slice(0, 10)})`, band: bands.p2 },
                ].map(({ label, band }) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: "120px 60px 60px 140px 50px", gap: "4px 8px" }}>
                    <span style={{ color: C.muted }}>{label}</span>
                    {band ? (
                      <>
                        <span style={{ color: C.text }}>{band.mean}</span>
                        <span style={{ color: C.text }}>{band.std}</span>
                        <span style={{ color: C.accent }}>[{band.low} – {band.high}]</span>
                        <span style={{ color: band.confidence >= 60 ? C.pos : C.amber }}>{band.confidence.toFixed(0)}%</span>
                      </>
                    ) : <span style={{ color: C.faint, gridColumn: "span 4" }}>insufficient data</span>}
                  </div>
                ))}
              </div>
            </>
          )}

          {ppm && (
            <>
              <Label>PPM model (season averages)</Label>
              <div style={{ fontFamily: FONT.mono, fontSize: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "120px 70px 70px 80px", gap: "4px 8px", color: C.faint, marginBottom: SP.xs }}>
                  <span></span><span>PPM</span><span>H2H Avg</span><span>Diff</span>
                </div>
                {[
                  { label: "Total (both)", ppmVal: ppm.total, h2hAvg: h2h?.avg_total ?? null },
                  { label: game.player1.slice(0, 10), ppmVal: ppm.p1, h2hAvg: null },
                  { label: game.player2.slice(0, 10), ppmVal: ppm.p2, h2hAvg: null },
                ].map(({ label, ppmVal, h2hAvg }) => (
                  <div key={label} style={{ display: "grid", gridTemplateColumns: "120px 70px 70px 80px", gap: "4px 8px" }}>
                    <span style={{ color: C.muted }}>{label}</span>
                    <span style={{ color: C.text }}>{ppmVal.toFixed(1)}</span>
                    <span style={{ color: C.faint }}>{h2hAvg != null ? h2hAvg.toFixed(1) : "—"}</span>
                    <span style={{ color: ppm.vs_h2h_diff != null ? (ppm.vs_h2h_diff >= 0 ? C.pos : C.neg) : C.faint }}>
                      {h2hAvg != null && ppm.vs_h2h_diff != null ? (ppm.vs_h2h_diff >= 0 ? "+" : "") + ppm.vs_h2h_diff.toFixed(1) : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {!bands && !ppm && <div style={{ color: C.faint, fontSize: 13 }}>No analysis data available.</div>}
        </div>
      )}
    </div>
  );
}
