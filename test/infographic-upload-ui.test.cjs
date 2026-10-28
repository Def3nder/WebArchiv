const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Artikel öffnen die Infografik-Verwaltung statt eines einzelnen Upload-Felds', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /id="detail-infographic-btn" aria-label="Infografiken verwalten"/);
  assert.match(app, /window\.openInfographicManager\?\.\(article\)/);
  assert.match(html, /id="infographic-manager"[\s\S]*data-igm-add>Grafik hinzufügen[\s\S]*data-igm-list/);
  assert.match(html, /infographic-manager\.js(?:\?v=[a-f0-9]+)?/);
});

test('Upload im Verwaltungsdialog aktualisiert Artikel und Grafikliste', () => {
  const manager = fs.readFileSync(path.join(__dirname, '..', 'public', 'infographic-manager.js'), 'utf8');
  assert.match(manager, /igmRun\(\(\) => uploadInfographic\(igmState\.article, file\)/);
  // Gesperrt nur, solange der Server schreibt und die Liste neu lädt; die Artikelansicht
  // wird danach aktualisiert, damit z. B. der Poster-Haken sofort gespeichert werden kann.
  assert.match(manager, /async function igmRun\([\s\S]*?await task\(\);[\s\S]*?await igmLoad\(\);[\s\S]*?finally \{\s*igmBusy\(false\);[\s\S]*?await igmRefreshArticle\(\)/);
  assert.match(manager, /function igmSave\([^)]*\) \{\s*return igmRun\(/);
  // Neu gerenderte Checkboxen übernehmen den Sperrzustand.
  assert.match(manager, /function igmRender\(\) \{[\s\S]*?igmBusy\(igmState\.busy\);\s*\}/);
  assert.match(manager, /const detailPosition = captureDetailPosition\(\)[\s\S]*?await loadArticles\(\)[\s\S]*?await openArticle\(articleId, \{ historyMode: 'none', detailPosition \}\)/);
});

test('Dialog kann per Escape und Pull-to-Close geschlossen werden', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'public', 'infographic-manager.js'), 'utf8');
  assert.match(app, /\['#infographic-manager', '#infographic-manager \[data-igm-close\]'\]/);
  assert.match(manager, /\$igm\.addEventListener\('cancel', event =>/);
  assert.match(manager, /document\.addEventListener\('keydown'[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*igmEscape\(\)[\s\S]*}, true\)/);
});
