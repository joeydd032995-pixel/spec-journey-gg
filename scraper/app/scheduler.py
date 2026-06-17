"""Background refresh jobs (APScheduler) to keep the DB/cache warm without
hammering the source on every request."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from . import cache, config, scraper

log = logging.getLogger("h2hggl.scheduler")
_scheduler: BackgroundScheduler | None = None


def _refresh_games() -> None:
    try:
        scraper.build_feed(days=config.DEFAULT_FEED_DAYS, min_gp=1)
        scraper.get_schedule()
        cache.invalidate("feed:")
        cache.invalidate("games:")
        cache.invalidate("schedule")
        log.info("refreshed games/schedule")
    except Exception as e:  # keep the scheduler alive
        log.warning("games refresh failed: %s", e)


def _refresh_players() -> None:
    try:
        scraper.get_players(min_gp=1)
        scraper.get_standings()
        cache.invalidate("players:")
        cache.invalidate("standings")
        log.info("refreshed players/standings")
    except Exception as e:
        log.warning("players refresh failed: %s", e)


def start() -> BackgroundScheduler | None:
    global _scheduler
    if config.REFRESH_GAMES_MIN <= 0 and config.REFRESH_PLAYERS_MIN <= 0:
        return None
    _scheduler = BackgroundScheduler(timezone="UTC")
    if config.REFRESH_GAMES_MIN > 0:
        _scheduler.add_job(_refresh_games, "interval", minutes=config.REFRESH_GAMES_MIN,
                           id="games", max_instances=1, coalesce=True)
    if config.REFRESH_PLAYERS_MIN > 0:
        _scheduler.add_job(_refresh_players, "interval", minutes=config.REFRESH_PLAYERS_MIN,
                           id="players", max_instances=1, coalesce=True)
    _scheduler.start()
    log.info("scheduler started (games=%dm players=%dm)",
             config.REFRESH_GAMES_MIN, config.REFRESH_PLAYERS_MIN)
    return _scheduler


def shutdown() -> None:
    if _scheduler:
        _scheduler.shutdown(wait=False)
