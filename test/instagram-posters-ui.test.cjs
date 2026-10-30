const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readStyles = require('./support/read-styles.cjs');
const readApp = require('./support/read-app.cjs');

const root = path.join(__dirname, '..');
const app = readApp();
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = readStyles();
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const review = fs.readFileSync(path.join(root, 'public', 'infographic-review.js'), 'utf8');
// Prüfmodus: Logik in infographic-review.js, Einhängepunkte in app.js.
const reviewUi = app + review;

test('Infografiken-Autor schaltet zyklisch zwischen allen, Postern und klassischen Infografiken', () => {
  assert.match(html, /data-instagram-icon/);
  assert.match(html, /data-infographic-icon/);
  assert.match(app, /state\.author === INFOGRAPHICS_AUTHOR/);
  assert.match(app, /const order = \['all', 'posters', 'classic'\]/);
  assert.match(app, /if \(previousAuthor !== state\.author\) setInfographicFilter\('all'\)/);
  assert.match(app, /if \(state\.author === INFOGRAPHICS_AUTHOR\) setInfographicFilter\(nextInfographicFilter\(\)\)/);
  assert.match(app, /\[data-instagram-icon\][\s\S]*!infographicMode \|\| classicMode/);
  assert.match(app, /\[data-infographic-icon\][\s\S]*!classicMode/);
  assert.match(app, /infographicFilter: state\.author === INFOGRAPHICS_AUTHOR \? state\.infographicFilter : 'all'/);
  assert.match(app, /qs\.set\('infographic', 'poster'\)/);
  assert.match(app, /qs\.set\('infographic', 'classic'\)/);
  assert.match(app, /posters: 'Nur klassische Infografiken anzeigen'/);
  assert.match(app, /classic: 'Alle Infografiken anzeigen'/);
  assert.match(css, /\.telegram-btn\.is-instagram \{[\s\S]*width: 34px;[\s\S]*height: 30px;[\s\S]*border-color: transparent;/);
  assert.match(css, /\.instagram-filter-icon,[\s\S]*\.infographic-filter-icon \{[\s\S]*width: 28px;[\s\S]*height: 28px;/);
  assert.match(css, /\.telegram-btn\.is-instagram \.instagram-icon-bg \{[\s\S]*fill: var\(--text-muted\)/);
  assert.match(css, /\.telegram-btn\.is-instagram\.active \.instagram-icon-bg \{ fill: url\(#instagram-filter-gradient\); \}/);
  assert.match(html, /radialGradient id="instagram-filter-gradient"/);
  assert.match(html, /linearGradient id="infographic-filter-gradient"[\s\S]*#123e4a[\s\S]*#26756f[\s\S]*#63aaa0/);
  assert.match(server, /if \(instagramPosterMode\) filtered = filtered\.filter\(a => a\.instagramPoster && a\.ownImage\)/);
  assert.match(server, /if \(classicInfographicMode\) filtered = filtered\.filter\(a => !a\.instagramPoster && a\.ownImage\)/);
  assert.match(server, /if \(article\.author !== INFOGRAPHICS_AUTHOR\) return exposed;/);
});

test('Jede Infografik zeigt den Autor ihres Hauptartikels, sonst Infografiken', () => {
  assert.match(server, /function exposeArticleForUser\(article, user\)[\s\S]*if \(article\.author !== INFOGRAPHICS_AUTHOR\) return exposed;[\s\S]*displayAuthor: articleDisplayAuthor\(article, visibleGroupAnchor\(article, user\)\)/);
  const articleIndex = fs.readFileSync(path.join(root, 'lib', 'article-index.cjs'), 'utf8');
  assert.match(articleIndex, /function articleDisplayAuthor\(article, linkedArticle = null\)[\s\S]*linkedArticle\?\.author \|\| INFOGRAPHICS_AUTHOR/);
  assert.match(server, /map\(tile => \(\{ \.\.\.exposeGroupForUser\(tile, user\), bookmarked:/);
  assert.match(app, /function renderCard\(article, idx\) \{[\s\S]*const author = article\.displayAuthor \|\| article\.author;[\s\S]*authorHue\(author\)/);
  assert.match(app, /function renderInstagramPosterCard\(poster, idx\) \{[\s\S]*const author = poster\.displayAuthor \|\| INFOGRAPHICS_AUTHOR/);
  assert.match(review, /function renderInfographicReviewCard\(poster, idx\) \{[\s\S]*const author = poster\.displayAuthor \|\| INFOGRAPHICS_AUTHOR/);
  assert.match(app, /class="author-badge"[^>]*>\$\{esc\(author\.replace\(\/_\/g,' '\)\)\}<\/span>/);
});

test('Listenansicht setzt den Infografikfilter zurück und deaktiviert den Symbolbutton', () => {
  assert.match(app, /const disabled = infographicMode && currentLayout\(\) === 'list'/);
  assert.match(app, /\$telegramBtn\.disabled = disabled/);
  assert.match(app, /layout === 'list'[\s\S]*state\.author === INFOGRAPHICS_AUTHOR[\s\S]*state\.infographicFilter !== 'all'/);
  assert.match(app, /if \(resetInfographicFilter\)[\s\S]*setInfographicFilter\('all'\);[\s\S]*state\.page = 1/);
  assert.match(app, /groupMode\(\) !== wasGrouped \|\| resetInfographicFilter/);
  assert.match(css, /\.telegram-btn\.is-instagram:disabled \{[\s\S]*opacity: \.34;[\s\S]*filter: grayscale\(1\);[\s\S]*cursor: not-allowed/);
});

test('Poster-Kacheln zeigen nur Bild, Autoren- und Datumsbadge im 9:16-Contain-Format', () => {
  assert.match(app, /class="card instagram-poster-card/);
  assert.match(app, /instagram-poster-author/);
  assert.match(app, /instagram-poster-date/);
  assert.match(css, /\.instagram-poster-grid \.instagram-poster-card[\s\S]*aspect-ratio: 9 \/ 16/);
  assert.match(css, /\.instagram-poster-image img[\s\S]*object-fit: contain/);
  assert.match(app, /function responsiveDateFormats\(d\)[\s\S]*formatDate\(d\)[\s\S]*formatDateShort\(d\)[\s\S]*`\$\{m\}\.\$\{y\}`[\s\S]*y \|\| d/);
  assert.match(app, /function responsiveDateFits\(date\)[\s\S]*date\.scrollWidth <= date\.clientWidth \+ 1/);
  assert.match(app, /new ResizeObserver\(updateResponsiveDates\)/);
  assert.match(app, /responsiveDateMarkup\(poster\.date, 'instagram-poster-badge instagram-poster-date'\)/);
});

test('Klassische Infografiken verwenden dieselben 9:16-Bildkacheln und Badges wie Poster', () => {
  assert.match(app, /isInstagramPosterMode\(\) \|\| isClassicInfographicMode\(\)/);
  assert.match(app, /classic \? ' classic-infographic-card' : ''/);
  assert.match(app, /classic \? ' classic-infographic-grid' : ''/);
  assert.match(css, /\.instagram-poster-grid \.instagram-poster-card,[\s\S]*aspect-ratio: 9 \/ 16/);
  assert.doesNotMatch(css, /classic-infographic-grid[\s\S]{0,300}aspect-ratio:/);
  assert.match(app, /instagram-poster-author/);
  assert.match(app, /instagram-poster-date/);
});

test('Poster öffnen die begrenzte Vollbildliste ohne sichtbare Navigation', () => {
  assert.match(app, /Number\(posterIndex\), null, true, card/);
  assert.match(app, /function fullscreenLayerKey\(event\)[\s\S]*stepFullscreen\(dir\)/);
  assert.doesNotMatch(html, /img-fullscreen-(?:prev|next)/);
});

test('Admin-Prüfmodus sammelt Poster-Markierungen seitenübergreifend und speichert sie gemeinsam', () => {
  assert.match(html, /data-action="review-infographics"[^>]*>Infografiken prüfen</);
  assert.match(html, /id="infographic-review-save"/);
  assert.match(reviewUi, /baseline: new Map\(\)[\s\S]*changes: new Map\(\)/);
  assert.match(reviewUi, /function setInfographicReviewMark\([\s\S]*review\.changes\.set/);
  assert.match(reviewUi, /expected: review\.baseline\.get\(id\)/);
  assert.match(reviewUi, /apiFetch\('\/api\/infographic-review'/);
  assert.match(reviewUi, /review\.changes\.clear\(\);[\s\S]*await leaveInfographicReview\(\{ discard: true \}\)/);
  assert.match(reviewUi, /count \? `Speichern \(\$\{count\}\)` : 'Abbrechen'/);
  assert.match(reviewUi, /if \(review\.changes\.size\) void saveInfographicReview\(\);[\s\S]*else void leaveInfographicReview\(\);/);
  assert.match(reviewUi, /infographicReview: isInfographicReviewMode\(\)/);
  assert.match(server, /infographicReview === '1'[\s\S]*user\.role !== 'admin'/);
  assert.match(server, /infographicReviewMode[\s\S]*a\.author === INFOGRAPHICS_AUTHOR && a\.ownImage/);
});

test('Prüfkacheln trennen große Checkbox-Touchfläche und Vollbildöffnung', () => {
  assert.match(reviewUi, /class="instagram-poster-image infographic-review-image"/);
  assert.match(reviewUi, /data-review-poster-id/);
  assert.match(css, /\.poster-review-toggle \{[\s\S]*min-width: 48px;[\s\S]*min-height: 48px;/);
  assert.match(css, /\.infographic-review-card\.is-poster[\s\S]*#ffd600[\s\S]*#ff0169[\s\S]*#7638fa/);
  assert.match(reviewUi, /openGalleryFullscreen\([\s\S]*state\.currentItems\.map\(item => item\.id\)/);
});

test('Fokussierte Poster-Checkbox blockiert die Seitennavigation per Cursortaste nicht', () => {
  assert.match(app, /const reviewCheckbox = isInfographicReviewMode\(\)[\s\S]*interactive\?\.matches\('\[data-review-poster-id\]'\)/);
  assert.match(app, /\(interactive && !reviewCheckbox && !closedMenuTrigger\)/);
});

test('Poster-Markierung ist auch in der Vollbildansicht verfügbar', () => {
  assert.match(html, /id="img-fullscreen-poster-toggle"/);
  assert.match(html, /id="img-fullscreen-poster-checkbox"/);
  assert.match(reviewUi, /fsGallery\.reviewIds\[index\]/);
  assert.match(reviewUi, /\$fullscreenPosterCheckbox\?\.addEventListener\('change'/);
  // Leertaste über die Tastatur der Bildvollansicht (Ebenen-Stapel), kein eigener document-Handler.
  assert.match(reviewUi, /fullscreenKey: infographicReviewFullscreenKey/);
  assert.doesNotMatch(reviewUi, /document\.addEventListener\('keydown'/);
  const start = reviewUi.indexOf('function infographicReviewFullscreenKey(');
  const source = reviewUi.slice(start, reviewUi.indexOf('\n}', start) + 2);
  const marks = [];
  const checkbox = { checked: false, dataset: { reviewId: 'bild-1' } };
  const context = {
    Node: { ELEMENT_NODE: 1 }, isInfographicReviewMode: () => true,
    $fullscreenPosterToggle: { hidden: false }, $fullscreenPosterCheckbox: checkbox,
    setInfographicReviewMark: (id, value) => marks.push([id, value]),
  };
  vm.runInNewContext(source, context);
  const plain = { nodeType: 1, closest: () => null };
  const press = (init = {}) => {
    const event = { key: ' ', code: 'Space', target: plain, repeat: false, prevented: false,
      preventDefault() { this.prevented = true; }, ...init };
    return [context.infographicReviewFullscreenKey(event), event.prevented];
  };
  assert.deepEqual(press(), [true, true]);
  assert.deepEqual(press({ repeat: true }), [true, true], 'gehaltene Taste wechselt nicht mehrfach');
  assert.deepEqual(press({ target: checkbox }), [false, false], 'Checkbox bedient sich selbst');
  assert.deepEqual(press({ target: { nodeType: 1, closest: () => ({}) } }), [false, false], 'Bedienelemente behalten die Taste');
  assert.deepEqual(press({ key: 'ArrowRight', code: 'ArrowRight' }), [false, false]);
  context.isInfographicReviewMode = () => false;
  assert.deepEqual(press(), [false, false], 'außerhalb des Prüfmodus nichts');
  assert.deepEqual(marks, [['bild-1', true]]);
  assert.match(reviewUi, /beforeunload[\s\S]*review\.changes\.size/);
});


test('Prüfmodus liegt im Admin-Skript infographic-review.js, app.js hält nur Platzhalter', () => {
  for (const name of ['enterInfographicReview', 'leaveInfographicReview', 'saveInfographicReview', 'setInfographicReviewMark', 'renderInfographicReviewCard']) {
    assert.doesNotMatch(app, new RegExp(`function ${name}[(]`), `${name} gehört nicht mehr in app.js`);
    assert.match(review, new RegExp(`function ${name}[(]`));
  }
  assert.match(app, /const infographicReview = \{[\s\S]*?active: false,[\s\S]*?renderCard: \(\) => '',/);
  assert.match(review, /Object\.assign\(infographicReview, \{[\s\S]*?renderCard: renderInfographicReviewCard,/);
  assert.match(review, /adminHooks\.actions\['review-infographics'\]/);
  assert.match(html, /<script src="infographic-review\.js(?:\?v=[a-f0-9]+)?" data-admin-asset><\/script>/);
  assert.match(server, /'\/infographic-review\.js',/);
});
