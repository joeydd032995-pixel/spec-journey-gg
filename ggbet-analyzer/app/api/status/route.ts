import { NextResponse } from "next/server";
import { isDefaultUrl } from "@/lib/h2hggl";

/* Lightweight config probe for the Settings view: which data-source mode the
   deployment is in, and whether a server-side Anthropic key is configured.
   Never returns the values themselves. */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    dataSource: isDefaultUrl() ? "direct" : "scraper",
    scraperUrl: isDefaultUrl() ? null : (process.env.H2HGGL_API_URL ?? null),
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    betsapiConfigured: Boolean(process.env.BETSAPI_TOKEN),
  });
}
