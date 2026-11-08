import {
  GRANULARITIES, SORTS, HIDDEN_USER, parsePageInput, fetchRevisions, buildTimeline, buildUsers,
  autoGranularity, estimateBins, addUnits, floorTo, fmtPeriod, fmtDate, fmtInt, timelineCsv, usersCsv,
  fetchBotUsers, BOT_NAME, combineUsers, sortCombined, fmtAge, approxWords, resolvePage, editorBreakdown, editStats, recordHolders, topUsers, editDuration, fmtDuration,
} from './lib/core.js';

const MAX_BINS = 4000;   // granularities that would exceed this are disabled
const AUTO_BINS = 300;   // "Auto" picks the finest unit at or under this (divided by the number of pages)
const USER_BATCH = 150;  // user rows added per infinite-scroll step
const RECENT_MS = 7 * 864e5; // names turn blue if the user edited within this window
const MAX_PAGES = 5;

// Wikipedias offered in each search box's language list (largest first, roughly). A code from a
// pasted URL or the address bar that isn't here gets added to that box's list.
const LANGS = [
  ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['ja', '日本語'],
  ['ru', 'Русский'], ['it', 'Italiano'], ['zh', '中文'], ['pt', 'Português'], ['ar', 'العربية'],
  ['fa', 'فارسی'], ['pl', 'Polski'], ['nl', 'Nederlands'], ['uk', 'Українська'], ['he', 'עברית'],
  ['id', 'Bahasa Indonesia'], ['tr', 'Türkçe'], ['cs', 'Čeština'], ['sv', 'Svenska'], ['ko', '한국어'],
  ['vi', 'Tiếng Việt'], ['fi', 'Suomi'], ['hu', 'Magyar'], ['ca', 'Català'], ['th', 'ไทย'],
  ['hi', 'हिन्दी'], ['bn', 'বাংলা'], ['no', 'Norsk bokmål'], ['da', 'Dansk'], ['el', 'Ελληνικά'],
  ['ro', 'Română'], ['sr', 'Српски'], ['ms', 'Bahasa Melayu'], ['simple', 'Simple English'],
];

const $ = id => document.getElementById(id);
const el = {
  form: $('page-form'), slots: $('slots'), compareCount: $('compare-count'),
  load: $('load-btn'), status: $('status'),
  results: $('results'),
  granSeg: $('gran-seg'), start: $('start-input'), end: $('end-input'), reset: $('reset-btn'),
  tlTitle: $('tl-title'), tlLegend: $('tl-legend'), tlWrap: $('tl-wrap'), tlCanvas: $('tl-canvas'), brush: $('tl-brush'), tip: $('tl-tip'),
  wordsWrap: $('words-wrap'), wordsCanvas: $('words-canvas'),
  tlTable: $('tl-table'), tlCsv: $('tl-csv'), tableView: document.querySelector('.table-view'),
  anchorSeg: $('anchor-seg'), usersCompare: $('users-compare'), showSeg: $('show-seg'), pagesNote: $('pages-note'), users: $('users'), usersSub: $('users-sub'), sortSeg: $('sort-seg'), dirBtn: $('dir-btn'),
  usersKey: $('users-key'), usersEnd: $('users-end'), usersCsv: $('users-csv'),
};

const state = {
  pages: [],           // loaded pages: { page, revisions, bots, allTimeTop, color }
  get data() { return this.pages[0]; }, // page 1, the default for anything not yet per-page
  fullStart: 0, fullEnd: 0,
  start: null, end: null, // null = full history
  gran: 'auto',
  sort: 'edits', dir: null,
  anchor: 0,           // which page the per-user chart sorts and highlights by
  show: 'all',         // per-user chart: 'all' editors, 'shared' (edited 2+ pages) or 'every' (edited all pages)
  hover: -1,
};
let tl = null;         // current timeline { granularity, start, end, bins, series: [bins per page] }
let users = [];        // current sorted user rows: { user, anon, hidden, per: [stats | null per page] }
let shownRows = [];    // users after the Show filter
let pageRanks = [];    // per page: Map user → rank by edits on that page (ties share a rank)
let pageUsers = [];    // per page: that page's users within the range
let loadCtrl = null;

const BASE_TITLE = document.title;
const pageColor = k => css(`--page-${k + 1}`);
// A page's display name; adds the wiki when the compared pages span more than one language.
const pageName = p => (new Set(state.pages.map(q => q.page.lang)).size > 1 ? `${p.page.title} (${p.page.lang})` : p.page.title);

// ------------------------------------------------------------------ search boxes

// One slot per search box: its input, its disambiguation chooser, and the title it resolved to.
const slots = [];
let slotIds = 0;       // keeps element ids unique as boxes come and go

function addSlot(value = '', lang = slots[0]?.lang.value || 'en') {
  if (slots.length >= MAX_PAGES) return null;
  const k = slots.length, id = slotIds++;
  const wrap = document.createElement('div');
  wrap.className = 'slot-wrap';
  wrap.innerHTML = `
    <div class="slot">
      <span class="swatch" style="background:var(--page-${k + 1})" aria-hidden="true"></span>
      <label class="field grow">
        <span class="slot-label"></span>
        <input type="text" placeholder="${k ? 'Another page, or the same one in another language' : 'e.g. Ada Lovelace'}" ${k ? '' : 'required'}>
      </label>
      <label class="field lang">
        <span>Language</span>
        <select>${LANGS.map(([code, name]) => `<option value="${code}">${code} · ${esc(name)}</option>`).join('')}</select>
      </label>
      <div class="slot-info"></div>
      ${k ? `<button type="button" class="ghost icon remove" aria-label="Remove page ${k + 1}" title="Remove this page">×</button>` : '<span class="remove-spacer" hidden></span>'}
    </div>
    <div class="chooser" hidden>
      <label class="chooser-msg"></label>
      <select></select>
    </div>`;
  el.slots.append(wrap);
  const slot = {
    wrap, input: wrap.querySelector('input'), lang: wrap.querySelector('.lang select'), info: wrap.querySelector('.slot-info'), chooser: wrap.querySelector('.chooser'),
    chooserMsg: wrap.querySelector('.chooser-msg'), select: wrap.querySelector('.chooser select'), resolved: null,
  };
  slot.chooserMsg.htmlFor = slot.select.id = `chooser-${id}`;
  slot.input.value = value;
  setSlotLang(slot, lang);
  slot.input.addEventListener('input', () => { slot.resolved = null; });
  slot.lang.addEventListener('change', () => { slot.resolved = null; });
  wrap.querySelector('.remove')?.addEventListener('click', () => removeSlot(slot));
  slots.push(slot);
  updateSlotUi();
  return slot;
}

// After loading, a box shows its page's full URL, size and age in place of the search field.
// "Change" brings the search field back.
function showSlotInfo(slot, { page, revisions, bots }) {
  const created = page.created ?? revisions[0].ts;
  const url = pageUrl(page);
  // Logged-in people vs. everyone else (bots, IP addresses, hidden usernames), over the whole history.
  const all = buildUsers(revisions);
  const isPerson = u => !u.hidden && !u.anon && !bots.has(u.user);
  const people = all.filter(isPerson), others = all.filter(u => !isPerson(u));
  const edits = list => list.reduce((t, u) => t + u.edits, 0);
  const avg = list => (list.length ? (edits(list) / list.length).toFixed(2) : '—');
  const other = editorBreakdown(others, bots);
  const shown = `https://${page.lang}.wikipedia.org/wiki/${page.title.replace(/ /g, '_')}`;
  const line1 = [
    `<a class="slot-url" href="${url}" target="_blank" rel="noopener">${esc(shown)}</a>`,
    `${fmtInt(edits(people))} edits by ${fmtInt(people.length)} logged-in users (avg. ${avg(people)}) / `
      + `${fmtInt(edits(others))} edits by ${fmtInt(other.bots)} bots, ${fmtInt(other.ips)} IP addresses, `
      + `${fmtInt(other.hidden)} hidden usernames (avg. ${avg(others)})`,
    page.redirectedFrom ? `redirected from “${esc(page.redirectedFrom)}”` : null,
  ].filter(Boolean).join(' · ');
  const line2 = [
    `Created ${fmtDate(created)}`,
    `Article is ${fmtAge(created, Date.now())} old`,
    `~word count ${fmtInt(Math.round(approxWords(revisions.at(-1).size) / 100) * 100)}`,
  ].join(' · ');
  slot.info.innerHTML = `<p>${line1}<button type="button" class="ghost small change">Change</button></p>
    <p class="muted slot-created">${line2}</p>`;
  slot.info.querySelector('.change').onclick = () => {
    slot.wrap.classList.remove('loaded');
    slot.input.focus();
    slot.input.select();
  };
  slot.wrap.classList.add('loaded');
}

function setSlotLang(slot, code) {
  if (![...slot.lang.options].some(o => o.value === code)) slot.lang.add(new Option(code, code));
  slot.lang.value = code;
}

function removeSlot(slot, reload = true) {
  slots.splice(slots.indexOf(slot), 1);
  slot.wrap.remove();
  // Re-number the remaining boxes so colours stay in order: blue, orange, aqua, yellow, magenta.
  slots.forEach((s, k) => {
    s.wrap.querySelector('.swatch').style.background = `var(--page-${k + 1})`;
    s.wrap.querySelector('.remove')?.setAttribute('aria-label', `Remove page ${k + 1}`);
  });
  updateSlotUi();
  if (reload && !el.results.hidden) lookupAll({ keepView: true }); // histories are cached, so this is quick
}

// The "Compare to N additional pages" list: add empty boxes, or drop boxes (empty ones first).
function setSlotCount(n) {
  const before = slots.length;
  while (slots.length < n) addSlot();
  while (slots.length > n) {
    const extra = slots.slice(1);
    removeSlot(extra.find(s => !s.input.value.trim()) ?? extra.at(-1), false);
  }
  if (slots.length > before) slots[before].input.focus();
  else if (!el.results.hidden) lookupAll({ keepView: true });
}

function updateSlotUi() {
  const multi = slots.length > 1;
  el.form.classList.toggle('multi', multi);
  slots[0]?.wrap.querySelector('.remove-spacer')?.toggleAttribute('hidden', !multi);
  slots.forEach((s, k) => {
    s.wrap.querySelector('.slot-label').textContent = multi ? `Page ${k + 1}` : 'Page title or URL';
  });
  el.compareCount.value = String(slots.length - 1);
}

el.compareCount.onchange = () => setSlotCount(+el.compareCount.value + 1);

// Phones get shorter wording so the closed dropdown isn't cut off.
const narrow = matchMedia('(max-width: 480px)');
function labelCompareCount() {
  for (const o of el.compareCount.options) {
    const n = +o.value;
    const what = `page${n > 1 ? 's' : ''} or language${n > 1 ? 's' : ''}`;
    if (n) o.textContent = narrow.matches ? `Add ${n} ${what}` : `Compare to ${n} additional ${what}`;
  }
}
narrow.addEventListener('change', labelCompareCount);
labelCompareCount();

el.form.addEventListener('submit', e => {
  e.preventDefault();
  lookupAll({});
});

// Check each title (disambiguation page? missing?) before fetching any history.
async function lookupAll(initial) {
  loadCtrl?.abort();
  const ctrl = (loadCtrl = new AbortController());
  const active = slots.filter(s => s.input.value.trim());
  if (!active.length) return;
  setStatus('Looking up…');
  el.load.disabled = true;
  try {
    await Promise.all(active.map(async s => {
      if (s.resolved) return;
      const { lang, title } = parsePageInput(s.input.value, s.lang.value);
      setSlotLang(s, lang); // a pasted URL's wiki wins over the list
      const res = await resolvePage(title, { lang, signal: ctrl.signal });
      if (res.status === 'ok') {
        s.resolved = { title: res.title, lang };
        s.chooser.hidden = true;
        return;
      }
      if (!res.options.length) throw new Error(`No page titled “${title}” on ${lang}.wikipedia.org, and no search results.`);
      showChooser(s, res, lang);
    }));
    if (ctrl.signal.aborted) return;
    const waiting = active.filter(s => !s.resolved);
    if (waiting.length) {
      document.title = `${waiting.map(s => s.input.value.trim()).join(', ')} (choose a page) · ${BASE_TITLE}`;
      el.results.hidden = true;
      setStatus(waiting.length === active.length && active.length === 1 ? '' : 'Choose from the list above to continue.');
      return;
    }
    await loadAll(ctrl, initial);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, true);
  } finally {
    if (loadCtrl === ctrl) el.load.disabled = false;
  }
}

function showChooser(slot, res, lang) {
  const sel = slot.select;
  slot.chooserMsg.textContent = res.status === 'disambiguation'
    ? `“${res.title}” could mean several things. Choose an article:`
    : `There's no page titled “${res.title}”. Pages matching your search:`;
  const opt = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text.length > 120 ? text.slice(0, 119) + '…' : text;
    return o;
  };
  const placeholder = opt('', `Choose one of ${res.options.length} pages…`);
  placeholder.disabled = placeholder.selected = true;
  sel.replaceChildren(placeholder);
  let group = null, label = null;
  for (const o of res.options) {
    if (o.group !== label || !group) {
      label = o.group;
      group = document.createElement('optgroup');
      group.label = label || (res.status === 'disambiguation' ? 'Most common' : 'Search results');
      sel.append(group);
    }
    // Descriptions usually start with the title ("Mercury (planet), the closest…"); don't repeat it.
    const desc = o.desc.startsWith(o.title) ? o.desc.slice(o.title.length).replace(/^[\s,:–—-]+/, '') : o.desc;
    group.append(opt(o.title, desc ? `${o.title} — ${desc}` : o.title));
  }
  if (res.status === 'disambiguation') {
    const g = document.createElement('optgroup');
    g.label = 'Other';
    g.append(opt(res.title, `${res.title} (the disambiguation page itself)`));
    sel.append(g);
  }
  sel.onchange = () => {
    if (!sel.value) return;
    slot.resolved = { title: sel.value, lang };
    lookupAll({ keepView: true });
  };
  slot.resolved = null;
  slot.chooser.hidden = false;
  sel.focus();
}

// Histories already fetched this session, so adding, removing or switching pages is instant.
const cache = new Map();

async function getHistory(title, lang, signal, onProgress) {
  const key = `${lang}|${title}`;
  if (cache.has(key)) return cache.get(key);
  const data = await fetchRevisions(title, { lang, signal, onProgress });
  if (!data.revisions.length) throw new Error(`“${title}” has no visible revisions.`);
  const names = [...new Set(data.revisions.map(r => r.user).filter(Boolean))];
  try {
    data.bots = await fetchBotUsers(names, { lang, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    data.bots = new Set(names.filter(n => BOT_NAME.test(n))); // fall back to the name rule
  }
  data.allTimeTop = topUsers(buildUsers(data.revisions));
  cache.set(key, data);
  return data;
}

async function loadAll(ctrl, initial) {
  const want = slots.map((s, k) => ({ s, k })).filter(({ s }) => s.resolved);
  const progress = want.map(() => 0);
  const show = () => setStatus(`Fetching revisions… ${want.map(({ s }, i) =>
    `${s.resolved.title}: ${fmtInt(progress[i])}`).join(' · ')}`);
  show();
  const datas = await Promise.all(want.map(({ s }, i) =>
    getHistory(s.resolved.title, s.resolved.lang, ctrl.signal, n => { progress[i] = n; show(); })));
  if (ctrl.signal.aborted) return;

  const keep = initial.keepView && state.pages.length;
  state.pages = datas.map((d, i) => ({ ...d, color: want[i].k }));
  state.fullStart = Math.min(...state.pages.map(p => p.page.created ?? p.revisions[0].ts));
  state.fullEnd = Date.now();
  if (!keep) {
    state.start = initial.start ?? null;
    state.end = initial.end ?? null;
    state.gran = initial.gran ?? 'auto';
    state.sort = initial.sort ?? 'edits';
    state.dir = initial.dir ?? null;
    state.anchor = initial.anchor ?? 0;
    state.show = initial.show ?? 'all';
  }
  want.forEach(({ s }, i) => {
    s.input.value = datas[i].page.title;
    showSlotInfo(s, datas[i]);
  });
  // The averages above are means; say why the median and mode aren't shown.
  const odd = state.pages.map(p => [p, editStats(buildUsers(p.revisions))]).filter(([, s]) => s.median !== 1 || s.mode !== 1);
  el.pagesNote.textContent = 'Averages are mean edits per editor. The median and mode are 1 on nearly every page, so they aren\'t shown.'
    + (odd.length ? ` Exceptions here: ${odd.map(([p, s]) => `${pageName(p)} (median ${num(s.median)}, mode ${num(s.mode)})`).join('; ')}.` : '');
  el.pagesNote.hidden = false;
  document.title = `${state.pages.map(pageName).join(' vs ')} · ${BASE_TITLE}`;
  setStatus('');
  el.results.hidden = false;
  renderAll();
}

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('error', isError);
}

// ------------------------------------------------------------------ state → view

const range = () => ({
  start: state.start ?? state.fullStart,
  end: state.end ?? state.fullEnd,
});

function effectiveGran() {
  const { start, end } = range();
  if (state.gran !== 'auto' && estimateBins(start, end, state.gran) <= MAX_BINS) return state.gran;
  return autoGranularity(start, end, Math.round(AUTO_BINS / state.pages.length));
}

function renderAll() {
  const { start, end } = range();
  const g = effectiveGran();
  const series = state.pages.map(p => buildTimeline(p.revisions, { granularity: g, start, end, bots: p.bots }).bins);
  tl = { granularity: g, start, end, bins: series[0], series };
  if (state.anchor >= state.pages.length) state.anchor = 0;
  pageUsers = state.pages.map(p => buildUsers(p.revisions, { start, end }));
  users = sortCombined(combineUsers(pageUsers), state.sort, state.dir, state.anchor);
  pageRanks = pageUsers.map(rankByEdits);
  state.hover = -1;

  renderControls();
  const multi = state.pages.length > 1;
  const span = `${fmtDate(start)} → ${fmtDate(end)}`;
  el.tlTitle.textContent = `Edits per ${tl.granularity} · ${span}`;
  el.tlLegend.innerHTML = multi ? state.pages.map(p =>
    `<span class="legend-item"><span class="swatch" style="background:var(--page-${p.color + 1})"></span>${esc(pageName(p))}</span>`).join('') : '';
  el.tlLegend.hidden = !multi;
  const ranged = state.start != null || state.end != null ? ' (selected range)' : '';
  if (multi) {
    const n = state.pages.length;
    const shared = users.filter(r => r.per.filter(Boolean).length > 1).length;
    const every = users.filter(r => r.per.every(Boolean)).length;
    el.usersSub.textContent = `${fmtInt(users.length)} different editors across ${n} pages · `
      + `${fmtInt(shared)} edited 2 or more${n > 2 ? ` · ${fmtInt(every)} edited all ${n}` : ''} · ${span}${ranged}`;
  } else {
    const inRange = pageUsers[0].reduce((s, u) => s + u.edits, 0);
    el.usersSub.textContent = `${fmtInt(inRange)} edits by ${fmtInt(users.length)} editors (${subtotals(editorBreakdown(users, state.data.bots))}) · ${span}${ranged}`;
  }
  drawCharts();
  if (el.tableView.open) renderTable();
  renderUsers();
  syncUrl();
}

const pageUrl = page => `https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`;

function renderControls() {
  const { start, end } = range();
  const eff = tl.granularity;
  el.granSeg.replaceChildren(...['auto', ...GRANULARITIES].map(g => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    const n = g === 'auto' ? 0 : estimateBins(start, end, g);
    b.textContent = g === 'auto' ? `Auto (${eff})` : g[0].toUpperCase() + g.slice(1);
    b.setAttribute('aria-checked', String(state.gran === g || (state.gran !== 'auto' && g === 'auto' && state.gran !== eff)));
    if (g !== 'auto' && n > MAX_BINS) {
      b.disabled = true;
      b.title = `~${fmtInt(n)} ${g}s — narrow the date range to use this`;
    } else if (g !== 'auto') {
      b.title = `${fmtInt(n)} periods`;
    }
    b.onclick = () => { state.gran = g; renderAll(); };
    return b;
  }));
  el.start.value = toLocalInput(start);
  el.end.value = toLocalInput(end);
  el.start.min = el.end.min = toLocalInput(state.fullStart);
  el.start.max = el.end.max = toLocalInput(state.fullEnd);
  el.reset.disabled = state.start == null && state.end == null;

  el.sortSeg.replaceChildren(...Object.entries(SORTS).map(([key, s]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = s.label;
    b.setAttribute('aria-checked', String(state.sort === key));
    b.onclick = () => setSort(key);
    return b;
  }));
  el.dirBtn.textContent = dirArrow();
  el.dirBtn.title = dirLabel();

  const multi = state.pages.length > 1;
  el.usersCompare.hidden = !multi;
  const n = state.pages.length;
  const count = f => fmtInt(users.filter(f).length);
  const shows = [
    ['all', `All editors (${fmtInt(users.length)})`],
    ['shared', `Edited 2+ pages (${count(r => r.per.filter(Boolean).length > 1)})`],
    ...(n > 2 ? [['every', `Edited all ${n} pages (${count(r => r.per.every(Boolean))})`]] : []),
  ];
  el.showSeg.replaceChildren(...(multi ? shows : []).map(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(showMode() === key));
    b.textContent = label;
    b.onclick = () => { state.show = key; renderControls(); renderUsers(); syncUrl(); };
    return b;
  }));
  el.anchorSeg.replaceChildren(...(multi ? state.pages : []).map((p, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(state.anchor === k));
    const name = pageName(p);
    b.title = `Sort and highlight by ${name}`;
    b.innerHTML = `<span class="swatch" style="background:var(--page-${p.color + 1})"></span>${esc(name.length > 22 ? name.slice(0, 21) + '…' : name)}`;
    b.onclick = () => setAnchor(k);
    return b;
  }));
}

// With two pages, "edited all pages" is the same as "edited 2+ pages".
const showMode = () => (state.show === 'every' && state.pages.length === 2 ? 'shared' : state.show);

// Rank each editor by edits on one page; ties share a rank (1, 2, 2, 4).
function rankByEdits(list) {
  const sorted = [...list].sort((x, y) => y.edits - x.edits);
  const ranks = new Map();
  sorted.forEach((u, i) => ranks.set(u.user, i && u.edits === sorted[i - 1].edits ? ranks.get(sorted[i - 1].user) : i + 1));
  return ranks;
}

function setAnchor(k) {
  state.anchor = k;
  users = sortCombined(users, state.sort, state.dir, state.anchor);
  renderControls();
  renderUsers();
  syncUrl();
}

const curDir = () => state.dir || SORTS[state.sort].defaultDir;
const dirArrow = () => (curDir() === 'asc' ? '↑' : '↓');
function dirLabel() {
  const asc = curDir() === 'asc';
  if (state.sort === 'edits') return asc ? 'Fewest first' : 'Most first';
  if (state.sort === 'duration') return asc ? 'Shortest first' : 'Longest first';
  return asc ? 'Oldest first' : 'Newest first';
}

function setSort(key) {
  if (state.sort === key) state.dir = curDir() === 'asc' ? 'desc' : 'asc';
  else { state.sort = key; state.dir = null; }
  users = sortCombined(users, state.sort, state.dir, state.anchor);
  renderControls();
  renderUsers();
  syncUrl();
}

el.dirBtn.onclick = () => setSort(state.sort);
el.reset.onclick = () => { state.start = state.end = null; state.gran = 'auto'; renderAll(); };
el.start.onchange = () => setRange(fromLocalInput(el.start.value), state.end);
el.end.onchange = () => setRange(state.start, fromLocalInput(el.end.value, true));

function setRange(start, end) {
  if (start != null && end != null && end < start) [start, end] = [end, start];
  state.start = start == null || start <= state.fullStart ? null : start;
  state.end = end == null || end >= state.fullEnd ? null : end;
  renderAll();
}

// datetime-local inputs, interpreted as UTC
const toLocalInput = ts => new Date(ts).toISOString().slice(0, 16);
function fromLocalInput(v, endOfMinute = false) {
  if (!v) return null;
  const t = Date.parse(v + 'Z');
  return Number.isNaN(t) ? null : t + (endOfMinute ? 59999 : 0);
}

// ------------------------------------------------------------------ canvas charts

const M = { l: 56, r: 14, t: 18, b: 28 };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function niceScale(max, count) {
  if (!max) return { max: 1, ticks: [0, 1] };
  const step = Math.max(1, niceStep(max / count));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { max: top, ticks };
}
const compact = v => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${+(v / 1e3).toFixed(1)}K` : fmtInt(v));

function xScale(width) {
  const t0 = tl.bins[0].start, t1 = tl.bins.at(-1).end;
  const w = width - M.l - M.r;
  return { t0, t1, w, x: t => M.l + ((t - t0) / (t1 - t0)) * w, t: x => t0 + ((x - M.l) / w) * (t1 - t0) };
}

const TICK_UNITS = [
  ['hour', 1], ['hour', 3], ['hour', 6], ['hour', 12], ['day', 1], ['day', 2], ['week', 1],
  ['month', 1], ['month', 3], ['month', 6], ['year', 1], ['year', 2], ['year', 5], ['year', 10], ['year', 25],
];
const APPROX = { hour: 36e5, day: 864e5, week: 6048e5, month: 2.63e9, year: 3.156e10 };
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

function timeTicks(sx) {
  const minPx = 84;
  const [g, n] = TICK_UNITS.find(([g, n]) => (APPROX[g] * n / (sx.t1 - sx.t0)) * sx.w >= minPx) || ['year', 50];
  let t = floorTo(sx.t0, g);
  const field = { hour: 'getUTCHours', month: 'getUTCMonth', year: 'getUTCFullYear' }[g];
  if (n > 1 && field) while (new Date(t)[field]() % n) t = addUnits(t, g);
  const ticks = [];
  for (; t <= sx.t1; t = addUnits(t, g, n)) if (t >= sx.t0) ticks.push(t);
  const label = ts => {
    const d = new Date(ts);
    if (g === 'year') return String(d.getUTCFullYear());
    if (g === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (g === 'hour' && (d.getUTCHours() || n === 1)) return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  };
  return ticks.map(t => ({ t, label: label(t) }));
}

function drawCharts() {
  drawTimeline();
  drawWords();
}

// Where period i's columns sit: the first column's left edge, column width and the gap between pages.
function columnGeom(sx, i, n) {
  const b = tl.bins[i];
  const x0 = sx.x(b.start), slot = sx.x(b.end) - x0;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const avail = slot - gap;
  const inner = n > 1 ? (avail / n >= 8 ? 2 : avail / n >= 4 ? 1 : 0) : 0;
  const bw = Math.max(1, Math.min(24, (avail - inner * (n - 1)) / n));
  const groupW = bw * n + inner * (n - 1);
  return { x: x0 + (slot - groupW) / 2, bw, inner };
}

function drawTimeline() {
  const { ctx, width, height } = setupCanvas(el.tlCanvas);
  const sx = xScale(width);
  const h = height - M.t - M.b;
  const n = tl.series.length;
  const maxEdits = Math.max(...tl.series.flatMap(bins => bins.map(b => b.edits)));
  const ys = niceScale(maxEdits, 4);
  const y = v => M.t + h - (v / ys.max) * h;
  ctx.font = `11px ${css('--font')}`;
  ctx.textBaseline = 'middle';

  // grid + y labels
  ctx.fillStyle = css('--text-muted');
  ctx.textAlign = 'right';
  for (const v of ys.ticks) {
    ctx.fillStyle = css('--grid');
    ctx.fillRect(M.l, Math.round(y(v)), sx.w, 1);
    ctx.fillStyle = css('--text-muted');
    ctx.fillText(compact(v), M.l - 8, y(v));
  }

  // hover band
  if (state.hover >= 0) {
    const b = tl.bins[state.hover];
    ctx.fillStyle = css('--hover-band');
    ctx.fillRect(sx.x(b.start), M.t, Math.max(1, sx.x(b.end) - sx.x(b.start)), h);
  }

  // columns: one per page, side by side within each period
  let maxIdx = -1;
  if (n === 1) maxIdx = tl.bins.findIndex(b => b.edits === maxEdits);
  tl.bins.forEach((b, i) => {
    const { x, bw, inner } = columnGeom(sx, i, n);
    let bx = x;
    tl.series.forEach((bins, k) => {
      const v = bins[i].edits;
      if (v) {
        const top = y(v), bh = Math.max(1, M.t + h - top);
        ctx.fillStyle = pageColor(state.pages[k].color);
        ctx.beginPath();
        if (bw >= 8 && ctx.roundRect) ctx.roundRect(bx, M.t + h - bh, bw, bh, [Math.min(4, bh), Math.min(4, bh), 0, 0]);
        else ctx.rect(bx, M.t + h - bh, bw, bh);
        ctx.fill();
      }
      bx += bw + inner;
    });
  });

  // baseline
  ctx.fillStyle = css('--axis');
  ctx.fillRect(M.l, M.t + h, sx.w, 1);

  // direct label on the peak only
  if (n === 1 && maxIdx >= 0 && maxEdits > 0) {
    const b = tl.bins[maxIdx];
    const cx = (sx.x(b.start) + sx.x(b.end)) / 2;
    const text = `${fmtInt(maxEdits)} · ${fmtPeriod(b.start, tl.granularity)}`;
    ctx.fillStyle = css('--text-primary');
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(text).width;
    ctx.textAlign = 'center';
    ctx.fillText(text, Math.min(Math.max(cx, M.l + tw / 2), width - M.r - tw / 2), y(maxEdits) - 3);
  }

  // x ticks
  ctx.fillStyle = css('--text-muted');
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const { t, label } of timeTicks(sx)) {
    const x = sx.x(t);
    ctx.fillStyle = css('--axis');
    ctx.fillRect(Math.round(x), M.t + h, 1, 4);
    ctx.fillStyle = css('--text-muted');
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(Math.max(x, M.l + tw / 2), width - M.r - tw / 2), M.t + h + 8);
  }
}

function drawWords() {
  const { ctx, width, height } = setupCanvas(el.wordsCanvas);
  const sx = xScale(width);
  const top = 10, bottom = 4;
  const h = height - top - bottom;
  const n = tl.series.length;
  const vals = tl.series.flatMap(bins => bins.map(b => b.words)).filter(v => v != null);
  const ys = niceScale(vals.reduce((m, v) => Math.max(m, v), 0), 2);
  const y = v => top + h - (v / ys.max) * h;
  ctx.font = `11px ${css('--font')}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const v of [0, ys.max]) {
    ctx.fillStyle = css('--grid');
    ctx.fillRect(M.l, Math.round(y(v)), sx.w, 1);
    ctx.fillStyle = css('--text-muted');
    ctx.fillText(compact(v), M.l - 8, y(v));
  }

  // Step lines: each value holds across its period and is the size at the period's end.
  // One page keeps the grey line and wash; several pages each get their colour, no wash.
  const lineColor = k => (n === 1 ? css('--size-line') : pageColor(state.pages[k].color));
  tl.series.forEach((bins, k) => {
    const segs = [];
    let cur = null;
    for (const b of bins) {
      if (b.words == null) { cur = null; continue; }
      if (!cur) segs.push((cur = []));
      cur.push([sx.x(b.start), y(b.words)], [sx.x(b.end), y(b.words)]);
    }
    for (const pts of segs) {
      if (n === 1) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], y(0));
        for (const [px, py] of pts) ctx.lineTo(px, py);
        ctx.lineTo(pts.at(-1)[0], y(0));
        ctx.closePath();
        ctx.fillStyle = css('--size-wash');
        ctx.fill();
      }
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.strokeStyle = lineColor(k);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  });

  if (state.hover >= 0) {
    const b = tl.bins[state.hover];
    const cx = (sx.x(b.start) + sx.x(b.end)) / 2;
    ctx.fillStyle = css('--hover-band');
    ctx.fillRect(sx.x(b.start), top, Math.max(1, sx.x(b.end) - sx.x(b.start)), h);
    tl.series.forEach((bins, k) => {
      const v = bins[state.hover].words;
      if (v == null) return;
      ctx.beginPath();
      ctx.arc(cx, y(v), 4, 0, Math.PI * 2);
      ctx.fillStyle = lineColor(k);
      ctx.strokeStyle = css('--surface-1');
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    });
  }
}

// ------------------------------------------------------------------ chart interaction

function binAt(clientX, canvas) {
  const rect = canvas.getBoundingClientRect();
  const sx = xScale(rect.width);
  const t = sx.t(clientX - rect.left);
  if (t < sx.t0 || t >= sx.t1) return -1;
  let lo = 0, hi = tl.bins.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tl.bins[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Which page's column in period i is nearest the pointer: columns with edits first.
// The word-count strip has no columns, so there it only answers when there's one page.
function pageAt(i, clientX, canvas) {
  const n = tl.series.length;
  if (i < 0) return -1;
  if (n === 1) return 0;
  if (canvas !== el.tlCanvas) return -1;
  const rect = canvas.getBoundingClientRect();
  const { x, bw, inner } = columnGeom(xScale(rect.width), i, n);
  const px = clientX - rect.left;
  const dist = k => Math.abs(x + k * (bw + inner) + bw / 2 - px);
  const ks = [...Array(n).keys()];
  const withEdits = ks.filter(k => tl.series[k][i].edits);
  return (withEdits.length ? withEdits : ks).reduce((best, k) => (dist(k) < dist(best) ? k : best));
}

// Wikipedia's own history page, starting at the beginning of period i (oldest edits of the period).
const fmtStamp = ts => new Date(ts).toISOString().replace(/\D/g, '').slice(0, 14);
function historyUrl(k, i) {
  const { page } = state.pages[k];
  const edits = tl.series[k][i].edits;
  const q = new URLSearchParams({ title: page.title, action: 'history', dir: 'prev', offset: fmtStamp(tl.bins[i].start), limit: String(Math.max(50, Math.min(500, edits))) });
  return `https://${page.lang}.wikipedia.org/w/index.php?${q}`;
}

function setHover(i, clientX, clientY, canvas = el.tlCanvas) {
  if (i !== state.hover) {
    state.hover = i;
    drawCharts();
  }
  if (i < 0) { el.tip.hidden = true; return; }
  const b = tl.bins[i];
  const target = pageAt(i, clientX, canvas);
  const ROWS = [
    ['Edits', x => fmtInt(x.edits)],
    ['Editors', x => fmtInt(x.editors)],
    ['bots', x => fmtInt(x.bots), true],
    ['IP addresses', x => fmtInt(x.ips), true],
    ['hidden usernames', x => fmtInt(x.hidden), true],
    ['Avg edits per editor', perEditor],
    ['~Word count at end', x => fmtInt(x.words)],
  ];
  let body;
  if (tl.series.length === 1) {
    body = ROWS.map(([label, f, sub]) =>
      `<div class="t-row${sub ? ' t-sub' : ''}"><span>${label}</span><span>${f(b)}</span></div>`).join('');
  } else {
    const short = t => esc(t.length > 18 ? t.slice(0, 17) + '…' : t);
    body = `<table class="t-table"><thead><tr><th></th>${state.pages.map(p =>
      `<th><span class="swatch" style="background:var(--page-${p.color + 1})"></span>${short(pageName(p))}</th>`).join('')}</tr></thead><tbody>${
      ROWS.map(([label, f, sub]) => `<tr${sub ? ' class="t-sub"' : ''}><td>${label}</td>${tl.series.map(bins => `<td>${f(bins[i])}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
  }
  el.tip.innerHTML = `
    <div class="t-head">${fmtPeriod(b.start, tl.granularity)}</div>
    ${body}
    ${target < 0 ? '' : `<div class="t-hint">Click to open ${tl.series.length > 1 ? `${esc(pageName(state.pages[target]))}'s` : 'the'} Wikipedia history from ${fmtPeriod(b.start, tl.granularity)}</div>`}`;
  el.tip.hidden = false;
  const card = el.tip.offsetParent.getBoundingClientRect();
  const tw = el.tip.offsetWidth, th = el.tip.offsetHeight;
  let left = clientX - card.left + 14;
  if (left + tw > card.width - 8) left = clientX - card.left - tw - 14;
  el.tip.style.left = `${Math.max(8, left)}px`;
  el.tip.style.top = `${Math.max(8, clientY - card.top - th - 12)}px`;
}

// The tooltip lives on the card so it can follow the pointer over both charts.
el.tlWrap.closest('.card').style.position = 'relative';
el.tlWrap.closest('.card').appendChild(el.tip);

let drag = null;
for (const canvas of [el.tlCanvas, el.wordsCanvas]) {
  canvas.addEventListener('pointerdown', e => {
    if (!tl || e.button !== 0) return;
    drag = { canvas, x0: e.clientX, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!tl) return;
    if (drag && drag.canvas === canvas) {
      if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
      if (drag.moved) {
        const rect = el.tlCanvas.getBoundingClientRect();
        const a = Math.max(M.l, Math.min(drag.x0, e.clientX) - rect.left);
        const b = Math.min(rect.width - M.r, Math.max(drag.x0, e.clientX) - rect.left);
        Object.assign(el.brush.style, { left: `${a}px`, width: `${Math.max(0, b - a)}px` });
        el.brush.hidden = false;
        el.tip.hidden = true;
        return;
      }
    }
    setHover(binAt(e.clientX, canvas), e.clientX, e.clientY, canvas);
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) setHover(-1); });
  canvas.addEventListener('pointerup', e => {
    if (!drag || drag.canvas !== canvas) return;
    const d = drag;
    drag = null;
    el.brush.hidden = true;
    if (d.moved) {
      let a = binAt(Math.min(d.x0, e.clientX), canvas);
      let b = binAt(Math.max(d.x0, e.clientX), canvas);
      if (a < 0) a = 0;
      if (b < 0) b = tl.bins.length - 1;
      zoomTo(tl.bins[a].start, tl.bins[b].end - 1);
    } else {
      const i = binAt(e.clientX, canvas);
      const k = pageAt(i, e.clientX, canvas);
      if (k >= 0) window.open(historyUrl(k, i), '_blank', 'noopener');
    }
  });
  canvas.addEventListener('pointercancel', () => { drag = null; el.brush.hidden = true; });
}

function zoomTo(start, end) {
  state.gran = 'auto';
  setRange(Math.max(start, state.fullStart), Math.min(end, state.fullEnd));
}

new ResizeObserver(() => tl && drawCharts()).observe(el.tlWrap);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => tl && drawCharts());

// ------------------------------------------------------------------ table view

el.tableView.addEventListener('toggle', () => el.tableView.open && renderTable());

const subtotals = s => `${fmtInt(s.bots)} bots, ${fmtInt(s.ips)} IP addresses, ${fmtInt(s.hidden)} hidden usernames`;
const perEditor = b => (b.editors ? (b.edits / b.editors).toFixed(1) : '—');

function renderTable() {
  const multi = tl.series.length > 1;
  const cols = b => `<td>${fmtInt(b.edits)}</td><td>${fmtInt(b.editors)}</td><td>${perEditor(b)}</td><td>${fmtInt(b.words)}</td>`;
  const rows = tl.bins.map((b, i) =>
    `<tr><td>${fmtPeriod(b.start, tl.granularity)}</td>${tl.series.map(bins => cols(bins[i])).join('')}</tr>`);
  const sub = '<th>Edits</th><th>Editors</th><th>Edits per editor</th><th>~Word count at end</th>';
  const head = multi
    ? `<tr><th></th>${state.pages.map(p => `<th colspan="4" class="t-page"><span class="swatch" style="background:var(--page-${p.color + 1})"></span>${esc(pageName(p))}</th>`).join('')}</tr>
       <tr><th>Period (UTC)</th>${state.pages.map(() => sub).join('')}</tr>`
    : `<tr><th>Period (UTC)</th>${sub}</tr>`;
  el.tlTable.innerHTML = `<thead>${head}</thead><tbody>${rows.join('')}</tbody>`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = () => state.pages.map(p => pageName(p).replace(/[^\w-]+/g, '_')).join('-vs-');
const titles = () => state.pages.map(pageName);
el.tlCsv.onclick = () => download(`${slug()}-edits-per-${tl.granularity}.csv`, timelineCsv(tl, titles()));
el.usersCsv.onclick = () => download(`${slug()}-edits-per-user.csv`, usersCsv(shownRows, titles()));

// ------------------------------------------------------------------ users chart

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Rows are added in batches as the list scrolls into view.
const isRecent = u => !!u && !u.hidden && Date.now() - u.last <= RECENT_MS;
const ulist = { shown: 0, max: 1, records: new Set(), timeSort: false, bots: new Set(), creators: [] };
const num = v => (Number.isInteger(v) ? fmtInt(v) : v.toFixed(1));
const swatch = k => `<span class="swatch" style="background:var(--page-${state.pages[k].color + 1})"></span>`;

function renderUsers() {
  const multi = state.pages.length > 1;
  const a = state.anchor;
  const anchor = state.pages[a];
  ulist.shown = 0;
  const mode = multi ? showMode() : 'all';
  shownRows = mode === 'every' ? users.filter(r => r.per.every(Boolean))
    : mode === 'shared' ? users.filter(r => r.per.filter(Boolean).length > 1) : users;
  ulist.max = pageUsers.flat().reduce((m, u) => Math.max(m, u.edits), 1); // one scale for every page
  ulist.timeSort = state.sort === 'first' || state.sort === 'last'; // bold/underline apply to date sorts only
  ulist.records = ulist.timeSort ? recordHolders(pageUsers[a], state.sort) : new Set();
  ulist.bots = new Set(state.pages.flatMap(p => [...p.bots]));
  ulist.creators = state.pages.map(p => p.revisions[0].user);

  const onAnchor = users.filter(r => r.per[a]).map(r => r.per[a]);
  const key = [];
  if (multi) key.push(`Sorting and highlights use ${swatch(a)}<b>${esc(pageName(anchor))}</b>`);
  if (ulist.timeSort) {
    const when = state.sort === 'first' ? 'first edit' : 'last edit';
    key.push(`<span class="u-record">Bold</span>: most edits of anyone up to that ${when}`);
    if (onAnchor.some(u => anchor.allTimeTop.has(u.user))) key.push('<span class="u-top">Underlined</span>: most edits of all time');
  }
  const creator = ulist.creators[a];
  if (creator && onAnchor.some(u => u.user === creator)) key.push('<span class="u-creator">Green</span>: created the page');
  if (onAnchor.some(isRecent)) key.push('<span class="u-recent">Blue</span>: edited in the last 7 days');
  if (users.some(r => ulist.bots.has(r.user))) key.push('<span class="u-bot">Orange</span>: bot account');
  el.usersKey.innerHTML = key.join(' · ');
  el.usersKey.hidden = !key.length;

  const arrow = dirArrow();
  const head = k => `${state.sort === k ? 'sorted' : ''}" data-arrow="${arrow}" data-sort="${k}`;
  const cols = `
      <span class="u-date u-first ${head('first')}" role="columnheader" style="cursor:pointer">First edit</span>
      <span class="u-date u-last ${head('last')}" role="columnheader" style="cursor:pointer">Last edit</span>
      <span class="u-dur ${head('duration')}" role="columnheader" style="cursor:pointer">Duration</span>
      <span class="u-barcell ${head('edits')}" role="columnheader" style="cursor:pointer">Edits</span>`;
  el.users.innerHTML = multi
    ? `<div class="u-row u-multi u-header" role="row">
        <span class="u-rank" role="columnheader">#</span>
        <span class="u-name" role="columnheader">User</span>
        <div class="u-subs"><div class="u-sub"><span class="u-page" role="columnheader">Page</span>${cols}</div></div>
      </div>`
    : `<div class="u-row u-header" role="row">
        <span class="u-rank" role="columnheader">#</span>
        <span class="u-name" role="columnheader">User</span>${cols}
      </div>`;
  el.users.querySelectorAll('[data-sort]').forEach(h => (h.onclick = () => setSort(h.dataset.sort)));
  appendUsers();
}

// The name cell. Colour and bold/underline follow the anchor page.
function nameCell(r) {
  if (r.hidden) return `<span class="muted">${HIDDEN_USER}</span>`;
  const a = state.anchor;
  const anchor = state.pages[a];
  const multi = state.pages.length > 1;
  const isBot = ulist.bots.has(r.user);
  const isCreator = r.user === ulist.creators[a];
  const cls = ['u-link'];
  // One colour per name: green (creator) beats blue (recent) beats orange (bot).
  if (isCreator) cls.push('u-creator');
  else if (isRecent(r.per[a])) cls.push('u-recent');
  else if (isBot) cls.push('u-bot');
  if (ulist.records.has(r.user)) cls.push('u-record');
  if (ulist.timeSort && r.per[a] && anchor.allTimeTop.has(r.user)) cls.push('u-top');
  const tags = (!multi && isCreator ? '<span class="u-tag">creator</span>' : '')
    + (r.anon ? '<span class="u-tag">IP</span>' : '') + (isBot ? '<span class="u-tag">bot</span>' : '');
  return `<a class="${cls.join(' ')}" href="https://${anchor.page.lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(r.user)}" target="_blank" rel="noopener" title="${esc(r.user)}">${esc(r.user)}</a>${tags}`;
}

// First / last / duration / bar for one user on one page.
function statCells(u, k) {
  const multi = state.pages.length > 1;
  const bar = multi ? ` style="background:var(--page-${state.pages[k].color + 1});width:` : ' style="width:';
  return `
    ${multi ? `<span class="u-page" role="cell" title="${esc(pageName(state.pages[k]))}"><span class="u-page-name">${esc(pageName(state.pages[k]))}</span>${swatch(k)}</span>` : ''}
    <span class="u-date u-first" role="cell" title="First edit">${fmtDate(u.first)}</span>
    <span class="u-date u-last" role="cell" title="Last edit">${fmtDate(u.last)}</span>
    <span class="u-dur" role="cell" title="Time from first to last edit, rounded up to whole days">${fmtDuration(editDuration(u.first, u.last))}</span>
    <span class="u-barcell" role="cell"><span class="u-bar"${bar}calc((100% - 3.5em) * ${u.edits / ulist.max})"></span><span class="u-count">${fmtInt(u.edits)}</span>${
      multi && !u.hidden && u.user === ulist.creators[k] ? '<span class="u-tag">creator</span>' : ''}</span>`;
}

function userRow(r, i) {
  if (state.pages.length === 1) {
    return `<div class="u-row" role="row">
      <span class="u-rank" role="cell">${i + 1}</span>
      <span class="u-name" role="cell">${nameCell(r)}</span>${statCells(r.per[0], 0)}
    </div>`;
  }
  // The sort page's line first, then any other pages this user edited, in page order.
  const order = [state.anchor, ...r.per.map((_, k) => k).filter(k => k !== state.anchor)];
  const subs = order.filter(k => r.per[k]).map(k =>
    `<div class="u-sub${k === state.anchor ? ' u-anchor' : ''}">${statCells(r.per[k], k)}</div>`).join('');
  // Editors of more than one page: their rank by edits on each page they edited, in line order.
  const edited = order.filter(k => r.per[k]);
  const ranks = edited.length > 1 && !r.hidden ? `<span class="u-ranks">${edited.map(k =>
    `#${fmtInt(pageRanks[k].get(r.user))} of ${fmtInt(pageUsers[k].length)} on ${esc(pageName(state.pages[k]))}`).join('<br>')}</span>` : '';
  return `<div class="u-row u-multi" role="row">
    <span class="u-rank" role="cell">${i + 1}</span>
    <span class="u-name" role="cell">${nameCell(r)}${ranks}</span>
    <div class="u-subs">${subs}</div>
  </div>`;
}

function appendUsers() {
  const batch = shownRows.slice(ulist.shown, ulist.shown + USER_BATCH);
  el.users.insertAdjacentHTML('beforeend', batch.map((u, j) => userRow(u, ulist.shown + j)).join(''));
  ulist.shown += batch.length;
  const n = shownRows.length;
  el.usersEnd.textContent = !n ? `No editor edited ${showMode() === 'every' ? 'every page' : 'more than one page'} in this range`
    : ulist.shown < n ? `Showing ${fmtInt(ulist.shown)} of ${fmtInt(n)} — scroll for more`
    : `All ${fmtInt(n)} editors shown`;
  // The observer only fires on changes, so keep filling while the end marker is still in view.
  requestAnimationFrame(() => {
    if (ulist.shown < shownRows.length && el.usersEnd.getBoundingClientRect().top < innerHeight + 800) appendUsers();
  });
}

new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && state.data && ulist.shown < shownRows.length) appendUsers();
}, { rootMargin: '800px 0px' }).observe(el.usersEnd);

// ------------------------------------------------------------------ URL state

function syncUrl() {
  const p = new URLSearchParams();
  const lang0 = state.pages[0].page.lang;
  state.pages.forEach(({ page }, i) => {
    p.set(i ? `page${i + 1}` : 'page', page.title);
    if (i && page.lang !== lang0) p.set(`lang${i + 1}`, page.lang);
  });
  if (lang0 !== 'en') p.set('lang', lang0);
  if (state.start != null) p.set('from', toLocalInput(state.start));
  if (state.end != null) p.set('to', toLocalInput(state.end));
  if (state.gran !== 'auto') p.set('g', state.gran);
  if (state.sort !== 'edits') p.set('sort', state.sort);
  if (state.dir) p.set('dir', state.dir);
  if (state.anchor) p.set('by', String(state.anchor + 1));
  if (state.pages.length > 1 && showMode() !== 'all') p.set('show', showMode());
  history.replaceState(null, '', `?${p}`);
}

function initFromUrl() {
  const p = new URLSearchParams(location.search);
  const lang = p.get('lang') || 'en';
  const first = addSlot(p.get('page') || '', lang);
  for (let i = 2; i <= MAX_PAGES; i++) {
    const t = p.get(`page${i}`);
    if (t) addSlot(t, p.get(`lang${i}`) || lang);
  }
  if (!p.get('page')) { first.input.focus(); return; }
  lookupAll({
    start: fromLocalInput(p.get('from')) ?? undefined,
    end: p.get('to') ? fromLocalInput(p.get('to'), true) : undefined,
    gran: GRANULARITIES.includes(p.get('g')) ? p.get('g') : undefined,
    sort: SORTS[p.get('sort')] ? p.get('sort') : undefined,
    dir: ['asc', 'desc'].includes(p.get('dir')) ? p.get('dir') : undefined,
    anchor: +p.get('by') >= 2 && +p.get('by') <= slots.length ? +p.get('by') - 1 : undefined,
    show: ['shared', 'every'].includes(p.get('show')) ? p.get('show') : p.get('common') === '1' ? 'every' : undefined,
  });
}
initFromUrl();
