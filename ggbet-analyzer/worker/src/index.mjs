/**
 * Cloudflare Worker: pass-through proxy for the h2hggl/hudstats JSON API.
 *
 * The API sits behind Cloudflare bot protection that intermittently serves an
 * HTML "Just a moment..." challenge to Vercel's datacenter IPs. Requests from a
 * Worker leave from Cloudflare's own network, which that protection trusts.
 *
 * Only GET /v1/participant/<sport> and GET /v1/schedule/<sport> are forwarded.
 * Optional secret PROXY_KEY: when set, callers must send a matching X-Proxy-Key.
 */

const UPSTREAM = "https://api-h2h.cdn-hudstats.com";
const ALLOWED_PATH = /^\/v1\/(participant|schedule)\/[a-z0-9_-]+$/i;
const SITE = "https://h2hggl.com";

const text = (body, status) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request, env) {
    if (request.method !== "GET") return text("Method not allowed", 405);

    const url = new URL(request.url);
    if (url.pathname === "/health") return text("ok", 200);
    if (!ALLOWED_PATH.test(url.pathname)) return text("Not found", 404);

    if (env.PROXY_KEY && request.headers.get("x-proxy-key") !== env.PROXY_KEY) {
      return text("Unauthorized", 401);
    }

    const upstream = new URL(UPSTREAM + url.pathname);
    upstream.search = url.search;

    const res = await fetch(upstream, {
      headers: {
        Accept: "application/json",
        Origin: SITE,
        Referer: SITE + "/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      // Cache good responses briefly at the edge; never cache failures/challenges.
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 120, "400-599": 0 } },
    });

    return new Response(res.body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  },
};
