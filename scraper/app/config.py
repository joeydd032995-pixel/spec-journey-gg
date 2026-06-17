"""Environment-driven settings for the h2hggl scraper service.

All site-specific knowledge (API base, endpoint templates, the sport mapping
used by h2hggl.com) lives here so that a change on the source site is a
one-file edit.
"""
from __future__ import annotations

import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# h2hggl.com is a Vite SPA backed by an open JSON API. The frontend's url-sport
# ("ebasketball") maps to the API's sport key ("nba").
API_BASE = os.environ.get("H2HGGL_API_BASE", "https://api-h2h.hudstats.com/v1").rstrip("/")
SITE_BASE = os.environ.get("H2HGGL_SITE_BASE", "https://h2hggl.com").rstrip("/")

# url-sport -> api sport key. Mirrors urlSportToSportMap in the site bundle.
URL_SPORT_TO_API = {"ebasketball": "nba", "esoccer": "fifa", "eamericanfootball": "nfl"}
URL_SPORT = os.environ.get("H2HGGL_URL_SPORT", "ebasketball")
API_SPORT = URL_SPORT_TO_API.get(URL_SPORT, "nba")

# Polite scraping / request behaviour.
USER_AGENT = os.environ.get(
    "H2HGGL_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
)
REQUEST_TIMEOUT = _int("H2HGGL_REQUEST_TIMEOUT", 25)
POLITE_DELAY_MS = _int("H2HGGL_POLITE_DELAY_MS", 800)  # min gap between source requests
MAX_RETRIES = _int("H2HGGL_MAX_RETRIES", 3)

# Caching / persistence.
CACHE_TTL = _int("H2HGGL_CACHE_TTL", 300)  # seconds
DB_PATH = os.environ.get("H2HGGL_DB_PATH", os.path.join(os.path.dirname(__file__), "..", "h2hgg.db"))

# Background refresh cadence (minutes). 0 disables the scheduler.
REFRESH_GAMES_MIN = _int("H2HGGL_REFRESH_GAMES_MIN", 10)
REFRESH_PLAYERS_MIN = _int("H2HGGL_REFRESH_PLAYERS_MIN", 30)
DEFAULT_FEED_DAYS = _int("H2HGGL_FEED_DAYS", 14)

# Deep archive: fetches this many days of history once per day to back-fill game_history.
ARCHIVE_DAYS = _int("H2HGGL_ARCHIVE_DAYS", 90)

# CORS — comma-separated list of allowed origins for the frontend.
CORS_ORIGINS = [o.strip() for o in os.environ.get("H2HGGL_CORS_ORIGINS", "*").split(",") if o.strip()]
