const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTtsVoiceSettings, validateVoiceId } = require('../voice-settings.cjs');

async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(__dirname, '.test-voice-settings-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function mockQwen() {
  const calls = [];
  const voices = [{ id: 'Sachbuch-Autor', name: 'Sachbuch-Autor', model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    createdAt: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64) }];
  return {
    calls, voices,
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/v1/voices') && (!options.method || options.method === 'GET')) {
        return Response.json({ voices, model: voices[0].model, busy: false });
      }
      if (url.includes('/v1/voice-jobs/') && options.method === 'PUT') {
        return Response.json({ id: url.split('/').at(-1), status: 'running', stage: 'queued' }, { status: 202 });
      }
      if (/\/v1\/jobs\/[0-9a-f-]+$/.test(url) && options.method === 'PUT') {
        return Response.json({ id: url.split('/').at(-1), status: 'running' }, { status: 202 });
      }
      if (/\/v1\/jobs\/[0-9a-f-]+\/audio$/.test(url) && !options.method) {
        return new Response(Buffer.from('lokale Stimmprobe'), { headers: { 'Content-Type': 'audio/mpeg' } });
      }
      if (/\/v1\/jobs\/[0-9a-f-]+$/.test(url) && options.method === 'DELETE') {
        return Response.json({ id: url.split('/').at(-1), status: 'cancelled' });
      }
      if (url.endsWith('/v1/voices/Sachbuch-Autor') && options.method === 'PATCH') {
        voices[0] = { ...voices[0], id: 'Neue-Stimme', name: 'Neue-Stimme' };
        return Response.json(voices[0]);
      }
      return Response.json({ error: 'unexpected' }, { status: 404 });
    },
  };
}

test('globale Qwen-Stimme wird getrennt vom Voice-Verzeichnis atomar gespeichert', () => temporary(async dir => {
  const configFile = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'tts-settings.json');
  await fs.writeFile(configFile, JSON.stringify({ tts: { provider: 'qwen' }, qwen: { base_url: 'http://qwen.test', token_environment_variable: 'TOKEN' } }));
  const mock = mockQwen();
  const service = createTtsVoiceSettings({ file: settingsFile, configFile, env: { TOKEN: 'secret' }, request: mock.request });
  assert.equal((await service.getSettings()).qwenVoiceId, null);
  await service.select('Sachbuch-Autor', { email: 'admin@example.de' });
  assert.equal(await service.selectedVoice(), 'Sachbuch-Autor');
  const stored = JSON.parse(await fs.readFile(settingsFile));
  assert.equal(stored.qwenVoiceId, 'Sachbuch-Autor');
  assert.equal(stored.updatedBy, 'admin@example.de');
}));

test('Voice-Aufnahme bleibt Remote-Auftrag und Umbenennung aktualisiert aktive Auswahl', () => temporary(async dir => {
  const configFile = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'tts-settings.json');
  await fs.writeFile(configFile, JSON.stringify({ tts: { provider: 'qwen' }, qwen: { base_url: 'http://qwen.test', token_environment_variable: 'TOKEN' } }));
  const mock = mockQwen();
  const service = createTtsVoiceSettings({ file: settingsFile, configFile, env: { TOKEN: 'secret' }, request: mock.request });
  await service.select('Sachbuch-Autor', { email: 'admin@example.de' });
  const audioBase64 = Buffer.from('recording').toString('base64');
  await service.createVoice({ name: 'Nur Name', mimeType: 'audio/webm', audioBase64 });
  const createCall = mock.calls.find(call => call.url.includes('/v1/voice-jobs/'));
  assert.deepEqual(JSON.parse(createCall.options.body), { name: 'Nur Name', mimeType: 'audio/webm', audioBase64 });
  await service.renameVoice('Sachbuch-Autor', 'Neue Stimme', { email: 'admin@example.de' });
  assert.equal(await service.selectedVoice(), 'Neue-Stimme');
  await assert.rejects(service.trashVoice('Neue-Stimme'), /aktive Stimme/);
}));

test('Voice-IDs erlauben Namen, aber niemals Pfade', () => {
  assert.equal(validateVoiceId('Stefan-Hiene'), 'Stefan-Hiene');
  assert.throws(() => validateVoiceId('../voice'), /Ungültig/);
  assert.throws(() => validateVoiceId('voice/other'), /Ungültig/);
});

test('Stimmprobe wird auf dem WebArchiv gespeichert und nur bei identischem Voice-Hash angeboten', () => temporary(async dir => {
  const configFile = path.join(dir, 'config.json');
  const settingsFile = path.join(dir, 'tts-settings.json');
  const previewDirectory = path.join(dir, 'previews');
  await fs.writeFile(configFile, JSON.stringify({ tts: { provider: 'qwen' }, qwen: { base_url: 'http://qwen.test', token_environment_variable: 'TOKEN' } }));
  const mock = mockQwen();
  const service = createTtsVoiceSettings({ file: settingsFile, previewDirectory, configFile,
    env: { TOKEN: 'secret' }, request: mock.request });

  assert.equal((await service.getSettings()).voices[0].previewAvailable, false);
  const started = await service.startPreview('Sachbuch-Autor');
  const previewCall = mock.calls.find(call => /\/v1\/jobs\/[0-9a-f-]+$/.test(call.url)
    && call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(previewCall.options.body), {
    markdown: 'Stimmprobe. Dies ist eine kurze Vorschau der ausgewählten Stimme.',
    voiceId: 'Sachbuch-Autor',
  });
  const saved = await service.previewAudio(started.id);
  assert.equal(await fs.readFile(saved.file, 'utf8'), 'lokale Stimmprobe');

  const current = (await service.getSettings()).voices[0];
  assert.equal(current.previewAvailable, true);
  assert.match(current.previewUrl, /\/api\/tts\/voices\/Sachbuch-Autor\/preview-audio\?v=aaaaaaaaaaaaaaaa$/);
  assert.equal((await service.cachedPreviewAudio('Sachbuch-Autor')).file, saved.file);

  const regenerated = await service.startPreview('Sachbuch-Autor');
  const replaced = await service.previewAudio(regenerated.id);
  assert.equal(replaced.file, saved.file);
  assert.equal(await fs.readFile(replaced.file, 'utf8'), 'lokale Stimmprobe');

  mock.voices[0].sha256 = 'b'.repeat(64);
  const changed = (await service.getSettings()).voices[0];
  assert.equal(changed.previewAvailable, false);
  await assert.rejects(service.cachedPreviewAudio('Sachbuch-Autor'), { status: 404 });
}));
