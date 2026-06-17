"""HTTP client for the h2hggl/hudstats internal JSON API.

h2hggl.com is a Vite SPA whose data comes from an open JSON API discovered by
inspecting the site bundle (exactly the "intercept the XHR calls first" tip):

    GET {API_BASE}/participant/{sport}            -> all participants + full stats
    GET {API_BASE}/schedule/{sport}?date=<ISO>    -> a day's fixtures (incl. ended w/ scores)

Because the API is reachable with plain HTTP, no headless browser is needed for
the live path. `scraper.py` provides a Playwright-based fallback/rediscovery for
resilience if the site ever changes.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config


class H2HGGLClient:
    def __init__(self, base: str | None = None, sport: str | None = None) -> None:
        self.base = (base or config.API_BASE).rstrip("/")
        self.sport = sport or config.API_SPORT
        self._last_request = 0.0
        self._client = httpx.Client(
            timeout=config.REQUEST_TIMEOUT,
            headers={
                "User-Agent": config.USER_AGENT,
                "Accept": "application/json",
                "Origin": config.SITE_BASE,
                "Referer": config.SITE_BASE + "/",
            },
        )

    # -- polite, retrying GET ------------------------------------------------ #
    def _throttle(self) -> None:
        gap = config.POLITE_DELAY_MS / 1000 - (time.time() - self._last_request)
        if gap > 0:
            time.sleep(gap)

    def _get(self, path: str, params: dict | None = None):
        url = f"{self.base}/{path.lstrip('/')}"
        for attempt in range(1, config.MAX_RETRIES + 1):
            self._throttle()
            try:
                resp = self._client.get(url, params=params)
                self._last_request = time.time()
                if resp.status_code == 429 or resp.status_code >= 500:
                    time.sleep(2 ** attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except (httpx.HTTPError, ValueError):
                if attempt == config.MAX_RETRIES:
                    raise
                time.sleep(1.5 * attempt)
        raise RuntimeError(f"GET {url} failed after {config.MAX_RETRIES} retries")

    # -- endpoints ----------------------------------------------------------- #
    def participants(self) -> list[dict]:
        data = self._get(f"participant/{self.sport}")
        return data if isinstance(data, list) else []

    def schedule_day(self, day: datetime) -> list[dict]:
        iso = day.astimezone(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
        data = self._get(f"schedule/{self.sport}", params={"date": iso})
        return data if isinstance(data, list) else []

    def schedule_range(self, days: int) -> list[dict]:
        """Concatenate `days` daily schedules ending today (UTC)."""
        out: list[dict] = []
        today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        for d in range(days):
            out.extend(self.schedule_day(today - timedelta(days=d)))
        return out

    def close(self) -> None:
        self._client.close()
