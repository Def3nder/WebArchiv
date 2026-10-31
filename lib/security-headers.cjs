'use strict';

// Sicherheits-Header für alle Antworten, insbesondere die Content-Security-Policy.
// CSP_MODE: „report“ (Standard; Verstöße nur melden), „enforce“ (blockieren)
// oder „off“. Skripte sind strikt auf eigene Dateien beschränkt; Inline-Styles
// bleiben erlaubt (style-Attribute in Templates, CodeMirror-Stylesheets).
// Der eingebettete PDF.js-Viewer braucht WebAssembly und erhält eine eigene Richtlinie.

const crypto = require('crypto');

const CSP_MODES = ['report', 'enforce', 'off'];
const REPORT_PATH = '/api/csp-report';
const PDFJS_PREFIX = '/vendor/pdfjs/';
const MAX_REPORTS_PER_MINUTE = 20;

function cspMode(value) {
  const mode = String(value || 'report').trim().toLowerCase();
  if (!CSP_MODES.includes(mode)) throw new Error(`CSP_MODE muss ${CSP_MODES.join(', ')} sein.`);
  return mode;
}

function serialize(directives) {
  return Object.entries(directives).map(([name, values]) => [name, ...values].join(' ')).join('; ');
}

function appPolicy(nonce) {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com'],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'"],
    'frame-src': ["'self'"],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
    'report-uri': [REPORT_PATH],
  };
}

function pdfjsPolicy() {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:', 'blob:'],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'", 'data:', 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
    'report-uri': [REPORT_PATH],
  };
}

function createSecurityHeaders({ mode = 'report' } = {}) {
  const resolvedMode = cspMode(mode);
  const header = resolvedMode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
  return function securityHeaders(req, res, next) {
    // Nonce pro Antwort, z. B. für das Weiterleitungs-Skript der Link-Vorschau (/a/*).
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
      // Nicht in Suchmaschinen aufnehmen. Bewusst hier und nicht im Reverse Proxy: dessen
      // Option dafür sperrt zugleich Vorschau-Crawler (WhatsApp, Telegram …) für /a/*.
      'X-Robots-Tag': 'noindex, nofollow',
    });
    if (resolvedMode !== 'off') {
      const policy = req.path.startsWith(PDFJS_PREFIX) ? pdfjsPolicy() : appPolicy(res.locals.cspNonce);
      res.set(header, serialize(policy));
    }
    next();
  };
}

// Verstöße landen im Dienstprotokoll (journalctl). Begrenzt, damit eine Seite
// mit vielen Meldungen das Log nicht flutet.
function installCspReportRoute(app, express, { log = console } = {}) {
  let windowStart = 0;
  let count = 0;
  app.post(REPORT_PATH,
    express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '16kb' }),
    (req, res) => {
      const now = Date.now();
      if (now - windowStart > 60 * 1000) { windowStart = now; count = 0; }
      if (++count <= MAX_REPORTS_PER_MINUTE) {
        const reports = Array.isArray(req.body) ? req.body.map(entry => entry?.body) : [req.body?.['csp-report']];
        for (const report of reports.filter(Boolean)) {
          const directive = report['violated-directive'] || report.effectiveDirective || report['effective-directive'] || '?';
          const blocked = report['blocked-uri'] || report.blockedURL || '?';
          const page = report['document-uri'] || report.documentURL || '?';
          const source = report['source-file'] || report.sourceFile || '';
          const line = report['line-number'] || report.lineNumber || '';
          log.warn(`CSP-Verstoß: ${directive} blockiert ${blocked} auf ${page}${source ? ` (${source}:${line})` : ''}`);
        }
      }
      res.status(204).end();
    });
}

module.exports = { createSecurityHeaders, installCspReportRoute, cspMode, REPORT_PATH };
