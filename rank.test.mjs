// Self-check: node rank.test.mjs
import assert from 'node:assert/strict';
import { fresh, ensureCurrent, pair, choose, tie, move, reRank, undo } from './rank.js';

let seed = 1;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const N = 300;
const games = Array.from({ length: N }, (_, i) => ({ id: i, name: `G${i}`, platforms: [1], pop: N - i }));
const truth = games.map(g => g.id).sort(() => rand() - 0.5); // true best-first order
const score = new Map(truth.map((id, i) => [id, i]));
const better = ([a, b]) => (score.get(a) < score.get(b) ? a : b);

// 1. Honest answers reproduce the true order with <= ceil(log2(n+1)) comparisons per insert;
//    rematches all agree and make up about a quarter of comparisons once 20 games are ranked.
const s = fresh();
s.platforms = [1];
ensureCurrent(s, games, rand);
let steps = 0, n = 0;
let rematches = 0, eligible = 0;
while (s.current) {
  const before = s.ranked.length;
  if (s.ranked.length >= 20) eligible++;
  if (s.current.rematch) { rematches++; choose(s, better(pair(s)), games, rand); continue; }
  choose(s, better(pair(s)), games, rand);
  steps++;
  if (s.ranked.length !== before) {
    if (before > 0) assert.ok(steps <= Math.ceil(Math.log2(before + 1)), `insert into ${before} took ${steps}`);
    steps = 0; n++;
  }
}
assert.equal(s.ranked.length, N);
assert.equal(s.stats.agreed, s.stats.rematches);
assert.equal(s.stats.rematches, rematches);
assert.ok(Math.abs(rematches / eligible - 0.25) < 0.03, `rematch share ${rematches / eligible}`);
assert.deepEqual(s.ranked, [...s.ranked].sort((a, b) => score.get(a) - score.get(b)));

// 2. "Not played" moves the candidate out and starts a new one.
const t = fresh();
t.platforms = [1];
ensureCurrent(t, games, rand);
choose(t, pair(t)[0], games, rand); // bootstrap
const cand = t.current.candidate;
move(t, cand, 'backlog', games, rand);
assert.deepEqual(t.backlog, [cand]);
assert.ok(!t.ranked.includes(cand));
assert.notEqual(t.current.candidate, cand);

// 3. Undo restores the previous state.
const before = JSON.stringify({ ...t, history: 0 });
choose(t, pair(t)[0], games, rand);
undo(t);
assert.equal(JSON.stringify({ ...t, history: 0 }), before);

// 4. Tie inserts directly above the pivot; re-rank removes and restarts.
const pivot = pair(t).find(id => id !== t.current.candidate);
const c2 = t.current.candidate;
tie(t, games, rand);
assert.equal(t.ranked.indexOf(c2) + 1, t.ranked.indexOf(pivot));
reRank(t, c2, games, rand);
assert.ok(!t.ranked.includes(c2));
assert.equal(t.current.candidate, c2);

// 5. A rematch the lower game wins moves it to just above the other; "too close" changes nothing.
const r = fresh();
r.platforms = [1];
r.ranked = games.slice(0, 30).map(g => g.id);
r.current = { rematch: [r.ranked[3], r.ranked[7]], flip: false };
const mover = r.ranked[7], above = r.ranked[3];
choose(r, mover, games, rand);
assert.equal(r.ranked.indexOf(mover), 3);
assert.equal(r.ranked.indexOf(above), 4);
assert.deepEqual([r.stats.rematches, r.stats.agreed], [1, 0]);
assert.deepEqual(r.lastPlaced, { id: mover, rank: 4, moved: true });
const order = [...r.ranked];
r.current = { rematch: [r.ranked[0], r.ranked[1]], flip: true };
tie(r, games, rand);
assert.deepEqual(r.ranked, order);
assert.equal(r.stats.agreed, 1);

console.log(`ok: ranked ${N} games in ${s.stats.comparisons} comparisons (${rematches} rematches)`);
