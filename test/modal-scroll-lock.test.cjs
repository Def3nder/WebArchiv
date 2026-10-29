const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readStyles = require('./support/read-styles.cjs');
const readApp = require('./support/read-app.cjs');

const root = path.join(__dirname, '..');
const app = readApp();
const css = readStyles();
const start = app.indexOf('function syncModalPageScroll()');
const end = app.indexOf('\nconst dialogOpen', start);

test('Scrollbereiche aller Dialoge und Ebenen verketten nicht in die Seite dahinter', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const layers = ['dialog', '.overlay', '.scrape-overlay', '.login-overlay', '.img-fullscreen', '.book-reader'];
  const list = layers.map(layer => layer.replace('.', '\\.')).join(', ');
  assert.match(css, new RegExp(`:where\\(${list}\\),\\s*:where\\(${list}\\) \\* \\{\\s*overscroll-behavior: contain;\\s*\\}`));
  // Jede Ebene aus index.html trägt eine der Klassen; der Hörbuch-Reader und die Extras
  // entstehen per Skript mit class „book-reader“.
  for (const id of ['article-overlay', 'img-fullscreen', 'login-overlay', 'scrape-overlay', 'tts-overlay']) {
    const tag = html.match(new RegExp(`<(?:div|dialog) id="${id}" class="([^"]+)"`));
    assert.ok(tag && layers.some(layer => tag[1].split(' ').includes(layer.slice(1))), id);
  }
  // Eigene Angaben (kein Federn am Artikel-Panel) behalten Vorrang.
  assert.match(css, /\.overlay-panel \{[^}]*overscroll-behavior-y: none;/);
});

test('alle modalen Ebenen sperren den Seiten-Scrollbereich bis zum letzten Schließen', () => {
  assert.ok(start >= 0 && end > start);
  assert.match(css, /html\.modal-open,\s*html\.modal-open body \{\s*overflow: hidden;\s*overscroll-behavior: none;/);
  // Alle Ebenen sind Dialoge (auch Login, Scrape und TTS): ein offener Dialog sperrt die Seite.
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const id of ['article-overlay', 'img-fullscreen', 'login-overlay', 'scrape-overlay', 'tts-overlay']) {
    assert.match(html, new RegExp(`<dialog id="${id}" class="[^"]*\\bapp-layer\\b`), id);
  }

  const classes = new Set();
  const article = { open: false };
  let openDialogs = 0;
  let notify;
  const stackListeners = [];
  const document = {
    body: {},
    documentElement: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    querySelector(selector) {
      assert.equal(selector, 'dialog[open]');
      return openDialogs > 0 ? {} : null;
    },
  };
  class MutationObserver {
    constructor(callback) { notify = callback; }
    observe(target, options) {
      assert.equal(target, document.body);
      assert.deepEqual(Array.from(options.attributeFilter), ['open']);
      assert.equal(options.subtree, true);
    }
  }
  const WebArchivLayers = { onChange(listener) { stackListeners.push(listener); } };
  vm.runInNewContext(app.slice(start, end), { document, MutationObserver, WebArchivLayers, $overlay: article });
  assert.equal(stackListeners.length, 1, 'auch Änderungen am Ebenen-Stapel aktualisieren die Sperre');
  assert.equal(classes.has('modal-open'), false);

  // Artikel offen, darüber das TTS-Fenster; erst nach dem letzten Schließen frei.
  article.open = true; openDialogs = 1; stackListeners[0]();
  assert.equal(classes.has('modal-open'), true);
  assert.equal(classes.has('overlay-open'), true);
  openDialogs = 2; notify();
  openDialogs = 1; notify();
  assert.equal(classes.has('modal-open'), true);
  article.open = false; openDialogs = 0; notify();
  assert.equal(classes.has('modal-open'), false);
  assert.equal(classes.has('overlay-open'), false);
});
