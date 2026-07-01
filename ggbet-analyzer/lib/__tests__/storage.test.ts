// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { loadKey, saveKey, STORAGE_KEYS } from "@/lib/storage";

describe("storage", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips values through localStorage", () => {
    saveKey("t:key", { a: 1, b: [2, 3] });
    expect(loadKey("t:key", null)).toEqual({ a: 1, b: [2, 3] });
    expect(JSON.parse(localStorage.getItem("t:key")!)).toEqual({ a: 1, b: [2, 3] });
  });

  it("returns the fallback for missing keys", () => {
    expect(loadKey("t:absent", "fallback")).toBe("fallback");
    expect(loadKey("t:absent", [])).toEqual([]);
  });

  it("survives corrupted JSON by falling back", () => {
    localStorage.setItem("t:bad", "{not json");
    expect(loadKey("t:bad", "safe")).toBe("safe");
  });

  it("exports stable storage keys", () => {
    expect(STORAGE_KEYS.players).toBe("ggba:players");
    expect(STORAGE_KEYS.bets).toBe("ggba:bets");
    expect(STORAGE_KEYS.settings).toBe("ggba:settings");
    expect(STORAGE_KEYS.matches).toBe("ggba:matches");
    expect(STORAGE_KEYS.walkforward).toBe("ggba:walkforward");
  });
});
