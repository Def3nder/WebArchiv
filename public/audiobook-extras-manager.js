import { createMarkdownInput } from './markdown-live-preview.js';

/* WebArchiv — administrative Verwaltung der dateibasierten Hörbuch-Extras */

const $bem = document.getElementById('book-extras-manager');
const $bemBook = document.getElementById('book-extras-manager-book');
const $bemStatus = document.getElementById('book-extras-manager-status');
const $bemExtras = $bem.querySelector('[data-bem-extras]');
const $bemImages = $bem.querySelector('[data-bem-images]');
const $bemPreview = $bem.querySelector('[data-bem-preview-pane]');
const $bemPreviewTitle = $bem.querySelector('[data-bem-preview-title]');
const $bemPreviewBody = $bem.querySelector('[data-bem-preview-body]');
const $bemEditor = $bem.querySelector('[data-bem-editor]');
const $bemEditorHeading = $bem.querySelector('[data-bem-editor-heading]');
const $bemEditorTitleField = $bem.querySelector('[data-bem-editor-title-field]');
const $bemEditorTitle = $bem.querySelector('[data-bem-editor-title]');
const $bemEditorText = $bem.querySelector('[data-bem-editor-text]');
const $bemExtraFiles = $bem.querySelector('[data-bem-extra-files]');
const $bemImageFiles = $bem.querySelector('[data-bem-image-files]');
const $bemReplaceFile = $bem.querySelector('[data-bem-replace-file]');
const $bemLibrary = $bem.querySelector('.bem-library');
const $bemTabs = [...$bem.querySelectorAll('[data-bem-tab]')];
const $bemPanels = [...$bem.querySelectorAll('[data-bem-panel]')];
const $bemActions = [...$bem.querySelectorAll('[data-bem-actions]')];

const bemState = {
  book: null,
  data: { extras: [], images: [] },
  editing: null,
  originalTitle: '',
  originalText: '',
  replace: null,
  insertImages: false,
  changed: false,
  busy: false,
  dragFile: null,
  activeTab: 'extras',
  renaming: null,
  actionMenu: null,
  preview: null,
  previewToken: 0,
};

const bemMarkdownInput = createMarkdownInput({
  parent: $bemEditorText,
  onChange: () => {},
  resolveImageUrl: bemResolveImageUrl,
  onInsertImage: () => {
    bemState.replace = null;
    bemState.insertImages = true;
    $bemImageFiles.click();
  },
  labelledBy: 'bem-editor-text-label',
  describedBy: 'bem-editor-text-hint',
});

function bemPath(kind, query = {}) {
  const id = bemState.book.id.split('/').map(encodeURIComponent).join('/');
  const qs = new URLSearchParams(query);
  return `/api/audiobook-extra-${kind}/${id}${qs.size ? `?${qs}` : ''}`;
}

async function bemRequest(kind, { query, body, ...options } = {}) {
  const init = { cache: 'no-store', ...options };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...init.headers };
    init.body = JSON.stringify(body);
  }
  const response = await apiFetch(bemPath(kind, query), init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Die Extras konnten nicht geändert werden.');
  return result;
}

function bemSetStatus(message = '', kind = '') {
  $bemStatus.textContent = message;
  $bemStatus.dataset.kind = kind;
}

function bemDirty() {
  return !!bemState.editing
    && ($bemEditorTitle.value !== bemState.originalTitle || bemMarkdownInput.getValue() !== bemState.originalText);
}

function bemSetBusy(busy) {
  bemState.busy = busy;
  $bem.querySelectorAll('button, input').forEach(control => {
    if (!control.matches('[data-bem-close]')) control.disabled = busy;
  });
  bemMarkdownInput.setBusy(busy);
  bemMarkdownInput.setReadOnly(busy || !bemState.editing);
  if (!busy && bemState.editing && !bemState.editing.isNew) $bemEditorTitle.disabled = true;
}

function bemDocumentIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 2.5h8l4 4V21.5H6z"/><path d="M14 2.5v4h4M9 11h6M9 15h6"/></svg>';
}

function bemTrashIcon() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
}

function bemMoreIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
}

function bemEntry(entry, scope, index, total) {
  const isMarkdown = entry.type === 'markdown';
  const sortable = scope === 'extras';
  const preview = entry.url
    ? `<img src="${esc(entry.url)}" alt="" loading="lazy">`
    : bemDocumentIcon();
  return `<article class="bem-entry${sortable ? ' is-sortable' : ''}" data-bem-entry data-scope="${scope}" data-file="${esc(entry.file)}">
    ${sortable ? `<button type="button" class="bem-drag-handle" draggable="true" data-bem-drag aria-label="${esc(entry.title)} verschieben" title="Ziehen, um die Reihenfolge zu ändern">⠿</button>` : ''}
    <button type="button" class="bem-entry-preview" data-bem-preview aria-label="${esc(entry.title)} ansehen" title="Ansehen">${preview}</button>
    <div class="bem-entry-main">
      <div class="bem-entry-name">
        <span class="bem-entry-title">${esc(entry.title)}</span>
        <input type="text" value="${esc(entry.title)}" maxlength="140" aria-label="Anzeigenamen für ${esc(entry.file)}" data-bem-name>
      </div>
      <span class="bem-entry-file">${scope === 'images' ? 'images/' : ''}${esc(entry.file)}</span>
      <div class="bem-rename-actions">
        <button type="button" class="bem-mini" data-bem-rename-cancel>Abbrechen</button>
        <button type="button" class="bem-mini bem-inline-primary" data-bem-rename-save>Speichern</button>
      </div>
    </div>
    <button type="button" class="bem-entry-more" data-bem-more aria-expanded="false" aria-controls="bem-actions-${scope}-${index}" aria-label="Aktionen für ${esc(entry.title)}" title="Weitere Aktionen">${bemMoreIcon()}</button>
    <div class="bem-entry-actions" id="bem-actions-${scope}-${index}">
      ${sortable ? `<button type="button" class="bem-mini bem-move" data-bem-move="-1" aria-label="${esc(entry.title)} nach oben" aria-disabled="${index === 0}">↑</button>
      <button type="button" class="bem-mini bem-move" data-bem-move="1" aria-label="${esc(entry.title)} nach unten" aria-disabled="${index === total - 1}">↓</button>` : ''}
      ${isMarkdown ? '<button type="button" class="bem-mini" data-bem-edit>Text bearbeiten</button>' : ''}
      <button type="button" class="bem-mini" data-bem-rename>Umbenennen</button>
      <button type="button" class="bem-mini" data-bem-replace>Ersetzen</button>
      <button type="button" class="bem-mini is-danger bem-icon-btn" data-bem-delete aria-label="${esc(entry.title)} entfernen" title="Entfernen">${bemTrashIcon()}</button>
    </div>
  </article>`;
}

function bemRender() {
  const { extras, images } = bemState.data;
  $bem.querySelector('[data-bem-extra-count]').textContent = `${extras.length} ${extras.length === 1 ? 'Datei' : 'Dateien'}`;
  $bem.querySelector('[data-bem-image-count]').textContent = `${images.length} ${images.length === 1 ? 'Bild' : 'Bilder'}`;
  $bemExtras.innerHTML = extras.length
    ? extras.map((entry, index) => bemEntry(entry, 'extras', index, extras.length)).join('')
    : '<p class="bem-empty">Noch keine Extras. Der Ordner wird erst beim Speichern der ersten Datei angelegt.</p>';
  $bemImages.innerHTML = images.length
    ? images.map((entry, index) => bemEntry(entry, 'images', index, images.length)).join('')
    : '<p class="bem-empty">Noch keine eingebetteten Bilder.</p>';
  bemRestoreActionMenu();
}

function bemCloseActionMenus() {
  $bem.querySelectorAll('.bem-entry.is-actions-open').forEach(row => {
    row.classList.remove('is-actions-open');
    row.querySelector('[data-bem-more]')?.setAttribute('aria-expanded', 'false');
  });
  bemState.actionMenu = null;
}

function bemOpenActionMenu(scope, file, { focus = false } = {}) {
  bemCloseActionMenus();
  const row = [...$bem.querySelectorAll('[data-bem-entry]')]
    .find(item => item.dataset.scope === scope && item.dataset.file === file);
  if (!row) return;
  row.classList.add('is-actions-open');
  const more = row.querySelector('[data-bem-more]');
  more?.setAttribute('aria-expanded', 'true');
  bemState.actionMenu = { scope, file };
  if (focus && more?.offsetParent !== null) more.focus();
}

function bemRestoreActionMenu(options) {
  if (!bemState.actionMenu) return;
  bemOpenActionMenu(bemState.actionMenu.scope, bemState.actionMenu.file, options);
}

function bemPreviewPath(file) {
  const id = bemState.book.id.split('/').map(encodeURIComponent).join('/');
  return `/api/audiobook-extra/${id}?file=${encodeURIComponent(file)}`;
}

function bemResolveImageUrl(raw) {
  const value = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!value) return '';
  if (/^(?:https?:)?\/\//i.test(value) || value.startsWith('/')) {
    try {
      const url = new URL(value, location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  let relative = value.split(/[?#]/)[0].replace(/\\/g, '/');
  try { relative = decodeURIComponent(relative); } catch { /* unverändert */ }
  const parts = relative.split('/').filter(part => part && part !== '.');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'images' || parts.includes('..')) return '';
  const image = bemState.data.images.find(entry => entry.file.toLowerCase() === parts[1].toLowerCase());
  return image?.url || '';
}

function bemClosePreview({ focus = true } = {}) {
  if ($bemPreview.hidden) return false;
  const previous = bemState.preview;
  bemState.preview = null;
  bemState.previewToken++;
  $bemPreview.hidden = true;
  $bemPreviewBody.replaceChildren();
  if (focus && previous) {
    const row = [...$bem.querySelectorAll('[data-bem-entry]')]
      .find(item => item.dataset.scope === previous.scope && item.dataset.file === previous.file);
    row?.querySelector('[data-bem-preview]')?.focus({ preventScroll: true });
  }
  return true;
}

async function bemOpenPreview(entry, scope) {
  bemCloseActionMenus();
  const token = ++bemState.previewToken;
  bemState.preview = { scope, file: entry.file };
  $bemPreviewTitle.textContent = entry.title;
  $bemPreview.hidden = false;
  $bemPreview.querySelector('[data-bem-preview-close]').focus();
  if (entry.type === 'image') {
    $bemPreviewBody.innerHTML = `<div class="bem-image-preview"><img src="${esc(entry.url)}" alt="${esc(entry.title)}"></div>`;
    return;
  }
  $bemPreviewBody.innerHTML = '<p class="bem-preview-status">Text wird geladen …</p>';
  try {
    const response = await apiFetch(bemPreviewPath(entry.file), { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (token !== bemState.previewToken) return;
    if (!response.ok) throw new Error(data.error || 'Der Text konnte nicht geladen werden.');
    $bemPreviewBody.innerHTML = '<div class="bem-text-preview-scroll" tabindex="0"><article class="bem-text-preview detail-body"></article></div>';
    $bemPreviewBody.querySelector('.bem-text-preview').innerHTML = data.html;
    $bemPreviewBody.querySelector('.bem-text-preview-scroll').focus({ preventScroll: true });
  } catch (error) {
    if (token !== bemState.previewToken || error.code === 'session_expired') return;
    $bemPreviewBody.innerHTML = `<p class="bem-preview-status is-error">${esc(error.message)}</p>`;
  }
}

function bemSelectTab(name) {
  const renaming = $bem.querySelector('.bem-entry.is-renaming');
  if (renaming) bemCancelRename(renaming);
  bemState.activeTab = name;
  $bemTabs.forEach(tab => {
    const selected = tab.dataset.bemTab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $bemPanels.forEach(panel => panel.classList.toggle('is-active', panel.dataset.bemPanel === name));
  $bemActions.forEach(actions => actions.classList.toggle('is-active', actions.dataset.bemActions === name));
}

async function bemLoad() {
  const scrollTop = $bemLibrary.scrollTop;
  bemSetStatus('Extras werden geladen …');
  bemState.data = await bemRequest('manage');
  bemRender();
  bemSelectTab(bemState.activeTab);
  $bemLibrary.scrollTop = scrollTop;
  bemSetStatus('');
}

function bemCloseEditor(force = false) {
  if (!force && bemDirty() && !confirm('Ungespeicherte Änderungen verwerfen?')) return false;
  bemState.editing = null;
  bemState.originalTitle = '';
  bemState.originalText = '';
  bemMarkdownInput.setValue('', { readOnly: true });
  $bemEditor.hidden = true;
  return true;
}

function bemOpenNewText() {
  if (!bemCloseEditor()) return;
  bemState.editing = { isNew: true };
  bemState.originalTitle = '';
  bemState.originalText = '';
  $bemEditorHeading.textContent = 'Neues Text-Extra';
  $bemEditorTitleField.hidden = false;
  $bemEditorTitle.disabled = false;
  $bemEditorTitle.value = '';
  bemMarkdownInput.setValue('');
  $bemEditor.hidden = false;
  $bemEditorTitle.focus();
}

async function bemOpenMarkdown(entry) {
  if (!bemCloseEditor()) return;
  bemSetBusy(true);
  bemSetStatus(`„${entry.title}“ wird geladen …`);
  try {
    const source = await bemRequest('source', { query: { file: entry.file } });
    bemState.editing = { isNew: false, file: source.file, version: source.version };
    bemState.originalTitle = entry.title;
    bemState.originalText = source.markdown;
    $bemEditorHeading.textContent = entry.title;
    $bemEditorTitleField.hidden = true;
    $bemEditorTitle.value = entry.title;
    $bemEditorTitle.disabled = true;
    bemMarkdownInput.setValue(source.markdown);
    $bemEditor.hidden = false;
    bemMarkdownInput.focus();
    bemSetStatus('');
  } catch (error) {
    bemSetStatus(error.message, 'error');
  } finally { bemSetBusy(false); }
}

async function bemSaveEditor() {
  if (!bemState.editing || bemState.busy) return;
  const title = $bemEditorTitle.value.trim();
  const markdown = bemMarkdownInput.getValue() || (title ? `# ${title}\n` : '');
  if (bemState.editing.isNew && !title) {
    bemSetStatus('Bitte einen Namen für das Text-Extra eingeben.', 'error');
    $bemEditorTitle.focus();
    return;
  }
  bemSetBusy(true);
  bemSetStatus('Text-Extra wird gespeichert …');
  try {
    if (bemState.editing.isNew) {
      await bemRequest('create', { method: 'POST', body: { title, markdown } });
    } else {
      await bemRequest('source', {
        method: 'PUT', query: { file: bemState.editing.file },
        body: { markdown, version: bemState.editing.version },
      });
    }
    bemState.changed = true;
    bemCloseEditor(true);
    await bemLoad();
    bemSetStatus('Text-Extra gespeichert.', 'success');
  } catch (error) {
    bemSetStatus(error.message, 'error');
  } finally { bemSetBusy(false); }
}

async function bemUploadOne(file, scope, replace = '') {
  if (file.size > 20 * 1024 * 1024) throw new Error(`„${file.name}“ ist größer als 20 MB.`);
  const response = await apiFetch(bemPath('upload', { scope, name: file.name, ...(replace ? { replace } : {}) }), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `„${file.name}“ konnte nicht hochgeladen werden.`);
  return result.file;
}

async function bemUploadFiles(files, scope, { insert = false, replace = '' } = {}) {
  if (!files.length || bemState.busy) return;
  bemSetBusy(true);
  const uploaded = [];
  try {
    for (let index = 0; index < files.length; index++) {
      bemSetStatus(`${files[index].name} wird hochgeladen (${index + 1}/${files.length}) …`);
      uploaded.push(await bemUploadOne(files[index], scope, replace));
    }
    bemState.changed = true;
    await bemLoad();
    if (insert && uploaded.length && bemState.editing) {
      const markdown = uploaded
        .map(file => `![${file.replace(/\.[^.]+$/, '')}](images/${encodeURIComponent(file)})`)
        .join('\n');
      bemMarkdownInput.replaceSelection(markdown);
    }
    bemSetStatus(replace ? 'Datei ersetzt.' : `${uploaded.length} ${uploaded.length === 1 ? 'Datei' : 'Dateien'} hinzugefügt.`, 'success');
  } catch (error) {
    bemSetStatus(error.message, 'error');
  } finally {
    bemState.replace = null;
    bemState.insertImages = false;
    bemSetBusy(false);
  }
}

function bemCancelRename(row, restoreFocus = false) {
  if (!row) return;
  const input = row.querySelector('[data-bem-name]');
  input.value = input.dataset.originalValue || input.value;
  delete input.dataset.originalValue;
  row.classList.remove('is-renaming');
  bemState.renaming = null;
  bemOpenActionMenu(row.dataset.scope, row.dataset.file, { focus: restoreFocus });
}

function bemStartRename(row) {
  if (bemState.busy) return;
  const current = $bem.querySelector('.bem-entry.is-renaming');
  if (current && current !== row) bemCancelRename(current);
  const input = row.querySelector('[data-bem-name]');
  input.dataset.originalValue = input.value;
  bemState.actionMenu = { scope: row.dataset.scope, file: row.dataset.file };
  row.classList.remove('is-actions-open');
  row.querySelector('[data-bem-more]')?.setAttribute('aria-expanded', 'false');
  row.classList.add('is-renaming');
  bemState.renaming = `${row.dataset.scope}/${row.dataset.file}`;
  input.focus();
  input.select();
}

async function bemRename(row) {
  const input = row.querySelector('[data-bem-name]');
  const title = input.value.trim();
  if (!title || bemState.busy) {
    if (!title) {
      bemSetStatus('Bitte einen Namen eingeben.', 'error');
      input.focus();
    }
    return;
  }
  bemSetBusy(true);
  bemSetStatus('Datei wird umbenannt …');
  try {
    const result = await bemRequest('entry', {
      method: 'PATCH',
      body: { scope: row.dataset.scope, file: row.dataset.file, title },
    });
    bemState.changed = true;
    bemState.renaming = null;
    bemState.actionMenu = { scope: row.dataset.scope, file: result.file };
    if (bemState.editing?.file === row.dataset.file) bemCloseEditor(true);
    await bemLoad();
    bemRestoreActionMenu({ focus: true });
    bemSetStatus('Name geändert.', 'success');
  } catch (error) {
    bemSetStatus(error.message, 'error');
  } finally { bemSetBusy(false); }
}

async function bemDelete(row) {
  if (bemState.busy || !confirm(`„${row.dataset.file}“ wirklich entfernen?`)) return;
  bemSetBusy(true);
  bemSetStatus('Datei wird entfernt …');
  try {
    await bemRequest('entry', {
      method: 'DELETE',
      body: { scope: row.dataset.scope, file: row.dataset.file },
    });
    bemState.changed = true;
    if (bemState.editing?.file === row.dataset.file) bemCloseEditor(true);
    await bemLoad();
    bemSetStatus('Datei entfernt.', 'success');
  } catch (error) {
    bemSetStatus(error.message, 'error');
  } finally { bemSetBusy(false); }
}

async function bemPersistOrder(files) {
  if (bemState.busy || files.length < 2
      || files.every((file, index) => file === bemState.data.extras[index]?.file)) return;
  bemSetBusy(true);
  bemSetStatus('Reihenfolge wird gespeichert …');
  try {
    const result = await bemRequest('order', { method: 'POST', body: { files } });
    const edited = result.files?.find(item => item.from === bemState.editing?.file);
    if (edited) bemState.editing.file = edited.to;
    const menuEntry = result.files?.find(item => item.from === bemState.actionMenu?.file);
    if (menuEntry) bemState.actionMenu.file = menuEntry.to;
    bemState.changed = true;
    await bemLoad();
    bemSetStatus('Reihenfolge gespeichert.', 'success');
  } catch (error) {
    bemRender();
    bemSetStatus(error.message, 'error');
  } finally { bemSetBusy(false); }
}

function bemMove(row, offset) {
  if (bemState.busy || row.dataset.scope !== 'extras') return;
  const files = bemState.data.extras.map(entry => entry.file);
  const index = files.indexOf(row.dataset.file);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= files.length) return;
  [files[index], files[target]] = [files[target], files[index]];
  bemPersistOrder(files);
}

function bemClearDrag() {
  bemState.dragFile = null;
  $bemExtras.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after').forEach(row => {
    row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
  });
}

async function openBookExtrasManager(book) {
  if (currentUser?.role !== 'admin' || $bem.open) return;
  Object.assign(bemState, {
    book, data: { extras: [], images: [] }, editing: null, replace: null,
    insertImages: false, changed: false, busy: false, dragFile: null,
    activeTab: 'extras', renaming: null, actionMenu: null, preview: null,
  });
  $bemBook.textContent = book.title;
  $bemLibrary.scrollTop = 0;
  bemSelectTab('extras');
  bemClosePreview({ focus: false });
  bemCloseEditor(true);
  bemRender();
  // Ebenen-Stapel: Escape schließt stufenweise (Vorschau, Umbenennen, Editor, Dialog).
  WebArchivLayers.open($bem, { name: 'extras-manager', onEscape: bemTryClose });
  try { await bemLoad(); }
  catch (error) { bemSetStatus(error.message, 'error'); }
}

// audiobooks.js läuft weiterhin als klassisches Skript und öffnet den Manager
// über diesen globalen Einstiegspunkt. Das Editor-Bundle kapselt Module sonst ab.
window.openBookExtrasManager = openBookExtrasManager;

function bemTryClose() {
  if (bemState.busy) return;
  if (bemClosePreview()) return;
  const renaming = $bem.querySelector('.bem-entry.is-renaming');
  if (renaming) {
    bemCancelRename(renaming, true);
    return;
  }
  if (!$bemEditor.hidden) {
    bemCloseEditor();
    return;
  }
  $bem.close();
}

$bem.querySelector('[data-bem-close]').addEventListener('click', bemTryClose);
// Escape und cancel (auch das bubbelnde cancel abgebrochener Dateifelder unter iOS)
// regelt der Ebenen-Stapel: nur der Dialog selbst schließt, die Ebene darunter nicht.
// Wie bei den übrigen modalen Dialogen schließt ein Klick neben die sichtbare
// Dialogfläche. Klicks auf Inhalt oder freie Fläche innerhalb des Dialogs bleiben erhalten.
$bem.addEventListener('click', event => {
  if (event.target !== $bem) return;
  const rect = $bem.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) bemTryClose();
});
$bem.querySelector('[data-bem-new-text]').addEventListener('click', bemOpenNewText);
$bem.querySelector('[data-bem-preview-close]').addEventListener('click', () => bemClosePreview());
$bem.querySelector('[data-bem-add-extra]').addEventListener('click', () => {
  bemState.replace = null;
  $bemExtraFiles.click();
});
$bem.querySelector('[data-bem-add-image]').addEventListener('click', () => {
  bemState.replace = null;
  bemState.insertImages = false;
  $bemImageFiles.click();
});
$bem.querySelector('[data-bem-editor-save]').addEventListener('click', bemSaveEditor);
$bem.querySelector('[data-bem-editor-cancel]').addEventListener('click', () => bemCloseEditor());
$bemTabs.forEach(tab => tab.addEventListener('click', () => bemSelectTab(tab.dataset.bemTab)));
$bemExtraFiles.addEventListener('change', () => {
  const files = [...$bemExtraFiles.files];
  $bemExtraFiles.value = '';
  bemUploadFiles(files, 'extras');
});
$bemImageFiles.addEventListener('change', () => {
  const files = [...$bemImageFiles.files];
  $bemImageFiles.value = '';
  bemUploadFiles(files, 'images', { insert: bemState.insertImages });
});
$bemReplaceFile.addEventListener('change', () => {
  const file = $bemReplaceFile.files[0];
  $bemReplaceFile.value = '';
  if (file && bemState.replace) bemUploadFiles([file], bemState.replace.scope, { replace: bemState.replace.file });
});
$bemExtras.addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-bem-drag]');
  const row = handle?.closest('[data-bem-entry]');
  if (!row || bemState.busy) { event.preventDefault(); return; }
  bemState.dragFile = row.dataset.file;
  row.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.file);
});
$bemExtras.addEventListener('dragover', event => {
  const row = event.target.closest('[data-bem-entry]');
  if (!bemState.dragFile || !row || row.dataset.file === bemState.dragFile) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  $bemExtras.querySelectorAll('.is-drop-before, .is-drop-after').forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
  const rect = row.getBoundingClientRect();
  row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
});
$bemExtras.addEventListener('drop', event => {
  const row = event.target.closest('[data-bem-entry]');
  const dragged = bemState.dragFile;
  if (!dragged || !row || row.dataset.file === dragged) { bemClearDrag(); return; }
  event.preventDefault();
  const after = row.classList.contains('is-drop-after');
  const files = bemState.data.extras.map(entry => entry.file).filter(file => file !== dragged);
  const target = files.indexOf(row.dataset.file);
  files.splice(target + (after ? 1 : 0), 0, dragged);
  bemClearDrag();
  bemPersistOrder(files);
});
$bemExtras.addEventListener('dragend', bemClearDrag);
$bem.addEventListener('click', event => {
  const row = event.target.closest('[data-bem-entry]');
  if (!row) return;
  const more = event.target.closest('[data-bem-more]');
  if (more) {
    const open = !row.classList.contains('is-actions-open');
    if (open) bemOpenActionMenu(row.dataset.scope, row.dataset.file);
    else bemCloseActionMenus();
    return;
  }
  const entry = (row.dataset.scope === 'images' ? bemState.data.images : bemState.data.extras)
    .find(item => item.file === row.dataset.file);
  if (!entry) return;
  if (event.target.closest('[data-bem-preview]')) {
    bemOpenPreview(entry, row.dataset.scope);
    return;
  }
  if (event.target.closest('[data-bem-rename-cancel]')) {
    bemCancelRename(row, true);
    return;
  }
  if (event.target.closest('[data-bem-rename-save]')) {
    bemRename(row);
    return;
  }
  const move = event.target.closest('[data-bem-move]');
  if (move) {
    bemState.actionMenu = { scope: row.dataset.scope, file: row.dataset.file };
    bemMove(row, Number(move.dataset.bemMove));
  } else if (event.target.closest('[data-bem-edit]')) {
    bemCloseActionMenus();
    bemOpenMarkdown(entry);
  }
  else if (event.target.closest('[data-bem-rename]')) bemStartRename(row);
  else if (event.target.closest('[data-bem-delete]')) {
    bemCloseActionMenus();
    bemDelete(row);
  }
  else if (event.target.closest('[data-bem-replace]')) {
    bemCloseActionMenus();
    bemState.replace = { scope: row.dataset.scope, file: row.dataset.file };
    $bemReplaceFile.accept = entry.type === 'markdown'
      ? '.md,text/markdown'
      : '.png,.jpg,.jpeg,.gif,image/png,image/jpeg,image/gif';
    $bemReplaceFile.click();
  }
});
$bem.addEventListener('keydown', event => {
  const input = event.target.closest('.bem-entry.is-renaming [data-bem-name]');
  if (!input) return;
  const row = input.closest('[data-bem-entry]');
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    bemRename(row);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    bemCancelRename(row, true);
  }
});
$bem.addEventListener('close', async () => {
  if (!bemState.changed || !bemState.book) return;
  try {
    const updated = await fetchArticle(bemState.book.id);
    currentBookDetail = updated;
    if ($overlay.open) renderBookDetail(updated);
  } catch { /* Detail wird beim nächsten Öffnen aktualisiert */ }
});
