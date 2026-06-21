"""Background refresh jobs (APScheduler) to keep the DB/cache warm without
hammering the source on every request."""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from . import cache, config, scraper

try:
    from optimizer import optimizer_scheduler as _opt_sched
    _HAS_OPTIMIZER = True
except ImportError:
    _HAS_OPTIMIZER = False

log = logging.getLogger("h2hggl.scheduler")
_scheduler: BackgroundScheduler | None = None


def _refresh_games() -> None:
    """Refresh the games/schedule cache and persist a new DB snapshot."""
    try:
        scraper.build_feed(days=config.DEFAULT_FEED_DAYS, min_gp=1)
        scraper.get_schedule()
        cache.invalidate("feed:")
        cache.invalidate("games:")
        cache.invalidate("schedule:")
        log.info("refreshed games/schedule")
    except Exception:  # keep the scheduler alive
        log.exception("games refresh failed")


def _refresh_players() -> None:
    """Refresh the players/standings cache and persist a new DB snapshot."""
    try:
        scraper.get_players(min_gp=1)
        scraper.get_standings()
        cache.invalidate("players:")
        cache.invalidate("standings")
        log.info("refreshed players/standings")
    except Exception:
        log.exception("players refresh failed")


def _deep_archive() -> None:
    """Run the nightly deep archive job to accumulate completed games in game_history."""
    try:
        inserted = scraper.deep_archive(days=config.ARCHIVE_DAYS)
        log.info("deep_archive job complete: %d new rows", inserted)
    except Exception:
        log.exception("deep_archive failed")


def start() -> BackgroundScheduler | None:
    """Start the APScheduler background scheduler; returns None when all intervals are 0."""
    global _scheduler
    has_refresh = config.REFRESH_GAMES_MIN > 0 or config.REFRESH_PLAYERS_MIN > 0
    has_archive = config.ARCHIVE_DAYS > 0
    if not has_refresh and not has_archive:
        return None
    _scheduler = BackgroundScheduler(timezone="UTC")
    if config.REFRESH_GAMES_MIN > 0:
        _scheduler.add_job(_refresh_games, "interval", minutes=config.REFRESH_GAMES_MIN,
                           id="games", max_instances=1, coalesce=True)
    if config.REFRESH_PLAYERS_MIN > 0:
        _scheduler.add_job(_refresh_players, "interval", minutes=config.REFRESH_PLAYERS_MIN,
                           id="players", max_instances=1, coalesce=True)
    if has_archive:
        # Nightly deep archive at 02:00 UTC accumulates full history in game_history.
        _scheduler.add_job(_deep_archive, "cron", hour=2, minute=0,
                           id="deep_archive", max_instances=1, coalesce=True)
    _scheduler.start()
    log.info("scheduler started (games=%dm players=%dm archive=%dd@02:00UTC)",
             config.REFRESH_GAMES_MIN, config.REFRESH_PLAYERS_MIN, config.ARCHIVE_DAYS)
    if _HAS_OPTIMIZER:
        _opt_sched.start()
        log.info("optimizer scheduler started")
    return _scheduler


def shutdown() -> None:
    """Gracefully stop the background scheduler without waiting for running jobs."""
    if _scheduler:
        _scheduler.shutdown(wait=False)
    if _HAS_OPTIMIZER:
        try:
            _opt_sched.shutdown()
        except Exception:
            log.exception("failed to stop optimizer scheduler")
