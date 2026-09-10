# Web launch review

The existing Next.js dashboard is the standalone web application. Desktop Python tools and the offline optimizer remain separate utilities; their automation is not deployed by this web release.

## Corrected

- Whole-number total markets now distinguish over, under and push probability. Total EV and Kelly sizing account for refunds; half-point totals retain two-outcome behavior.
- Same-player projections are rejected.
- Live import no longer collapses all meetings between a pair into one game per day. Direct-feed match rows retain full timestamps.
- Stored null/object values cannot replace array collections; malformed saved settings/key containers fall back safely.
- Fatigue is an explicit scenario, no longer inferred from the viewer's timezone.
- Small screens use labeled bottom navigation, safe-area spacing, full-width content and 44px controls. Inputs use 16px text to avoid iOS focus zoom. Long status badges wrap.
- Added install metadata and web manifest. No offline/live-data caching claim is made.
- AI model selection resolves an available model for the supplied account instead of assuming an ID. Chat requests have message limits and upstream timeouts. An Anthropic key is still required.
- Next.js updated from 14.2.5 to 14.2.35 per the upstream security advisory: https://nextjs.org/blog/security-update-2025-12-11 .

## Validation and limits

Run `npm ci`, `npm test`, and `npm run build` inside `ggbet-analyzer/`.
Unit/component regressions cover discrete settlement, persistence shape errors, match identity, and existing application navigation/model behavior.

This is an engineering repair, not evidence of a profitable or calibrated betting model. The displayed confidence tiers are sample-size heuristics. The free external league feed has no guaranteed availability. Sportsbook prices are user-entered; this is not an automatic live-odds service.
Data and ledger entries are local to each browser/device; export important records from Data/Bet Ledger. AI use requires a user-provided API key. Do not configure a shared paid API key on a public deployment without authentication and durable rate limiting.

Deploy the `ggbet-analyzer` directory as the Vercel project root. No Python backend is required for direct-feed mode. `ANTHROPIC_MODEL` can optionally pin a model available to the account.
