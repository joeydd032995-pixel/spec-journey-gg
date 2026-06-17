# H2H GG League Data API (free, self-hosted)

A free data-acquisition service for the **eBasketball H2H GG League** (NBA 2K).
It pulls from h2hggl.com's open internal JSON API, normalizes the data into the
shape GGBetAnalyzer consumes, caches it, persists to SQLite, and refreshes it on
a schedule — **no paid provider required**.

This replaces the paid BetsAPI path as GGBetAnalyzer's primary source and, unlike
BetsAPI, supplies the stats that feed previously left blank: **FG%, steals,
fouls**, plus the match **division**.

## How it gets the data

h2hggl.com is a Vite single-page app whose data comes from an **open JSON API**
(found by inspecting the site bundle — the "intercept the XHR calls first"
approach). The live path is therefore plain HTTP, no headless browser:

| What | Endpoint |
|------|----------|
| Players + full stats | `GET https://api-h2h.hudstats.com/v1/participant/nba` |
| A day's fixtures (incl. ended w/ scores) | `GET …/v1/schedule/nba?date=<ISO midnight>` |

`app/scraper.py` also ships an optional **Playwright** fallback
(`playwright_rediscover()`) that re-captures the API endpoints by driving a
headless browser, in case the site ever changes.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | liveness + configured source |
| GET | `/api/standings` | participants ranked by win % |
| GET | `/api/players?minGp=N` | full roster with FG%/steals/fouls |
| GET | `/api/players/{name}` | one player |
| GET | `/api/schedule?days=N` | upcoming fixtures |
| GET | `/api/games?days=N` | recent ended matches |
| GET | `/api/feed?days=N&minGp=M` | **bridge**: `{ walkforward, players, matches, meta }` for GGBetAnalyzer |

## Run locally

```bash
cd scraper
pip install -r requirements.txt          # playwright/pytest optional for runtime
uvicorn app.main:app --reload --port 8000
curl "http://localhost:8000/api/feed?days=7&minGp=5" | head -c 400
```

## Run with Docker

```bash
cd scraper
docker compose up --build          # serves on :8000, SQLite persisted in a volume
```

## Test

```bash
cd scraper
pip install -r requirements.txt
pytest                              # 13 tests, fully offline (committed fixtures)
```

## Deploy

- **Docker on a VPS** (DigitalOcean/Vultr, ~$4–6/mo): `docker compose up -d`.
- **Render / Railway**: point at this directory; start command
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.

Set `H2HGGL_CORS_ORIGINS` to your site's origin in production. See `.env.example`
for all options. Be a good citizen: the service caches aggressively and
rate-limits source requests (`H2HGGL_POLITE_DELAY_MS`); the scheduler hits the
source at most every few minutes.
