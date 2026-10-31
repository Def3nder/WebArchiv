const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readApp = require('./support/read-app.cjs');

const ROOT = path.join(__dirname, '..');
const app = readApp();
const audiobooks = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('Hörbuch-Detailansicht zeigt Monat und Jahr mit kurzen Namen für lange Monate', () => {
  const match = app.match(/function formatMonthYear\(d\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'formatMonthYear fehlt');

  const context = { result: null };
  vm.runInNewContext(`${match[0]}; result = [
    formatMonthYear('2025-02-25'),
    formatMonthYear('2025-08-25'),
    formatMonthYear('2025-09-25'),
    formatMonthYear('2025-10-25'),
    formatMonthYear('2025-11-25'),
    formatMonthYear('2025-12-25'),
  ];`, context);
  assert.deepEqual(Array.from(context.result), ['Feb. 2025', 'Aug. 2025', 'Sept. 2025', 'Okt. 2025', 'Nov. 2025', 'Dez. 2025']);
  assert.match(audiobooks, /detail-date-block[^\n]*formatMonthYear\(book\.date\)/);
});

test('Folgekapitel startet noch im ended-Aufruf statt erst nach geladenen Metadaten', () => {
  const loadTrack = audiobooks.match(/function bookLoadTrack\(index, seek, play\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loadTrack, 'bookLoadTrack fehlt');
  assert.match(loadTrack, /const playImmediately = play && bookPlayer\.pendingSeek\.fromStart === 0;/);
  assert.ok(loadTrack.indexOf('audio.load();') < loadTrack.indexOf('if (playImmediately) bookPlay();'));
  assert.match(loadTrack, /bookPlayer\.playAfterLoad = play && !playImmediately;/);
});

test('Während der Wiedergabe wird genau das nächste Kapitel vorgeladen', () => {
  assert.match(audiobooks, /audio\.addEventListener\('playing', bookPreloadNext\)/);
  assert.match(audiobooks, /const next = bookPlayer\.book\?\.tracks\?\.\[bookPlayer\.index \+ 1\]/);
  assert.match(audiobooks, /preloadAudio\.preload = 'auto';/);
  assert.match(audiobooks, /bookClearPreload\(\);[\s\S]*bookPlayer\.book = book;/);
});

test('Hörbücher lassen sich mit öffentlicher Cover-Vorschau teilen', () => {
  assert.match(audiobooks, /data-book-share>Teilen<\/button>/);
  assert.match(audiobooks, /location\.origin}\/a\/\$\{sanitizeForId\(book\.id\)}/);
  assert.match(server, /getArticle: id => archive\.articleById\.get\(id\) \|\| audiobooks\.get\(id\)/);
  assert.match(server, /pathname\.startsWith\('\/audio-files\/'\) \? AUDIO_DIR/);
  assert.match(server, /resolvePreviewImagePath\(article\)/);
});
