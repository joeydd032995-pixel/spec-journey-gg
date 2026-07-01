import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

/* Server-side proxy for the AI Analyst chat. Keeps ANTHROPIC_API_KEY off the
   browser (the previous client-side call to api.anthropic.com could never
   succeed — no key, no anthropic-version header, and CORS forbids it). */

export const dynamic = "force-dynamic";

interface ChatMessage { role: "user" | "assistant"; content: string }

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "AI assistant is not configured. Set ANTHROPIC_API_KEY on the server." },
      { status: 503 },
    );
  }

  let body: { system?: string; messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = (body.messages || []).filter(
    (m): m is ChatMessage =>
      (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string" && m.content.length > 0,
  );
  if (!messages.length) {
    return NextResponse.json({ error: "No messages provided." }, { status: 400 });
  }

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: typeof body.system === "string" ? body.system : undefined,
      messages,
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return NextResponse.json({ text });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Rate limited — try again shortly." }, { status: 429 });
    }
    if (e instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Upstream error (${e.status}).` }, { status: 502 });
    }
    return NextResponse.json({ error: "Could not reach the model." }, { status: 502 });
  }
}
