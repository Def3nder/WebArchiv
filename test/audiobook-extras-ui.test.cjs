const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const books = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');
const manager = fs.readFileSync(path.join(ROOT, 'public', 'audiobook-extras-manager.js'), 'utf8');
const editorEntry = fs.readFileSync(path.join(ROOT, 'public', 'markdown-editors.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'audiobooks.cjs'), 'utf8');

test('Admin-Aktionen öffnen die Extras-Verwaltung auch ohne vorhandene Extras', () => {
  assert.match(books, /currentUser\?\.role === 'admin'[\s\S]*data-book-extras-manage>Extras verwalten/);
  assert.match(books, /data-book-extras-manage[^\n]*openBookExtrasManager\(book\)/);
  assert.match(manager, /window\.openBookExtrasManager = openBookExtrasManager/);
  assert.match(html, /id="book-extras-manager"[\s\S]*class="bem-tabs"[\s\S]*data-bem-actions="extras"[\s\S]*data-bem-new-text>Neuer Text<\/button>[\s\S]*data-bem-add-extra>Dateien\/Bilder<\/button>[\s\S]*data-bem-actions="images"[\s\S]*data-bem-add-image>Bilder hinzufügen<\/button>/);
  assert.match(manager, /data-bem-add-image[\s\S]*bemState\.insertImages = false[\s\S]*\$bemImageFiles\.click\(\)/);
});

test('Admin kann aus der Extras-Anzeige direkt in die Verwaltung wechseln', () => {
  assert.match(books, /currentUser\?\.role === 'admin'[\s\S]*data-extras-manage[\s\S]*>Verwalten<\/span>/);
  assert.match(books, /data-extras-manage[^\n]*addEventListener\('click',[\s\S]*?closeBookExtras\(false\)[\s\S]*?openBookExtrasManager\(book\)/);
  assert.match(books, /function closeBookExtras\(restoreFocus = true\)[\s\S]*?restoreFocus !== false/);
  assert.match(html, /audiobooks\.js\?v=22/);
});

test('Sichtbare Extras werden erst beim Öffnen vom Server geladen', () => {
  assert.match(books, /book\.hasExtras[\s\S]*data-book-extras/);
  assert.match(books, /function bookExtrasApiPath[\s\S]*\/api\/audiobook-extras\//);
  assert.match(books, /async function fetchBookExtras[\s\S]*apiFetch\(bookExtrasApiPath\(book\)/);
  assert.match(books, /async function openBookExtras[\s\S]*await fetchBookExtras\(book\)/);
  assert.doesNotMatch(books, /book\.extras/);
  assert.match(app, /await fetchBookExtras\(currentBookDetail\)[\s\S]*await openBookExtras\(currentBookDetail, extras\)/);
  assert.match(server, /app\.get\('\/api\/audiobook-extras\/\*'[\s\S]*return library\.extras\(book\)/);
});

test('Manager trennt sichtbare Extras und eingebettete Bilder ohne Manifest', () => {
  assert.match(manager, /bemUploadFiles\(files, 'extras'\)/);
  assert.match(manager, /bemUploadFiles\(files, 'images'/);
  assert.match(manager, /\]\(images\/\$\{encodeURIComponent\(file\)\}\)/);
  assert.doesNotMatch(manager + server, /manifest\.json/i);
});

test('Eingefügte Textbilder verwenden URL-sichere Dateinamen', () => {
  assert.match(manager, /images\/\$\{encodeURIComponent\(file\)\}/);
  assert.match(server, /try \{ rel = decodeURIComponent\(src\); \}/);
  assert.match(server, /images\/\$\{encodeURIComponent\(oldFile\)\}/);
});

test('Abbruch einer Dateiauswahl schließt den Extras-Dialog nicht', () => {
  assert.match(manager, /addEventListener\('cancel',[\s\S]*?event\.target !== \$bem[\s\S]*?event\.preventDefault\(\)[\s\S]*?bemTryClose\(\)/);
});

test('Klick neben die Extras-Verwaltung schließt wie bei den übrigen Dialogen', () => {
  assert.match(manager, /\$bem\.addEventListener\('click', event => \{[\s\S]*?event\.target !== \$bem[\s\S]*?\$bem\.getBoundingClientRect\(\)[\s\S]*?if \(!inside\) bemTryClose\(\)/);
});

test('Sichtbare Extras lassen sich per Drag-and-drop und Tastatur-Schaltern sortieren', () => {
  assert.match(manager, /draggable="true" data-bem-drag/);
  assert.match(manager, /addEventListener\('dragstart'/);
  assert.match(manager, /addEventListener\('drop'/);
  assert.match(manager, /data-bem-move="-1"/);
  assert.match(manager, /bemRequest\('order', \{ method: 'POST'/);
  assert.match(server, /app\.post\('\/api\/audiobook-extra-order\/\*'/);
  assert.match(editorEntry, /import '\.\/audiobook-extras-manager\.js'/);
  assert.match(html, /vendor\/article-editor\.bundle\.js\?v=16/);
});

test('Markdown-Editor nutzt die gemeinsame Live-Vorschau im gesamten Extras-Dialog', () => {
  assert.match(styles, /\.bem-content:has\(\.bem-editor:not\(\[hidden\]\)\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /\.bem-content:has\(\.bem-editor:not\(\[hidden\]\)\) \.bem-library \{ display: none; \}/);
  assert.match(html, /class="markdown-live-editor" data-bem-editor-text/);
  assert.doesNotMatch(html, /<textarea data-bem-editor-text/);
  assert.match(manager, /createMarkdownInput\(\{[\s\S]*?resolveImageUrl: bemResolveImageUrl/);
  assert.match(manager, /bemMarkdownInput\.setValue\(source\.markdown\)/);
  assert.match(manager, /bemMarkdownInput\.getValue\(\)/);
  assert.match(manager, /bemMarkdownInput\.replaceSelection\(markdown\)/);
  assert.match(manager, /onInsertImage: \(\) => \{[\s\S]*?bemState\.insertImages = true;[\s\S]*?\$bemImageFiles\.click\(\)/);
  assert.doesNotMatch(html, /data-bem-insert-image/);
  assert.match(manager, /function bemResolveImageUrl\(raw\)[\s\S]*?bemState\.data\.images\.find/);
  assert.match(styles, /\.bem-markdown-field \{ grid-template-rows: auto minmax\(0, 1fr\) auto; flex: 1 1 auto; min-height: 0; \}/);
  assert.match(styles, /\.bem-markdown-field \.markdown-live-editor \{[^}]*min-height: 0; height: 100%;/);
  assert.match(styles, /#book-extras-manager:has\(\.bem-editor:not\(\[hidden\]\)\) \.bem-toolbar, #book-extras-manager:has\(\.bem-editor:not\(\[hidden\]\)\) \.bem-tabs \{ display: none; \}/);
  assert.match(styles, /\.bem-status:empty \{ display: none; \}/);
  assert.match(html, /styles\.css\?v=125/);
});

test('Datei-Icons öffnen Markdown-, Extra-Bild- und Textbild-Vorschauen im Verwaltungsdialog', () => {
  assert.match(html, /class="bem-preview-pane" data-bem-preview-pane hidden[\s\S]*data-bem-preview-close>← Zurück<\/button>[\s\S]*data-bem-preview-body/);
  assert.match(manager, /class="bem-entry-preview" data-bem-preview aria-label="\$\{esc\(entry\.title\)\} ansehen"/);
  assert.match(manager, /function bemOpenPreview\(entry, scope\)[\s\S]*?entry\.type === 'image'[\s\S]*?bem-image-preview[\s\S]*?apiFetch\(bemPreviewPath\(entry\.file\)/);
  assert.match(manager, /event\.target\.closest\('\[data-bem-preview\]'\)[\s\S]*?bemOpenPreview\(entry, row\.dataset\.scope\)/);
  assert.match(styles, /\.bem-image-preview img \{[^}]*object-fit: contain/);
  assert.match(styles, /\.bem-text-preview-scroll \{[^}]*overflow-y: auto/);
});

test('Bestehende Markdown-Extras zeigen den Namen im Editor nicht doppelt', () => {
  assert.match(html, /data-bem-editor-title-field/);
  assert.match(manager, /bemOpenNewText[\s\S]*?\$bemEditorTitleField\.hidden = false/);
  assert.match(manager, /bemOpenMarkdown[\s\S]*?\$bemEditorHeading\.textContent = entry\.title[\s\S]*?\$bemEditorTitleField\.hidden = true/);
  assert.match(styles, /\[data-bem-editor-title-field\]\[hidden\] \{ display: none !important; \}/);
  assert.match(editorEntry, /import '\.\/audiobook-extras-manager\.js'/);
});

test('Entfernen verwendet dasselbe Mülleimer-Symbol wie die Benutzerverwaltung', () => {
  assert.match(manager, /class="bem-mini is-danger bem-icon-btn" data-bem-delete[^>]*aria-label="\$\{esc\(entry\.title\)\} entfernen"[^>]*>\$\{bemTrashIcon\(\)\}<\/button>/);
  assert.match(manager, /M3 6h18[\s\S]*M19 6l-1 14[\s\S]*M10 11v6M14 11v6/);
  assert.doesNotMatch(manager, /data-bem-delete>Entfernen<\/button>/);
});

test('Extras-Verwaltung ist auf Touch-Geräten als kompakte Vollbildansicht bedienbar', () => {
  assert.match(html, /data-bem-tab="extras"><span>Extras<\/span>[\s\S]*data-bem-tab="images"><span>Textbilder<\/span>/);
  assert.match(manager, /function bemSelectTab\(name\)[\s\S]*?aria-selected[\s\S]*?\$bemActions[\s\S]*?is-active/);
  assert.match(manager, /data-bem-more aria-expanded="false"/);
  assert.match(manager, /function bemMoreIcon\(\)[\s\S]*?<circle cx="5" cy="12"[\s\S]*?<circle cx="19" cy="12"/);
  assert.match(manager, /class="bem-entry-more"[\s\S]*?title="Weitere Aktionen">\$\{bemMoreIcon\(\)\}/);
  assert.doesNotMatch(manager, /prompt\('Neuer Name'/);
  assert.match(manager, /function bemStartRename\(row\)[\s\S]*?classList\.add\('is-renaming'\)[\s\S]*?input\.focus\(\)[\s\S]*?input\.select\(\)/);
  assert.match(styles, /#book-extras-manager \{[\s\S]*?width: 100vw;[\s\S]*?height: 100dvh;[\s\S]*?safe-area-inset-bottom/);
  assert.match(styles, /\.bem-entry\.is-actions-open \.bem-entry-actions \{ display: flex; \}/);
  assert.match(styles, /\.bem-entry-more \{[\s\S]*?border: 0;[\s\S]*?border-radius: 5px;[\s\S]*?color: var\(--text-muted\)/);
  assert.match(styles, /\.bem-toolbar \{ display: flex; flex-wrap: wrap;/);
  assert.doesNotMatch(styles, /\.bem-toolbar \.detail-cat-pill:first-child/);
  assert.match(styles, /\.bem-field input \{ font-size: 16px; \}/);
  assert.match(styles, /\.bem-markdown-field \.cm-content \{ padding: 14px 12px 24px; \}/);
});

test('Umbenennen bleibt mit Speichern, Abbrechen, Enter und Escape vollständig im Dialog', () => {
  assert.match(manager, /data-bem-rename-cancel>Abbrechen<\/button>[\s\S]*data-bem-rename-save>Speichern<\/button>/);
  assert.match(manager, /data-bem-rename[^\n]*bemStartRename\(row\)/);
  assert.match(manager, /event\.key === 'Enter'[\s\S]*?bemRename\(row\)[\s\S]*?event\.key === 'Escape'[\s\S]*?bemCancelRename\(row, true\)/);
  assert.match(styles, /\.bem-entry\.is-renaming \.bem-entry-name input \{ display: block; \}/);
});

test('Drei-Punkte-Menü bleibt nach Verschieben und Umbenennen an derselben Datei geöffnet', () => {
  assert.match(manager, /actionMenu: null/);
  assert.match(manager, /function bemOpenActionMenu\(scope, file,[\s\S]*?classList\.add\('is-actions-open'\)[\s\S]*?aria-expanded', 'true'/);
  assert.match(manager, /function bemCancelRename\(row,[\s\S]*?bemOpenActionMenu\(row\.dataset\.scope, row\.dataset\.file/);
  assert.match(manager, /const result = await bemRequest\('entry'[\s\S]*?actionMenu = \{ scope: row\.dataset\.scope, file: result\.file \}[\s\S]*?bemRestoreActionMenu\(\{ focus: true \}\)/);
  assert.match(manager, /const menuEntry = result\.files\?\.find\(item => item\.from === bemState\.actionMenu\?\.file\)[\s\S]*?bemState\.actionMenu\.file = menuEntry\.to/);
  assert.match(manager, /if \(move\) \{[\s\S]*?bemState\.actionMenu = \{ scope: row\.dataset\.scope, file: row\.dataset\.file \}[\s\S]*?bemMove\(row/);
});

test('Reiter, Bereich und Scrollposition bleiben nach Änderungen erhalten', () => {
  assert.match(manager, /activeTab: 'extras'/);
  assert.match(manager, /bemState\.activeTab = name/);
  assert.match(manager, /const scrollTop = \$bemLibrary\.scrollTop[\s\S]*?bemSelectTab\(bemState\.activeTab\)[\s\S]*?\$bemLibrary\.scrollTop = scrollTop/);
});

test('Escape und Herunterziehen schließen zuerst nur den Markdown-Editor', () => {
  assert.match(manager, /\$bem\.addEventListener\('cancel',[\s\S]*?event\.preventDefault\(\)[\s\S]*?bemTryClose\(\)/);
  assert.match(manager, /document\.addEventListener\('keydown', event => \{[\s\S]*?!\$bem\.open \|\| event\.key !== 'Escape'[\s\S]*?event\.stopImmediatePropagation\(\);[\s\S]*?\}, true\)/);
  assert.match(manager, /function bemTryClose\(\) \{[\s\S]*?if \(!\$bemEditor\.hidden\) \{[\s\S]*?bemCloseEditor\(\);[\s\S]*?return;[\s\S]*?\$bem\.close\(\)/);
  assert.match(app, /\['#book-extras-manager', '#book-extras-manager \[data-bem-close\]'\]/);
  assert.match(app, /onClose: \(\) => closeBtn\.click\(\)/);
  assert.match(html, /app\.js\?v=108/);
});

test('Escape und Herunterziehen schließen zuerst nur die Dateivorschau', () => {
  assert.match(manager, /function bemTryClose\(\) \{[\s\S]*?if \(bemClosePreview\(\)\) return;[\s\S]*?\$bem\.close\(\)/);
  assert.match(manager, /function bemClosePreview\([\s\S]*?\$bemPreview\.hidden = true[\s\S]*?data-bem-preview[^\n]*focus/);
});

test('Schreibende Extras-Routen sind admin- und same-site-geschützt', () => {
  assert.match(server, /admin && req\.session\.user\?\.role !== 'admin'/);
  assert.match(server, /req\.get\('sec-fetch-site'\) === 'cross-site'/);
  for (const method of ['put', 'post', 'patch', 'delete']) {
    assert.match(server, new RegExp(`app\\.${method}\\([\\s\\S]*?\\/api\\/audiobook-extra-`));
  }
});
