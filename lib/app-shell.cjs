'use strict';

// Versionssignatur der App-Shell und Quelltext des Update-Service-Workers
// (siehe public/pwa-update.js). Der Worker cached selbst keine Dateien.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PWA_SHELL_EXTENSIONS = new Set(['.css', '.html', '.ico', '.js', '.json', '.png', '.svg']);

function computeAppShellVersion(publicDir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(publicDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && PWA_SHELL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(publicDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// Wie computeAppShellVersion, hasht aber nur neu, wenn sich Name, Größe oder
// Änderungszeit einer Shell-Datei geändert haben (pro Abruf nur stat statt Lesen).
function createAppShellVersion(publicDir = PUBLIC_DIR) {
  let signature = null;
  let version = null;
  return () => {
    const next = fs.readdirSync(publicDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && PWA_SHELL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => {
        const stat = fs.statSync(path.join(publicDir, entry.name));
        return `${entry.name}:${stat.size}:${stat.mtimeMs}`;
      })
      .sort()
      .join('|');
    if (next !== signature) {
      version = computeAppShellVersion(publicDir);
      signature = next;
    }
    return version;
  };
}

// Liest eine Textdatei nur neu, wenn sich Größe oder Änderungszeit geändert haben,
// und hält das von transform berechnete Ergebnis bis dahin vor.
function cachedTextFile(file, transform = text => text) {
  let signature = null;
  let value = null;
  return () => {
    const stat = fs.statSync(file);
    const next = `${stat.size}:${stat.mtimeMs}`;
    if (next !== signature) {
      value = transform(fs.readFileSync(file, 'utf8'));
      signature = next;
    }
    return value;
  };
}

function serviceWorkerSource(version) {
  return `'use strict';
const APP_VERSION = ${JSON.stringify(version)};

self.addEventListener('install', () => {
  // Aktualisierte Worker warten, bis der Benutzer im Hinweis zustimmt.
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
`;
}

module.exports = { computeAppShellVersion, createAppShellVersion, cachedTextFile, serviceWorkerSource, PWA_SHELL_EXTENSIONS };
