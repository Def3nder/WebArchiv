'use strict';

// Gerenderter Artikeltext für die Detailansicht. Die Markdown-Datei wird nur neu
// gelesen, geparst und bereinigt, wenn sich Größe oder Änderungszeit geändert
// haben (z. B. nach dem Speichern im Editor). Die zuletzt geöffneten Artikel
// bleiben im Speicher; der älteste Eintrag fällt bei Überlauf heraus.

const fs = require('fs/promises');
const { parseArticle, renderArticleBody } = require('./article-parser.cjs');

function createArticleBodyCache({ maxEntries = 300, io = fs } = {}) {
  const entries = new Map(); // Dateipfad → { signature, value }

  async function get(filePath) {
    const stat = await io.stat(filePath);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = entries.get(filePath);
    if (cached?.signature === signature) {
      // Map-Reihenfolge = Nutzungsreihenfolge: zuletzt geöffnet ans Ende.
      entries.delete(filePath);
      entries.set(filePath, cached);
      return cached.value;
    }
    const parsed = parseArticle(await io.readFile(filePath, 'utf8'), filePath);
    const value = { bodyHtml: renderArticleBody(parsed.body), summary: parsed.summary || '' };
    entries.delete(filePath);
    entries.set(filePath, { signature, value });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  }

  return { get, clear: () => entries.clear(), get size() { return entries.size; } };
}

module.exports = { createArticleBodyCache };
