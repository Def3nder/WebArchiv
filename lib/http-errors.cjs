'use strict';

// Fehler mit HTTP-Status. Routen geben error.message nur bei gesetztem status
// an den Client weiter; Fehler ohne status gelten als unerwartet (500).
// extra: Zusatzfelder der Fehlerantwort (z. B. { started: false }).
function httpError(status, message, extra = null) {
  return Object.assign(new Error(message), extra ? { status, extra } : { status });
}

const isCrossSite = req => req.get('sec-fetch-site') === 'cross-site';

// Allgemeine API-Fehler mit festem Code: Die Oberfläche reagiert auf code
// (z. B. abgelaufene Admin-Sitzung), nie auf den Meldungstext.
const API_ERRORS = {
  not_authenticated: [401, 'Nicht angemeldet.'],
  password_change_required: [403, 'Bitte zuerst ein neues Kennwort festlegen.'],
  admin_required: [403, 'Nur für Administratoren.'],
  forbidden: [403, 'Kein Zugriff.'],
  // Schutz der Admin-Schreibzugriffe (requireAdminAccess in server.js).
  cross_site: [403, 'Änderungen sind nur aus dem Archiv erlaubt.'],
  invalid_origin: [403, 'Ungültige Anfrageherkunft.'],
  csrf_invalid: [403, 'Ungültiges oder fehlendes Sicherheitstoken.'],
  not_found: [404, 'Nicht gefunden.'],
  internal: [500, 'Die Anfrage ist fehlgeschlagen.'],
};

function sendApiError(res, code, extra = {}) {
  const [status, error] = API_ERRORS[code];
  return res.status(status).json({ error, code, ...extra });
}

// Dasselbe als Fehler zum Werfen in jsonRoute-Handlern (Antwort { error, code }).
function apiError(code) {
  const [status, error] = API_ERRORS[code];
  return httpError(status, error, { code });
}

// Fehlerantwort einer Route: eigene Fehler (mit status) gehen mit ihrer Meldung und
// ihren Zusatzfeldern (extra) an die Oberfläche, unerwartete nur ins Dienst-Log (Pfade,
// Systemmeldungen). Schlug zusätzlich das Zurückrollen fehl, steht dessen Ursache
// ebenfalls nur im Log.
function sendRouteError(res, error, { label, fallback = 'Die Anfrage ist fehlgeschlagen.', rollbackError = null } = {}) {
  if (!error?.status) console.error(`${label}:`, error);
  if (rollbackError) console.error(`${label} – Wiederherstellung fehlgeschlagen:`, rollbackError);
  if (error?.retryAfter) res.set('Retry-After', String(error.retryAfter));
  const message = error?.status ? error.message : fallback;
  return res.status(error?.status || 500).json({
    ...(error?.status ? error.extra : null),
    error: rollbackError ? `${message} Wiederherstellung fehlgeschlagen; Details stehen im Server-Log.` : message,
  });
}

// Gemeinsamer Rahmen für JSON-Routen der Module: keine Zwischenspeicherung,
// schreibende Aufrufe nur von derselben Website, Fehler über sendRouteError.
// mapError kann Fehler ohne status in einen httpError übersetzen (z. B. ENOENT → 404).
// Muss ein Handler nach einem Fehler Dateien zurückrollen und scheitert dabei, hängt
// er die Ursache als error.rollbackError an und wirft den ursprünglichen Fehler weiter.
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
      sendRouteError(res, known || error, {
        label: `${label} ${req.method} ${req.path}`, fallback, rollbackError: error.rollbackError || null,
      });
    }
  };
}

module.exports = { httpError, apiError, isCrossSite, jsonRoute, sendApiError, sendRouteError, API_ERRORS };
