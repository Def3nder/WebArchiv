import http from 'node:http';
import https from 'node:https';

// Bewusst ohne fetch/Undici: dessen pausierter Parser kann bei Socket-Ende
// einen nicht abfangbaren AssertionError auslösen (nodejs/undici#5360).
export function requestQwen(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Ungültiges HTTP-Protokoll.'));
    const payload = body === undefined ? undefined : Buffer.from(body);
    const request = (parsed.protocol === 'https:' ? https : http).request(parsed, {
      method, agent: false, signal,
      headers: { ...headers, Connection: 'close', ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, response => {
      // Fehler bleiben auch zwischen Headerempfang und Beginn des Dateischreibens behandelt.
      response.on('error', () => {});
      response.cancel = async () => { response.destroy(); };
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: { get: name => response.headers[name.toLowerCase()] ?? null },
        body: response,
        async json() {
          const chunks = []; let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > 65536) { response.destroy(); throw new Error('Qwen-JSON-Antwort ist zu groß.'); }
            chunks.push(chunk);
          }
          if (!response.complete) throw new Error('Qwen-HTTP-Antwort ist unvollständig.');
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        },
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}
