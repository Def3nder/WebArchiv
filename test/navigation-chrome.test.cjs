const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

test('Kopf und Filter bilden eine gemeinsam verschiebbare Navigation', () => {
  assert.match(HTML, /id="navigation-chrome"[\s\S]*class="site-header"[\s\S]*id="filter-bar"/);
  assert.match(CSS, /\.navigation-chrome\s*\{[^}]*transition:\s*none/s);
  assert.match(CSS, /\.navigation-chrome\.is-returning\s*\{[^}]*transition:\s*transform 180ms/s);
  assert.match(CSS, /prefers-reduced-motion/);
});

test('Herunterscrollen verschiebt direkt, nur die Rückkehr hat eine Animation', () => {
  assert.match(APP, /NAV_SCROLL_THRESHOLD = 24/);
  assert.match(APP, /setNavigationChromeOffset\(navigationOffset \+ delta\)/);
  assert.match(APP, /showNavigationChrome\(true\)/);
  assert.match(APP, /requestAnimationFrame\(updateNavigationChrome\)/);
});

test('Aktive Navigation und Dialoge bleiben sichtbar', () => {
  assert.match(APP, /active === \$searchInput/);
  assert.match(APP, /!\$adminMenu\.hidden/);
  assert.match(APP, /dialog\[open\]/);
  assert.match(APP, /navigationVisibleUntil = Date\.now\(\)/);
  assert.match(APP, /function scrollToResults[\s\S]*showNavigationChrome\(true\)/);
});
