// Shared data layer for the web page and the CLI.
// Runs unchanged in browsers and Node >= 18 (both have global fetch).
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
 * If `start` is given, one extra revision from just before it is fetched (flagged `seed`)
 * so byte counts are known from the first period on.
 * Returns { page: {title, pageid, lang, created, redirectedFrom}, revisions: [...] }.
 */
export async function fetchRevisions(title, { lang = 'en', start, end, onProgress, signal, userAgent } = {}) {
  const headers = userAgent ? { 'User-Agent': userAgent } : undefined;
  const opts = { headers, signal };
  const base = {
    action: 'query', prop: 'revisions', titles: title, redirects: '1',
    rvprop: RVPROP, rvlimit: 'max', rvdir: 'newer',
    rvstart: start != null ? new Date(start).toISOString() : undefined,
    rvend: end != null ? new Date(end).toISOString() : undefined,
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

  if (start == null) {
    page.created = revisions[0]?.ts ?? null;
  } else {
    // Creation date and the last revision before the window (for the starting byte count).
    const [first, before] = await Promise.all([
      getJson(apiUrl(lang, { action: 'query', prop: 'revisions', pageids: page.pageid, rvprop: RVPROP, rvlimit: 1, rvdir: 'newer' }), opts),
      getJson(apiUrl(lang, { action: 'query', prop: 'revisions', pageids: page.pageid, rvprop: RVPROP, rvlimit: 1, rvdir: 'older', rvstart: new Date(start - 1000).toISOString() }), opts),
    ]);
    const f = first.query.pages[0].revisions?.[0];
    page.created = f ? Date.parse(f.timestamp) : null;
    const b = before.query.pages[0].revisions?.[0];
    if (b) revisions.unshift({ ...toRev(b), seed: true });
  }
  return { page, revisions };
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
 * Each bin: { start, end, edits, bytes } where bytes is the page size after the last
 * revision at or before the end of the period (carried forward through quiet periods).
 * `revisions` must be sorted oldest first.
 */
export function buildTimeline(revisions, { granularity, start, end } = {}) {
  const real = revisions.filter(r => !r.seed);
  const t0 = start ?? real[0]?.ts ?? Date.now();
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
    while (i < revisions.length && revisions[i].ts < next && revisions[i].ts <= t1) {
      if (!revisions[i].seed) edits++;
      if (revisions[i].size != null) size = revisions[i].size;
      i++;
    }
    bins.push({ start: t, end: next, edits, bytes: size });
  }
  return { granularity: g, start: t0, end: t1, bins };
}

// ---------------------------------------------------------------- users

export const HIDDEN_USER = '(username hidden)';

/** Per-user totals within [start, end]. */
export function buildUsers(revisions, { start = -Infinity, end = Infinity } = {}) {
  const map = new Map();
  for (const r of revisions) {
    if (r.seed || r.ts < start || r.ts > end) continue;
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

export const SORTS = {
  edits: { label: 'Total edits', defaultDir: 'desc', key: u => u.edits },
  first: { label: 'First edit', defaultDir: 'asc', key: u => u.first },
  last: { label: 'Last edit', defaultDir: 'desc', key: u => u.last },
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

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${fmtDate(ts)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
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

/** Parse "2020", "2020-03", "2020-03-04", "2020-03-04T12:00" as UTC. */
export function parseUtc(s, { endOfPeriod = false } = {}) {
  if (s == null || s === '') return undefined;
  const m = String(s).trim().match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T ](\d{1,2})(?::(\d{2}))?)?)?)?Z?$/);
  if (!m) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`Can't parse date "${s}"`);
    return t;
  }
  const [, y, mo, d, h, mi] = m;
  const parts = [+y, mo ? +mo - 1 : 0, d ? +d : 1, h ? +h : 0, mi ? +mi : 0];
  const t = Date.UTC(...parts);
  if (!endOfPeriod) return t;
  const g = mi ? null : h ? 'hour' : d ? 'day' : mo ? 'month' : 'year';
  return g ? addUnits(t, g) - 1 : t + 60e3 - 1;
}

export function toCsv(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
}

export function timelineCsv(tl) {
  return toCsv([
    ['period_start_utc', 'period', 'edits', 'bytes_at_end'],
    ...tl.bins.map(b => [new Date(b.start).toISOString(), fmtPeriod(b.start, tl.granularity), b.edits, b.bytes]),
  ]);
}

export function usersCsv(users) {
  return toCsv([
    ['user', 'anonymous', 'edits', 'first_edit_utc', 'last_edit_utc'],
    ...users.map(u => [u.user, u.anon ? 'yes' : 'no', u.edits, new Date(u.first).toISOString(), new Date(u.last).toISOString()]),
  ]);
}
