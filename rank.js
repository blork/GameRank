// Pure ranking logic: binary insertion into state.ranked (best first), plus rematches
// between already-ranked games so early mistakes and changed opinions get corrected.
// No DOM or storage; app.js persists state after each call.

const POOL = 50;
const HISTORY = 20;
const REMATCH_SHARE = 0.25; // of comparisons, once REMATCH_MIN games are ranked
const REMATCH_MIN = 20;
const REMATCH_FAR = 0.1;    // share of rematches against a distant game

export function fresh() {
  return { version: 1, hiddenPlatforms: [], ranked: [], backlog: [], ignored: [],
           current: null, history: [], stats: { comparisons: 0, rematches: 0, agreed: 0 },
           seen: {}, rematchDue: 0, lastPlaced: null };
}

function snapshot(s) {
  const { history, ...rest } = s;
  s.history = [...history, structuredClone(rest)].slice(-HISTORY);
}

export function undo(s) {
  const prev = s.history.pop();
  if (prev) Object.assign(s, prev, { lastPlaced: null });
}

// A game is offered unless every platform it's on is hidden.
export const eligible = (s, g) => g.platforms.some(p => !s.hiddenPlatforms.includes(p));

function pick(s, games, rand, exclude = []) {
  const used = new Set([...s.ranked, ...s.backlog, ...s.ignored, ...exclude]);
  const pool = [];
  for (const g of games) {
    if (used.has(g.id) || !eligible(s, g)) continue;
    pool.push(g.id);
    if (pool.length === POOL) break; // games are sorted by popularity
  }
  return pool.length ? pool[Math.floor(rand() * pool.length)] : null;
}

// Start placing `id`. Bootstrap (empty list) pairs it with another unranked game.
function start(s, id, games, rand) {
  if (id == null) { s.current = null; return; }
  if (s.ranked.length) {
    s.current = { candidate: id, lo: 0, hi: s.ranked.length, flip: rand() < 0.5 };
    return;
  }
  const opponent = pick(s, games, rand, [id]);
  if (opponent == null) { s.ranked = [id]; s.current = null; return; }
  s.current = { candidate: id, opponent, flip: rand() < 0.5 };
}

// Rematch a ranked game, skewed to the top and to games not compared recently,
// against a neighbour 1-4 places away (sometimes a distant game).
function rematch(s, rand) {
  const n = s.ranked.length, seen = id => s.seen[id] ?? -1;
  const top = () => Math.floor(n * rand() ** 2);
  let i = top();
  for (let k = 0; k < 4; k++) { const j = top(); if (seen(s.ranked[j]) < seen(s.ranked[i])) i = j; }
  let j;
  if (rand() < REMATCH_FAR) {
    do j = Math.floor(rand() * n); while (j === i);
  } else {
    const d = Math.min(n - 1, 1 + Math.floor(-Math.log(1 - rand()) * 2));
    j = i + (rand() < 0.5 ? -d : d);
    if (j < 0 || j >= n) j = i + (j < 0 ? d : -d);
    j = Math.max(0, Math.min(n - 1, j));
    if (j === i) j = i ? i - 1 : 1;
  }
  return { rematch: [s.ranked[Math.min(i, j)], s.ranked[Math.max(i, j)]], flip: rand() < 0.5 };
}

export function ensureCurrent(s, games, rand = Math.random) {
  if (s.current) return;
  if (s.rematchDue >= 1 && s.ranked.length >= REMATCH_MIN) {
    s.rematchDue--;
    s.current = rematch(s, rand);
    return;
  }
  start(s, pick(s, games, rand), games, rand);
}

// [left, right] ids for the current comparison, or null when nothing is left.
export function pair(s) {
  const c = s.current;
  if (!c) return null;
  if (c.rematch) return c.flip ? [c.rematch[1], c.rematch[0]] : c.rematch;
  const opp = c.opponent ?? s.ranked[(c.lo + c.hi) >> 1];
  return c.flip ? [opp, c.candidate] : [c.candidate, opp];
}

function insert(s, id, at, games, rand) {
  s.ranked.splice(at, 0, id);
  s.lastPlaced = { id, rank: at + 1 };
  s.current = null;
  ensureCurrent(s, games, rand);
}

function count(s) {
  for (const id of pair(s)) s.seen[id] = s.stats.comparisons;
  s.stats.comparisons++;
  if (s.current.rematch) s.stats.rematches++;
  else if (s.ranked.length >= REMATCH_MIN) s.rematchDue += REMATCH_SHARE / (1 - REMATCH_SHARE);
}

export function choose(s, winner, games, rand = Math.random) {
  const c = s.current;
  if (!c) return;
  snapshot(s);
  count(s);
  s.lastPlaced = null;
  if (c.rematch) {
    const [upper, lower] = c.rematch;
    if (winner === upper) s.stats.agreed++;
    else { // move the winner to just above the game it beat
      s.ranked.splice(s.ranked.indexOf(lower), 1);
      const at = s.ranked.indexOf(upper);
      s.ranked.splice(at, 0, lower);
      s.lastPlaced = { id: lower, rank: at + 1, moved: true };
    }
    s.current = null;
    return ensureCurrent(s, games, rand);
  }
  if (c.opponent != null) {
    const loser = winner === c.candidate ? c.opponent : c.candidate;
    s.ranked = [winner, loser];
    s.lastPlaced = { id: winner, rank: 1 };
    s.current = null;
    return ensureCurrent(s, games, rand);
  }
  const mid = (c.lo + c.hi) >> 1;
  if (winner === c.candidate) c.hi = mid; else c.lo = mid + 1;
  if (c.lo === c.hi) return insert(s, c.candidate, c.lo, games, rand);
  c.flip = rand() < 0.5;
}

// "Too close to call": place the candidate directly above the current pivot.
export function tie(s, games, rand = Math.random) {
  const c = s.current;
  if (!c) return;
  snapshot(s);
  count(s);
  if (c.rematch) { // too close: the current order stands
    s.stats.agreed++;
    s.current = null;
    return ensureCurrent(s, games, rand);
  }
  if (c.opponent != null) {
    s.ranked = [c.candidate, c.opponent];
    s.lastPlaced = { id: c.candidate, rank: 1 };
    s.current = null;
    return ensureCurrent(s, games, rand);
  }
  insert(s, c.candidate, (c.lo + c.hi) >> 1, games, rand);
}

function remove(s, id) {
  for (const k of ['ranked', 'backlog', 'ignored']) s[k] = s[k].filter(x => x !== id);
}

// Move any game to 'backlog' or 'ignored' (also used for "not played").
export function move(s, id, list, games, rand = Math.random) {
  snapshot(s);
  s.lastPlaced = null;
  const c = s.current;
  const wasRanked = s.ranked.includes(id);
  remove(s, id);
  s[list].push(id);
  if (!c) return ensureCurrent(s, games, rand);
  if (c.rematch) {
    if (c.rematch.includes(id)) { s.current = null; ensureCurrent(s, games, rand); }
    return;
  }
  if (c.candidate === id) {
    // keep the bootstrap opponent as the new candidate when there is one
    return start(s, c.opponent ?? pick(s, games, rand), games, rand);
  }
  if (c.opponent === id) return start(s, c.candidate, games, rand);
  if (wasRanked) start(s, c.candidate, games, rand); // indices shifted; restart search
}

// Take a ranked or backlogged game out and place it again from scratch.
export function reRank(s, id, games, rand = Math.random) {
  snapshot(s);
  s.lastPlaced = null;
  remove(s, id);
  start(s, id, games, rand);
}

// Hide a platform the user never had. Ranked games stay; an unranked game in the
// current comparison is replaced if it's now only on hidden platforms.
export function hidePlatform(s, platform, games, rand = Math.random) {
  snapshot(s);
  s.hiddenPlatforms.push(platform);
  const c = s.current;
  const gone = id => { // games not in `games` (e.g. from search) were picked deliberately, so they stay
    const g = id != null && !s.ranked.includes(id) && games.find(x => x.id === id);
    return g && !eligible(s, g);
  };
  if (c && !c.rematch && (gone(c.candidate) || gone(c.opponent))) { s.current = null; ensureCurrent(s, games, rand); }
}

export function showPlatform(s, platform) {
  snapshot(s);
  s.hiddenPlatforms = s.hiddenPlatforms.filter(p => p !== platform);
}

export function restore(s, id, games, rand = Math.random) {
  snapshot(s);
  remove(s, id);
  ensureCurrent(s, games, rand);
}
