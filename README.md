# GameRank

Prototype: rank every game you've played by picking the better of two. Static site, data in localStorage.

## Run locally
```
python3 -m http.server 8765
```
Open http://localhost:8765 (`file://` won't load the data).

## Test the ranking logic
```
node rank.test.mjs
```

## Game data
`data/games.json` is a 40-game sample with no covers. Generate the real dataset (~5000 games) from IGDB using a [Twitch developer app](https://dev.twitch.tv/console/apps):
```
TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... node scripts/fetch-games.mjs
```
Ids in saved state that aren't in the new dataset are dropped on load, so reset after switching from the sample.

## Deploy
Push to GitHub, then Settings → Pages → Deploy from branch `main`, folder `/`.

## Files
- `rank.js`: binary-insertion ranking, no DOM (port target for iOS)
- `app.js`: screens, storage, events
- `scripts/fetch-games.mjs`: IGDB → `data/games.json`

Game data and covers from [IGDB](https://www.igdb.com).
