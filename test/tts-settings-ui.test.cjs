const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Admin-Menü und nativer Dialog enthalten die vollständige Qwen-Stimmenverwaltung', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const css = read('public/styles.css');
  assert.match(html, /data-action="tts-settings"[^>]*data-admin-only[^>]*>TTS-Einstellungen/);
  assert.match(html, /<dialog id="tts-settings-dialog"[^>]*aria-labelledby="tts-settings-title"/);
  for (const id of ['tts-settings-voice', 'tts-settings-preview', 'tts-settings-rename', 'tts-settings-trash',
    'tts-settings-record', 'tts-settings-stop', 'tts-settings-file', 'tts-settings-create']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /-1\.7B\.pt/);
  assert.doesNotMatch(html, /Einwilligung|Zustimmung|consent/i);
  assert.match(html, /tts-settings\.js\?v=2[\s\S]*app\.js\?v=116/);
  assert.match(html, /styles\.css\?v=146/);
  assert.match(css, /#tts-settings-meta\s*{[^}]*margin-top:\s*6px/);
  assert.match(html, /id="tts-settings-name"[^>]*aria-describedby="tts-settings-name-hint"/);
  assert.match(css, /#tts-settings-name-hint\s*{[^}]*margin-top:\s*6px/);
  assert.match(app, /action === 'tts-settings'[\s\S]*openTtsSettingsDialog/);
  assert.match(app, /\['#tts-settings-dialog', '#tts-settings-close'\]/);
});

test('Browseraufnahme, Datei-Upload, globale Auswahl, Vorschau und Trash benutzen nur Admin-APIs', () => {
  const source = read('public/tts-settings.js');
  assert.match(source, /mediaDevices\?\.getUserMedia/);
  assert.match(source, /new MediaRecorder/);
  assert.match(source, /audioBase64/);
  assert.match(source, /method: 'PUT'[\s\S]*voiceId/);
  assert.match(source, /\/api\/tts\/voices-preview/);
  assert.match(source, /previewAvailable/);
  assert.match(source, /WebArchiv-Server gespeichert/);
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /voices\/trash/);
  assert.doesNotMatch(source, /E:\\Code|faster-qwen3-tts/);
});
