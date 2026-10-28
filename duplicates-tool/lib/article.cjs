// Markdown-Artikel mit dem Parser des WebArchiv (lib/article-parser.cjs) einlesen,
// damit Titel, Datum und Body genauso erkannt werden. Das Werkzeug braucht nur diese drei Felder.
'use strict';

const { normalizeDate, bodyExcerpt, parseArticle: parseArchiveArticle } = require('../../lib/article-parser.cjs');

function parseArticle(content, filePath) {
  const text = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const { title, date, body } = parseArchiveArticle(text, filePath);
  return { title, date, body };
}

module.exports = { normalizeDate, bodyExcerpt, parseArticle };
