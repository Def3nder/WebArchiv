const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { providerSettings } = require('./provider-config.cjs');

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const PREVIEW_TEXT = 'Stimmprobe. Dies ist eine kurze Vorschau der ausgewählten Stimme.';
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateVoiceId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 80 || !/^[\p{L}\p{N}_ .-]+$/u.test(id)
      || id === '.' || id === '..' || /[\\/]/.test(id) || /[ .]$/.test(id)) {
    throw fail('Ungültiger Stimmenname.');
  }
  return id;
}

function validateJobId(value) {
  const id = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw fail('Ungültige Auftrags-ID.');
  }
  return id;
}

async function atomicJson(file, value, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    const handle = await io.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await io.rename(temporary, file);
  } finally {
    await io.rm(temporary, { force: true }).catch(() => {});
  }
}

function createTtsVoiceSettings({
  file = process.env.TTS_SETTINGS_FILE || path.join(__dirname, '..', 'tts-settings.json'),
  previewDirectory = process.env.TTS_VOICE_PREVIEW_DIR || path.join(__dirname, '..', 'tts-voice-previews'),
  configFile = path.join(__dirname, 'config.json'), env = process.env, io = fs, request,
} = {}) {
  let writeQueue = Promise.resolve();
  const previewJobs = new Map();

  function previewPath(sha256) {
    if (!SHA256.test(String(sha256 || ''))) throw fail('Der Qwen-Server liefert keinen gültigen Voice-Hash.', 502);
    return path.join(previewDirectory, `${sha256}.mp3`);
  }

  async function previewInfo(voice) {
    const file = previewPath(voice.sha256);
    try {
      const stat = await io.stat(file);
      if (!stat.isFile() || stat.size < 1) return { previewAvailable: false };
      return {
        previewAvailable: true,
        previewCreatedAt: stat.mtime.toISOString(),
        previewUrl: `/api/tts/voices/${encodeURIComponent(voice.id)}/preview-audio?v=${voice.sha256.slice(0, 16)}`,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { previewAvailable: false };
      throw error;
    }
  }

  async function stored() {
    try {
      const value = JSON.parse(await io.readFile(file, 'utf8'));
      return {
        qwenVoiceId: value.qwenVoiceId ? validateVoiceId(value.qwenVoiceId) : null,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : null,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { qwenVoiceId: null, updatedAt: null, updatedBy: null };
      throw error;
    }
  }

  async function connection() {
    const config = JSON.parse(await io.readFile(configFile, 'utf8'));
    return providerSettings({ ...config, tts: { ...config.tts, provider: 'qwen' } }, env);
  }

  async function send(endpoint, options = {}, timeoutMs = 15000) {
    const { baseUrl, token } = await connection();
    const transport = request || (await import('./qwen-http.js')).requestQwen;
    const response = await transport(baseUrl + endpoint, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
    return response;
  }

  async function json(endpoint, options, timeoutMs) {
    const response = await send(endpoint, options, timeoutMs);
    let body;
    try { body = await response.json(); }
    catch {
      await response.body?.cancel?.();
      throw fail('Der Qwen-Server hat ungültig geantwortet.', 502);
    }
    if (!response.ok) throw fail(body?.error || `Qwen-Dienst HTTP ${response.status}.`, response.status === 404 ? 404 : 409);
    return body;
  }

  async function catalog() {
    const body = await json('/v1/voices');
    if (!Array.isArray(body.voices) || body.voices.some(voice => !voice || typeof voice.id !== 'string'
        || typeof voice.name !== 'string' || typeof voice.model !== 'string' || !SHA256.test(voice.sha256))) {
      throw fail('Der Qwen-Server liefert keinen gültigen Stimmenkatalog.', 502);
    }
    const voices = await Promise.all(body.voices.map(async voice => ({ ...voice, ...await previewInfo(voice) })));
    return { voices, model: body.model, busy: !!body.busy };
  }

  async function getSettings() {
    const [saved, remote] = await Promise.all([stored(), catalog()]);
    return { ...saved, ...remote, selectedAvailable: !saved.qwenVoiceId
      || remote.voices.some(voice => voice.id === saved.qwenVoiceId) };
  }

  const serverSettings = () => json('/v1/settings');

  const saveServerSettings = settings => json('/v1/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
  });

  async function select(voiceId, user) {
    voiceId = validateVoiceId(voiceId);
    const remote = await catalog();
    if (!remote.voices.some(voice => voice.id === voiceId)) throw fail('Die gewählte Stimme ist auf dem TTS-Server nicht verfügbar.', 409);
    const value = { qwenVoiceId: voiceId, updatedAt: new Date().toISOString(), updatedBy: user?.email || null };
    writeQueue = writeQueue.catch(() => {}).then(() => atomicJson(file, value, io));
    await writeQueue;
    return { ...value, voices: remote.voices, model: remote.model, busy: remote.busy, selectedAvailable: true };
  }

  async function selectedVoice() {
    return (await stored()).qwenVoiceId;
  }

  async function createVoice({ name, mimeType, audioBase64 }) {
    const estimated = Math.floor(String(audioBase64 || '').length * 3 / 4);
    if (!audioBase64 || estimated < 1 || estimated > MAX_AUDIO_BYTES) throw fail('Die Aufnahme ist leer oder größer als 10 MB.');
    const id = randomUUID();
    return json(`/v1/voice-jobs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name || ''), mimeType: String(mimeType || ''), audioBase64 }),
    }, 30000);
  }

  const voiceJob = id => json(`/v1/voice-jobs/${validateJobId(id)}`);
  const cancelVoiceJob = id => json(`/v1/voice-jobs/${validateJobId(id)}`, { method: 'DELETE' });

  async function renameVoice(id, name, user) {
    id = validateVoiceId(id);
    const result = await json(`/v1/voices/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: String(name || '') }),
    });
    const saved = await stored();
    if (saved.qwenVoiceId === id) await select(result.id, user);
    return result;
  }

  async function trashVoice(id) {
    id = validateVoiceId(id);
    if ((await stored()).qwenVoiceId === id) throw fail('Die aktive Stimme kann nicht gelöscht werden. Bitte zuerst eine andere Stimme speichern.', 409);
    return json(`/v1/voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async function startPreview(voiceId) {
    voiceId = validateVoiceId(voiceId);
    const remote = await catalog();
    const voice = remote.voices.find(candidate => candidate.id === voiceId);
    if (!voice) throw fail('Die gewählte Stimme ist auf dem TTS-Server nicht verfügbar.', 409);
    const id = randomUUID();
    const result = await json(`/v1/jobs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: PREVIEW_TEXT, voiceId }),
    });
    previewJobs.set(id, { voiceId, sha256: voice.sha256 });
    return result;
  }

  const previewStatus = id => json(`/v1/jobs/${validateJobId(id)}`);
  async function cancelPreview(id) {
    id = validateJobId(id);
    try { return await json(`/v1/jobs/${id}`, { method: 'DELETE' }); }
    finally { previewJobs.delete(id); }
  }

  async function writePreview(remote, target) {
    await io.mkdir(previewDirectory, { recursive: true });
    const temporary = path.join(previewDirectory, `.${path.basename(target)}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await io.open(temporary, 'wx', 0o600);
      let bytes = 0;
      for await (const chunk of remote.body) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > MAX_PREVIEW_BYTES) throw fail('Die Stimmprobe des Qwen-Servers ist zu groß.', 502);
        await handle.write(value);
      }
      if (remote.body.complete === false || bytes < 1) throw fail('Der Qwen-Server liefert keine vollständige Stimmprobe.', 502);
      await handle.sync();
      await handle.close();
      handle = null;
      await io.rename(temporary, target);
      return io.stat(target);
    } finally {
      await handle?.close().catch(() => {});
      await io.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function previewAudio(id) {
    id = validateJobId(id);
    const pending = previewJobs.get(id);
    if (!pending) throw fail('Stimmproben-Auftrag ist nicht mehr bekannt.', 404);
    const response = await send(`/v1/jobs/${id}/audio`, {}, 30000);
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch { await response.body?.cancel?.(); }
      throw fail(body.error || 'Stimmprobe ist nicht verfügbar.', response.status === 404 ? 404 : 409);
    }
    if (response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg' || !response.body) {
      await response.body?.cancel?.();
      throw fail('Der Qwen-Server liefert keine gültige Stimmprobe.', 502);
    }
    const target = previewPath(pending.sha256);
    const stat = await writePreview(response, target);
    return { file: target, size: stat.size, sha256: pending.sha256, voiceId: pending.voiceId };
  }

  async function cachedPreviewAudio(voiceId) {
    voiceId = validateVoiceId(voiceId);
    const remote = await catalog();
    const voice = remote.voices.find(candidate => candidate.id === voiceId);
    if (!voice || !voice.previewAvailable) throw fail('Für diese Stimme ist keine aktuelle Stimmprobe gespeichert.', 404);
    const file = previewPath(voice.sha256);
    const stat = await io.stat(file);
    return { file, size: stat.size, sha256: voice.sha256, voiceId };
  }

  return {
    getSettings, select, selectedVoice, createVoice, voiceJob, cancelVoiceJob,
    renameVoice, trashVoice, startPreview, previewStatus, cancelPreview, previewAudio, cachedPreviewAudio,
    serverSettings, saveServerSettings,
  };
}

module.exports = { createTtsVoiceSettings, validateVoiceId, atomicJson, MAX_AUDIO_BYTES };
