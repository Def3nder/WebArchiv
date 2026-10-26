const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

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
  assert.match(server, /!instagramPosterMode && !classicInfographicMode && !infographicReviewMode/);
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
  assert.match(app, /if \(!\$imgFullscreen\.hidden\)[\s\S]*stepFullscreen\(dir\)/);
  assert.doesNotMatch(html, /img-fullscreen-(?:prev|next)/);
});

test('Admin-Prüfmodus sammelt Poster-Markierungen seitenübergreifend und speichert sie gemeinsam', () => {
  assert.match(html, /data-action="review-infographics"[^>]*>Infografiken prüfen</);
  assert.match(html, /id="infographic-review-save"/);
  assert.match(app, /baseline: new Map\(\)[\s\S]*changes: new Map\(\)/);
  assert.match(app, /function setInfographicReviewMark\([\s\S]*infographicReview\.changes\.set/);
  assert.match(app, /expected: infographicReview\.baseline\.get\(id\)/);
  assert.match(app, /apiFetch\('\/api\/infographic-review'/);
  assert.match(app, /infographicReview\.changes\.clear\(\);[\s\S]*await leaveInfographicReview\(\{ discard: true \}\)/);
  assert.match(app, /count \? `Speichern \(\$\{count\}\)` : 'Abbrechen'/);
  assert.match(app, /if \(infographicReview\.changes\.size\) void saveInfographicReview\(\);[\s\S]*else void leaveInfographicReview\(\);/);
  assert.match(app, /infographicReview: isInfographicReviewMode\(\)/);
  assert.match(server, /infographicReview === '1'[\s\S]*user\.role !== 'admin'/);
  assert.match(server, /infographicReviewMode[\s\S]*a\.author === INFOGRAPHICS_AUTHOR && a\.ownImage/);
});

test('Prüfkacheln trennen große Checkbox-Touchfläche und Vollbildöffnung', () => {
  assert.match(app, /class="instagram-poster-image infographic-review-image"/);
  assert.match(app, /data-review-poster-id/);
  assert.match(css, /\.poster-review-toggle \{[\s\S]*min-width: 48px;[\s\S]*min-height: 48px;/);
  assert.match(css, /\.infographic-review-card\.is-poster[\s\S]*#ffd600[\s\S]*#ff0169[\s\S]*#7638fa/);
  assert.match(app, /openGalleryFullscreen\([\s\S]*state\.currentItems\.map\(item => item\.id\)/);
});

test('Fokussierte Poster-Checkbox blockiert die Seitennavigation per Cursortaste nicht', () => {
  assert.match(app, /const reviewCheckbox = isInfographicReviewMode\(\)[\s\S]*interactive\?\.matches\('\[data-review-poster-id\]'\)/);
  assert.match(app, /\(interactive && !reviewCheckbox\)/);
});

test('Poster-Markierung ist auch in der Vollbildansicht verfügbar', () => {
  assert.match(html, /id="img-fullscreen-poster-toggle"/);
  assert.match(html, /id="img-fullscreen-poster-checkbox"/);
  assert.match(app, /fsGallery\.reviewIds\[index\]/);
  assert.match(app, /\$fullscreenPosterCheckbox\.addEventListener\('change'/);
  assert.match(app, /\(e\.key === ' ' \|\| e\.code === 'Space'\)[\s\S]*isInfographicReviewMode\(\)[\s\S]*!\$fullscreenPosterToggle\.hidden/);
  assert.match(app, /if \(e\.target === \$fullscreenPosterCheckbox\) return;[\s\S]*setInfographicReviewMark\(id, !\$fullscreenPosterCheckbox\.checked\)/);
  assert.match(app, /e\.preventDefault\(\);[\s\S]*if \(e\.repeat\) return;/);
  assert.match(app, /beforeunload[\s\S]*infographicReview\.changes\.size/);
});

