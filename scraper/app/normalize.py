"""Normalize raw h2hggl/hudstats API payloads into GGBetAnalyzer's data shapes.

The output is byte-compatible with the `{ walkforward, players, matches, meta }`
contract that the Next.js app already consumes (see ggbet-analyzer/lib/betsapi.ts:
WFRow / PlayerRow / MatchRow). The leakage-free walk-forward builder mirrors
buildWalkforward() there and build_walkforward() in `ggba betsapi.py`.

Crucially, this fills the three stats the BetsAPI feed left blank
(fg_pct, steals, fouls) plus `division`, sourcing them from the participant
endpoint and the match stream name respectively.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

ENDED = "MATCH_ENDED"


# --------------------------------------------------------------------------- #
# Field mapping: hudstats participant record -> GGBetAnalyzer player row       #
# --------------------------------------------------------------------------- #
def _num(v: Any) -> float | str:
    if v is None:
        return ""
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return ""


def participant_to_player_row(p: dict, team: str = "") -> dict:
    """Map one participant stats record to a PlayerRow (CSV_COLS order)."""
    won = int(p.get("matchesWon") or 0)
    lost = int(p.get("matchesLost") or 0)
    form = p.get("matchForm") or []
    recent_form = "".join(str(c).upper() for c in form[:5])
    return {
        "name": p.get("participantName", ""),
        "win_pct": _num(p.get("matchesWinPct")),
        "pts_per_match": _num(p.get("avgPoints")),
        "fg_pct": _num(p.get("avgFieldGoalsPercent")),  # was blank from BetsAPI
        "steals": _num(p.get("avgSteals")),             # was blank from BetsAPI
        "fouls": _num(p.get("avgTeamFouls")),           # was blank from BetsAPI
        "gp": won + lost,
        "w": won,
        "l": lost,
        "recent_form": recent_form,
        "nba_team": team,
    }


def aggregate_players(participants: Iterable[dict], min_gp: int = 1,
                      team_by_player: dict[str, str] | None = None) -> list[dict]:
    """Convert participant records to sorted player rows, optionally enriched with team data."""
    team_by_player = team_by_player or {}
    rows = []
    for p in participants:
        name = p.get("participantName", "")
        row = participant_to_player_row(p, team_by_player.get(name.lower(), ""))
        if row["gp"] >= min_gp:
            rows.append(row)
    rows.sort(key=lambda r: r["name"].lower())
    return rows


# --------------------------------------------------------------------------- #
# Schedule record -> normalized internal game                                  #
# --------------------------------------------------------------------------- #
def parse_game(ev: dict) -> dict | None:
    """Map one schedule entry to an internal game dict, or None if unusable."""
    a, b = ev.get("participantAName"), ev.get("participantBName")
    if not a or not b:
        return None
    sa, sb = ev.get("teamAScore"), ev.get("teamBScore")
    ts, date, hour = 0, "", ""
    sd = ev.get("startDate")
    if sd:
        try:
            dt = datetime.fromisoformat(sd.replace("Z", "+00:00")).astimezone(timezone.utc)
            ts, date, hour = int(dt.timestamp()), dt.date().isoformat(), dt.hour
        except ValueError:
            pass
    return {
        "external_id": ev.get("externalId", ""),
        "ts": ts, "date": date, "hour_utc": hour,
        "p1": a, "p1_team": ev.get("teamAName", "") or "",
        "p2": b, "p2_team": ev.get("teamBName", "") or "",
        "s1": sa, "s2": sb,
        "status": ev.get("matchStatus", ""),
        "division": ev.get("streamName", "") or ev.get("tournamentName", "") or "",
    }


def ended_games(events: Iterable[dict]) -> list[dict]:
    """Parsed, chronologically sorted ended games with valid scores."""
    games = []
    for ev in events:
        g = parse_game(ev)
        if not g or g["status"] != ENDED:
            continue
        if not isinstance(g["s1"], (int, float)) or not isinstance(g["s2"], (int, float)):
            continue
        games.append(g)
    games.sort(key=lambda g: (g["ts"], g["external_id"]))
    return games


# --------------------------------------------------------------------------- #
# Per-player accumulator (mirrors PlayerAgg in lib/betsapi.ts)                  #
# --------------------------------------------------------------------------- #
class _Agg:
    """Per-player stat accumulator used by the leakage-free walk-forward builder."""

    def __init__(self) -> None:
        """Initialize all counters to zero."""
        self.gp = self.w = self.l = 0
        self.pts = 0.0
        self.teams: dict[str, int] = {}
        self.history: list[tuple[int, str]] = []

    def add(self, ts: int, team: str, scored: float, won: bool) -> None:
        """Record one game result into the accumulator."""
        self.gp += 1
        self.pts += scored
        if won:
            self.w += 1
        else:
            self.l += 1
        if team:
            self.teams[team] = self.teams.get(team, 0) + 1
        self.history.append((ts, "W" if won else "L"))

    def recent_form(self, n: int = 5) -> str:
        """Return the most recent *n* results as a string of 'W'/'L' characters."""
        return "".join(h[1] for h in sorted(self.history, key=lambda x: x[0], reverse=True)[:n])

    def snap(self) -> dict:
        """Return a pre-game snapshot of stats; empty strings signal no history yet."""
        if self.gp == 0:
            return {"win_pct": "", "ppm": "", "form": "", "gp": 0}
        return {
            "win_pct": round(self.w / self.gp * 100, 1),
            "ppm": round(self.pts / self.gp, 1),
            "form": self.recent_form(),
            "gp": self.gp,
        }

    def modal_team(self) -> str:
        """Return the NBA team skin this player appeared with most often."""
        return max(self.teams, key=self.teams.get) if self.teams else ""


def build_walkforward(games: list[dict]) -> list[dict]:
    """Leakage-free walk-forward rows: each row snapshots both players' stats as
    they stood immediately BEFORE the game, then the state is updated."""
    state: dict[str, _Agg] = {}
    rows = []
    for g in games:
        a = state.setdefault(g["p1"], _Agg())
        b = state.setdefault(g["p2"], _Agg())
        s1, s2 = a.snap(), b.snap()
        rows.append({
            "date": g["date"], "player1": g["p1"], "player2": g["p2"],
            "p1_team": g["p1_team"], "p2_team": g["p2_team"],
            "p1_win_pct": s1["win_pct"], "p1_ppm": s1["ppm"], "p1_form": s1["form"], "p1_gp": s1["gp"],
            "p2_win_pct": s2["win_pct"], "p2_ppm": s2["ppm"], "p2_form": s2["form"], "p2_gp": s2["gp"],
            "score1": g["s1"], "score2": g["s2"], "actual_total": g["s1"] + g["s2"],
            "hour_utc": g["hour_utc"],
        })
        a.add(g["ts"], g["p1_team"], g["s1"], g["s1"] > g["s2"])
        b.add(g["ts"], g["p2_team"], g["s2"], g["s2"] > g["s1"])
    return rows


def build_matches(games: list[dict]) -> list[dict]:
    """Flatten ended games into lightweight match records with scores and division."""
    return [{
        "date": g["date"], "player1": g["p1"], "player2": g["p2"],
        "score1": g["s1"], "score2": g["s2"], "total": g["s1"] + g["s2"],
        "division": g["division"],
    } for g in games]


def team_map(games: list[dict]) -> dict[str, str]:
    """Modal NBA team skin per player across the supplied games."""
    aggs: dict[str, _Agg] = {}
    for g in games:
        aggs.setdefault(g["p1"], _Agg()).add(g["ts"], g["p1_team"], g["s1"], g["s1"] > g["s2"])
        aggs.setdefault(g["p2"], _Agg()).add(g["ts"], g["p2_team"], g["s2"], g["s2"] > g["s1"])
    return {name.lower(): a.modal_team() for name, a in aggs.items()}


def build_standings(participants: Iterable[dict]) -> list[dict]:
    """Build a rank-ordered standings table from participant records."""
    rows = []
    for p in participants:
        won = int(p.get("matchesWon") or 0)
        lost = int(p.get("matchesLost") or 0)
        rows.append({
            "name": p.get("participantName", ""),
            "win_pct": _num(p.get("matchesWinPct")),
            "w": won, "l": lost, "gp": won + lost,
            "pts_for": int(p.get("pointsFor") or 0),
            "pts_against": int(p.get("pointsAgainst") or 0),
            "fg_pct": _num(p.get("avgFieldGoalsPercent")),
        })
    rows.sort(key=lambda r: (r["win_pct"] if isinstance(r["win_pct"], (int, float)) else -1), reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def build_schedule(events: Iterable[dict]) -> list[dict]:
    """Upcoming (not-yet-ended) fixtures."""
    out = []
    for ev in events:
        g = parse_game(ev)
        if not g or g["status"] == ENDED:
            continue
        out.append({
            "external_id": g["external_id"], "date": g["date"], "hour_utc": g["hour_utc"],
            "player1": g["p1"], "player2": g["p2"],
            "p1_team": g["p1_team"], "p2_team": g["p2_team"],
            "status": g["status"], "division": g["division"],
        })
    return out
