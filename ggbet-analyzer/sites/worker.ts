import { NextRequest } from './next-server';
import * as feed from '../app/api/h2hggl-games/route';
import * as upcoming from '../app/api/upcoming/route';
import * as upcomingFeed from '../app/api/upcoming-feed/route';
import * as assistant from '../app/api/assistant/route';
import * as status from '../app/api/status/route';
import * as bets from '../app/api/fetch-games/route';
// @ts-ignore generated text asset
import client from './generated-client.txt';
// @ts-ignore text asset
import manifest from '../public/manifest.webmanifest';
// @ts-ignore text asset
import icon from '../public/icon.svg';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0d0f12"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="GG Analyzer"><meta name="description" content="H2H GG eBasketball matchup analysis, data imports and a personal bet ledger."><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg"><title>GGBetAnalyzer · H2H GG League</title></head><body style="margin:0;background:#0d0f12"><div id="root"></div><noscript>This analytics workspace requires JavaScript.</noscript><script src="/app.js" defer></script></body></html>`;
const routes: Record<string, any> = {
 '/api/h2hggl-games': feed, '/api/upcoming': upcoming,
 '/api/upcoming-feed': upcomingFeed, '/api/assistant': assistant,
 '/api/status': status, '/api/fetch-games': bets,
};
export default {
 async fetch(request: Request) {
  const url = new URL(request.url);
  const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
  const assets: Record<string, [string, string]> = {
   '/': [html, 'text/html; charset=utf-8'], '/app.js': [client, 'application/javascript; charset=utf-8'],
   '/manifest.webmanifest': [manifest, 'application/manifest+json'], '/icon.svg': [icon, 'image/svg+xml'],
  };
  if (assets[url.pathname] && ['GET','HEAD'].includes(request.method)) {
   const [body, type] = assets[url.pathname];
   return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Type': type, 'Cache-Control': 'no-cache' } });
  }
  const route = routes[url.pathname];
  if (!route) return new Response('Not found', { status:404 });
  const handler = route[request.method];
  if (!handler) return new Response('Method not allowed', { status:405, headers:{Allow: Object.keys(route).filter(k=>['GET','POST'].includes(k)).join(', ')} });
  if (request.method === 'POST') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return Response.json({ error:'Cross-origin request denied' }, {status:403});
    const body = await request.text();
    if (body.length > 100000) return Response.json({error:'Request too large'}, {status:413});
    request = new Request(request.url, { method:request.method, headers:request.headers, body });
  }
  try { return await handler(new NextRequest(request)); }
  catch { return Response.json({error:'Request could not be completed. Try again.'},{status:500}); }
 }
};
