# GameRank

Prototype: rank every game you've played by picking the better of two. Static site; your data stays in localStorage. Game data and covers come live from IGDB through a small Cloudflare Worker.

## Run locally
```
python3 -m http.server 8765
```
Open http://localhost:8765. The Worker only accepts requests from this origin and `https://blork.github.io`.

## Test the ranking logic
```
node rank.test.mjs
```

## Worker (`worker/`)
Proxies `GET /{games|platforms}?q=<IGDB query>` to the IGDB API, keeping the Twitch secret server-side.
Live at https://gamerank.crimson-wave-94ca.workers.dev.

```
cd worker
npx wrangler deploy                          # after editing index.js or wrangler.toml
npx wrangler secret put TWITCH_CLIENT_ID     # Twitch dev app credentials
npx wrangler secret put TWITCH_CLIENT_SECRET
```
To allow another site, add its origin to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy.

## Deploy the site
Push to GitHub, then Settings → Pages → Deploy from branch `main`, folder `/`.

## Files
- `rank.js`: binary-insertion ranking, no DOM (port target for iOS)
- `app.js`: screens, storage, IGDB queries via the Worker
- `worker/index.js`: IGDB proxy

Game data and covers from [IGDB](https://www.igdb.com).
