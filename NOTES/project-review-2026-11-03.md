# Project review: readWikiHistory, 2026-11-03

readWikiHistory is a static GitHub Pages site that charts the edit history of up to three Wikipedia
pages. It has no build step and no dependencies, and it's small: 2 JS files (about 61 KB, 1,430 lines),
one HTML page, one stylesheet, a README and a `package.json`. It's tidy overall. The main debts come
from fast iteration: leftovers from the deleted CLI and from the "page 1 only" stage, CSS rules that
were appended instead of merged, one-page and multi-page code paths that do the same job twice, and
an `app.js` that has grown to nearly 1,000 lines.

## Summary
| Type | Findings | Suggested effort |
|---|---|---|
| Unused work | 5 | small |
| Duplicates that could be merged | 5 | small–medium |
| Design patterns worth changing | 3 | small–large |
| Docs and data hygiene | 2 | small |

## Unused work

### Hidden "users-note" element left over from the "page 1 only" stage
- **Where:** `index.html:74` (`<p id="users-note" hidden>`), `app.js:22` (`usersNote` in `el`), `style.css` (`.users-note`)
- **Evidence:** `el.usersNote` is never read or written after the per-user chart learned to compare
  pages. The element is always hidden.
- **Suggested response:** delete the element, the `el` entry and the `.users-note` rule. Also fix the
  stale comment on `state.data` at `app.js:28` ("the per-user chart shows page 1 for now"). It's still
  used for page-1 defaults, but the comment is no longer true.

### Unused CSS custom properties
- **Where:** `style.css:12-13`, `37-38`, `59-60` (`--series-1-hover`, `--series-1-wash`)
- **Evidence:** neither is referenced in `style.css` or `app.js` (`css('--…')`). The hover colour
  stopped being used when the columns became one per page.
- **Suggested response:** delete both, in all three token blocks.

### `sortUsers` import no longer used in the page
- **Where:** `app.js:2`
- **Evidence:** the only occurrence in `app.js` is the import. Sorting now goes through `sortCombined`.
  `sortUsers` is still used inside `lib/core.js` (by `recordHolders`).
- **Suggested response:** drop it from the import list. Keep the function in core.

### `fmtDateTime` exported but never used
- **Where:** `lib/core.js:370`
- **Evidence:** no caller anywhere since dates in the user list were cut to `YYYY-MM-DD` and the
  Created line went date-only.
- **Suggested response:** delete.

### `.gitignore` still ignores the CLI's output folder
- **Where:** `.gitignore` (`out/`)
- **Evidence:** `out/` was where `--csv` wrote files. The CLI has been deleted.
- **Suggested response:** delete the line.

(Checked and kept: the `t-row` class flagged by the scanner is built in a template string at
`app.js:670`. The `--page-1..3` variables are read as `` var(--page-${n}) ``. `htmlToText`'s
non-DOM branch and `fetchRevisions`' `userAgent` option exist so `lib/core.js` can be imported from
Node for testing, which the file header documents. Keep all of these.)

## Duplicates that could be merged

### Single-page and multi-page CSV exports are written twice
- **Where:** `lib/core.js:444` `timelineCsv` and `app.js:766` `comparisonCsv`; `lib/core.js:451`
  `usersCsv` and `app.js:788` `comparisonUsersCsv`
- **Evidence:** each pair builds the same columns, one for a single page and one with per-page
  prefixes. They have already drifted: the single-page timeline CSV has `edits_per_editor`, but the
  comparison one doesn't.
- **Suggested response:** keep one timeline function and one users function in `lib/core.js`, each
  taking the list of pages. With one page, leave out the `Title:` prefix. Delete the other two.
  Effort: small.

### Same palette colour defined twice under two names
- **Where:** `style.css:11` `--series-1: #2a78d6` and `style.css:19` `--page-1: #2a78d6` (and both
  dark blocks); `--recent-text` (`style.css:199-201`) repeats `--series-1-hover`'s hex values
- **Evidence:** identical hexes in every theme block, so a palette change has to be made twice.
- **Suggested response:** make `--page-1` the source of truth and set `--series-1: var(--page-1)`, or
  the reverse. Set `--recent-text` from the same ramp variable, not a copied hex. Effort: small.

### Theme tokens split across extra `:root` blocks
- **Where:** `style.css:199-201` (`--bot-text`, `--recent-text`, `--creator-text`) in their own
  `:root` / dark-media / `data-theme` trio, appended after the main token blocks at the top
- **Evidence:** the scanner flags `:root`, `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`
  as each defined twice. Repeating the dark values in the media-query block and the `data-theme`
  block is deliberate: it's the theming contract, so keep that pattern.
- **Suggested response:** move the three name colours into the existing token blocks at the top of
  the file, so each theme is defined in one place. Effort: small.

### Same selector restyled in separate rules
- **Where:** `.controls` at `style.css:90` and `122`; `.summary` at `121` and `234`; `.sort-controls`
  at `159` and `207`; the user-list column widths `84px 84px 96px` at `163` and `250`
- **Evidence:** later rules were appended instead of edited in place. The rules don't conflict yet,
  but each element is styled in two places.
- **Suggested response:** fold each pair into one rule. Put the user-list column widths in a single
  custom property, e.g. `--u-cols: 84px 84px 96px minmax(80px, 1fr)`. Effort: small.

### Time-unit lengths defined in both files
- **Where:** `app.js:457` `APPROX = { hour: 36e5, day: 864e5, … }`, `lib/core.js:9` `APPROX_MS`;
  `app.js:10` `RECENT_MS = 7 * 864e5` next to core's `DAY`
- **Evidence:** the same five unit lengths, written differently in two places.
- **Suggested response:** export `DAY` and `APPROX_MS` from `lib/core.js` and use them in `app.js`.
  Effort: small.

## Design patterns worth changing

### `app.js` is a 975-line file doing five jobs
- **Where:** `app.js`, covering search boxes and loading (`lookupAll` at 114), summary and controls
  (`renderAll` at 260), canvas charts (`drawTimeline` at 483), chart interaction and the tooltip
  (`setHover` at 650), the user list (`renderUsers` at 808) and URL state (`syncUrl` at 936)
- **Evidence:** the scanner flags it as very long. The sections share the module-level `state`, `tl`,
  `users` and `pageUsers`.
- **Suggested response:** split along the existing section comments into `search.js`, `charts.js`,
  `users.js` and `url.js`, with `app.js` owning `state` and passing it in. No behaviour change.
  Effort: large (needs a plan). It's worth doing before the next big feature.

### Chart colours are looked up again and again on every redraw
- **Where:** `app.js:419` `css()`, about 18 call sites in the draw functions
- **Evidence:** `getComputedStyle(...)` runs for every colour on every pointer move. With three pages
  at the hour level there are thousands of columns, and `pageColor(...)` is called for each one.
- **Suggested response:** read all the colours once per draw (or once per theme change) into a
  `palette` object, and pass that to `drawTimeline` and `drawWords`. Effort: small.

### Language code inserted into HTML without escaping
- **Where:** `app.js:293` (`pageUrl`), `app.js:302`, `app.js:882`
- **Evidence:** `page.lang` comes from the `lang` URL parameter or the Wiki field and goes into
  `innerHTML` and `href` as-is. In practice it's harmless, because nothing renders unless
  `https://<lang>.wikipedia.org` answered, which limits it to valid hostname characters.
- **Suggested response:** validate `lang` once against `/^[a-z0-9-]+$/` in `parsePageInput` and when
  reading the URL, then rely on that. Effort: small.

## Docs and data hygiene

### README describes some features as they were before comparison and word counts
- **Where:** `README.md:3` ("Edit history of a Wikipedia page"), `README.md:8` (sort list omits
  Duration), `README.md:27` ("The page-size chart"; it's now the ~word count chart),
  `README.md:51` (URL parameter list is missing `page2`, `page3`, `lang2`, `lang3` and `by`)
- **Evidence:** compared with the current UI and `syncUrl` (`app.js:936`).
- **Suggested response:** update those four places. Split the long "Compare pages" bullet into
  "timeline" and "per-user chart" bullets. Effort: small.

### README never gives the live site URL
- **Where:** `README.md` "Deploying to GitHub Pages"
- **Evidence:** the live page is https://cshirky.github.io/readWikiHistory/, but the README only gives
  generic setup steps.
- **Suggested response:** add the live URL (and an example comparison link) near the top. Effort: small.

## Next steps
1. Delete the leftovers: the users-note element, the two unused CSS variables, the `sortUsers` import,
   `fmtDateTime` and `out/` in `.gitignore`. All are small, with no behaviour change.
2. Merge the CSV exporters into one function per kind in `lib/core.js`. This also fixes the missing
   `edits_per_editor` column in comparison CSVs.
3. Tidy `style.css`: one rule per selector, one token block per theme, and `--page-1` as the single
   blue.
4. Bring the README up to date and add the live URL.
5. Before the next large feature, split `app.js` into modules along its section comments.

- `/simplify app.js lib/core.js style.css` would apply findings 1–3 here.
- `/code-review app.js` is worth running for a bug hunt in the multi-page paths: `lookupAll` and
  `loadAll`, and the anchor and `per[]` handling in `renderUsers`, `nameCell` and `userRow`. These
  were added quickly and have only been checked with screenshots, since the headless browser can't
  hover.
