const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArticle } = require('./server.js');

test('beginnt einen Blogartikel mit dem ersten Inhalt nach dem Datum', () => {
  const markdown = [
    '# Kann Berührung wirklich Medizin sein?',
    '',
    '*Quelle: https://example.com/blogartikel*',
    '',
    '**Datum: 2026-09-17**',
    '',
    'Erster Absatz des Artikels.',
    '',
    'Quelle: Studie im Artikeltext.',
    '',
    'Joe Turan',
  ].join('\n');

  const article = parseArticle(markdown, '2026-09-17_blogartikel.md');

  assert.equal(article.sourceUrl, 'https://example.com/blogartikel');
  assert.equal(
    article.body,
    'Erster Absatz des Artikels.\n\nQuelle: Studie im Artikeltext.\n\nJoe Turan'
  );
});

test('liest bekannte Metadaten direkt nach dem Datum weiterhin', () => {
  const markdown = [
    '# Artikel mit Metadaten',
    '',
    '**Datum: 2026-09-18**',
    '',
    '**Audioquickie: 42**',
    '**Kategorien: Körper, Gesundheit**',
    '',
    'Artikelinhalt.',
  ].join('\n');

  const article = parseArticle(markdown, '2026-09-18_metadaten.md');

  assert.equal(article.episodeNum, 42);
  assert.deepEqual(article.tags, ['Körper', 'Gesundheit']);
  assert.equal(article.body, 'Artikelinhalt.');
});
