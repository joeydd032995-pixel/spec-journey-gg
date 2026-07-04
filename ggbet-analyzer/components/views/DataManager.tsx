'use client';
/* Data view — live fetch, roster, match results, walk-forward snapshots and
   model parameters, arranged as a two-column workspace instead of a long
   stack of full-width cards. */
import React, { useRef, useState } from "react";
import Papa from "papaparse";
import { Database, Upload, Plus, Download, Trash2, RefreshCw, X, AlertTriangle, Edit3 } from "lucide-react";

import { C, FONT, SP, RADIUS } from "@/lib/theme";
import {
  CSV_COLS, MATCH_COLS, WF_COLS, DEFAULT_SETTINGS, efficiency, matchKey, num, wfKey,
  type MatchResult, type Player, type Settings, type WalkForwardRow,
} from "@/lib/model";
import { downloadCsv, readFileAsText } from "@/lib/download";
import {
  Badge, Btn, Card, CardHeader, Empty, Field, FormDots, Hero, Hint, Label, Notice,
  PlayerSelect, Stat, StatStrip, iconBtn, selStyle, tdR, thStyle,
} from "@/components/ui";

type Msg = { t: "pos" | "neg" | "amber"; m: string } | null;
type SetPlayers = React.Dispatch<React.SetStateAction<Player[]>>;
type SetMatches = React.Dispatch<React.SetStateAction<MatchResult[]>>;
type SetWf = React.Dispatch<React.SetStateAction<WalkForwardRow[]>>;

function blankPlayer(): Player {
  return { name: "", win_pct: "", pts_per_match: "", fg_pct: "", steals: "", fouls: "", gp: "", w: "", l: "", recent_form: "", nba_team: "" };
}

export default function DataManager({ players, setPlayers, matches, setMatches, wf, setWf, settings, setSettings }: {
  players: Player[]; setPlayers: SetPlayers;
  matches: MatchResult[]; setMatches: SetMatches;
  wf: WalkForwardRow[]; setWf: SetWf;
  settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>>;
}) {
  const [draft, setDraft] = useState<Player>(blankPlayer());
  return (
    <div className="rise" style={{ display: "grid", gap: SP.lg }}>
      <Hero eyebrow="Data" title="Your data, your model"
        sub="Real data in, no fabricated rows. Fetch live, import CSVs, or enter players by hand — then tune the projection model."
        kpis={<StatStrip>
          <Stat label="Players" value={players.length} />
          <Stat label="Matches" value={matches.length} />
          <Stat label="WF rows" value={wf.length} />
        </StatStrip>} />
      <FetchCard setPlayers={setPlayers} setMatches={setMatches} setWf={setWf} />
      <div className="ggba-cols" style={{ "--cols": "minmax(0, 2fr) minmax(0, 1fr)" } as React.CSSProperties}>
        <div style={{ display: "grid", gap: SP.lg, minWidth: 0 }}>
          <RosterCard players={players} setPlayers={setPlayers} onEdit={setDraft} />
          <MatchEntry matches={matches} setMatches={setMatches} players={players} />
        </div>
        <div style={{ display: "grid", gap: SP.lg, minWidth: 0 }}>
          <PlayerForm players={players} setPlayers={setPlayers} draft={draft} setDraft={setDraft} />
          <ModelParams settings={settings} setSettings={setSettings} />
          <WalkForwardImport wf={wf} setWf={setWf} />
        </div>
      </div>
    </div>
  );
}

/* ── live fetch ──────────────────────────────────────────────────────────── */
function FetchCard({ setPlayers, setMatches, setWf }: { setPlayers: SetPlayers; setMatches: SetMatches; setWf: SetWf }) {
  const [days, setDays] = useState("14");
  const [minGp, setMinGp] = useState("1");
  const [source, setSource] = useState<"h2hggl" | "betsapi">("h2hggl");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Msg>(null);

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

      setWf((prev) => {
        const seen = new Set(prev.map(wfKey));
        const next = [...prev];
        (walkforward as WalkForwardRow[]).forEach((r) => { const k = wfKey(r); if (!seen.has(k)) { seen.add(k); next.push(r); } });
        next.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        return next;
      });
      setPlayers((prev) => {
        const map = new Map(prev.map((p) => [p.name.toLowerCase(), p]));
        (newPlayers as Player[]).forEach((p) => map.set(p.name.toLowerCase(), { ...p, last_updated: new Date().toISOString() }));
        return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
      });
      setMatches((prev) => {
        const key = (m: MatchResult) => `${m.date}|${m.player1}|${m.player2}`;
        const seen = new Set(prev.map(key));
        const next = [...prev];
        (newMatches as MatchResult[]).forEach((m) => { if (!seen.has(key(m))) { seen.add(key(m)); next.push(m); } });
        return next;
      });
      setResult({ t: "pos", m: `Fetched ${meta.games} games (${days}d) → ${walkforward.length} WF rows, ${newPlayers.length} players.` });
    } catch (e) {
      setResult({ t: "neg", m: `Error: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card glow>
      <CardHeader icon={<Download size={15} />} title="Fetch live data"
        sub={source === "h2hggl"
          ? "Free H2H GG League data — games, players, FG% / steals / fouls, walk-forward snapshots in one click. Works out of the box via h2hggl.com's public API; optionally point H2HGGL_API_URL at the self-hosted scraper (see /scraper) for cached responses."
          : "BetsAPI fallback (paid) — requires BETSAPI_TOKEN; FG%, steals & fouls are not in this feed."}
        actions={
          <div style={{ display: "flex", gap: SP.sm, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <Label>Source</Label>
              <select value={source} onChange={(e) => setSource(e.target.value as "h2hggl" | "betsapi")} style={{ ...selStyle, width: 190 }}>
                <option value="h2hggl">H2H GG League (free)</option>
                <option value="betsapi">BetsAPI (fallback)</option>
              </select>
            </div>
            <div>
              <Label>History</Label>
              <select value={days} onChange={(e) => setDays(e.target.value)} style={{ ...selStyle, width: 110 }}>
                {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <div>
              <Label>Min GP</Label>
              <select value={minGp} onChange={(e) => setMinGp(e.target.value)} style={{ ...selStyle, width: 100 }}>
                {[1, 3, 5, 10, 20].map((g) => <option key={g} value={g}>{g} games</option>)}
              </select>
            </div>
            <Btn kind="primary" onClick={fetchData} disabled={loading}>
              <RefreshCw size={14} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
              {loading ? "Fetching…" : "Fetch data"}
            </Btn>
          </div>
        } />
      {result && <Badge tone={result.t}>{result.m}</Badge>}
    </Card>
  );
}

/* ── roster table ────────────────────────────────────────────────────────── */
function RosterCard({ players, setPlayers, onEdit }: { players: Player[]; setPlayers: SetPlayers; onEdit: (p: Player) => void }) {
  const [msg, setMsg] = useState<Msg>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function importCsv(text: string) {
    const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
    let added = 0, updated = 0;
    const rows = res.data.filter((r) => (r.name || "").trim());
    setPlayers((prev) => {
      const map = new Map(prev.map((p) => [p.name.toLowerCase(), p]));
      rows.forEach((r) => {
        const rec: Player = {
          name: r.name.trim(),
          win_pct: num(r.win_pct), pts_per_match: num(r.pts_per_match), fg_pct: num(r.fg_pct),
          steals: num(r.steals), fouls: num(r.fouls), gp: num(r.gp), w: num(r.w), l: num(r.l),
          recent_form: (r.recent_form || "").toUpperCase().replace(/[^WL]/g, ""),
          nba_team: r.nba_team || "", last_updated: new Date().toISOString(),
        };
        const key = rec.name.toLowerCase();
        if (map.has(key)) { map.set(key, { ...map.get(key)!, ...rec }); updated++; }
        else { map.set(key, rec); added++; }
      });
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    });
    setMsg({ t: "pos", m: `Imported ${added} new · updated ${updated}.` });
  }

  function exportPlayers() {
    if (!players.length) return;
    const csv = Papa.unparse(players.map((p) => {
      const o: Record<string, unknown> = {};
      CSV_COLS.forEach((c) => (o[c] = (p as unknown as Record<string, unknown>)[c] ?? ""));
      return o;
    }));
    downloadCsv("ggba_players_export.csv", csv);
  }

  return (
    <Card flush>
      <div style={{ padding: `${SP.lg}px ${SP.lg}px 0` }}>
        <CardHeader icon={<Database size={15} />}
          title={<>Roster · <span style={{ fontFamily: FONT.mono, color: C.accent }}>{players.length}</span></>}
          sub={<>CSV columns mirror the h2hggl schema: <span style={{ fontFamily: FONT.mono }}>{CSV_COLS.join(" · ")}</span></>}
          actions={<>
            <input ref={fileRef} type="file" accept=".csv" onChange={(e) => { readFileAsText(e.target.files?.[0], importCsv); e.target.value = ""; }} style={{ display: "none" }} />
            <Btn onClick={() => fileRef.current?.click()}><Upload size={14} />Import</Btn>
            <Btn onClick={() => downloadCsv("ggba_players_template.csv", CSV_COLS.join(",") + "\n")}><Download size={14} />Template</Btn>
            <Btn onClick={exportPlayers} disabled={!players.length}><Download size={14} />Export</Btn>
          </>} />
        {msg && <Notice tone={msg.t}>{msg.m}</Notice>}
      </div>
      {players.length === 0 ? (
        <Empty icon={<Database size={26} color={C.muted} />} title="No players yet"
          body="Fetch live data above, import a CSV of real stats, or add a player in the side panel. The model needs at least the two competitors you want to analyze." />
      ) : (
        <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: FONT.mono }}>
            <thead>
              <tr>
                {(["Player", "Win%", "PPM", "FG%", "STL", "PF", "GP", "Form", "Eff", ""] as const).map((h, i) => (
                  <th key={i} style={thStyle(i === 0 || i === 7 ? "left" : "right")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const low = num(p.gp) < 20;
                return (
                  <tr key={p.name} style={{ borderBottom: `1px solid ${C.border}55` }}>
                    <td style={{ padding: "8px 12px", color: C.text, fontWeight: 700, fontFamily: FONT.ui, whiteSpace: "nowrap" }}>
                      {p.name}
                      {low && <span title="Low sample (<20 GP)" style={{ color: C.amber, marginLeft: 6, fontSize: 10, fontFamily: FONT.mono }}>LOW</span>}
                      {p.nba_team && <span style={{ color: C.faint, fontWeight: 400, marginLeft: 6 }}>{p.nba_team}</span>}
                    </td>
                    <td style={tdR}>{num(p.win_pct).toFixed(1)}</td>
                    <td style={tdR}>{num(p.pts_per_match).toFixed(1)}</td>
                    <td style={tdR}>{num(p.fg_pct).toFixed(1)}</td>
                    <td style={tdR}>{num(p.steals).toFixed(1)}</td>
                    <td style={tdR}>{num(p.fouls).toFixed(1)}</td>
                    <td style={tdR}>{num(p.gp)}</td>
                    <td style={{ ...tdR, textAlign: "left" }}><FormDots form={p.recent_form} /></td>
                    <td style={{ ...tdR, color: C.accent }}>{efficiency(p).toFixed(1)}</td>
                    <td style={{ padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button title={`Edit ${p.name}`} onClick={() => onEdit({ ...p })} style={iconBtn}><Edit3 size={14} /></button>
                      <button title={`Delete ${p.name}`} onClick={() => setPlayers((pp) => pp.filter((x) => x.name !== p.name))}
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
  );
}

/* ── manual player entry ─────────────────────────────────────────────────── */
function PlayerForm({ players, setPlayers, draft, setDraft }: {
  players: Player[]; setPlayers: SetPlayers;
  draft: Player; setDraft: React.Dispatch<React.SetStateAction<Player>>;
}) {
  const [msg, setMsg] = useState<Msg>(null);
  const editing = players.some((p) => p.name.toLowerCase() === String(draft.name).trim().toLowerCase());

  function upsert() {
    if (!String(draft.name).trim()) { setMsg({ t: "neg", m: "Player name required." }); return; }
    const clean: Player = { ...draft, name: String(draft.name).trim(), last_updated: new Date().toISOString() };
    setPlayers((prev) => {
      const i = prev.findIndex((p) => p.name.toLowerCase() === clean.name.toLowerCase());
      if (i >= 0) { const cp = [...prev]; cp[i] = { ...cp[i], ...clean }; return cp; }
      return [...prev, clean].sort((a, b) => a.name.localeCompare(b.name));
    });
    setDraft(blankPlayer());
    setMsg({ t: "pos", m: `Saved ${clean.name}.` });
  }

  const set = (k: keyof Player) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Card>
      <CardHeader icon={<Plus size={15} />} title="Add / update player"
        sub="Real data only — the terminal ships empty and models what you load." />
      {msg && <Notice tone={msg.t}>{msg.m}</Notice>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SP.sm, marginBottom: SP.md }}>
        <div style={{ gridColumn: "span 2" }}>
          <Field label="Name" mono={false} value={String(draft.name)} onChange={set("name")} placeholder="e.g. LANES" />
        </div>
        <Field label="Win %" value={draft.win_pct as string} onChange={set("win_pct")} placeholder="0–100" />
        <Field label="Pts/Match" value={draft.pts_per_match as string} onChange={set("pts_per_match")} />
        <Field label="FG %" value={draft.fg_pct as string} onChange={set("fg_pct")} />
        <Field label="GP" value={draft.gp as string} onChange={set("gp")} />
        <Field label="Steals" value={draft.steals as string} onChange={set("steals")} />
        <Field label="Fouls" value={draft.fouls as string} onChange={set("fouls")} />
        <Field label="Form" value={draft.recent_form} onChange={set("recent_form")} placeholder="WWLWL" />
        <Field label="NBA Team" mono={false} value={draft.nba_team as string} onChange={set("nba_team")} placeholder="optional" />
      </div>
      <div style={{ display: "flex", gap: SP.sm }}>
        <Btn kind="primary" onClick={upsert}><Plus size={14} />{editing ? "Update player" : "Save player"}</Btn>
        {editing && <Btn onClick={() => setDraft(blankPlayer())}><X size={14} />Clear</Btn>}
      </div>
    </Card>
  );
}

/* ── match results ───────────────────────────────────────────────────────── */
function MatchEntry({ matches, setMatches, players }: { matches: MatchResult[]; setMatches: SetMatches; players: Player[] }) {
  const [d, setD] = useState({ date: new Date().toISOString().slice(0, 10), player1: "", player2: "", score1: "", score2: "", division: "" });
  const [msg, setMsg] = useState<Msg>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function add() {
    if (!d.player1 || !d.player2 || d.score1 === "" || d.score2 === "") return;
    const m: MatchResult = { id: crypto.randomUUID(), ...d, score1: num(d.score1), score2: num(d.score2), total: num(d.score1) + num(d.score2) };
    setMatches((p) => [m, ...p]);
    setD({ ...d, player1: "", player2: "", score1: "", score2: "" });
  }

  function importCsv(text: string) {
    const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
    const rows: MatchResult[] = res.data
      .filter((r) => (r.player1 || "").trim() && (r.player2 || "").trim() && r.score1 !== "" && r.score2 !== "")
      .map((r) => ({
        id: crypto.randomUUID(),
        date: (r.date || "").trim() || new Date().toISOString().slice(0, 10),
        player1: r.player1.trim(), player2: r.player2.trim(),
        score1: num(r.score1), score2: num(r.score2),
        total: r.total !== undefined && r.total !== "" ? num(r.total) : num(r.score1) + num(r.score2),
        division: r.division || "",
      }));
    if (!rows.length) { setMsg({ t: "neg", m: "No valid rows. Need player1, player2, score1, score2." }); return; }
    let added = 0;
    setMatches((prev) => {
      const seen = new Set(prev.map(matchKey));
      const next = [...prev];
      rows.forEach((m) => { const k = matchKey(m); if (!seen.has(k)) { seen.add(k); next.push(m); added++; } });
      next.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      return next;
    });
    setMsg({ t: "pos", m: `Imported ${added} · skipped ${rows.length - added} duplicate(s).` });
  }

  return (
    <Card>
      <CardHeader title={<>Match results <span style={{ color: C.faint, fontWeight: 400, fontSize: 12 }}>· {matches.length} loaded · feeds backtest</span></>}
        sub={<span style={{ fontFamily: FONT.mono, fontSize: 11 }}>columns: {MATCH_COLS.join(" · ")}</span>}
        actions={<>
          <input ref={fileRef} type="file" accept=".csv" onChange={(e) => { readFileAsText(e.target.files?.[0], importCsv); e.target.value = ""; }} style={{ display: "none" }} />
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} />Import</Btn>
          <Btn onClick={() => downloadCsv("ggba_matches_template.csv", MATCH_COLS.join(",") + "\n")}><Download size={14} />Template</Btn>
          {matches.length > 0 && <Btn kind="danger" onClick={() => { if (window.confirm("Clear all match results?")) { setMatches([]); setMsg(null); } }}><Trash2 size={14} />Clear</Btn>}
        </>} />
      {msg && <Notice tone={msg.t}>{msg.m}</Notice>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: SP.sm, marginBottom: SP.md }}>
        <Field label="Date" type="date" value={d.date} onChange={(v) => setD({ ...d, date: v })} />
        <PlayerSelect label="Player 1" players={players} value={d.player1} onChange={(v) => setD({ ...d, player1: v })} />
        <PlayerSelect label="Player 2" players={players} value={d.player2} onChange={(v) => setD({ ...d, player2: v })} />
        <Field label="Score 1" value={d.score1} onChange={(v) => setD({ ...d, score1: v })} />
        <Field label="Score 2" value={d.score2} onChange={(v) => setD({ ...d, score2: v })} />
        <Field label="Division" mono={false} value={d.division} onChange={(v) => setD({ ...d, division: v })} placeholder="optional" />
      </div>
      <Btn kind="primary" onClick={add}><Plus size={14} />Add result</Btn>
      {matches.length > 0 && (
        <div style={{ marginTop: SP.md, maxHeight: 176, overflowY: "auto" }}>
          {matches.slice(0, 30).map((m) => (
            <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 0", borderBottom: `1px solid ${C.border}55`, fontSize: 12, fontFamily: FONT.mono, gap: SP.sm }}>
              <span style={{ color: C.muted }}>{m.date}</span>
              <span style={{ color: C.text }}>{m.player1} {m.score1}–{m.score2} {m.player2}</span>
              <span style={{ color: C.accent }}>Σ{m.total}</span>
              <button title="Delete result" onClick={() => setMatches((p) => p.filter((x) => x.id !== m.id))} style={{ ...iconBtn, color: C.neg }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ── walk-forward snapshots ──────────────────────────────────────────────── */
function WalkForwardImport({ wf, setWf }: { wf: WalkForwardRow[]; setWf: SetWf }) {
  const [msg, setMsg] = useState<Msg>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function importCsv(text: string) {
    const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true });
    const rows: WalkForwardRow[] = res.data
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

  return (
    <Card>
      <CardHeader title={<>Walk-forward snapshots <span style={{ color: C.faint, fontWeight: 400, fontSize: 12 }}>· {wf.length}</span></>}
        sub="Each row carries pre-match stats computed only from earlier games, so the backtest is leakage-free."
        actions={<>
          <input ref={fileRef} type="file" accept=".csv" onChange={(e) => { readFileAsText(e.target.files?.[0], importCsv); e.target.value = ""; }} style={{ display: "none" }} />
          <Btn onClick={() => fileRef.current?.click()}><Upload size={14} />Import</Btn>
          <Btn onClick={() => downloadCsv("ggba_walkforward_template.csv", WF_COLS.join(",") + "\n")}><Download size={14} />Template</Btn>
          {wf.length > 0 && <Btn kind="danger" onClick={() => { if (window.confirm("Clear walk-forward data?")) { setWf([]); setMsg(null); } }}><Trash2 size={14} />Clear</Btn>}
        </>} />
      {msg && <Badge tone={msg.t}>{msg.m}</Badge>}
    </Card>
  );
}

/* ── model parameters ────────────────────────────────────────────────────── */
function ModelParams({ settings, setSettings }: { settings: Settings; setSettings: React.Dispatch<React.SetStateAction<Settings>> }) {
  const params: Array<[keyof Settings, string, string, number]> = [
    ["dispersion", "Total dispersion", "σ = √(proj × this) · both models", 0.05],
    ["edgeThresh", "Edge alert threshold", "min edge to flag +EV", 0.005],
    ...(settings.modelMode === "rated"
      ? ([["etaP", "Player learn rate", "ratings: per-player step", 0.01],
          ["etaT", "Team learn rate", "ratings: per-team step (slower)", 0.01],
          ["ratingDecay", "Rating decay", "recency shrink (0=off)", 0.005]] as Array<[keyof Settings, string, string, number]>)
      : ([["formCoef", "Form coefficient", "±this at WWW/LLL", 0.01],
          ["matchupCoef", "Matchup coefficient", "needs steals/fouls (feed=0)", 0.01],
          ["variance", "Global scale ×", "1.00 = unbiased", 0.01],
          ["shrinkK", "Shrinkage k", "regress low-GP → league mean", 1]] as Array<[keyof Settings, string, string, number]>)),
  ];

  return (
    <Card>
      <CardHeader icon={<AlertTriangle size={15} />} title="Model parameters" sub="Changes persist and feed every view." />
      <div style={{ display: "flex", alignItems: "center", gap: SP.sm, marginBottom: SP.lg, flexWrap: "wrap" }}>
        {([["rated", "Opponent + team ratings"], ["baseline", "Baseline ppm"]] as const).map(([m, lab]) => (
          <button key={m} onClick={() => setSettings((s) => ({ ...s, modelMode: m }))}
            style={{ padding: "8px 12px", minHeight: 36, borderRadius: RADIUS.md, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: FONT.ui,
              border: `1px solid ${settings.modelMode === m ? C.accent : C.border}`,
              background: settings.modelMode === m ? C.accentDim : "transparent",
              color: settings.modelMode === m ? C.text : C.muted }}>{lab}</button>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SP.md }}>
        {params.map(([k, lab, sub, step]) => (
          <div key={k}>
            <Field label={lab} type="number" step={step} value={settings[k] as number}
              onChange={(v) => setSettings((s) => ({ ...s, [k]: num(v) }))} />
            <div style={{ fontSize: 10, color: C.faint, marginTop: SP.xs }}>{sub}</div>
          </div>
        ))}
      </div>
      <Hint><Btn onClick={() => setSettings(DEFAULT_SETTINGS)}><RefreshCw size={13} />Reset to defaults</Btn></Hint>
    </Card>
  );
}
