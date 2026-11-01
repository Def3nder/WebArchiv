'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { foldSearchText, parseFulltextQuery, matchesFulltext } = require('../lib/fulltext.cjs');
const { parseArticleContent } = require('../lib/article-scan.cjs');

test('foldSearchText: klein, ohne Umlautpunkte und Akzente, ß als ss, Satzzeichen als Leerzeichen', () => {
  assert.equal(foldSearchText('Ängste, Größe & **Café**\n\n# Über-Ich'), 'angste grosse cafe uber ich');
  assert.equal(foldSearchText(null), '');
});

test('parseFulltextQuery: Wörter und Phrasen in Anführungszeichen', () => {
  assert.deepEqual(parseFulltextQuery('Angst "inneres  Kind" Größe'), ['angst', 'inneres kind', 'grosse']);
  assert.deepEqual(parseFulltextQuery('"" ,, '), []);
});

test('matchesFulltext: alle Begriffe, auch innerhalb von Wörtern und über Zeilen hinweg', () => {
  const text = foldSearchText('Die Verlustangst des inneren\nKindes zeigt sich früh.');
  assert.equal(matchesFulltext(text, parseFulltextQuery('angst')), true, 'innerhalb von Wörtern');
  assert.equal(matchesFulltext(text, parseFulltextQuery('Angst frueh')), false, 'ae/oe/ue-Schreibweise zählt nicht');
  assert.equal(matchesFulltext(text, parseFulltextQuery('angst früh')), true, 'alle Wörter');
  assert.equal(matchesFulltext(text, parseFulltextQuery('angst Wut')), false, 'ein Wort fehlt');
  assert.equal(matchesFulltext(text, parseFulltextQuery('"inneren kindes"')), true, 'Phrase über Zeilenumbruch');
  assert.equal(matchesFulltext(text, parseFulltextQuery('"kindes inneren"')), false, 'Phrase in falscher Reihenfolge');
  assert.equal(matchesFulltext(text, []), false);
  assert.equal(matchesFulltext('', ['angst']), false);
});

test('Scan: Suchtext aus Titel, Zusammenfassung und Text', () => {
  const parsed = parseArticleContent('Über Mut\n\nDatum: 2026-01-05\nZusammenfassung: Kurz und klar.\n\n****\n\nDie **Verlustangst** loslassen.\n', '/a.md');
  assert.equal(parsed.searchText, 'uber mut kurz und klar die verlustangst loslassen');
});
