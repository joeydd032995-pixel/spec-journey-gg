"""FastAPI service exposing free h2hggl.com data as a REST API.

Endpoints serve cached/normalized data; the background scheduler keeps the
SQLite store warm. If a live fetch fails, the last good DB snapshot is served.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import cache, config, db, scheduler, scraper

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("h2hggl.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the DB and start background jobs on startup; shut down cleanly on exit."""
    db.init_db()
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="H2H GG League Data API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _served(key: str, fetch_fn, snapshot_key: str | None = None):
    """Cache-first, then live fetch, then last-good DB snapshot on failure."""
    try:
        return cache.get_cached(key, fetch_fn)
    except Exception as e:
        log.warning("live fetch failed for %s: %s", key, e)
        snap = db.load_snapshot(snapshot_key or key)
        if snap is not None:
            return snap
        raise HTTPException(status_code=502, detail=f"source unavailable: {e}")


@app.get("/health")
def health():
    """Liveness check — returns service status, sport key, and API base URL."""
    return {"status": "ok", "sport": config.API_SPORT, "source": config.API_BASE}


@app.get("/api/standings")
def standings():
    """Return league standings ranked by win percentage."""
    return _served("standings", scraper.get_standings)


@app.get("/api/players")
def players(minGp: int = Query(1, ge=1)):
    """Return normalized player rows filtered to those with at least *minGp* games played."""
    return _served(f"players:{minGp}", lambda: scraper.get_players(min_gp=minGp), "players:1")


@app.get("/api/players/{player_id}")
def player(player_id: str, minGp: int = Query(1, ge=1)):
    """Look up a single player by name (case-insensitive); raises 404 if not found."""
    rows = _served(f"players:{minGp}", lambda: scraper.get_players(min_gp=minGp), "players:1")
    pid = player_id.lower()
    for r in rows:
        if r["name"].lower() == pid:
            return r
    raise HTTPException(status_code=404, detail=f"player '{player_id}' not found")


@app.get("/api/schedule")
def schedule(days: int = Query(2, ge=1, le=14)):
    """Return upcoming (not-yet-ended) fixtures for the next *days* days."""
    return _served(f"schedule:{days}", lambda: scraper.get_schedule(days=days))


@app.get("/api/games")
def games(days: int = Query(config.DEFAULT_FEED_DAYS, ge=1, le=90)):
    """Return completed match records for the last *days* days."""
    return _served(f"games:{days}", lambda: scraper.get_games(days=days), f"games:{days}")


@app.get("/api/feed")
def feed(days: int = Query(config.DEFAULT_FEED_DAYS, ge=1, le=90), minGp: int = Query(1, ge=1)):
    """Bridge endpoint: { walkforward, players, matches, meta } for GGBetAnalyzer."""
    return _served(f"feed:{days}:{minGp}",
                   lambda: scraper.build_feed(days=days, min_gp=minGp),
                   f"feed:{days}:{minGp}")


@app.get("/api/h2h")
def h2h(p1: str = Query(..., description="First player name"),
        p2: str = Query(..., description="Second player name"),
        limit: int = Query(20, ge=1, le=200)):
    """Head-to-head record between two players drawn from the permanent game_history archive."""
    result = db.head_to_head(p1, p2, limit=limit)
    if result["total"] == 0:
        # Trigger a fresh archive pass so first-time callers get data without waiting
        try:
            scraper.deep_archive(days=config.ARCHIVE_DAYS)
            result = db.head_to_head(p1, p2, limit=limit)
        except Exception as e:
            log.warning("h2h on-demand archive failed: %s", e)
    return result


@app.get("/api/history")
def history(limit: int = Query(200, ge=1, le=1000)):
    """Recent rows from the permanent game_history archive."""
    rows = db.history_games(limit=limit)
    return {"count": len(rows), "games": rows}
