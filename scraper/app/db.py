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
