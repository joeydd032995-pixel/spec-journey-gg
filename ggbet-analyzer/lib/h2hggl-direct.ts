/**
 * lib/h2hggl-direct.ts
 * TypeScript port of scraper/app/client.py + normalize.py.
 * Calls the public h2hggl/hudstats API directly — no separate scraper service needed.
 */

import { buildWalkforward } from "./betsapi";
import type { RawGame, PlayerRow, MatchRow } from "./betsapi";
import type { FeedResponse } from "./h2hggl";

const API_BASE = "https://api-h2h.hudstats.com/v1";
const SITE_BASE = "https://h2hggl.com";
const API_SPORT = "nba";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  Origin: SITE_BASE,
  Referer: SITE_BASE + "/",
};

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function apiGet(path: string, revalidate = 120): Promise<unknown> {
  const url = `${API_BASE}/${path.replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    headers: HEADERS,
    next: { revalidate },
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`hudstats API ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchParticipants(): Promise<unknown[]> {
  const data = await apiGet(`participant/${API_SPORT}`, 300);
  return Array.isArray(data) ? data : [];
}

function dayIso(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10) + "T00:00:00+00:00";
}

async function fetchScheduleDay(dateIso: string): Promise<unknown[]> {
  const data = await apiGet(
    `schedule/${API_SPORT}?date=${encodeURIComponent(dateIso)}`,
    120,
  );
  return Array.isArray(data) ? data : [];
}

/** Fetch multiple days concurrently. offsets = days relative to today (negative = past, positive = future). */
async function fetchDays(offsets: number[]): Promise<unknown[]> {
  const results = await Promise.all(offsets.map((i) => fetchScheduleDay(dayIso(i))));
  return results.flat();
}

// ── Internal event shape (raw, before filtering) ─────────────────────────────

interface InternalEvent {
  external_id: string;
  ts: number;
  date: string;
  hour_utc: number | "";
  p1: string; p1_team: string;
  p2: string; p2_team: string;
  s1: number | null;
  s2: number | null;
  status: string;
  division: string;
}

/** Ended game — structurally compatible with RawGame (for buildWalkforward) plus extras. */
interface H2HGame {
  external_id: string;
  ts: number;
  date: string;
  hour_utc: number | "";
  hp: string; ht: string;
  ap: string; at: string;
  hs: number; as_: number;
  division: string;
}

function numF(v: unknown): number | "" {
  if (v == null) return "";
  const n = parseFloat(String(v));
  return isNaN(n) ? "" : Math.round(n * 100) / 100;
}

function numFStr(v: unknown): string {
  const r = numF(v);
  return r === "" ? "" : String(r);
}

function parseEvent(ev: unknown): InternalEvent | null {
  const e = ev as Record<string, unknown>;
  const a = e.participantAName as string | undefined;
  const b = e.participantBName as string | undefined;
  if (!a || !b) return null;

  let ts = 0, date = "", hour_utc: number | "" = "";
  const sd = e.startDate as string | undefined;
  if (sd) {
    try {
      const dt = new Date(sd);
      if (!isNaN(dt.getTime())) {
        ts = Math.floor(dt.getTime() / 1000);
        date = dt.toISOString().slice(0, 10);
        hour_utc = dt.getUTCHours();
      }
    } catch (_) { /* ignore malformed dates */ }
  }

  return {
    external_id: String(e.externalId ?? ""),
    ts, date, hour_utc,
    p1: a, p1_team: String(e.teamAName ?? ""),
    p2: b, p2_team: String(e.teamBName ?? ""),
    s1: typeof e.teamAScore === "number" ? e.teamAScore : null,
    s2: typeof e.teamBScore === "number" ? e.teamBScore : null,
    status: String(e.matchStatus ?? ""),
    division: String(e.streamName || e.tournamentName || ""),
  };
}

function endedGames(events: unknown[]): H2HGame[] {
  const games: H2HGame[] = [];
  for (const ev of events) {
    const e = parseEvent(ev);
    if (!e || e.status !== "MATCH_ENDED" || e.s1 === null || e.s2 === null) continue;
    games.push({
      external_id: e.external_id,
      ts: e.ts, date: e.date, hour_utc: e.hour_utc,
      hp: e.p1, ht: e.p1_team,
      ap: e.p2, at: e.p2_team,
      hs: e.s1, as_: e.s2,
      division: e.division,
    });
  }
  return games.sort((a, b) => a.ts - b.ts || a.external_id.localeCompare(b.external_id));
}

function buildH2HMatches(games: H2HGame[]): MatchRow[] {
  return games.map((g) => ({
    date: g.date, player1: g.hp, player2: g.ap,
    score1: g.hs, score2: g.as_, total: g.hs + g.as_, division: g.division,
  }));
}

function buildTeamMap(games: H2HGame[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const g of games) {
    const add = (name: string, team: string) => {
      if (!team) return;
      const key = name.toLowerCase();
      if (!counts.has(key)) counts.set(key, new Map());
      const m = counts.get(key)!;
      m.set(team, (m.get(team) ?? 0) + 1);
    };
    add(g.hp, g.ht);
    add(g.ap, g.at);
  }
  const result = new Map<string, string>();
  for (const [player, teamCounts] of counts) {
    let best = "", max = 0;
    for (const [t, c] of teamCounts) if (c > max) { max = c; best = t; }
    result.set(player, best);
  }
  return result;
}

function participantsToPlayerRows(
  participants: unknown[],
  teamMap: Map<string, string>,
  minGp = 1,
): PlayerRow[] {
  const rows: PlayerRow[] = [];
  for (const p of participants) {
    const pr = p as Record<string, unknown>;
    const name = String(pr.participantName ?? "");
    if (!name) continue;
    const won = parseInt(String(pr.matchesWon ?? 0), 10) || 0;
    const lost = parseInt(String(pr.matchesLost ?? 0), 10) || 0;
    const gp = won + lost;
    if (gp < minGp) continue;
    const formArr = Array.isArray(pr.matchForm) ? pr.matchForm : [];
    const recent_form = formArr
      .slice(0, 5)
      .map((c: unknown) => String(c).toUpperCase())
      .join("");
    const wp = numF(pr.matchesWinPct);
    const ppm = numF(pr.avgPoints);
    rows.push({
      name,
      win_pct: typeof wp === "number" ? wp : 0,
      pts_per_match: typeof ppm === "number" ? ppm : 0,
      fg_pct: numFStr(pr.avgFieldGoalsPercent),
      steals: numFStr(pr.avgSteals),
      fouls: numFStr(pr.avgTeamFouls),
      gp, w: won, l: lost,
      recent_form,
      nba_team: teamMap.get(name.toLowerCase()) ?? "",
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Score prediction band ────────────────────────────────────────────────────

interface ScoreBand {
  mean: number; std: number; low: number; high: number;
  confidence: number; n: number;
}

function scoreBand(scores: number[]): ScoreBand | null {
  if (scores.length < 3) return null;
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const low = mean - 0.5 * std;
  const high = mean + 0.5 * std;
  const inBand = scores.filter((s) => s >= low && s <= high).length;
  return {
    mean: Math.round(mean * 10) / 10,
    std: Math.round(std * 10) / 10,
    low: Math.round(low * 10) / 10,
    high: Math.round(high * 10) / 10,
    confidence: Math.round((inBand / n) * 1000) / 10,
    n,
  };
}

// ── In-memory H2H computation ─────────────────────────────────────────────────

function computeH2H(games: H2HGame[], p1: string, p2: string, limit = 20) {
  const lp1 = p1.toLowerCase(), lp2 = p2.toLowerCase();
  const h2hGames = games
    .filter(
      (g) =>
        (g.hp.toLowerCase() === lp1 && g.ap.toLowerCase() === lp2) ||
        (g.hp.toLowerCase() === lp2 && g.ap.toLowerCase() === lp1),
    )
    .sort((a, b) => b.ts - a.ts);

  const total = h2hGames.length;
  let p1Wins = 0, scoreSum = 0;
  for (const g of h2hGames) {
    const p1IsA = g.hp.toLowerCase() === lp1;
    if (p1IsA ? g.hs > g.as_ : g.as_ > g.hs) p1Wins++;
    scoreSum += g.hs + g.as_;
  }

  const recent = h2hGames.slice(0, limit).map((g) => {
    const p1IsA = g.hp.toLowerCase() === lp1;
    const p1Score = p1IsA ? g.hs : g.as_;
    const p2Score = p1IsA ? g.as_ : g.hs;
    return {
      date: g.date, hour_utc: g.hour_utc,
      p1_score: p1Score, p2_score: p2Score,
      total: g.hs + g.as_, division: g.division,
      winner: p1Score > p2Score ? p1 : p2,
    };
  });

  return {
    p1, p2, total,
    p1_wins: p1Wins, p2_wins: total - p1Wins,
    p1_win_pct: total ? Math.round((p1Wins / total) * 1000) / 10 : null,
    avg_total: total > 0 ? Math.round((scoreSum / total) * 10) / 10 : null,
    recent,
  };
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface ScheduleRow {
  external_id: string;
  date: string;
  hour_utc: number | "";
  player1: string; player2: string;
  p1_team: string; p2_team: string;
  status: string;
  division: string;
}

export interface UpcomingFeedResponse {
  upcoming: unknown[];
  meta: Record<string, unknown>;
}

// ── Exported main functions ──────────────────────────────────────────────────

export async function buildFeedDirect(days: number, minGp: number): Promise<FeedResponse> {
  const d = Math.min(Math.max(days, 1), 90);
  const g = Math.max(minGp, 1);

  const [participants, events] = await Promise.all([
    fetchParticipants(),
    fetchDays(Array.from({ length: d }, (_, i) => -i)),
  ]);

  const games = endedGames(events);
  const teamMap = buildTeamMap(games);
  const players = participantsToPlayerRows(participants, teamMap, g);
  const walkforward = buildWalkforward(games as unknown as RawGame[]);
  const matches = buildH2HMatches(games);

  return {
    walkforward,
    players,
    matches,
    meta: {
      source: "h2hggl-direct",
      games: games.length,
      days: d,
      minGp: g,
      participants: participants.length,
      fetched: new Date().toISOString(),
    },
  };
}

/** Fetch upcoming fixtures (today + next `days-1` days). */
export async function fetchScheduleDirect(days: number): Promise<ScheduleRow[]> {
  const clamp = Math.min(Math.max(days, 1), 14);
  const events = await fetchDays(Array.from({ length: clamp }, (_, i) => i));
  const rows: ScheduleRow[] = [];
  for (const ev of events) {
    const e = parseEvent(ev);
    if (!e || e.status === "MATCH_ENDED") continue;
    rows.push({
      external_id: e.external_id,
      date: e.date, hour_utc: e.hour_utc,
      player1: e.p1, player2: e.p2,
      p1_team: e.p1_team, p2_team: e.p2_team,
      status: e.status, division: e.division,
    });
  }
  return rows;
}

/** Build rich upcoming-feed cards with H2H analysis computed in-memory. */
export async function buildUpcomingFeedDirect(
  daysFeed: number,
  daysHistory: number,
): Promise<UpcomingFeedResponse> {
  const df = Math.min(Math.max(daysFeed, 1), 14);
  const dh = Math.min(Math.max(daysHistory, 7), 90);

  const [participants, upcomingEvents, historyEvents] = await Promise.all([
    fetchParticipants(),
    fetchDays(Array.from({ length: df }, (_, i) => i)),
    fetchDays(Array.from({ length: dh }, (_, i) => -i)),
  ]);

  const schedule: ScheduleRow[] = [];
  for (const ev of upcomingEvents) {
    const e = parseEvent(ev);
    if (!e || e.status === "MATCH_ENDED") continue;
    schedule.push({
      external_id: e.external_id,
      date: e.date, hour_utc: e.hour_utc,
      player1: e.p1, player2: e.p2,
      p1_team: e.p1_team, p2_team: e.p2_team,
      status: e.status, division: e.division,
    });
  }

  const historyGames = endedGames(historyEvents);
  const teamMap = buildTeamMap(historyGames);
  const playerRows = participantsToPlayerRows(participants, teamMap, 1);
  const playerLookup = new Map<string, PlayerRow>(
    playerRows.map((p) => [p.name.toUpperCase(), p]),
  );

  function playerCard(row: PlayerRow | undefined) {
    if (!row) return null;
    return {
      win_pct: typeof row.win_pct === "number" ? row.win_pct : null,
      pts_per_match: typeof row.pts_per_match === "number" ? row.pts_per_match : null,
      gp: row.gp,
      recent_form: row.recent_form,
    };
  }

  const upcoming = schedule.map((fixture) => {
    const p1 = fixture.player1, p2 = fixture.player2;
    const p1Card = playerCard(playerLookup.get(p1.toUpperCase()));
    const p2Card = playerCard(playerLookup.get(p2.toUpperCase()));
    const h2h = computeH2H(historyGames, p1, p2, 50);

    const totals = h2h.recent.map((r) => r.total);
    const p1Scores = h2h.recent.map((r) => r.p1_score);
    const p2Scores = h2h.recent.map((r) => r.p2_score);

    const scoreBands =
      totals.length >= 3
        ? { total: scoreBand(totals), p1: scoreBand(p1Scores), p2: scoreBand(p2Scores) }
        : null;

    const p1Ppm = p1Card?.pts_per_match ?? null;
    const p2Ppm = p2Card?.pts_per_match ?? null;
    const ppmTotal =
      p1Ppm !== null && p2Ppm !== null
        ? Math.round((p1Ppm + p2Ppm) * 10) / 10
        : null;
    const vsDiff =
      ppmTotal !== null && h2h.avg_total !== null
        ? Math.round((ppmTotal - h2h.avg_total) * 10) / 10
        : null;

    const wp1 = p1Card?.win_pct ?? null, wp2 = p2Card?.win_pct ?? null;

    return {
      external_id: fixture.external_id,
      date: fixture.date, hour_utc: fixture.hour_utc,
      player1: p1, player2: p2,
      p1_team: fixture.p1_team, p2_team: fixture.p2_team,
      division: fixture.division,
      p1_stats: p1Card, p2_stats: p2Card,
      h2h: {
        total_games: h2h.total,
        p1_wins: h2h.p1_wins, p2_wins: h2h.p2_wins,
        avg_total: h2h.avg_total,
        recent: h2h.recent,
      },
      analysis: {
        score_bands: scoreBands,
        ppm_model: {
          total: ppmTotal,
          p1: p1Ppm !== null ? Math.round(p1Ppm * 10) / 10 : null,
          p2: p2Ppm !== null ? Math.round(p2Ppm * 10) / 10 : null,
          vs_h2h_diff: vsDiff,
        },
        win_edge: {
          favored:
            wp1 !== null && wp2 !== null ? (wp1 >= wp2 ? p1 : p2) : null,
          edge_pct:
            wp1 !== null && wp2 !== null
              ? Math.round(Math.abs(wp1 - wp2) * 10) / 10
              : null,
        },
      },
    };
  });

  return {
    upcoming,
    meta: {
      source: "h2hggl-direct",
      count: upcoming.length,
      days_schedule: df,
      days_history: dh,
      fetched: new Date().toISOString(),
    },
  };
}
