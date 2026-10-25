const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('Infografiken-Autor schaltet den Header-Button auf einen temporären Instagram-Filter um', () => {
  assert.match(html, /data-instagram-icon/);
  assert.match(app, /state\.author === INFOGRAPHICS_AUTHOR/);
  assert.match(app, /if \(previousAuthor !== state\.author\) setInstagramPosterFilter\(false\)/);
  assert.match(app, /if \(state\.author === INFOGRAPHICS_AUTHOR\) setInstagramPosterFilter/);
  assert.match(app, /toggleAttribute\('hidden', instagramMode\)/);
  assert.match(app, /toggleAttribute\('hidden', !instagramMode\)/);
  assert.match(app, /instagramPosters: isInstagramPosterMode\(\)/);
  assert.match(app, /qs\.set\('instagram', '1'\)/);
  assert.match(app, /isInstagramPosterMode\(\) \? 'Poster' : 'Artikel'/);
  assert.match(css, /\.telegram-btn\.is-instagram \{[\s\S]*width: 34px;[\s\S]*height: 30px;[\s\S]*border-color: transparent;/);
  assert.match(css, /\.instagram-filter-icon \{[\s\S]*width: 28px;[\s\S]*height: 28px;/);
  assert.match(css, /\.telegram-btn\.is-instagram \.instagram-icon-bg \{[\s\S]*fill: var\(--text-muted\)/);
  assert.match(css, /\.telegram-btn\.is-instagram\.active \.instagram-icon-bg \{ fill: url\(#instagram-filter-gradient\); \}/);
  assert.match(html, /radialGradient id="instagram-filter-gradient"/);
  assert.match(server, /if \(instagramPosterMode\) filtered = filtered\.filter\(a => a\.instagramPoster && a\.ownImage\)/);
});

test('Poster-Kacheln zeigen nur Bild, Autoren- und Datumsbadge im 9:16-Contain-Format', () => {
  assert.match(app, /class="card instagram-poster-card"/);
  assert.match(app, /instagram-poster-author/);
  assert.match(app, /instagram-poster-date/);
  assert.match(css, /\.instagram-poster-grid \.instagram-poster-card[\s\S]*aspect-ratio: 9 \/ 16/);
  assert.match(css, /\.instagram-poster-image img[\s\S]*object-fit: contain/);
  assert.match(app, /function responsiveDateFormats\(d\)[\s\S]*formatDate\(d\)[\s\S]*formatDateShort\(d\)[\s\S]*`\$\{m\}\.\$\{y\}`[\s\S]*y \|\| d/);
  assert.match(app, /function responsiveDateFits\(date\)[\s\S]*date\.scrollWidth <= date\.clientWidth \+ 1/);
  assert.match(app, /new ResizeObserver\(updateResponsiveDates\)/);
  assert.match(app, /responsiveDateMarkup\(poster\.date, 'instagram-poster-badge instagram-poster-date'\)/);
});

test('Poster öffnen die begrenzte Vollbildliste ohne sichtbare Navigation', () => {
  assert.match(app, /Number\(posterIndex\), null, true, card/);
  assert.match(app, /if \(!\$imgFullscreen\.hidden\)[\s\S]*stepFullscreen\(dir\)/);
  assert.doesNotMatch(html, /img-fullscreen-(?:prev|next)/);
});

