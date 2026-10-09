const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const Fuse = require('fuse.js');
const { writeJsonAtomic } = require('./user-store.cjs');

// Hörbücher liegen als je ein Ordner unter audio/<Verzeichnis>/ (nicht unter www/),
// damit der Artikel-Scan sie nicht als Artikel einliest. Angezeigt wird immer
// AUDIOBOOK_AUTHOR; das Verzeichnis darf ohne Umlaute heißen (Server: Hoerbuecher).
const AUDIOBOOK_AUTHOR = 'Hörbücher';
const DIRECTORY_CANDIDATES = ['Hoerbuecher', AUDIOBOOK_AUTHOR];
const TRACK_EXTS = new Set(['.mp3', '.m4b', '.m4a']);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const EXTRA_IMAGE_EXTS = new Set([...IMAGE_EXTS, '.gif']);
const EXTRA_EXTS = new Set([...EXTRA_IMAGE_EXTS, '.md']);
const SORTS = ['recent', 'title', 'date'];
// eBook zum Hörbuch: Datei heißt wie der Ordner (Reihenfolge = Vorrang).
const EBOOK_EXTS = ['.md', '.txt', '.pdf'];
const EBOOK_MAX_BYTES = 5 * 1024 * 1024;
const TEXT_PROGRESS_KEY = '__text';   // je Nutzer: { <Buch-ID>: { format, position, updatedAt } }
const DEFAULT_CONFIG = { skipLongSeconds: 600, skipShortSeconds: 30 };
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const fail = (status, message) => Object.assign(new Error(message), { status });
const emailKey = email => String(email || '').toLowerCase();

// ─── abstract.md ───────────────────────────────────────────────────────────

function normalizeDate(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})$/);
  return m ? `${m[1]}-01-01` : null;
}

// Feste Felder: Titel, Autor, Datum, Inhalt (Rest der Datei, Markdown).
// Markierungen wie **Titel:** oder # Titel: werden toleriert.
function parseAbstract(content) {
  const lines = String(content || '').replace(/^﻿/, '').split(/\r?\n/);
  const result = { title: '', author: '', date: null, description: '' };
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].replace(/^[\s#>*_]+/, '');
    const m = clean.match(/^(titel|autor|datum|inhalt)[*_]*\s*:[*_]*\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/[*_\s]+$/, '').trim();
    if (key === 'inhalt') {
      result.description = [m[2], ...lines.slice(i + 1)].join('\n').trim();
      break;
    }
    if (key === 'titel') result.title = value;
    else if (key === 'autor') result.author = value;
    else result.date = normalizeDate(value);
  }
  return result;
}

// ─── Tracks ────────────────────────────────────────────────────────────────

function trackTitles(files) {
  const titles = files.map(file => {
    const stem = path.parse(file).name;
    return stem.replace(/^\s*\d+\s*[-–._)]*\s*/, '').trim() || stem;
  });
  // Gemeinsamen Anhang wie " - Buchtitel - Autor" entfernen, wenn alle Tracks ihn tragen.
  if (titles.length > 1) {
    const parts = titles.map(t => t.split(' - '));
    let k = 0;
    while (parts.every(p => p.length > k + 1 && p[p.length - 1 - k] === parts[0][parts[0].length - 1 - k])) k++;
    if (k) return parts.map(p => p.slice(0, p.length - k).join(' - '));
  }
  return titles;
}

function mediaUrl(...segments) {
  return '/audio-files/' + segments.map(encodeURIComponent).join('/');
}

function withVersion(url, absPath) {
  try { return `${url}?v=${Math.floor(fsSync.statSync(absPath).mtimeMs)}`; }
  catch { return url; }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Reiner Text → Absätze. Ohne Leerzeilen gilt jede Zeile als Absatz, sonst werden
// fest umbrochene Zeilen innerhalb eines Absatzes zusammengezogen.
function renderPlainText(text) {
  const clean = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  const blocks = /\n[ \t]*\n/.test(clean) ? clean.split(/\n[ \t]*\n/) : clean.split('\n');
  return blocks
    .map(block => block.split('\n').map(line => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean)
    .map(block => '<p>' + escapeHtml(block) + '</p>')
    .join('\n');
}

function findByName(filesByLower, names) {
  for (const name of names) {
    const actual = filesByLower.get(name);
    if (actual) return actual;
  }
  return null;
}

function extraTitle(file, bookTitle) {
  let title = path.parse(file).name.replace(/^\s*\d+\s*[-–._)]*\s*/, '').trim();
  const prefix = String(bookTitle || '').trim();
  if (prefix && title.toLocaleLowerCase('de').startsWith(prefix.toLocaleLowerCase('de') + ' - ')) {
    title = title.slice(prefix.length + 3).trim();
  }
  return title || path.parse(file).name;
}

// ─── Bibliothek (In-Memory-Index, wird beim Reindex neu aufgebaut) ─────────

// Konfiguriertes Verzeichnis oder das erste vorhandene aus DIRECTORY_CANDIDATES.
function resolveAudiobookDirectory(audioRoot, configured) {
  const candidates = configured ? [configured] : DIRECTORY_CANDIDATES;
  return candidates.find(name => {
    try { return fsSync.statSync(path.join(audioRoot, name)).isDirectory(); }
    catch { return false; }
  }) || null;
}

function createAudiobookLibrary({ audioRoot, directory = null, excerpt, renderMarkdown, progress }) {
  let books = [];
  let fuse = null;
  let dirName = null;   // tatsächlicher Ordnername unter audioRoot (für URLs und Rechteprüfung)
  let root = null;
  const textCache = new Map();   // Buch-ID → { mtimeMs, html }

  async function scanBook(bookDir) {
    const dirPath = path.join(root, bookDir);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const filesByLower = new Map(entries.filter(e => e.isFile()).map(e => [e.name.toLowerCase(), e.name]));
    const trackFiles = [...filesByLower.values()]
      .filter(name => TRACK_EXTS.has(path.extname(name).toLowerCase()))
      .sort(collator.compare);
    // Ein reines eBook (Text, aber kein Audio) ist ebenfalls ein Buch.
    const ebookFile = findByName(filesByLower, EBOOK_EXTS.map(ext => bookDir.toLowerCase() + ext));
    if (!trackFiles.length && !ebookFile) return null;

    const abstractName = filesByLower.get('abstract.md');
    const abstractPath = abstractName ? path.join(dirPath, abstractName) : null;
    const abstract = abstractPath ? parseAbstract(await fs.readFile(abstractPath, 'utf8')) : parseAbstract('');
    // Ohne Angaben: Ordnername „Autor - Titel“ auswerten.
    const sep = bookDir.indexOf(' - ');
    const title = abstract.title || (sep > 0 ? bookDir.slice(sep + 3) : bookDir);
    const bookAuthor = abstract.author || (sep > 0 ? bookDir.slice(0, sep) : '');

    const coverName = findByName(filesByLower, IMAGE_EXTS.map(ext => 'cover' + ext));
    let imageUrl = null;
    if (coverName) {
      imageUrl = withVersion(mediaUrl(dirName, bookDir, coverName), path.join(dirPath, coverName));
    } else {
      const standard = IMAGE_EXTS.map(ext => 'standard' + ext).find(name => fsSync.existsSync(path.join(root, name)));
      if (standard) imageUrl = withVersion(mediaUrl(dirName, standard), path.join(root, standard));
    }

    const ebook = ebookFile ? { format: path.extname(ebookFile).slice(1).toLowerCase(), file: ebookFile } : null;
    const extrasDir = entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'extras');
    let extras = [];
    if (extrasDir) {
      const extraPath = path.join(dirPath, extrasDir.name);
      const extraEntries = await fs.readdir(extraPath, { withFileTypes: true });
      extras = extraEntries
        .filter(entry => entry.isFile() && EXTRA_EXTS.has(path.extname(entry.name).toLowerCase()))
        .map(entry => {
          const ext = path.extname(entry.name).toLowerCase();
          return {
            file: entry.name,
            title: extraTitle(entry.name, title),
            type: ext === '.md' ? 'markdown' : 'image',
            ...(ext === '.md' ? {} : { url: withVersion(mediaUrl(dirName, bookDir, extrasDir.name, entry.name), path.join(extraPath, entry.name)) }),
          };
        })
        .sort((a, b) => collator.compare(a.file, b.file));
    }

    const titles = trackTitles(trackFiles);
    return {
      // ID unabhängig vom Ordnernamen auf der Platte → Hörfortschritt bleibt gültig.
      id: `${AUDIOBOOK_AUTHOR}/${bookDir}`,
      kind: 'audiobook',
      author: AUDIOBOOK_AUTHOR,
      bookAuthor,
      title,
      date: abstract.date,
      year: abstract.date ? abstract.date.slice(0, 4) : '',
      excerpt: excerpt(abstract.description),
      imageUrl,
      trackCount: trackFiles.length,
      ebookOnly: !trackFiles.length,
      tracks: trackFiles.map((file, i) => ({ title: titles[i], file, url: mediaUrl(dirName, bookDir, file) })),
      description: abstract.description,
      filePath: abstractPath,
      ebook,
      extras,
      extrasDirName: extrasDir?.name || null,
      bookDir,
    };
  }

  async function rebuild() {
    textCache.clear();
    dirName = resolveAudiobookDirectory(audioRoot, directory);
    if (!dirName) { books = []; fuse = null; return books; }
    root = path.join(audioRoot, dirName);
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') { books = []; fuse = null; return books; }
      throw err;
    }
    const next = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const book = await scanBook(entry.name);
        if (book) next.push(book);
      } catch (err) {
        console.warn(`Hörbuch „${entry.name}“ übersprungen:`, err.message);
      }
    }
    books = next.sort((a, b) => collator.compare(a.title, b.title));
    fuse = new Fuse(books, {
      keys: [
        { name: 'title', weight: 3 },
        { name: 'bookAuthor', weight: 2 },
        { name: 'excerpt', weight: 0.8 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
    return books;
  }

  function progressSummary(user, book) {
    const entry = progress.get(user?.email, book.id);
    if (!entry) return null;
    return { trackIndex: resolveTrackIndex(book, entry), trackCount: book.trackCount, updatedAt: entry.updatedAt };
  }

  function listView(book, user) {
    const { tracks, description, filePath, bookDir, extras, extrasDirName, ...rest } = book;
    return { ...rest, hasExtras: extras.length > 0, progress: progressSummary(user, book) };
  }

  function list(user, { q, sort, page = 1, limit = 24 } = {}) {
    let items = books;
    const text = String(q || '').trim();
    if (text && fuse) {
      const ids = new Set(fuse.search(text).map(r => r.item.id));
      items = items.filter(b => ids.has(b.id));
    }
    const mode = SORTS.includes(sort) ? sort : 'recent';
    items = [...items];
    if (mode === 'date') {
      items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || collator.compare(a.title, b.title));
    } else if (mode === 'recent') {
      const heard = book => progress.lastActivity(user?.email, book.id);
      items.sort((a, b) => heard(b).localeCompare(heard(a)) || collator.compare(a.title, b.title));
    }
    const total = items.length;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));
    return {
      total, page: p, limit: lim, pages: Math.ceil(total / lim), sort: mode,
      items: items.slice((p - 1) * lim, p * lim).map(book => listView(book, user)),
    };
  }

  function detail(user, id) {
    const book = books.find(b => b.id === id);
    if (!book) return null;
    const { description, filePath, bookDir, extrasDirName, ...rest } = book;
    const entry = progress.get(user?.email, book.id);
    return {
      ...rest,
      tracks: book.tracks.map(({ title, url }) => ({ title, url })),
      descriptionHtml: description ? renderMarkdown(description) : '',
      hasAbstract: !!filePath,
      ebookPosition: book.ebook ? progress.getText(user?.email, book.id, book.ebook.format) : null,
      progress: entry ? { ...entry, trackIndex: resolveTrackIndex(book, entry) } : null,
    };
  }

  // Bildpfad relativ zur eBook-Datei → Datei im Buchordner (Unterordner erlaubt, Groß-/Kleinschreibung
  // egal: Linux unterscheidet sie, die Dateien entstehen aber oft unter Windows). Liefert { url } oder
  // { reason }; Pfade aus dem Buchordner heraus werden abgewiesen. stat folgt Symlinks/Mounts.
  async function resolveEbookImage(bookDir, src) {
    let rel = src;
    try { rel = decodeURIComponent(src); } catch { /* unverändert */ }
    const parts = path.posix.normalize(rel.split('\\').join('/').split(/[?#]/)[0]).split('/').filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..')) return { reason: 'liegt außerhalb des Buchordners' };
    let dir = path.join(root, bookDir);
    const segments = [];
    for (const [i, part] of parts.entries()) {
      const isLast = i === parts.length - 1;
      let name = part;
      let stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat) {
        let entries;
        try { entries = await fs.readdir(dir); }
        catch (err) { return { reason: 'Ordner nicht lesbar (' + err.code + '): ' + dir }; }
        name = entries.find(entry => entry.toLowerCase() === part.toLowerCase());
        stat = name && await fs.stat(path.join(dir, name)).catch(() => null);
      }
      if (!stat) return { reason: '„' + part + '“ nicht gefunden in ' + dir };
      if (isLast ? !stat.isFile() : !stat.isDirectory()) return { reason: '„' + name + '“ hat den falschen Typ' };
      segments.push(name);
      dir = path.join(dir, name);
    }
    return { url: withVersion(mediaUrl(dirName, bookDir, ...segments), dir) };
  }

  // <img src="images/x.jpg"> → /audio-files/…; nicht auflösbare lokale Bilder entfallen (mit Hinweis
  // im Log), externe (http, data:) bleiben unverändert.
  async function rewriteEbookImages(html, book) {
    const tags = [...new Set(html.match(/<img\b[^>]*>/gi) || [])];
    const misses = [];
    for (const tag of tags) {
      const m = tag.match(/\bsrc="([^"]*)"/i);
      if (!m || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(m[1])) continue;
      const { url, reason } = await resolveEbookImage(book.bookDir, m[1]);
      if (!url) misses.push(m[1] + ' – ' + reason);
      html = html.split(tag).join(url ? tag.replace(m[0], 'src="' + url + '"') : '');
    }
    if (misses.length) console.warn('Hörbuch-Text „' + book.id + '“: ' + misses.length + ' Bild(er) nicht gefunden, z. B. ' + misses[0]);
    return html;
  }

  // eBook-Inhalt: md/txt als HTML (gecacht nach Änderungszeit), pdf als Medien-URL.
  async function ebookText(book) {
    if (!book?.ebook) throw fail(404, 'Zu diesem Hörbuch gibt es keinen Text.');
    const abs = path.join(root, book.bookDir, book.ebook.file);
    const stat = await fs.stat(abs);
    const { format } = book.ebook;
    if (format === 'pdf') return { format, url: withVersion(mediaUrl(dirName, book.bookDir, book.ebook.file), abs) };
    if (stat.size > EBOOK_MAX_BYTES) throw fail(413, 'Der Text ist zu groß.');
    const cached = textCache.get(book.id);
    if (cached && cached.mtimeMs === stat.mtimeMs) return { format, html: cached.html };
    const raw = await fs.readFile(abs, 'utf8');
    const html = format === 'md'
      ? await rewriteEbookImages(renderMarkdown(raw.replace(/^﻿/, '')), book)
      : renderPlainText(raw);
    textCache.set(book.id, { mtimeMs: stat.mtimeMs, html });
    return { format, html };
  }

  async function extraText(book, file) {
    const extra = book?.extras?.find(item => item.type === 'markdown' && item.file === file);
    if (!extra) throw fail(404, 'Das Extra wurde nicht gefunden.');
    const extrasDir = path.join(root, book.bookDir, book.extrasDirName);
    const abs = path.join(extrasDir, extra.file);
    const stat = await fs.stat(abs);
    if (stat.size > EBOOK_MAX_BYTES) throw fail(413, 'Der Text ist zu groß.');
    const cacheKey = `${book.id}\0extra\0${extra.file}`;
    const cached = textCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs) return { format: 'md', title: extra.title, html: cached.html };
    const raw = await fs.readFile(abs, 'utf8');
    let html = renderMarkdown(raw.replace(/^﻿/, ''));
    const tags = [...new Set(html.match(/<img\b[^>]*>/gi) || [])];
    for (const tag of tags) {
      const match = tag.match(/\bsrc="([^"]*)"/i);
      if (!match || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(match[1])) continue;
      let rel = match[1];
      try { rel = decodeURIComponent(rel); } catch { /* unverändert */ }
      const parts = path.posix.normalize(rel.split('\\').join('/').split(/[?#]/)[0]).split('/').filter(part => part && part !== '.');
      let url = null;
      if (parts.length > 1 && parts[0].toLowerCase() === 'images' && !parts.includes('..')) {
        const resolved = await resolveEbookImage(book.bookDir, [book.extrasDirName, ...parts].join('/'));
        url = resolved.url || null;
      }
      html = html.split(tag).join(url ? tag.replace(match[0], 'src="' + url + '"') : '');
    }
    textCache.set(cacheKey, { mtimeMs: stat.mtimeMs, html });
    return { format: 'md', title: extra.title, html };
  }

  return {
    rebuild,
    list,
    detail,
    ebookText,
    extraText,
    get: id => books.find(b => b.id === id),
    get books() { return books; },
    get directory() { return dirName; },
  };
}

// Track bevorzugt über den Dateinamen finden, damit eingefügte Dateien den Stand nicht verschieben.
function resolveTrackIndex(book, entry) {
  const byFile = entry.file ? book.tracks.findIndex(t => t.file === entry.file) : -1;
  if (byFile >= 0) return byFile;
  return Math.max(0, Math.min(entry.trackIndex | 0, book.trackCount - 1));
}

// ─── Hörfortschritt pro Nutzer (audiobook-progress.json) ───────────────────

function createProgressStore({ file, io = fs }) {
  let data = {};
  let queue = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('audiobook-progress.json nicht geladen —', err.message);
      data = {};
    }
  }

  function persist() {
    const run = queue.then(() => writeJsonAtomic(file, data, io, 0o600));
    queue = run.catch(err => console.error('Hörfortschritt konnte nicht gespeichert werden:', err.message));
    return run;
  }

  return {
    load,
    get(email, bookId) {
      return (email && data[emailKey(email)]?.[bookId]) || null;
    },
    // Zeitpunkt der letzten Nutzung (Hören oder Lesen), für die Sortierung „zuletzt“.
    lastActivity(email, bookId) {
      const user = email ? data[emailKey(email)] : null;
      const heard = user?.[bookId]?.updatedAt || '';
      const read = user?.[TEXT_PROGRESS_KEY]?.[bookId]?.updatedAt || '';
      return heard > read ? heard : read;
    },
    async set(email, book, input) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      const trackIndex = Number(input?.trackIndex);
      const position = Number(input?.position);
      const speed = Number(input?.speed ?? 1);
      if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= book.trackCount) throw fail(400, 'Ungültiger Track.');
      if (!Number.isFinite(position) || position < 0 || position > 24 * 3600) throw fail(400, 'Ungültige Position.');
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 3) throw fail(400, 'Ungültige Geschwindigkeit.');
      const entry = {
        file: book.tracks[trackIndex].file,
        trackIndex,
        position: Math.round(position * 10) / 10,
        speed: Math.round(speed * 100) / 100,
        updatedAt: new Date().toISOString(),
      };
      const key = emailKey(email);
      data[key] = { ...(data[key] || {}), [book.id]: entry };
      await persist();
      return entry;
    },
    getText(email, bookId, format) {
      const entry = email ? data[emailKey(email)]?.[TEXT_PROGRESS_KEY]?.[bookId] : null;
      return entry && entry.format === format ? entry.position : null;
    },
    // Leseposition: Anteil 0–1 (md/txt) bzw. Seitenzahl (pdf); getrennt vom Hörstand.
    async setText(email, book, input) {
      if (!email) throw fail(401, 'Nicht angemeldet.');
      if (!book.ebook) throw fail(404, 'Zu diesem Hörbuch gibt es keinen Text.');
      const { format } = book.ebook;
      const position = Number(input?.position);
      const valid = format === 'pdf'
        ? Number.isInteger(position) && position >= 1 && position <= 100000
        : Number.isFinite(position) && position >= 0 && position <= 1;
      if (!valid) throw fail(400, 'Ungültige Leseposition.');
      const key = emailKey(email);
      const user = data[key] || {};
      const entry = { format, position: format === 'pdf' ? position : Math.round(position * 10000) / 10000, updatedAt: new Date().toISOString() };
      data[key] = { ...user, [TEXT_PROGRESS_KEY]: { ...(user[TEXT_PROGRESS_KEY] || {}), [book.id]: entry } };
      await persist();
      return entry;
    },
    async removeUser(email) {
      const key = emailKey(email);
      if (!data[key]) return;
      delete data[key];
      await persist();
    },
  };
}

// ─── Konfiguration (config.json → audiobooks) ──────────────────────────────

function loadAudiobookConfig(file) {
  let raw = {};
  try { raw = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.audiobooks || {}; }
  catch (err) { if (err.code !== 'ENOENT') console.warn('config.json nicht geladen —', err.message); }
  const pick = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const dir = typeof raw.directory === 'string' ? raw.directory.trim() : '';
  return {
    skipLongSeconds: pick(raw.skipLongSeconds, DEFAULT_CONFIG.skipLongSeconds),
    skipShortSeconds: pick(raw.skipShortSeconds, DEFAULT_CONFIG.skipShortSeconds),
    // Optional; ohne Angabe wird Hoerbuecher bzw. Hörbücher gesucht.
    directory: dir && !/[\\/\0]/.test(dir) && dir !== '.' && dir !== '..' ? dir : null,
  };
}

// ─── Routen ────────────────────────────────────────────────────────────────

function installAudiobookRoutes(app, { library, progress, config, requireAuth, canAccessAuthor }) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!canAccessAuthor(req.session.user, AUDIOBOOK_AUTHOR)) throw fail(403, 'Kein Zugriff auf Hörbücher.');
      if (req.method !== 'GET' && req.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Änderungen sind nur aus dem Archiv erlaubt.');
      res.json(await handler(req, req.session.user));
    } catch (error) {
      if (!error.status) console.error('Hörbücher:', error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Anfrage ist fehlgeschlagen.' });
    }
  };

  app.get('/api/audiobooks', requireAuth, route((req, user) => library.list(user, req.query)));
  app.get('/api/audiobooks/*', requireAuth, route((req, user) => {
    const book = library.detail(user, req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return { ...book, config: { skipLongSeconds: config.skipLongSeconds, skipShortSeconds: config.skipShortSeconds } };
  }));
  app.get('/api/audiobook-text/*', requireAuth, route(async (req, user) => {
    const book = library.get(req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    const text = await library.ebookText(book);
    return { ...text, position: progress.getText(user.email, book.id, text.format) };
  }));
  app.get('/api/audiobook-extra/*', requireAuth, route(async req => {
    const book = library.get(req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return library.extraText(book, String(req.query.file || ''));
  }));
  app.put('/api/audiobook-text-progress/*', requireAuth, route(async (req, user) => {
    const book = library.get(req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return progress.setText(user.email, book, req.body);
  }));
  app.put('/api/audiobook-progress/*', requireAuth, route(async (req, user) => {
    const book = library.get(req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return progress.set(user.email, book, req.body);
  }));
}

module.exports = {
  AUDIOBOOK_AUTHOR,
  resolveAudiobookDirectory,
  parseAbstract,
  trackTitles,
  createAudiobookLibrary,
  createProgressStore,
  loadAudiobookConfig,
  installAudiobookRoutes,
};
