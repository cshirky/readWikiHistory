// Data layer for the page: fetching, binning and per-user stats.
// Plain ES module with no dependencies; also importable from Node >= 18 for testing.
// All time handling is UTC.

export const GRANULARITIES = ['hour', 'day', 'week', 'month', 'year'];

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const APPROX_MS = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30.44 * DAY, year: 365.25 * DAY };

// ---------------------------------------------------------------- input

/** Accepts "Albert Einstein", "Albert_Einstein", or a full Wikipedia URL. */
export function parsePageInput(input, defaultLang = 'en') {
  const raw = String(input || '').trim();
  let lang = defaultLang;
  let title = raw;
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const m = u.hostname.match(/^([a-z0-9-]+)\.(?:m\.)?wikipedia\.org$/i);
    if (m) lang = m[1].toLowerCase();
    title = u.searchParams.get('title') || decodeURIComponent(u.pathname.replace(/^\/wiki\//, ''));
  }
  title = title.replace(/_/g, ' ').replace(/#.*$/, '').trim();
  return { lang, title };
}

// ---------------------------------------------------------------- fetching

function apiUrl(lang, params) {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', origin: '*', ...params })) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  return u;
}

async function getJson(url, { headers, signal }) {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Wikipedia API: ${data.error.info || data.error.code}`);
  return data;
}

function toRev(r) {
  return {
    id: r.revid,
    ts: Date.parse(r.timestamp),
    user: r.userhidden ? null : r.user ?? null,
    anon: !!r.anon,
    size: typeof r.size === 'number' ? r.size : null,
    minor: !!r.minor,
  };
}

const RVPROP = 'ids|timestamp|user|size|flags';

/**
 * Fetch every revision of one page, oldest first.
 * Returns { page: {title, pageid, lang, created, redirectedFrom}, revisions: [...] }.
 */
export async function fetchRevisions(title, { lang = 'en', onProgress, signal, userAgent } = {}) {
  const opts = { headers: userAgent ? { 'User-Agent': userAgent } : undefined, signal };
  const base = {
    action: 'query', prop: 'revisions', titles: title, redirects: '1',
    rvprop: RVPROP, rvlimit: 'max', rvdir: 'newer',
  };
  const revisions = [];
  let page = null;
  let cont = {};
  do {
    const data = await getJson(apiUrl(lang, { ...base, ...cont }), opts);
    const p = data.query?.pages?.[0];
    if (!p || p.missing) throw new Error(`No page titled "${title}" on ${lang}.wikipedia.org`);
    if (p.invalid) throw new Error(`Invalid title "${title}": ${p.invalidreason || ''}`);
    if (!page) {
      page = {
        title: p.title, pageid: p.pageid, lang,
        redirectedFrom: data.query.redirects?.[0]?.from ?? null,
      };
    }
    for (const r of p.revisions || []) revisions.push(toRev(r));
    cont = data.continue || null;
    onProgress?.(revisions.length, revisions.at(-1)?.ts);
  } while (cont);
  page.created = revisions[0]?.ts ?? null;
  return { page, revisions };
}

// ---------------------------------------------------------------- disambiguation

const NON_ARTICLE = /^(Help|Wikipedia|WP|Template|Category|File|Image|Portal|Special|Talk|User|Draft|Module|MediaWiki|Wiktionary|wikt|Media)( talk)?:/i;
const SKIP_CONTAINERS = '.navbox, .toc, #toc, .hatnote, .metadata, .noprint, .sistersitebox, .reflist, .mw-references-wrap, .dmbox, .ambox';

/**
 * Check a title before fetching its history.
 *   { status: 'ok', title }                              — an ordinary article
 *   { status: 'disambiguation', title, options: [...] }  — the title is a disambiguation page
 *   { status: 'missing', title, options: [...] }         — no such page; options are search results
 * Each option: { title, desc, group }. Reading the disambiguation page needs DOMParser (browser).
 */
export async function resolvePage(title, { lang = 'en', signal, userAgent } = {}) {
  const opts = { headers: userAgent ? { 'User-Agent': userAgent } : undefined, signal };
  const data = await getJson(apiUrl(lang, {
    action: 'query', titles: title, redirects: '1', prop: 'pageprops', ppprop: 'disambiguation',
  }), opts);
  const p = data.query?.pages?.[0];
  if (p?.invalid) throw new Error(`Invalid title "${title}": ${p.invalidreason || ''}`);

  if (!p || p.missing) {
    const s = await getJson(apiUrl(lang, {
      action: 'query', list: 'search', srsearch: title, srlimit: 25, srprop: 'snippet', srnamespace: 0,
    }), opts);
    const options = (s.query?.search || []).map(r => ({ title: r.title, desc: htmlToText(r.snippet), group: '' }));
    return { status: 'missing', title, options };
  }
  if (!('disambiguation' in (p.pageprops || {}))) return { status: 'ok', title: p.title };

  const parsed = await getJson(apiUrl(lang, {
    action: 'parse', pageid: p.pageid, prop: 'text', disableeditsection: 1, disabletoc: 1,
  }), opts);
  return { status: 'disambiguation', title: p.title, options: disambiguationOptions(parsed.parse.text, p.title) };
}

function htmlToText(html) {
  if (globalThis.DOMParser) {
    const decode = h => new DOMParser().parseFromString(h, 'text/html').body.textContent;
    let text = decode(html);
    if (/&(#\d+|[a-z]+);/i.test(text)) text = decode(text); // some snippets are double-encoded
    return text.replace(/\s+/g, ' ').trim();
  }
  return html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").trim();
}

/** The article choices on a disambiguation page: the first article link in each list item. */
function disambiguationOptions(html, selfTitle) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const options = [];
  const seen = new Set([selfTitle]);
  let h2 = '', h3 = '';
  for (const node of doc.body.querySelectorAll('h2, h3, li')) {
    if (node.closest(SKIP_CONTAINERS)) continue;
    if (node.tagName === 'H2') { h2 = node.textContent.trim(); h3 = ''; continue; }
    if (node.tagName === 'H3') { h3 = node.textContent.trim(); continue; }
    const a = [...node.querySelectorAll('a[href^="/wiki/"]')].find(x => x.closest('li') === node);
    if (!a || a.classList.contains('new') || a.classList.contains('extiw')) continue;
    const t = (a.getAttribute('title') || '').trim();
    if (!t || NON_ARTICLE.test(t) || seen.has(t)) continue;
    seen.add(t);
    // The item's own text, without any nested sub-list.
    const clone = node.cloneNode(true);
    clone.querySelectorAll('ul, ol').forEach(x => x.remove());
    const desc = clone.textContent.replace(/\s+/g, ' ').trim();
    options.push({ title: t, desc, group: h2 === 'See also' ? 'See also' : [h2, h3].filter(Boolean).join(' › ') });
  }
  return options;
}

// ---------------------------------------------------------------- time bins

export function floorTo(ts, g) {
  const d = new Date(ts);
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
  switch (g) {
    case 'hour': return Date.UTC(y, m, day, d.getUTCHours());
    case 'day': return Date.UTC(y, m, day);
    case 'week': return Date.UTC(y, m, day - ((d.getUTCDay() + 6) % 7)); // Monday
    case 'month': return Date.UTC(y, m, 1);
    case 'year': return Date.UTC(y, 0, 1);
  }
  throw new Error(`Unknown granularity ${g}`);
}

export function addUnits(ts, g, n = 1) {
  const d = new Date(ts);
  switch (g) {
    case 'hour': return ts + n * HOUR;
    case 'day': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n, d.getUTCHours());
    case 'week': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 * n, d.getUTCHours());
    case 'month': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
    case 'year': return Date.UTC(d.getUTCFullYear() + n, 0, 1);
  }
  throw new Error(`Unknown granularity ${g}`);
}

export function estimateBins(start, end, g) {
  return Math.ceil((end - floorTo(start, g)) / APPROX_MS[g]) + 1;
}

/** Finest granularity that keeps the bin count at or under maxBins. */
export function autoGranularity(start, end, maxBins = 300) {
  for (const g of GRANULARITIES) if (estimateBins(start, end, g) <= maxBins) return g;
  return 'year';
}

/**
 * Bin revisions into periods.
 * Each bin: { start, end, edits, editors, bots, ips, hidden, words }. editors counts distinct
 * users; bots / ips / hidden are subtotals of it (pass the bot names as `bots`). Revisions with
 * hidden usernames can't be told apart, so they count as one editor. words is the approximate word
 * count (bytes / 6) of the page after the last
 * revision at or before the end of the period (carried forward through quiet periods).
 * `revisions` must be sorted oldest first.
 */
export function buildTimeline(revisions, { granularity, start, end, bots = new Set() } = {}) {
  const t0 = start ?? revisions[0]?.ts ?? Date.now();
  const t1 = end ?? Date.now();
  const g = granularity || autoGranularity(t0, t1);
  const bins = [];
  let i = 0;
  let size = null;
  while (i < revisions.length && revisions[i].ts < t0) {
    if (revisions[i].size != null) size = revisions[i].size;
    i++;
  }
  for (let t = floorTo(t0, g); t <= t1; t = addUnits(t, g)) {
    const next = addUnits(t, g);
    let edits = 0;
    const who = new Map(); // name -> revision, for the subtotals
    while (i < revisions.length && revisions[i].ts < next && revisions[i].ts <= t1) {
      edits++;
      who.set(revisions[i].user ?? HIDDEN_USER, revisions[i]);
      if (revisions[i].size != null) size = revisions[i].size;
      i++;
    }
    bins.push({ start: t, end: next, edits, ...editorBreakdown([...who.values()], bots), words: approxWords(size) });
  }
  return { granularity: g, start: t0, end: t1, bins };
}

/** Subtotals for a list of distinct editors (each item needs .user/.anon, or .hidden). */
export function editorBreakdown(editors, bots = new Set()) {
  let nBots = 0, ips = 0, hidden = 0;
  for (const e of editors) {
    if (e.user == null || e.hidden) hidden++;
    else if (e.anon) ips++;
    else if (bots.has(e.user)) nBots++;
  }
  return { editors: editors.length, bots: nBots, ips, hidden };
}

// ---------------------------------------------------------------- users

export const HIDDEN_USER = '(username hidden)';

/** Per-user totals within [start, end]. */
export function buildUsers(revisions, { start = -Infinity, end = Infinity } = {}) {
  const map = new Map();
  for (const r of revisions) {
    if (r.ts < start || r.ts > end) continue;
    const key = r.user ?? HIDDEN_USER;
    let u = map.get(key);
    if (!u) map.set(key, (u = { user: key, anon: r.anon, hidden: r.user == null, edits: 0, first: r.ts, last: r.ts }));
    u.edits++;
    if (r.ts < u.first) u.first = r.ts;
    if (r.ts > u.last) u.last = r.ts;
  }
  return [...map.values()];
}

/**
 * Which of `names` are bots: accounts currently in the 'bot' user group, plus any name ending
 * in "bot" as a word (catches retired bots that lost the flag). Only names containing "bot" are
 * checked against the API, 50 per request.
 */
export const BOT_NAME = /bot\b/i;
export async function fetchBotUsers(names, { lang = 'en', signal, userAgent } = {}) {
  const candidates = names.filter(n => n && /bot/i.test(n));
  const bots = new Set(candidates.filter(n => BOT_NAME.test(n)));
  const opts = { headers: userAgent ? { 'User-Agent': userAgent } : undefined, signal };
  for (let i = 0; i < candidates.length; i += 50) {
    const data = await getJson(apiUrl(lang, {
      action: 'query', list: 'users', usprop: 'groups', ususers: candidates.slice(i, i + 50).join('|'),
    }), opts);
    for (const u of data.query?.users || []) if (u.groups?.includes('bot')) bots.add(u.name);
  }
  return bots;
}

/** Mean, median and mode of edits per user (mode ties go to the smaller count). */
export function editStats(users) {
  if (!users.length) return { mean: 0, median: 0, mode: 0 };
  const c = users.map(u => u.edits).sort((a, b) => a - b);
  const mid = c.length >> 1;
  const freq = new Map();
  for (const v of c) freq.set(v, (freq.get(v) || 0) + 1);
  let mode = c[0];
  for (const [v, f] of freq) if (f > freq.get(mode)) mode = v;
  return {
    mean: c.reduce((s, v) => s + v, 0) / c.length,
    median: c.length % 2 ? c[mid] : (c[mid - 1] + c[mid]) / 2,
    mode,
  };
}

/**
 * Walking users in chronological order of `key` ('first' or 'last'), the users who set a new
 * high for total edits: the most active contributor so far. Ties don't set a new record.
 */
export function recordHolders(users, key) {
  const out = new Set();
  let max = 0;
  for (const u of sortUsers(users, key, 'asc')) {
    if (u.edits > max) { out.add(u.user); max = u.edits; }
  }
  return out;
}

/** Names of the user(s) with the most edits. */
export function topUsers(users) {
  const max = users.reduce((m, u) => Math.max(m, u.edits), 0);
  return new Set(users.filter(u => u.edits === max).map(u => u.user));
}

/**
 * Merge per-page user lists into one row per user: { user, anon, hidden, per: [stats | null per page] }.
 */
export function combineUsers(lists) {
  const map = new Map();
  lists.forEach((list, k) => {
    for (const u of list) {
      let c = map.get(u.user);
      if (!c) map.set(u.user, (c = { user: u.user, anon: u.anon, hidden: u.hidden, per: lists.map(() => null) }));
      c.per[k] = u;
    }
  });
  return [...map.values()];
}

/**
 * Sort combined rows by one page's numbers (`anchor`). Users with no edits on that page go last,
 * ordered by the first other page they did edit.
 */
export function sortCombined(rows, by = 'edits', dir, anchor = 0) {
  const s = SORTS[by] || SORTS.edits;
  const sign = (dir || s.defaultDir) === 'asc' ? 1 : -1;
  const ref = r => r.per[anchor] ?? r.per.find(Boolean);
  return [...rows].sort((a, b) =>
    (!!b.per[anchor] - !!a.per[anchor])
    || sign * (s.key(ref(a)) - s.key(ref(b)))
    || ref(b).edits - ref(a).edits
    || a.user.localeCompare(b.user));
}

export const SORTS = {
  edits: { label: 'Total edits', defaultDir: 'desc', key: u => u.edits },
  first: { label: 'First edit', defaultDir: 'asc', key: u => u.first },
  last: { label: 'Last edit', defaultDir: 'desc', key: u => u.last },
  duration: { label: 'Duration', defaultDir: 'desc', key: u => u.last - u.first },
};

export function sortUsers(users, by = 'edits', dir) {
  const s = SORTS[by] || SORTS.edits;
  const sign = (dir || s.defaultDir) === 'asc' ? 1 : -1;
  // Ties: more edits first, then name.
  return [...users].sort((a, b) =>
    sign * (s.key(a) - s.key(b)) || b.edits - a.edits || a.user.localeCompare(b.user));
}

// ---------------------------------------------------------------- formatting

const pad = n => String(n).padStart(2, '0');

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function fmtPeriod(ts, g) {
  const d = new Date(ts);
  switch (g) {
    case 'hour': return `${fmtDate(ts)} ${pad(d.getUTCHours())}:00`;
    case 'day': return fmtDate(ts);
    case 'week': return `wk of ${fmtDate(ts)}`;
    case 'month': return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    case 'year': return String(d.getUTCFullYear());
  }
}

export const fmtInt = n => (n == null ? '—' : n.toLocaleString('en-US'));

// Adds n calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28/29).
function addMonthsClamped(ts, n) {
  const d = new Date(ts);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/**
 * Time between a user's first and last edit as calendar years, months and days, with any
 * partial day rounded up (so a single edit, or two edits an hour apart, is 1 day).
 */
export function editDuration(first, last) {
  const days = Math.max(1, Math.ceil((last - first) / DAY));
  const end = first + days * DAY;
  let months = 0;
  while (addMonthsClamped(first, months + 1) <= end) months++;
  const d = Math.round((end - addMonthsClamped(first, months)) / DAY);
  return { years: Math.floor(months / 12), months: months % 12, days: d };
}

/** Calendar years, months and days from one moment to another, e.g. "4y 6m 7d" (partial days dropped). */

// Page sizes are in bytes of wikitext; about 6 bytes per word (5 letters plus a space) gives a
// rough word count. Markup, references and non-Latin scripts make this approximate.
export const BYTES_PER_WORD = 6;
export const approxWords = bytes => (bytes == null ? null : Math.round(bytes / BYTES_PER_WORD));


/** An age as its two largest units: "21y 3m" from a year up, else "3m 12d", else "12d". */
export function fmtAge(from, to) {
  let months = 0;
  while (addMonthsClamped(from, months + 1) <= to) months++;
  const days = Math.floor((to - addMonthsClamped(from, months)) / DAY);
  if (months >= 12) return `${Math.floor(months / 12)}y${months % 12 ? ` ${months % 12}m` : ''}`;
  if (months) return `${months}m${days ? ` ${days}d` : ''}`;
  return `${days}d`;
}

export function fmtDuration({ years, months, days }) {
  const parts = [];
  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}m`);
  if (days) parts.push(`${days}d`);
  return parts.join(' ') || '1d';
}

export function toCsv(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
}

const isoOrBlank = t => (t == null ? '' : new Date(t).toISOString());

/**
 * Timeline CSV for one or more pages. `tl.series` holds each page's bins (aligned with `tl.bins`).
 * With several pages, each column is prefixed with the page's title.
 */
export function timelineCsv(tl, titles = []) {
  const series = tl.series || [tl.bins];
  const cols = ['edits', 'editors', 'bot_editors', 'ip_editors', 'hidden_name_editors', 'edits_per_editor', 'approx_word_count_at_end'];
  const name = (k, c) => (series.length > 1 ? `${titles[k]}: ${c}` : c);
  return toCsv([
    ['period_start_utc', 'period', ...series.flatMap((_, k) => cols.map(c => name(k, c)))],
    ...tl.bins.map((b, i) => [isoOrBlank(b.start), fmtPeriod(b.start, tl.granularity), ...series.flatMap(bins => {
      const x = bins[i];
      return [x.edits, x.editors, x.bots, x.ips, x.hidden, x.editors ? (x.edits / x.editors).toFixed(2) : '', x.words];
    })]),
  ]);
}

/**
 * Per-user CSV for one or more pages, from combined rows ({ user, anon, per: [stats | null] }).
 * With several pages, each column is prefixed with the page's title; a page the user didn't edit is blank.
 */
export function usersCsv(rows, titles = []) {
  const n = rows[0]?.per.length ?? 1;
  const cols = ['edits', 'first_edit_utc', 'last_edit_utc', 'duration'];
  const name = (k, c) => (n > 1 ? `${titles[k]}: ${c}` : c);
  return toCsv([
    ['user', 'anonymous', ...Array.from({ length: n }, (_, k) => cols.map(c => name(k, c))).flat()],
    ...rows.map(r => [r.user, r.anon ? 'yes' : 'no', ...r.per.flatMap(u => (u
      ? [u.edits, isoOrBlank(u.first), isoOrBlank(u.last), fmtDuration(editDuration(u.first, u.last))]
      : [0, '', '', '']))]),
  ]);
}
