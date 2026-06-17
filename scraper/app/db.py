"""SQLite persistence so scraped data survives restarts and the API can serve
the last good snapshot even if the source is briefly unreachable."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from . import config

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS players (
                id TEXT PRIMARY KEY, name TEXT, team TEXT,
                win_pct REAL, pts_per_match REAL, fg_pct REAL, steals REAL, fouls REAL,
                gp INTEGER, w INTEGER, l INTEGER, recent_form TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )""")
        c.execute("""
            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY, game_date TEXT, hour_utc INTEGER,
                player1 TEXT, player2 TEXT, p1_team TEXT, p2_team TEXT,
                score1 INTEGER, score2 INTEGER, total INTEGER, division TEXT
            )""")
        # Permanent history — INSERT OR IGNORE so records never get overwritten.
        c.execute("""
            CREATE TABLE IF NOT EXISTS game_history (
                id TEXT PRIMARY KEY, game_date TEXT, hour_utc INTEGER,
                player1 TEXT, player2 TEXT, p1_team TEXT, p2_team TEXT,
                score1 INTEGER, score2 INTEGER, total INTEGER, division TEXT,
                archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_gh_p1 ON game_history (LOWER(player1))")
        c.execute("CREATE INDEX IF NOT EXISTS idx_gh_p2 ON game_history (LOWER(player2))")
        c.execute("CREATE INDEX IF NOT EXISTS idx_gh_date ON game_history (game_date)")
        # Generic snapshot store for normalized payloads (standings, schedule, feed).
        c.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                key TEXT PRIMARY KEY, payload TEXT, updated_at REAL
            )""")


def upsert_players(rows: list[dict]) -> None:
    with _lock, _conn() as c:
        for r in rows:
            c.execute("""
                INSERT INTO players (id, name, team, win_pct, pts_per_match, fg_pct, steals,
                                     fouls, gp, w, l, recent_form, last_updated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    team=excluded.team, win_pct=excluded.win_pct,
                    pts_per_match=excluded.pts_per_match, fg_pct=excluded.fg_pct,
                    steals=excluded.steals, fouls=excluded.fouls, gp=excluded.gp,
                    w=excluded.w, l=excluded.l, recent_form=excluded.recent_form,
                    last_updated=CURRENT_TIMESTAMP
            """, (
                r["name"].lower(), r["name"], r.get("nba_team", ""),
                _f(r["win_pct"]), _f(r["pts_per_match"]), _f(r["fg_pct"]),
                _f(r["steals"]), _f(r["fouls"]), r["gp"], r["w"], r["l"], r["recent_form"],
            ))


def upsert_games(games: list[dict]) -> None:
    with _lock, _conn() as c:
        for g in games:
            c.execute("""
                INSERT INTO games (id, game_date, hour_utc, player1, player2, p1_team, p2_team,
                                   score1, score2, total, division)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    score1=excluded.score1, score2=excluded.score2, total=excluded.total,
                    division=excluded.division
            """, (
                g["external_id"] or f"{g['date']}|{g['p1']}|{g['p2']}",
                g["date"], g["hour_utc"] if isinstance(g["hour_utc"], int) else None,
                g["p1"], g["p2"], g["p1_team"], g["p2_team"],
                g["s1"], g["s2"], g["s1"] + g["s2"], g["division"],
            ))


def archive_games(games: list[dict]) -> int:
    """Insert completed games into permanent history (INSERT OR IGNORE — never overwrites).
    Returns the number of newly inserted rows."""
    inserted = 0
    with _lock, _conn() as c:
        for g in games:
            gid = g["external_id"] or f"{g['date']}|{g['p1']}|{g['p2']}"
            cur = c.execute("""
                INSERT OR IGNORE INTO game_history
                    (id, game_date, hour_utc, player1, player2, p1_team, p2_team,
                     score1, score2, total, division)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """, (
                gid, g["date"],
                g["hour_utc"] if isinstance(g["hour_utc"], int) else None,
                g["p1"], g["p2"], g["p1_team"], g["p2_team"],
                g["s1"], g["s2"], g["s1"] + g["s2"], g["division"],
            ))
            inserted += cur.rowcount
    return inserted


def head_to_head(p1: str, p2: str, limit: int = 20) -> dict:
    """All historical matchups between two players from game_history."""
    lp1, lp2 = p1.lower(), p2.lower()
    with _lock, _conn() as c:
        # Aggregate over FULL history (no LIMIT) so stats are accurate.
        agg = c.execute("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN (LOWER(player1)=? AND score1>score2)
                             OR  (LOWER(player2)=? AND score2>score1)
                            THEN 1 ELSE 0 END) AS p1_wins,
                   AVG(CAST(total AS REAL)) AS avg_total
            FROM game_history
            WHERE (LOWER(player1)=? AND LOWER(player2)=?)
               OR (LOWER(player1)=? AND LOWER(player2)=?)
        """, (lp1, lp1, lp1, lp2, lp2, lp1)).fetchone()
        # Recent detail list capped to `limit`.
        rows = c.execute("""
            SELECT id, game_date, hour_utc, player1, player2,
                   score1, score2, total, division
            FROM game_history
            WHERE (LOWER(player1) = ? AND LOWER(player2) = ?)
               OR (LOWER(player1) = ? AND LOWER(player2) = ?)
            ORDER BY game_date DESC, COALESCE(hour_utc, 0) DESC
            LIMIT ?
        """, (lp1, lp2, lp2, lp1, limit)).fetchall()
    total = agg["total"] or 0
    p1_wins = agg["p1_wins"] or 0
    p2_wins = total - p1_wins
    avg_total_raw = agg["avg_total"]
    avg_total = round(avg_total_raw, 1) if avg_total_raw is not None else None
    recent = []
    for g in [dict(r) for r in rows]:
        p1_scored_first = g["player1"].lower() == lp1
        p1_score = g["score1"] if p1_scored_first else g["score2"]
        p2_score = g["score2"] if p1_scored_first else g["score1"]
        recent.append({
            "date": g["game_date"], "hour_utc": g["hour_utc"],
            "p1_score": p1_score, "p2_score": p2_score,
            "total": g["total"], "division": g["division"],
            "winner": p1 if p1_score > p2_score else p2,
        })
    return {
        "p1": p1, "p2": p2, "total": total,
        "p1_wins": p1_wins, "p2_wins": p2_wins,
        "p1_win_pct": round(p1_wins / total * 100, 1) if total else None,
        "avg_total": avg_total,
        "recent": recent,
    }


def history_games(limit: int = 200) -> list[dict]:
    """Most recent rows from the permanent game_history archive."""
    with _lock, _conn() as c:
        rows = c.execute("""
            SELECT id, game_date, hour_utc, player1, player2,
                   score1, score2, total, division, archived_at
            FROM game_history
            ORDER BY game_date DESC, COALESCE(hour_utc, 0) DESC
            LIMIT ?
        """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def save_snapshot(key: str, payload: Any) -> None:
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO snapshots (key, payload, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
            (key, json.dumps(payload), time.time()),
        )


def load_snapshot(key: str) -> Any | None:
    with _lock, _conn() as c:
        row = c.execute("SELECT payload FROM snapshots WHERE key=?", (key,)).fetchone()
    return json.loads(row["payload"]) if row else None


def _f(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) else None
