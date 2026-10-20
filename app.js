import * as R from './rank.js';

const API = 'https://gamerank.crimson-wave-94ca.workers.dev';
const KEY = 'gamerank:v2';
const CAT = 'gamerank:catalogue'; // disposable cache of game details and the candidate pool
const FIELDS = 'fields name,first_release_date,cover.image_id,platforms,total_rating_count;';
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

// Platform choices: counted from the 500 most-rated games overall.
const platforms = shared(async () => {
  if (cat.platCounts) return;
  const top = await query('games', `fields platforms; where total_rating_count > 10 & ${TYPES};
    sort total_rating_count desc; limit 500;`);
  const counts = {};
  for (const g of top) for (const p of g.platforms ?? []) counts[p] = (counts[p] ?? 0) + 1;
  for (const p of await query('platforms', `fields name; where id = (${Object.keys(counts)}); limit 500;`)) {
    cat.platNames[p.id] = p.name;
  }
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
  const stats = `<p class="muted">${s.ranked.length} ranked · ${s.stats.comparisons} comparisons</p>`;
  const search = `<form id="search" class="search">
      <input type="search" name="q" placeholder="Played something not shown? Search IGDB" aria-label="Search games">
      <button>Search</button>
    </form><ul id="results" class="rows"></ul>`;
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
  return `<h1>Which is better?</h1>
    <div class="pair">${card(p[0], '←')}${card(p[1], '→')}</div>
    <div class="controls">
      <button data-act="tie">Too close to call</button>
      <button data-act="undo" ${s.history.length ? '' : 'disabled'}>Undo</button>
    </div>${stats}${search}`;
}

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

function shareText() {
  const n = document.getElementById('topn')?.value ?? '10';
  const year = document.getElementById('year')?.value ?? '';
  let list = s.ranked.map(game);
  if (year) list = list.filter(g => String(g.year) === year);
  if (n !== 'all') list = list.slice(0, Number(n));
  const title = `My ${n === 'all' ? '' : `top ${list.length} `}games${year ? ` of ${year}` : ''}`;
  return [title, ...list.map((g, i) => `${i + 1}. ${g.name}${g.year ? ` (${g.year})` : ''}`)].join('\n');
}

function list() {
  if (!s.ranked.length) return `<h1>My list</h1><p>Nothing ranked yet. <a href="#rank">Start ranking</a>.</p>`;
  const years = [...new Set(s.ranked.map(id => game(id).year).filter(Boolean))].sort((a, b) => b - a);
  return `<h1>My list</h1>
    <details class="share"><summary>Share</summary>
      <label>Show <select id="topn"><option>10</option><option>25</option><option>100</option><option value="all">All</option></select></label>
      <label>Year <select id="year"><option value="">Any</option>${years.map(y => `<option>${y}</option>`).join('')}</select></label>
      <button data-act="copy">Copy</button>
      <pre id="preview"></pre>
    </details>
    <ol class="rows">${s.ranked.map((id, i) => row(id, `
      <button data-act="rerank" data-id="${id}">Re-rank</button>
      <button data-act="backlog" data-id="${id}">Backlog</button>
      <button data-act="ignored" data-id="${id}">Ignore</button>`, i + 1)).join('')}</ol>`;
}

const row = (id, actions, num) => {
  const g = game(id);
  return `<li>${num ? `<span class="num muted">${num}.</span>` : ''}<span class="thumb">${cover(g, 't_thumb')}</span><span class="name">${label(g)}</span><span class="acts">${actions}</span></li>`;
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

async function render() {
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
  const pre = document.getElementById('preview');
  if (pre) pre.textContent = shareText();
  if (s.lastPlaced && route === 'rank') {
    toast(`Placed ${game(s.lastPlaced.id).name} at #${s.lastPlaced.rank}`);
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
    case 'rerank': R.reRank(s, id, pool()); save(); location.hash = '#rank'; break;
    case 'retry': break;
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
  if (e.target.id === 'topn' || e.target.id === 'year') document.getElementById('preview').textContent = shareText();
  if (e.target.id === 'import' && e.target.files[0]) {
    e.target.files[0].text().then(async t => {
      const d = JSON.parse(t);
      if (!Array.isArray(d.ranked) || !Array.isArray(d.platforms)) throw new Error('not a GameRank export');
      s = Object.assign(R.fresh(), d, { history: [] });
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
  else if (e.key === 'b') act('backlog', s.current.candidate);
  else if (e.key === 'i') act('ignored', s.current.candidate);
});

addEventListener('hashchange', render);

s = Object.assign(R.fresh(), readJSON(KEY));
render();
