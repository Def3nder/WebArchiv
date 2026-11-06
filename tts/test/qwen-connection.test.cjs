const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {
  normalizeBaseUrl, providerSettings, providerInfo, checkQwen, qwenBaseUrl,
} = require('../provider-config.cjs');
const { createTtsVoiceSettings } = require('../voice-settings.cjs');

async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.test-qwen-connection-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function healthServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const HEALTHY = { protocol: 'webarchiv-qwen-v5', full_markdown: true, audio_format: 'mp3', chunk_progress: true,
  max_markdown_bytes: 1000000, voice_catalog: true };

test('Eingabe im Dialog: nackte IP bekommt http:// und Port 8765, ungültige Adressen werden abgelehnt', () => {
  const options = { defaultPort: 8765 };
  assert.equal(normalizeBaseUrl('192.168.1.200', options), 'http://192.168.1.200:8765');
  assert.equal(normalizeBaseUrl(' 192.168.1.200:9000 ', options), 'http://192.168.1.200:9000');
  assert.equal(normalizeBaseUrl('http://desktop.local:8765/', options), 'http://desktop.local:8765');
  assert.equal(normalizeBaseUrl('https://qwen.example', options), 'https://qwen.example:8765');
  assert.equal(normalizeBaseUrl('http://host:80', options), 'http://host'); // ausdrücklicher Port bleibt
  assert.equal(normalizeBaseUrl('[::1]', options), 'http://[::1]:8765');
  for (const bad of ['', '   ', 'ftp://host', 'http://user:pw@host', 'http://host/pfad', 'http://host?x=1', 'http://']) {
    assert.throws(() => normalizeBaseUrl(bad, options), bad);
  }
});

test('Im WebArchiv gespeicherte Adresse hat Vorrang vor Umgebungsvariable und config.json', () => temporary(async dir => {
  const file = path.join(dir, 'tts-connection.json');
  const config = { tts: { provider: 'qwen' }, qwen: { base_url: 'http://from-config:8765',
    base_url_environment_variable: 'QWEN_URL', token_environment_variable: 'TOKEN' } };
  const env = { TOKEN: 'secret', TTS_CONNECTION_FILE: file };
  assert.deepEqual(qwenBaseUrl(config, env).source, 'config');
  env.QWEN_URL = 'http://192.168.1.65:8765';
  assert.deepEqual(providerSettings(config, env), { provider: 'qwen', baseUrl: 'http://192.168.1.65:8765',
    token: 'secret', baseUrlSource: 'environment' });
  await fs.writeFile(file, JSON.stringify({ qwenBaseUrl: 'http://192.168.1.200:8765', updatedAt: '2026-11-06T10:00:00Z' }));
  assert.equal(providerSettings(config, env).baseUrl, 'http://192.168.1.200:8765');
  assert.equal(providerSettings(config, env).baseUrlSource, 'webarchiv');
  await fs.writeFile(file, '{kaputt');
  assert.throws(() => providerSettings(config, env), /nicht lesbar/);
  // Ohne base_url_file und ohne TTS_CONNECTION_FILE wird keine Datei gelesen (Tests, alte Konfiguration).
  assert.equal(qwenBaseUrl(config, { QWEN_URL: env.QWEN_URL }).source, 'environment');
}));

test('Verbindungstest nennt den konkreten Grund statt nur „nicht erreichbar“', async () => {
  let mode = 'healthy';
  const server = await healthServer((req, res) => {
    if (mode === 'silent') return;
    if (mode === 'unauthorized') { res.writeHead(401); return res.end('{}'); }
    if (mode === 'not-found') { res.writeHead(404); return res.end('<html>'); }
    if (mode === 'html') return res.end('<html>kein Qwen</html>');
    res.end(JSON.stringify(mode === 'old' ? { ...HEALTHY, protocol: 'webarchiv-qwen-v3' } : HEALTHY));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const check = () => checkQwen({ baseUrl, token: 'secret', timeoutMs: 300 });
  try {
    let result = await check();
    assert.equal(result.ok, true);
    assert.match(result.reason, /Verbindung erfolgreich: 127\.0\.0\.1:\d+ antwortet in \d+ ms .*Stimmenverwaltung aktiv/);
    const expected = {
      unauthorized: /lehnt aber das Token ab/, 'not-found': /HTTP 404/, html: /nicht wie der Qwen-TTS-Dienst/,
      old: /veraltet oder inkompatibel \(Protokoll webarchiv-qwen-v3/, silent: /Keine Antwort von 127\.0\.0\.1:\d+ innerhalb/,
    };
    for ([mode] of Object.entries(expected)) {
      result = await check();
      assert.equal(result.ok, false, mode);
      assert.match(result.reason, expected[mode], mode);
    }
    result = await checkQwen({ baseUrl, token: '' });
    assert.equal(result.code, 'token_missing');
  } finally { server.closeAllConnections(); server.close(); }
  const port = await closedPort();
  const refused = await checkQwen({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', timeoutMs: 2000 });
  assert.equal(refused.code, 'refused');
  assert.match(refused.reason, new RegExp(`auf Port ${port} läuft kein Dienst`));
});

test('Providerwahl zeigt den Grund und den Hinweis auf die TTS-Einstellungen', async () => {
  const port = await closedPort();
  const config = { tts: { api_key_environment_variable: 'KEY' },
    qwen: { base_url: `http://127.0.0.1:${port}`, token_environment_variable: 'TOKEN' } };
  const info = await providerInfo({ config, env: { TOKEN: 'secret' }, timeoutMs: 2000 });
  assert.equal(info.providers[0].available, false);
  assert.match(info.providers[0].status, /läuft kein Dienst.*TTS-Einstellungen/);
});

test('Dialog-API: Adresse testen ohne Speichern, speichern, Status anzeigen und wieder entfernen', () => temporary(async dir => {
  const server = await healthServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret');
    res.end(JSON.stringify(HEALTHY));
  });
  const port = server.address().port;
  const configFile = path.join(dir, 'config.json');
  const connectionFile = path.join(dir, 'tts-connection.json');
  await fs.writeFile(configFile, JSON.stringify({ tts: { provider: 'qwen' }, qwen: {
    base_url_environment_variable: 'QWEN_URL', base_url_file: connectionFile, token_environment_variable: 'TOKEN' } }));
  const env = { TOKEN: 'secret', QWEN_URL: 'http://192.0.2.1:8765' };
  const service = createTtsVoiceSettings({ file: path.join(dir, 'tts-settings.json'), configFile, env });
  try {
    let status = await service.connectionStatus();
    assert.equal(status.source, 'environment');
    assert.equal(status.baseUrl, 'http://192.0.2.1:8765');
    assert.equal(status.tokenConfigured, true);
    assert.equal(status.storable, true);

    const tested = await service.testConnection(`127.0.0.1:${port}`);
    assert.equal(tested.ok, true);
    assert.equal(tested.baseUrl, `http://127.0.0.1:${port}`);
    await assert.rejects(fs.access(connectionFile)); // Test speichert nichts
    await assert.rejects(service.testConnection('http://user:pw@host'), error => error.status === 400);

    status = await service.saveConnection(`127.0.0.1:${port}`, { email: 'admin@example.de' });
    assert.equal(status.source, 'webarchiv');
    assert.equal(status.stored.updatedBy, 'admin@example.de');
    assert.equal(status.test.ok, true);
    assert.equal(JSON.parse(await fs.readFile(connectionFile, 'utf8')).qwenBaseUrl, `http://127.0.0.1:${port}`);

    status = await service.saveConnection('', { email: 'admin@example.de' });
    assert.equal(status.source, 'environment');
    await assert.rejects(fs.access(connectionFile));
  } finally { server.closeAllConnections(); server.close(); }
}));
