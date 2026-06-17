/**
 * lib/betsapi.ts
 * TypeScript port of ggba_betsapi.py — server-side only.
 * Runs inside Next.js API routes (Node.js runtime), never in the browser.
 */

export const HOSTS = ["https://api.b365api.com", "https://api.betsapi.com"] as const;
export const DEFAULT_LEAGUE_ID = 25067; // Ebasketball H2H GG League - 4x5mins
export const DEFAULT_SPORT_ID  = 18;    // Basketball
export const PER_PAGE = 50;
export const MAX_PAGES = 100;
export const POLITE_DELAY_MS = 400;

// "DEN Nuggets (LANES)" → { player: "LANES", team: "DEN Nuggets" }
const NAME_RE = /^\s*(.*?)\s*\(([^()]+)\)\s*$/;

export function splitName(raw: string): { player: string; team: string } {
  if (!raw) return { player: "", team: "" };
  const m = raw.match(NAME_RE);
  if (m) return { player: m[2].trim(), team: m[1].trim() };
  return { player: raw.trim(), team: "" };
}

// "62-66" → [62, 66] | null
export function parseScore(ss: string | undefined): [number, number] | null {
  if (!ss || !ss.includes("-")) return null;
  const [a, b] = ss.split("-");
  const ha = parseInt(a, 10), hb = parseInt(b, 10);
  if (isNaN(ha) || isNaN(hb)) return null;
  return [ha, hb];
}

export interface RawGame {
  ts: number;
  date: string;
  hour_utc: number | string;
  hp: string; ht: string;   // home player, home team
  ap: string; at: string;   // away player, away team
  hs: number; as_: number;  // home score, away score
}

export interface WFRow {
  date: string;
  player1: string; player2: string;
  p1_team: string; p2_team: string;
  p1_win_pct: number | string; p1_ppm: number | string; p1_form: string; p1_gp: number;
  p2_win_pct: number | string; p2_ppm: number | string; p2_form: string; p2_gp: number;
  score1: number; score2: number; actual_total: number; hour_utc: number | string;
}

export interface PlayerRow {
  name: string; win_pct: number; pts_per_match: number;
  fg_pct: string; steals: string; fouls: string;
  gp: number; w: number; l: number; recent_form: string; nba_team: string;
}

export interface MatchRow {
  date: string; player1: string; player2: string;
  score1: number; score2: number; total: number; division: string;
}

// --------------------------------------------------------------------------- //
// Per-player accumulator                                                       //
// --------------------------------------------------------------------------- //
class PlayerAgg {
  name: string; gp = 0; w = 0; l = 0; pts = 0;
  teams: Map<string, number> = new Map();
  history: Array<[number, "W" | "L"]> = [];

  constructor(name: string) { this.name = name; }

  add(ts: number, team: string, scored: number, won: boolean) {
    this.gp++; this.pts += scored;
    if (won) this.w++; else this.l++;
    if (team) this.teams.set(team, (this.teams.get(team) ?? 0) + 1);
    this.history.push([ts, won ? "W" : "L"]);
  }

  recentForm(n = 5): string {
    return [...this.history]
      .sort((a, b) => b[0] - a[0])
      .slice(0, n)
      .map((h) => h[1])
      .join("");
  }

  modalTeam(): string {
    let best = ""; let count = 0;
    this.teams.forEach((c, t) => { if (c > count) { count = c; best = t; } });
    return best;
  }

  toPlayerRow(): PlayerRow {
    return {
      name: this.name,
      win_pct: this.gp ? +((this.w / this.gp) * 100).toFixed(1) : 0,
      pts_per_match: this.gp ? +(this.pts / this.gp).toFixed(1) : 0,
      fg_pct: "", steals: "", fouls: "",          // not in esports feed
      gp: this.gp, w: this.w, l: this.l,
      recent_form: this.recentForm(),
      nba_team: this.modalTeam(),
    };
  }
}

// --------------------------------------------------------------------------- //
// Build walk-forward rows (chronological, pre-match snapshots, leakage-free) //
// --------------------------------------------------------------------------- //
export function buildWalkforward(games: RawGame[]): WFRow[] {
  const state = new Map<string, PlayerAgg>();

  function snap(name: string) {
    const p = state.get(name);
    if (!p || p.gp === 0) return { win_pct: "" as const, ppm: "" as const, form: "", gp: 0 };
    return {
      win_pct: +((p.w / p.gp) * 100).toFixed(1),
      ppm: +(p.pts / p.gp).toFixed(1),
      form: p.recentForm(),
      gp: p.gp,
    };
  }

  const rows: WFRow[] = [];
  for (const g of games) {
    const s1 = snap(g.hp), s2 = snap(g.ap);
    rows.push({
      date: g.date, player1: g.hp, player2: g.ap,
      p1_team: g.ht, p2_team: g.at,
      p1_win_pct: s1.win_pct, p1_ppm: s1.ppm, p1_form: s1.form, p1_gp: s1.gp,
      p2_win_pct: s2.win_pct, p2_ppm: s2.ppm, p2_form: s2.form, p2_gp: s2.gp,
      score1: g.hs, score2: g.as_, actual_total: g.hs + g.as_, hour_utc: g.hour_utc,
    });
    // update AFTER snapshot (leakage-free)
    if (!state.has(g.hp)) state.set(g.hp, new PlayerAgg(g.hp));
    if (!state.has(g.ap)) state.set(g.ap, new PlayerAgg(g.ap));
    state.get(g.hp)!.add(g.ts, g.ht, g.hs, g.hs > g.as_);
    state.get(g.ap)!.add(g.ts, g.at, g.as_, g.as_ > g.hs);
  }
  return rows;
}

export function aggregatePlayers(games: RawGame[], minGp = 1): PlayerRow[] {
  const players = new Map<string, PlayerAgg>();
  for (const g of games) {
    if (!players.has(g.hp)) players.set(g.hp, new PlayerAgg(g.hp));
    if (!players.has(g.ap)) players.set(g.ap, new PlayerAgg(g.ap));
    players.get(g.hp)!.add(g.ts, g.ht, g.hs, g.hs > g.as_);
    players.get(g.ap)!.add(g.ts, g.at, g.as_, g.as_ > g.hs);
  }
  return [...players.values()]
    .filter((p) => p.gp >= minGp)
    .map((p) => p.toPlayerRow())
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildMatches(games: RawGame[]): MatchRow[] {
  return games.map((g) => ({
    date: g.date, player1: g.hp, player2: g.ap,
    score1: g.hs, score2: g.as_, total: g.hs + g.as_, division: "",
  }));
}

// --------------------------------------------------------------------------- //
// BetsAPI HTTP client (server-side — never runs in browser)                   //
// --------------------------------------------------------------------------- //
export class BetsAPIClient {
  private hostIdx = 0;

  constructor(
    private token: string,
    private sportId = DEFAULT_SPORT_ID,
  ) {
    if (!token) throw new Error("BETSAPI_TOKEN is required");
  }

  private get host() { return HOSTS[this.hostIdx % HOSTS.length]; }

  private async get(path: string, params: Record<string, string | number>): Promise<unknown> {
    const url = new URL(`${this.host}${path}`);
    url.searchParams.set("token", this.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          headers: { Accept: "application/json", "User-Agent": "GGBetAnalyzer/1.0" },
          // Next.js fetch cache: revalidate every 5 min
          next: { revalidate: 300 },
        });

        if (res.status === 429 || res.status >= 500) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }

        const data = await res.json();
        if (!data?.success) throw new Error(`BetsAPI error on ${path}: ${JSON.stringify(data).slice(0, 200)}`);
        await sleep(POLITE_DELAY_MS);
        return data;
      } catch (e) {
        if (attempt === 3) throw e;
        this.hostIdx++;
        await sleep(1500 * attempt);
      }
    }
    throw new Error(`Failed ${path} after 3 retries`);
  }

  async *paged(path: string, params: Record<string, string | number>): AsyncGenerator<unknown> {
    let page = 1;
    while (page <= MAX_PAGES) {
      const data = await this.get(path, { ...params, page }) as Record<string, unknown>;
      const results = (data.results as unknown[]) ?? [];
      for (const r of results) yield r;
      const pager = (data.pager as Record<string, unknown>) ?? {};
      const total = parseInt(String(pager.total ?? 0), 10);
      const per = parseInt(String(pager.per_page ?? PER_PAGE), 10) || PER_PAGE;
      if (results.length < per || page * per >= total) break;
      page++;
    }
  }

  /** Fetch ended events for the last `days` days. Returns chronologically sorted RawGames. */
  async fetchGames(leagueId: number, days: number): Promise<RawGame[]> {
    const games: RawGame[] = [];
    const today = new Date();
    for (let d = 0; d < days; d++) {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - d);
      const day = date.toISOString().slice(0, 10).replace(/-/g, "");
      for await (const ev of this.paged("/v3/events/ended", {
        sport_id: this.sportId, league_id: leagueId, day,
      })) {
        const e = ev as Record<string, unknown>;
        const score = parseScore((e.ss as string) ?? "");
        const homeRaw = ((e.home as Record<string, unknown>)?.name as string) ?? "";
        const awayRaw = ((e.away as Record<string, unknown>)?.name as string) ?? "";
        if (!score || !homeRaw || !awayRaw) continue;
        const ts = parseInt(String(e.time ?? 0), 10);
        const [hs, as_] = score;
        const { player: hp, team: ht } = splitName(homeRaw);
        const { player: ap, team: at } = splitName(awayRaw);
        games.push({
          ts, date: ts ? isoDate(ts) : day.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"),
          hour_utc: ts ? new Date(ts * 1000).getUTCHours() : "",
          hp, ht, ap, at, hs, as_,
        });
      }
    }
    games.sort((a, b) => a.ts - b.ts);
    return games;
  }

  /** Fetch upcoming/live games (for the slate view). */
  async fetchUpcoming(leagueId: number): Promise<Array<{ time: string; home: string; away: string }>> {
    const out: Array<{ time: string; home: string; away: string }> = [];
    for await (const ev of this.paged("/v3/events/upcoming", {
      sport_id: this.sportId, league_id: leagueId,
    })) {
      const e = ev as Record<string, unknown>;
      const homeRaw = ((e.home as Record<string, unknown>)?.name as string) ?? "";
      const awayRaw = ((e.away as Record<string, unknown>)?.name as string) ?? "";
      const ts = parseInt(String(e.time ?? 0), 10);
      out.push({
        time: ts ? new Date(ts * 1000).toUTCString() : "—",
        home: homeRaw, away: awayRaw,
      });
    }
    return out;
  }
}

function isoDate(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
