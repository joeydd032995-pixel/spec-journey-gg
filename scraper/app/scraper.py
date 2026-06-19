"""High-level data acquisition: fetch via the JSON API, normalize, persist.

Primary path uses `H2HGGLClient` (plain HTTP against the discovered API).
`playwright_rediscover()` is a resilience fallback that drives a headless browser
to re-capture the API base/endpoints if the site ever changes — it is optional
and only imported on demand so the service runs without a browser installed.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

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
    """Fetch all participants from the API and return normalized player rows."""
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
    """Fetch participant data and return standings rows sorted by win percentage."""
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
    db.save_snapshot(f"schedule:{days}", schedule)
    return schedule


def get_games(days: int = config.DEFAULT_FEED_DAYS) -> list[dict]:
    """Fetch and return normalized match records for completed games in the last *days* days."""
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


def build_upcoming_feed(days_schedule: int = 2, days_history: int = 60) -> dict:
    """Pre-compute H2H summary, score prediction bands, PPM model, and win% edge
    for every upcoming fixture so the frontend can render rich per-game cards.

    Args:
        days_schedule: How many days ahead to look for upcoming fixtures.
        days_history:  Only H2H games played within this many days are included in
                       aggregate stats, score bands, and the PPM model.

    Returns a dict shaped as::

        {
            "upcoming": [ { ...fixture fields..., "analysis": {...} }, ... ],
            "meta": { "source", "count", "days_schedule", "days_history", "fetched" }
        }
    """
    # 1. Fetch upcoming schedule and current player stats.
    schedule = get_schedule(days=days_schedule)
    players = get_players(min_gp=1)

    # 2. Build player lookup keyed by uppercased name.
    player_lookup: dict[str, dict] = {p["name"].upper(): p for p in players}

    def _player_card(raw: dict | None) -> dict | None:
        """Normalise a player row to the fields the GUI needs."""
        if raw is None:
            return None
        wp = raw.get("win_pct")
        ppm = raw.get("pts_per_match")
        return {
            "win_pct": float(wp) if isinstance(wp, (int, float)) else None,
            "pts_per_match": float(ppm) if isinstance(ppm, (int, float)) else None,
            "gp": raw.get("gp"),
            "recent_form": raw.get("recent_form", ""),
        }

    upcoming = []
    for fixture in schedule:
        p1_name: str = fixture["player1"]
        p2_name: str = fixture["player2"]

        p1_stats_raw = player_lookup.get(p1_name.upper())
        p2_stats_raw = player_lookup.get(p2_name.upper())

        p1_card = _player_card(p1_stats_raw)
        p2_card = _player_card(p2_stats_raw)

        # 3. Head-to-head history filtered to the requested history window.
        since = (date.today() - timedelta(days=days_history)).isoformat()
        h2h = db.head_to_head(p1_name, p2_name, limit=50, since_date=since)

        # 4. Extract score series from H2H recent list.
        recent = h2h.get("recent") or []
        totals = [r["total"] for r in recent if isinstance(r.get("total"), (int, float))]
        p1_scores = [r["p1_score"] for r in recent if isinstance(r.get("p1_score"), (int, float))]
        p2_scores = [r["p2_score"] for r in recent if isinstance(r.get("p2_score"), (int, float))]

        # 5. Score prediction bands (None when < 3 H2H games exist).
        score_bands: dict | None = None
        if len(totals) >= 3:
            score_bands = {
                "total": normalize.score_band(totals),
                "p1": normalize.score_band(p1_scores),
                "p2": normalize.score_band(p2_scores),
            }

        # 6. PPM model — leave fields None when player data is unavailable.
        p1_ppm = p1_card["pts_per_match"] if p1_card else None
        p2_ppm = p2_card["pts_per_match"] if p2_card else None
        avg_total = h2h.get("avg_total")
        if p1_ppm is not None and p2_ppm is not None:
            ppm_total: float | None = round(p1_ppm + p2_ppm, 1)
            vs_h2h_diff = round(ppm_total - avg_total, 1) if avg_total is not None else None
        else:
            ppm_total = None
            vs_h2h_diff = None
        ppm_model = {
            "total": ppm_total,
            "p1": round(p1_ppm, 1) if p1_ppm is not None else None,
            "p2": round(p2_ppm, 1) if p2_ppm is not None else None,
            "vs_h2h_diff": vs_h2h_diff,
        }

        # 7. Win% edge.
        wp1 = p1_card["win_pct"] if p1_card else None
        wp2 = p2_card["win_pct"] if p2_card else None
        if wp1 is not None and wp2 is not None:
            favored = p1_name if wp1 >= wp2 else p2_name
            edge_pct = round(abs(wp1 - wp2), 1)
        else:
            favored = None
            edge_pct = None
        win_edge = {"favored": favored, "edge_pct": edge_pct}

        upcoming.append({
            "external_id": fixture["external_id"],
            "date": fixture["date"],
            "hour_utc": fixture["hour_utc"],
            "player1": p1_name,
            "player2": p2_name,
            "p1_team": fixture.get("p1_team", ""),
            "p2_team": fixture.get("p2_team", ""),
            "division": fixture.get("division", ""),
            "p1_stats": p1_card,
            "p2_stats": p2_card,
            "h2h": {
                "total_games": h2h["total"],
                "p1_wins": h2h["p1_wins"],
                "p2_wins": h2h["p2_wins"],
                "avg_total": h2h["avg_total"],
                "recent": recent,
            },
            "analysis": {
                "score_bands": score_bands,
                "ppm_model": ppm_model,
                "win_edge": win_edge,
            },
        })

    result = {
        "upcoming": upcoming,
        "meta": {
            "source": "h2hggl",
            "count": len(upcoming),
            "days_schedule": days_schedule,
            "days_history": days_history,
            "fetched": _now(),
        },
    }
    db.save_snapshot(f"upcoming-feed:{days_schedule}:{days_history}", result)
    return result


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
