// @vitest-environment jsdom
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import BetLogger from "@/components/views/BetLogger";
import UpcomingGamesFeed from "@/components/views/UpcomingGames";
import Analyzer from "@/components/views/Analyzer";
import Settings from "@/components/views/Settings";
import { DEFAULT_SETTINGS, type Bet, type Player } from "@/lib/model";
import type { UpcomingGame } from "@/lib/upcoming";

function mkBet(over: Partial<Bet> = {}): Bet {
  return {
    id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    matchup: "A vs B", bet_type: "Total", line: "Over 130.5",
    proj_value: 133, model_prob: 58.1, odds: -110,
    close_side: "", close_other: "", stake: "", outcome: "Pending", profit: 0,
    ...over,
  };
}

function mkPlayer(name: string, over: Partial<Player> = {}): Player {
  return { name, win_pct: 55, pts_per_match: 68, fg_pct: 50, steals: 2, fouls: 3, gp: 60, recent_form: "WWLWL", ...over };
}

/* ResizeObserver stub for recharts ResponsiveContainer */
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = RO;

describe("BetLogger", () => {
  function Harness({ initial }: { initial: Bet[] }) {
    const [bets, setBets] = useState(initial);
    return <BetLogger bets={bets} setBets={setBets} />;
  }

  it("shows the empty state without bets", () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText("No bets yet")).toBeInTheDocument();
  });

  it("settles a win with payout math and moves it to Settled", () => {
    render(<Harness initial={[mkBet({ stake: 10, odds: -110 })]} />);
    expect(screen.getByText(/Open · 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Win"));
    const settled = screen.getByText(/Settled · 1/).closest("div")!.parentElement!;
    expect(within(settled as HTMLElement).getByText("Win")).toBeInTheDocument();
    // -110 stake 10 -> profit +9.09
    expect(screen.getByText("+9.09")).toBeInTheDocument();
  });

  it("settles a loss as negative stake", () => {
    render(<Harness initial={[mkBet({ stake: 5 })]} />);
    fireEvent.click(screen.getByTitle("Loss"));
    expect(screen.getByText("-5.00")).toBeInTheDocument();
  });

  it("computes CLV from the entered closing line", () => {
    // took +110; close -110/-110 -> fair 50% -> CLV +5.0%
    render(<Harness initial={[mkBet({ odds: 110, close_side: -110, close_other: -110 })]} />);
    expect(screen.getByText("+5.0%")).toBeInTheDocument();
  });

  it("deletes a bet", () => {
    render(<Harness initial={[mkBet()]} />);
    fireEvent.click(screen.getByTitle("Delete bet"));
    expect(screen.getByText("No bets yet")).toBeInTheDocument();
  });
});

describe("UpcomingGamesFeed", () => {
  const game: UpcomingGame = {
    external_id: "g1", date: "2026-07-01", hour_utc: 18, minute_utc: 30,
    player1: "ALPHA", player2: "BRAVO", p1_team: "LAL", p2_team: "BOS", division: "D1",
    p1_stats: { win_pct: 61.2, pts_per_match: 67.4, gp: 88, recent_form: "WWLWW" },
    p2_stats: { win_pct: 44.0, pts_per_match: 61.0, gp: 40, recent_form: "LLWLL" },
    h2h: { total_games: 5, p1_wins: 3, p2_wins: 2, avg_total: 128.4, recent: [] },
    analysis: { score_bands: null, ppm_model: null, win_edge: { favored: "ALPHA", edge_pct: 8.3 } },
  };

  it("renders games with edge badge and expands H2H", () => {
    render(<UpcomingGamesFeed upcoming={[game]} loading={false} error={null} onRefresh={() => {}} />);
    expect(screen.getByText("ALPHA")).toBeInTheDocument();
    expect(screen.getByText(/ALPHA edge \+8.3%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /H2H/ }));
    expect(screen.getByText("Head-to-head record")).toBeInTheDocument();
    expect(screen.getByText("128.4")).toBeInTheDocument();
  });

  it("shows the error banner and empty state", () => {
    const { rerender } = render(<UpcomingGamesFeed upcoming={[]} loading={false} error="HTTP 502" onRefresh={() => {}} />);
    expect(screen.getByText(/HTTP 502/)).toBeInTheDocument();
    rerender(<UpcomingGamesFeed upcoming={[]} loading={false} error={null} onRefresh={() => {}} />);
    expect(screen.getByText("No upcoming games found")).toBeInTheDocument();
  });

  it("refresh button calls onRefresh and disables while loading", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<UpcomingGamesFeed upcoming={[]} loading={false} error={null} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    rerender(<UpcomingGamesFeed upcoming={[]} loading={true} error={null} onRefresh={onRefresh} />);
    expect(screen.getByRole("button", { name: /Loading/ })).toBeDisabled();
  });
});

describe("Settings", () => {
  function stubFetch(routes: Record<string, unknown> = {}) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/status")) {
        return new Response(JSON.stringify({ dataSource: "direct", scraperUrl: null, aiConfigured: false, betsapiConfigured: false, ...(routes.status as object) }), { status: 200 });
      }
      if (url.includes("/api/assistant")) {
        const body = routes.assistant as { status?: number; json?: unknown } | undefined;
        return new Response(JSON.stringify(body?.json ?? { ok: true }), { status: body?.status ?? 200 });
      }
      return new Response("{}", { status: 200 });
    }));
  }

  it("saves the API key to localStorage and can remove it", async () => {
    localStorage.clear();
    stubFetch();
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: /Save key/ }));
    expect(JSON.parse(localStorage.getItem("ggba:anthropic_key")!)).toBe("sk-ant-test-123");
    expect(screen.getByText("Key saved to this browser.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    expect(JSON.parse(localStorage.getItem("ggba:anthropic_key")!)).toBe("");
    vi.unstubAllGlobals();
  });

  it("tests the key against the server and reports success", async () => {
    localStorage.clear();
    stubFetch({ assistant: { status: 200, json: { ok: true } } });
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: /Test key/ }));
    expect(await screen.findByText(/Key works/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("reports an invalid key", async () => {
    localStorage.clear();
    stubFetch({ assistant: { status: 401, json: { error: "Invalid API key." } } });
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-bad" } });
    fireEvent.click(screen.getByRole("button", { name: /Test key/ }));
    expect(await screen.findByText("Invalid API key.")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows the data-source mode from /api/status", async () => {
    localStorage.clear();
    stubFetch({ status: { dataSource: "scraper", scraperUrl: "https://scraper.example.com" } });
    render(<Settings />);
    expect(await screen.findByText("self-hosted scraper")).toBeInTheDocument();
    expect(screen.getByText(/scraper\.example\.com/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("Analyzer", () => {
  const players = [mkPlayer("ALPHA", { win_pct: 60 }), mkPlayer("BRAVO", { win_pct: 40, pts_per_match: 62 })];

  it("prompts for a matchup until two players are picked", () => {
    render(<Analyzer players={players} settings={{ ...DEFAULT_SETTINGS, modelMode: "baseline" }}
      lateNight={false} matches={[]} wf={[]} onLog={() => {}} />);
    expect(screen.getByText("Pick a matchup")).toBeInTheDocument();
  });

  it("projects a total and logs an Over bet with edge", () => {
    const onLog = vi.fn();
    render(<Analyzer players={players} settings={{ ...DEFAULT_SETTINGS, modelMode: "baseline" }}
      lateNight={false} matches={[]} wf={[]} onLog={onLog} />);

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "ALPHA" } });
    fireEvent.change(selects[1], { target: { value: "BRAVO" } });
    expect(screen.getByText("Projected total")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("130.5"), { target: { value: "125.5" } });
    const logButtons = screen.getAllByRole("button", { name: "Log" });
    fireEvent.click(logButtons[0]); // Over row
    expect(onLog).toHaveBeenCalledTimes(1);
    const bet = onLog.mock.calls[0][0] as Bet;
    expect(bet.bet_type).toBe("Total");
    expect(bet.line).toContain("Over 125.5");
    expect(bet.model_prob).toBeGreaterThan(0);
    expect(bet.outcome).toBe("Pending");
  });
});
