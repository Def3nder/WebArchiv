# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

WebArchiv is a self-hosted reading archive for German-language articles. The content lives as
plain Markdown files under `www/<Autor>/...` (with optional sibling image/audio/video/PDF files);
a Node/Express server indexes them in memory and serves a single-page vanilla-JS frontend.
There is no database and no build step — the Markdown tree *is* the data store. UI strings,
code comments, and content are German.

## Commands

```bash
npm install            # install deps (express, marked, fuse.js, express-session, bcryptjs, sharp)
npm start              # run server.js → http://localhost:3000 (PORT env overrides)
npm run dev:fixture    # same app on the test archive (test/fixtures/smoke-archive.cjs) → :3100, logins printed
npm test               # run all Node and Python tests from the test/ directories
node scripts/hash-passwords.js   # hash plaintext passwords in users.json (see Auth below)
```

Tests are organized under `test/`, `scraper/test/`, `epub-tool/test/`, `tts/test/`, `duplicates-tool/test/`,
and `tts-server/test/`. WebArchiv-side Node modules live under `tts/`; the separate
Qwen model server, its launch helpers, and its Python tests live under `tts-server/`.
`npm test` runs `npm run lint` first: ESLint (`eslint.config.js`) with only `no-undef`, `no-unused-vars` and
`no-redeclare` over the Node code (server, `lib/`, `modules/`, `scripts/`, tests, sub-packages) and `public/`. The
module type is set per folder there (ESLint ignores `"type"` in package.json); a leading `_` marks intentionally
unused parameters. Browser scripts: each classic script knows the shared names of the others, collected from the
source by `test/support/browser-globals.cjs` (no hand-kept list); redeclaring one of them or a browser global
(`open`, `close`, `reportError` …) fails. Code inside the esbuild bundles is *not* global — expose what classic
scripts call via `window.X` (e.g. `window.leaveArticleEditor`). `test/browser-globals.test.cjs` catches dead shared
names and names declared twice in one shell. `test/fixture-archive.test.cjs` builds the test archive from
`test/fixtures/smoke-archive.cjs` (~40 cases: media, infographic groups, Instagram posters, duplicates incl. moving
their graphics, access, audiobooks, the infographic badge (`displayAuthor`), the scraper center with its own
`SCRAPER_DIR` data — each with purpose and expected results) in a temp dir and runs the real
`server.js` on it as a child process (`WWW_DIR`/`AUDIO_DIR`/`CONFIG_FILE`, port 0, CSP enforced); a new combination of
articles, infographics or duplicates gets a case there. `npm run test:browser` (not part of `npm test`, ~10 s) runs
`test/browser/smoke.test.cjs` with Playwright/Chromium on the same archive: login, tiles and badges, full-text toggle,
article keys and gallery, bookmarks, duplicate redirect, dialogs on the layer stack (closed dialogs must be
invisible), audiobook playback; `test/browser/mobile.test.cjs` adds a Pixel-7 touch profile with real swipes via the
DevTools protocol (swipes beside/inside dialogs must not reach the page, a self-scrolling dialog still scrolls,
pull-to-close, 16px inputs, iPhone `maximum-scale`). Any console error or CSP violation fails. Run it after frontend
changes. Chromium is not iOS Safari: auto-zoom and rubber-banding themselves are only checked on a real iPhone. There
is no build. `node server.js` is the only runtime; restart it to
pick up server-code changes. Article changes under `www/` and `audio/` are picked up automatically by the file watcher
(`lib/archive-watcher.cjs`: 5 s quiet, then a cached rescan via `archiveLock.whenIdle`; off with `WATCH_ARCHIVE=0`),
otherwise by `SIGHUP`, the admin reindex button (`POST /api/reindex`, reads fresh) or a restart. Frontend changes (`public/`) only need a browser reload;
the server appends `?v=<content hash>` to every local `<script>`/`<link>` in `public/index.html`
automatically (`createVersionedIndex` in `lib/app-shell.cjs`) — never add `?v=` numbers by hand, and tests
must not pin versions.
The separately deployed Qwen model service is the exception: its Python runtime and all
server-side files are isolated under `tts-server/` and never run as part of `server.js`.

## Architecture

**Backend: `server.js` + `lib/` + `modules/`** (layout enforced by `test/code-rules.test.cjs`; no `.cjs` in the root).

- **`server.js`** holds the state and the wiring: the index state in the `archive` object (`articles`,
  `sourceArticles`, `articleById`, `infographicGroups`, `groupAnchorOf`, `duplicateCanonicalOf`, `duplicateCandidates`,
  `meta`, `fuseIndex`), stores, sessions, the lock, index build/partial reindex, `canAccessAuthor`,
  `duplicateCanonicalFor`, login/session middleware and the reindex routes. Every reindex replaces the fields of
  `archive`, so code that gets `archive` reads `archive.articleById` at call time and never keeps a map from install time.
- **`lib/`** — pure helpers without routes, usable from scripts and tests without starting the server; `lib/` never
  imports `modules/` or `server.js`: `article-parser.cjs` (`parseArticle`, date/search parsing, taxonomy),
  `infographics.cjs` (`linkInfographics`, naming, header editing, `moveInfographicFiles`), `archive-files.cjs` (directory
  cache, `findSibling`, file URLs, `isPathInside`, `resolveUnder`, `yearFromRelativeDir` — the only path-containment
  checks; never write `startsWith(root + path.sep)`), `article-index.cjs` (Fuse index, list helpers for partial reindex,
  scraper manifest), `app-shell.cjs` (PWA version, stat-based file caches for `index.html` and the service-worker
  version), `article-body-cache.cjs` (rendered article bodies by path, invalidated by size/mtime, LRU), `taxonomy.cjs`
  (filter categories), `session-file-store.cjs` (sessions survive restarts in `sessions.json`, gitignored; only when
  `server.js` runs as main module), `http-errors.cjs` (`httpError`, `apiError`, `jsonRoute`, `isCrossSite`,
  `sendApiError` — API errors are `{ error: <German message>, code? }`; the frontend reacts only to `code`, never to
  message text), `atomic-file.cjs` (`writeFileAtomic`, `writeJsonAtomic`, `writeFileAtomicSync`, `createJsonFile`),
  `share-ids.cjs` (short share ids), `new-article.cjs` (author and readable file name of a new own article), `article-scan.cjs` (the scan: `parseArticleContent` depends only on the `.md`
  content, `articleMedia` only on directory listings; entries carry an internal `fileSignature`; unreadable files are collected as `scanIssues`
  instead of being dropped silently), `index-cache.cjs`
  (persistent cache of the parse part per file signature in `index-cache.json`, gitignored; its version hashes the parser
  sources and the duplicate authors, so changing e.g. taxonomy keywords invalidates it — no manual bump needed; a full
  rescan that finds nothing changed publishes nothing (`sameSourceArticles`), the admin reindex button reads everything
  fresh via `buildIndex({ fresh: true })`), `fulltext.cjs` (full-text search without an index: every entry carries an
  internal, cached `searchText` — folded title, summary and body; `/api/articles?fulltext=1` appends substring matches,
  also inside words, after the Fuse hits; ~15 ms over the whole archive), `event-log.cjs` (messages for the health check: captures `console.error`/`warn` when
  `server.js` runs as main module — journal output stays — plus `[ERROR]` lines from `scraper/scrape_all.log` and
  failures from `cron-scrape.log`, read incrementally; identical messages are grouped; persisted in
  `health-events.json`, gitignored), `archive-watcher.cjs` (debounced `fs.watch` on `www/` and `audio/`, one
  non-recursive watcher per directory — Node's recursive watch aborts on Linux at an unreadable `lost+found`; ignores
  dot files, `*.filepart`, `lost+found` and `Infografiken/trash/`), plus the lock, security and duplicate-detection modules (`archive-lock.cjs`,
  `login-limiter.cjs`, `html-sanitizer.cjs`, `security-headers.cjs`, `duplicates.cjs`, see below).
- **`modules/`** — feature modules with routes: a `create…` factory for their state plus `install…Routes(app, deps)`
  (`user-store`, `bookmarks`, `audiobooks`, `audiobook-extras`, `article-editor`, `media-files`, `scrape`,
  `duplicate-admin`, `infographic-admin`, `new-article`, `articles`, `link-preview`, `health`, `scraper-center`). They import from `lib/` (and sibling modules),
  get everything from `server.js` as `deps`, and nobody — scripts included — ever `require`s `server.js`.
- **Routes** use `jsonRoute` (no-store, same-site check for writes, generic message for unexpected errors); no own
  `try/catch` + `sendRouteError` wrappers. `httpError(status, message, extra)` adds fields to the error response,
  `apiError(code)` throws a fixed `{ error, code }`, `mapError` translates e.g. `ENOENT`/`EEXIST`, and a handler whose
  rollback failed attaches it as `error.rollbackError` and rethrows. Exclusive writes use `lock.run(label, task)`.
- Every file write uses `lib/atomic-file.cjs` — no hand-written temp+rename code (only `tts/` keeps its own helpers).
  New pure helpers belong in `lib/`, new route groups in `modules/`, not in `server.js`.

The index works in three phases:

1. **Index build (`buildIndex` → `scanDir` in `lib/article-scan.cjs` → `parseArticle`).** On startup (and on reindex) it
   recursively walks `www/`. Top-level dirs are *authors*; nested 4-digit dirs (`2018/`) are
   *years*. Each `.md` becomes an article object. Sibling media files matching the `.md`
   basename (`foo.md` + `foo.jpg`/`foo.mp3`/`foo.mp4`/`foo.pdf`) are attached; a per-author
   `standard.jpg` is the image fallback. The full article list, a `meta` object (authors/years/
   categories), and a Fuse.js fuzzy-search index are held in the `archive` object — all
   in-memory, rebuilt wholesale on reindex.

2. **Markdown parsing (`parseArticle`).** Articles have NO YAML frontmatter. Metadata is parsed
   heuristically from the first ~20 lines: title = non-empty lines before the `Datum:` line;
   then `Datum:`, `Audioquickie:` (episode number), `Kategorien:`, `Quelle:` (source URL), and a
   `Zusammenfassung:` block that runs until a `****`/`----` separator. Body = everything after the
   separator (or after the last metadata line). Markers are matched case-insensitively and
   tolerant of `**`/`*`/`_` wrappers. Dates are normalized to ISO `yyyy-mm-dd` from ISO/German/
   slash formats or the filename prefix. When changing the article format, `parseArticle` and the
   `prompts/` templates (which instruct the LLM that generates articles) must stay in sync.

3. **Auto-categorization (`lib/taxonomy.cjs`: `autoCategorize` + `TAXONOMY`).** Each article gets at most 3
   `categories` from weighted keywords matched against whole words (`stem` = word start, `=word` = exact,
   `*stem` = inside compounds, phrases with spaces); title hits count triple, a category needs a minimum
   score (grows with text length) and ≥35 % of the strongest one. Never add short or ambiguous substrings
   ("ehe", "würde", "sucht") as prefix keys. These drive the category filter and search. Note the distinction: `categories` = unified taxonomy labels used
   for filtering; `tags` = the raw `Kategorien:` field, display-only.

**Frontend: `public/` (no framework).** `index.html` is the shell, `app.js` is a hash-routed SPA
(`#/article/<id>` deep-links), `public/css/*.css` the styling. It talks only to the `/api/*` JSON
endpoints and renders cards, an article overlay, audio/video players, and an embedded PDF viewer
(`public/vendor/pdfjs/`). State (search query, filters, pagination, current user) lives in the `state`
object in `app.js`.

## Auth & access control

- **JSON stores** (bookmarks, audiobook progress, duplicate decisions) use `createJsonState` from
  `lib/atomic-file.cjs`: change state only via `state.update(draft => …)` — the new state is committed
  after the file write succeeded, updates run one after another. Never mutate `state.value` directly.
- **Runtime files are gitignored:** `config.json` (author priority, duplicates, audiobook skips) and
  `public-directories.txt` are written by the app; templates are `example-config.json` and
  `example-public-directories.txt` — never re-add the real files to git. `index-cache.json` is a pure cache: deleting
  it only makes the next start slower; `health-events.json` only holds the health-check messages.
  `scraper/scraper-config.json` (sources, written by the scraper center) and `scraper/scrape-status.json` (last 30
  runs per source, written by `scrape_all.js`) are runtime files too; template `scraper/example-scraper-config.json`.
  The scraper center (`modules/scraper-center.cjs`, helpers `lib/scraper-sources.cjs`) only ever reports the expiry
  of the Facebook login from `cookies.txt`, never cookie names/values. The health check shows that login and an hourly
  reminder (`createLoginReminder`, server main only) records an expired login as an error at most once a day, so
  the health notice reminds; expiring within 7 days is a warning.
- **Users** live in `users.json` (gitignored). Copy `example-users.json` → `users.json`, set
  plaintext `password` fields, run `node scripts/hash-passwords.js` to replace them with bcrypt
  `passwordHash`. Each user has `role` (`admin`/`user`) and `allowedAuthors`: `null` = all authors,
  or an array of author names = whitelist.
- **Guests (no session)** get the authors listed in `public-directories.txt` (JSON, key
  `public-directories`). If that list is empty, unauthenticated requests get 401.
- **Enforcement is per-author** via `canAccessAuthor`. It gates three layers that must stay
  consistent: the `/files/*` media handler, the `/api/articles` list (ACL pre-filter), and the
  single-article route (both in `modules/articles.cjs`). `/files/*` and `/audio-files/*` live in `modules/media-files.cjs`:
  `resolveMediaRequest` rejects `.`/`..` segments (also when sent encoded) and the author ACL is
  checked on that validated path — never check a raw first segment and resolve afterwards. Reuse
  it for any new file-serving route. `prompts/*` uses the same
  `path.basename` + prefix-check guard.
- The `Telegram` author is special-cased: hidden from listings unless `?telegram=1` or explicitly
  filtered by `author=Telegram`.
- **Health exception** (`modules/health.cjs`): `GET /api/health` is **intentionally unauthenticated** for external
  monitoring and returns only `{ status }` (`ok` 200, `starting`/`degraded` 503) — never counts, paths or messages.
  Everything else (`/api/health/details`, `/api/health/events`, `/api/health/events/clear`) is admin-only.
- **Share links** use a short `shareId` (`lib/share-ids.cjs`, 12 chars `[A-Za-z0-9_-]` from the id's SHA-256,
  sent with article and audiobook details): `/a/<shareId>`. Share paths such as WhatsApp decode `%20` back to a
  space and cut the link there. `/a/<full id>` keeps working for older links.
- **Link-preview exception** (`modules/link-preview.cjs`): `GET /a/<id>` (Open-Graph HTML for social crawlers, redirects humans
  to `#/article/<id>`) and `GET /og-image/<id>` (sharp-downscaled preview image) are **intentionally
  unauthenticated** — they expose title/description/image of *any* article to anyone with the link,
  by design. `/og-image/*` still enforces the same path-traversal guard as `/files/*`. `sharp` output
  is cached in-memory per file mtime.

## Content & data conventions

- `www/` article `.md` files and media are **gitignored** (see `.gitignore` — only `standard.jpg`
  placeholders and `bilder-zu-md.ps1` are tracked). The real archive is deployed/synced separately;
  do not expect article content in the repo.
- `prompts/*.txt` are LLM prompt templates exposed read-only via `/api/prompts`. Filename pattern
  `N_Label.txt`: the numeric prefix sets ordering and is stripped from the displayed label.
- Media URLs get a `?v=<mtime>` cache-buster (`fileUrl`) so a replaced image with the same name
  reloads in the browser.
- `www/bilder-zu-md.ps1` is a Windows helper that creates empty `.md` stubs next to images.

## Deployment

Target is a Proxmox/Debian LXC running the app under systemd (`/opt/nodeapp`), with the `www/`
data on an external mounted disk. See `session-context.md` and `LXC-container node.js Setup.md`
for the full setup log (SSH keys, systemd unit, mount/permission notes). HTTPS terminates at the
NPMplus reverse proxy (192.168.1.14). With `NODE_ENV=production` the server refuses to start without a
`SESSION_SECRET` of at least 32 chars. `TRUST_PROXY` (default `loopback, 192.168.1.14`) limits which
proxies may set `X-Forwarded-*`; `CSP_MODE` is `report` (default), `enforce` or `off`;
production runs `enforce` (since 30.10.2026), so new frontend code must work under the CSP (no inline handlers or
scripts without nonce, no external sources).

**Browser script forms (keep to these three, don't add a fourth):**
- *Shared classic scripts* (`touch-gestures.js` — loaded before `app.js`, generic touch helpers —, `app-gallery.js`
  (fullscreen viewer, image download), `app-media.js` (article audio/video/PDF, Media Session), `app-detail.js`
  (open/close article, bookmarks, `renderDetail`), `app.js`, `audiobooks.js`, `book-reader.js`, `duplicates.js`,
  `user-admin.js`, …). The `app-*.js` parts load before `app.js` and contain only declarations — no top-level code
  that touches `app.js` bindings at load time; tests read all parts via `test/support/read-app.cjs`:
  top-level functions/consts are deliberately shared across scripts via the global scope; load order in
  `index.html` matters. Only for code that genuinely shares state with `app.js`.
- *Encapsulated scripts* (IIFE or UMD like `aria-menu.js`, `session-state.js`, `admin-tasks.js`,
  `infographic-review.js`): the default for new browser code. Expose an explicit API (`window.X`,
  `adminHooks`, placeholder objects) instead of new globals; UMD when Node tests import the module.
- *ES modules only inside esbuild bundles* (`markdown-editors.js` → `vendor/article-editor.bundle.js`,
  `duplicate-diff.js`): only where npm packages (CodeMirror, diff) are needed; rebuild with `npm run build:*`.

**Stylesheets** live in `public/css/` (base, filters, cards, detail, dialogs, account, audiobooks,
duplicates, health and scraper-center [admin only], audiobook-extras), loaded in this order — the order is the cascade. Tests read all
of them via `test/support/read-styles.cjs`.

**Menus and admin code (frontend):** every dropdown/action menu uses `public/aria-menu.js`
(`WebArchivAriaMenu.create` / `bindSelect`) — no hand-written open/close/Escape/outside-click logic and no
`<details>` menus. Admin-only browser code goes into admin scripts (`data-admin-asset` in `index.html`
and listed in `ADMIN_ASSET_PATHS` in `server.js`); `public/admin-tasks.js` holds TTS, reindex, scrape and
log and plugs into `app.js` via `adminHooks` (empty for guests/users). `public/infographic-review.js` holds the
"Infografiken prüfen" mode and fills the `infographicReview` placeholder in `app.js`. `public/scraper-center.js` holds the
scraper center dialog (menu "Scraper-Zentrale"; runs and log still use the scrape window from `admin-tasks.js` via
`adminHooks.actions.scrape`/`scrape-source`/`log`). `public/health.js` holds the
health check (notice top right under the navigation chrome for new errors, dialog from `/api/health/details`) and chains
`adminHooks.userChanged`/`actions` instead of replacing them. The markdown editor toolbar
(`markdown-live-preview.js`, bundled — run `npm run build:editor` after changes) also uses `window.WebArchivAriaMenu`.
The ⋯ button of the audiobook extras is an inline disclosure (actions row), not a popup menu.

**Concurrent jobs:** all archive writes and index rebuilds go through the single lock in
`lib/archive-lock.cjs` (`archiveLock` in `server.js`). Jobs with their own state (reindex, scrape, editor,
TTS) are `register`ed once; new write routes run inside `jsonRoute` as `lock.run(label, task)` (a conflict becomes
409 with the running job's name) or check `lock.busy` and `throw lock.conflictError()`; only routes outside `jsonRoute`
(reindex) answer with `sendArchiveBusy(res, archiveLock)`. No `tryAcquire` in routes and never new hand-written
`x.running || y.running` checks. Internal partial reindexes triggered by the lock holder
do not acquire again. On shutdown `archiveLock.waitUntilIdle` waits up to 20 s for write jobs (not for the scraper,
reindex or TTS, which `ttsJobs.shutdown` cancels).

**Security modules:** `lib/login-limiter.cjs` (429 after repeated failed password checks on `/api/login`
and `/api/me/password`), `lib/html-sanitizer.cjs` (all markdown → HTML that reaches `innerHTML` must go
through `renderSafeMarkdown`), `lib/security-headers.cjs` (CSP; frontend must not use inline handlers like
`onerror=` — use `img[data-fallback]` / event listeners; new inline scripts need the per-response nonce).

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
