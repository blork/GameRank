// Builds data/games.json from IGDB.
// TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=... node scripts/fetch-games.mjs [count]
import { writeFile, mkdir } from 'node:fs/promises';

const { TWITCH_CLIENT_ID: id, TWITCH_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
const COUNT = Number(process.argv[2] ?? 5000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const auth = await fetch(
  `https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`,
  { method: 'POST' }).then(r => r.json());
if (!auth.access_token) throw new Error(`Twitch auth failed: ${JSON.stringify(auth)}`);

async function igdb(endpoint, body) {
  const r = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': id, Authorization: `Bearer ${auth.access_token}` },
    body,
  });
  if (!r.ok) throw new Error(`${endpoint} ${r.status}: ${await r.text()}`);
  await sleep(250); // IGDB allows 4 req/s
  return r.json();
}

// game_type: 0 main, 4 standalone expansion, 8 remake, 9 remaster, 10 expanded game
const games = [];
for (let offset = 0; offset < COUNT; offset += 500) {
  const page = await igdb('games', `fields name,first_release_date,cover.image_id,platforms,total_rating_count;
    where total_rating_count > 10 & game_type = (0,4,8,9,10) & cover != null & platforms != null;
    sort total_rating_count desc; limit ${Math.min(500, COUNT - offset)}; offset ${offset};`);
  games.push(...page);
  console.log(`games: ${games.length}`);
  if (page.length < 500) break;
}

const platIds = [...new Set(games.flatMap(g => g.platforms))];
const platforms = {};
for (let i = 0; i < platIds.length; i += 500) {
  const page = await igdb('platforms', `fields name; where id = (${platIds.slice(i, i + 500)}); limit 500;`);
  for (const p of page) platforms[p.id] = p.name;
}

const out = {
  platforms,
  games: games.map(g => ({
    id: g.id,
    name: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    cover: g.cover?.image_id ?? null,
    platforms: g.platforms,
    pop: g.total_rating_count,
  })),
};
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/games.json', import.meta.url), JSON.stringify(out));
console.log(`wrote ${out.games.length} games, ${platIds.length} platforms`);
