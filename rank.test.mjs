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

// 1. Honest answers reproduce the true order with <= ceil(log2(n+1)) comparisons per insert.
const s = fresh();
s.platforms = [1];
ensureCurrent(s, games, rand);
let steps = 0, n = 0;
while (s.current) {
  const before = s.ranked.length;
  choose(s, better(pair(s)), games, rand);
  steps++;
  if (s.ranked.length !== before) {
    if (before > 0) assert.ok(steps <= Math.ceil(Math.log2(before + 1)), `insert into ${before} took ${steps}`);
    steps = 0; n++;
  }
}
assert.equal(s.ranked.length, N);
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

console.log(`ok: ranked ${N} games in ${s.stats.comparisons} comparisons`);
