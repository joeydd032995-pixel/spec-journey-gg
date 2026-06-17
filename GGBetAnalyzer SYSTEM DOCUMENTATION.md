# GGBetAnalyzer — System Documentation

**A betting-analytics terminal for the eBasketball H2H GG League (NBA 2K, 4×5-minute quarters)**

This document is a complete technical reference for everything built across this project: the original browser artifact, its full-stack Vercel port, the Python toolchain, the data-acquisition layer, and the statistical methodology underneath all of it. It is meant to be read once for orientation and then used as a lookup reference.

-----

## 1. What this program is and what it’s for

GGBetAnalyzer is a self-contained analytics tool for betting on the **eBasketball H2H GG League** — a continuously-running NBA 2K esport where professional gamers play 4×5-minute matches as named NBA teams (e.g. “DEN Nuggets (LANES)” means player **LANES** playing as the **Denver Nuggets** skin). Games complete every few minutes, around the clock, which makes this market simultaneously data-rich (thousands of games available) and historically under-modeled (most retail bettors treat it as a side market and price it loosely).

The program’s job is to take in match history for this league and produce three things a bettor actually needs: a **projection** of the next game’s total score and win probability, an **edge calculation** against a sportsbook’s posted line (is this a +EV bet, and how big), and a **performance ledger** that tracks whether bets actually beat the closing line over time (CLV), which is the most reliable signal of real skill versus variance.

It exists in two parallel forms that share the same mathematical core:

1. **The artifact** (`GGBetAnalyzer.jsx`) — a single self-contained React component meant to run inside Claude’s artifact environment or any React host. No backend; all data lives in browser storage.
1. **The Vercel deployment** (`ggbet-analyzer/`) — a full Next.js application that adds server-side API routes so the tool can pull live data from external sports-data APIs without exposing API keys to the browser, and can be deployed as a real hosted website.

Both forms run the *identical* projection, EV, Kelly, de-vig, CLV, and rating-model math — the Next.js version is not a rewrite, it’s the same logic wrapped in a deployable shell with a data-fetching layer bolted on.

-----

## 2. Two codebases, one brain

```
┌─────────────────────────────────────────────────────────────────────┐
│  SHARED MATHEMATICAL CORE (re-implemented identically 3 times)        │
│  • erf / normal CDF          • P(Over) with continuity correction     │
│  • empirical-Bayes shrinkage • baseline ppm projector                 │
│  • online opponent+team      • American-odds EV / Kelly               │
│    rating model (SGD)        • two-way de-vig                          │
│  • walk-forward backtest     • closing-line value (CLV)                │
│  • calibration (ECE/Brier)   • best-price line shopping                │
└─────────────────────────────────────────────────────────────────────┘
        │                              │                          │
        ▼                              ▼                          ▼
┌───────────────────┐      ┌─────────────────────────┐   ┌──────────────────┐
│  GGBetAnalyzer.jsx │      │  ggba_model.py           │   │ components/      │
│  (browser artifact)│      │  ggba_betsapi.py         │   │ GGBetAnalyzer.tsx│
│                    │      │  test_ggba.py            │   │  (Next.js port)  │
│  Pure client-side  │      │                          │   │                  │
│  JS. No server.    │      │  Offline CLI tools +     │   │  Same math, ported│
│  Data via browser  │      │  unit-tested reference   │   │  to TS, deployed  │
│  storage.          │      │  implementation.         │   │  on Vercel with   │
│                    │      │                          │   │  server-side API  │
└───────────────────┘      └─────────────────────────┘   │  routes.          │
                                                            └──────────────────┘
```

The Python module (`ggba_model.py`) is the **validation reference**: every formula in the JSX/TSX was cross-checked against it numerically (Node scripts compared outputs to ~6 decimal places) and `test_ggba.py` unit-tests the Python version with 23 tests. Because JS and Python implement the same arithmetic, a passing Python test suite is strong evidence the browser math is also correct — this was the actual TDD loop used during development: write the formula in Python, test it, then port the verified formula into JSX/TSX by hand and re-verify numerically.

-----

## 3. File-by-file structure

### 3.1 Standalone artifact bundle (`/mnt/user-data/outputs/`)

|File                                 |Type                   |Lines     |Purpose                                                                                                                                                                                                                            |
|-------------------------------------|-----------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`GGBetAnalyzer.jsx`                  |React component (JSX)  |1,864     |The complete browser application — every tab, every chart, every formula, in one file. No imports outside `react`, `papaparse`, `recharts`, `lucide-react`.                                                                        |
|`ggba_model.py`                      |Python 3 module + CLI  |462       |Stdlib-only (no pip deps) reimplementation of the rating model, baseline projector, EV/Kelly, de-vig/CLV, and a walk-forward backtester with a synthetic-data self-test. Runnable directly: `python3 ggba_model.py --csv data.csv`.|
|`ggba_betsapi.py`                    |Python 3 CLI script    |367       |Talks to the BetsAPI REST service, paginates through ended GG League events, and writes three CSVs (players, matches, walk-forward) to disk. Requires `requests` and a `BETSAPI_TOKEN`.                                            |
|`test_ggba.py`                       |Python `unittest` suite|206       |23 tests across 7 test classes covering every pure function in `ggba_model.py`, plus four “acceptance gate” tests that assert the rated model beats the baseline on correlation, accuracy, +EV, and win-rate.                      |
|`ggba_SYNTHETIC_demo_walkforward.csv`|Data file (CSV)        |4,924 rows|**Fabricated** demonstration data with injected player/team/pace structure, clearly named so it’s never mistaken for real results. Lets the dashboard demo its own backtest before a user has live data.                           |
|`ggbet-analyzer.zip`                 |Archive                |—         |Zipped copy of the entire Next.js project tree (§3.2), for download/deployment.                                                                                                                                                    |

### 3.2 Next.js / Vercel project (`ggbet-analyzer/`, zipped above)

```
ggbet-analyzer/
├── app/
│   ├── layout.tsx                       Root HTML shell, Google Fonts (Archivo, JetBrains Mono)
│   ├── page.tsx                         Home route — renders <GGBetAnalyzer/>
│   └── api/
│       ├── fetch-games/route.ts         POST — BetsAPI fetch → walk-forward + players + matches
│       ├── apisports-games/route.ts     POST — API-Sports (free tier) fetch, same output shape
│       ├── probe-sources/route.ts       GET  — tests every configured data source, reports coverage
│       └── upcoming/route.ts            GET  — tonight's fixtures (BetsAPI)
├── components/
│   └── GGBetAnalyzer.tsx                The ported dashboard (2,069 lines) — 'use client', localStorage-backed
├── lib/
│   ├── betsapi.ts                       BetsAPI HTTP client + shared data-shaping functions (279 lines)
│   └── apisports.ts                     API-Sports HTTP client, league auto-discovery (236 lines)
├── package.json                         next 14.2.5, react 18.3, recharts, papaparse, lucide-react
├── next.config.mjs                      Minimal Next config
├── tsconfig.json                        Strict TS, path alias @/*
├── vercel.json                          Per-route maxDuration overrides (60s for fetch routes)
├── .env.local.example                   Documents every env var (tokens/keys), all server-only
├── .gitignore                           Excludes node_modules, .next, .env.local, ggba_data/
└── SETUP.md                             Step-by-step deployment guide (local dev → GitHub → Vercel)
```

**Why this split exists:** Next.js’s App Router distinguishes server code (`app/api/*/route.ts`, `lib/*.ts`) from client code (`components/*.tsx` marked `'use client'`). API keys and tokens are read from `process.env` only inside the `app/api` route handlers and `lib/*.ts` files, which execute on Vercel’s servers — they are never bundled into the JavaScript sent to the browser. The component itself never sees a raw token; it only calls same-origin endpoints like `/api/fetch-games` and receives already-built JSON.

### 3.3 Extensions and file types in play

|Extension|Role                                                                                                                                                                          |
|---------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`.jsx`   |The standalone artifact — JSX requires a build step (Babel) to run as plain JS, which is what the artifact host or any bundler provides.                                      |
|`.tsx`   |TypeScript + JSX — same syntax as `.jsx` plus type annotations, used for the Next.js client component.                                                                        |
|`.ts`    |Pure TypeScript, no JSX — used for server-only library code and API routes.                                                                                                   |
|`.py`    |Python 3, stdlib-only — the offline/CLI half of the toolchain.                                                                                                                |
|`.csv`   |Tabular data interchange format — used for both the synthetic demo data and as the import/export format for players, matches, and walk-forward rows inside the app.           |
|`.json`  |Configuration (`package.json`, `tsconfig.json`, `vercel.json`) and the wire format for every API response.                                                                    |
|`.md`    |Documentation (`SETUP.md`, this file).                                                                                                                                        |
|`.mjs`   |ES-module JavaScript — `next.config.mjs` uses the `.mjs` extension specifically so Node treats it as an ES module regardless of the project’s `package.json` `"type"` setting.|

-----

## 4. Execution flow / workflow

### 4.1 Data acquisition (where the numbers come from)

There are three ways data enters the system, and all three converge on the same internal shape:

**Manual entry / CSV import** — a user types in a player row (name, win%, points-per-match, FG%, steals, fouls, games-played, recent form string like `"WWLWL"`, NBA team skin) or pastes a CSV matching `CSV_COLS`. This is the lowest-friction path and requires no API key.

**Walk-forward CSV import** — a separate, richer CSV format (`WF_COLS`) containing one row *per historical game*, with each player’s stats as they stood **immediately before** that game was played (a “pre-match snapshot”). This is the format the backtest engine consumes, and it’s the format both Python and TypeScript fetchers build automatically from raw game results.

**Live API fetch** — in the Vercel deployment, a “Probe sources → Fetch” UI flow calls a server-side route, which calls an external sports-data API, retrieves raw game results, and runs them through the *exact same* walk-forward-builder logic as the offline Python script (`buildWalkforward()` in `lib/betsapi.ts` is a line-for-line TypeScript port of `build_walkforward()` in `ggba_betsapi.py`).

```
  Raw game result                    Pre-match snapshot construction (leakage-free)
┌─────────────────────┐              ┌──────────────────────────────────────────┐
│ "DEN Nuggets (LANES)"│              │ For game N, look only at games 1..N-1     │
│ vs                   │   ────────▶  │ for both players: compute running        │
│ "LA Lakers (WAVE)"   │              │ win%, points/game, and a 5-game form      │
│ score: 62-58         │              │ string. THEN record the actual score.     │
│ timestamp: …         │              │ THEN (only after) update both players'    │
└─────────────────────┘              │ running stats with this game's result.    │
                                      └──────────────────────────────────────────┘
```

This “predict-before-update” ordering is the single most important invariant in the whole codebase — it’s what makes the backtest a legitimate **out-of-sample** test rather than a model grading itself on data it already memorized. It’s enforced identically in three places: `wfb` (the `useMemo` walk-forward engine inside the JSX/TSX `Insights` component), `walk_forward()` in `ggba_model.py`, and `build_walkforward()` / `buildWalkforward()` in the two fetchers.

### 4.2 The Vercel multi-source fetch flow

```
Browser: Data Manager tab
   │
   ├─ click "Probe sources"
   │        │
   │        ▼
   │  GET /api/probe-sources  (server)
   │        │  for each configured key (BETSAPI_TOKEN, APISPORTS_KEY, RAPIDAPI_KEY):
   │        │    make 1 cheap test call, check if GG League appears in the response
   │        ▼
   │  { sources: [...], recommended: "apisports" | "betsapi" | null }
   │        │
   ◀────────┘   UI renders a ✓/✗/? row per source with free-tier quota + signup link
   │
   ├─ select source (Auto / BetsAPI / API-Sports) + days/min-GP, click "Fetch"
   │        │
   │        ▼
   │  POST /api/fetch-games          OR        POST /api/apisports-games
   │   (BetsAPI, paginated by day)              (API-Sports, paginated by page,
   │        │                                    league ID auto-discovered by name)
   │        ▼                                          ▼
   │  { walkforward, players, matches, meta }  (identical shape from both routes)
   │        │
   ◀────────┘
   │
   ▼
mergeApiData() — upserts into React state (dedup walk-forward rows by a composite
key, upsert players by lowercased name, dedup matches), then saveKey() persists
the merged arrays to localStorage so they survive a page reload.
```

The two fetch routes are interchangeable from the frontend’s point of view because `lib/apisports.ts` reuses the exact same `splitName()`, `buildWalkforward()`, `aggregatePlayers()`, and `buildMatches()` functions from `lib/betsapi.ts` — only the HTTP calls and pagination differ between providers.

### 4.3 The in-app analytical pipeline

Once data exists (by any of the three paths above), the **Matchup Analyzer** tab runs this sequence for any two selected players:

1. **Build (or reuse) the rating model.** `buildRatingsModel()` replays every walk-forward row chronologically through `makeRatings()`, an online stochastic-gradient estimator (§5.3). This happens in a `useMemo` keyed on the walk-forward array and settings, so it only re-trains when the underlying data or hyperparameters change.
1. **Resolve team skins.** Each player’s most-frequently-used NBA team is computed from their walk-forward history (`modalTeam`), with a dropdown to override it (since a player can pilot multiple team skins across games).
1. **Project the matchup.** `computeProjection()` is the single entry point used everywhere in the UI: if the rated model has seen both players, it returns the rating-model’s additive prediction; otherwise it falls back to `projectTotal()`, the simpler multiplicative baseline (§5.2). Both return the same `{projected, p1_proj, p2_proj, sigma, confidence}` shape so downstream UI code never needs to know which model fired.
1. **Convert to market probabilities.** `probOver(projected, sigma, line)` turns the point projection into P(Over) for any sportsbook total line, using a Normal-distribution CDF with the standard 0.5 continuity correction for integer lines. `winProb()` does the same for moneyline.
1. **Compute edge.** `evPerUnit(modelProb, marketOdds)` and `fullKelly()` turn “the model disagrees with the market” into a concrete expected-value-per-unit and a suggested stake fraction.
1. **Line-shop across books.** If the user enters odds from 2–3 sportsbooks for the same total, `bestPrice()` finds the best number on each side and `devigTwoWay()` computes the no-vig consensus probability the *market* (collectively) is implying — letting the user see model-edge versus market-consensus-edge separately.
1. **Log the bet.** Clicking “Log” on any edge row writes a bet record (matchup, type, line, odds, model probability, timestamp, empty `close_side`/`close_other` placeholders) into the Bet Logger tab’s ledger.

### 4.4 The settlement and CLV-tracking loop

```
Bet Logger tab
  │
  ├─ enter stake on an open bet  ──────────▶  ROI/profit recalculated live
  │
  ├─ enter closing odds (your side + the   ──▶  clvEv() computes CLV immediately,
  │   other side, for proper de-vig)            shown as a colored % in the row
  │
  └─ settle Win/Loss/Push  ─────────────────▶  profit locked in; feeds the
                                                Historical Insights ROI/hit-rate
                                                stats and the CLV dashboard
```

The CLV dashboard (in **Historical Insights**) aggregates every bet that has closing odds entered: mean CLV%, beat-close rate, a cumulative-CLV area chart, and a histogram of CLV outcomes. This is presented as the **north-star metric** deliberately — win/loss record is noisy over any realistic sample size in a market this fast-moving, but consistently beating the closing line is very hard to achieve by luck and is the standard professional proxy for “this strategy has real edge.”

### 4.5 Historical Insights: the walk-forward backtest engine

This is the most analytically dense part of the app and deserves its own walkthrough, because it answers the question “does any of this actually work?” rather than just “what does the model currently think”:

1. **`wfb` (walk-forward backtest)** replays the entire walk-forward dataset chronologically once. For every row, it predicts with the rating model *before* updating it (leakage-free), and — if both players meet the minimum-games-played threshold — also computes the baseline projector’s prediction from the pre-match snapshot fields already stored in that row. It accumulates arrays of `{actual, baseProj, rateProj}` for every qualifying game and reports MAE/RMSE/bias for whichever model is currently active, a Pearson correlation, and a head-to-head comparison block (`cmp`) showing both models’ correlation and MAE side by side.
1. **`cal` (calibration)** takes the `wfb` rows and, instead of grading the model against the line it would have chosen itself, builds a synthetic grid of seven Over/Under lines anchored to the **realized median total** of the backtest sample (`CAL_GRID = [-6,-4,-2,0,2,4,6]` points around that median). This is deliberate: anchoring to the model’s own projection would let a biased model “grade its own homework” and hide systematic over/under-projection. For every (game, synthetic line) pair it computes the model’s implied P(Over), bins predictions into deciles, and computes **Brier score** and **Expected Calibration Error (ECE)** — the gap between predicted probability and actual frequency, averaged across bins, weighted by bin size. It also runs a sanity-check backtest: whenever the model’s probability diverges from a flat -110 market by more than `edgeThresh`, it “flags” a hypothetical bet and reports the realized ROI of that population of flags.
1. The UI surfaces correlation, MAE, ECE, Brier, and flag-ROI together so a user can distinguish three different failure modes that look similar from a single accuracy number alone: a model that’s accurate on average but miscalibrated at the tails, a model that’s well-calibrated but has no edge over a -110 line, and a model that’s both accurate and has genuine, exploitable disagreement with the market.

-----

## 5. Formulas and methodology

This section documents every quantitative method in the codebase, in the order a bet would actually flow through them.

### 5.1 Empirical-Bayes shrinkage

Raw small-sample statistics (a player’s win% after 6 games, say) are noisy. The shrinkage function pulls a raw value toward a target (typically the league mean) by an amount that shrinks smoothly as the sample size grows:

```
shrunk = w · raw + (1 − w) · target,      w = gp / (gp + k)
```

`k` is a “pseudo-games” prior strength — at `gp = k` the shrunk value is exactly halfway between the raw stat and the target; as `gp → ∞`, `w → 1` and the raw value dominates. `k = 0` disables shrinkage entirely. This same function shrinks both points-per-match (toward a games-played-weighted league mean) and win% (toward the fixed value 50, since the league-wide win rate is 50% by construction in head-to-head play). Critically, in the backtest the “target” is always the running league mean computed from **only prior games**, so shrinkage never leaks future information into a historical prediction.

### 5.2 Baseline projector (`projectTotal`)

A simple, fully-interpretable multiplicative model used whenever the rating model hasn’t seen one of the two players yet (or when the user explicitly selects “baseline” mode):

```
base        = shrink(p1.ppm) + shrink(p2.ppm)
form_adj    = 1 + formCoef · mean(formScore(p1), formScore(p2))
matchup_adj = clamp(1 − matchupCoef · (avg_defense_load / 10), 0.85, 1.05)
fatigue_adj = lateNight ? fatigue : 1.0
projected   = base · form_adj · matchup_adj · fatigue_adj · variance
σ           = sqrt(max(projected, 1) · dispersion)
```

`formScore` converts a recency-ordered win/loss string (e.g. `"WWLWL"`, leftmost = most recent) into a value in [−1, +1] using harmonic recency weights (`weight_i = 1/(i+1)`), so a recent win counts more than an older one. `defense_load` is the average of both players’ (steals + fouls), used as a crude proxy for a defensively engaged, lower-scoring matchup. The total is then split between the two players proportionally to their (shrunk) win percentages, and the standard deviation `σ` assumes the total score is approximately Normal with variance proportional to its own mean (`dispersion` is the proportionality constant, fit empirically) — a standard assumption for count-like scoring data of this magnitude.

### 5.3 Online opponent + team rating model (the primary edge layer)

This is the more sophisticated, and the better-performing, of the two models. It is an **additive, online, leakage-free SGD estimator** over four parallel rating tables: player-offense (`oP`), player-defense (`dP`), team-skin-offense (`oT`), team-skin-defense (`dT`). Every rating is a deviation from a running league-mean points-per-player-per-game, `m`. For a game between player A on team-skin TA and player B on team-skin TB:

```
E[score_A] = m + oP[A] + oT[TA] + dP[B] + dT[TB]
E[score_B] = m + oP[B] + oT[TB] + dP[A] + dT[TA]
```

In words: a player’s expected score is the league average, plus how good *that player* is offensively, plus how good the *team skin they’re piloting* is offensively, raised further by how *leaky* the opponent and the opponent’s team skin are defensively. Training is pure online stochastic gradient descent: for every game, `predict()` is called first (using only ratings as they exist *before* this game), the residual between predicted and actual score is computed, and each of the four involved ratings is nudged toward its share of that residual:

```
residual_A = actual_A − predicted_A
oP[A] += etaP · residual_A      oT[TA] += etaT · residual_A
dP[B] += etaP · residual_A      dT[TB] += etaT · residual_A
(symmetric update for player B's residual)
```

`etaP` (player learning rate, default 0.08) and `etaT` (team learning rate, default 0.04) differ because team-skin ratings pool evidence across many different players using that skin and so should move more slowly per observation than an individual player’s rating. An optional `decay` term multiplicatively shrinks every touched rating toward zero after each update, acting as both a recency weighting and a regularizer against rating inflation; it defaults to 0 (off). New players and team skins start at exactly 0 — perfectly average — so there is no cold-start instability. This single estimator subsumes three separate effects that might otherwise need three separate ad-hoc adjustments: opponent strength, the specific NBA team skin being piloted (some are simply better-designed in the game engine), and recent form (since the online update naturally lets recent games move the rating more than the rating’s long-run average would).

`computeProjection()` is the dispatcher: if rated mode is selected and the rating model has seen both named players at least once, it uses the rating model’s prediction; otherwise it transparently falls back to the baseline projector. Both paths return an identical result shape.

### 5.4 Margin-to-total volatility ratio

For spread (point-differential) betting, the model needs a standard deviation for the *margin*, not just the total. Rather than assume an arbitrary multiplier, `marginRatioFrom()` computes it empirically from the loaded match history: `SD(margin) / SD(total)` across all games, clamped to a sane [0.5, 1.6] range. This ratio is then applied to the total’s `σ` to get a margin `σ`, which is more honest than a hardcoded constant because it reflects how correlated the two teams’ scores actually are in this specific dataset.

### 5.5 Odds math, expected value, and Kelly staking

Standard American-odds conversions, implemented identically in JS and Python:

```
implied_prob(o)   = o > 0 ?  100/(o+100)  :  −o/(−o+100)
payout_mult(o)     = o > 0 ?  o/100        :  100/−o          (profit per 1 unit staked, if it wins)
decimal_odds(o)    = payout_mult(o) + 1
EV_per_unit(p, o)  = p · payout_mult(o) − (1 − p)
full_Kelly(p, o)   = (b·p − (1−p)) / b,   where b = payout_mult(o)
```

`p` is always the model’s estimated true probability; `o` is the market’s posted American odds. EV is the expected profit per 1 unit staked at a given price if the model’s probability is correct. Full Kelly is the theoretically bankroll-growth-optimal stake fraction; the UI’s stake suggestions use a quarter-Kelly fraction in practice as a variance-reduction haircut against model risk (the model is never perfectly calibrated, and quarter-Kelly trades some growth rate for a much smaller risk of ruin under model error).

### 5.6 De-vig and closing-line value (CLV)

A two-way sportsbook market (Over/Under, or moneyline) embeds a built-in profit margin (“the vig”) on both sides simultaneously, so the two sides’ implied probabilities sum to slightly more than 100%. The de-vig function removes this proportionally:

```
devig(o_side, o_other):
    q1 = implied_prob(o_side);  q2 = implied_prob(o_other)
    return q1/(q1+q2), q2/(q1+q2)        # now sums to exactly 1.0
```

This is the **proportional (multiplicative) method** — simple, robust, and standard for retail-line de-vigging where more sophisticated methods (e.g. Shin’s method, which separately models informed-money skew) aren’t justified by the available data. Closing-line value asks: at the time you placed your bet, was the price you took better than the *fair* (de-vigged) probability the market eventually settled on at close?

```
CLV(odds_taken, close_side, close_other) = p_close_fair · decimal_odds(odds_taken) − 1
```

If the closing line is only available one-sided, the function falls back to the (still-vigged) implied probability of that single side rather than failing outright — clearly a less rigorous number, but better than nothing. A positive CLV means the bettor got a better number than the market eventually agreed was fair; consistently positive CLV across many bets, even before any of them settle, is the standard professional signal that a strategy has real, structural edge rather than lucky variance — which is why it is treated as the dashboard’s “north-star metric” rather than raw win/loss record.

### 5.7 Line shopping / best price

Given quotes from several sportsbooks for the same market, `bestPrice()` finds the maximum decimal-odds price on each side independently (the book offering the best number isn’t necessarily the same book on both sides) and, wherever a book quotes *both* sides, runs that book’s price through the de-vig function and averages the resulting fair-Over-probability across books to produce a market-consensus probability. The UI then shows the model’s own probability next to this consensus, making explicit the difference between “edge versus the best price I can actually get” and “edge versus what the market collectively believes,” which are two different and both useful numbers.

### 5.8 Calibration metrics: Brier score and Expected Calibration Error

For a set of (predicted probability `p`, realized binary outcome `y`) pairs:

```
Brier  = mean( (p − y)² )                          — lower is better; 0 = perfect
ECE    = Σ_bins  (n_bin / N) · |mean(p in bin) − mean(y in bin)|
```

Predictions are sorted into 10 equal-width probability bins (0–10%, 10–20%, …); within each bin, ECE compares the *average predicted probability* against the *actual frequency of the outcome* in that bin, weighted by how many predictions fall in each bin. A well-calibrated model’s “I said 70%” predictions really do come true about 70% of the time, bin by bin — Brier rewards sharp, correct probabilities overall, while ECE specifically isolates *systematic* miscalibration (e.g. a model that’s always 5 points too confident) from ordinary noise.

### 5.9 Acceptance gates used to validate the rating model against the baseline

Four conditions, checked together rather than individually, were used as the bar for declaring the rating model an improvement worth shipping as the default:

```
1. Correlation:  Pearson(rated_predictions, actuals)  >  0   AND  ≥ baseline's correlation
2. Accuracy:     MAE(rated)  <  MAE(baseline)
3. +EV:          realized ROI of rated-model-flagged bets  >  0   AND  >  baseline's flagged ROI
4. Win rate:      win% of rated-model-flagged bets  >  break-even win% for the assumed odds (52.38% at −110)
```

These are implemented as actual `assert`-style test methods in `TestAcceptanceGates` (in `test_ggba.py`) running against a structured synthetic dataset with deliberately injected player/team/pace effects, and were re-verified against the real `ggba_SYNTHETIC_demo_walkforward.csv` demo file end-to-end through the literal browser code path (not just the Python mirror) before shipping. On that demo data the rated model reached r≈0.71 (vs. baseline’s ≈0.47–0.53), MAE≈9.7 (vs. ≈11.7–12.8), a flagged-bet win rate of ≈73% (vs. ≈62%), and an ECE roughly six times tighter than baseline.

**Important honesty note carried through every part of this project:** these specific magnitudes (the 70%+ win rates, the +30–40% ROI figures) are properties of a **deliberately soft, synthetic benchmark book** built to validate that the estimator correctly recovers known, injected structure — they are not a claim about real-market profitability. The load-bearing, transferable result is the *relative* improvement of the rated model over the baseline and its tighter calibration, not the absolute numbers. Real validation requires fetching genuine GG League results and genuine sportsbook closing lines and re-running the identical backtest — which is exactly what the live-data-fetch layer (§6) exists to make possible.

-----

## 6. The data-source integration layer

### 6.1 Why a server-side layer exists at all

The browser artifact has no concept of a server and cannot safely hold an API token (anything in client-side JavaScript is visible to anyone who opens dev tools). The Vercel port exists specifically to solve this: `BETSAPI_TOKEN`, `APISPORTS_KEY`, and `RAPIDAPI_KEY` are read exclusively inside files that execute on Vercel’s servers (`app/api/*/route.ts` and the `lib/*.ts` modules they import), and the browser only ever talks to same-origin paths like `/api/fetch-games`, receiving a finished JSON payload with no credentials embedded anywhere in the response or the network request the browser itself makes.

### 6.2 Configured sources

|Source        |File              |Auth                                                                |Free tier                         |Confirmed GG League coverage                                                        |
|--------------|------------------|--------------------------------------------------------------------|----------------------------------|------------------------------------------------------------------------------------|
|**BetsAPI**   |`lib/betsapi.ts`  |`BETSAPI_TOKEN` query param                                         |None — paid only (~$10/mo+)       |**Yes** — directly observed live in their basketball results feed                   |
|**API-Sports**|`lib/apisports.ts`|`x-apisports-key` header (or RapidAPI gateway with `X-RapidAPI-Key`)|100 requests/day, no card required|**Unconfirmed** — depends on account/plan; auto-discovered at runtime, never assumed|

`lib/betsapi.ts` paginates by calendar day against `/v3/events/ended`, retries with exponential backoff on 429/5xx, and fails over between two BetsAPI hostnames (`api.b365api.com` / `api.betsapi.com`). `lib/apisports.ts` does not hardcode a league ID at all — `discoverGGLeague()` calls the provider’s `/leagues` endpoint and pattern-matches league names containing “gg league”, “h2h gg”, or “ebasketball h2h”, returning the matched ID and its available seasons, so the integration keeps working even if the provider renumbers the league or a user’s account simply doesn’t have it (in which case the probe correctly reports it as unavailable rather than silently returning wrong data).

### 6.3 The probe-first pattern

`app/api/probe-sources/route.ts` exists so a user never has to guess whether a configured key actually works for this specific league before spending request quota on a full fetch. It makes one minimal call per configured source, reports a tri-state result (✓ confirmed working / ✗ configured but no coverage / configured-but-errored, vs. simply “not configured”), and recommends the cheapest working option (preferring a free source over a paid one when both work). The frontend’s “Probe sources” button surfaces this directly, with sign-up links inlined for any source that isn’t yet configured.

### 6.4 Shape contract between sources

Both fetch routes (`/api/fetch-games` and `/api/apisports-games`) return the identical JSON shape — `{ walkforward, players, matches, meta }` — which is exactly the shape `mergeApiData()` inside the React component expects. This means the frontend’s merge/dedup logic, written once, works against either provider without modification, and a third provider could be added in the future by writing one more `lib/*.ts` file and one more route that produces this same shape.

-----

## 7. Data schemas

### 7.1 Player CSV (`CSV_COLS`)

```
name, win_pct, pts_per_match, fg_pct, steals, fouls, gp, w, l, recent_form, nba_team
```

A full-sample roster row: one line per player, aggregated across however much history has been loaded. `recent_form` is a short win/loss string, most-recent game first (e.g. `"WWLWL"`).

### 7.2 Walk-forward CSV (`WF_COLS`)

```
date, player1, player2, p1_team, p2_team,
p1_win_pct, p1_ppm, p1_form, p1_gp,
p2_win_pct, p2_ppm, p2_form, p2_gp,
score1, score2, actual_total, hour_utc
```

One row per historical game, with each player’s stat columns frozen at their **pre-match** state (this is the file format that makes leakage-free backtesting possible without re-deriving snapshots at analysis time). `actual_total = score1 + score2` is stored explicitly to avoid float-precision drift across re-derivations.

### 7.3 Browser storage keys

```
ggba:players      — full player roster array
ggba:matches      — flat match-result array (for the in-sample probe / H2H lookups)
ggba:bets         — the bet ledger (open + settled), including close_side/close_other for CLV
ggba:settings     — the active hyperparameter set (form/matchup coefficients, model mode, etc.)
ggba:walkforward  — the walk-forward dataset that powers the backtest engine
```

In the artifact these are read/written through `window.storage` (the artifact host’s persistence API) with an in-memory fallback; in the Vercel port the identical key names are used against `window.localStorage` directly, so a player’s data format is portable between the two if ever needed.

-----

## 8. Testing and validation methodology

Three layers of verification were used throughout development, and all three still apply to the shipped code:

**Cross-implementation numerical agreement.** Every formula was written once in Python, unit-tested there, then manually ported into JavaScript/TypeScript and re-verified by running both implementations on identical inputs in scratch Node/Python scripts and diffing the outputs to ~6 decimal places. This catches transcription errors (a flipped sign, a wrong constant) that a single-language test suite cannot.

**Unit tests (`test_ggba.py`, 23 tests / 7 classes).** `TestMathCore` checks the normal CDF and `P(Over)` continuity correction and Pearson correlation edge cases (zero variance, n<2). `TestOdds` checks implied probability, payout multiples, EV, and Kelly at the break-even point and away from it. `TestDevigLineShopCLV` checks that de-vig probabilities sum to exactly 1, that best-price selection picks the correct book on each side independently, and that CLV is positive/negative/zero in the expected directions including the single-sided fallback path. `TestShrink` checks the boundary behavior of empirical-Bayes shrinkage (k=0 disables it, gp=0 returns the raw value, gp=k lands exactly at the midpoint). `TestBaselineProjector` checks the multiplicative model is unbiased at neutral inputs and responds in the correct direction to variance and form changes. `TestRatingModel` checks that brand-new entities start exactly at the league mean, that the model is leakage-free (repeated `predict()` calls without an intervening `update()` are deterministic), and that it actually recovers injected structure on synthetic data (r > 0.5). `TestAcceptanceGates` runs the four-gate comparison described in §5.9 against a fixed-seed synthetic dataset.

**End-to-end acceptance on the literal shipped code path.** Beyond the Python mirror, the actual JSX walk-forward engine logic was extracted and re-run in Node against both the synthetic benchmark and the demo CSV, to confirm the browser code — not just its Python analogue — produces the documented numbers. This was treated as a non-negotiable gate before any “all tests pass” claim was made: a green Python suite proves the *reference* implementation is correct, not that the *shipped* implementation matches it, hence the separate cross-check.

-----

## 9. Honest limitations and open items

This project was built with a deliberate emphasis on intellectual honesty about what’s proven versus assumed, and that’s worth restating plainly here rather than only in scattered code comments.

The rating model’s validated performance (§5.9) is against a **synthetic benchmark with injected structure and a deliberately soft simulated sportsbook** — it demonstrates the estimator correctly recovers known ground truth and that the relative improvement over baseline is real, but the absolute win-rate and ROI figures are not a claim about current real-market profitability. That claim can only be earned by re-running the same backtest against real fetched results and real sportsbook closing lines.

API-Sports’ coverage of this specific league is **unconfirmed** as a general fact — it depends on the account and plan, which is exactly why the probe-first pattern (§6.3) exists rather than the code simply asserting it works. BetsAPI’s coverage is confirmed by direct observation but has no free tier.

The margin-to-total volatility ratio (§5.4) and the dispersion constant in `σ = sqrt(projected · dispersion)` are both empirically fit rather than theoretically derived; they’re reasonable for count-like scoring data of this magnitude but would benefit from re-fitting against a larger real dataset as one accumulates.

There is currently no database — both deployments use browser storage (`window.storage` / `localStorage`), which is simple and sufficient for a single user but doesn’t support multi-device sync or multi-user sharing; a future iteration with those requirements would need to swap that layer for a real datastore (e.g. Vercel Postgres) behind the existing API routes, which were already written with that swap in mind (the routes return data, they don’t dictate how it’s persisted).

-----

## 10. Glossary

**CLV (Closing Line Value)** — whether the odds you took beat the market’s final, settled-on-fair price; the standard professional proxy for genuine edge.

**De-vig** — removing a sportsbook’s built-in margin from a two-sided market to recover the implied “fair” probability.

**ECE (Expected Calibration Error)** — the average gap, across probability bins, between what a model predicted and what actually happened.

**EV (Expected Value)** — expected profit per unit staked, given a model’s probability and the market’s price.

**Kelly criterion** — the bankroll-growth-optimal stake fraction given an edge; this app suggests a fraction of full Kelly as a risk haircut.

**Leakage-free / walk-forward** — a backtest where every prediction uses only information that would have been available before that game occurred, with model state updated strictly afterward.

**Shrinkage (empirical Bayes)** — pulling a noisy small-sample statistic toward a more reliable target, with the pull fading smoothly as sample size grows.

**Team skin** — the NBA team a GG League player is piloting in a given match; the same human player may pilot different team skins across different games.