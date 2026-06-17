# H2H GG Analyzer

Betting-analytics tooling for the eBasketball **H2H GG League** (NBA 2K, 4×5-min).
Pulls live data from h2hggl.com's open JSON API — **no auth, no API key, no server required**.

---

## What's in the repo

| Path | What it is |
|------|-----------|
| `ggba_gui.py` | **Standalone desktop app** — tkinter GUI with six tabs (Players, Standings, H2H, Matchup, Analyze, Export). No server needed. |
| `ggba_h2hggl.py` | **Standalone CLI** — same data, terminal output. One dependency: `httpx`. |
| `build_exe.bat` | One-click Windows build script (PyInstaller → `dist/H2H_GG_Analyzer.exe`). |
| `ggba_gui.spec` | PyInstaller spec for the above. |
| `scraper/` | Advanced: FastAPI + SQLite data service (Dockerized). |
| `ggbet-analyzer/` | Advanced: Next.js analytics dashboard (calls the scraper). |
| `GGBetAnalyzer.ts` | Original standalone React artifact (single-file, browser-only). |
| `ggba betsapi.py` | Python bulk-fetch script for BetsAPI (requires paid token). |
| `ggba model.py` | Offline Python walk-forward backtester. |

---

## Standalone Desktop App (recommended)

The GUI and CLI work without any server — they call h2hggl.com's API directly.

### Requirements

| Tool | Version |
|------|---------|
| Python | 3.11 + |
| pip | 23 + |

> **Windows users:** you can skip Python entirely by downloading the pre-built
> `H2H_GG_Analyzer.exe` from the [Releases](../../releases) page and running it directly.

---

### Option A — Run from source (all platforms)

**1. Clone the repo**

```bash
git clone https://github.com/joeydd032995-pixel/spec-journey-gg.git
cd spec-journey-gg
```

**2. Create a virtual environment and install the one dependency**

```bash
python -m venv .venv

# Windows (Git Bash or PowerShell)
source .venv/Scripts/activate      # Git Bash
# .venv\Scripts\activate           # PowerShell / cmd.exe

# macOS / Linux
source .venv/bin/activate
```

```bash
pip install httpx
```

**3. Launch the GUI**

```bash
python ggba_gui.py
```

The window opens immediately. All data loads in the background when you click a button — no waiting before you start.

---

### Option B — Windows .exe (no Python needed)

**Build it yourself (one command):**

```bat
build_exe.bat
```

Requires Python + pip to be on your PATH. The script installs PyInstaller and `httpx`, then builds `dist\H2H_GG_Analyzer.exe`. Double-click to run.

---

## GUI — Tab Reference

| Tab | What it does |
|-----|-------------|
| **Players** | Full roster with GP, Win%, PPM, FG%, Steals, Fouls. Filter by name or minimum games played. |
| **Standings** | League table ranked by win percentage. |
| **H2H** | Head-to-head record between two players. Select a matchup from the dropdown, choose a date range, and click **Load H2H**. |
| **Matchup** | Full matchup analysis: individual stats, **Score Prediction Bands** (±0.5σ tight band with empirical confidence for Total/Home/Away), **PPM Model** (season averages vs H2H averages), win%-based edge, and the last 25 H2H games. |
| **Analyze** | Walk-forward model accuracy summary over a configurable day range. |
| **Export** | Save all data (players, standings, schedule, H2H games, walk-forward) to CSV files in `./ggba_data/`. |

### Using the Matchup tab

1. Open the **Matchup** tab.
2. Select a player pair from the **Matchup** dropdown (all known pairs appear automatically once the Players tab has loaded, or click the dropdown to populate).
3. Adjust **Days** (default 30) if you want more/less H2H history.
4. Click **Analyze**.

The output shows two separate sections side-by-side in the result pane:

```
  Score Prediction Bands  (±0.5σ tight band, empirical confidence)
  ──────────────────────────────────────────────────────────────────
                       Mean     Std    Band               Conf
  Total  (both)       214.3    18.5   [205.1 – 223.5]    67%
  Home   (PlayerA)    112.1     9.8   [107.2 – 117.0]    58%
  Away   (PlayerB)    102.2    11.4   [ 96.5 – 107.9]    75%

  PPM Model  (season scoring averages)
  ──────────────────────────────────────────────────────────────────
                        PPM     H2H Avg    Diff
  Total  (both)        218.4    214.3     +4.1
  Home   (PlayerA)     115.2    112.1     +3.1
  Away   (PlayerB)     103.2    102.2     +1.0
```

- **Score Prediction Bands** — empirical ±0.5σ range based on actual H2H games. Confidence = fraction of past games that landed inside the band.
- **PPM Model** — season-average points-per-match for each player, compared against their H2H average. A positive Diff means the season PPM is tracking above their H2H history.

---

## CLI Reference

The same data is available in the terminal without opening the GUI:

```bash
# Activate your virtual environment first
source .venv/Scripts/activate   # Windows Git Bash
source .venv/bin/activate       # macOS / Linux

# Then run any command
python ggba_h2hggl.py <command> [options]
```

### Commands

| Command | Description | Example |
|---------|-------------|---------|
| `players` | Full roster with stats | `python ggba_h2hggl.py players` |
| `standings` | League standings | `python ggba_h2hggl.py standings` |
| `schedule` | Upcoming fixtures | `python ggba_h2hggl.py schedule --days 3` |
| `h2h P1 P2` | Head-to-head record | `python ggba_h2hggl.py h2h "PlayerA" "PlayerB" --days 60` |
| `matchup P1 P2` | Full matchup analysis with bands + PPM | `python ggba_h2hggl.py matchup "PlayerA" "PlayerB" --days 30` |
| `analyze` | Walk-forward model accuracy | `python ggba_h2hggl.py analyze --days 30` |
| `export` | Save all data to CSV | `python ggba_h2hggl.py export --out ./ggba_data` |

### Common flags

| Flag | Default | Applies to |
|------|---------|-----------|
| `--days N` | 30–60 | h2h, matchup, analyze, export, schedule |
| `--min-gp N` | 1 | players, export |
| `--filter TEXT` | (none) | players |
| `--out DIR` | `./ggba_data` | export |

Player names are **case-insensitive** and matched by exact name. Use `players` first to see the full roster.

---

## Building the Windows .exe

**Prerequisites:** Python 3.11+ and pip on your PATH (the script installs everything else).

```bat
REM Run from the repo root (the folder containing ggba_gui.py)
build_exe.bat
```

Output: `dist\H2H_GG_Analyzer.exe` — single file, no console window, no Python install required on the end-user machine.

To build manually:

```bash
pip install pyinstaller httpx
pyinstaller ggba_gui.spec
```

---

## Advanced: Web Dashboard

The repo also contains a full web stack for more advanced analytics. This is optional — the GUI and CLI above cover the same data without any server.

**Requirements:** Python 3.11+, Node.js 18+

```bash
# Terminal 1 — start the data service
cd scraper
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000

# Terminal 2 — start the dashboard
cd ggbet-analyzer
npm install
echo "H2HGGL_API_URL=http://localhost:8000" > .env.local
npm run dev
```

Open **http://localhost:3000** → Data Manager → "Fetch live data".

For Docker, Vercel deployment, and full configuration, see **[SETUP.md](SETUP.md)**.

### Scraper API endpoints

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

---

## Troubleshooting

**`ModuleNotFoundError: No module named 'httpx'`**
Run `pip install httpx` inside your activated virtual environment.

**`.venv/bin/activate: No such file or directory` (Windows Git Bash)**
Use `source .venv/Scripts/activate` (note `Scripts`, not `bin`).

**Player names not found in `h2h` / `matchup`**
Run `python ggba_h2hggl.py players` to see exact names, then copy-paste them.

**Matchup shows "insufficient H2H data"**
The two players haven't met enough times in the selected window. Try `--days 90` or `--days 180` to expand the search.

**GUI window doesn't open / crashes immediately (Windows)**
Make sure `ggba_h2hggl.py` is in the same folder as `ggba_gui.py`. The GUI imports from it at startup.

**First fetch is slow (3–8 s)**
The first request goes live to h2hggl.com. Subsequent calls in the same session are much faster.
