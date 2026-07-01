/**
 * app/api/h2hggl-games/route.ts
 *
 * POST /api/h2hggl-games   Body: { days?: number; minGp?: number }
 * GET  /api/h2hggl-games?days=&minGp=
 *
 * Primary (free) data source. Proxies to the self-hosted scraper service
 * (H2HGGL_API_URL) and returns the same { walkforward, players, matches, meta }
 * shape as /api/fetch-games — so the frontend merge logic is reused unchanged.
 * Unlike the BetsAPI path, players come back with FG%/steals/fouls populated.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchFeed, isDefaultUrl } from "@/lib/h2hggl";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { days?: unknown; minGp?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const days  = Math.min(Math.max(parseInt(String(body.days  ?? 14), 10), 1), 90);
  const minGp = Math.max(parseInt(String(body.minGp ?? 1), 10), 1);

  try {
    const feed = await fetchFeed(days, minGp);
    return NextResponse.json(feed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = isDefaultUrl()
      ? "h2hggl.com's public API may be slow or briefly unavailable — try again."
      : "Is the scraper running and H2HGGL_API_URL correct? See /scraper.";
    return NextResponse.json({ error: `${message}. ${hint}` }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const days  = parseInt(searchParams.get("days")  ?? "14", 10);
  const minGp = parseInt(searchParams.get("minGp") ?? "1", 10);
  return POST(
    new NextRequest(req.url, {
      method: "POST",
      body: JSON.stringify({ days, minGp }),
      headers: { "Content-Type": "application/json" },
    })
  );
}
