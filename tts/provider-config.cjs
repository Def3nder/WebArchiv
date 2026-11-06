const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const QWEN_PROTOCOL = 'webarchiv-qwen-v5';
const DEFAULT_QWEN_PORT = 8765;
const URL_RULE = 'Qwen-Basis-URL muss eine HTTP(S)-Adresse ohne Pfad oder Zugangsdaten sein.';

// Adresse aus dem Dialog „TTS-Einstellungen“: nackte IP/Rechnername bekommt http:// und Port 8765.
function normalizeBaseUrl(value, { defaultPort = null } = {}) {
  let text = String(value ?? '').trim();
  if (!text) throw new Error('Bitte die IP-Adresse oder den Rechnernamen des Qwen-TTS-Servers eingeben.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error(`„${String(value).trim()}“ ist keine gültige Adresse.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !url.hostname) throw new Error(URL_RULE);
  const explicitPort = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/?#:]*)(?::\d+)/i.test(text);
  if (defaultPort && !explicitPort) url.port = String(defaultPort);
  return url.origin;
}

// Laufzeitdatei mit der im WebArchiv gespeicherten Adresse (gitignored, wie tts-settings.json).
function connectionFile(c, env = process.env) {
  if (env.TTS_CONNECTION_FILE) return path.resolve(env.TTS_CONNECTION_FILE);
  return c?.qwen?.base_url_file ? path.resolve(__dirname, c.qwen.base_url_file) : null;
}

function readStoredConnection(file) {
  if (!file) return null;
  let value;
  try { value = JSON.parse(fsSync.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Die gespeicherte Qwen-Adresse (${path.basename(file)}) ist nicht lesbar.`);
  }
  if (!value || typeof value.qwenBaseUrl !== 'string') return null;
  return {
    baseUrl: normalizeBaseUrl(value.qwenBaseUrl),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : null,
  };
}

// Vorrang: im WebArchiv gespeichert > Umgebungsvariable > config.json (`base_url`).
function qwenBaseUrl(c, env = process.env) {
  const q = c?.qwen;
  if (!q) throw new Error('Qwen-Konfiguration fehlt.');
  const stored = readStoredConnection(connectionFile(c, env));
  if (stored) return { baseUrl: stored.baseUrl, source: 'webarchiv', stored };
  const fromEnv = q.base_url_environment_variable && env[q.base_url_environment_variable];
  const raw = fromEnv || q.base_url || '';
  let url;
  try { url = new URL(raw); } catch { throw new Error('Qwen-Adresse fehlt: in „TTS-Einstellungen“ eintragen.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/') throw new Error(URL_RULE);
  return { baseUrl: url.origin, source: fromEnv ? 'environment' : 'config', stored: null };
}

function providerSettings(c, env = process.env) {
  const provider = c.tts.provider || 'openai';
  if (!['qwen', 'openai'].includes(provider)) throw new Error('Unbekannter TTS-Provider.');
  if (provider === 'openai') return { provider };
  const { baseUrl, source } = qwenBaseUrl(c, env);
  const token = env[c.qwen.token_environment_variable]?.trim();
  if (!token) throw new Error('Qwen-Zugangstoken fehlt.');
  return { provider, baseUrl, token, baseUrlSource: source };
}

function describeNetworkError(error, url, timeoutMs) {
  const code = error?.code || error?.cause?.code;
  const where = url.host;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT') {
    return { code: 'timeout', reason: `Keine Antwort von ${where} innerhalb von ${Math.round(timeoutMs / 1000)} s: `
      + `IP-Adresse falsch, Rechner aus oder im Ruhezustand, oder eine Firewall blockiert Port ${port}.` };
  }
  if (code === 'ECONNREFUSED') {
    return { code: 'refused', reason: `${url.hostname} ist erreichbar, aber auf Port ${port} läuft kein Dienst: `
      + 'Qwen-TTS-Dienst gestartet (mit --host 0.0.0.0)? Port richtig?' };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { code: 'unreachable', reason: `${url.hostname} ist im Netzwerk nicht erreichbar: IP-Adresse falsch oder Rechner aus.` };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'not_found', reason: `Der Rechnername ${url.hostname} ist unbekannt.` };
  }
  if (code === 'ECONNRESET') return { code: 'reset', reason: `${where} hat die Verbindung abgebrochen.` };
  return { code: 'network', reason: `Verbindung zu ${where} fehlgeschlagen: ${error?.message || 'unbekannter Fehler'}.` };
}

// Health-Check mit verständlichem Grund; wirft nie (Ergebnis `{ ok, code, reason }`).
async function checkQwen({ baseUrl, token, request, timeoutMs = 3000 }) {
  const started = Date.now();
  const url = new URL(baseUrl);
  const done = result => ({ ...result, baseUrl: url.origin, milliseconds: Date.now() - started });
  if (!token) {
    return done({ ok: false, code: 'token_missing',
      reason: 'Auf dem WebArchiv-Server fehlt das Qwen-Zugangstoken (Umgebungsvariable QWEN_TTS_TOKEN).' });
  }
  let response;
  try {
    const send = request || (await import('./qwen-http.js')).requestQwen;
    response = await send(`${url.origin}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) { return done({ ok: false, ...describeNetworkError(error, url, timeoutMs) }); }
  if (!response.ok) {
    await response.body?.cancel?.();
    if (response.status === 401) {
      return done({ ok: false, code: 'unauthorized', reason: `${url.host} antwortet, lehnt aber das Token ab: `
        + 'QWEN_TTS_TOKEN muss auf dem WebArchiv-Server und dem Qwen-Rechner gleich sein.' });
    }
    return done({ ok: false, code: 'http_error',
      reason: `${url.host} antwortet mit HTTP ${response.status}: Läuft dort auf diesem Port wirklich der Qwen-TTS-Dienst?` });
  }
  let health;
  try { health = await response.json(); }
  catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return done({ ok: false, ...describeNetworkError(error, url, timeoutMs) });
    }
    return done({ ok: false, code: 'invalid_response',
      reason: `${url.host} antwortet, aber nicht wie der Qwen-TTS-Dienst (keine gültige JSON-Antwort).` });
  }
  if (health?.protocol !== QWEN_PROTOCOL || health.full_markdown !== true || health.audio_format !== 'mp3'
      || health.chunk_progress !== true || !Number.isInteger(health.max_markdown_bytes) || health.max_markdown_bytes < 1) {
    return done({ ok: false, code: 'incompatible', protocol: health?.protocol || null,
      reason: `Der Qwen-Dienst auf ${url.host} ist veraltet oder inkompatibel (Protokoll ${health?.protocol || 'unbekannt'}, `
        + `benötigt ${QWEN_PROTOCOL}): qwen_http_service.py und qwen_chunk_worker.py aktualisieren.` });
  }
  const milliseconds = Date.now() - started;
  return done({ ok: true, code: 'ok', protocol: health.protocol, voiceCatalog: health.voice_catalog === true,
    reason: `Verbindung erfolgreich: ${url.host} antwortet in ${milliseconds} ms (Protokoll ${health.protocol}`
      + `${health.voice_catalog === true ? ', Stimmenverwaltung aktiv' : ''}).` });
}

async function providerInfo({ config, env = process.env, request, timeoutMs = 3000 } = {}) {
  const c = config || JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
  let qwen;
  try {
    const { baseUrl } = qwenBaseUrl(c, env);
    qwen = await checkQwen({ baseUrl, token: env[c.qwen.token_environment_variable]?.trim(), request, timeoutMs });
  } catch (error) {
    // Verfügbarkeit wird mit Grund angezeigt; kein automatischer Providerwechsel.
    qwen = { ok: false, code: 'config', reason: error.message };
  }
  const openaiAvailable = !!env[c.tts.api_key_environment_variable]?.trim();
  return { providers: [
    { provider: 'qwen', label: 'Qwen-TTS (lokaler Server)', available: qwen.ok,
      status: qwen.ok ? `Server antwortet (${new URL(qwen.baseUrl).host}).`
        : `${qwen.reason} Adresse unter „TTS-Einstellungen“ prüfen.`,
      confirmation: 'Die vollständige Markdown-Datei wird an den lokalen Qwen-TTS-Server übertragen. Dessen Originalscript erstellt die fertige MP3. Es erfolgt kein OpenAI-Aufruf.' },
    { provider: 'openai', label: 'OpenAI API (kostenpflichtig)', available: openaiAvailable,
      status: openaiAvailable ? 'API-Schlüssel vorhanden; Gültigkeit und Guthaben wurden nicht geprüft.' : 'API-Schlüssel fehlt.',
      confirmation: 'Die Sprachgenerierung ist kostenpflichtig. Der Sprechtext wird an OpenAI übertragen. Mit „Audio-Generierung starten“ geben Sie diesen OpenAI-Aufruf frei.' },
  ] };
}

module.exports = {
  providerSettings, providerInfo, checkQwen, qwenBaseUrl, normalizeBaseUrl, connectionFile, readStoredConnection,
  DEFAULT_QWEN_PORT, QWEN_PROTOCOL,
};
