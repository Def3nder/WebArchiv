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
```

There is no test suite, linter, or build. `node server.js` is the only runtime; restart it to
pick up server-code changes. Article changes are picked up by re-indexing (admin reindex button
→ `POST /api/reindex`, or restart). Frontend changes (`public/`) only need a browser reload;
bump the `?v=` query on the `<script>`/`<link>` tags in `public/index.html` to bust caches.

## Architecture

**Single backend file: `server.js`.** It does everything in three phases:

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

3. **Auto-categorization (`autoCategorize` + `TAXONOMY`).** Each article is tagged with up to 5
   `categories` by keyword-counting against the hardcoded German `TAXONOMY` list. These drive the
   category filter and search. Note the distinction: `categories` = unified taxonomy labels used
   for filtering; `tags` = the raw `Kategorien:` field, display-only.

**Frontend: `public/` (no framework).** `index.html` is the shell, `app.js` is a hash-routed SPA
(`#/article/<id>` deep-links), `styles.css` the styling. It talks only to the `/api/*` JSON
endpoints and renders cards, an article overlay, audio/video players, and an embedded PDF viewer
(`public/pdfjs/`). State (search query, filters, pagination, current user) lives in the `state`
object in `app.js`.

## Auth & access control

- **Users** live in `users.json` (gitignored). Copy `example-users.json` → `users.json`, set
  plaintext `password` fields, run `node scripts/hash-passwords.js` to replace them with bcrypt
  `passwordHash`. Each user has `role` (`admin`/`user`) and `allowedAuthors`: `null` = all authors,
  or an array of author names = whitelist.
- **Guests (no session)** get the authors listed in `public-directories.txt` (JSON, key
  `public-directories`). If that list is empty, unauthenticated requests get 401.
- **Enforcement is per-author** via `canAccessAuthor`. It gates three layers that must stay
  consistent: the `/files/*` media handler, the `/api/articles` list (ACL pre-filter), and the
  single-article route. `/files/*` also has path-traversal protection (resolved path must stay
  under `www/`) — replicate that pattern for any new file-serving route. `prompts/*` uses the same
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
data on an external mounted disk. See `session-context.md` and `LXC-container node.js Setup.txt`
for the full setup log (SSH keys, systemd unit, mount/permission notes). Set `SESSION_SECRET` in
production — the default in `server.js` is a dev placeholder.
