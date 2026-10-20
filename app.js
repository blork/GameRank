import * as R from './rank.js';

const API = 'https://gamerank.crimson-wave-94ca.workers.dev';
const KEY = 'gamerank:v2';
const CAT = 'gamerank:catalogue:v2'; // disposable cache of game details and the candidate pool
const FIELDS = 'fields name,first_release_date,cover.image_id,platforms,total_rating_count,franchises.name,collections.name;';
const TYPES = 'game_type = (0,4,8,9,10)'; // main, standalone expansion, remake, remaster, expanded
const POOL_MIN = 50;
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

let cat = Object.assign({ games: {}, platNames: {}, platCounts: null, pool: null },
  readJSON(CAT));
let s = R.fresh();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(s)); localStorage.setItem(CAT, JSON.stringify(cat)); } catch {}
}

async function query(endpoint, q) {
  const r = await fetch(`${API}/${endpoint}?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`${endpoint} ${r.status}: ${await r.text()}`);
  return r.json();
}

function addGames(list) {
  for (const g of list) {
    cat.games[g.id] = {
      id: g.id, name: g.name,
      year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
      cover: g.cover?.image_id ?? null, platforms: g.platforms ?? [], pop: g.total_rating_count ?? 0,
      series: [...new Set([...g.franchises ?? [], ...g.collections ?? []].map(x => x.name))],
    };
  }
  return list.map(g => g.id);
}

const game = id => cat.games[id];
const pool = () => (cat.pool?.ids ?? []).map(game);
const userIds = () => [...s.ranked, ...s.backlog, ...s.ignored,
  ...(s.current ? [s.current.candidate, s.current.opponent] : [])].filter(id => id != null);

// Fetch details for any of the user's games missing from the cache (import, cleared cache).
async function ensureDetails() {
  const missing = userIds().filter(id => !game(id));
  for (let i = 0; i < missing.length; i += 500) {
    addGames(await query('games', `${FIELDS} where id = (${missing.slice(i, i + 500)}); limit 500;`));
  }
  // ponytail: ids IGDB no longer returns are dropped
  for (const k of ['ranked', 'backlog', 'ignored']) s[k] = s[k].filter(game);
  if (s.current && userIds().some(id => !game(id))) s.current = null;
}

// Concurrent renders share one in-flight call instead of fetching the same page twice.
const shared = fn => () => (fn.p ??= fn().finally(() => { fn.p = null; }));

// Keep at least POOL_MIN unplayed candidates for the selected platforms, most popular first.
const topUp = shared(async () => {
  const key = [...s.platforms].sort().join();
  if (cat.pool?.key !== key) cat.pool = { key, ids: [], offset: 0, done: false };
  const used = new Set(userIds());
  while (!cat.pool.done && cat.pool.ids.filter(id => !used.has(id)).length < POOL_MIN) {
    const page = await query('games', `${FIELDS} where platforms = (${key}) & total_rating_count > 5 & ${TYPES};
      sort total_rating_count desc; limit 500; offset ${cat.pool.offset};`);
    cat.pool.ids.push(...addGames(page));
    cat.pool.offset += 500;
    cat.pool.done = page.length < 500;
  }
  save();
});

async function platformNames(ids) {
  const missing = ids.filter(p => !cat.platNames[p]);
  if (!missing.length) return;
  for (const p of await query('platforms', `fields name; where id = (${missing}); limit 500;`)) cat.platNames[p.id] = p.name;
  save();
}

// Platform choices: counted from the 500 most-rated games overall.
const platforms = shared(async () => {
  if (cat.platCounts) return;
  const top = await query('games', `fields platforms; where total_rating_count > 10 & ${TYPES};
    sort total_rating_count desc; limit 500;`);
  const counts = {};
  for (const g of top) for (const p of g.platforms ?? []) counts[p] = (counts[p] ?? 0) + 1;
  await platformNames(Object.keys(counts));
  cat.platCounts = counts;
  save();
});

const esc = t => String(t ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const cover = (g, size) => g.cover
  ? `<img src="https://images.igdb.com/igdb/image/upload/${size}/${g.cover}.jpg" alt="" loading="lazy">`
  : `<div class="nocover">${esc(g.name)}</div>`;
const label = g => `${esc(g.name)}${g.year ? ` <span class="muted">(${g.year})</span>` : ''}`;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ---- screens ----

async function setup() {
  await platforms();
  const counts = cat.platCounts;
  const sel = new Set(s.platforms);
  const plats = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
  return `<h1>Which platforms have you played on?</h1>
    <form id="setup">
      <div class="plats">${plats.map(p => `<label><input type="checkbox" value="${p}" ${sel.has(p) ? 'checked' : ''}>
        ${esc(cat.platNames[p] ?? `Platform ${p}`)}</label>`).join('')}</div>
      <button class="primary">Save</button>
    </form>`;
}

async function rank() {
  await topUp();
  R.ensureCurrent(s, pool());
  save();
  const p = R.pair(s);
  const { comparisons, rematches, agreed } = s.stats;
  const stats = `<p class="muted">${s.ranked.length} ranked · ${comparisons} comparisons${rematches
    ? ` · rematches agree ${Math.round(100 * agreed / rematches)}% (${rematches})` : ''}</p>`;
  const search = searchBox('Played something not shown? Search IGDB');
  if (!p) return `<h1>No games left</h1><p>Every game on your platforms is ranked, backlogged or ignored.</p>${stats}${search}`;
  const c = s.current;
  const skippable = id => id === c.candidate || c.opponent != null;
  const card = (id, key) => {
    const g = game(id);
    return `<div class="side">
      <button class="card" data-act="choose" data-id="${id}" title="Pick (${key})">${cover(g, 't_cover_big')}<span>${label(g)}</span></button>
      ${skippable(id) ? `<div class="skip">Not played:
        <button data-act="backlog" data-id="${id}">Want to play</button>
        <button data-act="ignored" data-id="${id}">Not interested</button></div>` : '<div class="skip muted">In your list</div>'}
    </div>`;
  };
  const left = c.rematch ? `Both are in your list. ${esc(game(c.rematch[0]).name)} is ranked higher; pick the other to move it up.`
    : c.opponent == null && `Placing ${esc(game(c.candidate).name)}: about ${Math.ceil(Math.log2(c.hi - c.lo + 1))} more`;
  return `<h1>${c.rematch ? 'Rematch: which is better now?' : 'Which is better?'}</h1>${left ? `<p class="muted">${left}</p>` : ''}
    <div class="pair">${card(p[0], '←')}${card(p[1], '→')}</div>
    <div class="controls">
      <button data-act="tie">Too close to call</button>
      <button data-act="undo" ${s.history.length ? '' : 'disabled'}>Undo</button>
    </div>${stats}${search}`;
}

const searchBox = placeholder => `<form id="search" class="search">
    <input type="search" name="q" placeholder="${placeholder}" aria-label="Search games">
    <button>Search</button>
  </form><ul id="results" class="rows"></ul>`;

async function searchGames(term) {
  const q = term.replace(/["\\]/g, '').trim();
  const results = document.getElementById('results');
  if (!q) return;
  results.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const ids = addGames(await query('games', `search "${q}"; ${FIELDS} where ${TYPES}; limit 20;`))
      .sort((a, b) => game(b).pop - game(a).pop); // IGDB can't sort search results; fan projects rank low
    save();
    results.innerHTML = ids.length ? ids.map(id => {
      const at = s.ranked.indexOf(id);
      return row(id, at >= 0 ? `<span class="muted">#${at + 1}</span>` : `<button data-act="rerank" data-id="${id}">Rank it</button>`);
    }).join('') : '<li class="muted">No matches</li>';
  } catch (err) {
    results.innerHTML = `<li class="muted">Search failed: ${esc(err.message)}</li>`;
  }
}

const filters = { top: 'all', platform: '', year: '', series: '' }; // per session

function filtered() {
  const { top, platform, year, series } = filters;
  let l = s.ranked.map((id, i) => ({ g: game(id), rank: i + 1 }));
  if (platform) l = l.filter(x => x.g.platforms.includes(Number(platform)));
  if (year) l = l.filter(x => year.endsWith('s') ? Math.floor(x.g.year / 10) * 10 === parseInt(year) : x.g.year === Number(year));
  if (series) l = l.filter(x => x.g.series?.includes(series));
  return top === 'all' ? l : l.slice(0, Number(top));
}

function shareText() {
  const { top, platform, year, series } = filters;
  const l = filtered();
  const what = [series, platform && cat.platNames[platform]].filter(Boolean).join(' ');
  const when = year ? ` of ${year.endsWith('s') ? 'the ' : ''}${year}` : '';
  const title = `My ${top === 'all' ? '' : `top ${l.length} `}${what ? `${what} ` : ''}games${when}`;
  return [title, ...l.map(({ g }, i) => `${i + 1}. ${g.name}${g.year ? ` (${g.year})` : ''}`)].join('\n');
}

// Values sorted by how many ranked games have them.
function byCount(values) {
  const n = {};
  for (const v of values) n[v] = (n[v] ?? 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b));
}

const select = (key, opts) => `<select data-filter="${key}" aria-label="${key}">${opts.map(([v, t]) =>
  `<option value="${esc(v)}" ${filters[key] === String(v) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;

async function list() {
  const search = searchBox('Add a game you\'ve played');
  if (!s.ranked.length) return `<h1>My list</h1>${search}<p>Nothing ranked yet. <a href="#rank">Start ranking</a>.</p>`;
  const games = s.ranked.map(game);
  const years = [...new Set(games.map(g => g.year).filter(Boolean))].sort((a, b) => b - a);
  const decades = [...new Set(years.map(y => `${Math.floor(y / 10) * 10}s`))];
  const plats = byCount(games.flatMap(g => g.platforms)).map(Number).filter(p => s.platforms.includes(p));
  await platformNames(plats);
  const l = filtered();
  const narrowed = l.length < s.ranked.length;
  return `<h1>My list</h1>${search}
    <div class="filters">
      ${select('top', [['all', 'All'], ['10', 'Top 10'], ['25', 'Top 25'], ['100', 'Top 100']])}
      ${select('platform', [['', 'Any platform'], ...plats.map(p => [p, cat.platNames[p] ?? `Platform ${p}`])])}
      ${select('year', [['', 'Any year'], ...decades.map(d => [d, d]), ...years.map(y => [y, y])])}
      ${select('series', [['', 'Any series'], ...byCount(games.flatMap(g => g.series ?? [])).map(x => [x, x])])}
    </div>
    ${l.length ? `<ol class="rows">${l.map(({ g, rank }, i) => row(g.id, `
      <button data-act="rerank" data-id="${g.id}">Re-rank</button>
      <button data-act="backlog" data-id="${g.id}">Backlog</button>
      <button data-act="ignored" data-id="${g.id}">Ignore</button>`, i + 1, narrowed && rank)).join('')}</ol>
    <div class="list-foot">
      <button class="primary" data-act="share">Share ${narrowed ? 'this list' : 'my list'}</button>
      <button data-act="copy">Copy as text</button>
    </div>` : '<p class="muted">No games match these filters.</p>'}`;
}

const row = (id, actions, num, overall) => {
  const g = game(id);
  return `<li>${num ? `<span class="num muted">${num}.</span>` : ''}<span class="thumb">${cover(g, 't_thumb')}</span><span class="name">${label(g)}${overall ? ` <span class="muted">· #${overall} overall</span>` : ''}</span><span class="acts">${actions}</span></li>`;
};

function backlog() {
  if (!s.backlog.length) return `<h1>Backlog</h1><p class="muted">Games you mark "Want to play" appear here.</p>`;
  return `<h1>Backlog</h1><ul class="rows">${s.backlog.map(id => row(id, `
    <button data-act="rerank" data-id="${id}">Played it</button>
    <button data-act="ignored" data-id="${id}">Ignore</button>`)).join('')}</ul>`;
}

function ignored() {
  if (!s.ignored.length) return `<h1>Ignored</h1><p class="muted">Games you mark "Not interested" appear here.</p>`;
  return `<h1>Ignored</h1><ul class="rows">${s.ignored.map(id => row(id, `
    <button data-act="restore" data-id="${id}">Restore</button>`)).join('')}</ul>`;
}

function settings() {
  return `<h1>Settings</h1>
    <p><a href="#setup">Change platforms</a></p>
    <p><button data-act="export">Export data</button>
       <label class="button">Import data<input type="file" id="import" accept=".json,application/json" hidden></label></p>
    <p><button data-act="reset" class="danger">Reset everything</button></p>
    <p class="muted">${Object.keys(cat.games).length} games cached. Game data and covers from <a href="https://www.igdb.com">IGDB</a>.</p>`;
}

const screens = { setup, rank, list, backlog, ignored, settings };

let returnTo = null; // { id, hash }: go back here once this game is placed

async function render() {
  if (returnTo && s.lastPlaced?.id === returnTo.id) {
    const { hash } = returnTo;
    returnTo = null;
    if (location.hash !== hash) return void (location.hash = hash); // hashchange renders
  } else if (returnTo && s.current?.candidate !== returnTo.id) returnTo = null;
  const n = render.n = (render.n ?? 0) + 1; // drop results of renders that were overtaken
  let route = location.hash.slice(1) || 'rank';
  if (!s.platforms.length) route = 'setup';
  if (!screens[route]) route = 'rank';
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.hash === `#${route}`));
  let html;
  try {
    await ensureDetails();
    html = await screens[route]();
  } catch (err) {
    html = `<h1>Couldn't reach the game server</h1><p class="muted">${esc(err.message)}</p>
      <button data-act="retry">Retry</button>`;
  }
  if (n !== render.n) return;
  view.innerHTML = html;
  if (s.lastPlaced) {
    const { id, rank, moved } = s.lastPlaced;
    toast(`${moved ? 'Moved' : 'Placed'} ${game(id).name} ${moved ? 'up to' : 'at'} #${rank}`);
    s.lastPlaced = null;
    save();
  }
}

function act(action, id) {
  switch (action) {
    case 'choose': R.choose(s, id, pool()); break;
    case 'tie': R.tie(s, pool()); break;
    case 'undo': R.undo(s); break;
    case 'backlog': case 'ignored': R.move(s, id, action, pool()); break;
    case 'restore': R.restore(s, id, pool()); break;
    case 'rerank':
      R.reRank(s, id, pool());
      if (location.hash && location.hash !== '#rank') returnTo = { id, hash: location.hash };
      save();
      location.hash = '#rank';
      break;
    case 'retry': break;
    case 'share':
      if (navigator.share) {
        navigator.share({ text: shareText() }).catch(err => err.name !== 'AbortError' && toast('Share failed'));
        return;
      } // falls through to copy
    case 'copy':
      navigator.clipboard.writeText(shareText()).then(() => toast('Copied'), () => toast('Copy failed'));
      return;
    case 'export': {
      const { history, ...out } = s;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
      a.download = `gamerank-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      return;
    }
    case 'reset':
      if (!confirm('Delete all rankings, backlog and ignored games?')) return;
      s = R.fresh();
      break;
  }
  save();
  render();
}

view.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b) act(b.dataset.act, b.dataset.id ? Number(b.dataset.id) : undefined);
});

view.addEventListener('change', e => {
  if (e.target.dataset.filter) {
    filters[e.target.dataset.filter] = e.target.value;
    render();
  }
  if (e.target.id === 'import' && e.target.files[0]) {
    e.target.files[0].text().then(async t => {
      const d = JSON.parse(t);
      if (!Array.isArray(d.ranked) || !Array.isArray(d.platforms)) throw new Error('not a GameRank export');
      s = withDefaults(d);
      await ensureDetails();
      save();
      toast(`Imported ${s.ranked.length} ranked games`);
      render();
    }).catch(err => toast(`Import failed: ${err.message}`));
  }
});

view.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'search') return searchGames(e.target.q.value);
  const picked = [...e.target.querySelectorAll('input:checked')].map(i => Number(i.value));
  if (!picked.length) return toast('Pick at least one platform');
  s.platforms = picked;
  s.current = null; // candidate may no longer match the platforms
  save();
  location.hash = '#rank';
  render();
});

document.addEventListener('keydown', e => {
  if ((location.hash || '#rank') !== '#rank' || e.target.closest?.('input, select, textarea')) return;
  const p = R.pair(s);
  if (!p) return;
  if (e.key === 'ArrowLeft') act('choose', p[0]);
  else if (e.key === 'ArrowRight') act('choose', p[1]);
  else if (e.key === 'u') act('undo');
  else if (e.key === 't') act('tie');
  else if (e.key === 'b' && s.current.candidate != null) act('backlog', s.current.candidate);
  else if (e.key === 'i' && s.current.candidate != null) act('ignored', s.current.candidate);
});

addEventListener('hashchange', render);

// Saved or imported state may predate newer fields.
function withDefaults(saved) {
  const f = R.fresh();
  return Object.assign(f, saved, { stats: { ...f.stats, ...saved?.stats }, seen: saved?.seen ?? {}, history: saved?.history ?? [] });
}

s = withDefaults(readJSON(KEY));
render();
