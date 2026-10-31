# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
node scripts/hash-passwords.js   # hash plaintext passwords in users.json (see Auth below)
node scripts/make-favicons.js    # regenerate public/favicon.ico + apple-touch-icon.png from favicon.svg
node scripts/strip-infographic-categories.js [--dry-run]  # drop Kategorien: lines from infographic .md (backup in download/)
node scripts/migrate-audiobook-private.js [--dry-run]    # one-time: move private flags from audiobook-progress.json to audiobook-private.json
```

```bash
# EPUB → Markdown für Hörbuch-eBooks (eigenes Paket epub-tool/, eigene node_modules; nicht Teil der App)
node epub-tool/epub-to-md.js "Buch.epub" --out "audio/Hoerbuecher/<Buch>" [--dry-run] [--force]
npm test --prefix epub-tool
```

Run the complete Node and Python test suite with `npm test`. Tests live under
`test/`, `scraper/test/`, `epub-tool/test/`, `tts/test/` and `duplicates-tool/test/`. There is no linter or build.
`duplicates-tool/` is a dev-only app (not deployed) that reuses `lib/article-parser.cjs`, `lib/duplicates.cjs`,
`lib/html-sanitizer.cjs`, `lib/atomic-file.cjs` and the diff bundle — keep it working when changing those.
`node server.js` is the only runtime; restart it to
pick up server-code changes. Article changes are picked up by re-indexing (admin reindex button
→ `POST /api/reindex`, or restart). Frontend changes (`public/`) only need a browser reload;
the server appends `?v=<content hash>` to every local `<script>`/`<link>` in `public/index.html`
automatically (`createVersionedIndex` in `lib/app-shell.cjs`) — never add `?v=` numbers by hand, and tests
must not pin versions.

## Architecture

**Backend: `server.js`, `lib/` and `modules/`.** `server.js` holds all module state (index,
stores, sessions, lock), the wiring and the remaining routes; pure logic lives in `lib/` and can be required by scripts
and tests without starting the server: `article-parser.cjs` (`parseArticle`, date/search parsing,
taxonomy), `infographics.cjs` (`linkInfographics`, naming, header editing, `moveInfographicFiles`),
`archive-files.cjs` (directory cache, `findSibling`, file URLs, `isPathInside`, `resolveUnder`,
`yearFromRelativeDir` — the only path-containment checks; never write `startsWith(root + path.sep)`), `article-index.cjs`
(Fuse index, list helpers for partial reindex, scraper manifest), `app-shell.cjs` (PWA version, stat-based
file caches for `index.html` and the service-worker version), `article-body-cache.cjs` (rendered article
bodies by path, invalidated by size/mtime, LRU), `taxonomy.cjs` (filter categories), `session-file-store.cjs`
(sessions survive restarts in `sessions.json`, gitignored; only when `server.js` runs as main module),
`http-errors.cjs` (`httpError`, `jsonRoute`, `isCrossSite`, `sendApiError` — API errors are
`{ error: <German message>, code? }`; the frontend reacts only to `code`, never to message text), `atomic-file.cjs` (`writeFileAtomic`,
`writeJsonAtomic`, `writeFileAtomicSync`, `createJsonFile`); also the lock, security and duplicate-detection modules
(`archive-lock.cjs`, `login-limiter.cjs`, `html-sanitizer.cjs`, `security-headers.cjs`, `duplicates.cjs`, see below). Never `require('./server.js')` from scripts — import from `lib/`.
Module routes use `jsonRoute` (no-store, same-site check for writes, generic message for unexpected errors;
`httpError(status, message, extra)` adds fields to the error response, a handler whose rollback failed attaches
it as `error.rollbackError` and rethrows);
every file write uses `lib/atomic-file.cjs` — no hand-written temp+rename code (only `tts/` keeps its own helpers).
New pure helpers belong in `lib/`, not in `server.js`. Feature modules with routes live in `modules/`: a `create…`
factory for their state plus `install…Routes(app, deps)` (`user-store`, `bookmarks`, `audiobooks`, `audiobook-extras`,
`article-editor`, `media-files`, `scrape`, `duplicate-admin`, `infographic-admin`, `articles`, `link-preview`); they
import from `lib/`, never
from `server.js`. Exclusive writes in these modules use `lock.run(label, task)` inside `jsonRoute`. The index state lives in the
`archive` object in `server.js` (`articles`, `sourceArticles`, `articleById`, `infographicGroups`, `groupAnchorOf`,
`duplicateCanonicalOf`, `duplicateCandidates`, `meta`, `fuseIndex`); every reindex replaces its fields, so code that
gets `archive` reads `archive.articleById` at call time and never keeps a map from install time. The index works in three phases:

1. **Index build (`buildIndex` → `scanDir` → `parseArticle`).** On startup (and on reindex) it
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

**Infographic groups (`linkInfographics`).** Infographics (`www/Infografiken/`) are linked to their article by year +
file stem (`_N` suffix = variant only if the shortened stem exists). Placeholder infographics (no body) become
members of a group anchored on the article (or the base infographic); they inherit categories/tags and audio.
`/api/articles?group=1` (tile views) returns one tile per group with `images`; grouping happens per request after
the ACL filter, so users who cannot see the article get the infographic as its own tile.

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
  `passwordHash`. Each user has `role` (`admin`/`user`), `allowedAuthors` (`null` = all authors,
  or an array = whitelist), optional `mustChangePassword` and `sessionVersion`.
- **User management** (`modules/user-store.cjs` + `public/user-admin.js`): admins manage users and the
  public-author list in the UI (header "Aktionen" menu); every user can change their own password.
  `users.json` and `public-directories.txt` are written at runtime (atomic temp+rename, re-read
  before each change). `req.session.user` holds the resolved user (`email`, `role`,
  `allowedAuthors`, `mustChangePassword`, `sessionVersion`, also persisted in `sessions.json`), but
  only `email` and `sessionVersion` are authoritative: a middleware in `server.js` re-resolves
  role/rights from the store on every request, so changes apply at once and a bumped `sessionVersion`
  (new password) ends other sessions. While `mustChangePassword` is set,
  only `/api/me`, `/api/me/password`, `/api/login`, `/api/logout` are allowed.
- **Guests (no session)** get the authors listed in `public-directories.txt` (JSON, key
  `public-directories`). If that list is empty, unauthenticated requests get 401. Logged-in users
  with a whitelist always get the public authors in addition.
- **Enforcement is per-author** via `canAccessAuthor`. It gates three layers that must stay
  consistent: the `/files/*` media handler, the `/api/articles` list (ACL pre-filter), and the
  single-article route (both in `modules/articles.cjs`). `/files/*` and `/audio-files/*` live in `modules/media-files.cjs`:
  `resolveMediaRequest` rejects `.`/`..` segments (also when sent encoded) and the author ACL is
  checked on that validated path — never check a raw first segment and resolve afterwards. Reuse
  it for any new file-serving route. `prompts/*` uses the same
  `path.basename` + prefix-check guard.
- **Audiobooks** (`modules/audiobooks.cjs` = library, index, progress, routes; `modules/audiobook-extras.cjs` = extras folder
  management; `public/audiobooks.js`): author `Hörbücher` lives under
  `audio/Hoerbuecher/<book>/` (ASCII dir name, mapped to author `Hörbücher`; tracks + cover + optional `abstract.md`), has its own index and
  `/api/audiobooks*` routes (a book without tracks but with an ebook text file is an "ebook only" book: `trackCount: 0`, `ebookOnly: true`, no player), is never public (guests blocked in `canAccessAuthor`, filtered from
  `public-directories.txt`), and stores per-user playback position in `audiobook-progress.json`.
  Admins can mark a book *private* (global, not per user) — stored separately in `audiobook-private.json`;
  private books exist only for admins (list sort `private`, detail, media, preview). Sorts: `recent` (default),
  `added` (book folder creation time), `title`, `date`.
- **Bookmarks** (`modules/bookmarks.cjs`): per-user, logged-in only, stored in `bookmarks.json` (gitignored).
  `PUT/DELETE /api/bookmarks/*`; `/api/articles?bookmarks=1` filters after the ACL pre-filter and
  also includes Telegram. Display settings (font, light/dark/auto, article text size) are per device
  in `localStorage` (`public/settings.js`); guests always get the defaults.
- The `Telegram` author is special-cased: hidden from listings unless `?telegram=1` or explicitly
  filtered by `author=Telegram`.
- **Share links** use a short `shareId` (`lib/share-ids.cjs`, 12 chars `[A-Za-z0-9_-]` from the id's SHA-256,
  sent with article and audiobook details): `/a/<shareId>`. Share paths such as WhatsApp decode `%20` back to a
  space and cut the link there. `/a/<full id>` keeps working for older links.
- **Link-preview exception** (`modules/link-preview.cjs`): `GET /a/<id>` (Open-Graph HTML for social crawlers, redirects humans
  to `#/article/<id>`) and `GET /og-image/<id>` (sharp-downscaled preview image) are **intentionally
  unauthenticated** — they expose title/description/image of *any* article to anyone with the link,
  by design. `/og-image/*` still enforces the same path-traversal guard as `/files/*`; `?sq=256|512` returns a square top crop of the same image, used as lock-screen artwork (Media Session) for article audio. `sharp` output
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

**Layers (Session.MD §45–52):** every layer over the page is a modal `<dialog>` registered with
`public/layer-stack.js` (`WebArchivLayers.open(dialog, { onEscape, onKey, returnFocus })`, `close`, `top`, `count`,
`setBase` for the tile view's keys, `float` for elements that must stay usable above a layer such as the mini-player).
The stack owns keyboard order (element → top layer → base), Escape/`cancel`, focus return and blocks touch swipes that
cannot scroll anything in the top layer (Safari would scroll the page behind). Whoever handles Escape calls
`preventDefault()`, otherwise the browser also closes the next dialog. App layers (article view, image fullscreen,
eBook reader, extras, login, scrape and TTS windows) carry class `app-layer` and use `.open`, never `.hidden`; the
article view keeps its history depth in `history.state.articleDepth` and closes via `history.go(-depth)`
(`closeOverlay`; the real work is `finishCloseOverlay`, also used by popstate). All native dialogs are on the stack
too. Rules (enforced by `test/layer-rules.test.cjs`): open dialogs only with `WebArchivLayers.open` (never
`showModal()`), pass the close logic as `onEscape`, no own `cancel` listener, no `document`/`window` key handler and no
`stopImmediatePropagation` (only `aria-menu.js`, which closes menus first). Keys belong on the element (Ctrl+Enter,
arrows) or in the layer's `onKey` (e.g. the infographic review's Space via `infographicReview.fullscreenKey`). Ask
the stack (`WebArchivLayers.top()`), not `document.querySelector('dialog[open]')`, which layer is on top.

**Concurrent jobs:** all archive writes and index rebuilds go through the single lock in
`lib/archive-lock.cjs` (`archiveLock` in `server.js`). Jobs with their own state (reindex, scrape, editor,
TTS) are `register`ed once; new write routes use `archiveLock.tryAcquire(label)` + `release()` in
`finally` (or `archiveLock.run`) and answer conflicts with `sendArchiveBusy(res, archiveLock)` (inside `jsonRoute`: `throw archiveLock.conflictError()`) — never add new
hand-written `x.running || y.running` checks. Internal partial reindexes triggered by the lock holder
do not acquire again.

**Security modules:** `lib/login-limiter.cjs` (429 after repeated failed password checks on `/api/login`
and `/api/me/password`), `lib/html-sanitizer.cjs` (all markdown → HTML that reaches `innerHTML` must go
through `renderSafeMarkdown`), `lib/security-headers.cjs` (CSP; frontend must not use inline handlers like
`onerror=` — use `img[data-fallback]` / event listeners; new inline scripts need the per-response nonce).
