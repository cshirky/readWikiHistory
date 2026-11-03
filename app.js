import {
  GRANULARITIES, SORTS, HIDDEN_USER, parsePageInput, fetchRevisions, buildTimeline, buildUsers, sortUsers,
  autoGranularity, estimateBins, addUnits, floorTo, fmtPeriod, fmtDate, fmtDateTime, fmtInt, timelineCsv, usersCsv,
  fetchBotUsers, BOT_NAME, editorBreakdown, editStats, recordHolders, topUsers, editDuration, fmtDuration,
} from './lib/core.js';

const MAX_BINS = 4000;   // granularities that would exceed this are disabled
const AUTO_BINS = 300;   // "Auto" picks the finest unit at or under this
const USER_BATCH = 150;  // user rows added per infinite-scroll step
const RECENT_MS = 7 * 864e5; // names turn blue if the user edited within this window

const $ = id => document.getElementById(id);
const el = {
  form: $('page-form'), page: $('page-input'), lang: $('lang-input'), load: $('load-btn'), status: $('status'),
  results: $('results'), pageLink: $('page-link'), summary: $('summary-line'),
  granSeg: $('gran-seg'), start: $('start-input'), end: $('end-input'), reset: $('reset-btn'),
  tlTitle: $('tl-title'), tlWrap: $('tl-wrap'), tlCanvas: $('tl-canvas'), brush: $('tl-brush'), tip: $('tl-tip'),
  bytesWrap: $('bytes-wrap'), bytesCanvas: $('bytes-canvas'),
  tlTable: $('tl-table'), tlCsv: $('tl-csv'), tableView: document.querySelector('.table-view'),
  users: $('users'), usersSub: $('users-sub'), sortSeg: $('sort-seg'), dirBtn: $('dir-btn'),
  usersStats: $('users-stats'), usersKey: $('users-key'), usersEnd: $('users-end'), usersCsv: $('users-csv'),
};

const state = {
  data: null,          // { page, revisions }
  fullStart: 0, fullEnd: 0,
  start: null, end: null, // null = full history
  gran: 'auto',
  sort: 'edits', dir: null,
  hover: -1,
};
let tl = null;         // current timeline { granularity, start, end, bins }
let users = [];        // current sorted users
let loadCtrl = null;

// ------------------------------------------------------------------ loading

el.form.addEventListener('submit', e => {
  e.preventDefault();
  const { lang, title } = parsePageInput(el.page.value, el.lang.value.trim() || 'en');
  if (!title) return;
  el.lang.value = lang;
  load(title, lang, {});
});

async function load(title, lang, initial) {
  loadCtrl?.abort();
  const ctrl = (loadCtrl = new AbortController());
  setStatus(`Fetching revisions of “${title}”…`);
  el.load.disabled = true;
  try {
    const data = await fetchRevisions(title, {
      lang, signal: ctrl.signal,
      onProgress: (n, ts) => setStatus(`Fetching revisions… ${fmtInt(n)}${ts ? ` (through ${fmtDate(ts)})` : ''}`),
    });
    if (ctrl.signal.aborted) return;
    if (!data.revisions.length) throw new Error('That page has no visible revisions.');
    setStatus('Checking for bot accounts…');
    const names = [...new Set(data.revisions.map(r => r.user).filter(Boolean))];
    try {
      data.bots = await fetchBotUsers(names, { lang, signal: ctrl.signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      data.bots = new Set(names.filter(n => BOT_NAME.test(n))); // fall back to the name rule
    }
    data.allTimeTop = topUsers(buildUsers(data.revisions));
    if (ctrl.signal.aborted) return;
    state.data = data;
    state.fullStart = data.page.created ?? data.revisions[0].ts;
    state.fullEnd = Date.now();
    state.start = initial.start ?? null;
    state.end = initial.end ?? null;
    state.gran = initial.gran ?? 'auto';
    state.sort = initial.sort ?? 'edits';
    state.dir = initial.dir ?? null;
    el.page.value = data.page.title;
    setStatus('');
    el.results.hidden = false;
    renderAll();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(err.message, true);
  } finally {
    if (loadCtrl === ctrl) el.load.disabled = false;
  }
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
  return autoGranularity(start, end, AUTO_BINS);
}

function renderAll() {
  const { page, revisions } = state.data;
  const { start, end } = range();
  tl = buildTimeline(revisions, { granularity: effectiveGran(), start, end, bots: state.data.bots });
  users = sortUsers(buildUsers(revisions, { start, end }), state.sort, state.dir);
  state.hover = -1;

  // summary
  const all = revisions;
  const editors = new Set(all.map(r => r.user ?? HIDDEN_USER)).size;
  el.pageLink.textContent = page.title;
  el.pageLink.href = `https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`;
  el.summary.textContent = [
    page.redirectedFrom ? `Redirected from “${page.redirectedFrom}”` : null,
    `${page.lang}.wikipedia.org`,
    `${fmtInt(all.length)} edits by ${fmtInt(editors)} editors`,
    `created ${fmtDateTime(state.fullStart)} UTC`,
    `current size ${fmtInt(all.at(-1).size)} bytes`,
  ].filter(Boolean).join(' · ');

  renderControls();
  const inRange = users.reduce((s, u) => s + u.edits, 0);
  const span = `${fmtDate(start)} → ${fmtDate(end)}`;
  el.tlTitle.textContent = `Edits per ${tl.granularity} · ${span}`;
  el.usersSub.textContent = `${fmtInt(inRange)} edits by ${fmtInt(users.length)} editors (${subtotals(editorBreakdown(users, state.data.bots))}) · ${span}`
    + (state.start != null || state.end != null ? ' (selected range)' : '');
  drawCharts();
  if (el.tableView.open) renderTable();
  renderUsers();
  syncUrl();
}

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
  users = sortUsers(users, state.sort, state.dir);
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
  drawBytes();
}

function drawTimeline() {
  const { ctx, width, height } = setupCanvas(el.tlCanvas);
  const sx = xScale(width);
  const h = height - M.t - M.b;
  const maxEdits = Math.max(...tl.bins.map(b => b.edits));
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

  // columns
  const base = css('--series-1'), hov = css('--series-1-hover');
  let maxIdx = -1;
  tl.bins.forEach((b, i) => {
    if (b.edits === maxEdits && maxIdx < 0) maxIdx = i;
    if (!b.edits) return;
    const x0 = sx.x(b.start), slot = sx.x(b.end) - x0;
    const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
    const bw = Math.max(1, Math.min(24, slot - gap));
    const bx = x0 + (slot - bw) / 2;
    const top = y(b.edits), bh = Math.max(1, M.t + h - top);
    ctx.fillStyle = i === state.hover ? hov : base;
    ctx.beginPath();
    if (bw >= 8 && ctx.roundRect) ctx.roundRect(bx, M.t + h - bh, bw, bh, [Math.min(4, bh), Math.min(4, bh), 0, 0]);
    else ctx.rect(bx, M.t + h - bh, bw, bh);
    ctx.fill();
  });

  // baseline
  ctx.fillStyle = css('--axis');
  ctx.fillRect(M.l, M.t + h, sx.w, 1);

  // direct label on the peak only
  if (maxIdx >= 0 && maxEdits > 0) {
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

function drawBytes() {
  const { ctx, width, height } = setupCanvas(el.bytesCanvas);
  const sx = xScale(width);
  const top = 10, bottom = 4;
  const h = height - top - bottom;
  const vals = tl.bins.map(b => b.bytes).filter(v => v != null);
  const ys = niceScale(Math.max(0, ...vals), 2);
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

  // step line (value holds across each period, ends at its end-of-period size)
  const segs = [];
  let cur = null;
  for (const b of tl.bins) {
    if (b.bytes == null) { cur = null; continue; }
    if (!cur) segs.push((cur = []));
    cur.push([sx.x(b.start), y(b.bytes)], [sx.x(b.end), y(b.bytes)]);
  }
  for (const pts of segs) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], y(0));
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(pts.at(-1)[0], y(0));
    ctx.closePath();
    ctx.fillStyle = css('--size-wash');
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = css('--size-line');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  if (state.hover >= 0 && tl.bins[state.hover].bytes != null) {
    const b = tl.bins[state.hover];
    const cx = (sx.x(b.start) + sx.x(b.end)) / 2;
    ctx.fillStyle = css('--hover-band');
    ctx.fillRect(sx.x(b.start), top, Math.max(1, sx.x(b.end) - sx.x(b.start)), h);
    ctx.beginPath();
    ctx.arc(cx, y(b.bytes), 4, 0, Math.PI * 2);
    ctx.fillStyle = css('--size-line');
    ctx.strokeStyle = css('--surface-1');
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
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

function setHover(i, clientX, clientY) {
  if (i !== state.hover) {
    state.hover = i;
    drawCharts();
  }
  if (i < 0) { el.tip.hidden = true; return; }
  const b = tl.bins[i];
  const canZoom = tl.granularity !== 'hour';
  el.tip.innerHTML = `
    <div class="t-head">${fmtPeriod(b.start, tl.granularity)}</div>
    <div class="t-row"><span>Edits</span><span>${fmtInt(b.edits)}</span></div>
    <div class="t-row"><span>Editors</span><span>${fmtInt(b.editors)}</span></div>
    <div class="t-row t-sub"><span>bots</span><span>${fmtInt(b.bots)}</span></div>
    <div class="t-row t-sub"><span>IP addresses</span><span>${fmtInt(b.ips)}</span></div>
    <div class="t-row t-sub"><span>hidden usernames</span><span>${fmtInt(b.hidden)}</span></div>
    <div class="t-row"><span>Avg edits per editor</span><span>${perEditor(b)}</span></div>
    <div class="t-row"><span>Bytes at end</span><span>${fmtInt(b.bytes)}</span></div>
    ${canZoom ? '<div class="t-hint">Click to zoom into this period</div>' : ''}`;
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
for (const canvas of [el.tlCanvas, el.bytesCanvas]) {
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
    setHover(binAt(e.clientX, canvas), e.clientX, e.clientY);
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
      if (i >= 0 && tl.granularity !== 'hour') zoomTo(tl.bins[i].start, tl.bins[i].end - 1);
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
  const rows = tl.bins.map(b =>
    `<tr><td>${fmtPeriod(b.start, tl.granularity)}</td><td>${fmtInt(b.edits)}</td><td>${fmtInt(b.editors)}</td><td>${perEditor(b)}</td><td>${fmtInt(b.bytes)}</td></tr>`);
  el.tlTable.innerHTML = `<thead><tr><th>Period (UTC)</th><th>Edits</th><th>Editors</th><th>Edits per editor</th><th>Bytes at end</th></tr></thead><tbody>${rows.join('')}</tbody>`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = () => state.data.page.title.replace(/[^\w-]+/g, '_');
el.tlCsv.onclick = () => download(`${slug()}-edits-per-${tl.granularity}.csv`, timelineCsv(tl));
el.usersCsv.onclick = () => download(`${slug()}-edits-per-user.csv`, usersCsv(users));

// ------------------------------------------------------------------ users chart

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Rows are added in batches as the list scrolls into view.
const isRecent = u => !u.hidden && Date.now() - u.last <= RECENT_MS;
const ulist = { shown: 0, max: 1, records: new Set(), timeSort: false };

function renderUsers() {
  const { bots, allTimeTop } = state.data;
  ulist.shown = 0;
  ulist.max = users.reduce((m, u) => Math.max(m, u.edits), 1);
  ulist.timeSort = state.sort === 'first' || state.sort === 'last'; // bold/underline apply to date sorts only
  ulist.records = ulist.timeSort ? recordHolders(users, state.sort) : new Set();

  const s = editStats(users);
  const num = v => (Number.isInteger(v) ? fmtInt(v) : v.toFixed(1));
  el.usersStats.innerHTML = `Edits per editor: <b>mean</b> ${num(s.mean)} · <b>median</b> ${num(s.median)} · <b>mode</b> ${num(s.mode)}`;

  const anyBots = users.some(u => bots.has(u.user));
  const key = [];
  if (ulist.timeSort) {
    const when = state.sort === 'first' ? 'first edit' : 'last edit';
    key.push(`<span class="u-record">Bold</span>: most edits of anyone up to that ${when}`);
    if (users.some(u => allTimeTop.has(u.user))) key.push('<span class="u-top">Underlined</span>: most edits of all time');
  }
  if (users.some(isRecent)) key.push('<span class="u-recent">Blue</span>: edited in the last 7 days');
  if (anyBots) key.push('<span class="u-bot">Orange</span>: bot account');
  el.usersKey.innerHTML = key.join(' · ');
  el.usersKey.hidden = !key.length;

  const arrow = dirArrow();
  const head = k => `${state.sort === k ? 'sorted' : ''}" data-arrow="${arrow}" data-sort="${k}`;
  el.users.innerHTML = `
    <div class="u-row u-header" role="row">
      <span class="u-rank" role="columnheader">#</span>
      <span class="u-name" role="columnheader">User</span>
      <span class="u-date u-first ${head('first')}" role="columnheader" style="cursor:pointer">First edit</span>
      <span class="u-date u-last ${head('last')}" role="columnheader" style="cursor:pointer">Last edit</span>
      <span class="u-dur ${head('duration')}" role="columnheader" style="cursor:pointer">Duration</span>
      <span class="u-barcell ${head('edits')}" role="columnheader" style="cursor:pointer">Edits</span>
    </div>`;
  el.users.querySelectorAll('[data-sort]').forEach(h => (h.onclick = () => setSort(h.dataset.sort)));
  appendUsers();
}

function userRow(u, i) {
  const { bots, allTimeTop, page } = state.data;
  const cls = ['u-link'];
  // Blue (recent) wins over orange (bot); the "bot" tag still marks the account type.
  if (isRecent(u)) cls.push('u-recent');
  else if (bots.has(u.user)) cls.push('u-bot');
  if (ulist.records.has(u.user)) cls.push('u-record');
  if (ulist.timeSort && allTimeTop.has(u.user)) cls.push('u-top');
  const tags = (u.anon ? '<span class="u-tag">IP</span>' : '') + (bots.has(u.user) ? '<span class="u-tag">bot</span>' : '');
  const name = u.hidden
    ? `<span class="muted">${HIDDEN_USER}</span>`
    : `<a class="${cls.join(' ')}" href="https://${page.lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(u.user)}" target="_blank" rel="noopener" title="${esc(u.user)}">${esc(u.user)}</a>${tags}`;
  return `<div class="u-row" role="row">
    <span class="u-rank" role="cell">${i + 1}</span>
    <span class="u-name" role="cell">${name}</span>
    <span class="u-date u-first" role="cell" title="First edit">${fmtDate(u.first)}</span>
    <span class="u-date u-last" role="cell" title="Last edit">${fmtDate(u.last)}</span>
    <span class="u-dur" role="cell" title="Time from first to last edit, rounded up to whole days">${fmtDuration(editDuration(u.first, u.last))}</span>
    <span class="u-barcell" role="cell"><span class="u-bar" style="width:calc((100% - 3.5em) * ${u.edits / ulist.max})"></span><span class="u-count">${fmtInt(u.edits)}</span></span>
  </div>`;
}

function appendUsers() {
  const batch = users.slice(ulist.shown, ulist.shown + USER_BATCH);
  el.users.insertAdjacentHTML('beforeend', batch.map((u, j) => userRow(u, ulist.shown + j)).join(''));
  ulist.shown += batch.length;
  el.usersEnd.textContent = ulist.shown < users.length
    ? `Showing ${fmtInt(ulist.shown)} of ${fmtInt(users.length)} — scroll for more`
    : `All ${fmtInt(users.length)} editors shown`;
  // The observer only fires on changes, so keep filling while the end marker is still in view.
  requestAnimationFrame(() => {
    if (ulist.shown < users.length && el.usersEnd.getBoundingClientRect().top < innerHeight + 800) appendUsers();
  });
}

new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && state.data && ulist.shown < users.length) appendUsers();
}, { rootMargin: '800px 0px' }).observe(el.usersEnd);

// ------------------------------------------------------------------ URL state

function syncUrl() {
  const p = new URLSearchParams();
  p.set('page', state.data.page.title);
  if (state.data.page.lang !== 'en') p.set('lang', state.data.page.lang);
  if (state.start != null) p.set('from', toLocalInput(state.start));
  if (state.end != null) p.set('to', toLocalInput(state.end));
  if (state.gran !== 'auto') p.set('g', state.gran);
  if (state.sort !== 'edits') p.set('sort', state.sort);
  if (state.dir) p.set('dir', state.dir);
  history.replaceState(null, '', `?${p}`);
}

function initFromUrl() {
  const p = new URLSearchParams(location.search);
  const page = p.get('page');
  if (!page) { el.page.focus(); return; }
  const lang = p.get('lang') || 'en';
  el.page.value = page;
  el.lang.value = lang;
  load(page, lang, {
    start: fromLocalInput(p.get('from')) ?? undefined,
    end: p.get('to') ? fromLocalInput(p.get('to'), true) : undefined,
    gran: GRANULARITIES.includes(p.get('g')) ? p.get('g') : undefined,
    sort: SORTS[p.get('sort')] ? p.get('sort') : undefined,
    dir: ['asc', 'desc'].includes(p.get('dir')) ? p.get('dir') : undefined,
  });
}
initFromUrl();
