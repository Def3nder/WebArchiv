/* Artikel-Infografiken: dieselbe dateinahe Bedienung wie bei Hörbuch-Extras. */

const $igm = document.getElementById('infographic-manager');
const $igmList = $igm.querySelector('[data-igm-list]');
const $igmLibrary = $igm.querySelector('[data-igm-library]');
const $igmPreview = $igm.querySelector('[data-igm-preview]');
const $igmFile = $igm.querySelector('[data-igm-file]');
const $igmStatus = document.getElementById('infographic-manager-status');
const igmState = {
  article: null, items: [], busy: false, dragId: null, previewId: null, actionIndex: -1, returnFocus: null,
};

function igmPath() {
  return '/api/infographic-manager/' + igmState.article.id.split('/').map(encodeURIComponent).join('/');
}

async function igmRequest(body) {
  const response = await apiFetch(igmPath(), body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Infografiken konnten nicht verwaltet werden.');
  return result;
}

function igmStatus(message = '', kind = '') {
  $igmStatus.textContent = message;
  $igmStatus.dataset.kind = kind;
}

function igmBusy(value) {
  igmState.busy = value;
  $igm.querySelectorAll('button, input').forEach(control => {
    const move = control.dataset.igmMove;
    const row = control.closest('[data-igm-entry]');
    const movable = igmState.items.filter(item => !item.fixed);
    const index = row ? movable.findIndex(item => item.id === row.dataset.id) : -1;
    control.disabled = value || (move !== undefined && (index < 0
      || index + Number(move) < 0 || index + Number(move) >= movable.length));
  });
  $igm.setAttribute('aria-busy', String(value));
}

function igmMoreIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
}

function igmTrashIcon() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
}

function igmEntry(item, index, total) {
  const movable = igmState.items.filter(candidate => !candidate.fixed);
  const movableIndex = movable.findIndex(candidate => candidate.id === item.id);
  const label = item.fixed ? 'Artikelgrafik' : 'Grafik ' + (movableIndex + 1);
  return '<article class="bem-entry igm-entry' + (item.fixed ? ' is-fixed' : ' is-sortable') + '" data-igm-entry data-id="' + esc(item.id) + '">'
    + (item.fixed ? '' : '<button type="button" class="bem-drag-handle" draggable="true" data-igm-drag aria-label="' + label + ' verschieben" title="Ziehen, um die Reihenfolge zu ändern">⠿</button>')
    + '<button type="button" class="bem-entry-preview" data-igm-view aria-label="' + label + ' ansehen" title="Ansehen"><img src="' + esc(item.imageUrl) + '" alt="" loading="lazy"></button>'
    + '<div class="bem-entry-main"><span class="bem-entry-title">' + label + '</span><span class="bem-entry-file">' + esc(item.filename) + '</span>'
    + '<label class="igm-instagram-toggle"><input type="checkbox" data-igm-instagram'
    + (item.instagramPoster ? ' checked' : '') + '><span>Instagram-Poster</span></label></div>'
    + (item.fixed ? '' : '<button type="button" class="bem-entry-more" data-igm-more aria-expanded="false" aria-label="Aktionen für ' + label + '" title="Weitere Aktionen">' + igmMoreIcon() + '</button>'
    + '<div class="bem-entry-actions">'
    + '<button type="button" class="bem-mini bem-move" data-igm-move="-1" aria-label="' + label + ' nach oben"' + (movableIndex === 0 ? ' disabled' : '') + '>↑</button>'
    + '<button type="button" class="bem-mini bem-move" data-igm-move="1" aria-label="' + label + ' nach unten"' + (movableIndex === movable.length - 1 ? ' disabled' : '') + '>↓</button>'
    + '<button type="button" class="bem-mini is-danger bem-icon-btn" data-igm-trash aria-label="' + label + ' in den Papierkorb verschieben" title="In den Papierkorb">' + igmTrashIcon() + '</button>'
    + '</div>') + '</article>';
}

function igmRender() {
  const count = igmState.items.length;
  $igm.querySelector('[data-igm-count]').textContent = count + (count === 1 ? ' Infografik' : ' Infografiken');
  $igmList.innerHTML = count
    ? igmState.items.map((item, index) => igmEntry(item, index, count)).join('')
    : '<p class="bem-empty">Für diesen Artikel sind noch keine Infografiken vorhanden.</p>';
  const active = $igmList.querySelectorAll('[data-igm-entry]')[igmState.actionIndex];
  active?.classList.add('is-actions-open');
  active?.querySelector('[data-igm-more]')?.setAttribute('aria-expanded', 'true');
}

async function igmLoad() {
  const data = await igmRequest();
  igmState.items = data.items || [];
  document.getElementById('infographic-manager-article').textContent = data.title || igmState.article.title;
  igmRender();
}

async function igmRefreshArticle() {
  const articleId = igmState.article.id;
  const detailPosition = captureDetailPosition();
  await loadArticles();
  if (!$overlay.hidden && currentViewItemId === articleId) {
    await openArticle(articleId, { historyMode: 'none', detailPosition });
  }
}

async function igmSave(body, workingText, successText) {
  if (igmState.busy) return;
  igmBusy(true);
  igmStatus(workingText);
  let saved = false;
  try {
    await igmRequest(body);
    saved = true;
    await igmLoad();
    try {
      await igmRefreshArticle();
      igmStatus(successText, 'success');
    } catch {
      igmStatus('Gespeichert. Die Artikelansicht konnte nicht aktualisiert werden; bitte die Seite neu laden.', 'error');
    }
  } catch (error) {
    igmState.actionIndex = -1;
    igmRender();
    igmStatus(saved
      ? 'Gespeichert. Die Liste konnte nicht aktualisiert werden; bitte die Seite neu laden.'
      : (error.message || 'Die Änderung ist fehlgeschlagen.'), 'error');
  } finally { igmBusy(false); }
}

function igmOrder(ids, actionIndex = -1) {
  const movable = igmState.items.filter(item => !item.fixed);
  if (ids.length < 2 || ids.every((id, index) => id === movable[index]?.id)) return;
  igmState.actionIndex = actionIndex;
  void igmSave({ action: 'order', ids }, 'Reihenfolge wird gespeichert …', 'Reihenfolge gespeichert.');
}

function igmMove(id, offset) {
  const ids = igmState.items.filter(item => !item.fixed).map(item => item.id);
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  igmOrder(ids, target);
}

function igmClosePreview() {
  igmState.previewId = null;
  $igmPreview.hidden = true;
  $igmLibrary.hidden = false;
  $igm.querySelector('[data-igm-preview-body]').replaceChildren();
}

function igmOpenPreview(item) {
  igmState.previewId = item.id;
  $igm.querySelector('[data-igm-preview-title]').textContent = item.title || 'Infografik';
  const image = document.createElement('img');
  image.src = item.imageUrl;
  image.alt = item.title || 'Infografik';
  $igm.querySelector('[data-igm-preview-body]').replaceChildren(image);
  $igmLibrary.hidden = true;
  $igmPreview.hidden = false;
  $igm.querySelector('[data-igm-preview-close]').focus();
}

function igmClose() {
  if (igmState.busy) return;
  igmClosePreview();
  $igm.close();
}

function igmEscape() {
  if (igmState.busy) return;
  if (!$igmPreview.hidden) igmClosePreview();
  else igmClose();
}

async function openInfographicManager(article) {
  if (currentUser?.role !== 'admin' || !article?.canUploadInfographic || $igm.open) return;
  igmState.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  igmState.article = article;
  igmState.items = [];
  igmState.dragId = null;
  igmState.actionIndex = -1;
  igmClosePreview();
  igmRender();
  igmStatus();
  $igm.showModal();
  try { await igmLoad(); }
  catch (error) { igmStatus(error.message, 'error'); }
}
window.openInfographicManager = openInfographicManager;

$igm.querySelector('[data-igm-close]').addEventListener('click', igmClose);
$igm.querySelector('[data-igm-preview-close]').addEventListener('click', igmClosePreview);
$igm.querySelector('[data-igm-add]').addEventListener('click', () => {
  if (igmState.busy) return;
  $igmFile.value = '';
  $igmFile.click();
});
$igmFile.addEventListener('change', async () => {
  const file = $igmFile.files?.[0];
  $igmFile.value = '';
  if (!file || igmState.busy) return;
  igmState.actionIndex = -1;
  igmBusy(true);
  igmStatus('Grafik wird hochgeladen …');
  let saved = false;
  try {
    await uploadInfographic(igmState.article, file);
    saved = true;
    await igmLoad();
    try {
      await igmRefreshArticle();
      igmStatus('Grafik hinzugefügt.', 'success');
    } catch {
      igmStatus('Grafik gespeichert. Die Artikelansicht konnte nicht aktualisiert werden; bitte die Seite neu laden.', 'error');
    }
  } catch (error) {
    igmStatus(saved
      ? 'Grafik gespeichert. Die Liste konnte nicht aktualisiert werden; bitte die Seite neu laden.'
      : (error.message || 'Upload fehlgeschlagen.'), 'error');
  } finally { igmBusy(false); }
});
$igm.addEventListener('cancel', event => {
  // Auch das Abbrechen des System-Dateidialogs kann ein bubbling cancel senden.
  if (event.target !== $igm) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  igmEscape();
});
$igm.addEventListener('close', () => {
  const returnFocus = igmState.returnFocus;
  igmState.returnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
  else if (!document.getElementById('article-overlay').hidden) document.getElementById('overlay-close').focus();
});
document.addEventListener('keydown', event => {
  if (!$igm.open || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  igmEscape();
}, true);
$igm.addEventListener('click', event => {
  if (event.target !== $igm) return;
  const rect = $igm.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) igmClose();
});

$igmList.addEventListener('click', event => {
  const row = event.target.closest('[data-igm-entry]');
  if (!row || igmState.busy) return;
  const item = igmState.items.find(candidate => candidate.id === row.dataset.id);
  if (!item) return;
  const instagram = event.target.closest('[data-igm-instagram]');
  if (instagram) {
    igmState.actionIndex = -1;
    const enabled = instagram.checked;
    void igmSave(
      { action: 'instagram-poster', id: item.id, enabled },
      enabled ? 'Instagram-Poster wird markiert …' : 'Instagram-Markierung wird entfernt …',
      enabled ? 'Als Instagram-Poster markiert.' : 'Instagram-Markierung entfernt.',
    );
    return;
  }
  if (event.target.closest('[data-igm-more]')) {
    const wasOpen = row.classList.contains('is-actions-open');
    $igmList.querySelectorAll('.is-actions-open').forEach(entry => {
      entry.classList.remove('is-actions-open');
      entry.querySelector('[data-igm-more]')?.setAttribute('aria-expanded', 'false');
    });
    row.classList.toggle('is-actions-open', !wasOpen);
    row.querySelector('[data-igm-more]').setAttribute('aria-expanded', String(!wasOpen));
    igmState.actionIndex = wasOpen ? -1 : igmState.items.indexOf(item);
    return;
  }
  if (event.target.closest('[data-igm-view]')) { igmOpenPreview(item); return; }
  const move = event.target.closest('[data-igm-move]');
  if (move) { igmMove(item.id, Number(move.dataset.igmMove)); return; }
  if (event.target.closest('[data-igm-trash]')
    && window.confirm('„' + item.filename + '“ samt Markdown-Datei in den Papierkorb verschieben?')) {
    igmState.actionIndex = -1;
    void igmSave({ action: 'trash', id: item.id }, 'Grafik wird in den Papierkorb verschoben …', 'Grafik in den Papierkorb verschoben.');
  }
});

function igmClearDrag() {
  igmState.dragId = null;
  $igmList.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after').forEach(row => {
    row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
  });
}
$igmList.addEventListener('dragstart', event => {
  const row = event.target.closest('[data-igm-drag]')?.closest('[data-igm-entry]');
  if (!row || igmState.busy) { event.preventDefault(); return; }
  igmState.dragId = row.dataset.id;
  row.classList.add('is-dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', row.dataset.id);
});
$igmList.addEventListener('dragover', event => {
  const row = event.target.closest('[data-igm-entry]');
  if (!igmState.dragId || !row || row.dataset.id === igmState.dragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  $igmList.querySelectorAll('.is-drop-before, .is-drop-after').forEach(entry => entry.classList.remove('is-drop-before', 'is-drop-after'));
  const rect = row.getBoundingClientRect();
  row.classList.add(event.clientY > rect.top + rect.height / 2 ? 'is-drop-after' : 'is-drop-before');
});
$igmList.addEventListener('drop', event => {
  const row = event.target.closest('[data-igm-entry]');
  const id = igmState.dragId;
  const targetItem = igmState.items.find(item => item.id === row?.dataset.id);
  if (!row || !id || row.dataset.id === id || targetItem?.fixed) { igmClearDrag(); return; }
  event.preventDefault();
  const after = row.classList.contains('is-drop-after');
  const ids = igmState.items.filter(item => !item.fixed).map(item => item.id).filter(itemId => itemId !== id);
  const target = ids.indexOf(row.dataset.id);
  ids.splice(target + (after ? 1 : 0), 0, id);
  igmClearDrag();
  igmOrder(ids);
});
$igmList.addEventListener('dragend', igmClearDrag);
