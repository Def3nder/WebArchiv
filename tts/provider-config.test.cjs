const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { providerInfo } = require('./provider-config.cjs');

test('Providerwahl prüft live: gesund, gestoppt, stumm, HTTP-Fehler und falscher Vertrag', async () => {
  let mode = 'healthy', requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/v1/health');
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (mode === 'silent') return;
    if (mode === 'body-stalled') { res.writeHead(200); res.write('{'); return; }
    if (mode === 'unauthorized') { res.writeHead(401); res.end(); return; }
    res.end(JSON.stringify({ protocol: mode === 'old' ? 'webarchiv-qwen-v3' : 'webarchiv-qwen-v4',
      full_markdown: true, audio_format: 'mp3', max_markdown_bytes: 1000000 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { tts: { provider: 'openai', api_key_environment_variable: 'TEST_KEY' },
    qwen: { base_url: `http://127.0.0.1:${server.address().port}`, token_environment_variable: 'TEST_TOKEN' } };
  const env = { TEST_TOKEN: 'test-token', TEST_KEY: 'simulated-not-used' };
  const select = () => providerInfo({ config, env, timeoutMs: 100 });
  try {
    assert.deepEqual((await select()).providers.map(p => p.available), [true, true]);
    for (mode of ['unauthorized', 'old', 'silent', 'body-stalled']) {
      const before = Date.now();
      const info = await select();
      assert.deepEqual(info.providers.map(p => p.available), [false, true]);
      assert.match(info.providers[1].confirmation, /kostenpflichtig/);
      assert.ok(Date.now() - before < 1500);
    }
    mode = 'healthy';
    delete env.TEST_KEY;
    assert.deepEqual((await select()).providers.map(p => p.available), [true, false]);
    env.TEST_KEY = 'simulated';
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual((await select()).providers.map(p => p.available), [false, true]);
    delete env.TEST_KEY;
    assert.deepEqual((await select()).providers.map(p => p.available), [false, false]);
    assert.equal(requests, 6);
  } finally { server.closeAllConnections(); server.close(); }
});

test('Fehlende Qwen-Konfiguration bietet OpenAI nur mit vorhandenem Schlüssel an', async () => {
  const config = { tts: { provider: 'qwen', api_key_environment_variable: 'TEST_KEY' } };
  assert.deepEqual((await providerInfo({ config, env: { TEST_KEY: 'simulated' } })).providers.map(p => p.available), [false, true]);
  const info = await providerInfo({ config, env: {} });
  assert.deepEqual(info.providers.map(p => p.available), [false, false]);
  assert.match(info.providers[1].status, /API-Schlüssel fehlt/);
});

test('Bestätigter Provider wird im Worker vor der Konfigurationsprüfung gebunden', async () => {
  const { loadConfig } = await import('./markdown_tts.js');
  assert.equal((await loadConfig(undefined, 'openai')).tts.provider, 'openai');
  assert.equal((await loadConfig(undefined, 'qwen')).tts.provider, 'qwen');
  await assert.rejects(loadConfig(undefined, 'other'), /Unbekannter bestätigter/);
});
