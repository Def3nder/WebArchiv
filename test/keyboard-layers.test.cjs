const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const readApp = require('./support/read-app.cjs');
const pageSwipe = require('../public/page-swipe.js');

// Tastatur der Artikel- und Bildvollansicht (Ebenen am Stapel) und der Kachelansicht
// (Grundansicht). Die Reihenfolge Element → oberste Ebene → Grundansicht sowie der
// Schutz offener, nicht angemeldeter Dialoge prüft test/layer-stack.test.cjs.
const app = readApp();
const slice = (startMarker, endMarker) => {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return app.slice(start, end);
};
// Eine Funktion bis zu ihrer schließenden Klammer am Zeilenanfang.
const fn = name => {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n}', start) + 2);
};
const ARROW_KEY_CONTROLS = app.match(/const ARROW_KEY_CONTROLS = '([^']+)'/)[1];

// Ein Element, dessen closest() nur auf seinen eigenen Tag-Namen reagiert.
const element = tag => ({
  nodeType: 1,
  closest(selector) { return selector.split(',').map(part => part.trim()).includes(tag) ? this : null; },
  matches() { return false; },
});
const key = (key, target = element('div')) => ({ key, target, preventDefault() { this.prevented = true; } });

test('Artikelansicht: ←/→ blättern zum Nachbarartikel, Bedienelemente behalten die Pfeile', () => {
  const calls = [];
  const context = { pageSwipeMath: pageSwipe, Node: { ELEMENT_NODE: 1 }, ARROW_KEY_CONTROLS,
    navigateArticle: dir => calls.push(dir) };
  vm.runInNewContext(fn('articleLayerKey'), context);
  assert.equal(context.articleLayerKey(key('ArrowRight', element('button'))), true);
  assert.equal(context.articleLayerKey(key('ArrowLeft')), true);
  for (const tag of ['input', 'select', 'textarea', 'audio', 'video', '[role="slider"]']) {
    assert.equal(context.articleLayerKey(key('ArrowRight', element(tag))), true, `${tag}: nicht weiterreichen`);
  }
  assert.equal(context.articleLayerKey(key('ArrowUp')), false);
  assert.equal(context.articleLayerKey(key('Escape')), false, 'Escape übernimmt der Stapel (closeOverlay)');
  assert.deepEqual(calls, [1, -1]);
});

test('Bildvollansicht: ←/→ blättern durch die Bilder', () => {
  const steps = [];
  const context = { pageSwipeMath: pageSwipe, stepFullscreen: dir => steps.push(dir) };
  vm.runInNewContext(fn('fullscreenLayerKey'), context);
  const right = key('ArrowRight');
  assert.equal(context.fullscreenLayerKey(right), true);
  assert.equal(right.prevented, true);
  assert.equal(context.fullscreenLayerKey(key(' ')), false, 'Leertaste bleibt für den Prüfmodus');
  assert.deepEqual(steps, [1]);
});

function base({ dialog = false, scrape = false, login = true } = {}) {
  const calls = [];
  const context = {
    pageSwipeMath: pageSwipe, Node: { ELEMENT_NODE: 1 }, ARROW_KEY_CONTROLS,
    document: { querySelector: selector => (selector === 'dialog[open]' && dialog ? {} : null) },
    $scrapeOverlay: { hidden: !scrape }, $ttsOverlay: { hidden: true }, $loginOverlay: { hidden: login },
    currentUser: { role: 'user' }, state: { page: 2, pages: 3 },
    currentLayout: () => 'tall', isInfographicReviewMode: () => false,
    hideLogin: () => calls.push('hideLogin'),
    changeResultsPage: page => calls.push(['changeResultsPage', page]),
    WebArchivLayers: { setBase() {} },
  };
  vm.runInNewContext(slice('function layerAboveContentOpen()', 'WebArchivLayers.setBase(baseViewKey);'), context);
  return { calls, press: (...args) => context.baseViewKey(key(...args)) };
}

test('Kachelansicht: Pfeile blättern nur ohne offenes Fenster und außerhalb von Bedienelementen', () => {
  assert.deepEqual((() => { const f = base({ dialog: true }); f.press('ArrowRight'); return f.calls; })(), []);
  assert.deepEqual((() => { const f = base({ scrape: true }); f.press('ArrowRight'); return f.calls; })(), []);
  const f = base();
  f.press('ArrowRight', element('a'));
  f.press('ArrowRight', element('input'));
  assert.deepEqual(f.calls, []);
  f.press('ArrowRight');
  assert.deepEqual(f.calls, [['changeResultsPage', 3]]);
});

test('Kachelansicht: Escape schließt das Login-Fenster nur, wenn schon jemand angemeldet ist', () => {
  const f = base({ login: false });
  f.press('Escape');
  assert.deepEqual(f.calls, ['hideLogin']);
});

test('app.js meldet die Grundansicht am Stapel an und hat keinen eigenen keydown-Handler mehr', () => {
  assert.match(app, /WebArchivLayers\.setBase\(baseViewKey\);/);
  assert.match(app, /WebArchivLayers\.open\(\$overlay, \{ name: 'article', onEscape: closeOverlay, onKey: articleLayerKey \}\)/);
  assert.match(app, /WebArchivLayers\.open\(fullscreen, \{[\s\S]*?name: 'image', onEscape: closeImageFullscreen, onKey: fullscreenLayerKey/);
  assert.doesNotMatch(app, /document\.addEventListener\('keydown', e => \{\s*if \(e\.key === 'Escape'\)/);
});
