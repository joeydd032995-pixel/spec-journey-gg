# GGBetAnalyzer

Betting-analytics tooling for the eBasketball **H2H GG League** (NBA 2K, 4×5-min).

---

## What's in the repo

| Path | What it is |
|------|-----------|
| `scraper/` | Free data-acquisition service (FastAPI + SQLite + APScheduler, Dockerized). Reads h2hggl.com's open internal JSON API and serves normalized data at `localhost:8000`. |
| `ggbet-analyzer/` | Next.js analytics dashboard. Walk-forward model, matchup analyzer, line shopping, CLV tracking, bet logger. Calls the scraper server-side; BetsAPI is an optional fallback. |
| `GGBetAnalyzer.ts` | Original standalone React artifact (single-file, browser-only). |
| `ggba betsapi.py` | Python bulk-fetch script for BetsAPI (requires token). |
| `ggba model.py` | Offline Python walk-forward backtester. |
| `GGBetAnalyzer SYSTEM DOCUMENTATION.md` | System-level design notes. |

---

## Free data — no paid API key required

The scraper pulls from h2hggl.com's **open internal JSON API** (discovered by
inspecting the site bundle — no auth, no scraping). It fills in the stat fields
that the old BetsAPI feed left permanently blank:

| Field | BetsAPI | h2hggl scraper |
|-------|---------|----------------|
| `fg_pct` | `""` | real value |
| `steals` | `""` | real value |
| `fouls` | `""` | real value |
| `division` | `""` | real value |

The scraper also maintains a permanent `game_history` archive and exposes a
head-to-head record endpoint (`/api/h2h`).

---

## Quick start (5 minutes)

**Requirements:** Python 3.11+, Node.js 18+

```bash
# Clone
git clone https://github.com/joeydd032995-pixel/spec-journey-gg.git
cd spec-journey-gg

# Terminal 1 — start the free data service
cd scraper
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000

# Terminal 2 — start the dashboard
cd ggbet-analyzer
npm install
echo "H2HGGL_API_URL=http://localhost:8000" > .env.local
npm run dev
```

Open **http://localhost:3000** → Data Manager → "Fetch live data" (H2H GG League).

For Docker, full Vercel deployment, and everything else, see **[SETUP.md](SETUP.md)**.

---

## Scraper API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness check |
| `GET /api/standings` | Participants ranked by win % |
| `GET /api/players?minGp=N` | Full roster with FG%/steals/fouls |
| `GET /api/players/{player_id}` | Single player lookup |
| `GET /api/schedule?days=N` | Upcoming fixtures |
| `GET /api/games?days=N` | Recent completed matches |
| `GET /api/feed?days=N&minGp=M` | Bridge payload `{ walkforward, players, matches, meta }` |
| `GET /api/h2h?p1=X&p2=Y&limit=20` | Head-to-head record |
| `GET /api/history?limit=200` | Permanent game archive |

Scraper-specific docs: [`scraper/README.md`](scraper/README.md)
