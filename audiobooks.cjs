const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const express = require('express');
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
const SORTS = ['recent', 'added', 'title', 'date', 'private'];
// eBook zum Hörbuch: Datei heißt wie der Ordner (Reihenfolge = Vorrang).
const EBOOK_EXTS = ['.md', '.txt', '.pdf'];
const EBOOK_MAX_BYTES = 5 * 1024 * 1024;
const EXTRA_MARKDOWN_MAX_BYTES = 1024 * 1024;
const EXTRA_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const TEXT_PROGRESS_KEY = '__text';   // je Nutzer: { <Buch-ID>: { format, position, updatedAt } }
const GLOBAL_STATE_KEY = '__global';
const PRIVATE_BOOKS_KEY = '__private'; // global: { <Buch-ID>: true }
const DEFAULT_CONFIG = { skipLongSeconds: 600, skipShortSeconds: 30 };
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
const fail = (status, message) => Object.assign(new Error(message), { status });
const emailKey = email => String(email || '').toLowerCase();

function contentVersion(content) {
  return createHash('sha256').update(content).digest('hex');
}

function safeExtraTitle(value) {
  const title = String(value || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 140).trim();
  if (!title || title === '.' || title === '..') throw fail(400, 'Bitte einen gültigen Namen eingeben.');
  return title;
}

function safeUploadName(value) {
  const original = path.basename(String(value || '').replace(/\\/g, '/'));
  const ext = path.extname(original).toLowerCase();
  const stem = safeExtraTitle(path.parse(original).name);
  return stem + ext;
}

function renamedExtraFile(file, title, preserveOrder = true) {
  const ext = path.extname(file).toLowerCase();
  const prefix = preserveOrder
    ? path.parse(file).name.match(/^(\s*\d+\s*[-–._)]*\s*)/)?.[1] || ''
    : '';
  return prefix + safeExtraTitle(title) + ext;
}

function orderedExtraFile(file, index, width) {
  const ext = path.extname(file).toLowerCase();
  const stem = path.parse(file).name.replace(/^\s*\d+\s*[-–._)]*\s*/, '').trim() || 'Extra';
  return `${String(index + 1).padStart(width, '0')} - ${stem}${ext}`;
}

function validateImage(content, ext) {
  if (!Buffer.isBuffer(content) || !content.length) throw fail(400, 'Keine Bilddatei empfangen.');
  const png = content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  const gif = content.length >= 6 && ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString('ascii'));
  if ((ext === '.png' && !png) || (['.jpg', '.jpeg'].includes(ext) && !jpeg) || (ext === '.gif' && !gif)) {
    throw fail(415, 'Bildinhalt und Dateiendung passen nicht zusammen.');
  }
}

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
    const dirStat = await fs.stat(dirPath);
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
      // Wann der Buchordner ins Archiv kam; nicht mit dem inhaltlichen Datum verwechseln.
      addedAt: new Date(dirStat.birthtimeMs > 0 ? dirStat.birthtimeMs : dirStat.mtimeMs).toISOString(),
      excerpt: excerpt(abstract.description),
      imageUrl,
      trackCount: trackFiles.length,
      ebookOnly: !trackFiles.length,
      tracks: trackFiles.map((file, i) => ({ title: titles[i], file, url: mediaUrl(dirName, bookDir, file) })),
      description: abstract.description,
      filePath: abstractPath,
      ebook,
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
    const { tracks, description, filePath, bookDir, ...rest } = book;
    return {
      ...rest,
      private: progress.isPrivate(book.id),
      progress: progressSummary(user, book),
    };
  }

  function list(user, { q, sort, page = 1, limit = 24 } = {}) {
    const requestedMode = SORTS.includes(sort) ? sort : 'recent';
    const isAdmin = user?.role === 'admin';
    // Alte PWAs dürfen weiterhin sort=private senden. Für Nicht-Administratoren
    // wird das serverseitig wie „zuletzt“ behandelt und private Bücher bleiben unsichtbar.
    const mode = requestedMode === 'private' && !isAdmin ? 'recent' : requestedMode;
    const isPrivate = book => progress.isPrivate(book.id);
    let items = books.filter(book => isAdmin && mode === 'private' ? isPrivate(book) : !isPrivate(book));
    const text = String(q || '').trim();
    if (text && fuse) {
      const ids = new Set(fuse.search(text).map(r => r.item.id));
      items = items.filter(b => ids.has(b.id));
    }
    items = [...items];
    if (mode === 'date') {
      items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || collator.compare(a.title, b.title));
    } else if (mode === 'added') {
      items.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || collator.compare(a.title, b.title));
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

  async function detail(user, id) {
    const book = books.find(b => b.id === id);
    if (!book || !canAccess(user, book)) return null;
    const { description, filePath, bookDir, ...rest } = book;
    const entry = progress.get(user?.email, book.id);
    return {
      ...rest,
      private: progress.isPrivate(book.id),
      hasExtras: !!(await existingExtrasPath(book)),
      tracks: book.tracks.map(({ title, url }) => ({ title, url })),
      descriptionHtml: description ? renderMarkdown(description) : '',
      hasAbstract: !!filePath,
      ebookPosition: book.ebook ? progress.getText(user?.email, book.id, book.ebook.format) : null,
      progress: entry ? { ...entry, trackIndex: resolveTrackIndex(book, entry) } : null,
    };
  }

  function canAccess(user, book) {
    return !!book && (user?.role === 'admin' || !progress.isPrivate(book.id));
  }

  function getForUser(user, id) {
    const book = books.find(b => b.id === id);
    return canAccess(user, book) ? book : null;
  }

  function bookForMediaPath(relPath) {
    let decoded = String(relPath || '').replace(/\\/g, '/');
    try { decoded = decodeURIComponent(decoded); } catch { /* ungültig bleibt unverändert */ }
    const parts = path.posix.normalize(decoded).split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== dirName) return null;
    return books.find(book => book.bookDir === parts[1]) || null;
  }

  function canAccessMedia(user, relPath) {
    let decoded = String(relPath || '').replace(/\\/g, '/');
    try { decoded = decodeURIComponent(decoded); } catch { /* ungültig bleibt unverändert */ }
    const parts = path.posix.normalize(decoded).split('/').filter(Boolean);
    if (parts[0] !== dirName) return false;
    // Standard-Cover liegen direkt im Hörbuch-Wurzelverzeichnis und gehören zu keinem Buch.
    if (parts.length === 2) return true;
    return canAccess(user, bookForMediaPath(decoded));
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
    const extrasDir = await existingExtrasPath(book);
    if (!extrasDir) throw fail(404, 'Das Extra wurde nicht gefunden.');
    const requested = String(file || '');
    if (!requested || path.basename(requested) !== requested || requested.startsWith('.')) {
      throw fail(404, 'Das Extra wurde nicht gefunden.');
    }
    const actualFile = await actualEntry(extrasDir, requested);
    if (path.extname(actualFile).toLowerCase() !== '.md') throw fail(404, 'Das Extra wurde nicht gefunden.');
    const extra = { file: actualFile, title: extraTitle(actualFile, book.title) };
    const abs = path.join(extrasDir, actualFile);
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
        const resolved = await resolveEbookImage(book.bookDir, [path.basename(extrasDir), ...parts].join('/'));
        url = resolved.url || null;
      }
      html = html.split(tag).join(url ? tag.replace(match[0], 'src="' + url + '"') : '');
    }
    textCache.set(cacheKey, { mtimeMs: stat.mtimeMs, html });
    return { format: 'md', title: extra.title, html };
  }

  let extrasWriting = false;

  function extrasPaths(book) {
    if (!book || !root) throw fail(404, 'Hörbuch nicht gefunden.');
    const bookPath = path.join(root, book.bookDir);
    return {
      bookPath,
      extrasPath: path.join(bookPath, book.extrasDirName || 'extras'),
    };
  }

  async function existingExtrasPath(book) {
    const { bookPath } = extrasPaths(book);
    const entries = await fs.readdir(bookPath, { withFileTypes: true });
    const entry = entries.find(item => item.name.toLowerCase() === 'extras');
    if (!entry) return null;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail(403, 'Der Extras-Pfad ist kein erlaubter Ordner.');
    return path.join(bookPath, entry.name);
  }

  async function actualEntry(dir, requested) {
    const clean = path.basename(String(requested || ''));
    if (!clean || clean !== requested || clean.startsWith('.')) throw fail(400, 'Ungültiger Dateiname.');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const entry = entries.find(item => item.name.toLowerCase() === clean.toLowerCase());
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) throw fail(404, 'Die Extra-Datei wurde nicht gefunden.');
    return entry.name;
  }

  function visibleExtras(book, extrasPath, entries) {
    return entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink() && EXTRA_EXTS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => {
        const ext = path.extname(entry.name).toLowerCase();
        const type = ext === '.md' ? 'markdown' : 'image';
        return {
          file: entry.name,
          title: extraTitle(entry.name, book.title),
          type,
          ...(type === 'image' ? { url: withVersion(mediaUrl(dirName, book.bookDir, path.basename(extrasPath), entry.name), path.join(extrasPath, entry.name)) } : {}),
        };
      })
      .sort((a, b) => collator.compare(a.file, b.file));
  }

  async function extras(book) {
    const extrasPath = await existingExtrasPath(book);
    if (!extrasPath) return { extras: [] };
    const entries = await fs.readdir(extrasPath, { withFileTypes: true });
    return { extras: visibleExtras(book, extrasPath, entries) };
  }

  async function extrasManagement(book) {
    const extrasPath = await existingExtrasPath(book);
    if (!extrasPath) return { extras: [], images: [] };
    const entries = await fs.readdir(extrasPath, { withFileTypes: true });
    const extras = visibleExtras(book, extrasPath, entries);

    let images = [];
    const imageEntry = entries.find(entry => entry.name.toLowerCase() === 'images');
    if (imageEntry) {
      if (!imageEntry.isDirectory() || imageEntry.isSymbolicLink()) throw fail(403, 'extras/images ist kein erlaubter Ordner.');
      const imagesPath = path.join(extrasPath, imageEntry.name);
      images = (await fs.readdir(imagesPath, { withFileTypes: true }))
        .filter(entry => entry.isFile() && !entry.isSymbolicLink() && EXTRA_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()))
        .map(entry => ({
          file: entry.name,
          title: path.parse(entry.name).name,
          type: 'image',
          url: withVersion(mediaUrl(dirName, book.bookDir, path.basename(extrasPath), imageEntry.name, entry.name), path.join(imagesPath, entry.name)),
        }))
        .sort((a, b) => collator.compare(a.file, b.file));
    }
    return { extras, images };
  }

  async function extraMarkdownSource(book, requested) {
    const extrasPath = await existingExtrasPath(book);
    if (!extrasPath) throw fail(404, 'Das Extra wurde nicht gefunden.');
    const file = await actualEntry(extrasPath, requested);
    if (path.extname(file).toLowerCase() !== '.md') throw fail(415, 'Nur Markdown-Extras können als Text bearbeitet werden.');
    const content = await fs.readFile(path.join(extrasPath, file));
    if (content.length > EXTRA_MARKDOWN_MAX_BYTES) throw fail(413, 'Das Markdown-Extra ist größer als 1 MB.');
    const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    return { file, markdown, version: contentVersion(content) };
  }

  async function atomicWrite(target, content, mode) {
    const temp = path.join(path.dirname(target), `.extra-${randomUUID()}.tmp`);
    const handle = await fs.open(temp, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.rename(temp, target); }
    catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }

  async function withExtrasWrite(task) {
    if (extrasWriting) throw fail(409, 'Es wird bereits ein Extra bearbeitet. Bitte kurz warten.');
    extrasWriting = true;
    try {
      const result = await task();
      await rebuild();
      return result;
    } finally { extrasWriting = false; }
  }

  async function saveExtraMarkdown(book, requested, input) {
    if (typeof input?.markdown !== 'string' || input.markdown.includes('\0') || !/^[a-f0-9]{64}$/.test(input.version || '')) {
      throw fail(400, 'Markdown-Text und gültige Dateiversion sind erforderlich.');
    }
    const content = Buffer.from(input.markdown, 'utf8');
    if (content.length > EXTRA_MARKDOWN_MAX_BYTES) throw fail(413, 'Das Markdown-Extra ist größer als 1 MB.');
    return withExtrasWrite(async () => {
      const extrasPath = await existingExtrasPath(book);
      if (!extrasPath) throw fail(404, 'Das Extra wurde nicht gefunden.');
      const file = await actualEntry(extrasPath, requested);
      if (path.extname(file).toLowerCase() !== '.md') throw fail(415, 'Nur Markdown-Extras können als Text bearbeitet werden.');
      const target = path.join(extrasPath, file);
      const original = await fs.readFile(target);
      if (contentVersion(original) !== input.version) throw fail(409, 'Die Datei wurde inzwischen geändert. Bitte neu laden.');
      await atomicWrite(target, content, (await fs.stat(target)).mode & 0o777);
      return { saved: true, file, version: contentVersion(content) };
    });
  }

  async function createExtraMarkdown(book, input) {
    const title = safeExtraTitle(input?.title);
    const markdown = typeof input?.markdown === 'string' ? input.markdown : `# ${title}\n`;
    if (markdown.includes('\0')) throw fail(400, 'Der Markdown-Text enthält ungültige Zeichen.');
    const content = Buffer.from(markdown, 'utf8');
    if (content.length > EXTRA_MARKDOWN_MAX_BYTES) throw fail(413, 'Das Markdown-Extra ist größer als 1 MB.');
    return withExtrasWrite(async () => {
      const { extrasPath } = extrasPaths(book);
      let created = false;
      try {
        let dir = await existingExtrasPath(book);
        if (!dir) { await fs.mkdir(extrasPath); dir = extrasPath; created = true; }
        const file = safeExtraTitle(title) + '.md';
        if ((await fs.readdir(dir)).some(name => name.toLowerCase() === file.toLowerCase())) throw fail(409, 'Ein Extra mit diesem Namen existiert bereits.');
        await atomicWrite(path.join(dir, file), content, 0o644);
        return { created: true, file };
      } catch (error) {
        if (created) await fs.rmdir(extrasPath).catch(() => {});
        throw error;
      }
    });
  }

  async function uploadExtraFile(book, { scope, name, replace }, content) {
    const file = safeUploadName(name);
    const ext = path.extname(file).toLowerCase();
    if (scope === 'images') {
      if (!EXTRA_IMAGE_EXTS.has(ext)) throw fail(415, 'Für eingebettete Bilder sind JPG, PNG und GIF erlaubt.');
    } else if (scope === 'extras') {
      if (!EXTRA_EXTS.has(ext)) throw fail(415, 'Als Extras sind Markdown-, JPG-, PNG- und GIF-Dateien erlaubt.');
    } else throw fail(400, 'Ungültiger Zielordner.');
    if (!Buffer.isBuffer(content) || !content.length) throw fail(400, 'Keine Datei empfangen.');
    if (ext === '.md') {
      if (content.length > EXTRA_MARKDOWN_MAX_BYTES) throw fail(413, 'Die Markdown-Datei ist größer als 1 MB.');
      try { new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { throw fail(415, 'Die Markdown-Datei ist nicht gültig UTF-8-kodiert.'); }
    } else {
      if (content.length > EXTRA_IMAGE_MAX_BYTES) throw fail(413, 'Die Bilddatei ist größer als 20 MB.');
      validateImage(content, ext);
    }
    return withExtrasWrite(async () => {
      const { extrasPath } = extrasPaths(book);
      let extrasCreated = false;
      let imagesCreated = false;
      let activeExtrasPath = extrasPath;
      try {
        let dir = await existingExtrasPath(book);
        if (!dir) { await fs.mkdir(extrasPath); dir = extrasPath; extrasCreated = true; }
        activeExtrasPath = dir;
        if (scope === 'images') {
          const imagesPath = path.join(dir, 'images');
          const imageStat = await fs.lstat(imagesPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (!imageStat) { await fs.mkdir(imagesPath); imagesCreated = true; }
          else if (!imageStat.isDirectory() || imageStat.isSymbolicLink()) throw fail(403, 'extras/images ist kein erlaubter Ordner.');
          dir = imagesPath;
        }
        const existing = (await fs.readdir(dir)).find(item => item.toLowerCase() === String(replace || file).toLowerCase());
        if (replace) {
          if (!existing || path.extname(existing).toLowerCase() !== ext) throw fail(404, 'Die zu ersetzende Datei wurde nicht gefunden oder hat einen anderen Typ.');
        } else if (existing) throw fail(409, 'Eine Datei mit diesem Namen existiert bereits.');
        const target = path.join(dir, replace ? existing : file);
        const mode = replace ? (await fs.stat(target)).mode & 0o777 : 0o644;
        await atomicWrite(target, content, mode);
        return { uploaded: true, file: replace ? existing : file };
      } catch (error) {
        if (imagesCreated) await fs.rmdir(path.join(activeExtrasPath, 'images')).catch(() => {});
        if (extrasCreated) await fs.rmdir(extrasPath).catch(() => {});
        throw error;
      }
    });
  }

  async function updateMarkdownImageReferences(extrasPath, oldFile, newFile) {
    const entries = await fs.readdir(extrasPath, { withFileTypes: true });
    const variants = [
      [`images/${oldFile}`, `images/${newFile}`],
      [`images\\${oldFile}`, `images\\${newFile}`],
      [`images/${encodeURIComponent(oldFile)}`, `images/${encodeURIComponent(newFile)}`],
    ];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      const target = path.join(extrasPath, entry.name);
      const original = await fs.readFile(target);
      if (original.length > EXTRA_MARKDOWN_MAX_BYTES) continue;
      let markdown;
      try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(original); }
      catch { continue; }
      let updated = markdown;
      for (const [from, to] of variants) updated = updated.split(from).join(to);
      if (updated !== markdown) await atomicWrite(target, Buffer.from(updated, 'utf8'), (await fs.stat(target)).mode & 0o777);
    }
  }

  async function renameExtraEntry(book, input) {
    const scope = input?.scope;
    if (!['extras', 'images'].includes(scope)) throw fail(400, 'Ungültiger Zielordner.');
    return withExtrasWrite(async () => {
      const extrasPath = await existingExtrasPath(book);
      if (!extrasPath) throw fail(404, 'Die Extra-Datei wurde nicht gefunden.');
      const dir = scope === 'images' ? path.join(extrasPath, 'images') : extrasPath;
      const file = await actualEntry(dir, String(input.file || ''));
      const ext = path.extname(file).toLowerCase();
      if (scope === 'images' ? !EXTRA_IMAGE_EXTS.has(ext) : !EXTRA_EXTS.has(ext)) throw fail(415, 'Dieser Dateityp kann nicht verwaltet werden.');
      const next = renamedExtraFile(file, input.title, scope === 'extras');
      const conflict = (await fs.readdir(dir)).find(name => name.toLowerCase() === next.toLowerCase() && name !== file);
      if (conflict) throw fail(409, 'Eine Datei mit diesem Namen existiert bereits.');
      if (next === file) return { renamed: false, file };
      const source = path.join(dir, file);
      const target = path.join(dir, next);
      const intermediate = path.join(dir, `.extra-rename-${randomUUID()}.tmp`);
      await fs.rename(source, intermediate);
      try {
        await fs.rename(intermediate, target);
        if (scope === 'images') await updateMarkdownImageReferences(extrasPath, file, next);
      } catch (error) {
        await fs.rename(intermediate, source).catch(() => fs.rename(target, source).catch(() => {}));
        throw error;
      }
      return { renamed: true, file: next };
    });
  }

  async function reorderExtras(book, input) {
    if (!Array.isArray(input?.files) || !input.files.length || input.files.length > 1000) {
      throw fail(400, 'Eine gültige Reihenfolge der Extras ist erforderlich.');
    }
    return withExtrasWrite(async () => {
      const extrasPath = await existingExtrasPath(book);
      if (!extrasPath) throw fail(404, 'Die Extras wurden nicht gefunden.');
      const entries = (await fs.readdir(extrasPath, { withFileTypes: true }))
        .filter(entry => entry.isFile() && !entry.isSymbolicLink() && EXTRA_EXTS.has(path.extname(entry.name).toLowerCase()));
      const byLower = new Map(entries.map(entry => [entry.name.toLowerCase(), entry.name]));
      const requested = input.files.map(file => {
        if (typeof file !== 'string' || path.basename(file) !== file || file.startsWith('.')) {
          throw fail(400, 'Die Reihenfolge enthält einen ungültigen Dateinamen.');
        }
        return byLower.get(file.toLowerCase());
      });
      if (requested.some(file => !file)
          || new Set(requested.map(file => file.toLowerCase())).size !== requested.length
          || requested.length !== entries.length) {
        throw fail(409, 'Die Extras haben sich inzwischen geändert. Bitte neu laden.');
      }

      const width = Math.max(2, String(requested.length).length);
      const moves = requested.map((source, index) => ({
        source,
        target: orderedExtraFile(source, index, width),
        temp: `.extra-order-${randomUUID()}.tmp`,
      }));
      const staged = [];
      try {
        for (const move of moves) {
          await fs.rename(path.join(extrasPath, move.source), path.join(extrasPath, move.temp));
          staged.push(move);
        }
      } catch (error) {
        for (const move of staged.reverse()) {
          await fs.rename(path.join(extrasPath, move.temp), path.join(extrasPath, move.source)).catch(() => {});
        }
        throw error;
      }

      const completed = [];
      try {
        for (const move of moves) {
          await fs.rename(path.join(extrasPath, move.temp), path.join(extrasPath, move.target));
          completed.push(move);
        }
      } catch (error) {
        for (const move of completed.reverse()) {
          await fs.rename(path.join(extrasPath, move.target), path.join(extrasPath, move.temp)).catch(() => {});
        }
        for (const move of moves.slice().reverse()) {
          await fs.rename(path.join(extrasPath, move.temp), path.join(extrasPath, move.source)).catch(() => {});
        }
        throw error;
      }
      return {
        reordered: true,
        files: moves.map(move => ({ from: move.source, to: move.target })),
      };
    });
  }

  async function markdownImageReferences(extrasPath, file) {
    const entries = await fs.readdir(extrasPath, { withFileTypes: true });
    const needles = [`images/${file}`, `images\\${file}`, `images/${encodeURIComponent(file)}`];
    const references = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      const text = await fs.readFile(path.join(extrasPath, entry.name), 'utf8');
      if (needles.some(needle => text.includes(needle))) references.push(entry.name);
    }
    return references;
  }

  async function deleteExtraEntry(book, input) {
    const scope = input?.scope;
    if (!['extras', 'images'].includes(scope)) throw fail(400, 'Ungültiger Zielordner.');
    return withExtrasWrite(async () => {
      const extrasPath = await existingExtrasPath(book);
      if (!extrasPath) throw fail(404, 'Die Extra-Datei wurde nicht gefunden.');
      const dir = scope === 'images' ? path.join(extrasPath, 'images') : extrasPath;
      const file = await actualEntry(dir, String(input.file || ''));
      const ext = path.extname(file).toLowerCase();
      if (scope === 'images' ? !EXTRA_IMAGE_EXTS.has(ext) : !EXTRA_EXTS.has(ext)) throw fail(415, 'Dieser Dateityp kann nicht verwaltet werden.');
      if (scope === 'images') {
        const references = await markdownImageReferences(extrasPath, file);
        if (references.length) throw fail(409, `Das Bild wird noch verwendet in: ${references.join(', ')}`);
      }
      await fs.unlink(path.join(dir, file));
      if (scope === 'images') await fs.rmdir(dir).catch(() => {});
      await fs.rmdir(extrasPath).catch(() => {});
      return { deleted: true, file };
    });
  }

  return {
    rebuild,
    list,
    detail,
    ebookText,
    extraText,
    extras,
    extrasManagement,
    extraMarkdownSource,
    saveExtraMarkdown,
    createExtraMarkdown,
    uploadExtraFile,
    renameExtraEntry,
    reorderExtras,
    deleteExtraEntry,
    get: id => books.find(b => b.id === id),
    getForUser,
    canAccess,
    bookForMediaPath,
    canAccessMedia,
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

  function migratePrivateBooks() {
    const privateBooks = { ...(data[GLOBAL_STATE_KEY]?.[PRIVATE_BOOKS_KEY] || {}) };
    let changed = false;
    for (const [key, entry] of Object.entries(data)) {
      if (key === GLOBAL_STATE_KEY || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const legacy = entry[PRIVATE_BOOKS_KEY];
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) continue;
      for (const [bookId, value] of Object.entries(legacy)) {
        if (value) privateBooks[bookId] = true;
      }
      delete entry[PRIVATE_BOOKS_KEY];
      if (!Object.keys(entry).length) delete data[key];
      changed = true;
    }
    if (Object.keys(privateBooks).length) {
      data[GLOBAL_STATE_KEY] = { ...(data[GLOBAL_STATE_KEY] || {}), [PRIVATE_BOOKS_KEY]: privateBooks };
    }
    return changed;
  }

  function load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('audiobook-progress.json nicht geladen —', err.message);
      data = {};
    }
    // Frühere Versionen speicherten „privat“ pro Nutzer. Die Vereinigung aller
    // Markierungen wird global übernommen, damit beim Update nichts offengelegt wird.
    if (migratePrivateBooks()) persist();
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
    isPrivate(bookId) {
      return !!data[GLOBAL_STATE_KEY]?.[PRIVATE_BOOKS_KEY]?.[bookId];
    },
    async setPrivate(bookId, value) {
      if (typeof value !== 'boolean') throw fail(400, 'Ungültige Privat-Markierung.');
      const globalState = { ...(data[GLOBAL_STATE_KEY] || {}) };
      const privateBooks = { ...(globalState[PRIVATE_BOOKS_KEY] || {}) };
      if (value) privateBooks[bookId] = true;
      else delete privateBooks[bookId];
      if (Object.keys(privateBooks).length) globalState[PRIVATE_BOOKS_KEY] = privateBooks;
      else delete globalState[PRIVATE_BOOKS_KEY];
      if (Object.keys(globalState).length) data[GLOBAL_STATE_KEY] = globalState;
      else delete data[GLOBAL_STATE_KEY];
      await persist();
      return { private: value };
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

function installAudiobookRoutes(app, { library, progress, config, requireAuth, canAccessAuthor, busy = () => false }) {
  const route = (handler, admin = false) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!canAccessAuthor(req.session.user, AUDIOBOOK_AUTHOR)) throw fail(403, 'Kein Zugriff auf Hörbücher.');
      if (admin && req.session.user?.role !== 'admin') throw fail(403, 'Nur Administratoren dürfen diese Funktion verwenden.');
      if (admin && req.method !== 'GET' && busy()) throw fail(409, 'Es läuft bereits ein Speicher- oder Indexauftrag. Bitte später erneut versuchen.');
      if (req.method !== 'GET' && req.get('sec-fetch-site') === 'cross-site') throw fail(403, 'Änderungen sind nur aus dem Archiv erlaubt.');
      res.json(await handler(req, req.session.user));
    } catch (error) {
      if (!error.status) console.error('Hörbücher:', error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Anfrage ist fehlgeschlagen.' });
    }
  };

  const accessibleBook = (user, id) => {
    const book = library.getForUser(user, id);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return book;
  };

  app.get('/api/audiobooks', requireAuth, route((req, user) => library.list(user, req.query)));
  app.get('/api/audiobooks/*', requireAuth, route(async (req, user) => {
    const book = await library.detail(user, req.params[0]);
    if (!book) throw fail(404, 'Hörbuch nicht gefunden.');
    return { ...book, config: { skipLongSeconds: config.skipLongSeconds, skipShortSeconds: config.skipShortSeconds } };
  }));
  app.get('/api/audiobook-text/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    const text = await library.ebookText(book);
    return { ...text, position: progress.getText(user.email, book.id, text.format) };
  }));
  app.put('/api/audiobook-private/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return progress.setPrivate(book.id, req.body?.private);
  }, true));
  app.get('/api/audiobook-extra/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.extraText(book, String(req.query.file || ''));
  }));
  app.get('/api/audiobook-extras/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.extras(book);
  }));
  app.get('/api/audiobook-extra-manage/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.extrasManagement(book);
  }, true));
  app.get('/api/audiobook-extra-source/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.extraMarkdownSource(book, String(req.query.file || ''));
  }, true));
  app.put('/api/audiobook-extra-source/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.saveExtraMarkdown(book, String(req.query.file || ''), req.body);
  }, true));
  app.post('/api/audiobook-extra-create/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.createExtraMarkdown(book, req.body);
  }, true));
  app.post(
    '/api/audiobook-extra-upload/*',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: EXTRA_IMAGE_MAX_BYTES }),
    route(async (req, user) => {
      const book = accessibleBook(user, req.params[0]);
      return library.uploadExtraFile(book, {
        scope: String(req.query.scope || ''),
        name: String(req.query.name || ''),
        replace: String(req.query.replace || ''),
      }, req.body);
    }, true),
  );
  app.patch('/api/audiobook-extra-entry/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.renameExtraEntry(book, req.body);
  }, true));
  app.post('/api/audiobook-extra-order/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.reorderExtras(book, req.body);
  }, true));
  app.delete('/api/audiobook-extra-entry/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return library.deleteExtraEntry(book, req.body);
  }, true));
  app.put('/api/audiobook-text-progress/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
    return progress.setText(user.email, book, req.body);
  }));
  app.put('/api/audiobook-progress/*', requireAuth, route(async (req, user) => {
    const book = accessibleBook(user, req.params[0]);
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
