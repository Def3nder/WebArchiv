const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const audiobooks = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('Hörbuch-Detailansicht zeigt nur den ausgeschriebenen Monat und das Jahr', () => {
  const match = app.match(/function formatMonthYear\(d\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'formatMonthYear fehlt');

  const context = {};
  vm.runInNewContext(`${match[0]}; result = formatMonthYear('2025-09-25');`, context);
  assert.equal(context.result, 'September 2025');
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
  assert.match(server, /articles\.find\(a => a\.id === id\) \|\| audiobooks\.get\(id\)/);
  assert.match(server, /pathname\.startsWith\('\/audio-files\/'\) \? AUDIO_DIR/);
  assert.match(server, /resolvePreviewImagePath\(article\)/);
});
