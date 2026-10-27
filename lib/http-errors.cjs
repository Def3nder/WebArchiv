'use strict';

// Fehler mit HTTP-Status. Routen geben error.message nur bei gesetztem status
// an den Client weiter; Fehler ohne status gelten als unerwartet (500).
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const isCrossSite = req => req.get('sec-fetch-site') === 'cross-site';

// Allgemeine API-Fehler mit festem Code: Die Oberfläche reagiert auf code
// (z. B. abgelaufene Admin-Sitzung), nie auf den Meldungstext.
const API_ERRORS = {
  not_authenticated: [401, 'Nicht angemeldet.'],
  password_change_required: [403, 'Bitte zuerst ein neues Kennwort festlegen.'],
  admin_required: [403, 'Nur für Administratoren.'],
  forbidden: [403, 'Kein Zugriff.'],
  not_found: [404, 'Nicht gefunden.'],
};

function sendApiError(res, code, extra = {}) {
  const [status, error] = API_ERRORS[code];
  return res.status(status).json({ error, code, ...extra });
}

// Gemeinsamer Rahmen für JSON-Routen der Module: keine Zwischenspeicherung,
// schreibende Aufrufe nur von derselben Website, eigene Fehler (mit status) gehen
// an die Oberfläche, unerwartete nur ins Dienst-Log. mapError kann Fehler ohne
// status in einen httpError übersetzen (z. B. ENOENT → 404).
function jsonRoute(handler, {
  label,
  fallback = 'Die Anfrage ist fehlgeschlagen.',
  crossSiteMessage = 'Änderungen sind nur aus dem Archiv erlaubt.',
  mapError,
} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET' && isCrossSite(req)) throw httpError(403, crossSiteMessage);
      res.json(await handler(req));
    } catch (error) {
      const known = error.status ? error : mapError?.(error);
      if (!known) console.error(`${label} ${req.method} ${req.path}:`, error);
      if (known?.retryAfter) res.set('Retry-After', String(known.retryAfter));
      res.status(known?.status || 500).json({ error: known ? known.message : fallback });
    }
  };
}

module.exports = { httpError, isCrossSite, jsonRoute, sendApiError, API_ERRORS };
