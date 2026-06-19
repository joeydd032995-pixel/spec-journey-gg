/**
 * lib/h2hggl.ts
 * Server-side proxy to the self-hosted H2H GG League scraper service
 * (see /scraper). Free data acquisition — no paid provider, no API key.
 *
 * The scraper exposes a `/api/feed` endpoint that already returns the exact
 * { walkforward, players, matches, meta } shape GGBetAnalyzer consumes, with
 * the FG%/steals/fouls/division that the BetsAPI feed left blank now filled in.
 *
 * Reuses the WFRow / PlayerRow / MatchRow shapes from lib/betsapi.ts.
 */

import type { WFRow, PlayerRow, MatchRow } from "./betsapi";

export const DEFAULT_H2HGGL_URL = "http://localhost:8000";

export interface FeedResponse {
  walkforward: WFRow[];
  players: PlayerRow[];
  matches: MatchRow[];
  meta: Record<string, unknown>;
}

function baseUrl(): string {
  return (process.env.H2HGGL_API_URL || DEFAULT_H2HGGL_URL).replace(/\/+$/, "");
}

export function isDefaultUrl(): boolean {
  const raw = process.env.H2HGGL_API_URL?.trim();
  if (!raw) return true;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function getJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "GGBetAnalyzer/1.0" },
      // Cache parity with the BetsAPI client.
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`H2HGGL service ${res.status} on ${path}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the normalized feed for the last `days` days. */
export async function fetchFeed(days: number, minGp: number): Promise<FeedResponse> {
  if (isDefaultUrl()) {
    const { buildFeedDirect } = await import("./h2hggl-direct");
    return buildFeedDirect(days, minGp);
  }
  const d = Math.min(Math.max(days, 1), 90);
  const g = Math.max(minGp, 1);
  return (await getJson(`/api/feed?days=${d}&minGp=${g}`)) as FeedResponse;
}

/** Fetch upcoming fixtures for the slate view. */
export async function fetchUpcoming(days = 2): Promise<
  Array<{ time: string; home: string; away: string }>
> {
  if (isDefaultUrl()) {
    const { fetchScheduleDirect } = await import("./h2hggl-direct");
    const rows = await fetchScheduleDirect(days);
    return rows.map((r) => ({
      time: `${r.date}${r.hour_utc !== "" ? ` ${String(r.hour_utc).padStart(2, "0")}:00 UTC` : ""}`,
      home: `${r.p1_team} (${r.player1})`,
      away: `${r.p2_team} (${r.player2})`,
    }));
  }
  const rows = (await getJson(`/api/schedule?days=${days}`)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    time: `${r.date ?? ""}${r.hour_utc !== "" && r.hour_utc != null ? ` ${String(r.hour_utc).padStart(2, "0")}:00 UTC` : ""}`,
    home: `${r.p1_team ?? ""} (${r.player1 ?? ""})`,
    away: `${r.p2_team ?? ""} (${r.player2 ?? ""})`,
  }));
}
