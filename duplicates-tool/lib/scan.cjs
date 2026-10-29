// Ordner rekursiv nach .md-Dateien durchsuchen und Begleitdateien zuordnen.
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { parseArticle, bodyExcerpt } = require('./article.cjs');
const { buildDuplicateProfile } = require('./duplicates.cjs');
const { isPathInside } = require('../../lib/archive-files.cjs');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);

function splitName(name) {
  const ext = path.extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext: ext.toLowerCase() };
}

// Liegt child in parent oder ist parent selbst?
function isInside(child, parent) {
  return path.resolve(child) === path.resolve(parent) || isPathInside(parent, child);
}

// Begleitdateien: gleicher Basisname (foo.jpg) oder Infografik-Variante (foo_1.jpg),
// sofern es keine eigene foo_1.md gibt. Andere .md-Dateien sind nie Begleitdateien.
function companionsFor(mdName, fileNames) {
  const { stem } = splitName(mdName);
  const lowerStem = stem.toLocaleLowerCase('de-DE');
  const mdStems = new Set(fileNames.filter(name => splitName(name).ext === '.md')
    .map(name => splitName(name).stem.toLocaleLowerCase('de-DE')));
  return fileNames.filter(name => {
    const parts = splitName(name);
    if (parts.ext === '.md' || name === mdName) return false;
    const lower = parts.stem.toLocaleLowerCase('de-DE');
    if (lower === lowerStem) return true;
    const variant = lower.match(/^(.*)_(\d+)$/);
    return Boolean(variant && variant[1] === lowerStem && !mdStems.has(lower));
  }).sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

// idPrefix trennt mehrere Ordner derselben Seite (A1, A2 …), damit IDs eindeutig bleiben.
async function scanFolder(root, { side, idPrefix = side, rootIndex = 1, exclude = [] } = {}) {
  const resolvedRoot = path.resolve(root);
  const excluded = exclude.filter(Boolean).map(item => path.resolve(item))
    .filter(item => item !== resolvedRoot && isInside(item, resolvedRoot));
  const articles = [];

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (dir === resolvedRoot) throw error;
      console.warn('Ordner übersprungen:', dir, error.message);
      return;
    }
    const fileNames = entries.filter(entry => entry.isFile()).map(entry => entry.name);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (excluded.some(item => isInside(full, item))) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || splitName(entry.name).ext !== '.md') continue;
      try {
        const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
        const parsed = parseArticle(content, full);
        const relPath = path.relative(resolvedRoot, full);
        articles.push({
          id: `${idPrefix}:${relPath.split(path.sep).join('/')}`,
          side,
          root: resolvedRoot,
          rootIndex,
          relPath,
          absPath: full,
          title: parsed.title,
          date: parsed.date,
          body: parsed.body,
          excerpt: bodyExcerpt(parsed.body, 240),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          companions: companionsFor(entry.name, fileNames),
          duplicateProfile: buildDuplicateProfile(parsed.title, parsed.body),
        });
      } catch (error) {
        console.warn('Datei übersprungen:', full, error.message);
      }
    }
  }

  await walk(resolvedRoot);
  return articles.sort((a, b) => a.relPath.localeCompare(b.relPath, 'de', { numeric: true }));
}

module.exports = { IMAGE_EXTENSIONS, splitName, isInside, companionsFor, scanFolder };
