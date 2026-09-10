# GGBetAnalyzer automation

Vercel target: `joeydd032995-pixel/spec-journey-gg`, root directory `ggbet-analyzer`, Next.js, production branch `main`. Do not deploy the Python repository root or the Sites Worker build. Browser data on chatgpt.site does not automatically transfer to the Vercel domain: export it before switching.

## Research

`research.yml` runs at minutes 7, 22, 37 and 52 UTC. It collects public league results independently of Vercel, reconstructs chronological snapshots from accumulated results, evaluates default settings, and updates `research-data`. No private ledger, tokens or paid odds are committed. `/api/research-snapshot` reads the latest successful snapshot. Browser settings remain personal; scheduled reports state their default settings. Failed jobs preserve the previous publication. Check the generated timestamp for staleness.

First run backfills 90 days; later runs fetch 3 days. Corrections to older results require a deliberate rebuild. Replay is not an immutable prospective prediction archive. In-sample charts remain browser diagnostics. GitHub schedules can be delayed/dropped and public-repository schedules may disable after 60 days without activity:
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## CLV provider candidate, not live verified

BetsAPI documents GGBet odds, basketball ML (18_1), spread (18_2), totals (18_3), timestamps and event history:
https://betsapi.com/docs/events/odds.html
https://betsapi.com/docs/events/view.html
https://betsapi.com/docs/

Subscription/token required. Confirm H2H GG 4x5 coverage, GGBet prematch history, retention and package price before purchase. No subscription was purchased.

Add GitHub Actions secret BETSAPI_TOKEN and repository variable BETSAPI_TEST_EVENT_IDS (1–10 actual H2H GG event IDs). Run “Verify candidate CLV provider coverage”. Its artifact checks actual event/market coverage without publishing raw paid odds. Last observed prematch odds are not necessarily the final executable close. The summary endpoint's end field can contain in-play quotes; never use it blindly.

Automatic CLV still requires authenticated sample validation and ledger mapping to provider event ID, bookmaker, period, market, participant orientation, side and exact line. Do not match repeated player names alone or compare price-only CLV across changed lines. Complete historical odds can be imported after an event, so GitHub need not run at the exact start.

## Calibration

Current O/U chart tests hypothetical lines derived from earlier scores. Seven lines from one game are correlated, not seven independent games. It diagnoses the model; it does not prove real-market calibration or profitability. Real validation requires predictions saved before start, actual line/odds, eventual result, explicit push handling and untouched later evaluation data. Fit probability mappings on earlier training data only; compare raw/calibrated Brier scores, log loss and reliability on later games. Automatic probability fitting/promotion remains disabled.
