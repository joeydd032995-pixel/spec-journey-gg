"""High-level data acquisition: fetch via the JSON API, normalize, persist.

Primary path uses `H2HGGLClient` (plain HTTP against the discovered API).
`playwright_rediscover()` is a resilience fallback that drives a headless browser
to re-capture the API base/endpoints if the site ever changes — it is optional
and only imported on demand so the service runs without a browser installed.
"""
from __future__ import annotations

import logging

from . import config, db, normalize
from .client import H2HGGLClient

log = logging.getLogger("h2hggl.scraper")


# --------------------------------------------------------------------------- #
# Builders — each returns a normalized payload and persists what it can.        #
# --------------------------------------------------------------------------- #
def build_feed(days: int = config.DEFAULT_FEED_DAYS, min_gp: int = 1) -> dict:
    """The bridge payload consumed by the Next.js app: matches /api/fetch-games."""
    client = H2HGGLClient()
    try:
        participants = client.participants()
        events = client.schedule_range(days)
    finally:
        client.close()

    games = normalize.ended_games(events)
    tmap = normalize.team_map(games)
    players = normalize.aggregate_players(participants, min_gp=min_gp, team_by_player=tmap)
    walkforward = normalize.build_walkforward(games)
    matches = normalize.build_matches(games)

    db.upsert_players(players)
    db.upsert_games(games)
    db.archive_games(games)

    feed = {
        "walkforward": walkforward,
        "players": players,
        "matches": matches,
        "meta": {
            "source": "h2hggl",
            "games": len(games),
            "days": days,
            "minGp": min_gp,
            "participants": len(participants),
            "fetched": _now(),
        },
    }
    db.save_snapshot(f"feed:{days}:{min_gp}", feed)
    return feed


def get_players(min_gp: int = 1) -> list[dict]:
    client = H2HGGLClient()
    try:
        participants = client.participants()
    finally:
        client.close()
    players = normalize.aggregate_players(participants, min_gp=min_gp)
    db.upsert_players(players)
    db.save_snapshot(f"players:{min_gp}", players)
    return players


def get_standings() -> list[dict]:
    client = H2HGGLClient()
    try:
        participants = client.participants()
    finally:
        client.close()
    standings = normalize.build_standings(participants)
    db.save_snapshot("standings", standings)
    return standings


def get_schedule(days: int = 2) -> list[dict]:
    """Upcoming fixtures across the next `days` days (today forward)."""
    from datetime import datetime, timedelta, timezone
    client = H2HGGLClient()
    events: list[dict] = []
    try:
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        for d in range(days):
            events.extend(client.schedule_day(today + timedelta(days=d)))
    finally:
        client.close()
    schedule = normalize.build_schedule(events)
    db.save_snapshot("schedule", schedule)
    return schedule


def get_games(days: int = config.DEFAULT_FEED_DAYS) -> list[dict]:
    client = H2HGGLClient()
    try:
        events = client.schedule_range(days)
    finally:
        client.close()
    games = normalize.ended_games(events)
    db.upsert_games(games)
    db.archive_games(games)
    matches = normalize.build_matches(games)
    db.save_snapshot(f"games:{days}", matches)
    return matches


def deep_archive(days: int = config.ARCHIVE_DAYS) -> int:
    """Fetch a long date window and archive all completed games into game_history.
    Returns the count of newly inserted rows (skips already-archived games)."""
    client = H2HGGLClient()
    try:
        events = client.schedule_range(days)
    finally:
        client.close()
    games = normalize.ended_games(events)
    inserted = db.archive_games(games)
    log.info("deep_archive: %d new rows from %d games over %d days", inserted, len(games), days)
    return inserted


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- #
# Optional Playwright fallback (rediscovery if the site/API changes).           #
# --------------------------------------------------------------------------- #
def playwright_rediscover(url: str | None = None) -> list[str]:
    """Drive a headless browser, capture JSON XHR/fetch URLs the SPA calls.

    Returns the list of discovered JSON endpoint URLs. Requires the optional
    `playwright` dependency (and `playwright install chromium`).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:  # pragma: no cover - optional dependency
        log.warning("playwright not installed; rediscovery unavailable")
        return []

    target = url or f"{config.SITE_BASE}/en/{config.URL_SPORT}/standings"
    found: list[str] = []
    with sync_playwright() as p:  # pragma: no cover - needs a browser
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(user_agent=config.USER_AGENT)

        def on_response(resp):
            ct = resp.headers.get("content-type", "")
            if "json" in ct or "/api" in resp.url or "/v1/" in resp.url:
                if resp.ok:
                    found.append(resp.url)

        page.on("response", on_response)
        page.goto(target, wait_until="networkidle")
        browser.close()
    return sorted(set(found))
