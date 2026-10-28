const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appFiles } = require('./support/read-app.cjs');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

const PARTS = {
  'app-gallery.js': ['showFullscreenImage', 'openGalleryFullscreen', 'closeImageFullscreen', 'stepFullscreen', 'zoomImageCentered', 'prepareImageFile'],
  'app-media.js': ['stopAudio', 'renderAudioPlayer', 'renderPdfEmbed', 'setArticleMediaSession', 'wireAudioPlayer'],
  'app-detail.js': ['openArticle', 'closeOverlay', 'toggleBookmark', 'renderDetail'],
};

test('app.js ist in Teildateien aufgeteilt, die vor app.js geladen werden', () => {
  assert.deepEqual(appFiles(), ['app-gallery.js', 'app-media.js', 'app-detail.js', 'app.js']);
  const app = read('app.js');
  for (const [file, names] of Object.entries(PARTS)) {
    const source = read(file);
    for (const name of names) {
      assert.match(source, new RegExp(`function ${name}\\(`), `${name} in ${file}`);
      assert.doesNotMatch(app, new RegExp(`function ${name}\\(`), `${name} nicht mehr in app.js`);
    }
  }
});

test('Teildateien enthalten nur Deklarationen ohne Ladezeit-Zugriff auf app.js', () => {
  for (const file of Object.keys(PARTS)) {
    // Oberste Ebene: nur Funktionen, Konstanten/Variablen, Kommentare und eigene Dokument-Listener.
    for (const line of read(file).split(/\r?\n/)) {
      if (!line || /^[\s})\]]/.test(line)) continue;
      assert.match(line, /^(?:\/\/|\/\*| \*|(?:async )?function |const |let |document\.addEventListener\()/, `${file}: ${line}`);
    }
    // Keine DOM-Referenzen aus app.js beim Laden (z. B. $overlay.querySelector auf oberster Ebene).
    assert.doesNotMatch(read(file), /^(?:const|let) [\w$]+ = \$/m, file);
  }
});
