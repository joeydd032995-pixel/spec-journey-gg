/* localStorage-backed persistence (works on Vercel; falls back to in-memory
   when localStorage is unavailable, e.g. during SSR or in private modes). */

export const STORAGE_KEYS = {
  players: "ggba:players",
  matches: "ggba:matches",
  bets: "ggba:bets",
  settings: "ggba:settings",
  walkforward: "ggba:walkforward",
} as const;

const mem: Record<string, unknown> = {};

export function loadKey<T>(key: string, fallback: T): T {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const v = localStorage.getItem(key);
      return v != null ? (JSON.parse(v) as T) : fallback;
    }
  } catch {
    /* corrupted JSON or storage denied — fall through to memory */
  }
  return key in mem ? (mem[key] as T) : fallback;
}

export function saveKey(key: string, val: unknown): void {
  mem[key] = val;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      localStorage.setItem(key, JSON.stringify(val));
    }
  } catch {
    /* quota exceeded or storage denied — memory copy still holds */
  }
}
