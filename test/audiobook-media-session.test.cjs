const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const audiobooks = fs.readFileSync(path.join(root, 'public', 'audiobooks.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Hörbuchplayer synchronisiert Wiedergabestatus und Position mit der Media Session', () => {
  assert.match(audiobooks, /function bookSyncMediaSessionState\(\)/);
  assert.match(audiobooks, /mediaSession\.playbackState\s*=\s*audio\.paused \|\| audio\.ended \? 'paused' : 'playing'/);
  assert.match(audiobooks, /mediaSession\.setPositionState\(\{[\s\S]*?duration:[\s\S]*?playbackRate,[\s\S]*?position,/);
  assert.match(audiobooks, /addEventListener\('loadedmetadata',[\s\S]*?bookSyncMediaSessionState\(\)/);
  assert.match(audiobooks, /addEventListener\('timeupdate',[\s\S]*?bookSyncMediaSessionState\(\)/);
  assert.match(audiobooks, /addEventListener\('playing', bookSyncMediaSessionState\)/);
  assert.match(audiobooks, /addEventListener\('pause',[\s\S]*?bookSyncMediaSessionState\(\)/);
});

test('Hörbuch-Script erhält einen neuen Cache-Buster', () => {
  assert.match(index, /audiobooks\.js(?:\?v=[a-f0-9]+)?/);
});
