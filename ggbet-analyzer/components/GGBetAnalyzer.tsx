'use client';
/* ============================================================================
   GGBetAnalyzer — eBasketball H2H GG League (4×5) analytics terminal.
   App shell: fixed sidebar navigation + dense main workspace. All model math
   lives in lib/model.ts; each view lives in components/views/.
   ========================================================================== */
import React, { useState, useEffect } from "react";
import {
  Database, Crosshair, ClipboardList, Bot,
  Calendar, Moon, Sun, Settings as SettingsIcon,
} from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import { DEFAULT_SETTINGS, type Bet, type MatchResult, type Player, type Settings, type WalkForwardRow } from "@/lib/model";
import { STORAGE_KEYS as K, loadKey, saveKey } from "@/lib/storage";
import type { UpcomingGame } from "@/lib/upcoming";

import DataManager from "@/components/views/DataManager";
import Analyzer from "@/components/views/Analyzer";
import UpcomingGamesFeed from "@/components/views/UpcomingGames";
import BetLogger from "@/components/views/BetLogger";
import Insights from "@/components/views/Insights";
import AIAssistant from "@/components/views/AIAssistant";
import SettingsView from "@/components/views/Settings";

type TabId = "data" | "analyze" | "upcoming" | "log" | "ai" | "settings";

const NAV: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "analyze", label: "Analyzer", icon: <Crosshair size={16} /> },
  { id: "upcoming", label: "Upcoming", icon: <Calendar size={16} /> },
  { id: "log", label: "Bet Ledger", icon: <ClipboardList size={16} /> },
  { id: "data", label: "Data", icon: <Database size={16} /> },
  { id: "ai", label: "AI Analyst", icon: <Bot size={16} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={16} /> },
];

export default function GGBetAnalyzer() {
  const [tab, setTab] = useState<TabId>("analyze");
  const [players, setPlayers] = useState<Player[]>([]);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [wf, setWf] = useState<WalkForwardRow[]>([]);
  const [bets, setBets] = useState<Bet[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [lateNight, setLateNight] = useState(false);
  const [clock, setClock] = useState<Date | null>(null);
  const [upcoming, setUpcoming] = useState<UpcomingGame[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcomingError, setUpcomingError] = useState<string | null>(null);

  // hydrate persisted state once on mount
  useEffect(() => {
    setPlayers(loadKey(K.players, [] as Player[]));
    setMatches(loadKey(K.matches, [] as MatchResult[]));
    setWf(loadKey(K.walkforward, [] as WalkForwardRow[]));
    setBets(loadKey(K.bets, [] as Bet[]));
    setSettings({ ...DEFAULT_SETTINGS, ...loadKey(K.settings, {} as Partial<Settings>) });
    const h = new Date().getHours();
    setLateNight(h >= 23 || h < 5);
    setClock(new Date());
    setLoaded(true);
  }, []);
  // persist on change
  useEffect(() => { if (loaded) saveKey(K.players, players); }, [players, loaded]);
  useEffect(() => { if (loaded) saveKey(K.matches, matches); }, [matches, loaded]);
  useEffect(() => { if (loaded) saveKey(K.walkforward, wf); }, [wf, loaded]);
  useEffect(() => { if (loaded) saveKey(K.bets, bets); }, [bets, loaded]);
  useEffect(() => { if (loaded) saveKey(K.settings, settings); }, [settings, loaded]);
  // clock
  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);

  // upcoming fetch — generation counter discards stale in-flight responses
  const upcomingGenRef = React.useRef(0);
  async function fetchUpcomingFeed() {
    const gen = ++upcomingGenRef.current;
    setUpcomingLoading(true);
    setUpcomingError(null);
    try {
      const res = await fetch("/api/upcoming-feed?days=2&history=30");
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
    return () => { clearInterval(iv); upcomingGenRef.current++; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: FONT.ui }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 8px; }
        ::selection { background: ${C.accent}33; }
        input::placeholder { color: ${C.faint}; }
        button:focus-visible, input:focus-visible, select:focus-visible {
          outline: 2px solid ${C.accent}; outline-offset: 2px;
        }
        @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .rise { animation: rise .25s ease both; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        .live { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        select { -webkit-appearance: none; appearance: none; }
        @media (prefers-reduced-motion: reduce) {
          .rise, .live { animation: none; }
        }
        .ggba-sidebar { position: fixed; inset: 0 auto 0 0; width: 212px; display: flex; flex-direction: column;
          border-right: 1px solid ${C.border}; background: ${C.surface}; z-index: 20; }
        .ggba-main { margin-left: 212px; padding: ${SP.xl}px; max-width: 1440px; }
        .ggba-nav-label { display: inline; }
        /* Responsive multi-column layout: set --cols inline for the desktop template;
           below the breakpoint every instance recomposes to a single column so
           content can never squeeze into overlapping slivers on phones. */
        .ggba-cols { display: grid; gap: ${SP.lg}px; align-items: start; grid-template-columns: var(--cols, 1fr); }
        .ggba-cols > * { min-width: 0; }
        @media (max-width: 1080px) {
          .ggba-cols { grid-template-columns: 1fr; }
        }
        @media (max-width: 900px) {
          .ggba-sidebar { width: 60px; }
          .ggba-main { margin-left: 60px; padding: ${SP.lg}px; }
          .ggba-nav-label, .ggba-side-meta { display: none; }
        }
      `}</style>

      {/* sidebar */}
      <aside className="ggba-sidebar">
        <div style={{ display: "flex", alignItems: "center", gap: SP.md, padding: `${SP.lg}px ${SP.lg}px ${SP.md}px` }}>
          <div style={{ width: 32, height: 32, borderRadius: RADIUS.md, background: C.accent, color: "#04130c",
            display: "grid", placeItems: "center", fontWeight: 900, fontSize: 17, flexShrink: 0 }}>G</div>
          <div className="ggba-nav-label" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, letterSpacing: 0.5, fontSize: 14, whiteSpace: "nowrap" }}>
              GGBET<span style={{ color: C.accent }}>//</span>ANALYZER
            </div>
            <div style={{ fontSize: 9, color: C.muted, letterSpacing: 1.2, textTransform: "uppercase", whiteSpace: "nowrap" }}>
              H2H GG League · 4×5
            </div>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2, padding: `${SP.sm}px ${SP.sm}px` }}>
          {NAV.map((t) => {
            const on = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} title={t.label}
                style={{ display: "flex", alignItems: "center", gap: SP.md, padding: "10px 12px", minHeight: 40,
                  borderRadius: RADIUS.md, border: "none", width: "100%", textAlign: "left",
                  background: on ? C.surface3 : "transparent", color: on ? C.text : C.muted,
                  cursor: "pointer", fontSize: 13, fontWeight: on ? 700 : 500, fontFamily: FONT.ui }}>
                <span style={{ color: on ? C.accent : C.faint, display: "inline-flex", flexShrink: 0 }}>{t.icon}</span>
                <span className="ggba-nav-label">{t.label}</span>
              </button>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto", padding: SP.lg, borderTop: `1px solid ${C.border}`, display: "grid", gap: SP.md }}>
          <div style={{ display: "flex", alignItems: "center", gap: SP.sm, fontFamily: FONT.mono, fontSize: 12 }}>
            <span className="live" style={{ width: 7, height: 7, borderRadius: 99, background: C.accent, flexShrink: 0 }} />
            <span className="ggba-nav-label">{clock ? clock.toLocaleTimeString([], { hour12: false }) : "—"}</span>
          </div>
          <button onClick={() => setLateNight((v) => !v)} title="Toggle late-night fatigue model"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: lateNight ? C.amberBg : C.surface2,
              color: lateNight ? C.amber : C.muted, border: `1px solid ${lateNight ? C.amber + "55" : C.border}`,
              borderRadius: RADIUS.md, padding: "7px 10px", minHeight: 32, cursor: "pointer", fontSize: 11, fontFamily: FONT.ui }}>
            {lateNight ? <Moon size={13} /> : <Sun size={13} />}
            <span className="ggba-nav-label">{lateNight ? "Late-night" : "Daytime"}</span>
          </button>
          <div className="ggba-side-meta" style={{ fontFamily: FONT.mono, fontSize: 10.5, color: C.faint, lineHeight: 1.7 }}>
            {players.length} players · {matches.length} matches<br />{wf.length} walk-forward rows
          </div>
        </div>
      </aside>

      {/* main workspace */}
      <main className="ggba-main">
        {!loaded ? (
          <div style={{ color: C.muted, padding: SP.xxl, textAlign: "center" }}>Loading terminal…</div>
        ) : tab === "data" ? (
          <DataManager players={players} setPlayers={setPlayers} matches={matches} setMatches={setMatches}
            wf={wf} setWf={setWf} settings={settings} setSettings={setSettings} />
        ) : tab === "analyze" ? (
          // Analyzer + Insights share one screen: run a matchup, then read the
          // ledger/CLV/backtest evidence right below it without switching views.
          <div style={{ display: "grid", gap: SP.lg }}>
            <Analyzer players={players} settings={settings} lateNight={lateNight} matches={matches} wf={wf}
              onLog={(b: Bet) => setBets((p) => [b, ...p])} />
            <Insights bets={bets} matches={matches} players={players} settings={settings} lateNight={lateNight} wf={wf} />
          </div>
        ) : tab === "upcoming" ? (
          <UpcomingGamesFeed upcoming={upcoming} loading={upcomingLoading} error={upcomingError} onRefresh={fetchUpcomingFeed} />
        ) : tab === "log" ? (
          <BetLogger bets={bets} setBets={setBets} />
        ) : tab === "settings" ? (
          <SettingsView />
        ) : (
          <AIAssistant players={players} settings={settings} lateNight={lateNight} wf={wf} />
        )}

        <footer style={{ textAlign: "center", padding: `${SP.xl}px ${SP.lg}px`, color: C.faint, fontSize: 11, lineHeight: 1.6 }}>
          Models are estimates from your own data — not guarantees. Bet only what you can afford to lose · 21+ ·
          Help: 1-800-522-4700.<br />Collect public stats yourself and import them; respect h2hggl.com&apos;s terms.
        </footer>
      </main>
    </div>
  );
}
