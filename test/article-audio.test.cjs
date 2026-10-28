const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readApp = require('./support/read-app.cjs');

const ROOT = path.join(__dirname, '..');
const app = readApp();
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const mediaRoutes = fs.readFileSync(path.join(ROOT, 'media-files.cjs'), 'utf8');

test('Artikel-Audio fordert auf iOS eine dauerhafte Playback-Session an', () => {
  assert.match(app, /function prepareAudioPlaybackSession\(\)[\s\S]*?navigator\.audioSession\.type = 'playback'/);
  assert.match(app, /function playArticleAudio\(audio\)[\s\S]*?prepareAudioPlaybackSession\(\);[\s\S]*?audio\.play\(\)/);
});

test('Sperrbildschirm lässt Play und Pause nativ vom Audioelement behandeln', () => {
  assert.match(app, /WebKit kann das aktive HTMLMediaElement[\s\S]*?\['play', 'pause',[\s\S]*?setActionHandler\(action, null\)/);
  assert.doesNotMatch(app, /play:\s*\(\) =>[\s\S]{0,160}?playArticleAudio\(audio\)/);
  assert.doesNotMatch(app, /mediaSession\.playbackState\s*=/);
});

test('Artikel-Player zeigt Wiedergabe erst beim playing-Ereignis an', () => {
  assert.match(app, /addEventListener\('playing',[\s\S]*?classList\.add\('playing'\)/);
  const requested = app.slice(
    app.indexOf("audio.addEventListener('play'"),
    app.indexOf("audio.addEventListener('playing'"),
  );
  assert.doesNotMatch(requested, /classList\.add\('playing'\)/);
  assert.match(app, /audio\.paused \|\| !btn\.classList\.contains\('playing'\)/);
});

test('Ereignisse eines gestoppten Players lesen nicht das globale audioEl', () => {
  // stopAudio() setzt audioEl auf null; ein danach eintreffendes timeupdate darf es nicht lesen.
  const source = app.replace(/\r\n/g, '\n');
  const start = source.indexOf('function wireAudioPlayer(');
  const wire = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(wire, /const audio = new Audio\(audioUrl\);[\s\S]*?audioEl = audio;/);
  const afterAssignment = wire.slice(wire.indexOf('audioEl = audio;') + 'audioEl = audio;'.length);
  assert.doesNotMatch(afterAssignment, /\baudioEl\b/);
});

test('Cache-Buster liefert die korrigierte Player-Version aus', () => {
  assert.match(html, /<script src="app\.js(?:\?v=[a-f0-9]+)?"><\/script>/);
});

test('Der TTS-Papierkorb wird nicht über die Audio-Route ausgeliefert', () => {
  const audioRoute = mediaRoutes.slice(mediaRoutes.indexOf("app.get('/audio-files/*'"));
  assert.match(audioRoute, /topDir\.toLowerCase\(\) === 'trash'[\s\S]*?status\(404\)/);
});
