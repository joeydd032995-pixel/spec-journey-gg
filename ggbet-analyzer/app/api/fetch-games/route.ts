/**
 * app/api/fetch-games/route.ts
 *
 * POST /api/fetch-games
 * Body: { days?: number; leagueId?: number; minGp?: number }
 *
 * Calls BetsAPI server-side (BETSAPI_TOKEN env var), builds walk-forward
 * snapshots, and returns all three data sets needed by GGBetAnalyzer:
 *   - walkforward  (WF rows for the model + backtest)
 *   - players      (full-sample roster for Data Manager)
 *   - matches      (flat results for h2h + in-sample probe)
 *
 * The token never leaves the server.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  BetsAPIClient,
  buildWalkforward,
  aggregatePlayers,
  buildMatches,
  DEFAULT_LEAGUE_ID,
} from "@/lib/betsapi";

export const maxDuration = 60; // Vercel Pro: up to 60s; Hobby: 10s (use fewer days)

export async function POST(req: NextRequest) {
  const token = process.env.BETSAPI_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "BETSAPI_TOKEN not configured. Add it to your Vercel environment variables." },
      { status: 500 }
    );
  }

  let body: { days?: unknown; leagueId?: unknown; minGp?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const days    = Math.min(Math.max(parseInt(String(body.days    ?? 7),  10), 1), 90);
  const leagueId = parseInt(String(body.leagueId ?? DEFAULT_LEAGUE_ID), 10);
  const minGp   = Math.max(parseInt(String(body.minGp ?? 1), 10), 1);

  try {
    const client = new BetsAPIClient(token);
    const games  = await client.fetchGames(leagueId, days);

    if (!games.length) {
      return NextResponse.json({
        walkforward: [], players: [], matches: [],
        meta: { games: 0, days, leagueId, message: "No ended events found for this range." },
      });
    }

    const walkforward = buildWalkforward(games);
    const players     = aggregatePlayers(games, minGp);
    const matches     = buildMatches(games);

    return NextResponse.json({
      walkforward,
      players,
      matches,
      meta: { games: games.length, days, leagueId, minGp, fetched: new Date().toISOString() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Also support GET with query params (handy for quick browser testing)
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const days     = parseInt(searchParams.get("days")     ?? "7",  10);
  const leagueId = parseInt(searchParams.get("leagueId") ?? String(DEFAULT_LEAGUE_ID), 10);
  const minGp    = parseInt(searchParams.get("minGp")    ?? "1",  10);
  return POST(
    new NextRequest(req.url, {
      method: "POST",
      body: JSON.stringify({ days, leagueId, minGp }),
      headers: { "Content-Type": "application/json" },
    })
  );
}
