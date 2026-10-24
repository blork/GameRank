// Pure ranking logic. Each ranked game has a rating and an uncertainty (Glicko-1).
// Every answer nudges both games; matchups favour uncertain games against similarly
// rated ones, and a game is never featured twice in a row. s.ranked is the ranked
// games sorted by rating. No DOM or storage; app.js persists state after each call.

const POOL = 50;           // new games are picked at random from the top of the pool
const HISTORY = 20;        // undo steps
const RD0 = 200;           // uncertainty of a new game
const RD_MIN = 25;
const DRIFT = 15;          // uncertainty regained per 100 comparisons a game sits out (opinions change)
const SEED_TARGET = 50;    // until this many games are ranked: mostly new games, random references
const COOLDOWN = 3;        // a featured game sits out this many comparisons
const YEAR_MIN = 5;        // year mode prefers that year's games once this many are ranked
const VS_MEMORY = 8;       // recent opponents a game won't be paired with again
const Q = Math.LN10 / 400;

export function fresh() {
  return { version: 2, year: null, hiddenPlatforms: [], ranked: [], backlog: [], ignored: [],
           ratings: {}, recent: [], current: null, history: [], stats: { comparisons: 0 } };
}

// Starting rating from the critic score (0-100), so a new list looks sensible early.
export const prior = g => 1500 + ((g.critic ?? 75) - 75) * 8;

// A game is offered unless every platform it's on is hidden.
export const eligible = (s, g) => g.platforms.some(p => !s.hiddenPlatforms.includes(p));

const rdNow = (s, id) => {
  const x = s.ratings[id];
  return Math.min(RD0, Math.sqrt(x.rd ** 2 + DRIFT ** 2 * (s.stats.comparisons - x.last) / 100));
};

// 0 (just added) to 1 (well established).
export const confidence = (s, id) =>
  Math.max(0, Math.min(1, 1 - (rdNow(s, id) - RD_MIN) / (RD0 - RD_MIN)));

export const listConfidence = s =>
  s.ranked.length ? s.ranked.reduce((t, id) => t + confidence(s, id), 0) / s.ranked.length : 0;

const sortRanked = s => s.ranked.sort((a, b) => s.ratings[b].r - s.ratings[a].r);

function add(s, g) {
  s.ratings[g.id] = { r: prior(g), rd: RD0, last: s.stats.comparisons, year: g.year ?? null, vs: [] };
  s.ranked.push(g.id);
  sortRanked(s);
}

// Undo restores the lists and the ratings of the games an action touched (a full copy
// of every rating per step would fill localStorage).
function snapshot(s, ids = []) {
  const { ranked, backlog, ignored, hiddenPlatforms, current, recent, stats, year } = s;
  s.history = [...s.history, {
    lists: structuredClone({ ranked, backlog, ignored, hiddenPlatforms, current, recent, stats, year }),
    ratings: Object.fromEntries(ids.map(id => [id, s.ratings[id] ? structuredClone(s.ratings[id]) : null])),
  }].slice(-HISTORY);
}

export function undo(s) {
  const h = s.history.pop();
  if (!h) return;
  Object.assign(s, h.lists);
  for (const [id, r] of Object.entries(h.ratings)) {
    if (r) s.ratings[id] = r; else delete s.ratings[id];
  }
}

const sample = (items, weight, rand) => {
  const w = items.map(weight), total = w.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < items.length; i++) if ((x -= w[i]) <= 0) return items[i];
  return items.at(-1);
};

// Ranked games from the chosen year, if year mode is on and there are enough of them.
function ofYear(s) {
  if (s.year == null) return null;
  const list = s.ranked.filter(id => s.ratings[id].year === s.year);
  return list.length >= YEAR_MIN ? list : null;
}

function pickNew(s, games, rand) {
  const used = new Set([...s.ranked, ...s.backlog, ...s.ignored]);
  const pool = [];
  for (const g of games) {
    if (used.has(g.id) || !eligible(s, g)) continue;
    pool.push(g);
    if (pool.length === POOL) break; // pools are sorted best-known first
  }
  return pool.length ? pool[Math.floor(rand() * pool.length)] : null;
}

// The least certain games, skipping ones featured in the last few comparisons
// (with a tiny list, only the last one).
function pickRefine(s, rand) {
  const all = ofYear(s) ?? s.ranked;
  let list = all.filter(id => !s.recent.includes(id));
  if (!list.length) list = all.filter(id => id !== s.recent[0]);
  const top = list.map(id => [id, rdNow(s, id)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return top.length ? top[Math.floor(rand() * top.length)][0] : null;
}

// Seeding: any ranked game. After: similarly rated, well-established games, which make
// the most informative comparisons. Recent opponents are avoided.
function pickReference(s, id, r, rd, rand) {
  const vs = s.ratings[id]?.vs ?? [];
  const year = ofYear(s);
  let list = (year && rand() < 0.7 ? year : s.ranked).filter(x => x !== id);
  if (list.some(x => !vs.includes(x))) list = list.filter(x => !vs.includes(x));
  if (!list.length) return null;
  if (s.ranked.length < SEED_TARGET) return list[Math.floor(rand() * list.length)];
  const width = 60 + rd / 2;
  return sample(list, x => Math.exp(-((s.ratings[x].r - r) ** 2) / (2 * width ** 2)) / rdNow(s, x), rand);
}

// Choose the next comparison. `games` is the pool new games come from, best-known first.
// s.current = { featured, reference, isNew, game? }; reference is null only before
// anything is ranked, and game (the details) is kept for new games.
export function next(s, games, rand = Math.random) {
  if (s.current) return;
  const newCard = () => {
    const g = pickNew(s, games, rand);
    return g && { featured: g.id, reference: pickReference(s, g.id, prior(g), RD0, rand), isNew: true, game: g };
  };
  const refineCard = () => {
    const id = s.ranked.length >= 2 ? pickRefine(s, rand) : null;
    return id != null && { featured: id, reference: pickReference(s, id, s.ratings[id].r, rdNow(s, id), rand), isNew: false };
  };
  const wantNew = rand() < (s.ranked.length < SEED_TARGET ? 0.8 : 0.4);
  s.current = (wantNew ? newCard() || refineCard() : refineCard() || newCard()) || null;
}

const g = rd => 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / (Math.PI * Math.PI));

// Glicko-1 rating period with a single game; score 1 = a won.
function update(a, b, score) {
  const gb = g(b.rd), e = 1 / (1 + 10 ** (-gb * (a.r - b.r) / 400));
  const d2 = 1 / (Q * Q * gb * gb * e * (1 - e));
  const precision = 1 / a.rd ** 2 + 1 / d2;
  return { r: a.r + (Q / precision) * gb * (score - e), rd: Math.max(RD_MIN, Math.sqrt(1 / precision)) };
}

const remember = (x, id) => { x.vs = [id, ...x.vs.filter(v => v !== id)].slice(0, VS_MEMORY); };

// The featured game is better (true) or worse (false) than the reference.
export function answer(s, better, games, rand = Math.random) {
  const c = s.current;
  if (c?.reference == null) return;
  snapshot(s, [c.featured, c.reference]);
  if (c.isNew) add(s, c.game);
  const f = s.ratings[c.featured], ref = s.ratings[c.reference];
  const a = { r: f.r, rd: rdNow(s, c.featured) }, b = { r: ref.r, rd: rdNow(s, c.reference) };
  const n = s.stats.comparisons + 1;
  Object.assign(f, update(a, b, better ? 1 : 0), { last: n });
  Object.assign(ref, update(b, a, better ? 0 : 1), { last: n });
  remember(f, c.reference);
  remember(ref, c.featured);
  s.stats.comparisons = n;
  s.recent = [c.featured, ...s.recent].slice(0, COOLDOWN);
  sortRanked(s);
  s.current = null;
  next(s, games, rand);
}

// First card only (nothing ranked to compare against): add it at its starting rating.
export function playedIt(s, games, rand = Math.random) {
  const c = s.current;
  if (!c?.isNew || c.reference != null) return;
  snapshot(s, [c.featured]);
  add(s, c.game);
  s.current = null;
  next(s, games, rand);
}

// Move a game to 'backlog' (want to play) or 'ignored' (haven't played). Also used from My list.
export function move(s, id, list, games, rand = Math.random) {
  snapshot(s, [id]);
  for (const k of ['ranked', 'backlog', 'ignored']) s[k] = s[k].filter(x => x !== id);
  delete s.ratings[id];
  s[list].push(id);
  const c = s.current;
  if (c && (c.featured === id || c.reference === id)) s.current = null;
  next(s, games, rand);
}

// Look at a game again: unranked ones (search, backlog) are added at their starting
// rating; ranked ones become uncertain. Either way it's featured next.
export function recheck(s, game, games, rand = Math.random) {
  snapshot(s, [game.id]);
  s.backlog = s.backlog.filter(x => x !== game.id);
  s.ignored = s.ignored.filter(x => x !== game.id);
  if (!s.ratings[game.id]) add(s, game);
  else s.ratings[game.id].rd = RD0;
  const reference = pickReference(s, game.id, s.ratings[game.id].r, RD0, rand);
  s.current = reference == null ? null : { featured: game.id, reference, isNew: false };
  next(s, games, rand);
}

export function restore(s, id, games, rand = Math.random) {
  snapshot(s);
  s.ignored = s.ignored.filter(x => x !== id);
  s.backlog = s.backlog.filter(x => x !== id);
  next(s, games, rand);
}

// Hide a platform the user never had. Ranked games stay; a new featured game that is
// now only on hidden platforms is replaced.
export function hidePlatform(s, platform, games, rand = Math.random) {
  snapshot(s);
  s.hiddenPlatforms.push(platform);
  if (s.current?.isNew && !eligible(s, s.current.game)) {
    s.current = null;
    next(s, games, rand);
  }
}

export function showPlatform(s, platform) {
  snapshot(s);
  s.hiddenPlatforms = s.hiddenPlatforms.filter(p => p !== platform);
}

export function setYear(s, year, games, rand = Math.random) {
  s.year = year;
  s.current = null;
  next(s, games, rand);
}

// Run on every load. Lists ranked by the old binary-insertion version have an order but
// no ratings: spread them evenly, moderately certain. yearOf(id) gives the release year if known.
export function migrate(s, yearOf) {
  if (s.current && !('featured' in s.current)) s.current = null; // old comparison format
  for (const k of ['seen', 'rematchDue', 'lastPlaced', 'platforms']) delete s[k];
  const n = s.ranked.length;
  s.ranked.forEach((id, i) => {
    s.ratings[id] ??= { r: 1700 - (n > 1 ? (400 * i) / (n - 1) : 0), rd: 120,
                        last: s.stats.comparisons, year: yearOf(id) ?? null, vs: [] };
  });
  sortRanked(s);
}
