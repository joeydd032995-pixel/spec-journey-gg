/* Types for the /api/upcoming-feed payload (scraper-driven schedule + analysis). */

export interface ScoreBand {
  mean: number; std: number; low: number; high: number;
  confidence: number; n: number;
}

export interface UpcomingGame {
  external_id: string; date: string; hour_utc: number; minute_utc?: number;
  player1: string; player2: string;
  p1_team: string; p2_team: string; division: string;
  p1_stats: { win_pct: number | null; pts_per_match: number | null; gp: number; recent_form: string } | null;
  p2_stats: { win_pct: number | null; pts_per_match: number | null; gp: number; recent_form: string } | null;
  h2h: { total_games: number; p1_wins: number; p2_wins: number; avg_total: number | null; recent: Record<string, unknown>[] } | null;
  analysis: {
    score_bands: { total: ScoreBand | null; p1: ScoreBand | null; p2: ScoreBand | null } | null;
    ppm_model: { total: number; p1: number; p2: number; vs_h2h_diff: number | null } | null;
    win_edge: { favored: string; edge_pct: number } | null;
  } | null;
}
