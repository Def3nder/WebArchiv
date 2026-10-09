const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('Die mobile Kachel-Navigation passt mit Pfeilen in eine Zeile', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

  assert.match(app, /page-btn page-btn-nav[^>]*aria-label="Vorherige Seite"/);
  assert.match(app, /aria-label="Vorherige Seite"[^>]*>‹<span class="page-btn-label"> Zurück<\/span><\/button>/);
  assert.match(app, /aria-label="Nächste Seite"[^>]*><span class="page-btn-label">Weiter <\/span>›<\/button>/);
  assert.match(app, /page-btn page-ellipsis/);
  assert.match(css, /body:not\(\.layout-list\) \.pagination\s*\{[^}]*gap:\s*2px;[^}]*flex-wrap:\s*nowrap;/s);
  assert.match(css, /body:not\(\.layout-list\) \.page-ellipsis\s*\{[^}]*min-width:\s*16px;/s);
  assert.doesNotMatch(css, /\.page-btn-label\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /\.page-btn-nav\s*\{[^}]*font-size:/s);
});
