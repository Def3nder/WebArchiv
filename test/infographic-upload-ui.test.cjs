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
  assert.match(
    manager,
    /await uploadInfographic\(igmState\.article, file\)[\s\S]*?await igmLoad\(\)[\s\S]*?await igmRefreshArticle\(\)/,
  );
  assert.match(manager, /const detailPosition = captureDetailPosition\(\)[\s\S]*?await loadArticles\(\)[\s\S]*?await openArticle\(articleId, \{ historyMode: 'none', detailPosition \}\)/);
});

test('Dialog kann per Escape und Pull-to-Close geschlossen werden', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'public', 'infographic-manager.js'), 'utf8');
  assert.match(app, /\['#infographic-manager', '#infographic-manager \[data-igm-close\]'\]/);
  assert.match(manager, /\$igm\.addEventListener\('cancel', event =>/);
  assert.match(manager, /document\.addEventListener\('keydown'[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*igmEscape\(\)[\s\S]*}, true\)/);
});
