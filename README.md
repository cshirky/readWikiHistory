# readWikiHistory

Charts the edit history of a Wikipedia page, or compares up to three pages side by side: when they
were edited, how big they grew, and who edited them.

**Live:** https://cshirky.github.io/readWikiHistory/
(example comparison: https://cshirky.github.io/readWikiHistory/?page=Clay%20Shirky&page2=Cory%20Doctorow&page3=Yochai%20Benkler)

It's a static page with no dependencies and no build step. Revision data comes straight from the
[MediaWiki API](https://www.mediawiki.org/wiki/API:Revisions) in your browser, so there's no server.

## What it shows

**Page summary.** For each page: its wiki, edit and editor counts, creation date, how long after
Wikipedia's launch it was created, how long ago that was, and its current approximate word count.

**Edit timeline.**
- A column chart of edits per hour, day, week, month or year.
- Below it, a line chart of the page's approximate word count at the end of each period.
- Hovering a period shows edits, editors (with subtotals for bots, IP addresses and hidden
  usernames), average edits per editor, and the word count.
- A table view and a CSV download hold the same numbers.

**Edits per user.**
- One row per editor, with first edit, last edit, duration and an edits bar.
  - Duration is the time from first to last edit in years, months and days, rounded up to a whole
    day. A single edit counts as 1 day.
- The header shows totals with bot, IP and hidden-username subtotals, plus the mean, median and mode
  of edits per editor.
- Sort by total edits (the default, most first), first edit, last edit or duration. Click the active
  sort, or ↑/↓, to reverse it.
- Name marks:
  - **Green:** the page's creator, also tagged "creator".
  - **Blue:** edited in the last 7 days.
  - **Orange:** a bot, also tagged "bot". A bot is an account in Wikipedia's bot group, or any name
    ending in "bot".
  - A name gets one colour: green beats blue, and blue beats orange.
  - IP editors are tagged "IP".
- In the first-edit and last-edit sorts:
  - **Bold:** the user set a new high for total edits up to that point. Ties don't count.
  - **Underlined:** the user with the most edits in the page's whole history.
- Rows load as you scroll. There's a CSV download.

## Using it

- **Find a page:** enter a title or paste a Wikipedia URL. Set the Wiki field (`en`, `de`, …) for
  other languages; a pasted URL sets it for you.
- **Disambiguation:** if a title is a disambiguation page (e.g. "Mercury"), a dropdown lists the
  articles it links to, grouped under the page's own headings. The disambiguation page itself is the
  last option. If no page has that title, the dropdown lists search results instead.
- **Compare pages:**
  - "Compare another page" and "Compare two other pages" add search boxes, up to three pages in all.
    × removes one.
  - Each page keeps a colour: page 1 blue, page 2 orange, page 3 aqua.
  - The column chart puts the pages' columns side by side in each period, and the line chart draws
    one line per page. The hover shows the pages in columns.
  - The per-user chart lists every editor of any of the pages. Each name gets one line per page
    they edited, marked with that page's coloured bullet: the sort page's line first, then the
    others in page order. All bars share one scale.
  - **Sort using**, above the chart, picks which page drives the sort and the name marks (page 1 by
    default). Users who never edited that page go last. Each page's creator is tagged on that
    page's line.
  - **Only show users common to all pages** hides anyone who didn't edit every page in the range.
    The CSV download follows it.
- **Time range and granularity:**
  - The range runs from creation (the earliest page's, when comparing) to now.
  - **Auto** picks the finest unit that gives at most 300 periods, divided by the number of pages.
  - Units that would need more than 4,000 periods are greyed out until you narrow the range.
  - To zoom, drag across a chart, click a column, or set From/To. **Full history** resets.
  - The per-user chart follows the selected range.
- **Links:** the address keeps the whole view, so a copied link reopens it:

  | Parameter | Meaning |
  |---|---|
  | `page`, `page2`, `page3` | page titles |
  | `lang`, `lang2`, `lang3` | wiki language (`lang2`/`lang3` only when they differ from `lang`) |
  | `from`, `to` | range, UTC, as `YYYY-MM-DDTHH:MM` |
  | `g` | `hour`, `day`, `week`, `month` or `year` (omitted for Auto) |
  | `sort`, `dir` | `edits`, `first`, `last` or `duration`; `asc` or `desc` |
  | `by` | `2` or `3` to sort the per-user chart using page 2 or 3 |
  | `common` | `1` to show only users common to all pages |

## Notes on the numbers

- All times are UTC. Weeks start on Monday.
- **~Word count** is the page size in bytes divided by 6, after the last edit at or before the end of
  the period. It carries forward through periods with no edits. It's rough: wikitext markup and
  references count toward the bytes.
- Edits with suppressed usernames can't be told apart, so they're grouped as one
  "(username hidden)" editor.
- "After Wikipedia launched" counts from English Wikipedia's launch on 2001-01-15, for every
  language edition.
- Heavily edited pages (50,000+ revisions) take a while: the API returns 500 revisions per request.
  Each page is downloaded once per visit, so switching or removing compared pages is instant.

## Running and deploying

```sh
npm run serve            # python3 -m http.server 8000
# open http://localhost:8000/?page=Clay%20Shirky
```

GitHub Pages serves the `main` branch root, so pushing to `main` deploys the site.

| File | What's in it |
|---|---|
| `index.html` | page structure |
| `app.js` | search boxes, loading, charts, hover, per-user list, URL state |
| `lib/core.js` | data layer: API calls, disambiguation, time bins, per-user stats, CSV. No DOM except disambiguation parsing, so it can be imported from Node for testing. |
| `style.css` | theme tokens (light and dark) and layout |
