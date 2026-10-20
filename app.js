import * as R from './rank.js';

const KEY = 'gamerank:v1';
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

const data = await fetch('data/games.json').then(r => r.json());
const games = data.games; // sorted by popularity, most popular first
const byId = new Map(games.map(g => [g.id, g]));
let s = load();

function load(saved) {
  if (saved === undefined) try { saved = JSON.parse(localStorage.getItem(KEY)); } catch {}
  const st = Object.assign(R.fresh(), saved);
  // drop ids missing from the dataset (e.g. after regenerating games.json)
  for (const k of ['ranked', 'backlog', 'ignored']) st[k] = st[k].filter(id => byId.has(id));
  if (st.current && !byId.has(st.current.candidate)) st.current = null;
  return st;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

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

function setup() {
  const counts = {};
  for (const g of games) for (const p of g.platforms) counts[p] = (counts[p] ?? 0) + 1;
  const sel = new Set(s.platforms);
  const plats = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
  return `<h1>Which platforms have you played on?</h1>
    <form id="setup">
      <div class="plats">${plats.map(p => `<label><input type="checkbox" value="${p}" ${sel.has(p) ? 'checked' : ''}>
        ${esc(data.platforms[p] ?? `Platform ${p}`)} <span class="muted">${counts[p]}</span></label>`).join('')}</div>
      <button class="primary">Save</button>
    </form>`;
}

function rank() {
  R.ensureCurrent(s, games);
  save();
  const p = R.pair(s);
  const stats = `<p class="muted">${s.ranked.length} ranked · ${s.stats.comparisons} comparisons</p>`;
  if (!p) return `<h1>No games left</h1><p>Every game on your platforms is ranked, backlogged or ignored.</p>${stats}`;
  const c = s.current;
  const skippable = id => id === c.candidate || c.opponent != null;
  const card = (id, key) => {
    const g = byId.get(id);
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
    </div>${stats}`;
}

function shareText() {
  const n = document.getElementById('topn')?.value ?? '10';
  const year = document.getElementById('year')?.value ?? '';
  let list = s.ranked.map(id => byId.get(id));
  if (year) list = list.filter(g => String(g.year) === year);
  if (n !== 'all') list = list.slice(0, Number(n));
  const title = `My ${n === 'all' ? '' : `top ${list.length} `}games${year ? ` of ${year}` : ''}`;
  return [title, ...list.map((g, i) => `${i + 1}. ${g.name}${g.year ? ` (${g.year})` : ''}`)].join('\n');
}

function list() {
  if (!s.ranked.length) return `<h1>My list</h1><p>Nothing ranked yet. <a href="#rank">Start ranking</a>.</p>`;
  const years = [...new Set(s.ranked.map(id => byId.get(id).year).filter(Boolean))].sort((a, b) => b - a);
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
  const g = byId.get(id);
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
    <p class="muted">${games.length} games in dataset. Game data and covers from <a href="https://www.igdb.com">IGDB</a>.</p>`;
}

const screens = { setup, rank, list, backlog, ignored, settings };

function render() {
  let route = location.hash.slice(1) || 'rank';
  if (!s.platforms.length) route = 'setup';
  if (!screens[route]) route = 'rank';
  view.innerHTML = screens[route]();
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.hash === `#${route}`));
  const pre = document.getElementById('preview');
  if (pre) pre.textContent = shareText();
  if (s.lastPlaced && route === 'rank') {
    toast(`Placed ${byId.get(s.lastPlaced.id).name} at #${s.lastPlaced.rank}`);
    s.lastPlaced = null;
    save();
  }
}

function act(action, id) {
  switch (action) {
    case 'choose': R.choose(s, id, games); break;
    case 'tie': R.tie(s, games); break;
    case 'undo': R.undo(s); break;
    case 'backlog': case 'ignored': R.move(s, id, action, games); break;
    case 'restore': R.restore(s, id, games); break;
    case 'rerank': R.reRank(s, id, games); save(); location.hash = '#rank'; return;
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
    e.target.files[0].text().then(t => {
      const d = JSON.parse(t);
      if (!Array.isArray(d.ranked) || !Array.isArray(d.platforms)) throw new Error('not a GameRank export');
      s = load(d);
      save();
      toast(`Imported ${s.ranked.length} ranked games`);
      render();
    }).catch(err => toast(`Import failed: ${err.message}`));
  }
});

view.addEventListener('submit', e => {
  e.preventDefault();
  const picked = [...e.target.querySelectorAll('input:checked')].map(i => Number(i.value));
  if (!picked.length) return toast('Pick at least one platform');
  s.platforms = picked;
  if (s.current) s.current = null; // candidate may no longer match the platforms
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
render();
