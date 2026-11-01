'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readStyles = require('./support/read-styles.cjs');
const readApp = require('./support/read-app.cjs');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = readStyles();
const APP = readApp();

test('Lupe im Suchfeld ist ein beschrifteter Schalter für die Volltextsuche', () => {
  assert.match(HTML, /<button id="search-fulltext" class="search-fulltext" type="button" aria-pressed="false"\s+title="Volltextsuche einschalten" aria-label="Volltextsuche einschalten">\s*<svg class="search-icon"[^>]*aria-hidden="true"/);
  const wrap = HTML.slice(HTML.indexOf('<div class="search-wrap">'), HTML.indexOf('id="search-clear"'));
  assert.ok(wrap.indexOf('id="search-fulltext"') < wrap.indexOf('id="search-input"'), 'Lupe steht vor dem Suchtext');
});

test('Lupe: entfärbt aus, gold mit dezentem Kreis an, Tippfläche 28 px, sichtbarer Tastaturfokus', () => {
  assert.match(CSS, /\.search-fulltext \{[^}]*width: 28px;[^}]*height: 28px;[^}]*border-radius: 50%;[^}]*color: var\(--text-muted\);/);
  assert.match(CSS, /\.search-fulltext\[aria-pressed="true"\] \{\s*color: var\(--accent\);\s*background: var\(--accent-glow\);\s*\}/);
  assert.match(CSS, /\.search-fulltext:focus-visible \{[^}]*box-shadow: 0 0 0 2px var\(--accent-dim\);/);
  assert.doesNotMatch(CSS, /\.search-icon \{[^}]*position: absolute/, 'die Lupe positioniert jetzt der Knopf');
});

test('Umschalten merkt den Modus pro Gerät, ändert Platzhalter und Beschriftung und sucht neu', () => {
  assert.match(APP, /const SEARCH_FULLTEXT_KEY = 'wa-search-fulltext';/);
  assert.match(APP, /on: 'Volltext: Wörter und Wortteile im Artikeltext…'/);
  assert.match(APP, /off: 'Suche nach Artikel, Autor, Kategorie, Datum…'/);
  assert.match(APP, /function applySearchFulltext\(\) \{[\s\S]*?setAttribute\('aria-pressed', String\(state\.fulltext\)\)[\s\S]*?\$searchInput\.placeholder = state\.fulltext/);
  assert.match(APP, /try \{ state\.fulltext = deviceStorage\(\)\?\.getItem\(SEARCH_FULLTEXT_KEY\) === '1'; \} catch/);
  assert.match(APP, /\$searchFulltext\.addEventListener\('click', \(\) => \{[\s\S]*?state\.fulltext = !state\.fulltext;[\s\S]*?setItem\(SEARCH_FULLTEXT_KEY[\s\S]*?if \(state\.q\) \{[\s\S]*?loadArticles\(\);/);
  // Die Anfrage trägt fulltext=1 nur mit Suchtext; der Platzhalter im HTML entspricht dem Aus-Zustand.
  assert.match(APP, /if \(params\.q && params\.fulltext\) qs\.set\('fulltext', '1'\);/);
  assert.match(APP, /fulltext: state\.fulltext,/);
  assert.match(HTML, /placeholder="Suche nach Artikel, Autor, Kategorie, Datum…"/);
});
