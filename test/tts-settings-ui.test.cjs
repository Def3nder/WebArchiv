const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readStyles = require('./support/read-styles.cjs');
const readApp = require('./support/read-app.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Admin-Menü und nativer Dialog enthalten die vollständige Qwen-Stimmenverwaltung', () => {
  const html = read('public/index.html');
  const app = readApp();
  const css = readStyles();
  assert.match(html, /data-action="tts-settings"[^>]*data-admin-only[^>]*>TTS-Einstellungen/);
  assert.match(html, /<dialog id="tts-settings-dialog"[^>]*aria-labelledby="tts-settings-title"/);
  for (const id of ['tts-settings-voice', 'tts-settings-preview', 'tts-settings-rename', 'tts-settings-trash',
    'tts-settings-record', 'tts-settings-stop', 'tts-settings-file', 'tts-settings-create']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /-1\.7B\.pt/);
  assert.doesNotMatch(html, /Einwilligung|Zustimmung|consent/i);
  assert.match(html, /tts-settings\.js(?:\?v=[a-f0-9]+)?[\s\S]*app\.js(?:\?v=[a-f0-9]+)?/);
  assert.match(html, /css\/base\.css(?:\?v=[a-f0-9]+)?/);
  assert.match(css, /#tts-settings-meta\s*{[^}]*margin-top:\s*6px/);
  assert.match(html, /id="tts-settings-name"[^>]*aria-describedby="tts-settings-name-hint"/);
  assert.match(css, /#tts-settings-name-hint\s*{[^}]*margin-top:\s*6px/);
  assert.match(app, /action === 'tts-settings'[\s\S]*openTtsSettingsDialog/);
  assert.match(app, /\['#tts-settings-dialog', '#tts-settings-close'\]/);
});

test('Server-Einstellungen stehen unter den vorhandenen Bereichen und bilden alle Qwen-Werte ab', () => {
  const html = read('public/index.html');
  const source = read('public/tts-settings.js');
  const css = readStyles();
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

test('Verbindung zum Qwen-Server steht oben: Adressfeld, Testen und Speichern über Admin-APIs', () => {
  const html = read('public/index.html');
  const source = read('public/tts-settings.js');
  const css = readStyles();
  assert.ok(html.indexOf('id="tts-connection-title"') > html.indexOf('id="tts-settings-dialog"'));
  assert.ok(html.indexOf('id="tts-connection-title"') < html.indexOf('id="tts-settings-active-title"'));
  assert.match(html, /<label class="login-label" for="tts-connection-address">IP-Adresse/);
  assert.match(html, /id="tts-connection-address" class="login-input" type="text" inputmode="url"[^>]*aria-describedby="tts-connection-source"/);
  assert.match(html, /id="tts-connection-test"[^>]*>Verbindung testen</);
  assert.match(html, /id="tts-connection-save"[^>]*>Speichern</);
  assert.match(html, /id="tts-connection-status" class="tts-settings-status" role="status" aria-live="polite"/);
  assert.match(source, /request\('\/api\/tts\/connection\/test', \{\s*method: 'POST'/);
  assert.match(source, /request\('\/api\/tts\/connection', \{\s*method: 'PUT'/);
  // Ohne Qwen: Dialog öffnet trotzdem, erst die Verbindung, dann (nur wenn sie steht) Stimmen und Server-Werte.
  assert.match(source, /if \(await loadConnection\(\)\) await Promise\.all\(\[loadSettings\(\), loadServerSettings\(\)\]\);\s*else showDisconnected\(\);/);
  assert.ok(source.indexOf("WebArchivLayers.open(dialog") < source.indexOf('if (await loadConnection())'),
    'der Dialog ist schon offen, bevor auf Qwen gewartet wird');
  // Enter im Feld testet die Verbindung (Taste am Element, kein globaler Handler).
  assert.match(source, /addressInput\.addEventListener\('keydown'[\s\S]*event\.key !== 'Enter'[\s\S]*testAddress\(\)/);
  // Neue Oberfläche, alter Server-Code: Express antwortet 404 ohne JSON → verständlicher Hinweis statt „(404)“.
  assert.match(source, /response\.status === 404 && url\.startsWith\('\/api\/'\)[\s\S]*Server-Dateien \(tts\/\) aktualisieren und den Dienst neu starten/);
  // Schmale Zeile (grün/rot), die per Button aufklappt; kein <details> (Projektregel für Menüs/Disclosures).
  assert.match(html, /<section id="tts-connection" class="tts-settings-section tts-connection" data-state="checking"/);
  assert.match(html, /<button type="button" id="tts-connection-toggle" class="tts-connection-toggle" aria-expanded="false" aria-controls="tts-connection-panel">/);
  assert.match(html, /<div id="tts-connection-panel" class="tts-connection-panel" hidden>[\s\S]*id="tts-connection-address"[\s\S]*id="tts-connection-save"/);
  assert.doesNotMatch(html, /<details[^>]*tts-connection/);
  assert.match(css, /\.tts-connection\[data-state="ok"\] \{ --connection-color: var\(--success, #2f9e5b\); \}/);
  assert.match(css, /\.tts-connection\[data-state="error"\] \{ --connection-color: var\(--danger, #c44747\); \}/);
  assert.match(css, /\.tts-connection-toggle\[aria-expanded="true"\] \.tts-connection-chevron/);
  assert.match(source, /function setExpanded\(open\) \{\s*connectionToggle\.setAttribute\('aria-expanded', String\(open\)\);\s*connectionPanel\.hidden = !open;/);
  assert.match(source, /if \(result\.ok\) setSummary\('ok'/);
  assert.match(css, /\.tts-settings-status\.is-ok \{/);
  assert.match(css, /\.tts-connection-row \{[^}]*grid-template-columns/);
});

test('Die Stimmenauswahl verwendet das gemeinsame ARIA-Menü mit nativem Touch-Fallback', () => {
  const html = read('public/index.html');
  const source = read('public/tts-settings.js');
  const css = readStyles();
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
