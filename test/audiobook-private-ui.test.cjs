const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const books = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'audiobooks.cjs'), 'utf8');
const sessionState = fs.readFileSync(path.join(ROOT, 'public', 'session-state.js'), 'utf8');

test('Sortierung bietet die Privat-Ansicht ausschließlich Administratoren an', () => {
  assert.match(html, /<option value="private" hidden disabled>Privat<\/option>/);
  assert.match(books, /const BOOK_SORTS = \['recent', 'added', 'title', 'date', 'private'\]/);
  assert.match(books, /function syncBookPrivateAccess\([\s\S]*?option\.hidden = !isAdmin;[\s\S]*?option\.disabled = !isAdmin/);
  assert.match(app, /const visibleOptions = \[\.\.\.select\.options\]\.filter\(option => !option\.hidden\)/);
  assert.match(books, /state\.bookSort === 'private'[\s\S]*?state\.bookSort = 'recent'/);
  assert.match(sessionState, /\['recent', 'added', 'title', 'date', 'private'\]/);
  assert.match(server, /requestedMode === 'private' && !isAdmin \? 'recent' : requestedMode/);
  assert.match(server, /isAdmin && mode === 'private' \? isPrivate\(book\) : !isPrivate\(book\)/);
});

test('Nur Administratoren können die globale Privat-Markierung umschalten', () => {
  assert.match(books, /const privateAction = currentUser\?\.role === 'admin'/);
  assert.match(books, /data-book-private>\$\{book\.private \? 'Privat aufheben' : 'Als privat markieren'\}/);
  assert.match(books, /apiFetch\('\/api\/audiobook-private\/'[\s\S]*?method: 'PUT'[\s\S]*?private: !book\.private/);
  assert.match(server, /app\.put\('\/api\/audiobook-private\/\*'[\s\S]*?progress\.setPrivate\(book\.id, req\.body\?\.private\)[\s\S]*?}, true\)\);/);
  assert.match(html, /audiobooks\.js\?v=24/);
});

test('Server sperrt Detail-, Zusatz- und Medienzugriffe auf private Hörbücher', () => {
  assert.match(server, /function canAccess\(user, book\)[\s\S]*?user\?\.role === 'admin' \|\| !progress\.isPrivate\(book\.id\)/);
  assert.match(server, /const accessibleBook = \(user, id\)[\s\S]*?library\.getForUser\(user, id\)/);
  const mainServer = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mediaRoutes = fs.readFileSync(path.join(ROOT, 'media-files.cjs'), 'utf8');
  assert.match(mediaRoutes, /!audiobooks\.canAccessMedia\(req\.user, relPath, \{ decoded: true \}\)/);
  assert.match(mainServer, /installMediaRoutes\(app, \{[\s\S]*?audiobooks, canAccessAuthor, attachUser/);
  assert.match(mainServer, /function publicShareItem\(id\)[\s\S]*?audiobooks\.getForUser\(null, id\)/);
});
