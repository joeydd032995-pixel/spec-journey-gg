# GGBetAnalyzer Next.js App — Setup Guide

This is the analytics dashboard. For full end-to-end setup including the
free data service, see the [root SETUP.md](../SETUP.md).

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 + |
| npm | 9 + |
| Running scraper service | see [`scraper/`](../scraper/README.md) |

---

## 1 — Install dependencies

```bash
cd ggbet-analyzer
npm install
```

---

## 2 — Configure environment

Create `.env.local` in this directory:

```env
# URL of the running scraper service (no trailing slash)
H2HGGL_API_URL=http://localhost:8000

# Optional: BetsAPI token (only needed if you want the BetsAPI fallback source)
# BETSAPI_TOKEN=your_token_here
```

The scraper must be running before you start the app. See the
[root SETUP.md](../SETUP.md) for how to start it.

---

## 3 — Run locally

```bash
npm run dev
```

Open **http://localhost:3000**.

- Go to **Data Manager** → **"Fetch live data"** (source: H2H GG League).
- Players, walk-forward rows, and matches will populate within a few seconds.
- The `fg_pct`, `steals`, `fouls`, and `division` columns are now fully populated
  (previously blank with BetsAPI).

---

## 4 — Build for production

```bash
npm run build
npm start
```

---

## 5 — Deploy to Vercel

1. Push the repo to GitHub.
2. Go to https://vercel.com/new → **Import Git Repository**.
3. Set **Root Directory** to `ggbet-analyzer`.
4. Add environment variables:
   - `H2HGGL_API_URL` → public URL of your deployed scraper service
   - `BETSAPI_TOKEN` → optional BetsAPI token
5. Click **Deploy**.

> **Hobby tier:** API timeouts are 10 s. Scraper responses are served from
> cache and typically complete in < 1 s, so this is not an issue in practice.

---

## API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/h2hggl-games` | GET / POST | Proxies `/api/feed` from the scraper; returns `{ walkforward, players, matches, meta }` |
| `/api/fetch-games` | GET / POST | BetsAPI fallback (requires `BETSAPI_TOKEN`) |
| `/api/upcoming` | GET | Upcoming fixtures (`?source=h2hggl` or `?source=betsapi`) |

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `H2HGGL_API_URL` | `http://localhost:8000` | Base URL of the scraper service |
| `BETSAPI_TOKEN` | *(unset)* | Optional BetsAPI token for the fallback source |

---

## File reference

| File | Purpose |
|------|---------|
| `components/GGBetAnalyzer.tsx` | Main React dashboard (all tabs) |
| `app/api/h2hggl-games/route.ts` | H2H GG League data endpoint (primary) |
| `app/api/fetch-games/route.ts` | BetsAPI data endpoint (fallback) |
| `app/api/upcoming/route.ts` | Upcoming fixtures endpoint |
| `lib/h2hggl.ts` | Scraper service client + TypeScript types |
| `lib/betsapi.ts` | BetsAPI client + walk-forward builder utilities |

---

## Troubleshooting

**"H2HGGL service 502" or "Connection refused"**
The scraper isn't running. Start it first:
```bash
cd ../scraper
uvicorn app.main:app --port 8000
```

**Dashboard loads but no data appears**
Check that `H2HGGL_API_URL` in `.env.local` is correct and the scraper health
check passes: `curl http://localhost:8000/health`

**`fg_pct` / `steals` / `fouls` show as blank**
These fields come from the scraper (h2hggl source), not BetsAPI. Make sure
you're fetching from the **H2H GG League** source, not BetsAPI.

**Vercel: "cannot find module"**
Confirm the Vercel project's **Root Directory** is set to `ggbet-analyzer`,
not the repo root.
