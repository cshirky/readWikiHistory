# Handoff: what readWikiHistory taught us about Wikipedia data, 2026-11-08

Background for a new, larger project built on Wikipedia data. It records what is **not** obvious
from reading this repo's code. For the details, read `lib/core.js` (the reusable part, about 470
lines, no DOM except the disambiguation parser) and the README's "Notes on the numbers".

Repo: https://github.com/cshirky/readWikiHistory · local: `~/claude_projects/Wikipedia/history`
Live: https://cshirky.github.io/readWikiHistory/

## What this project is

A static page (no build, no dependencies, no server) that charts one page's edit history, or
compares up to five pages, possibly in different languages. Everything comes from the MediaWiki
Action API, called straight from the browser. GitHub Pages serves `main`, so a push deploys it.

## The MediaWiki API as we use it

- **Endpoint:** `https://{lang}.wikipedia.org/w/api.php`. Each language is a separate wiki with its
  own API, page IDs and bot list.
- **Always send** `format=json&formatversion=2&origin=*`.
  - `origin=*` is what allows anonymous CORS requests from a browser. Without it, requests fail.
  - `formatversion=2` gives `query.pages` as an array (read `pages[0]`), not an object keyed by ID.
- **Errors arrive with HTTP 200.** Check `data.error` and the page flags `missing` and `invalid`
  (with `invalidreason`), not just `res.ok`. `getJson()` in core.js does this.
- **Redirects:** pass `redirects=1`. The original title then shows up in `query.redirects[0].from`.

### Revisions (`fetchRevisions`)
- `action=query&prop=revisions&rvprop=ids|timestamp|user|size|flags&rvlimit=max&rvdir=newer`
- `rvlimit=max` means 500 revisions per request for anonymous clients. A page with 50,000+ edits
  takes 100+ sequential requests, so show progress. Paging uses `continue`: merge `data.continue`
  into the next request until it's absent.
- `rvdir=newer` returns the oldest revision first. The first revision gives the creation date and
  creator for free.
- We don't fetch content. `size` is bytes of wikitext. It is **null** on revisions whose content
  was deleted, so handle that. Word counts are estimated as bytes ÷ 6, which is rough because
  markup and references count toward the bytes.
- **Hidden users:** suppressed usernames come back with `userhidden` and no `user`. They can't be
  told apart, so we group them as one "(username hidden)" editor.
- **IP editors** have `anon: true`. Temporary accounts (Wikimedia is rolling these out in place of
  IP editing) are a newer wrinkle. We haven't handled them; check how they appear before counting
  "anonymous" editors.

### Bots (`fetchBotUsers`)
- No single flag marks a revision as made by a bot. We use two checks:
  1. accounts currently in the `bot` group (`list=users&usprop=groups`, 50 names per request);
  2. any name matching `/bot\b/i`, to catch retired bots that lost the flag.
- Only names containing "bot" are looked up at all, which keeps the number of requests small.
- This list is per wiki: a bot on enwiki may not be flagged on dewiki.

### Disambiguation and search (`resolvePage`)
- Check `prop=pageprops&ppprop=disambiguation` first. If the page is a disambiguation page, fetch
  its HTML with `action=parse&prop=text`. Then walk the links, grouping them under the page's own
  H2/H3 headings and skipping see-also, navboxes, red links (`.new`) and interwiki links (`.extiw`).
  This parser uses `DOMParser`, so it runs in a browser only.
- Missing title: fall back to `list=search&srnamespace=0&srlimit=25` and offer the results.

### Cross-language
- Usernames are global (single user login, SUL), so merging editors by name across language
  editions works.
- Page titles differ by language. We have the user type the title in each box; we never looked
  titles up through `langlinks`. A larger project likely wants `prop=langlinks`, or Wikidata
  sitelinks, to map one article across languages.

### Etiquette and headers
- Browsers can't set `User-Agent`. Wikimedia asks browser clients to send an `Api-User-Agent`
  header instead. core.js only sets `User-Agent` when the deleted command-line tool passed one in,
  and the web page sends neither.
- **For the new project:** any server, script or bulk job must send a descriptive User-Agent with
  a contact address, keep requests sequential (no parallel floods), and back off on `maxlag`/429.
- Choose a contact address deliberately; don't default to a personal email.

## When the new project outgrows per-page API calls

This project never needed more than a handful of pages, so we didn't evaluate these. They are
leads to check, not tested advice:
- Wikimedia Analytics/REST APIs for pageviews and edit counts.
- XML dumps and the analytics "history" dumps, for bulk revision history.
- Wikidata, for cross-language identity and structured facts.
- Quarry or the Toolforge database replicas, for SQL over replicated wiki tables.

## Design and engineering habits worth keeping

- **No build step:** ES modules, with a `lib/core.js` of pure functions (fetching plus data shaping)
  kept separate from `app.js` (DOM and charts). That split let the logic run under Node and in
  tests. In a bigger project, keep core logic free of the DOM from day one.
- **State in the URL:** every view can be shared as a link (`page`, `page2`… `lang2`…, `from`, `to`,
  `g`, `sort`, `dir`, `by`, `common`). Parameters left at their defaults are omitted from the URL,
  and links stay compatible as features are added.
- **Load handling:** histories are cached per session by `lang|title`, so adding, removing or
  re-sorting pages never refetches. Each new load aborts the one still running (`AbortController`).
- **Canvas for charts:** at thousands of bins, canvas beats SVG. Hover, tooltips and a table view
  plus a CSV download cover accessibility.
- **Times are UTC everywhere.** Weeks start on Monday. "Auto" granularity picks the finest unit
  that gives ≤300 bins (divided by the number of pages). Units over 4,000 bins are disabled.

### Colour
- Colours come from the `dataviz` skill's validated categorical palette, in fixed order:
  blue, orange, aqua, yellow, magenta (then green, violet, red).
  - Each slot has separate light and dark values. Dark mode is declared both under
    `prefers-color-scheme` and under `[data-theme="dark"]`.
- Colour follows the entity, never its rank: page 2 stays orange when page 1 is removed.
- The palette is validated for **adjacent** pairs (bars, lines). For scatter plots, maps or other
  all-pairs views, only the first three colours are safe. Beyond that, fold series into "Other" or
  split into small multiples.

## Testing setup that worked

- Serve with `python3 -m http.server 8000`, then open http://localhost:8000/.
- Headless checks used Playwright, installed in the session scratchpad rather than the repo, with
  a cached Chromium. Load a URL with state, wait for `#results:not([hidden])`, read the DOM, take
  a screenshot, and also run at 375px width to catch phone overflow. This caught real layout bugs
  that reading the code missed.

## Mistakes to avoid

- `app.js` grew to about 1,000 lines through fast iteration. The 2026-11-03 project review (in
  this folder) found leftovers from abandoned stages and duplicated one-page and multi-page code
  paths. For a bigger project, decide early how modules are split, and generalise to N items from
  the start rather than special-casing "page 1".
- Single-language assumptions spread quietly. Labels needed language codes once the same title
  could appear twice. Treat `(lang, title)` as the identity of a page everywhere.
