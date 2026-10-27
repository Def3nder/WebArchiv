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
npm test               # run all Node and Python tests from the test/ directories
node scripts/hash-passwords.js   # hash plaintext passwords in users.json (see Auth below)
```

Tests are organized under `test/`, `scraper/test/`, `epub-tool/test/`, `tts/test/`,
and `tts-server/test/`. WebArchiv-side Node modules live under `tts/`; the separate
Qwen model server, its launch helpers, and its Python tests live under `tts-server/`.
There is no linter or build. `node server.js` is the only runtime; restart it to
pick up server-code changes. Article changes are picked up by re-indexing (admin reindex button
→ `POST /api/reindex`, or restart). Frontend changes (`public/`) only need a browser reload;
the server appends `?v=<content hash>` to every local `<script>`/`<link>` in `public/index.html`
automatically (`createVersionedIndex` in `lib/app-shell.cjs`) — never add `?v=` numbers by hand, and tests
must not pin versions.
The separately deployed Qwen model service is the exception: its Python runtime and all
server-side files are isolated under `tts-server/` and never run as part of `server.js`.

## Architecture

**Backend: `server.js` + stateless modules in `lib/`.** `server.js` holds all module state (index,
stores, sessions, lock) and the routes; pure logic lives in `lib/` and can be required by scripts
and tests without starting the server: `article-parser.cjs` (`parseArticle`, date/search parsing,
taxonomy), `infographics.cjs` (`linkInfographics`, naming, header editing, `moveInfographicFiles`),
`archive-files.cjs` (directory cache, `findSibling`, file URLs, `isPathInside`, `resolveUnder`,
`yearFromRelativeDir` — the only path-containment checks; never write `startsWith(root + path.sep)`), `article-index.cjs`
(Fuse index, list helpers for partial reindex, scraper manifest), `app-shell.cjs` (PWA version, stat-based
file caches for `index.html` and the service-worker version), `article-body-cache.cjs` (rendered article
bodies by path, invalidated by size/mtime, LRU), `taxonomy.cjs` (filter categories), `session-file-store.cjs`
(sessions survive restarts in `sessions.json`, gitignored; only when `server.js` runs as main module),
`http-errors.cjs` (`httpError`, `jsonRoute`, `isCrossSite`), `atomic-file.cjs` (`writeFileAtomic`,
`writeJsonAtomic`, `writeFileAtomicSync`, `createJsonFile`). Never `require('./server.js')` from scripts — import from `lib/`.
Module routes use `jsonRoute` (no-store, same-site check for writes, generic message for unexpected errors);
every file write uses `lib/atomic-file.cjs` — no hand-written temp+rename code (only `tts/` keeps its own helpers).
New pure helpers belong in `lib/`, not in `server.js`. The index works in three phases:

1. **Index build (`buildIndex` → `scanDir` → `parseArticle`).** On startup (and on reindex) it
   recursively walks `www/`. Top-level dirs are *authors*; nested 4-digit dirs (`2018/`) are
   *years*. Each `.md` becomes an article object. Sibling media files matching the `.md`
   basename (`foo.md` + `foo.jpg`/`foo.mp3`/`foo.mp4`/`foo.pdf`) are attached; a per-author
   `standard.jpg` is the image fallback. The full article list, a `meta` object (authors/years/
   categories), and a Fuse.js fuzzy-search index are held in module-level variables — all
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
  `example-public-directories.txt` — never re-add the real files to git.
- **Users** live in `users.json` (gitignored). Copy `example-users.json` → `users.json`, set
  plaintext `password` fields, run `node scripts/hash-passwords.js` to replace them with bcrypt
  `passwordHash`. Each user has `role` (`admin`/`user`) and `allowedAuthors`: `null` = all authors,
  or an array of author names = whitelist.
- **Guests (no session)** get the authors listed in `public-directories.txt` (JSON, key
  `public-directories`). If that list is empty, unauthenticated requests get 401.
- **Enforcement is per-author** via `canAccessAuthor`. It gates three layers that must stay
  consistent: the `/files/*` media handler, the `/api/articles` list (ACL pre-filter), and the
  single-article route. `/files/*` and `/audio-files/*` live in `media-files.cjs`:
  `resolveMediaRequest` rejects `.`/`..` segments (also when sent encoded) and the author ACL is
  checked on that validated path — never check a raw first segment and resolve afterwards. Reuse
  it for any new file-serving route. `prompts/*` uses the same
  `path.basename` + prefix-check guard.
- The `Telegram` author is special-cased: hidden from listings unless `?telegram=1` or explicitly
  filtered by `author=Telegram`.
- **Link-preview exception:** `GET /a/<id>` (Open-Graph HTML for social crawlers, redirects humans
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
proxies may set `X-Forwarded-*`; `CSP_MODE` is `report` (default), `enforce` or `off`.

**Browser script forms (keep to these three, don't add a fourth):**
- *Shared classic scripts* (`touch-gestures.js` — loaded before `app.js`, generic touch helpers —, `app.js`,
  `audiobooks.js`, `book-reader.js`, `duplicates.js`, `user-admin.js`, …):
  top-level functions/consts are deliberately shared across scripts via the global scope; load order in
  `index.html` matters. Only for code that genuinely shares state with `app.js`.
- *Encapsulated scripts* (IIFE or UMD like `aria-menu.js`, `session-state.js`, `admin-tasks.js`,
  `infographic-review.js`): the default for new browser code. Expose an explicit API (`window.X`,
  `adminHooks`, placeholder objects) instead of new globals; UMD when Node tests import the module.
- *ES modules only inside esbuild bundles* (`markdown-editors.js` → `vendor/article-editor.bundle.js`,
  `duplicate-diff.js`): only where npm packages (CodeMirror, diff) are needed; rebuild with `npm run build:*`.

**Stylesheets** live in `public/css/` (base, filters, cards, detail, dialogs, account, audiobooks,
duplicates [admin only], audiobook-extras), loaded in this order — the order is the cascade. Tests read all
of them via `test/support/read-styles.cjs`.

**Menus and admin code (frontend):** every dropdown/action menu uses `public/aria-menu.js`
(`WebArchivAriaMenu.create` / `bindSelect`) — no hand-written open/close/Escape/outside-click logic and no
`<details>` menus. Admin-only browser code goes into admin scripts (`data-admin-asset` in `index.html`
and listed in `ADMIN_ASSET_PATHS` in `server.js`); `public/admin-tasks.js` holds TTS, reindex, scrape and
log and plugs into `app.js` via `adminHooks` (empty for guests/users). `public/infographic-review.js` holds the
"Infografiken prüfen" mode and fills the `infographicReview` placeholder in `app.js`. The markdown editor toolbar
(`markdown-live-preview.js`, bundled — run `npm run build:editor` after changes) also uses `window.WebArchivAriaMenu`.
The ⋯ button of the audiobook extras is an inline disclosure (actions row), not a popup menu.

**Concurrent jobs:** all archive writes and index rebuilds go through the single lock in
`archive-lock.cjs` (`archiveLock` in `server.js`). Jobs with their own state (reindex, scrape, editor,
TTS) are `register`ed once; new write routes use `archiveLock.tryAcquire(label)` + `release()` in
`finally` (or `archiveLock.run`) and answer conflicts with `sendArchiveBusy(res)` — never add new
hand-written `x.running || y.running` checks. Internal partial reindexes triggered by the lock holder
do not acquire again.

**Security modules:** `login-limiter.cjs` (429 after repeated failed password checks on `/api/login`
and `/api/me/password`), `html-sanitizer.cjs` (all markdown → HTML that reaches `innerHTML` must go
through `renderSafeMarkdown`), `security-headers.cjs` (CSP; frontend must not use inline handlers like
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
