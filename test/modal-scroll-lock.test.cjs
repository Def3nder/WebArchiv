const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const start = app.indexOf('const modalOverlays =');
const end = app.indexOf('\nconst dialogOpen', start);

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
