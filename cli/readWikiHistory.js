#!/usr/bin/env node
// Command-line front end. Usage: node cli/readWikiHistory.js --help
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GRANULARITIES, SORTS, parsePageInput, fetchRevisions, buildTimeline, buildUsers, sortUsers,
  autoGranularity, estimateBins, parseUtc, fmtPeriod, fmtDateTime, fmtDate, fmtInt, timelineCsv, usersCsv,
} from '../lib/core.js';

const USER_AGENT = 'readWikiHistory/0.1 (https://github.com/cshirky/readWikiHistory)';

const HELP = `readWikiHistory — edit timeline and per-user edit counts for a Wikipedia page

Usage:
  readWikiHistory <page title or URL> [options]

Options:
  -l, --lang <code>        Wikipedia language edition (default: en, or taken from a URL)
  -s, --start <date>       Start of range, UTC: 2020 | 2020-03 | 2020-03-04 | 2020-03-04T12
  -e, --end <date>         End of range, UTC (inclusive; "2020" means through Dec 31 2020)
  -g, --granularity <g>    hour | day | week | month | year | auto (default: auto)
      --sort <key>         edits | first | last   (default: edits)
      --asc / --desc       Sort direction (defaults: edits desc, first asc, last desc)
  -n, --top <n|all>        How many users to list (default: 25)
      --width <cols>       Bar width in characters (default: 40)
      --json               Print JSON instead of charts
      --csv <dir>          Also write timeline.csv and users.csv into <dir>
  -h, --help               Show this help

Defaults: the range runs from page creation to now; auto granularity picks the finest
unit that gives at most 120 periods. All times are UTC.

Examples:
  readWikiHistory "Clay Shirky"
  readWikiHistory https://en.wikipedia.org/wiki/Ada_Lovelace -g year
  readWikiHistory "Ada Lovelace" -s 2015-12 -e 2015-12 -g day --sort first -n all
`;

function parseArgs(argv) {
  const o = { lang: undefined, granularity: 'auto', sort: 'edits', dir: undefined, top: 25, width: 40, positional: [] };
  const need = (i, name) => {
    if (argv[i + 1] == null) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-l': case '--lang': o.lang = need(i++, a); break;
      case '-s': case '--start': o.start = need(i++, a); break;
      case '-e': case '--end': o.end = need(i++, a); break;
      case '-g': case '--granularity': o.granularity = need(i++, a); break;
      case '--sort': o.sort = need(i++, a); break;
      case '--asc': o.dir = 'asc'; break;
      case '--desc': o.dir = 'desc'; break;
      case '-n': case '--top': o.top = need(i++, a); break;
      case '--width': o.width = +need(i++, a); break;
      case '--json': o.json = true; break;
      case '--csv': o.csv = need(i++, a); break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        o.positional.push(a);
    }
  }
  if (o.granularity !== 'auto' && !GRANULARITIES.includes(o.granularity))
    throw new Error(`--granularity must be one of auto, ${GRANULARITIES.join(', ')}`);
  if (!SORTS[o.sort]) throw new Error(`--sort must be one of ${Object.keys(SORTS).join(', ')}`);
  return o;
}

// Horizontal bar with eighth-block resolution.
const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
function bar(value, max, width) {
  if (!value || !max) return '';
  const eighths = Math.max(1, Math.round((value / max) * width * 8));
  return '█'.repeat(Math.floor(eighths / 8)) + BLOCKS[eighths % 8];
}

const tty = process.stdout.isTTY;
const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const blue = s => (tty ? `\x1b[34m${s}\x1b[0m` : s);

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.positional.length) {
    process.stdout.write(HELP);
    process.exit(o.help ? 0 : 1);
  }
  const parsed = parsePageInput(o.positional.join(' '), o.lang || 'en');
  const lang = o.lang || parsed.lang;
  const start = parseUtc(o.start);
  const end = parseUtc(o.end, { endOfPeriod: true });
  if (start != null && end != null && end < start) throw new Error('--end is before --start');

  const progress = (n, ts) => {
    if (process.stderr.isTTY) process.stderr.write(`\r  fetching revisions… ${fmtInt(n)}${ts ? ` (through ${fmtDate(ts)})` : ''}   `);
  };
  const { page, revisions } = await fetchRevisions(parsed.title, { lang, start, end, onProgress: progress, userAgent: USER_AGENT });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

  const t0 = start ?? page.created ?? Date.now();
  const t1 = end ?? Date.now();
  const gran = o.granularity === 'auto' ? autoGranularity(t0, t1, 120) : o.granularity;
  if (estimateBins(t0, t1, gran) > 20000)
    throw new Error(`That would print ~${fmtInt(estimateBins(t0, t1, gran))} ${gran}s. Narrow the range with --start/--end or use a coarser --granularity.`);

  const timeline = buildTimeline(revisions, { granularity: gran, start: t0, end: t1 });
  const users = sortUsers(buildUsers(revisions, { start: t0, end: t1 }), o.sort, o.dir);
  const totalEdits = users.reduce((s, u) => s + u.edits, 0);

  if (o.csv) {
    mkdirSync(o.csv, { recursive: true });
    writeFileSync(join(o.csv, 'timeline.csv'), timelineCsv(timeline));
    writeFileSync(join(o.csv, 'users.csv'), usersCsv(users));
    process.stderr.write(`Wrote ${join(o.csv, 'timeline.csv')} and ${join(o.csv, 'users.csv')}\n`);
  }

  if (o.json) {
    const iso = t => new Date(t).toISOString();
    process.stdout.write(JSON.stringify({
      page: { ...page, created: page.created && iso(page.created), url: pageUrl(page) },
      range: { start: iso(t0), end: iso(t1), granularity: gran },
      totals: { edits: totalEdits, editors: users.length },
      timeline: timeline.bins.map(b => ({ start: iso(b.start), period: fmtPeriod(b.start, gran), edits: b.edits, bytes: b.bytes })),
      users: users.map(u => ({ user: u.user, anon: u.anon, edits: u.edits, first: iso(u.first), last: iso(u.last) })),
    }, null, 2) + '\n');
    return;
  }

  const out = [];
  const W = o.width;
  out.push('');
  out.push(bold(page.title) + dim(`  ${pageUrl(page)}`));
  if (page.redirectedFrom) out.push(dim(`(redirected from "${page.redirectedFrom}")`));
  out.push(`${fmtInt(totalEdits)} edits by ${fmtInt(users.length)} editors · ${fmtDate(t0)} → ${fmtDate(t1)} UTC`
    + (page.created ? dim(` · page created ${fmtDateTime(page.created)}`) : ''));

  // --- timeline
  const bins = timeline.bins;
  const maxEdits = Math.max(...bins.map(b => b.edits));
  const pw = Math.max(...bins.map(b => fmtPeriod(b.start, gran).length));
  const ew = Math.max(5, fmtInt(maxEdits).length);
  out.push('');
  out.push(bold(`EDITS PER ${gran.toUpperCase()}`));
  out.push(dim(`${'period'.padEnd(pw)}  ${'edits'.padStart(ew)}  ${''.padEnd(W)}  bytes at end`));
  for (const b of bins) {
    out.push(`${fmtPeriod(b.start, gran).padEnd(pw)}  ${fmtInt(b.edits).padStart(ew)}  ${blue(bar(b.edits, maxEdits, W).padEnd(W))}  ${fmtInt(b.bytes).padStart(12)}`);
  }

  // --- users
  const top = o.top === 'all' ? users.length : Math.max(1, +o.top || 25);
  const shown = users.slice(0, top);
  const dirLabel = (o.dir || SORTS[o.sort].defaultDir) === 'asc' ? 'ascending' : 'descending';
  const maxU = Math.max(...users.map(u => u.edits), 1);
  const nw = Math.min(32, Math.max(4, ...shown.map(u => u.user.length + (u.anon ? 5 : 0))));
  const uw = Math.max(5, fmtInt(maxU).length);
  const UW = Math.max(10, Math.round(W * 0.75));
  out.push('');
  out.push(bold('EDITS PER USER') + dim(`  sorted by ${SORTS[o.sort].label.toLowerCase()}, ${dirLabel}`
    + (shown.length < users.length ? ` · top ${shown.length} of ${fmtInt(users.length)} (use --top all)` : '')));
  out.push(dim(`${'user'.padEnd(nw)}  ${'edits'.padStart(uw)}  ${''.padEnd(UW)}  ${'first edit'.padEnd(16)}  last edit`));
  for (const u of shown) {
    let name = u.user + (u.anon ? ' (IP)' : '');
    if (name.length > nw) name = name.slice(0, nw - 1) + '…';
    out.push(`${name.padEnd(nw)}  ${fmtInt(u.edits).padStart(uw)}  ${blue(bar(u.edits, maxU, UW).padEnd(UW))}  ${fmtDateTime(u.first)}  ${fmtDateTime(u.last)}`);
  }
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

const pageUrl = p => `https://${p.lang}.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`;

main().catch(err => {
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  process.stderr.write(`readWikiHistory: ${err.message}\n`);
  process.exit(1);
});
