const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { computeAppShellVersion, serviceWorkerSource } = require('../server.js');

test('App-Shell-Version ändert sich automatisch mit ausgelieferten Frontend-Dateien', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webarchiv-pwa-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="app.js?v=1"></script>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const version = 1;');

  const first = computeAppShellVersion(dir);
  fs.writeFileSync(path.join(dir, 'app.js'), 'const version = 2;');
  const second = computeAppShellVersion(dir);

  assert.match(first, /^[a-f0-9]{16}$/);
  assert.notEqual(second, first);
});

test('Service Worker wartet auf Zustimmung und cached keine veraltete App-Shell', () => {
  const source = serviceWorkerSource('abc123');
  assert.match(source, /APP_VERSION = "abc123"/);
  assert.match(source, /SKIP_WAITING/);
  assert.match(source, /clients\.claim\(\)/);
  assert.doesNotMatch(source, /addEventListener\('fetch'/);
  assert.doesNotMatch(source, /caches\./);
});

test('Update-Oberfläche und Registrierung sind in der App-Shell eingebunden', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'pwa-update.js'), 'utf8');
  assert.match(html, /id="pwa-update-notice"/);
  assert.match(html, /pwa-update\.js\?v=1/);
  assert.match(client, /serviceWorker\.register\('\/service-worker\.js'/);
  assert.match(client, /updateViaCache:\s*'none'/);
  assert.match(client, /app-update/);
});
