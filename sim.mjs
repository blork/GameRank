// Accuracy simulation for rank.js: node sim.mjs
// 300 games with a known true order (id 0 = best). Answers are noisy: the chance of picking the
// worse game is 0.5 * exp(-d / 8), d = true rank distance. Critic score = 90 - 30*t/300 + N(0, sd),
// which seeds each game's prior; 'none' means no critic data. Results average 10 seeds.
// Reported per budget: games ranked, mean places off, true top 10 found in our top 10.
// Baseline (29 Oct 2026, sd 8): 3,000 answers -> 8.1/10, 9.9 off; 6,000 -> 9.1/10, 7.0 off.
// The old binary insertion + rematches scored 7.5/10, 5.5 off at 3,000.
import * as G from './rank.js';
const N = 300, BUDGETS = [1000, 2000, 3000, 4500, 6000];
let seed; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const pick = (a, b) => { const right = Math.min(a, b), wrong = Math.max(a, b);
  return rand() < 0.5 * Math.exp(-(wrong - right) / 8) ? wrong : right; };
function score(list) { // list: true ranks in our order
  const sorted = [...list].sort((a, b) => a - b), pos = new Map(sorted.map((t, i) => [t, i]));
  const off = list.reduce((s, t, i) => s + Math.abs(pos.get(t) - i), 0) / (list.length || 1);
  return { off, top10: list.slice(0, 10).filter(t => t < 10).length, n: list.length };
}
function games(criticSd) {
  const gs = Array.from({ length: N }, (_, t) => ({ id: t, platforms: [1], year: 2000,
    critic: criticSd === 'none' ? undefined : 90 - 30 * t / N + gauss() * criticSd }));
  return gs.sort((a, b) => (b.critic ?? 0) - (a.critic ?? 0) || rand() - .5); // acclaimed first
}
function run(criticSd) {
  const gs = games(criticSd), s = G.fresh(), out = {}; let k = 0;
  G.next(s, gs, rand);
  while (k < BUDGETS.at(-1) && s.current) {
    const c = s.current;
    if (c.reference == null) { G.playedIt(s, gs, rand); continue; }
    G.answer(s, pick(c.featured, c.reference) === c.featured, gs, rand); k++;
    if (BUDGETS.includes(k)) out[k] = score(s.ranked);
  }
  return out;
}
const avg = f => { const acc = {}; for (let i = 1; i <= 10; i++) { seed = i * 7919; const o = f();
  for (const b of BUDGETS) { acc[b] ??= { off: 0, top10: 0, n: 0 }; for (const m in o[b] ?? {}) acc[b][m] += o[b][m] / 10; } } return acc; };
const rows = { 'critic prior sd 8': avg(() => run(8)), 'critic prior sd 15': avg(() => run(15)), 'no critic data': avg(() => run('none')) };
console.log('answers'.padEnd(22) + BUDGETS.map(b => String(b).padStart(22)).join(''));
for (const [name, r] of Object.entries(rows))
  console.log(name.padEnd(22) + BUDGETS.map(b => `${r[b].n.toFixed(0)}g ${r[b].off.toFixed(1)}off ${r[b].top10.toFixed(1)}/10`.padStart(22)).join(''));
