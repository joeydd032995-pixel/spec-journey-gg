# H2H GG League Data API (free, self-hosted)

A free data-acquisition service for the **eBasketball H2H GG League** (NBA 2K).
It pulls from h2hggl.com's open internal JSON API, normalises the data into the
shape GGBetAnalyzer consumes, caches it, persists to SQLite, and refreshes on a
schedule — **no paid provider required**.

This replaces the paid BetsAPI path as GGBetAnalyzer's primary source and, unlike
BetsAPI, supplies the stats that feed previously left blank: **FG%, steals,
fouls**, plus the match **division**. A permanent `game_history` archive
accumulates every completed game and powers the `/api/h2h` head-to-head endpoint.

---

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

---

## Setup

### Requirements

- Python 3.11+
- pip 23+
- Docker (optional, for the containerised path)

### Local Python

```bash
cd scraper

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure (review defaults — no changes required for local use)
cp .env.example .env

# Start the service
uvicorn app.main:app --reload --port 8000
```

Verify:

```bash
curl http://localhost:8000/health
# → {"status":"ok","sport":"nba","source":"https://api-h2h.hudstats.com/v1"}

curl "http://localhost:8000/api/feed?days=7&minGp=5"
# → {"walkforward":[...],"players":[...],"matches":[...],"meta":{...}}
```

The first call does a live fetch (~2–5 s). After that, the in-memory cache
serves requests in < 10 ms. The background scheduler refreshes automatically.

### Docker

```bash
cd scraper
docker compose up --build          # serves on :8000, SQLite persisted in a volume
docker compose up --build -d       # background mode
docker compose logs -f             # stream logs
docker compose down                # stop
```

### Deploy to Render / Railway

Set **Root Directory** to `scraper/` and **Start Command** to:

```
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Add environment variable: `H2HGGL_CORS_ORIGINS=https://your-app.vercel.app`

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + configured source |
| GET | `/api/standings` | Participants ranked by win % |
| GET | `/api/players?minGp=N` | Full roster with FG%/steals/fouls |
| GET | `/api/players/{player_id}` | Single player lookup (by player name) |
| GET | `/api/schedule?days=N` | Upcoming fixtures (default 2 days) |
| GET | `/api/games?days=N` | Recent ended matches |
| GET | `/api/feed?days=N&minGp=M` | **Bridge**: `{ walkforward, players, matches, meta }` for GGBetAnalyzer |
| GET | `/api/h2h?p1=X&p2=Y&limit=20` | Head-to-head record from permanent archive |
| GET | `/api/history?limit=200` | Recent rows from permanent game archive |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `H2HGGL_API_BASE` | `https://api-h2h.hudstats.com/v1` | h2hggl JSON API root |
| `H2HGGL_URL_SPORT` | `ebasketball` | `ebasketball` / `esoccer` / `eamericanfootball` |
| `H2HGGL_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `H2HGGL_CACHE_TTL` | `300` | In-memory cache TTL (seconds) |
| `H2HGGL_REFRESH_GAMES_MIN` | `10` | Game-refresh interval in minutes (0 = off) |
| `H2HGGL_REFRESH_PLAYERS_MIN` | `30` | Player-refresh interval in minutes (0 = off) |
| `H2HGGL_FEED_DAYS` | `14` | Days of history kept warm by the scheduler |
| `H2HGGL_ARCHIVE_DAYS` | `90` | Days fetched by the nightly deep-archive job |
| `H2HGGL_DB_PATH` | `./h2hgg.db` | SQLite file path |
| `H2HGGL_POLITE_DELAY_MS` | `800` | Minimum gap between source requests (ms) |
| `H2HGGL_REQUEST_TIMEOUT` | `25` | HTTP request timeout (seconds) |

Set `H2HGGL_CORS_ORIGINS` to your site's origin in production. See `.env.example`
for all options.

---

## Test

```bash
cd scraper
source .venv/bin/activate
pytest                              # fully offline — uses committed fixtures
```

---

## Architecture notes

- **Cache → DB → live** hierarchy: requests hit the in-memory TTL cache first;
  on miss they trigger a live fetch and write through to SQLite; on failure the
  last good DB snapshot is served.
- **Background scheduler** (APScheduler): games refresh every 10 min, players
  every 30 min, deep archive nightly at 02:00 UTC.
- **`game_history` table**: INSERT OR IGNORE semantics — records are never
  overwritten. The nightly deep-archive job fetches 90 days of history to
  back-fill this table.
- **Politeness**: realistic User-Agent, configurable polite delay between
  source requests, aggressive caching — the source is hit at most every few
  minutes regardless of API traffic.
