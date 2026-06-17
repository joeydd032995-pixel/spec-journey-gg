/**
 * app/api/upcoming/route.ts
 *
 * GET /api/upcoming[?source=h2hggl|betsapi][?leagueId=25067]
 *
 * Returns upcoming fixtures — useful for pre-game setup. Defaults to the free
 * self-hosted h2hggl scraper; BetsAPI is an optional fallback.
 */

import { NextRequest, NextResponse } from "next/server";
import { BetsAPIClient, DEFAULT_LEAGUE_ID } from "@/lib/betsapi";
import { fetchUpcoming as fetchH2hgglUpcoming } from "@/lib/h2hggl";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const source = searchParams.get("source") ?? "h2hggl";

  if (source !== "h2hggl" && source !== "betsapi") {
    return NextResponse.json(
      { error: `Unknown source '${source}'. Use 'h2hggl' or 'betsapi'.` },
      { status: 400 },
    );
  }

  if (source === "h2hggl") {
    try {
      const upcoming = await fetchH2hgglUpcoming(2);
      return NextResponse.json({ upcoming, fetched: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const token = process.env.BETSAPI_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "BETSAPI_TOKEN not configured." }, { status: 500 });
  }
  const leagueIdRaw = Number.parseInt(searchParams.get("leagueId") ?? String(DEFAULT_LEAGUE_ID), 10);
  const leagueId = Number.isFinite(leagueIdRaw) ? leagueIdRaw : DEFAULT_LEAGUE_ID;
  try {
    const client   = new BetsAPIClient(token);
    const upcoming = await client.fetchUpcoming(leagueId);
    return NextResponse.json({ upcoming, fetched: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
