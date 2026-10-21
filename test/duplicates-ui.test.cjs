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
  assert.match(html, /vendor\/duplicate-diff\.bundle\.js\?v=7[\s\S]*duplicates\.js\?v=17/);
  assert.match(html, /id="duplicate-detail-dialog"[\s\S]*id="duplicate-detail-content"/);
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
  assert.match(ui, /<details class="duplicate-infographic-gallery"/);
  assert.match(ui, /duplicateDetailContent\.innerHTML/);
  assert.match(ui, /duplicateDetailDialog\.showModal\(\)/);
  assert.match(css, /\.duplicate-detail\s*\{[\s\S]*grid-template-rows: auto auto minmax\(0, 1fr\) auto auto/);
  assert.match(css, /\.duplicate-comparison-scroll\s*\{[^}]*overflow-y: auto/);
  assert.match(css, /\.duplicate-detail-header-grid h3\s*\{[^}]*-webkit-line-clamp: 3/);
  assert.match(css, /\.duplicate-infographic-gallery\[open\]\s*\{ height: 122px;/);
  assert.match(ui, /duplicateDetailContent\.addEventListener\('toggle'[\s\S]*other\.open = gallery\.open/);
  assert.match(ui, /<details class="duplicate-migration-note">[\s\S]*<summary>/);
  assert.doesNotMatch(css, /\.duplicate-migration-note ul \{ display: none;/);
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

test('Filter sind kombinierbar, Auswahl bleibt gespeichert und doppelte Quellen-Ziele werden vermieden', () => {
  const ui = read('public/duplicates.js');
  const server = read('server.js');
  assert.match(ui, /filters: \{ score: 'all', infographics: 'all', authors: null \}/);
  assert.match(ui, /localStorage\.setItem\(DUPLICATE_SELECTION_KEY/);
  assert.match(ui, /scoreMatch[\s\S]*infographicMatch[\s\S]*return duplicateAuthorMatches\(item\) && scoreMatch && infographicMatch/);
  assert.match(ui, /facebookId[\s\S]*duplicateUi\.selection\.delete/);
  assert.match(server, /Ein Quellartikel darf nur einmal in einer Sammelaktion vorkommen/);
});

test('Autorfilter bietet alle konfigurierten Quellen zur Mehrfachauswahl auf jedem Tab', () => {
  const html = read('public/index.html');
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(html, /id="duplicate-author-filter"[\s\S]*id="duplicate-author-options"/);
  assert.match(ui, /duplicateUi\.data\.config\?\.facebookAuthors/);
  assert.match(html, /data-duplicate-filter-menu="authors"[\s\S]*data-duplicate-filter-menu="score"[\s\S]*data-duplicate-filter-menu="infographics"/);
  assert.match(html, /class="header-menu-dropdown" role="menu"/);
  assert.match(ui, /authors\.map\(author => `<button type="button" class="header-menu-item" role="menuitemcheckbox"/);
  assert.match(ui, /menu\.addEventListener\('click'/);
  assert.match(ui, /duplicateUi\.filters\[root\.dataset\.duplicateFilterMenu\] = item\.dataset\.duplicateFilterValue/);
  assert.match(ui, /duplicateVisibleItems\(duplicateUi\.tab\)/);
  assert.match(ui, /duplicateSelectionTools\.hidden = !pending/);
  assert.match(css, /\.duplicate-filter-menu \.header-menu-dropdown \{/);
  assert.match(html, /styles\.css\?v=141/);
});

test('Mobilgeräte nutzen System-Selects; Autorenauswahl bleibt mehrfach kombinierbar', () => {
  const html = read('public/index.html');
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  for (const id of ['author', 'score', 'infographic']) {
    assert.match(html, new RegExp(`<select id="duplicate-${id}-native" class="filter-select filter-menu-native duplicate-filter-native"`));
  }
  assert.match(html, /class="header-menu filter-header-menu duplicate-filter-menu"/);
  assert.match(css, /\.header-menu\.filter-header-menu \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 601px\) and \(hover: hover\) and \(pointer: fine\)/);
  assert.match(ui, /duplicateAuthorNative\.addEventListener\('change'/);
  assert.match(ui, /new Option\('Alle Autoren auswählen', 'all'\)/);
  assert.match(ui, /new Option\('Keine Autoren auswählen', 'none'\)/);
  assert.match(ui, /duplicateUi\.filters\.authors = selected\.size === authors\.length \? null : selected/);
  assert.match(ui, /function sizeDuplicateNativeFilter\(select\)[\s\S]*measureText\(label\)/);
});

test('Dublettenfilter folgen den Beschriftungseinstellungen und der Kopf reagiert auf Listenscrollen', () => {
  const html = read('public/index.html');
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(html, /id="duplicate-chrome"[\s\S]*id="duplicate-content"/);
  assert.match(css, /body\[data-filter-labels="hidden"\] \.duplicate-filter-caption \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.duplicate-filter-caption \{ display: none; \}/);
  assert.match(css, /\.duplicate-filter-menu \.filter-menu-trigger \{ width: max-content;/);
  assert.match(css, /\.duplicate-filter-menu \.header-menu-dropdown \{[^}]*width: max-content; min-width: 100%;/);
  assert.match(ui, /DUPLICATE_CHROME_SCROLL_THRESHOLD = 24/);
  assert.match(ui, /duplicateContent\.addEventListener\('scroll'/);
  assert.match(ui, /direction > 0[\s\S]*setDuplicateChromeOffset\(duplicateChromeOffset \+ delta\)/);
  assert.match(ui, /duplicateChromeTravel >= DUPLICATE_CHROME_SCROLL_THRESHOLD\) showDuplicateChrome\(true\)/);
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

test('Mobil wechselt nur Artikelkopf und Infografiken; der einspaltige Diff bleibt sichtbar', () => {
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(ui, /duplicateUi\.tab === 'pending' && !duplicateUi\.detail/);
  assert.match(ui, /data-mobile-side="\$\{duplicateUi\.mobileSide\}"/);
  assert.match(ui, /data-side="blog"[\s\S]*data-side="facebook"/);
  assert.match(ui, /aria-label="Artikelkopf und Infografiken"/);
  assert.match(css, /\.duplicate-diff-line \{ grid-template-columns: 2\.2rem 2\.2rem 1\.15rem/);
  assert.doesNotMatch(css, /data-mobile-side="blog"\] \.duplicate-comparison-cell/);
  assert.match(ui, /duplicateDetailContent\.querySelector\('\.duplicate-detail'\)\.dataset\.mobileSide/);
});

test('Prüfansicht kehrt bei Auswahl, Ignorieren und Escape in die Trefferliste zurück', () => {
  const ui = read('public/duplicates.js');
  assert.match(ui, /duplicateDetailDialog\.addEventListener\('close'[\s\S]*renderDuplicateList\(\{ restoreScroll: true \}\)/);
  assert.match(ui, /action === 'toggle-selection'[\s\S]*setDuplicateSelected[\s\S]*closeDuplicateDetail\(\)/);
  assert.match(ui, /action === 'ignore'[\s\S]*closeDuplicateDetail\(\);[\s\S]*mutateDuplicate/);
  assert.match(ui, /function closeTopDuplicateDialog\(\)[\s\S]*duplicateImageViewer\.open[\s\S]*duplicateDetailDialog\.open[\s\S]*duplicateDialog\.open/);
  assert.match(ui, /document\.addEventListener\('keydown'[\s\S]*event\.key !== 'Escape'[\s\S]*event\.preventDefault\(\)[\s\S]*closeTopDuplicateDialog\(\)/);
});

test('Volltext und nur Unterschiede lassen sich im Prüfdialog umschalten', () => {
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(ui, /onlyDifferences: true/);
  assert.match(ui, /data-duplicate-action="toggle-differences" aria-pressed="\$\{duplicateUi\.onlyDifferences\}"/);
  assert.match(ui, /function toggleDuplicateDiffMode\(\)[\s\S]*onlyDifferences = !duplicateUi\.onlyDifferences[\s\S]*duplicateComparisonRows\(pair\)/);
  assert.match(ui, /duplicateTextDiff\.renderUnifiedRows\([\s\S]*renderedBlocksFromHtml\(pair\.blog\.bodyHtml\)[\s\S]*renderedBlocksFromHtml\(pair\.facebook\.bodyHtml\)/);
  assert.match(ui, /<details class="duplicate-diff-fold">[\s\S]*unveränderte/);
  assert.match(ui, /duplicate-diff-line is-\$\{row\.kind\}/);
  assert.match(css, /\.duplicate-diff-line\.is-removed \{[^}]*background: color-mix/);
  assert.match(css, /\.duplicate-diff-line\.is-added \{[^}]*background: color-mix/);
  assert.match(css, /\.duplicate-diff-toggle\[aria-pressed="true"\]/);
});

test('100-Prozent-Filter nimmt nur echte normalisierte Textgleichheit und rundet andere Werte nicht auf 100', () => {
  const ui = read('public/duplicates.js');
  assert.match(ui, /duplicateUi\.filters\.score === '100'\s*\? !!item\.exact/);
  assert.match(ui, /similarity >= 1 \? '< 100 %'/);
  assert.match(ui, /Wortfolge gleich/);
});

test('alle drei Dublettendialoge verwenden das sichtbare Ziehen und Rückfedern der Hauptansicht', () => {
  const ui = read('public/duplicates.js');
  const app = read('public/app.js');
  assert.match(ui, /for \(const dialog of \[duplicateDialog, duplicateDetailDialog, duplicateImageViewer\]\)/);
  assert.match(ui, /enablePullToClose\(\{[\s\S]*scroller: dialog,[\s\S]*moving: dialog,[\s\S]*scrolledWithin\(event\.target, dialog\)/);
  assert.match(app, /const PULL_CLOSE_DISTANCE = 120/);
  assert.match(app, /moving\.style\.transform = `translateY\(\$\{offset\}px\)`/);
  assert.match(app, /dy < PULL_CLOSE_DISTANCE\) \{ reset\(true\); return; \}/);
});

test('offene Dublettendialoge sperren die Seite dahinter, nicht ihre inneren Scrollbereiche', () => {
  const ui = read('public/duplicates.js');
  const css = read('public/styles.css');
  assert.match(ui, /function syncDuplicatePageScroll\(\)[\s\S]*duplicateDialogs\.some\(dialog => dialog\.open\)/);
  assert.match(ui, /duplicateImageViewer\.showModal\(\);\s*syncDuplicatePageScroll\(\)/);
  assert.match(ui, /duplicateDetailDialog\.showModal\(\);\s*syncDuplicatePageScroll\(\)/);
  assert.match(ui, /duplicateDialog\.showModal\(\);\s*syncDuplicatePageScroll\(\)/);
  assert.match(ui, /dialog\.addEventListener\('close', syncDuplicatePageScroll\)/);
  assert.match(css, /html\.duplicate-modal-open,\s*html\.duplicate-modal-open body,/);
  assert.match(css, /\.duplicate-content \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.duplicate-comparison-scroll \{[^}]*overflow-y: auto;/);
});
