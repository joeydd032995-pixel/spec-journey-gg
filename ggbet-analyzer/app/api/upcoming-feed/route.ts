/**
 * app/api/upcoming-feed/route.ts
 *
 * GET /api/upcoming-feed?days=2&history=60
 *
 * Proxies to the self-hosted H2H GG League scraper at {H2HGGL_API_URL}/api/upcoming-feed.
 * Returns the scraper's JSON unchanged:
 *   { upcoming: UpcomingGame[], meta: { source, count, days_schedule, days_history, fetched } }
 *
 * Responds with 502 if the scraper is unreachable.
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const DEFAULT_H2HGGL_URL = "http://localhost:8000";

function baseUrl(): string {
  return (process.env.H2HGGL_API_URL || DEFAULT_H2HGGL_URL).replace(/\/+$/, "");
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const days    = searchParams.get("days")    ?? "2";
  const history = searchParams.get("history") ?? "60";

  const url = `${baseUrl()}/api/upcoming-feed?days=${encodeURIComponent(days)}&history=${encodeURIComponent(history)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "GGBetAnalyzer/1.0" },
      next: { revalidate: 0 },
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `Scraper returned ${upstream.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error:
          `${message}. Is the scraper running and H2HGGL_API_URL set? ` +
          `See /scraper (uvicorn app.main:app or docker compose up).`,
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
