// Pure ranking logic: binary insertion into state.ranked (best first).
// No DOM or storage; app.js persists state after each call.

const POOL = 50;
const HISTORY = 20;

export function fresh() {
  return { version: 1, platforms: [], ranked: [], backlog: [], ignored: [],
           current: null, history: [], stats: { comparisons: 0 }, lastPlaced: null };
}

function snapshot(s) {
  const { history, ...rest } = s;
  s.history = [...history, structuredClone(rest)].slice(-HISTORY);
}

export function undo(s) {
  const prev = s.history.pop();
  if (prev) Object.assign(s, prev, { lastPlaced: null });
}

function pick(s, games, rand, exclude = []) {
  const plat = new Set(s.platforms);
  const used = new Set([...s.ranked, ...s.backlog, ...s.ignored, ...exclude]);
  const pool = [];
  for (const g of games) {
    if (used.has(g.id) || !g.platforms.some(p => plat.has(p))) continue;
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

export function ensureCurrent(s, games, rand = Math.random) {
  if (!s.current) start(s, pick(s, games, rand), games, rand);
}

// [left, right] ids for the current comparison, or null when nothing is left.
export function pair(s) {
  const c = s.current;
  if (!c) return null;
  const opp = c.opponent ?? s.ranked[(c.lo + c.hi) >> 1];
  return c.flip ? [opp, c.candidate] : [c.candidate, opp];
}

function insert(s, id, at, games, rand) {
  s.ranked.splice(at, 0, id);
  s.lastPlaced = { id, rank: at + 1 };
  s.current = null;
  ensureCurrent(s, games, rand);
}

export function choose(s, winner, games, rand = Math.random) {
  const c = s.current;
  if (!c) return;
  snapshot(s);
  s.stats.comparisons++;
  s.lastPlaced = null;
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
  s.stats.comparisons++;
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

export function restore(s, id, games, rand = Math.random) {
  snapshot(s);
  remove(s, id);
  ensureCurrent(s, games, rand);
}
