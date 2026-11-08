# readWikiHistory

Static page (no build step) that charts a Wikipedia page's edit history, or compares up to five pages. Revision data comes from the MediaWiki API in the browser. See README.md for features and deploy details.

Run locally: `npm run serve`, then open http://localhost:8000/. Deploy: push to `main` (GitHub Pages).

## Status

- As of 2026-11-08: `main` is clean and in sync with origin. Latest work: per-user chart "Logged-in users only" / "Bots only" checkboxes.
- `NOTES/project-review-2026-11-03.md` lists cleanup debts (dead `users-note` element, unused CSS properties, duplicated one-page/multi-page code paths, `app.js` near 1,000 lines). It predates the five-page support, so recheck before acting on it.
- `NOTES/wikipedia-data-handoff.md` is background for a larger Wikipedia-data project.
- README examples use Elinor Ostrom (the "#6 of 282" rank example is illustrative, not a measured value).
