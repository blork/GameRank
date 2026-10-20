// IGDB proxy: GET /{games|platforms}?q=<apicalypse query> -> POST api.igdb.com/v4/{endpoint}.
// Holds the Twitch secret server-side and adds CORS for allowed origins only.
// ponytail: Origin check stops other websites, not scripted clients; add a rate limit if the quota gets abused.

const ENDPOINTS = new Set(['games', 'platforms']);
let token = null; // { value, expires } — lives as long as the isolate

async function getToken(env) {
  if (token && token.expires > Date.now()) return token.value;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${env.TWITCH_CLIENT_ID}` +
    `&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Twitch auth failed: ${r.status}`);
  token = { value: j.access_token, expires: Date.now() + (j.expires_in - 3600) * 1000 };
  return token.value;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').includes(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return new Response('Forbidden origin', { status: 403 });

    const url = new URL(req.url);
    const endpoint = url.pathname.slice(1);
    const q = url.searchParams.get('q');
    if (req.method !== 'GET' || !ENDPOINTS.has(endpoint) || !q) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    try {
      const r = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
        method: 'POST',
        headers: { 'Client-ID': env.TWITCH_CLIENT_ID, Authorization: `Bearer ${await getToken(env)}` },
        body: q,
      });
      if (r.status === 401) token = null;
      return new Response(r.body, {
        status: r.status,
        headers: { ...cors, 'Content-Type': 'application/json',
                   'Cache-Control': r.ok ? 'public, max-age=86400' : 'no-store' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: cors });
    }
  },
};
