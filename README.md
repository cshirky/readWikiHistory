# readWikiHistory

Charts the edit history of a Wikipedia page, or compares up to five pages side by side: when they
were edited, how big they grew, and who edited them.

**Live:** https://cshirky.github.io/readWikiHistory/
(example comparison: https://cshirky.github.io/readWikiHistory/?page=Elinor%20Ostrom&page2=Oliver%20E.%20Williamson&page3=Douglass%20North)

It's a static page with no dependencies and no build step. Revision data comes straight from the
[MediaWiki API](https://www.mediawiki.org/wiki/API:Revisions) in your browser, so there's no server.

## What it shows

**Page summary.** Once loaded, each search box turns into its page's full Wikipedia URL (a link),
followed by its whole-history editor counts in two groups: edits by logged-in users, and edits by
bots, IP addresses and hidden usernames. Each group has its average (mean) edits per editor. Under
that: creation date, the article's age (years and months, or months and days if under a year), and
its current approximate word count to the nearest 100. A note explains that the median and mode are
left out because they're 1 on nearly every page, and names any page here where they aren't.
**Change** brings the search box back. The page heading links to the live site.

**Edit timeline.**
- A column chart of edits per hour, day, week, month or year.
- A line overlaid on the columns shows the page's approximate word count at the end of each period,
  read on the right-hand axis. **Hide word count** / **Show word count** toggles it.
- Hovering a period shows edits, editors (with subtotals for bots, IP addresses and hidden
  usernames), average edits per editor, and the word count.
- A table view and a CSV download hold the same numbers.

**Edits per user.**
- One row per editor, with first edit, last edit, duration and an edits bar.
  - Duration is the time from first to last edit in years, months and days, rounded up to a whole
    day. A single edit counts as 1 day.
- The header shows the number of editors in the selected range (with bot, IP and hidden-username
  subtotals for one page, or how many edited 2+ and all pages when comparing).
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
- **Logged-in users only** hides bots, IP addresses and hidden usernames; **Bots only** shows just
  bots. Ticking one unticks the other. They combine with Show when comparing, whose counts follow
  them, and the CSV download follows both.
- Rows load as you scroll. There's a CSV download.

## Using it

- **Find a page:** enter a title or paste a Wikipedia URL. The Language list beside each search box
  picks that page's Wikipedia (`en`, `de`, …); a pasted URL sets it for you. A new box starts with
  page 1's language.
- **Disambiguation:** if a title is a disambiguation page (e.g. "Mercury"), a dropdown lists the
  articles it links to, grouped under the page's own headings. The disambiguation page itself is the
  last option. If no page has that title, the dropdown lists search results instead.
- **Compare pages:**
  - The "Compare to 1–4 additional pages or languages" list sets how many search boxes there are, up
    to five pages in all. Lowering it drops empty boxes first, then the last ones. × removes one box.
  - To compare languages, enter the same title in two boxes and pick a different language in each.
    When the pages span more than one language, labels add the language code, e.g. "Elinor Ostrom (de)".
  - Each page keeps a colour: page 1 blue, page 2 orange, page 3 aqua, page 4 yellow, page 5 magenta.
  - The column chart puts the pages' columns side by side in each period, and the word-count overlay draws
    one line per page. The hover shows the pages in columns.
  - The per-user chart lists every editor of any of the pages. Each name gets one line per page
    they edited, labelled with the page's name and coloured bullet: the sort page's line first,
    then the others in page order. All bars share one scale.
  - Under the name of anyone who edited more than one page: their rank by edits on each of those
    pages, e.g. "#6 of 282 on Elinor Ostrom". Ties share a rank.
  - In a Total edits sort, the sort page's line shows only its bullet, and its rank line is left
    out because the row number gives it. With Show or a checkbox filtering the list, that rank line
    comes back.
  - **Sort using**, above the chart, picks which page drives the sort and the name marks (page 1 by
    default). Users who never edited that page go last. Each page's creator is tagged on that
    page's line.
  - **Show** picks All editors, Edited 2+ pages, or (with three or more pages) Edited all pages,
    each with its count. The heading line also reports both counts. The CSV download follows it.
- **Time range and granularity:**
  - The range runs from creation (the earliest page's, when comparing) to now.
  - **Auto** picks the finest unit that gives at most 300 periods, divided by the number of pages.
  - Units that would need more than 4,000 periods are greyed out until you narrow the range.
  - To zoom, drag across a chart or set From/To. **Full history** resets.
  - Clicking a column opens that page’s history on Wikipedia in a new tab, starting at the beginning
    of the period (when comparing, the nearest page’s column; the hover says which).
  - The per-user chart follows the selected range.
- **Links:** the address keeps the whole view, so a copied link reopens it:

  | Parameter | Meaning |
  |---|---|
  | `page`, `page2` … `page5` | page titles |
  | `lang`, `lang2` … `lang5` | wiki language (`lang2` and later only when they differ from `lang`) |
  | `from`, `to` | range, UTC, as `YYYY-MM-DDTHH:MM` |
  | `g` | `hour`, `day`, `week`, `month` or `year` (omitted for Auto) |
  | `sort`, `dir` | `edits`, `first`, `last` or `duration`; `asc` or `desc` |
  | `by` | `2` to `5` to sort the per-user chart using that page |
  | `who` | `people` (logged-in users only) or `bots` (bots only) |
  | `show` | `shared` (edited 2+ pages) or `every` (edited all pages); older links' `common=1` means `every` |

## Notes on the numbers

- All times are UTC. Weeks start on Monday.
- **~Word count** is the page size in bytes divided by 6, rounded to the nearest 100, after the last edit at or before the end of
  the period. It carries forward through periods with no edits. It's rough: wikitext markup and
  references count toward the bytes.
- Edits with suppressed usernames can't be told apart, so they're grouped as one
  "(username hidden)" editor.
- Heavily edited pages (50,000+ revisions) take a while: the API returns 500 revisions per request.
  Each page is downloaded once per visit, so switching or removing compared pages is instant.

## Running and deploying

```sh
npm run serve            # python3 -m http.server 8000
# open http://localhost:8000/?page=Elinor%20Ostrom
```

GitHub Pages serves the `main` branch root, so pushing to `main` deploys the site.

| File | What's in it |
|---|---|
| `index.html` | page structure |
| `app.js` | search boxes, loading, charts, hover, per-user list, URL state |
| `lib/core.js` | data layer: API calls, disambiguation, time bins, per-user stats, CSV. No DOM except disambiguation parsing, so it can be imported from Node for testing. |
| `style.css` | theme tokens (light and dark) and layout |
