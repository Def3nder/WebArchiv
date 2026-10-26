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
  assert.match(html, /tts-settings\.js\?v=4[\s\S]*app\.js\?v=133/);
  assert.match(html, /styles\.css\?v=158/);
  assert.match(css, /#tts-settings-meta\s*{[^}]*margin-top:\s*6px/);
  assert.match(html, /id="tts-settings-name"[^>]*aria-describedby="tts-settings-name-hint"/);
  assert.match(css, /#tts-settings-name-hint\s*{[^}]*margin-top:\s*6px/);
  assert.match(app, /action === 'tts-settings'[\s\S]*openTtsSettingsDialog/);
  assert.match(app, /\['#tts-settings-dialog', '#tts-settings-close'\]/);
});

test('Server-Einstellungen stehen unter den vorhandenen Bereichen und bilden alle Qwen-Werte ab', () => {
  const html = read('public/index.html');
  const source = read('public/tts-settings.js');
  const css = read('public/styles.css');
  assert.ok(html.indexOf('id="tts-server-settings-title"') > html.indexOf('id="tts-settings-new-title"'));
  assert.doesNotMatch(html, /article-editor-heading[\s\S]{0,200}id="tts-settings-status"/);
  for (const id of ['tts-server-min-chunk', 'tts-server-target-chunk', 'tts-server-max-chunk',
    'tts-server-min-chunk-range', 'tts-server-target-chunk-range', 'tts-server-max-chunk-range',
    'tts-server-preroll-enabled', 'tts-server-preroll-sentence', 'tts-server-padding-enabled',
    'tts-server-padding-text', 'tts-server-preroll-pause', 'tts-server-lead-in',
    'tts-server-silence-threshold', 'tts-server-settings-save']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /qwen_http_service_config\.json/);
  assert.match(source, /request\('\/api\/tts\/server-settings'/);
  assert.match(source, /text_preroll_sentence:[\s\S]*chunk_end_padding_text:[\s\S]*silence_threshold_db:/);
  assert.match(source, /prerollFields\.hidden = !prerollEnabled\.checked/);
  assert.match(css, /\.tts-chunk-range[\s\S]*--chunk-target/);
});

test('Die Stimmenauswahl verwendet das gemeinsame ARIA-Menü mit nativem Touch-Fallback', () => {
  const html = read('public/index.html');
  const source = read('public/tts-settings.js');
  const css = read('public/styles.css');
  assert.match(html, /id="tts-settings-voice" class="settings-select filter-select filter-menu-native"/);
  assert.match(html, /class="header-menu filter-header-menu tts-settings-voice-menu" data-filter-aria-menu="tts-settings-voice"/);
  assert.match(html, /aria-controls="tts-settings-voice-menu" aria-labelledby="tts-settings-voice-label tts-settings-voice-value"/);
  assert.match(html, /id="tts-settings-voice-menu" class="header-menu-dropdown" role="menu"/);
  assert.match(source, /function syncVoiceMenu\(\)[\s\S]*syncFilterAriaMenu\(select\)/);
  assert.match(source, /syncVoiceMenu\(\);[\s\S]*updateButtons\(\)/);
  assert.match(source, /function closeVoiceMenu\(\)[\s\S]*closeFilterAriaMenu\(filterAriaRoot\(select\)\)/);
  assert.match(css, /\.tts-settings-voice-menu \.filter-menu-trigger \{[^}]*width:\s*100%/);
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
