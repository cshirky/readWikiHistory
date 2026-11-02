# readWikiHistory

Edit history of a Wikipedia page, shown two ways:

1. **Edit timeline**: a column chart of edits per hour, day, week, month, or year, with the page's
   byte count at the end of every period.
2. **Edits per user**: a bar chart of each editor's total edits, with the time of their first and
   last edit. You can sort it by total edits (the default), first edit, or last edit.

It comes as a static web page (GitHub Pages ready) and a Node command-line tool. Both use the same
data code in `lib/core.js`. There are no dependencies and no build step. Data comes live from the
[MediaWiki revisions API](https://www.mediawiki.org/wiki/API:Revisions). All times are UTC.

## Web page

```sh
npm run serve            # python3 -m http.server 8000
# open http://localhost:8000/?page=Clay%20Shirky
```

- Enter a title or paste a Wikipedia URL. Set the wiki language (`en`, `de`, …) if it isn't in the URL.
- By default the range runs from page creation to now. **Auto** picks the finest unit that gives at
  most 300 columns. A unit that would need more than 4,000 columns is greyed out until you narrow the range.
- **Zoom:** drag across either chart to select a range, or click a column to zoom into that
  period. You can also set the From/To fields. **Full history** resets the range.
- The per-user chart follows the selected range. Click a column header or the sort buttons to sort.
  Click the active sort again (or ↑/↓) to reverse the order.
- The page URL keeps your settings (`?page=…&lang=…&from=…&to=…&g=…&sort=…&dir=…`), so a link
  reopens the same view.
- Each chart has a CSV download, and the timeline has a table view.

### Deploying to GitHub Pages

Push this directory to a repo, then go to Settings → Pages → *Deploy from branch* → `main` / root.
Nothing needs to be built.

## Command line

Requires Node 18+.

```sh
node cli/readWikiHistory.js "Clay Shirky"
node cli/readWikiHistory.js https://en.wikipedia.org/wiki/Ada_Lovelace -g year
node cli/readWikiHistory.js "Ada Lovelace" -s 2015-12 -e 2015-12 -g day --sort first -n all
node cli/readWikiHistory.js "Ada Lovelace" --json > ada.json
node cli/readWikiHistory.js "Ada Lovelace" --csv out/      # writes out/timeline.csv, out/users.csv
npm link   # optional: installs a `readWikiHistory` command
```

Run `--help` for every option. When you pass `--start`, the CLI fetches only that range. It also
fetches one revision from just before the start, so the byte count is right from the first period.

## Notes

- Bin boundaries are UTC. Weeks start on Monday.
- "Bytes at end" is the page size after the last revision at or before the end of the period. It carries
  forward through periods with no edits.
- Editors with suppressed usernames are grouped as "(username hidden)". IP editors are tagged.
- Very heavily edited pages (50k+ revisions) take a while to load. The API returns 500 revisions per
  request.
