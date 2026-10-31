'use strict';

// Link-Vorschau (Open Graph) und Prompt-Dateien fürs Kopiermenü.
//
// Crawler (WhatsApp, Signal, Telegram …) führen kein JS aus und ignorieren
// den #-Teil der URL. Deshalb liefert /a/<id> serverseitig og:*-Meta-Tags und
// leitet echte Besucher per JS/meta-refresh in den SPA (#/article/<id>) weiter.
// Die ID kann zu einem Artikel oder Hörbuch gehören. /a/* und /og-image/* sind
// bewusst ohne Anmeldung erreichbar (siehe CLAUDE.md, „Link-preview exception“).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { escapeHtml } = require('../lib/html-sanitizer.cjs');
const { isPathInside } = require('../lib/archive-files.cjs');
const { shareIdFor, createShareIdLookup } = require('../lib/share-ids.cjs');
const { resolveMediaRequest } = require('./media-files.cjs');

// Artikelbilder liegen unter /files, Hörbuch-Cover unter /audio-files. Für die
// öffentliche Vorschau wird der URL-Pfad sicher auf die jeweilige Wurzel begrenzt.
function resolvePreviewImagePath(item, { wwwDir, audioDir }) {
  if (!item?.imageUrl) return null;
  const pathname = item.imageUrl.split('?')[0];
  const root = pathname.startsWith('/files/') ? wwwDir
    : pathname.startsWith('/audio-files/') ? audioDir
    : null;
  if (!root) return null;
  let rel;
  try { rel = decodeURIComponent(pathname.replace(/^\/(?:files|audio-files)\//, '')); }
  catch { return null; }
  // Dieselbe Prüfung wie /files/* und /audio-files/* (keine Punktsegmente).
  return resolveMediaRequest(root, rel)?.absPath || null;
}

// archive: Indexzustand aus server.js; duplicateCanonicalFor: Blogartikel einer
// verknüpften Dublette; audiobooks: Hörbuch-Bibliothek (Gastansicht, ohne private Bücher).
function installLinkPreviewRoutes(app, { archive, duplicateCanonicalFor, audiobooks, wwwDir, audioDir }) {
  const resolveShareId = createShareIdLookup(() => [archive.articles, audiobooks.books || []]);

  // Volle ID (ältere Links) oder kurze Teilen-ID (lib/share-ids.cjs).
  function publicShareItem(param) {
    const id = archive.articleById.has(param) ? param : (resolveShareId(param) || param);
    const article = archive.articleById.get(id);
    return (article ? (duplicateCanonicalFor(article) || article) : null) || audiobooks.getForUser(null, id);
  }

  app.get('/a/*', (req, res) => {
    const id = req.params[0];
    const article = publicShareItem(id);
    const canonicalId = article?.id || id;
    const base = `${req.protocol}://${req.get('host')}`;
    const canonical = base + '/a/' + (article ? shareIdFor(canonicalId) : encodeURIComponent(canonicalId));

    let tags;
    if (article) {
      const title = escapeHtml(article.title || 'WebArchiv');
      const img   = article.imageUrl ? base + '/og-image/' + shareIdFor(canonicalId) : '';
      // Bewusst ohne (og:/twitter:)description: Die Vorschau zeigt neben dem Bild nur
      // den Titel, der dadurch den ganzen Platz bekommt. Ohne og:description würden
      // Messenger auf <meta name="description"> zurückfallen, deshalb fehlt auch diese.
      tags = `
    <title>${title}</title>
    <meta property="og:site_name" content="WebArchiv" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${title}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    ${img ? `<meta property="og:image" content="${escapeHtml(img)}" />` : ''}
    <meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}" />
    <meta name="twitter:title" content="${title}" />
    ${img ? `<meta name="twitter:image" content="${escapeHtml(img)}" />` : ''}`;
    } else {
      tags = `
    <title>WebArchiv</title>
    <meta property="og:site_name" content="WebArchiv" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="WebArchiv" />
    <meta property="og:url" content="${escapeHtml(base + '/')}" />`;
    }

    // JS-Weiterleitung für Menschen; Crawler lesen nur die Meta-Tags oben.
    const target = '/#/article/' + encodeURIComponent(canonicalId);
    res.type('html').send(`<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(target)}" />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />${tags}
</head>
<body>
    <p>Weiterleitung … <a href="${escapeHtml(target)}">Zum Artikel</a></p>
    <script nonce="${escapeHtml(res.locals.cspNonce)}">location.replace(${JSON.stringify(target)});</script>
</body>
</html>`);
  });

  // Auth-freie, heruntergerechnete Bild-Auslieferung nur für die Link-Vorschau.
  // Bewusst ohne canAccessAuthor: die Vorschau-Metadaten aller Artikel und
  // Hörbücher sind öffentlich (Nutzer-Entscheidung). Das Bild wird auf max. 1200px/JPEG skaliert,
  // damit nie die Originalauflösung geteilt wird. Ergebnis pro mtime gecacht.
  const ogImageCache = new Map(); // key: absPath+':'+mtime+':'+Kantenlänge → Buffer
  // ?sq=<Kantenlänge>: quadratischer Ausschnitt vom oberen Bildteil (Sperrbildschirm/Media Session).
  const OG_SQUARE_SIZES = new Set([256, 512]);

  app.get('/og-image/*', async (req, res) => {
    const id = req.params[0];
    const article = publicShareItem(id);
    const absPath = resolvePreviewImagePath(article, { wwwDir, audioDir });
    if (!absPath) return res.status(404).end();

    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(absPath).mtimeMs); } catch { return res.status(404).end(); }

    const square = OG_SQUARE_SIZES.has(Number(req.query.sq)) ? Number(req.query.sq) : 0;
    const key = absPath + ':' + mtime + ':' + square;
    res.set('Cache-Control', 'public, max-age=86400');

    const cached = ogImageCache.get(key);
    if (cached) return res.type('image/jpeg').send(cached);

    try {
      const image = square
        ? sharp(absPath).resize({ width: square, height: square, fit: 'cover', position: 'top' })
        : sharp(absPath).resize({ width: 1200, withoutEnlargement: true });
      const buf = await image.jpeg({ quality: 80 }).toBuffer();
      // Cache begrenzen (einfaches FIFO), um Speicher im kleinen LXC zu schonen.
      if (ogImageCache.size >= 200) ogImageCache.delete(ogImageCache.keys().next().value);
      ogImageCache.set(key, buf);
      res.type('image/jpeg').send(buf);
    } catch (err) {
      // Fallback: Original ausliefern, damit die Vorschau funktionsfähig bleibt.
      res.sendFile(absPath, e => { if (e && !res.headersSent) res.status(404).end(); });
    }
  });
}

function parsePromptDefinition(content) {
  const lines = String(content).replace(/^﻿/, '').split(/\r?\n/);
  const urlMarker = lines.findIndex(line => line.trim().toUpperCase() === 'URL:');
  const promptMarker = lines.findIndex((line, index) => index > urlMarker && line.trim().toUpperCase() === 'PROMPT:');
  if (urlMarker < 0 || promptMarker < 0) throw new Error('URL:- oder PROMPT:-Abschnitt fehlt.');

  const urlText = lines.slice(urlMarker + 1, promptMarker).map(line => line.trim()).find(Boolean);
  if (!urlText) throw new Error('Die Prompt-URL fehlt.');
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error('Die Prompt-URL ist ungültig.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Die Prompt-URL muss HTTP oder HTTPS verwenden.');

  const prompt = lines.slice(promptMarker + 1).join('\n').trim();
  if (!prompt) throw new Error('Der Prompt ist leer.');
  return { url: url.href, prompt };
}

function installPromptRoutes(app, { attachUser, promptsDir }) {
  // Liste der verfügbaren Prompt-Dateien; Zahlen-Präfix steuert Reihenfolge
  // und wird aus dem Label entfernt (z. B. "1_Infografik-Prompt-ChatGPT.txt").
  app.get('/api/prompts', attachUser, (_req, res) => {
    try {
      const prompts = fs.readdirSync(promptsDir)
        .filter(f => f.toLowerCase().endsWith('.txt'))
        .map(file => {
          const stem = file.slice(0, -4);
          const m = stem.match(/^(\d+)_(.*)$/);
          try {
            const definition = parsePromptDefinition(fs.readFileSync(path.join(promptsDir, file), 'utf8'));
            return {
              file,
              label: m ? m[2] : stem,
              order: m ? parseInt(m[1], 10) : Infinity,
              ...definition,
            };
          } catch (err) {
            console.warn(`Prompt-Datei „${file}“ wird ignoriert: ${err.message}`);
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
        .map(({ file, label, url, prompt }) => ({ file, label, url, prompt }));
      res.json(prompts);
    } catch {
      res.json([]);
    }
  });

  // Inhalt einer einzelnen Prompt-Datei (Path-Traversal-Schutz wie /files/*)
  app.get('/api/prompts/:file', attachUser, (req, res) => {
    const file = path.basename(req.params.file);
    if (!file.toLowerCase().endsWith('.txt')) return res.status(400).end();
    const absPath = path.resolve(promptsDir, file);
    if (!isPathInside(promptsDir, absPath)) return res.status(400).end();
    try {
      const txt = fs.readFileSync(absPath, 'utf8');
      const { prompt } = parsePromptDefinition(txt);
      res.type('text/plain').send(prompt);
    } catch (err) {
      if (err?.code === 'ENOENT') return res.status(404).end();
      if (err instanceof Error) return res.status(422).type('text/plain').send(err.message);
      res.status(404).end();
    }
  });
}

module.exports = {
  resolvePreviewImagePath, parsePromptDefinition, installLinkPreviewRoutes, installPromptRoutes,
};
