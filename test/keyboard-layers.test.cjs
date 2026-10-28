const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const readApp = require('./support/read-app.cjs');
const pageSwipe = require('../public/page-swipe.js');

const app = readApp();
const start = app.indexOf('function layerAboveContentOpen()');
const end = app.indexOf('});', app.indexOf('void changeResultsPage(targetPage);', start)) + 3;

// Ein Element, dessen closest() nur auf seinen eigenen Tag-Namen reagiert.
const element = tag => ({
  nodeType: 1,
  closest(selector) { return selector.split(',').map(part => part.trim()).includes(tag) ? this : null; },
  matches() { return false; },
});

function setup({ overlayOpen = false } = {}) {
  const calls = [];
  const layers = { dialog: false, tts: { hidden: true }, scrape: { hidden: true } };
  let handler;
  const imgFullscreen = { hidden: true };
  const document = {
    querySelector(selector) {
      assert.equal(selector, 'dialog[open]');
      return layers.dialog ? {} : null;
    },
    getElementById(id) {
      assert.equal(id, 'img-fullscreen');
      return imgFullscreen;
    },
    addEventListener(type, listener) {
      if (type === 'keydown') handler = listener;
    },
  };
  vm.runInNewContext(app.slice(start, end), {
    document, Node: { ELEMENT_NODE: 1 },
    pageSwipeMath: pageSwipe,
    $overlay: { hidden: !overlayOpen }, $imgFullscreen: imgFullscreen, $loginOverlay: { hidden: true },
    $scrapeOverlay: layers.scrape, $ttsOverlay: layers.tts,
    currentUser: { role: 'admin' },
    state: { page: 2, pages: 3 },
    currentLayout: () => 'tall',
    isInfographicReviewMode: () => false,
    closeImageFullscreen: () => calls.push('closeImageFullscreen'),
    closeOverlay: () => calls.push('closeOverlay'),
    hideLogin: () => calls.push('hideLogin'),
    stepFullscreen: dir => calls.push(['stepFullscreen', dir]),
    navigateArticle: dir => calls.push(['navigateArticle', dir]),
    changeResultsPage: page => calls.push(['changeResultsPage', page]),
  });
  assert.equal(typeof handler, 'function');
  const press = (key, target = element('div')) => handler({ key, target, preventDefault() {} });
  return { calls, layers, press };
}

test('Artikelansicht: Escape und Pfeile wirken nicht durch einen offenen Dialog hindurch', () => {
  const f = setup({ overlayOpen: true });
  f.layers.dialog = true; // z. B. Anbieterauswahl von „Audio erzeugen“
  f.press('Escape', element('button'));
  f.press('ArrowRight', element('input'));
  f.press('ArrowLeft', element('button'));
  assert.deepEqual(f.calls, []);

  f.layers.dialog = false;
  f.layers.tts.hidden = false;
  f.press('Escape');
  f.press('ArrowRight');
  assert.deepEqual(f.calls, []);
});

test('Artikelansicht: Pfeile blättern nicht aus Bedienelementen, die sie selbst nutzen', () => {
  const f = setup({ overlayOpen: true });
  for (const tag of ['input', 'select', 'textarea', 'audio', 'video', '[role="slider"]']) {
    f.press('ArrowRight', element(tag));
  }
  assert.deepEqual(f.calls, []);
  // Nach einem Klick auf einen Knopf der Detailansicht bleibt das Blättern erhalten.
  f.press('ArrowRight', element('button'));
  f.press('ArrowLeft');
  f.press('Escape');
  assert.deepEqual(f.calls, [['navigateArticle', 1], ['navigateArticle', -1], 'closeOverlay']);
});

test('Kachelansicht: Pfeile blättern nur ohne offene Ebene und außerhalb von Bedienelementen', () => {
  const f = setup();
  f.layers.dialog = true;
  f.press('ArrowRight');
  f.layers.dialog = false;
  f.layers.scrape.hidden = false;
  f.press('ArrowRight');
  f.layers.scrape.hidden = true;
  f.press('ArrowRight', element('a'));
  assert.deepEqual(f.calls, []);
  f.press('ArrowRight');
  assert.deepEqual(f.calls, [['changeResultsPage', 3]]);
});
