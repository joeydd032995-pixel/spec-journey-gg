# GGBetAnalyzer — Vercel Setup Guide

Full-stack deployment of the eBasketball H2H GG League analytics tool:
React dashboard on the frontend, TypeScript API routes on the backend that
call BetsAPI server-side (token never touches the browser).

---

## What you're deploying

```
Browser (React)  ←→  Vercel (Next.js API routes)  ←→  BetsAPI
                              ↓
                     BETSAPI_TOKEN (env var, server-only)
```

- `/` — the full GGBetAnalyzer React dashboard (walk-forward model, line
  shopping, CLV tracking, bet logger)
- `/api/fetch-games` — POST endpoint: fetches ended GG League events from
  BetsAPI, builds walk-forward snapshots, returns players + matches + WF rows
- `/api/upcoming` — GET endpoint: returns tonight's upcoming fixtures

Data is persisted in browser `localStorage` (no database needed for MVP).

---

## Prerequisites

| Requirement | Where to get it |
|---|---|
| Node.js 18+ | https://nodejs.org |
| A Vercel account | https://vercel.com (free Hobby tier works) |
| A BetsAPI token | https://betsapi.com — sign up, get your API token |
| Git | https://git-scm.com |

---

## Step 1 — Get the code

### Option A: Clone from a repo (if you've pushed it)
```bash
git clone https://github.com/YOUR_USERNAME/ggbet-analyzer
cd ggbet-analyzer
```

### Option B: Start from the downloaded files
```bash
mkdir ggbet-analyzer
cd ggbet-analyzer
# Copy all files from the download into this directory, preserving the folder structure
```

Folder structure should look like this:
```
ggbet-analyzer/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   └── api/
│       ├── fetch-games/route.ts
│       └── upcoming/route.ts
├── components/
│   └── GGBetAnalyzer.tsx
├── lib/
│   └── betsapi.ts
├── package.json
├── next.config.mjs
├── tsconfig.json
├── vercel.json
└── .env.local.example
```

---

## Step 2 — Install dependencies

```bash
npm install
```

This installs:
- `next` + `react` + `react-dom` (the framework)
- `recharts` (charts)
- `papaparse` (CSV parsing)
- `lucide-react` (icons)

---

## Step 3 — Configure your environment

```bash
cp .env.local.example .env.local
```

Open `.env.local` in your editor and fill in your BetsAPI token:

```bash
BETSAPI_TOKEN=your_actual_token_here
```

> **.env.local is never committed to git** — it's in `.gitignore` by default
> in Next.js projects. Your token stays local and is only added to Vercel
> explicitly in Step 5.

---

## Step 4 — Test locally

```bash
npm run dev
```

Open http://localhost:3000

You should see the GGBetAnalyzer dashboard. Test the fetch:
- Go to the **Data Manager** tab
- Find the **"⬇ Fetch from BetsAPI"** card at the top
- Select "7 days", click **Fetch data**
- Wait 5-30 seconds depending on volume
- You should see players, matches, and walk-forward rows populate

If you get a token error, check your `.env.local` file.

---

## Step 5 — Deploy to Vercel

### 5a — Push to GitHub (recommended)

```bash
git init
git add .
git commit -m "initial GGBetAnalyzer deployment"
git remote add origin https://github.com/YOUR_USERNAME/ggbet-analyzer.git
git push -u origin main
```

### 5b — Deploy via Vercel dashboard

1. Go to https://vercel.com/new
2. Click **"Import Git Repository"**
3. Select your `ggbet-analyzer` repo
4. Under **"Environment Variables"**, click **"Add"**:
   - **Name**: `BETSAPI_TOKEN`
   - **Value**: your token
   - **Environment**: check Production, Preview, Development
5. Click **"Deploy"**

Vercel will build and deploy. Takes ~60 seconds. You'll get a URL like
`https://ggbet-analyzer-xyz.vercel.app`.

### Alternative: Deploy via Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
# Follow the prompts; when asked about env vars, paste your token
```

---

## Step 6 — Verify the live deployment

1. Open your Vercel URL
2. Go to **Data Manager → "⬇ Fetch from BetsAPI"**
3. Set days to 14, click **Fetch data**
4. Confirm players and walk-forward data populate
5. Open **Historical Insights** — you should see the walk-forward backtest
   with correlation and +EV stats
6. Run a matchup in the **Matchup Analyzer** tab

---

## Using the fetcher

### From the dashboard (recommended)
In **Data Manager**, use the "Fetch from BetsAPI" card. Settings:
- **7 days** — quick check, last week's results
- **14–30 days** — recommended for a usable backtest
- **60–90 days** — maximum history for robust model training

Fetched data merges with existing data (no duplicates). To reset, clear
each section with its "Clear" button.

### From the CLI (optional — runs original Python script)

If you want to run the Python script for bulk downloads or automation:

```bash
pip install requests

export BETSAPI_TOKEN=your_token_here

# Fetch last 30 days, output to ./ggba_data/
python3 ggba_betsapi.py --days 30

# Outputs:
# ./ggba_data/ggba_players.csv   → import in Data Manager > Player Roster
# ./ggba_data/ggba_matches.csv   → import in Data Manager > Match History
# ./ggba_walkforward.csv         → import in Data Manager > Walk-forward snapshots

# Then import those CSVs in the dashboard via the "Import CSV" buttons
```

### Backtest (Python, offline)
```bash
# Run the walk-forward backtest on your fetched data
python3 ggba_model.py --csv ggba_data/ggba_walkforward.csv
```

---

## Vercel plan considerations

| Feature | Hobby (free) | Pro ($20/mo) |
|---|---|---|
| API route timeout | **10 seconds** | **60 seconds** |
| Recommended max days | 7 days | 30–90 days |
| Custom domain | ✓ | ✓ |
| Analytics | — | ✓ |

**Important for Hobby tier**: The BetsAPI fetch can time out on large date
ranges. Stick to 7 days per fetch and repeat if needed (data merges without
duplicates). Or upgrade to Pro for 60-second timeouts.

To configure the timeout:
```json
// vercel.json (already included)
{
  "functions": {
    "app/api/fetch-games/route.ts": { "maxDuration": 60 }
  }
}
```

---

## Keeping data fresh

### Option A: Manual (simplest)
Click "Fetch data" in the dashboard before each session. Data persists in
localStorage between visits.

### Option B: GitHub Actions cron (automated)

Create `.github/workflows/fetch-data.yml`:

```yaml
name: Fetch GG League data daily

on:
  schedule:
    - cron: '0 6 * * *'   # 6 AM UTC daily
  workflow_dispatch:        # allow manual trigger

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install requests
      - run: python ggba_betsapi.py --days 2
        env:
          BETSAPI_TOKEN: ${{ secrets.BETSAPI_TOKEN }}
      - name: Commit updated data
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add ggba_data/
          git diff --staged --quiet || git commit -m "data: daily GG League fetch $(date -u +%Y-%m-%d)"
          git push
```

Add `BETSAPI_TOKEN` to your GitHub repo's Settings → Secrets and variables →
Actions.

---

## Troubleshooting

### "BETSAPI_TOKEN not configured"
- **Local**: check `.env.local` exists and has the right key name
- **Vercel**: go to your project → Settings → Environment Variables → confirm
  `BETSAPI_TOKEN` is set for Production

### Fetch times out (Hobby tier)
- Use 7 days or fewer per fetch
- Or upgrade to Vercel Pro for 60-second timeouts
- Or run `ggba_betsapi.py` locally and import the CSV files manually

### "No ended events found"
- The GG League runs continuously; if you see 0 games, double-check your
  `leagueId` (should be 25067) and that your token has access
- Try `GET /api/fetch-games?days=1` directly in your browser to see the raw
  API response

### Walk-forward shows "Not enough data"
- The model requires both players to have ≥ 10 prior games (configurable
  in Settings)
- Fetch more history (30+ days recommended for the backtest to be meaningful)

### Data isn't persisting between visits
- GGBetAnalyzer stores data in `localStorage` under the keys `ggba:*`
- Open browser DevTools → Application → Local Storage to verify
- Some browsers clear localStorage in private/incognito mode

---

## Environment variables reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETSAPI_TOKEN` | ✓ | — | Your BetsAPI authentication token |
| `GG_LEAGUE_ID` | — | `25067` | Override the GG League ID |
| `GG_SPORT_ID` | — | `18` | Override the sport ID (18 = Basketball) |

---

## File reference

| File | Purpose |
|---|---|
| `components/GGBetAnalyzer.tsx` | Main React dashboard (all tabs) |
| `app/api/fetch-games/route.ts` | BetsAPI → walk-forward data endpoint |
| `app/api/upcoming/route.ts` | Tonight's fixtures endpoint |
| `lib/betsapi.ts` | BetsAPI client + data-building utilities |
| `ggba_model.py` | Offline Python backtester (same math as the dashboard) |
| `ggba_betsapi.py` | Offline Python fetcher (bulk downloads) |
| `test_ggba.py` | 23-test Python test suite (`python3 -m unittest test_ggga -v`) |
| `ggba_SYNTHETIC_demo_walkforward.csv` | Synthetic demo data (clearly labeled) |

---

## Architecture notes

The model runs entirely client-side in the browser — no server compute is
needed for projections, EV, Kelly, CLV, or the walk-forward backtest. The only
server-side work is the BetsAPI fetch (to keep the token off the client).

This means:
- No database needed for MVP (localStorage holds everything)
- The Vercel serverless functions are stateless — each fetch is independent
- You can export your bets as CSV at any time from the Bet Logger
- If localStorage gets full (~5MB), export and clear, then re-import

For a production setup with multiple users or shared data, add Vercel
Postgres (or Neon) and swap the localStorage calls for API reads/writes.
