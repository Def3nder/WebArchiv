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

module.exports = { computeAppShellVersion, serviceWorkerSource, PWA_SHELL_EXTENSIONS };
