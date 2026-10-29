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
    const tag = html.match(new RegExp(`<div id="${id}" class="([^"]+)"`));
    assert.ok(tag && layers.some(layer => tag[1].split(' ').includes(layer.slice(1))), id);
  }
  // Eigene Angaben (kein Federn am Artikel-Panel) behalten Vorrang.
  assert.match(css, /\.overlay-panel \{[^}]*overscroll-behavior-y: none;/);
});

test('alle modalen Ebenen sperren den Seiten-Scrollbereich bis zum letzten Schließen', () => {
  assert.ok(start >= 0 && end > start);
  assert.match(css, /html\.modal-open,\s*html\.modal-open body \{\s*overflow: hidden;\s*overscroll-behavior: none;/);

  const classes = new Set();
  const overlays = Array.from({ length: 5 }, () => ({ hidden: true }));
  let dialogOpen = false;
  let notify;
  const document = {
    body: {},
    documentElement: { classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    } },
    querySelector(selector) {
      assert.equal(selector, 'dialog[open]');
      return dialogOpen ? {} : null;
    },
    getElementById(id) {
      assert.equal(id, 'img-fullscreen');
      return overlays[4];
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
  vm.runInNewContext(app.slice(start, end), {
    document, MutationObserver,
    $overlay: overlays[0], $loginOverlay: overlays[1],
    $scrapeOverlay: overlays[2], $ttsOverlay: overlays[3],
  });

  assert.equal(classes.has('modal-open'), false);
  for (const overlay of overlays) {
    overlay.hidden = false;
    notify();
    assert.equal(classes.has('modal-open'), true);
    overlay.hidden = true;
    notify();
    assert.equal(classes.has('modal-open'), false);
  }
  dialogOpen = true;
  notify();
  assert.equal(classes.has('modal-open'), true);
  overlays[0].hidden = false;
  notify();
  dialogOpen = false;
  notify();
  assert.equal(classes.has('modal-open'), true);
  overlays[0].hidden = true;
  notify();
  assert.equal(classes.has('modal-open'), false);
});
