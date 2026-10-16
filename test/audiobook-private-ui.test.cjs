const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const books = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'audiobooks.cjs'), 'utf8');
const sessionState = fs.readFileSync(path.join(ROOT, 'public', 'session-state.js'), 'utf8');

test('Sortierung bietet die exklusive Privat-Ansicht an', () => {
  assert.match(html, /<option value="private">Privat<\/option>/);
  assert.match(books, /\['recent', 'added', 'title', 'date', 'private'\]/);
  assert.match(sessionState, /\['recent', 'added', 'title', 'date', 'private'\]/);
  assert.match(server, /mode === 'private' \? isPrivate\(book\) : !isPrivate\(book\)/);
});

test('Aktionen-Menü kann die persönliche Privat-Markierung umschalten', () => {
  assert.match(books, /data-book-private>\$\{book\.private \? 'Privat aufheben' : 'Als privat markieren'\}/);
  assert.match(books, /apiFetch\('\/api\/audiobook-private\/'[\s\S]*?method: 'PUT'[\s\S]*?private: !book\.private/);
  assert.match(server, /app\.put\('\/api\/audiobook-private\/\*'[\s\S]*?progress\.setPrivate\(user\.email, book\.id, req\.body\?\.private\)/);
  assert.match(html, /audiobooks\.js\?v=23/);
});
