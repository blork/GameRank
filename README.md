# GameRank

Prototype: rank every game you've played by picking the better of two. Static site; your data stays in localStorage. Game data and covers come live from IGDB through a small Cloudflare Worker.

## Run locally
```
python3 -m http.server 8765
```
Open http://localhost:8765. The Worker only accepts requests from the origins in `worker/wrangler.toml`.

## Test the ranking logic
```
node rank.test.mjs
```

## Worker (`worker/`)
Live at https://gamerank.crimson-wave-94ca.workers.dev.
- `GET /{games|platforms}?q=<IGDB query>`: IGDB proxy, keeping the Twitch secret server-side.
- Passkey accounts (`/auth/...`) and `GET|PUT /list`: the signed-in account's list, stored in the D1 database `gamerank` (tables in `schema.sql`).

Check accounts and sync end to end with a software passkey: `npm install`, then `npm test` against `npx wrangler dev` (see `api.test.mjs`).

```
cd worker
npx wrangler deploy                          # after editing index.js or wrangler.toml
npx wrangler secret put TWITCH_CLIENT_ID     # Twitch dev app credentials
npx wrangler secret put TWITCH_CLIENT_SECRET
```
To allow another site, add its origin to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy.

## Deploy the site
Pages deploys `main` automatically: https://www.sam-oakley.co.uk/GameRank/

## Files
- `rank.js`: ratings with uncertainty (Glicko-1) and matchmaking, no DOM (port target for iOS)
- `app.js`: screens, storage, IGDB queries via the Worker
- `worker/index.js`: IGDB proxy, passkey accounts, list storage

Game data and covers from [IGDB](https://www.igdb.com).
