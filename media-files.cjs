'use strict';

// Geschützte Medienauslieferung: /files/* (www/) und /audio-files/* (audio/).
// Die Rechteprüfung muss genau den Pfad sehen, der anschließend ausgeliefert
// wird. Deshalb werden Punktsegmente abgewiesen statt aufgelöst; der Autor
// ergibt sich erst aus dem geprüften Pfad (früher: „Videos/../Joe Turan/…“
// wurde als öffentlicher Autor „Videos“ geprüft, aber aus „Joe Turan“ geliefert).

const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

function isPathInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Auf Windows unterscheidet das Dateisystem keine Groß-/Kleinschreibung.
function sameName(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  return IS_WINDOWS ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

// Nur aus Punkten/Leerzeichen bestehende Segmente sind „.“/„..“ oder werden von
// Windows dazu gekürzt („.. “); ein legitimer Archivpfad enthält sie nie.
function invalidSegment(segment) {
  return segment === '' || /^[. ]+$/.test(segment) || (IS_WINDOWS && segment.includes(':'));
}

// requestPath ist der von Express bereits dekodierte Teil hinter der Route.
// Ergebnis: { absPath, segments, relPath } oder null bei ungültigem Pfad.
function resolveMediaRequest(root, requestPath) {
  const raw = String(requestPath || '');
  if (!raw || raw.includes('\0')) return null;
  const segments = raw.split(/[\\/]/);
  if (segments.some(invalidSegment)) return null;
  const absPath = path.resolve(root, ...segments);
  if (!isPathInside(root, absPath)) return null;
  return { absPath, segments, relPath: segments.join('/') };
}

function sendMedia(res, absPath) {
  res.sendFile(absPath, err => { if (err && !res.headersSent) res.status(404).end(); });
}

function installMediaRoutes(app, {
  wwwDir, audioDir, infographicsAuthor, audiobookAuthor, audiobooks, canAccessAuthor, attachUser,
}) {
  app.get('/files/*', attachUser, (req, res) => {
    const media = resolveMediaRequest(wwwDir, req.params[0]);
    if (!media) return res.status(400).end();
    const [author, second] = media.segments;
    // Gelöschte Infografiken bleiben als Dateien erhalten, werden aber nie ausgeliefert.
    if (sameName(author, infographicsAuthor) && String(second || '').toLowerCase() === 'trash') {
      return res.status(404).end();
    }
    if (!canAccessAuthor(req.user, author)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    sendMedia(res, media.absPath);
  });

  app.get('/audio-files/*', attachUser, (req, res) => {
    const media = resolveMediaRequest(audioDir, req.params[0]);
    if (!media) return res.status(400).end();
    const relPath = media.relPath;
    const topDir = media.segments[0];
    // Ersetzte TTS-Dateien bleiben wiederherstellbar, dürfen aber nicht ausgeliefert werden.
    if (topDir.toLowerCase() === 'trash') return res.status(404).end();
    // Das Hörbuch-Verzeichnis (z. B. „Hoerbuecher“) gehört zum Autor „Hörbücher“.
    const isAudiobookDir = sameName(topDir, audiobooks.directory);
    const author = isAudiobookDir ? audiobookAuthor : topDir;
    if (!canAccessAuthor(req.user, author)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (isAudiobookDir && !audiobooks.canAccessMedia(req.user, relPath, { decoded: true })) {
      return res.status(404).end();
    }
    // Hörbuch-Tracks (.m4b/.m4a) kennt die MIME-Tabelle nicht; Browser brauchen audio/mp4.
    if (/\.m4[ab]$/i.test(media.absPath)) res.type('audio/mp4');
    sendMedia(res, media.absPath);
  });
}

module.exports = { isPathInside, resolveMediaRequest, installMediaRoutes };
