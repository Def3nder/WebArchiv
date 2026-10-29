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
const start = app.indexOf('const modalOverlays =');
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

  const classes = new Set();
  // Login-, Scrape- und TTS-Fenster sind noch divs; Artikel & Co. sind Dialoge.
  const overlays = Array.from({ length: 3 }, () => ({ hidden: true }));
  const article = { open: false };
  let dialogOpen = false;
  let notify;
  const stackListeners = [];
  const floated = [];
  const document = {
    body: {},
    documentElement: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    querySelector(selector) {
      assert.equal(selector, 'dialog[open]');
      return dialogOpen ? {} : null;
    },
  };
  class MutationObserver {
    constructor(callback) { notify = callback; }
    observe(target, options) {
      assert.equal(target, document.body);
      assert.deepEqual(Array.from(options.attributeFilter), ['hidden', 'open']);
      assert.equal(options.subtree, true);
    }
  }
  const WebArchivLayers = {
    onChange(listener) { stackListeners.push(listener); },
    float(element) { floated.push(element); },
  };
  vm.runInNewContext(app.slice(start, end), {
    document, MutationObserver, WebArchivLayers,
    $overlay: article, $loginOverlay: overlays[0],
    $scrapeOverlay: overlays[1], $ttsOverlay: overlays[2],
  });
  assert.equal(stackListeners.length, 1, 'auch Änderungen am Ebenen-Stapel aktualisieren die Sperre');
  assert.deepEqual(floated, overlays, 'die div-Fenster liegen bis zu ihrem Umbau in der obersten Ebene');

  assert.equal(classes.has('modal-open'), false);
  for (const overlay of overlays) {
    overlay.hidden = false;
    notify();
    assert.equal(classes.has('modal-open'), true);
    overlay.hidden = true;
    notify();
    assert.equal(classes.has('modal-open'), false);
  }
  // Artikel offen: Dialog offen und overlay-open gesetzt.
  dialogOpen = true;
  article.open = true;
  stackListeners[0]();
  assert.equal(classes.has('modal-open'), true);
  assert.equal(classes.has('overlay-open'), true);
  overlays[0].hidden = false;
  notify();
  dialogOpen = false;
  article.open = false;
  notify();
  assert.equal(classes.has('modal-open'), true, 'Login-Fenster sperrt noch');
  assert.equal(classes.has('overlay-open'), false);
  overlays[0].hidden = true;
  notify();
  assert.equal(classes.has('modal-open'), false);
});
