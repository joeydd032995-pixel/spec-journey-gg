/**
 * app/api/upcoming-feed/route.ts
 *
 * GET /api/upcoming-feed?days=2&history=60
 *
 * When no real scraper URL is configured (H2HGGL_API_URL unset or localhost),
 * builds the upcoming-feed card data directly from the h2hggl/hudstats API.
 * Otherwise proxies to the self-hosted scraper at {H2HGGL_API_URL}/api/upcoming-feed.
 *
 * Returns: { upcoming: UpcomingGame[], meta: { source, count, days_schedule, days_history, fetched } }
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

const DEFAULT_H2HGGL_URL = "http://localhost:8000";

function baseUrl(): string {
  return (process.env.H2HGGL_API_URL || DEFAULT_H2HGGL_URL).replace(/\/+$/, "");
}

function isDefaultUrl(): boolean {
  const u = process.env.H2HGGL_API_URL ?? "";
  return !u || u.includes("localhost");
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const days    = parseInt(searchParams.get("days")    ?? "2",  10);
  const history = parseInt(searchParams.get("history") ?? "60", 10);

  if (isDefaultUrl()) {
    try {
      const { buildUpcomingFeedDirect } = await import("@/lib/h2hggl-direct");
      const data = await buildUpcomingFeedDirect(days, history);
      return NextResponse.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const url = `${baseUrl()}/api/upcoming-feed?days=${encodeURIComponent(String(days))}&history=${encodeURIComponent(String(history))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "GGBetAnalyzer/1.0" },
      next: { revalidate: 0 },
    } as RequestInit);

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
