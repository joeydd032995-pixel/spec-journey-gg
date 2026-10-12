# h2hggl-proxy (Cloudflare Worker)

Pass-through proxy for the h2hggl/hudstats API, used when its Cloudflare bot
protection blocks Vercel's IPs ("Just a moment..." HTTP 403 in Fetch live data).
Forwards only `GET /v1/participant/<sport>` and `GET /v1/schedule/<sport>`.

## Deploy
```bash
cd ggbet-analyzer/worker
npx wrangler login
npx wrangler deploy                      # prints https://h2hggl-proxy.<account>.workers.dev
openssl rand -hex 24                     # make a key, then:
npx wrangler secret put PROXY_KEY        # paste the key (optional but recommended)
```
(Or paste `src/index.mjs` into a new Worker in the Cloudflare dashboard.)

## Point the app at it
Vercel → Project → Settings → Environment Variables (Production + Preview):

| Name | Value |
|---|---|
| `H2HGGL_API_BASE` | `https://h2hggl-proxy.<account>.workers.dev/v1` |
| `H2HGGL_PROXY_KEY` | the key from above (omit if you did not set `PROXY_KEY`) |

Redeploy, then press Fetch data. Check the Worker with `GET /health` (returns `ok`).
