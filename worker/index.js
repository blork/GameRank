// GameRank API.
//   GET /{games|platforms}?q=<apicalypse>  IGDB proxy (holds the Twitch secret)
//   POST /auth/{register|login}/{options|verify}, POST /auth/logout, DELETE /account  passkey accounts
//   GET|PUT /list  the signed-in account's saved state
// CORS for allowed origins only.
// ponytail: Origin check stops other websites, not scripted clients; add rate limits if the quota or account table gets abused.
import { generateRegistrationOptions, verifyRegistrationResponse,
         generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

const IGDB = new Set(['games', 'platforms']);
const DAY = 86400000;
const MAX_LIST = 1_000_000; // bytes
let token = null; // IGDB { value, expires }; lives as long as the isolate

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function getToken(env) {
  if (token && token.expires > Date.now()) return token.value;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${env.TWITCH_CLIENT_ID}` +
    `&client_secret=${env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`, { method: 'POST' });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Twitch auth failed: ${r.status}`);
  token = { value: j.access_token, expires: Date.now() + (j.expires_in - 3600) * 1000 };
  return token.value;
}

async function igdb(endpoint, q, env, cors) {
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
}

const randomId = () => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async text =>
  isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

async function saveChallenge(env, challenge, account = null) {
  const id = randomId();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO challenges (id, challenge, account, expires) VALUES (?, ?, ?, ?)')
      .bind(id, challenge, account, Date.now() + 5 * 60000),
  ]);
  return id;
}

async function takeChallenge(env, id) {
  const row = await env.DB.prepare('DELETE FROM challenges WHERE id = ? AND expires > ? RETURNING challenge, account')
    .bind(id ?? '', Date.now()).first();
  if (!row) throw new HttpError(400, 'Sign-in took too long. Try again.');
  return row;
}

async function newSession(env, account) {
  const t = randomId();
  await env.DB.prepare('INSERT INTO sessions (token, account, expires) VALUES (?, ?, ?)')
    .bind(await sha256(t), account, Date.now() + 365 * DAY).run();
  return t;
}

const bearer = req => req.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';

async function accountFor(req, env) {
  const row = await env.DB.prepare('SELECT account FROM sessions WHERE token = ? AND expires > ?')
    .bind(await sha256(bearer(req)), Date.now()).first();
  if (!row) throw new HttpError(401, 'Signed out');
  return row.account;
}

async function api(route, req, env, origin) {
  // Passkeys belong to the site's domain; www and the bare domain share one.
  const rpID = new URL(origin).hostname.replace(/^www\./, '');
  const now = Date.now();
  switch (route) {
    case 'POST /auth/register/options': {
      const account = crypto.randomUUID();
      const options = await generateRegistrationOptions({
        rpName: 'GameRank', rpID, userName: `GameRank ${new Date().toISOString().slice(0, 10)}`,
        userID: new TextEncoder().encode(account),
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      });
      return { challengeId: await saveChallenge(env, options.challenge, account), options };
    }
    case 'POST /auth/register/verify': {
      const { challengeId, response } = await req.json();
      const { challenge, account } = await takeChallenge(env, challengeId);
      const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID });
      if (!v.verified) throw new HttpError(400, 'Passkey could not be verified');
      const { id, publicKey, counter, transports } = v.registrationInfo.credential;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO accounts (id, created) VALUES (?, ?)').bind(account, now),
        env.DB.prepare('INSERT INTO passkeys (id, account, public_key, counter, transports, created) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, account, isoBase64URL.fromBuffer(publicKey), counter, JSON.stringify(transports ?? []), now),
      ]);
      return { token: await newSession(env, account) };
    }
    case 'POST /auth/login/options': {
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
      return { challengeId: await saveChallenge(env, options.challenge), options };
    }
    case 'POST /auth/login/verify': {
      const { challengeId, response } = await req.json();
      const { challenge } = await takeChallenge(env, challengeId);
      const key = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(response?.id ?? '').first();
      if (!key) throw new HttpError(404, 'That passkey has no account. It may have been deleted.');
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: key.id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: key.counter,
                      transports: JSON.parse(key.transports) },
      });
      if (!v.verified) throw new HttpError(401, 'Passkey could not be verified');
      await env.DB.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, key.id).run();
      return { token: await newSession(env, key.account) };
    }
    case 'POST /auth/logout':
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(bearer(req))).run();
      return { ok: true };
    case 'DELETE /account': {
      const account = await accountFor(req, env);
      await env.DB.batch(['lists', 'sessions', 'passkeys'].map(t =>
        env.DB.prepare(`DELETE FROM ${t} WHERE account = ?`).bind(account))
        .concat(env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account)));
      return { ok: true };
    }
    case 'GET /list': {
      const row = await env.DB.prepare('SELECT data, updated FROM lists WHERE account = ?')
        .bind(await accountFor(req, env)).first();
      return row && { data: JSON.parse(row.data), updated: row.updated };
    }
    case 'PUT /list': {
      const account = await accountFor(req, env);
      const body = await req.text();
      if (body.length > MAX_LIST) throw new HttpError(413, 'List too large');
      const { data, updated } = JSON.parse(body);
      if (typeof data !== 'object' || !Number.isFinite(updated)) throw new HttpError(400, 'Bad list');
      await env.DB.prepare(`INSERT INTO lists (account, data, updated) VALUES (?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
        .bind(account, JSON.stringify(data), updated).run();
      return { ok: true };
    }
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').includes(origin);
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403, headers: { ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
    }
    if (!allowed) return new Response('Forbidden origin', { status: 403 });

    const url = new URL(req.url);
    const path = url.pathname.slice(1);
    try {
      if (req.method === 'GET' && IGDB.has(path) && url.searchParams.get('q')) {
        return await igdb(path, url.searchParams.get('q'), env, cors);
      }
      const result = await api(`${req.method} ${url.pathname}`, req, env, origin);
      return Response.json(result, { headers: { ...cors, 'Cache-Control': 'no-store' } });
    } catch (e) {
      // verify* throw plain Errors for bad passkey responses
      const status = e.status ?? (url.pathname.startsWith('/auth/') ? 400 : 502);
      return Response.json({ error: e.message }, { status, headers: { ...cors, 'Cache-Control': 'no-store' } });
    }
  },
};
