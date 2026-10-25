// Self-check: node rank.test.mjs
import assert from 'node:assert/strict';
import * as R from './rank.js';

let seed = 1;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const games = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, platforms: [1], year: 2000 + (i % 2), critic: 90 - i / 5 }));
const play = (s, gs, steps, better) => {
  const featured = [];
  for (let k = 0; k < steps && s.current; k++) {
    const c = s.current;
    if (c.reference == null) { R.playedIt(s, gs, rand); continue; }
    featured.push(c);
    R.answer(s, better(c), gs, rand);
  }
  return featured;
};

// 1. Consistent answers converge on the true order (here: lower id is better);
//    no game is featured twice within 3 comparisons; recent opponents aren't repeated.
{
  const gs = games(100), s = R.fresh();
  R.next(s, gs, rand);
  assert.equal(s.current.reference, null, 'first card has nothing to compare with');
  const seen = play(s, gs, 4000, c => c.featured < c.reference);
  assert.equal(s.ranked.length, 100);
  const off = s.ranked.reduce((t, id, i) => t + Math.abs(id - 1 - i), 0) / 100;
  assert.ok(off < 3, `average places off ${off}`);
  assert.ok(s.ranked.slice(0, 10).filter(id => id <= 10).length >= 8, 'top 10');
  for (let i = 10; i < seen.length; i++) {
    const prev = seen.slice(i - 3, i).map(c => c.featured);
    assert.ok(!prev.includes(seen[i].featured), `featured ${seen[i].featured} again within 3`);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(!(seen[i].featured === seen[i - 1].featured && seen[i].reference === seen[i - 1].reference), 'same pair twice in a row');
  }
  assert.ok(R.listConfidence(s) > 0.5, `confidence ${R.listConfidence(s)}`);
}

// 2. While seeding (< 50 ranked), references are spread across the list, not just near neighbours.
{
  const gs = games(20), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 30, c => c.featured < c.reference);
  const counts = {};
  for (let k = 0; k < 4000; k++) {
    s.current = null;
    R.next(s, gs, rand);
    if (s.current?.reference != null) counts[s.current.reference] = (counts[s.current.reference] ?? 0) + 1;
  }
  const n = Object.values(counts);
  assert.equal(n.length, s.ranked.length, 'every ranked game used as a reference');
  assert.ok(Math.min(...n) > 0.4 * Math.max(...n), `seeding references uneven: ${n}`);
}

// 3. Undo after answering about a new game removes it again; Haven't played / Want to play.
{
  const gs = games(10), s = R.fresh();
  R.next(s, gs, rand);
  R.playedIt(s, gs, rand);
  const before = JSON.stringify({ ranked: s.ranked, ratings: s.ratings });
  const c = s.current;
  assert.ok(c.isNew && c.reference != null);
  R.answer(s, true, gs, rand);
  assert.ok(s.ranked.includes(c.featured));
  R.undo(s);
  assert.equal(JSON.stringify({ ranked: s.ranked, ratings: s.ratings }), before);
  assert.equal(s.current.featured, c.featured);
  R.move(s, c.featured, 'ignored', gs, rand);
  assert.deepEqual(s.ignored, [c.featured]);
  assert.ok(!s.ratings[c.featured] && s.current.featured !== c.featured);
}

// 4. Hiding a platform replaces a new featured game that's only on it.
{
  const gs = [{ id: 1, platforms: [1] }, { id: 2, platforms: [9] }, { id: 3, platforms: [9, 1] }];
  const s = R.fresh();
  s.current = { featured: 2, reference: null, isNew: true, game: gs[1] };
  R.hidePlatform(s, 9, gs, () => 0);
  assert.notEqual(s.current.featured, 2);
  R.undo(s);
  assert.deepEqual(s.hiddenPlatforms, []);
}

// 5. Recheck: a searched (unranked) game is added and featured next; a ranked one becomes uncertain.
{
  const gs = games(30), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 200, c => c.featured < c.reference);
  const outsider = { id: 999, platforms: [1], year: 1999, critic: 80 };
  R.recheck(s, outsider, gs, rand);
  assert.equal(s.current.featured, 999);
  assert.ok(s.ranked.includes(999) && !s.current.isNew);
  const top = s.ranked[0], c0 = R.confidence(s, top);
  s.current = null;
  R.recheck(s, gs[0], gs, rand);
  assert.ok(R.confidence(s, top) <= c0 && s.current.featured === gs[0].id);
}

// 6. Year mode: rechecked games and most references come from that year once 5 are ranked.
{
  const gs = games(60), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 600, c => c.featured < c.reference);
  R.setYear(s, 2001, [], rand); // no new games: refine only
  const seen = play(s, gs, 300, c => c.featured < c.reference);
  const yearOf = id => (id % 2 ? 2000 : 2001); // games(): odd ids are 2000
  assert.ok(seen.every(c => yearOf(c.featured) === 2001), 'featured from another year');
  assert.ok(seen.filter(c => yearOf(c.reference) === 2001).length > 0.6 * seen.length, 'references mostly that year');
}

// 7. Migration from the old version keeps the order.
{
  const s = Object.assign(R.fresh(), { ranked: [5, 3, 9], ratings: {}, seen: {}, rematchDue: 1,
    current: { candidate: 4, lo: 0, hi: 3 } });
  R.migrate(s, () => 2010);
  assert.deepEqual(s.ranked, [5, 3, 9]);
  assert.ok(s.ratings[5].r > s.ratings[3].r && s.ratings[3].r > s.ratings[9].r);
  assert.equal(s.current, null);
  assert.ok(!('seen' in s) && !('rematchDue' in s));
}

// 8. Platform mode: rechecked games come from that platform once 5 are ranked.
{
  const gs = games(40).map((g, i) => ({ ...g, platforms: i % 3 ? [1] : [1, 7] })), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 400, c => c.featured < c.reference);
  // fewer than 5 ranked on platform 9: only new platform-9 games are offered
  s.platform = 9;
  s.current = s.upcoming = null; // as the app does on a mode change
  const nine = [{ id: 901, platforms: [9], year: 2000 }, { id: 902, platforms: [9], year: 2000 }];
  for (let k = 0; k < 20; k++) { s.current = null; R.next(s, nine, rand); assert.ok(s.current.isNew, 'offered a ranked game from another platform'); }
  s.platform = 7;
  s.current = s.upcoming = null;
  R.next(s, [], rand);
  const seen = play(s, gs, 100, c => c.featured < c.reference);
  assert.ok(seen.every(c => s.ratings[c.featured].platforms.includes(7)), 'featured from another platform');
}

// 9. The queued game is shown next, never equals the current one, and skips games ranked meanwhile.
{
  const gs = games(40), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 60, c => c.featured < c.reference);
  for (let k = 0; k < 50; k++) {
    const queued = s.upcoming;
    assert.ok(queued && queued.featured !== s.current.featured, 'queued game missing or same as current');
    R.answer(s, k % 2 === 0, gs, rand);
    assert.equal(s.current.featured, queued.featured, 'queued game did not come next');
  }
  const queued = s.upcoming.featured;
  if (s.upcoming.isNew) {
    R.move(s, queued, 'backlog', gs, rand); // e.g. moved from search results meanwhile
    assert.notEqual(s.upcoming?.featured, queued);
  }
}

// 10. Merging: a new re-release stops coming up; two ranked games combine; separate undoes it.
{
  const gs = games(30), s = R.fresh();
  R.next(s, gs, rand);
  play(s, gs, 200, c => c.featured < c.reference);
  const [a, b] = [s.ranked[0], s.ranked[5]], ra = s.ratings[a].r, rb = s.ratings[b].r;
  R.merge(s, b, a, gs, rand);
  assert.ok(!s.ranked.includes(b) && !s.ratings[b] && s.merged[b] === a);
  assert.ok(s.ratings[a].r <= Math.max(ra, rb) && s.ratings[a].r >= Math.min(ra, rb), 'combined rating between the two');
  for (let k = 0; k < 200; k++) { s.current = s.upcoming = null; R.next(s, gs, rand); assert.notEqual(s.current.featured, b, 'merged game offered'); }
  R.undo(s);
  R.undo(s);
  const fresh2 = R.fresh();
  R.merge(fresh2, 7, 3, [], rand);
  R.merge(fresh2, 3, 1, [], rand); // merging a merge target carries its merges along
  assert.deepEqual(fresh2.merged, { 7: 1, 3: 1 });
  R.separate(fresh2, 1);
  assert.deepEqual(fresh2.merged, {});

  // Kept as the original release: Remastered (6036, ranked) + Part I (204350, new) -> The Last of Us (1009)
  const t3 = R.fresh();
  t3.ranked = [5, 6036, 6];
  t3.ratings = { 5: { r: 1600, rd: 60, last: 0, vs: [] }, 6036: { r: 1550, rd: 60, last: 0, vs: [] }, 6: { r: 1500, rd: 60, last: 0, vs: [] } };
  t3.ignored = [1009];
  R.merge(t3, 204350, 6036, [], rand, { id: 1009, year: 2013, platforms: [9] });
  assert.deepEqual(t3.ranked, [5, 1009, 6]);
  assert.equal(t3.ratings[1009].r, 1550);
  assert.equal(t3.ratings[1009].year, 2013);
  assert.deepEqual(t3.merged, { 204350: 1009, 6036: 1009 });
  assert.deepEqual(t3.ignored, [], 'original taken off Not played');
  R.undo(t3);
  assert.deepEqual(t3.ranked, [5, 6036, 6]);
  assert.ok(!t3.ratings[1009] && t3.ratings[6036], 'one undo restores both steps');
}

console.log('ok: convergence, cooldown, seeding spread, undo, platforms, recheck, year mode, migration, platform mode, queue, merging');
