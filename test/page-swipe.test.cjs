const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const pageSwipe = require('../public/page-swipe.js');

function gesture(overrides = {}) {
  return {
    startX: 200,
    startY: 300,
    endX: 20,
    endY: 310,
    startTime: 1000,
    endTime: 1200,
    viewportWidth: 390,
    multiple: false,
    blocked: false,
    ...overrides,
  };
}

test('Browser-Script stellt die Wischberechnung vor app.js global bereit', () => {
  const context = { globalThis: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'page-swipe.js'), 'utf8'), context);
  assert.equal(typeof context.globalThis.WebArchivPageSwipe?.pageDirection, 'function');

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="page-swipe.js') < html.indexOf('<script src="app.js'));
});

test('Wischen nach links und rechts wechselt in die passende Richtung', () => {
  assert.equal(pageSwipe.pageDirection(gesture()), 1);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 370 })), -1);
});

test('Cursor rechts und links blättert in dieselbe Richtung wie die Wischgeste', () => {
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowRight' }), 1);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowLeft' }), -1);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowUp' }), 0);
});

test('Modifizierte oder bereits behandelte Cursortasten bleiben unberührt', () => {
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowRight', altKey: true }), 0);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowLeft', ctrlKey: true }), 0);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowRight', metaKey: true }), 0);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowLeft', shiftKey: true }), 0);
  assert.equal(pageSwipe.keyDirection({ key: 'ArrowRight', defaultPrevented: true }), 0);
});

test('Die äußersten 30 Pixel bleiben den Browsergesten vorbehalten', () => {
  assert.equal(pageSwipe.EDGE_INSET, 30);
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 29, endX: 370 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 30, endX: 370 })), -1);
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 361, endX: 20 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 360, endX: 20 })), 1);
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 29, endX: 370 }), { edgeInset: 20 }), 0);
});

test('Ein Start auf der rechten Kachel kann nach links umblättern', () => {
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 330, endX: 30 })), 1);
});

test('Der Seitenwechsel erfordert das Erreichen der äußersten 30 Pixel', () => {
  assert.equal(pageSwipe.TARGET_EDGE_ZONE, 30);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 30 })), 1);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 31 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 360 })), -1);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 359 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ endX: 31 }), { targetEdgeZone: 20 }), 0);
});

test('Langsame horizontale Gesten bleiben erlaubt', () => {
  assert.equal(pageSwipe.pageDirection(gesture({ endTime: 6000 })), 1);
});

test('Die erste klare Bewegung reserviert nur horizontale Gesten', () => {
  assert.equal(pageSwipe.movementIntent({ startX: 200, startY: 300, currentX: 199, currentY: 300 }), 'horizontal');
  assert.equal(pageSwipe.movementIntent({ startX: 200, startY: 300, currentX: 199, currentY: 302 }), 'vertical');
  assert.equal(pageSwipe.movementIntent({ startX: 200, startY: 300, currentX: 198, currentY: 298 }), 'vertical');
  assert.equal(pageSwipe.movementIntent({ startX: 200, startY: 300, currentX: 200, currentY: 300 }), 'pending');
});

test('Zu kurze, vertikale und blockierte Gesten werden ignoriert', () => {
  assert.equal(pageSwipe.pageDirection(gesture({ startX: 100, endX: 30 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ endY: 500 })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ multiple: true })), 0);
  assert.equal(pageSwipe.pageDirection(gesture({ blocked: true })), 0);
});

test('Auch die Listenansicht reserviert horizontale Inhaltsgesten', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  assert.match(css, /body\.layout-list \.article-grid\s*\{[^}]*touch-action:\s*pan-y;/s);
});

test('Die Browserintegration übernimmt horizontale touchmove-Ereignisse aktiv', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /\$app\.addEventListener\('touchmove',[\s\S]*?event\.preventDefault\(\);[\s\S]*?passive:\s*false/);
  assert.match(app, /addEventListener\('touchcancel',\s*finishPageSwipe/);
  assert.doesNotMatch(app, /pageSwipeBlockedTarget\(target\)[\s\S]{0,300}card-gallery/);
  assert.match(app, /Reicht die Bewegung bis an den gegenüberliegenden Fensterrand[\s\S]*?pageSwipeMath\?\.pageDirection/);
});

test('Die Browserintegration blättert per Cursortaste nur in der Kachelansicht', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /pageSwipeMath\?\.keyDirection\(e\)/);
  assert.match(app, /currentLayout\(\) === 'list'[\s\S]*?state\.page \+ dir[\s\S]*?changeResultsPage\(targetPage\)/);
  assert.match(app, /input, textarea, select, button, a, audio, video/);
});
