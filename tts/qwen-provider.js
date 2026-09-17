import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import settings from './provider-config.cjs';
import { requestQwen } from './qwen-http.js';

// Vertrag des mitgelieferten qwen_http_service.py, keine OpenAI-Kompatibilität.
export async function synthesizeQwen(text, file, c, signal, emit = () => {}, fetchImpl = requestQwen) {
  const { baseUrl, token } = settings.providerSettings(c);
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('Markdown ist leer oder größer als 1 MB.');
  const id = randomUUID(), endpoint = `${baseUrl}/v1/jobs/${id}`;
  const headers = { Authorization: `Bearer ${token}` };
  let attempted = false, complete = false;
  async function request(url, options = {}, independent = false) {
    const timeout = AbortSignal.timeout(independent ? 5000 : 15000);
    const response = await fetchImpl(url, { ...options, redirect: 'error',
      headers: { ...headers, ...options.headers },
      signal: !independent && signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Qwen-Dienst HTTP ${response.status}.`); }
    return response;
  }
  try {
    signal?.throwIfAborted();
    const health = await (await request(`${baseUrl}/v1/health`)).json();
    if (health.protocol !== 'webarchiv-qwen-v4' || health.full_markdown !== true || health.audio_format !== 'mp3') {
      throw new Error('Qwen-Dienst benötigt das Update auf webarchiv-qwen-v4 (vollständiges Markdown → fertige MP3). Bitte HTTP-Brücke und Worker aktualisieren.');
    }
    if (!Number.isInteger(health.max_markdown_bytes) || Buffer.byteLength(text, 'utf8') > health.max_markdown_bytes) throw new Error('Markdown überschreitet das Serverlimit.');
    attempted = true;
    const started = await (await request(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: text }) })).json();
    if (started.id !== id) throw new Error('Qwen-Auftrags-ID stimmt nicht überein.');
    for (;;) {
      signal?.throwIfAborted();
      const status = await (await request(endpoint)).json();
      if (status.id !== id || !['running', 'succeeded', 'failed', 'cancelled'].includes(status.status)) throw new Error('Ungültiger Qwen-Auftragsstatus.');
      if (status.status === 'succeeded') break;
      if (status.status !== 'running') throw new Error(`Qwen-Auftrag ${status.status}.`);
      await delay(1000, undefined, { signal });
    }
    const response = await request(`${endpoint}/audio`);
    if (response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') {
      await response.body?.cancel(); throw new Error('Qwen liefert keine MP3-Antwort.');
    }
    const expected = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > 512 * 1024 * 1024 || !response.body) {
      await response.body?.cancel(); throw new Error('Ungültige Qwen-Audiolänge.');
    }
    const handle = await fs.open(file, 'wx');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted(); bytes += chunk.length;
        if (bytes > expected) throw new Error('Qwen-Antwort ist länger als angekündigt.');
        await handle.writeFile(chunk);
      }
      if (bytes !== expected) throw new Error('Qwen-Antwort ist unvollständig.');
    } finally { await handle.close(); }
    complete = true;
  } finally {
    // Auch bei verloren gegangener Startantwort ist die Remote-ID bekannt.
    // DELETE legt für noch unbekannte IDs eine Abbruchmarkierung an.
    if (attempted) {
      try { await (await request(endpoint, { method: 'DELETE' }, true)).json(); }
      catch { emit('warning', complete ? 'Remote-Aufräumen fehlgeschlagen; automatische Bereinigung folgt.'
        : 'Remote-Abbruch nicht bestätigt. Der Dienst beendet verwaiste Aufträge nach Ablauf der 90-Sekunden-Lease.'); }
    }
  }
}
