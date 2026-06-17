# spec-journey-gg — GGBetAnalyzer

Betting-analytics tooling for the eBasketball **H2H GG League** (NBA 2K, 4×5-min).

## Free data acquisition (h2hggl.com)

Previously the only wired data source was BetsAPI (paid, no free tier), and even
that left `fg_pct`, `steals`, `fouls`, and `division` blank. This repo now ships a
**free, self-hosted scraper + REST API** that replaces it as the primary source
and fills in those missing fields.

- **`scraper/`** — a standalone Python service (FastAPI + SQLite + APScheduler,
  Dockerized) that reads h2hggl.com's open internal JSON API, normalizes it into
  GGBetAnalyzer's `{ walkforward, players, matches, meta }` shape, caches it, and
  refreshes on a schedule. See [`scraper/README.md`](scraper/README.md).
- **`ggbet-analyzer/`** — the Next.js app. It now defaults to the free **H2H GG
  League** source via `/api/h2hggl-games` (proxying the scraper at
  `H2HGGL_API_URL`); BetsAPI remains selectable as an optional fallback.

### Quick start

```bash
# 1) Run the free data service
cd scraper && pip install -r requirements.txt && uvicorn app.main:app --port 8000

# 2) Run the app pointed at it
cd ggbet-analyzer && npm install && H2HGGL_API_URL=http://localhost:8000 npm run dev
# open http://localhost:3000 → Data Manager → "Fetch live data" (source: H2H GG League)
```

Other files at the repo root (`GGBetAnalyzer.ts`, `ggba *.py`, the system
documentation, and `ggbet-analyzer.zip`) are the original artifact, Python
toolchain, and the pre-extraction archive of the Next.js project.
