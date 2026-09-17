const fs = require('node:fs/promises');
const path = require('node:path');

function providerSettings(c, env = process.env) {
  const provider = c.tts.provider || 'openai';
  if (!['qwen', 'openai'].includes(provider)) throw new Error('Unbekannter TTS-Provider.');
  if (provider === 'openai') return { provider };
  const q = c.qwen;
  if (!q) throw new Error('Qwen-Konfiguration fehlt.');
  const url = new URL(env[q.base_url_environment_variable] || q.base_url || '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') throw new Error('Qwen-Basis-URL muss eine HTTP(S)-Adresse ohne Pfad oder Zugangsdaten sein.');
  const token = env[q.token_environment_variable]?.trim();
  if (!token) throw new Error('Qwen-Zugangstoken fehlt.');
  return { provider, baseUrl: url.origin, token };
}

async function providerInfo({ config, env = process.env, request, timeoutMs = 3000 } = {}) {
  const c = config || JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
  let qwenAvailable = false;
    try {
      const { baseUrl, token } = providerSettings({ ...c, tts: { ...c.tts, provider: 'qwen' } }, env);
      const send = request || (await import('./qwen-http.js')).requestQwen;
      const response = await send(`${baseUrl}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('health');
      }
      const health = await response.json();
      if (health.protocol !== 'webarchiv-qwen-v4' || health.full_markdown !== true
          || health.audio_format !== 'mp3' || !Number.isInteger(health.max_markdown_bytes)
          || health.max_markdown_bytes < 1) throw new Error('contract');
      qwenAvailable = true;
    } catch { /* Verfügbarkeit wird angezeigt; kein automatischer Providerwechsel. */ }
  const openaiAvailable = !!env[c.tts.api_key_environment_variable]?.trim();
  return { providers: [
    { provider: 'qwen', label: 'Qwen-TTS (lokaler Server)', available: qwenAvailable,
      status: qwenAvailable ? 'Server antwortet.' : 'Nicht erreichbar, inkompatibel oder nicht konfiguriert.',
      confirmation: 'Die vollständige Markdown-Datei wird an den lokalen Qwen-TTS-Server übertragen. Dessen Originalscript erstellt die fertige MP3. Es erfolgt kein OpenAI-Aufruf.' },
    { provider: 'openai', label: 'OpenAI API (kostenpflichtig)', available: openaiAvailable,
      status: openaiAvailable ? 'API-Schlüssel vorhanden; Gültigkeit und Guthaben wurden nicht geprüft.' : 'API-Schlüssel fehlt.',
      confirmation: 'Die Sprachgenerierung ist kostenpflichtig. Der Sprechtext wird an OpenAI übertragen. Mit „Audio-Generierung starten“ geben Sie diesen OpenAI-Aufruf frei.' },
  ] };
}

module.exports = { providerSettings, providerInfo };
