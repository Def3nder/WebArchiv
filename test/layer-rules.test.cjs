const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Regeln des Ebenen-Stapels (public/layer-stack.js, Session.MD §45–49) für den
// eigenen Browser-Code: Dialoge öffnen nur über WebArchivLayers.open, Escape und
// cancel regelt der Stapel, Tastatur läuft Element → oberste Ebene → Grundansicht.
const PUBLIC = path.join(__dirname, '..', 'public');
const sources = fs.readdirSync(PUBLIC)
  .filter(name => name.endsWith('.js'))
  .map(name => ({ name, code: fs.readFileSync(path.join(PUBLIC, name), 'utf8') }));

function filesMatching(pattern) {
  return sources.filter(({ code }) => pattern.test(code)).map(({ name }) => name).sort();
}

test('eigene Browser-Skripte werden geprüft', () => {
  assert.ok(sources.length > 20);
  assert.ok(sources.some(({ name }) => name === 'layer-stack.js'));
});

test('keine Tastenhandler am Dokument oder Fenster außer Stapel und Menüs', () => {
  // aria-menu.js schließt offene Menüs mit Escape in der Capture-Phase, bevor der Stapel
  // die Taste sieht; alle anderen hängen ihre Tasten an das eigene Element oder onKey/setBase.
  assert.deepEqual(filesMatching(/\b(?:document|window)\.addEventListener\(\s*['"]key(?:down|up|press)['"]/), ['aria-menu.js']);
  assert.deepEqual(filesMatching(/stopImmediatePropagation/), ['aria-menu.js']);
});

test('Dialoge öffnen nur über den Stapel, cancel behandelt nur der Stapel', () => {
  // markdown-live-preview.js: nativer Rückfall ohne Stapel (Dubletten-Werkzeug).
  assert.deepEqual(filesMatching(/\.showModal\(\)/), ['layer-stack.js', 'markdown-live-preview.js']);
  assert.match(sources.find(({ name }) => name === 'markdown-live-preview.js').code,
    /if \(globalThis\.WebArchivLayers\) globalThis\.WebArchivLayers\.open\(dialog, [^)]*\);\s*else dialog\.showModal\(\);/);
  assert.deepEqual(filesMatching(/addEventListener\(\s*['"]cancel['"]/), ['layer-stack.js']);
});
