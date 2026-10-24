import * as R from './rank.js';

const API = 'https://gamerank.crimson-wave-94ca.workers.dev';
const KEY = 'gamerank:v2';
const CAT = 'gamerank:catalogue:v3'; // disposable cache of game details and the candidate pools
const FIELDS = 'fields name,first_release_date,cover.image_id,platforms,total_rating_count,franchises.name,collections.name,aggregated_rating,total_rating;';
const TYPES = 'game_type = (0,4,8,9,10)'; // main, standalone expansion, remake, remaster, expanded
const POOL_MIN = 50;
const SEED_TARGET = 50; // matches rank.js: new players start on acclaimed games
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

let cat = Object.assign({ games: {}, platNames: {}, pools: {} },
  readJSON(CAT));
let s = R.fresh();

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function save() {
  const now = syncable();
  if (now !== lastSaved) { // a real change, not just a re-render
    if (lastSaved !== null) s.updated = Date.now();
    lastSaved = now;
  }
  try { localStorage.setItem(KEY, JSON.stringify(s)); localStorage.setItem(CAT, JSON.stringify(cat)); } catch {}
  if (auth && now !== lastSent) { clearTimeout(syncTimer); syncTimer = setTimeout(push, 2000); }
}

// ---- account sync (passkeys; the Worker stores the list in D1) ----

const AUTH = 'gamerank:auth';
let auth = readJSON(AUTH); // { token, synced } when signed in
let lastSaved = null, lastSent = null, syncTimer = null;
const webauthn = () => import('https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@14.0.0/+esm');

// Everything syncs except this device's undo history and toast state.
function syncable() {
  const { history, lastPlaced, updated, ...rest } = s;
  return JSON.stringify(rest);
}

function setAuth(a) {
  auth = a;
  try { a ? localStorage.setItem(AUTH, JSON.stringify(a)) : localStorage.removeItem(AUTH); } catch {}
}

async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${auth.token}` }) } });
  const j = await r.json().catch(() => null);
  if (r.status === 401 && auth && path === '/list') { setAuth(null); toast('Signed out. Sign in again in Settings.'); }
  if (!r.ok) throw new Error(j?.error ?? `${r.status}`);
  return j;
}

// ponytail: last write wins; two devices editing at once can overwrite each other.
async function push() {
  const body = syncable();
  s.updated ??= Date.now();
  try {
    await api('PUT', '/list', { data: JSON.parse(body), updated: s.updated });
    lastSent = body;
    setAuth({ ...auth, synced: Date.now() });
  } catch {
    if (auth) { clearTimeout(syncTimer); syncTimer = setTimeout(push, 30000); }
  }
}

function adopt(remote) {
  s = withDefaults({ ...remote.data, updated: remote.updated });
  lastSaved = lastSent = syncable();
  save();
  render();
}

// Newer copy wins: take the account's list or send this device's.
async function pull() {
  if (!auth) return;
  try {
    const remote = await api('GET', '/list');
    if (remote && remote.updated > (s.updated ?? 0)) adopt(remote);
    else if (!remote || remote.updated < (s.updated ?? 0)) push();
    else lastSent = syncable();
  } catch {}
}

const hasData = st => st.ranked.length + st.backlog.length + st.ignored.length > 0;
const passkeyError = err => err.name !== 'NotAllowedError' && toast(`Passkey failed: ${err.message}`); // NotAllowed = cancelled

async function signUp() {
  try {
    const { startRegistration } = await webauthn();
    const { challengeId, options } = await api('POST', '/auth/register/options');
    const response = await startRegistration({ optionsJSON: options });
    setAuth(await api('POST', '/auth/register/verify', { challengeId, response }));
    await push();
    toast('Account created. Your list now syncs.');
    render();
  } catch (err) { passkeyError(err); }
}

async function signIn() {
  try {
    const { startAuthentication } = await webauthn();
    const { challengeId, options } = await api('POST', '/auth/login/options');
    const response = await startAuthentication({ optionsJSON: options });
    setAuth(await api('POST', '/auth/login/verify', { challengeId, response }));
    const remote = await api('GET', '/list');
    if (!remote) await push();
    else if (!hasData(s)) adopt(remote);
    else if (confirm(`Use your account's list (${remote.data.ranked.length} ranked) on this device?\n\n` +
                     `This device's list (${s.ranked.length} ranked) will be replaced.`)) adopt(remote);
    else if (confirm(`Replace your account's list with this device's list instead?`)) await push();
    else { await signOut(); return; }
    toast('Signed in. Your list now syncs.');
    render();
  } catch (err) { passkeyError(err); }
}

async function signOut() {
  await api('POST', '/auth/logout').catch(() => {});
  setAuth(null);
  render();
}

async function deleteAccount() {
  if (!confirm('Delete your account and the list saved in it? The list on this device stays.')) return;
  try {
    await api('DELETE', '/account');
    setAuth(null);
    toast('Account deleted. You can remove the GameRank passkey from your password manager.');
    render();
  } catch (err) { toast(`Delete failed: ${err.message}`); }
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
      critic: g.aggregated_rating ?? g.total_rating ?? null, // starting rating
    };
  }
  return list.map(g => g.id);
}

const game = id => cat.games[id];
const userIds = () => [...s.ranked, ...s.backlog, ...s.ignored,
  ...(s.current ? [s.current.featured, s.current.reference] : [])].filter(id => id != null);

// Where new games come from: that year's games in year mode; otherwise the critics' top
// 1000 for a new player, then those and the most-rated games, alternately.
const POOLS = {
  acclaimed: { where: 'aggregated_rating_count >= 3 & total_rating_count > 50', sort: 'aggregated_rating', max: 1000 },
  all: { where: 'total_rating_count > 5', sort: 'total_rating_count' },
};
// Year and/or platform mode: one pool for that combination, e.g. 'y2017-p130'.
function focusPool(key) {
  const y = Number(key.match(/y(\d+)/)?.[1]), p = key.match(/p(\d+)/)?.[1];
  return { sort: 'total_rating_count', where: [y ? `total_rating_count > 0 & first_release_date >= ${Date.UTC(y, 0) / 1000
    } & first_release_date < ${Math.floor(Math.min(Date.UTC(y + 1, 0), Date.now()) / 1000)}` : 'total_rating_count > 2',
    p && `platforms = (${p})`].filter(Boolean).join(' & ') };
}
const focusKey = () => [s.year != null && `y${s.year}`, s.platform != null && `p${s.platform}`].filter(Boolean).join('-');
const poolKeys = () => (focusKey() ? [focusKey()] : s.ranked.length < SEED_TARGET ? ['acclaimed'] : ['acclaimed', 'all']);
const poolSpec = key => POOLS[key] ?? focusPool(key);
function newGames() {
  const lists = poolKeys().map(k => (cat.pools[k]?.ids ?? []).map(game));
  return lists.length === 1 ? lists[0] : lists[0].flatMap((g, i) => [g, lists[1][i]]).concat(lists[1].slice(lists[0].length)).filter(Boolean);
}

// Fetch details for any of the user's games missing from the cache (import, cleared cache).
async function ensureDetails() {
  const missing = userIds().filter(id => !game(id));
  for (let i = 0; i < missing.length; i += 500) {
    addGames(await query('games', `${FIELDS} where id = (${missing.slice(i, i + 500)}); limit 500;`));
  }
  // ponytail: ids IGDB no longer returns are dropped
  for (const k of ['ranked', 'backlog', 'ignored']) s[k] = s[k].filter(game);
  for (const id of s.ranked) { // migrated or older entries lack these
    s.ratings[id].year ??= game(id).year;
    s.ratings[id].platforms ??= game(id).platforms;
  }
  if (s.current && userIds().some(id => !game(id))) s.current = null;
}

// Concurrent renders share one in-flight call instead of fetching the same page twice.
const shared = fn => () => (fn.p ??= fn().finally(() => { fn.p = null; }));

// Keep at least POOL_MIN unplayed candidates (not only on hidden platforms) in each pool in use.
// ponytail: hidden platforms are filtered here, not in the query; hiding most platforms means fetching many pages.
// Year pools only hold games already out; new games have few ratings.
const topUp = shared(async () => {
  const used = new Set(userIds());
  for (const key of poolKeys()) {
    const spec = poolSpec(key), pl = cat.pools[key] ??= { ids: [], offset: 0, done: false };
    const unplayed = () => pl.ids.filter(id => !used.has(id) && R.eligible(s, game(id))).length;
    while (!pl.done && unplayed() < POOL_MIN) {
      const page = await query('games', `${FIELDS} where platforms != null & ${spec.where} & ${TYPES};
        sort ${spec.sort} desc; limit 500; offset ${pl.offset};`);
      pl.ids.push(...addGames(page));
      pl.offset += 500;
      pl.done = page.length < 500 || pl.offset >= (spec.max ?? Infinity);
    }
  }
  save();
});

async function platformNames(ids) {
  const missing = ids.filter(p => !cat.platNames[p]);
  if (!missing.length) return;
  for (const p of await query('platforms', `fields name; where id = (${missing}); limit 500;`)) cat.platNames[p.id] = p.name;
  save();
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


async function rank() {
  await topUp();
  R.next(s, newGames());
  save();
  const c = s.current;
  const stats = `<p class="muted">${s.ranked.length} ranked · ${s.stats.comparisons} comparisons${
    s.ranked.length ? ` · list confidence ${Math.round(100 * R.listConfidence(s))}%` : ''}</p>`;
  const search = searchBox('Played something not shown? Search IGDB');
  const thisYear = new Date().getFullYear();
  // Platforms to offer: those of your ranked games and the games on offer, most common first.
  const plat = byCount([...s.ranked.map(game), ...newGames()].flatMap(g => g?.platforms ?? [])).map(Number)
    .filter(p => !s.hiddenPlatforms.includes(p)).slice(0, 25);
  if (s.platform != null && !plat.includes(s.platform)) plat.unshift(s.platform);
  await platformNames(plat);
  const platName = p => cat.platNames[p] ?? `Platform ${p}`;
  const focusName = [s.year, s.platform != null && platName(s.platform)].filter(Boolean).join(' ');
  const focusCount = focusName && s.ranked.filter(id => (s.year == null || game(id)?.year === s.year) &&
    (s.platform == null || game(id)?.platforms.includes(s.platform))).length;
  const mode = `<div class="mode"><label>Games from <select data-mode="year" aria-label="Games from">
      <option value="">All years</option>${Array.from({ length: thisYear - 1970 }, (_, i) => thisYear - i)
        .map(y => `<option ${s.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <label>on <select data-mode="platform" aria-label="Games on"><option value="">All platforms</option>${plat
        .map(p => `<option value="${p}" ${s.platform === p ? 'selected' : ''}>${esc(platName(p))}</option>`).join('')}</select></label>
      ${focusName ? `<a href="#list" data-act="focus-list">Your ${esc(focusName)} list (${focusCount})</a>` : ''}</div>`;
  if (!c) return `${mode}<h1>No games left</h1><p>Every ${focusName ? `${esc(focusName)} ` : ''}game not on a hidden platform is ranked, backlogged or ignored.</p>${stats}${search}`;
  const f = c.isNew ? c.game : game(c.featured), ref = c.reference != null ? game(c.reference) : null;
  const both = [f, ref].filter(Boolean);
  await platformNames(both.flatMap(g => g.platforms));
  const plats = [...new Set(both.flatMap(g => g.platforms))].filter(pl => !s.hiddenPlatforms.includes(pl))
    .map(pl => `<button data-act="hide-platform" data-id="${pl}">${esc(cat.platNames[pl] ?? `Platform ${pl}`)}</button>`).join('');
  // No ranks or hints about the current order: just the comparison.
  return `${mode}
    <div class="duel">
      <div class="featured" title="Swipe or use the arrow keys">${cover(f, 't_cover_big')}<div class="title">${label(f)}</div></div>
      ${ref ? `<p class="ask">Better or worse than</p>
        <div class="vs">${cover(ref, 't_thumb')}<span>${label(ref)}</span></div>`
        : '<p class="ask">Have you played this?</p>'}
      <div class="answers">${ref
        ? '<button data-act="worse">← Worse</button><button data-act="better" class="primary">Better →</button>'
        : '<button data-act="played" class="primary">Played it →</button>'}</div>
      ${c.isNew ? `<div class="answers secondary"><button data-act="havent">↓ Haven't played</button>
        <button data-act="want">↑ Want to play</button></div>` : ''}
      <div class="controls"><button data-act="undo" ${s.history.length ? '' : 'disabled'}>Undo</button></div>
    </div>
    ${plats && `<details class="hide-plat"><summary>Never had one of these platforms?</summary>
      <p class="muted">Hide a platform and games only on it stop coming up.</p><div class="skip">${plats}</div></details>`}
    ${stats}${search}`;
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
      return row(id, at >= 0 ? '<span class="muted">In your list</span>' : `<button data-act="recheck" data-id="${id}">Rank it</button>`);
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
  const plats = byCount(games.flatMap(g => g.platforms)).map(Number).filter(p => !s.hiddenPlatforms.includes(p));
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
      <button data-act="recheck" data-id="${g.id}">Recheck</button>
      <button data-act="backlog" data-id="${g.id}">Backlog</button>
      <button data-act="ignored" data-id="${g.id}">Not played</button>`, i + 1, narrowed && rank)).join('')}</ol>
    <div class="list-foot">
      <button class="primary" data-act="share">Share ${narrowed ? 'this list' : 'my list'}</button>
      <button data-act="copy">Copy as text</button>
    </div>` : '<p class="muted">No games match these filters.</p>'}`;
}

const row = (id, actions, num, overall) => {
  const g = game(id);
  const conf = num && s.ratings[id] ? Math.round(100 * R.confidence(s, id)) : null;
  return `<li>${num ? `<span class="num muted">${num}.</span>` : ''}<span class="thumb">${cover(g, 't_thumb')}</span><span class="name">${label(g)}${overall ? ` <span class="muted">· #${overall} overall</span>` : ''}${
    conf != null ? `<span class="conf" style="--c:${conf}%" title="Confidence ${conf}%"></span>` : ''}</span><span class="acts">${actions}</span></li>`;
};

function backlog() {
  if (!s.backlog.length) return `<h1>Backlog</h1><p class="muted">Games you mark "Want to play" appear here.</p>`;
  return `<h1>Backlog</h1><ul class="rows">${s.backlog.map(id => row(id, `
    <button data-act="recheck" data-id="${id}">Played it</button>
    <button data-act="ignored" data-id="${id}">Not played</button>`)).join('')}</ul>`;
}

function ignored() {
  if (!s.ignored.length) return `<h1>Not played</h1><p class="muted">Games you mark "Haven't played" appear here.</p>`;
  return `<h1>Not played</h1><ul class="rows">${s.ignored.map(id => row(id, `
    <button data-act="restore" data-id="${id}">Restore</button>`)).join('')}</ul>`;
}

function account() {
  if (!window.PublicKeyCredential) return '<p class="muted">This browser doesn\'t support passkeys, so your list stays on this device.</p>';
  if (!auth) return `<p>Save your list to an account so it follows you to your other devices. It uses a passkey
      (Face ID, Touch ID or your device PIN): no email or password.</p>
    <p><button class="primary" data-act="signup">Save my list with a passkey</button>
       <button data-act="signin">Sign in with a passkey</button></p>`;
  return `<p>Signed in with a passkey. Your list syncs automatically${auth.synced
      ? ` (last saved ${new Date(auth.synced).toLocaleString()})` : ''}.</p>
    <p><button data-act="signout">Sign out</button> <button data-act="delete-account" class="danger">Delete account</button></p>`;
}

async function hiddenPlatforms() {
  const hidden = s.hiddenPlatforms;
  if (!hidden.length) return '<p class="muted">No hidden platforms. To hide one, open "Never had one of these?" under a game you\'re ranking.</p>';
  await platformNames(hidden);
  return `<p>Hidden platforms (games only on these don't come up):</p><ul class="rows">${hidden.map(p => `<li>
    <span class="name">${esc(cat.platNames[p] ?? `Platform ${p}`)}</span>
    <span class="acts"><button data-act="show-platform" data-id="${p}">Show again</button></span></li>`).join('')}</ul>`;
}

async function settings() {
  return `<h1>Settings</h1>
    <h2>Account</h2>${account()}
    <h2>Data</h2>
    ${await hiddenPlatforms()}
    <p><button data-act="export">Export data</button>
       <label class="button">Import data<input type="file" id="import" accept=".json,application/json" hidden></label></p>
    <p><button data-act="reset" class="danger">Reset everything</button></p>
    <p class="muted">${Object.keys(cat.games).length} games cached. Game data and covers from <a href="https://www.igdb.com">IGDB</a>.</p>`;
}

const screens = { rank, list, backlog, ignored, settings };

async function render() {
  const n = render.n = (render.n ?? 0) + 1; // drop results of renders that were overtaken
  let route = location.hash.slice(1) || 'rank';
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
}

function act(action, id) {
  switch (action) {
    case 'better': case 'worse': R.answer(s, action === 'better', newGames()); break;
    case 'played': R.playedIt(s, newGames()); break;
    case 'havent': case 'want': {
      const name = s.current.game.name;
      R.move(s, s.current.featured, action === 'want' ? 'backlog' : 'ignored', newGames());
      toast(action === 'want' ? `${name} added to your backlog` : `${name} moved to Not played`);
      break;
    }
    case 'undo': R.undo(s); break;
    case 'backlog': case 'ignored': R.move(s, id, action, newGames()); break;
    case 'restore': R.restore(s, id, newGames()); break;
    case 'hide-platform':
      R.hidePlatform(s, id, newGames());
      toast(`Hidden ${cat.platNames[id] ?? 'platform'}. Undo or Settings brings it back.`);
      break;
    case 'show-platform': R.showPlatform(s, id); break;
    case 'focus-list':
      Object.assign(filters, { top: 'all', series: '', year: s.year == null ? '' : String(s.year),
                               platform: s.platform == null ? '' : String(s.platform) });
      return; // the link navigates
    case 'recheck':
      R.recheck(s, game(id), newGames());
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
    case 'signup': signUp(); return;
    case 'signin': signIn(); return;
    case 'signout': signOut(); return;
    case 'delete-account': deleteAccount(); return;
    case 'reset':
      if (!confirm(`Delete all rankings, backlog and ignored games${auth ? ', here and in your account' : ''}?`)) return;
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
  if (e.target.dataset.mode) {
    s[e.target.dataset.mode] = e.target.value ? Number(e.target.value) : null; // year or platform
    s.current = null; // the shown game may not match; it comes up again later
    save();
    render();
  }
  if (e.target.dataset.filter) {
    filters[e.target.dataset.filter] = e.target.value;
    render();
  }
  if (e.target.id === 'import' && e.target.files[0]) {
    e.target.files[0].text().then(async t => {
      const d = JSON.parse(t);
      if (!Array.isArray(d.ranked)) throw new Error('not a GameRank export');
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
  if (e.target.id === 'search') searchGames(e.target.q.value);
});

// Arrow keys and swipes on the featured game map to the answer buttons on screen.
const shortcut = { ArrowRight: ['better', 'played'], ArrowLeft: ['worse'], ArrowUp: ['want'], ArrowDown: ['havent'], u: ['undo'] };
const onScreen = names => names.find(a => view.querySelector(`[data-act="${a}"]:not(:disabled)`));

document.addEventListener('keydown', e => {
  if ((location.hash || '#rank') !== '#rank' || e.target.closest?.('input, select, textarea')) return;
  const a = shortcut[e.key] && onScreen(shortcut[e.key]);
  if (a) { e.preventDefault(); act(a); }
});

let drag = null;
const swipe = (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy)) < 80 ? null
  : Math.abs(dx) > Math.abs(dy) ? onScreen(dx > 0 ? ['better', 'played'] : ['worse']) : onScreen([dy < 0 ? 'want' : 'havent']);
const swipeLabel = { better: 'Better', played: 'Played it', worse: 'Worse', want: 'Want to play', havent: "Haven't played" };
view.addEventListener('pointerdown', e => {
  const el = e.target.closest('.featured');
  if (!el) return;
  drag = { el, x: e.clientX, y: e.clientY };
  el.setPointerCapture(e.pointerId);
});
view.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 25}deg)`;
  drag.el.dataset.hint = swipeLabel[swipe(dx, dy)] ?? '';
});
const endDrag = e => {
  if (!drag) return;
  const { el, x, y } = drag, a = e.type === 'pointerup' && swipe(e.clientX - x, e.clientY - y);
  drag = null;
  el.dataset.hint = '';
  if (!a) { el.style.transform = ''; return; }
  el.style.transition = 'transform .15s, opacity .15s';
  el.style.transform += ' scale(.9)';
  el.style.opacity = 0;
  setTimeout(() => act(a), 150);
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pull();
  else if (auth && syncable() !== lastSent) push();
});

// Saved or imported state may predate newer fields.
function withDefaults(saved) {
  const f = R.fresh();
  const st = Object.assign(f, saved, { stats: { ...f.stats, ...saved?.stats }, history: saved?.history ?? [] });
  R.migrate(st, id => game(id)?.year);
  return st;
}

s = withDefaults(readJSON(KEY));
lastSaved = syncable();
render();
pull();
