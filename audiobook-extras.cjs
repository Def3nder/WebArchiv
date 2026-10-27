'use strict';

// Extra-Material zu Hörbüchern: Ordner extras/ im Buchordner (Markdown und Bilder)
// mit Unterordner images/ für eingebettete Bilder. Auflisten, Markdown bearbeiten und
// anlegen, Hochladen, Umbenennen, Sortieren und Löschen. Die Bibliothek
// (audiobooks.cjs) liefert Wurzelordner, Medien-URLs und den Neuaufbau nach Änderungen.

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('./lib/atomic-file.cjs');
const { httpError: fail } = require('./lib/http-errors.cjs');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const EXTRA_IMAGE_EXTS = new Set([...IMAGE_EXTS, '.gif']);
const EXTRA_EXTS = new Set([...EXTRA_IMAGE_EXTS, '.md']);
const EXTRA_MARKDOWN_MAX_BYTES = 1024 * 1024;
const EXTRA_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

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

function extraTitle(file, bookTitle) {
  let title = path.parse(file).name.replace(/^\s*\d+\s*[-–._)]*\s*/, '').trim();
  const prefix = String(bookTitle || '').trim();
  if (prefix && title.toLocaleLowerCase('de').startsWith(prefix.toLocaleLowerCase('de') + ' - ')) {
    title = title.slice(prefix.length + 3).trim();
  }
  return title || path.parse(file).name;
}

// getRoot(): tatsächlicher Hörbuch-Ordner (oder null); mediaUrlFor(absPath, ...segmente):
// versionierte /audio-files-URL; rebuild(): Bibliothek nach einer Änderung neu einlesen.
function createAudiobookExtras({ getRoot, mediaUrlFor, rebuild }) {
  let extrasWriting = false;

  function extrasPaths(book) {
    const root = getRoot();
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
          ...(type === 'image' ? { url: mediaUrlFor(path.join(extrasPath, entry.name), book.bookDir, path.basename(extrasPath), entry.name) } : {}),
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
          url: mediaUrlFor(path.join(imagesPath, entry.name), book.bookDir, path.basename(extrasPath), imageEntry.name, entry.name),
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
      await writeFileAtomic(target, content);
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
        await writeFileAtomic(path.join(dir, file), content);
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
        await writeFileAtomic(target, content);
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
      if (updated !== markdown) await writeFileAtomic(target, Buffer.from(updated, 'utf8'));
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
    extras, extrasManagement, extraMarkdownSource, saveExtraMarkdown, createExtraMarkdown, uploadExtraFile, renameExtraEntry, reorderExtras, deleteExtraEntry,
    // Für die Textansicht der Bibliothek (extraText).
    existingExtrasPath, actualEntry,
  };
}

module.exports = { createAudiobookExtras, extraTitle, EXTRA_IMAGE_MAX_BYTES };
