# readWikiHistory

Edit history of a Wikipedia page, shown two ways:

1. **Edit timeline**: a column chart of edits per hour, day, week, month, or year, with the page's
   byte count at the end of every period.
2. **Edits per user**: a bar chart of each editor's total edits, with the time of their first and
   last edit. You can sort it by total edits (the default), first edit, or last edit.

It's a static web page with no dependencies and no build step. The page code is in `app.js` and the
data code is in `lib/core.js`. Data comes live from the
[MediaWiki revisions API](https://www.mediawiki.org/wiki/API:Revisions). All times are UTC.

## Web page

```sh
npm run serve            # python3 -m http.server 8000
# open http://localhost:8000/?page=Clay%20Shirky
```

- Enter a title or paste a Wikipedia URL. Set the wiki language (`en`, `de`, …) if it isn't in the URL.
- If the title is a disambiguation page (e.g. "Mercury"), a dropdown lists the articles it links to,
  grouped by the page's own section headings. The disambiguation page itself is the last option.
  If no page has that title, the dropdown lists search results instead.
- By default the range runs from page creation to now. **Auto** picks the finest unit that gives at
  most 300 columns. A unit that would need more than 4,000 columns is greyed out until you narrow the range.
- **Zoom:** drag across either chart to select a range, or click a column to zoom into that
  period. You can also set the From/To fields. **Full history** resets the range.
- The per-user list has columns for user, first edit, last edit, duration and edits. Duration is the
  time from first to last edit in years, months and days, rounded up to a whole day; a single edit
  counts as 1 day. Names are blue if the user edited in the last 7 days.
- The per-user list loads more rows as you scroll. Its header shows the mean, median and mode of
  edits per editor. Bot accounts are shown in orange (blue wins if they edited recently) and tagged "bot". A bot is an account in
  Wikipedia's bot group, or any name ending in "bot".
- When the list is sorted by first or last edit, a name is **bold** if that user set a new high for
  total edits up to that point. Ties don't count as a new high. The user or users with the most
  edits in the page's whole history are underlined.
- The per-user chart follows the selected range. Click a column header or the sort buttons to sort by total edits, first edit, last edit or duration.
  Click the active sort again (or ↑/↓) to reverse the order.
- The page URL keeps your settings (`?page=…&lang=…&from=…&to=…&g=…&sort=…&dir=…`), so a link
  reopens the same view.
- Each chart has a CSV download, and the timeline has a table view.

### Deploying to GitHub Pages

Push this directory to a repo, then go to Settings → Pages → *Deploy from branch* → `main` / root.
Nothing needs to be built.

## Notes

- Bin boundaries are UTC. Weeks start on Monday.
- "Bytes at end" is the page size after the last revision at or before the end of the period. It carries
  forward through periods with no edits.
- Editors with suppressed usernames are grouped as "(username hidden)". IP editors are tagged.
- Very heavily edited pages (50k+ revisions) take a while to load. The API returns 500 revisions per
  request.
