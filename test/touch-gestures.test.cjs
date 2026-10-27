const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('Touch-Gesten liegen in touch-gestures.js und werden vor app.js geladen', () => {
  const gestures = read('public/touch-gestures.js');
  const app = read('public/app.js');
  const html = read('public/index.html');
  for (const name of ['pinchZoomed', 'hasActiveSelection', 'showScrubBubble', 'enableScrubBar', 'enablePullToClose']) {
    assert.match(gestures, new RegExp(`function ${name}\\(`));
    assert.doesNotMatch(app, new RegExp(`function ${name}\\(`), `${name} gehört nicht mehr in app.js`);
  }
  // Keine Abhängigkeit von app.js: weder Zustand noch DOM-Referenzen der App.
  assert.doesNotMatch(gestures, /\bstate\.|\$overlay|currentUser|apiFetch/);
  const gesturesAt = html.indexOf('<script src="touch-gestures.js"></script>');
  assert.ok(gesturesAt > 0 && gesturesAt < html.indexOf('<script src="app.js"></script>'));
});
