# GGBetAnalyzer — Full Setup Guide

Step-by-step from a fresh clone to a running analytics dashboard, including the
free h2hggl data service, the Next.js app, and optional Vercel deployment.

---

## Architecture overview

```
Browser (React dashboard)
        ↕
Next.js app  (ggbet-analyzer/)   ← http://localhost:3000
        ↕  H2HGGL_API_URL
Python scraper  (scraper/)       ← http://localhost:8000
        ↕  plain HTTP
api-h2h.hudstats.com  (free, no auth, h2hggl.com's internal API)
```

The scraper fetches live data from h2hggl.com's open internal JSON API, stores it
in SQLite, and exposes it as a REST API. The Next.js app calls that REST API
server-side and renders the full GGBetAnalyzer dashboard in the browser.

No paid API keys are required.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Git | any | https://git-scm.com |
| Python | 3.11 + | https://python.org/downloads |
| pip | 23 + | bundled with Python |
| Node.js | 18 + | https://nodejs.org |
| npm | 9 + | bundled with Node.js |
| Docker *(optional)* | 24 + | https://docs.docker.com/get-docker |

Verify your versions:

```bash
git --version
python3 --version
node --version
npm --version
```

---

## Step 1 — Clone the repository

```bash
git clone https://github.com/joeydd032995-pixel/spec-journey-gg.git
cd spec-journey-gg
```

The relevant directories are:

```
spec-journey-gg/
├── scraper/            ← Python data-acquisition service (FastAPI + SQLite)
│   ├── app/            ← source code
│   ├── tests/          ← offline test suite + fixtures
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── requirements.txt
│   └── .env.example
└── ggbet-analyzer/     ← Next.js analytics dashboard
    ├── app/
    ├── components/
    ├── lib/
    ├── package.json
    └── SETUP.md
```

---

## Step 2 — Set up the scraper service

The scraper is the data backbone. It hits h2hggl.com's free JSON API every few
minutes, normalises the data, and caches it in SQLite so the Next.js app always
gets a fast, stable response.

### Option A — Local Python (quickest for development)

**2a. Create a virtual environment**

```bash
cd scraper
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
```

**2b. Install dependencies**

```bash
pip install -r requirements.txt
```

**2c. Configure environment**

```bash
cp .env.example .env
```

Open `.env` and review the defaults. The only value you're likely to change
locally is `H2HGGL_CORS_ORIGINS`:

```env
# Allow the Next.js dev server to call the scraper
H2HGGL_CORS_ORIGINS=http://localhost:3000

# How many days of history to keep warm (default 14)
H2HGGL_FEED_DAYS=14

# Background refresh intervals (minutes; 0 to disable)
H2HGGL_REFRESH_GAMES_MIN=10
H2HGGL_REFRESH_PLAYERS_MIN=30

# SQLite file path (default: scraper/h2hgg.db)
H2HGGL_DB_PATH=./h2hgg.db
```

**2d. Start the service**

```bash
uvicorn app.main:app --reload --port 8000
```

You should see:

```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000
```

**2e. Verify it's working**

```bash
curl http://localhost:8000/health
# → {"status":"ok","sport":"nba","source":"https://api-h2h.hudstats.com/v1"}

curl "http://localhost:8000/api/feed?days=7&minGp=5"
# → {"walkforward":[...],"players":[...],"matches":[...],"meta":{...}}
```

The first call triggers a live fetch from h2hggl.com (takes ~2–5 s). Subsequent
calls are served from the in-memory cache (< 10 ms). The background scheduler
keeps the cache warm automatically.

---

### Option B — Docker (recommended for persistent/always-on use)

```bash
cd scraper
docker compose up --build
```

This builds a hardened image (non-root user, SQLite persisted in a named volume)
and starts the service on port 8000.

To run in the background:

```bash
docker compose up --build -d
docker compose logs -f          # stream logs
```

To stop:

```bash
docker compose down
```

**Override CORS for your domain** (edit `docker-compose.yml` before starting):

```yaml
environment:
  H2HGGL_CORS_ORIGINS: "https://your-app.vercel.app"
```

---

### Option C — Deploy to a VPS or cloud platform

**DigitalOcean / Vultr / Hetzner (~$4–6/mo):**

```bash
# On the server
git clone https://github.com/joeydd032995-pixel/spec-journey-gg.git
cd spec-journey-gg/scraper
docker compose up --build -d
```

**Render / Railway (free tier available):**

1. Connect your GitHub repo.
2. Set root directory to `scraper/`.
3. Set start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Add environment variable: `H2HGGL_CORS_ORIGINS=https://your-app.vercel.app`

Once deployed, copy the public URL — you'll need it in Step 3.

---

## Step 3 — Set up the Next.js app

```bash
cd ggbet-analyzer         # from repo root
```

**3a. Install dependencies**

```bash
npm install
```

**3b. Configure environment**

```bash
cp .env.local.example .env.local    # if the example exists, otherwise create it
```

Create (or edit) `.env.local`:

```env
# URL of your running scraper service (no trailing slash)
H2HGGL_API_URL=http://localhost:8000

# Optional: BetsAPI token (only needed if using BetsAPI as a fallback source)
# BETSAPI_TOKEN=your_token_here
```

**3c. Start the development server**

```bash
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Step 4 — Verify the full stack

1. Open http://localhost:3000.
2. Go to the **Data Manager** tab.
3. Find the **"Fetch live data"** card — source should default to **H2H GG League**.
4. Click **Fetch data**.
5. Players, walk-forward rows, and matches should populate within a few seconds.
6. Open **Historical Insights** — the walk-forward backtest should show correlation
   and +EV stats.
7. Try a matchup in **Matchup Analyzer** — `fg_pct`, `steals`, and `fouls` columns
   should now be populated (previously blank when using BetsAPI).

---

## Step 5 — Run the test suite (optional but recommended)

```bash
cd scraper
source .venv/bin/activate
pytest
```

All tests run fully offline using committed fixtures — no network required.

---

## Step 6 — Deploy the Next.js app to Vercel

**6a. Push to GitHub** (if not already done)

```bash
git add .
git commit -m "ready for deployment"
git push origin main
```

**6b. Import on Vercel**

1. Go to https://vercel.com/new
2. Click **Import Git Repository** and select your fork.
3. Set **Root Directory** to `ggbet-analyzer`.
4. Under **Environment Variables**, add:
   - `H2HGGL_API_URL` → the public URL of your deployed scraper (Step 2C)
   - `BETSAPI_TOKEN` → optional, only if you want the BetsAPI fallback
5. Click **Deploy**.

**6c. Verify**

Open your Vercel URL, go to Data Manager, and fetch. The dashboard should
populate exactly as it did locally.

> **Vercel plan note:** API route timeout is 10 s on Hobby and 60 s on Pro.
> The scraper-backed H2H routes usually complete in < 1 s once cached.

---

## Quick-start one-liner (development)

Run both services simultaneously in two terminals:

**Terminal 1 — scraper:**
```bash
cd scraper && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — Next.js:**
```bash
cd ggbet-analyzer && npm run dev
```

Then open http://localhost:3000.

---

## API endpoints reference (scraper)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Liveness check |
| GET | `/api/standings` | Participants ranked by win % |
| GET | `/api/players?minGp=N` | Full roster with FG%/steals/fouls |
| GET | `/api/players/{player_id}` | Single player lookup |
| GET | `/api/schedule?days=N` | Upcoming fixtures (default 2 days) |
| GET | `/api/games?days=N` | Recent completed matches |
| GET | `/api/feed?days=N&minGp=M` | Bridge payload for GGBetAnalyzer |
| GET | `/api/h2h?p1=X&p2=Y&limit=20` | Head-to-head record from permanent archive |
| GET | `/api/history?limit=200` | Recent rows from permanent game archive |

---

## Environment variables reference

### Scraper (`scraper/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `H2HGGL_API_BASE` | `https://api-h2h.hudstats.com/v1` | h2hggl JSON API root |
| `H2HGGL_URL_SPORT` | `ebasketball` | Sport key (`ebasketball` / `esoccer` / `eamericanfootball`) |
| `H2HGGL_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `H2HGGL_CACHE_TTL` | `300` | In-memory cache TTL in seconds |
| `H2HGGL_REFRESH_GAMES_MIN` | `10` | Background game-refresh interval (0 = off) |
| `H2HGGL_REFRESH_PLAYERS_MIN` | `30` | Background player-refresh interval (0 = off) |
| `H2HGGL_FEED_DAYS` | `14` | Days of history to keep warm |
| `H2HGGL_ARCHIVE_DAYS` | `90` | Days fetched by nightly deep-archive job |
| `H2HGGL_DB_PATH` | `./h2hgg.db` | SQLite file path |
| `H2HGGL_POLITE_DELAY_MS` | `800` | Minimum gap between source requests |
| `H2HGGL_REQUEST_TIMEOUT` | `25` | HTTP request timeout in seconds |

### Next.js app (`ggbet-analyzer/.env.local`)

| Variable | Default | Description |
|----------|---------|-------------|
| `H2HGGL_API_URL` | `http://localhost:8000` | Base URL of the scraper service |
| `BETSAPI_TOKEN` | *(unset)* | Optional BetsAPI token (fallback source) |

---

## Troubleshooting

**"Connection refused" when fetching from the app**
- Make sure the scraper is running (`curl http://localhost:8000/health`).
- Check `H2HGGL_API_URL` in `.env.local` matches the scraper port.

**CORS error in browser DevTools**
- The Next.js app calls the scraper server-side, so browser CORS doesn't apply.
  If you see CORS errors, you're calling the scraper directly from client code.

**First fetch is slow (5–10 s)**
- The first request triggers a live scrape. After that, responses come from
  the in-memory cache and are instant. The scheduler keeps the cache warm.

**Players have 0 games / walk-forward is empty**
- The GG League runs continuously — if data is missing, try increasing `days`:
  `curl "http://localhost:8000/api/feed?days=30"`.

**Docker: "permission denied" on `/data`**
- The image runs as a non-root user. Make sure you haven't bind-mounted
  a host directory with root-only permissions; use the named volume instead
  (the default `docker-compose.yml` does this correctly).

**Vercel deploy fails with "module not found"**
- Confirm the **Root Directory** is set to `ggbet-analyzer` in the Vercel project
  settings, not the repo root.

---

## Optional: Python toolchain

The repo also includes standalone Python scripts at the repo root for offline
analysis and bulk data work.

**Bulk fetch (original Python script, requires a BetsAPI token):**
```bash
pip install requests
export BETSAPI_TOKEN=your_token_here
python3 "ggba betsapi.py" --days 30
# Outputs CSVs to ./ggba_data/ → import via Data Manager's "Import CSV" buttons
```

**Walk-forward backtest (offline, no token needed):**
```bash
python3 "ggba model.py" --csv ggba_data/ggba_walkforward.csv
```

**Run tests:**
```bash
python3 -m pytest "test ggba.py" -v
```
