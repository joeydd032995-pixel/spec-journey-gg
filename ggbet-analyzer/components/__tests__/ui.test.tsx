// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Badge, Btn, Card, CardHeader, Empty, Field, FormDots, PlayerSelect, Stat, StatStrip } from "@/components/ui";
import type { Player } from "@/lib/model";

describe("ui atoms", () => {
  it("Card renders children", () => {
    render(<Card>hello</Card>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("CardHeader shows title, sub and actions", () => {
    render(<CardHeader title="Roster" sub="subtitle" actions={<button>act</button>} />);
    expect(screen.getByText("Roster")).toBeInTheDocument();
    expect(screen.getByText("subtitle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "act" })).toBeInTheDocument();
  });

  it("Badge renders each tone without crashing", () => {
    render(<>
      <Badge tone="pos">p</Badge><Badge tone="neg">n</Badge>
      <Badge tone="amber">a</Badge><Badge tone="blue">b</Badge><Badge>m</Badge>
    </>);
    ["p", "n", "a", "b", "m"].forEach((t) => expect(screen.getByText(t)).toBeInTheDocument());
  });

  it("Btn fires onClick and respects disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Btn onClick={onClick}>Go</Btn>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Btn onClick={onClick} disabled>Go</Btn>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Field propagates typed values", () => {
    const onChange = vi.fn();
    render(<Field label="Win %" value="" onChange={onChange} placeholder="0-100" />);
    fireEvent.change(screen.getByPlaceholderText("0-100"), { target: { value: "55" } });
    expect(onChange).toHaveBeenCalledWith("55");
    expect(screen.getByText("Win %")).toBeInTheDocument();
  });

  it("PlayerSelect lists players and reports selection", () => {
    const players = [{ name: "ALPHA" }, { name: "BRAVO" }] as Player[];
    const onChange = vi.fn();
    render(<PlayerSelect players={players} value="" onChange={onChange} label="Player 1" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "BRAVO" } });
    expect(onChange).toHaveBeenCalledWith("BRAVO");
    expect(screen.getByText("ALPHA")).toBeInTheDocument();
  });

  it("Stat renders label, value and sub", () => {
    render(<Stat label="ROI" value="+4.2%" sub="12 bets" />);
    expect(screen.getByText("ROI")).toBeInTheDocument();
    expect(screen.getByText("+4.2%")).toBeInTheDocument();
    expect(screen.getByText("12 bets")).toBeInTheDocument();
  });

  it("StatStrip renders all children", () => {
    render(<StatStrip><Stat label="A" value="1" /><Stat label="B" value="2" /></StatStrip>);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("Empty shows title and body", () => {
    render(<Empty title="Nothing here" body="Add data first." />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Add data first.")).toBeInTheDocument();
  });

  it("FormDots renders W/L letters and dash fallback", () => {
    const { container, rerender } = render(<FormDots form="WWL" />);
    expect(container.textContent).toBe("WWL");
    rerender(<FormDots />);
    expect(container.textContent).toBe("—");
  });
});
