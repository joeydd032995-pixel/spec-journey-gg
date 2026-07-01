// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import GGBetAnalyzer from "@/components/GGBetAnalyzer";

class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as Record<string, unknown>).ResizeObserver = RO;

describe("app shell", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ upcoming: [] }), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("hydrates and shows the sidebar navigation", async () => {
    render(<GGBetAnalyzer />);
    expect(await screen.findByText("Analyzer")).toBeInTheDocument();
    ["Upcoming", "Bet Ledger", "Insights", "Data", "AI Analyst"].forEach((label) =>
      expect(screen.getByText(label)).toBeInTheDocument());
    // default view is the Analyzer's empty state prompt
    expect(screen.getByText(/Add at least 2 players/)).toBeInTheDocument();
  });

  it("navigates between views", async () => {
    render(<GGBetAnalyzer />);
    fireEvent.click(await screen.findByRole("button", { name: "Bet Ledger" }));
    expect(screen.getByText("No bets yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(screen.getByText("No players yet")).toBeInTheDocument();
  });

  it("restores persisted players from localStorage", async () => {
    localStorage.setItem("ggba:players", JSON.stringify([
      { name: "ZULU", win_pct: 50, pts_per_match: 60, fg_pct: 50, steals: 1, fouls: 1, gp: 30, recent_form: "WLWLW" },
      { name: "YANKEE", win_pct: 50, pts_per_match: 60, fg_pct: 50, steals: 1, fouls: 1, gp: 30, recent_form: "LWLWL" },
    ]));
    render(<GGBetAnalyzer />);
    fireEvent.click(await screen.findByRole("button", { name: "Data" }));
    // player names appear in the roster table and in the match-entry selects
    expect(screen.getAllByText("ZULU").length).toBeGreaterThan(0);
    expect(screen.getAllByText("YANKEE").length).toBeGreaterThan(0);
  });

  it("fetches the upcoming feed when that view opens", async () => {
    render(<GGBetAnalyzer />);
    fireEvent.click(await screen.findByRole("button", { name: "Upcoming" }));
    expect(await screen.findByText("No upcoming games found")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/upcoming-feed?days=2&history=60");
  });
});
