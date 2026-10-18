const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Dublettenprüfung ist als Admin-Dialog mit allen Entscheidungswegen eingebunden', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const ui = read('public/duplicates.js');
  assert.match(html, /data-action="duplicates"[^>]*data-admin-only/);
  assert.match(html, /id="duplicate-review"[\s\S]*data-duplicate-tab="pending"[\s\S]*data-duplicate-tab="linked"[\s\S]*data-duplicate-tab="ignored"/);
  assert.match(html, /duplicates\.js\?v=4/);
  assert.match(app, /action === 'duplicates'[\s\S]*openDuplicateReview/);
  for (const action of ['inspect', 'toggle-selection', 'mobile-side', 'ignore', 'migrate', 'reset']) {
    assert.match(ui, new RegExp(`data-duplicate-action=\\"${action}\\"`));
  }
  assert.match(html, /id="duplicate-score-filter"[\s\S]*id="duplicate-infographic-filter"/);
  assert.match(html, /id="duplicate-select-all"[\s\S]*id="duplicate-batch-link"/);
  assert.match(ui, /\/api\/duplicates\/batch/);
});

test('Infografikmigration verlangt eine ausdrückliche Bestätigung und zeigt Zielpfade', () => {
  const ui = read('public/duplicates.js');
  assert.match(ui, /window\.confirm\('Die Infografikdateien im Ordner/);
  assert.match(ui, /item\.target/);
  assert.match(ui, /migrateImages/);
});

test('Migration richtet sich nur nach Infografiken und bleibt ohne Fund deaktiviert', () => {
  const ui = read('public/duplicates.js');
  const server = read('server.js');
  const plan = server.slice(server.indexOf('function planDuplicateMigration'), server.indexOf('function publicMigrationPlan'));
  assert.match(ui, /item\.facebook\?\.infographicCount/);
  assert.match(ui, /duplicateBatchMigrate\.disabled = duplicateUi\.busy \|\| withInfographics === 0/);
  assert.doesNotMatch(ui, /hasOwnImage \|\| item\.facebook\?\.infographicCount/);
  assert.match(plan, /infographicGroups\.get\(facebook\.id\)/);
  assert.doesNotMatch(plan, /facebook\.ownImage|facebook-image|findSibling/);
});

test('beide Artikelseiten zeigen ihre Infografikanzahl und der Detailfuß bleibt sichtbar', () => {
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(ui, /duplicateInfographicGallery\(pair\.blog, 'blog'\)/);
  assert.match(ui, /duplicateInfographicGallery\(pair\.facebook, 'facebook'\)/);
  assert.match(ui, /duplicateContent\.classList\.add\('is-detail'\)/);
  assert.match(css, /\.duplicate-detail\s*\{[\s\S]*grid-template-rows: auto minmax\(0, 1fr\) auto auto/);
  assert.match(css, /\.duplicate-fulltext\s*\{[\s\S]*overflow-y: auto/);
});

test('Blog- und Facebook-Infografiken lassen sich vergleichen und bildschirmfüllend öffnen', () => {
  const html = read('public/index.html');
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  const server = read('server.js');
  assert.match(server, /function duplicateInfographicViews[\s\S]*infographicGroups\.get\(article\.id\)[\s\S]*imageUrl: item\.imageUrl/);
  assert.doesNotMatch(server.slice(server.indexOf('function duplicateInfographicViews'), server.indexOf('function duplicateArticleView')), /article\.ownImage|article\.imageUrl/);
  assert.match(ui, /duplicateInfographicGallery\(pair\.blog, 'blog'\)/);
  assert.match(ui, /duplicateInfographicGallery\(pair\.facebook, 'facebook'\)/);
  assert.match(ui, /data-duplicate-action="open-infographic"/);
  assert.match(ui, /\['blog', 'facebook'\]\.flatMap/);
  assert.match(html, /id="duplicate-image-viewer"[\s\S]*id="duplicate-image-viewer-image"/);
  assert.match(css, /\.duplicate-image-viewer\s*\{[\s\S]*width: 100vw;[\s\S]*height: 100dvh;/);
});

test('Filter sind kombinierbar, Auswahl bleibt gespeichert und doppelte Facebook-Ziele werden vermieden', () => {
  const ui = read('public/duplicates.js');
  const server = read('server.js');
  assert.match(ui, /filters: \{ score: 'all', infographics: 'all' \}/);
  assert.match(ui, /localStorage\.setItem\(DUPLICATE_SELECTION_KEY/);
  assert.match(ui, /scoreMatch[\s\S]*infographicMatch[\s\S]*return scoreMatch && infographicMatch/);
  assert.match(ui, /facebookId[\s\S]*duplicateUi\.selection\.delete/);
  assert.match(server, /Ein Facebook-Artikel darf nur einmal in einer Sammelaktion vorkommen/);
});

test('Sammelverknüpfung indiziert höchstens einmal und reine Links gar nicht neu', () => {
  const server = read('server.js');
  const batch = server.slice(server.indexOf("app.post('/api/duplicates/batch'"), server.indexOf("app.post('/api/duplicates',"));
  assert.match(batch, /for \(const item of items\)/);
  assert.match(batch, /duplicateStore\.setMany/);
  assert.match(batch, /replaceArticleIds/);
  assert.match(batch, /if \(migrations\.length\) await buildIndex\(\);\s*else refreshDuplicateState\(\);/);
  assert.equal((batch.match(/await buildIndex\(\)/g) || []).length, 1);
});

test('Mobil zeigt der Vergleich genau eine umschaltbare Textseite', () => {
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(ui, /duplicateUi\.tab === 'pending' && !duplicateUi\.detail/);
  assert.match(ui, /data-mobile-side="\$\{duplicateUi\.mobileSide\}"/);
  assert.match(ui, /data-side="blog"[\s\S]*data-side="facebook"/);
  assert.match(css, /\.duplicate-detail-grid article \{ display: none;/);
  assert.match(css, /data-mobile-side="blog"[\s\S]*data-duplicate-side="blog"/);
  assert.match(css, /data-mobile-side="facebook"[\s\S]*data-duplicate-side="facebook"/);
});
