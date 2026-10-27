'use strict';

// Versionssignatur der App-Shell und Quelltext des Update-Service-Workers
// (siehe public/pwa-update.js). Der Worker cached selbst keine Dateien.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PWA_SHELL_EXTENSIONS = new Set(['.css', '.html', '.ico', '.js', '.json', '.png', '.svg']);
// Shell-Dateien liegen direkt in public/, die Stylesheets in public/css/.
const SHELL_SUBDIRS = ['', 'css'];

function shellFiles(publicDir) {
  return SHELL_SUBDIRS.flatMap(sub => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(publicDir, sub), { withFileTypes: true }); } catch { /* Ordner fehlt */ }
    return entries
      .filter(entry => entry.isFile() && PWA_SHELL_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => (sub ? `${sub}/${entry.name}` : entry.name));
  }).sort((a, b) => a.localeCompare(b, 'en'));
}

function computeAppShellVersion(publicDir = PUBLIC_DIR) {
  const hash = crypto.createHash('sha256');
  const files = shellFiles(publicDir);

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
    const next = shellFiles(publicDir)
      .map(file => {
        const stat = fs.statSync(path.join(publicDir, file));
        return `${file}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
    if (next !== signature) {
      version = computeAppShellVersion(publicDir);
      signature = next;
    }
    return version;
  };
}

// Lokale Skripte und Stylesheets in index.html (src="app.js", href="css/base.css").
const LOCAL_ASSET_RE = /\b(src|href)="(?![a-z]+:|\/\/)([^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"/gi;

// index.html mit automatischen Cache-Bustern: Jede lokale JS-/CSS-Referenz bekommt
// ?v=<Kurz-Hash des Dateiinhalts>. Neu berechnet wird nur, wenn sich index.html
// oder eine der referenzierten Dateien ändert (pro Abruf nur stat). transform
// erhält das versionierte HTML (z. B. für die rollenabhängigen Varianten).
function createVersionedIndex(indexFile, transform = html => html) {
  const dir = path.dirname(indexFile);
  let indexSignature = null;
  let assets = [];      // referenzierte Dateien aus index.html
  let signature = null;
  let value = null;
  const statKey = file => {
    try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}`; }
    catch { return 'fehlt'; }
  };
  return () => {
    const indexKey = statKey(indexFile);
    if (indexKey !== indexSignature) {
      const html = fs.readFileSync(indexFile, 'utf8');
      assets = [...new Set([...html.matchAll(LOCAL_ASSET_RE)].map(match => match[2]))];
      indexSignature = indexKey;
      signature = null;
    }
    const next = indexKey + '|' + assets.map(asset => `${asset}:${statKey(path.join(dir, asset))}`).join('|');
    if (next !== signature) {
      const versions = new Map(assets.map(asset => {
        let hash = 'fehlt';
        try { hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, asset))).digest('hex').slice(0, 10); }
        catch { /* fehlende Datei: Referenz bleibt sichtbar, der Browser meldet 404 */ }
        return [asset, hash];
      }));
      const html = fs.readFileSync(indexFile, 'utf8')
        .replace(LOCAL_ASSET_RE, (_match, attr, asset) => `${attr}="${asset}?v=${versions.get(asset)}"`);
      value = transform(html);
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

module.exports = {
  computeAppShellVersion, createAppShellVersion, createVersionedIndex, serviceWorkerSource, PWA_SHELL_EXTENSIONS,
};
