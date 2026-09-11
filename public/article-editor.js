const $articleEditor = document.getElementById('article-editor');
const $editorText = document.getElementById('article-editor-text');
const $editorStatus = document.getElementById('article-editor-status');
const $editorSave = document.getElementById('article-editor-save');
const articleEditorState = { id: null, original: '', version: null, saving: false, generation: 0, url: '', focus: null };

function editorDirty() {
  return articleEditorState.version !== null && $editorText.value !== articleEditorState.original;
}
function updateEditorSave() {
  $editorSave.disabled = articleEditorState.saving || !editorDirty();
}
function leaveArticleEditor() {
  if (!$articleEditor.open) return true;
  if (articleEditorState.saving) return false;
  if (editorDirty() && !confirm('Ungespeicherte Änderungen verwerfen?')) return false;
  ++articleEditorState.generation;
  $articleEditor.close();
  return true;
}
async function editorRequest(options) {
  const id = articleEditorState.id.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`/api/article-markdown/${id}`, { cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Die Anfrage ist fehlgeschlagen.');
  return result;
}
async function loadEditorFile() {
  if (articleEditorState.saving) return;
  if (editorDirty() && !confirm('Entwurf verwerfen und die aktuelle Datei neu laden?')) return;
  const generation = ++articleEditorState.generation;
  $editorText.disabled = true;
  $editorSave.disabled = true;
  $editorStatus.textContent = 'Datei wird geladen …';
  try {
    const result = await editorRequest();
    if (generation !== articleEditorState.generation || !$articleEditor.open) return;
    $editorText.value = result.markdown;
    articleEditorState.original = $editorText.value;
    articleEditorState.version = result.version;
    $editorStatus.textContent = '';
    $editorText.disabled = false;
    $editorText.focus();
  } catch (error) {
    if (generation !== articleEditorState.generation) return;
    $editorStatus.textContent = error.message + ' Ihr vorhandener Entwurf bleibt erhalten.';
    $editorText.disabled = articleEditorState.version === null;
  } finally {
    if (generation === articleEditorState.generation) updateEditorSave();
  }
}
async function saveEditorFile() {
  if ($editorSave.disabled) return;
  articleEditorState.saving = true;
  $editorText.readOnly = true;
  $articleEditor.querySelectorAll('button').forEach(button => { button.disabled = true; });
  $editorStatus.textContent = 'Datei wird gespeichert und das Archiv aktualisiert …';
  try {
    const result = await editorRequest({ method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: $editorText.value, version: articleEditorState.version }) });
    articleEditorState.original = $editorText.value;
    articleEditorState.version = result.version;
    if (result.warning) {
      $editorStatus.textContent = result.warning;
      return;
    }
    try {
      const article = await fetchArticle(articleEditorState.id);
      await loadMeta();
      // Auch ein Filter ohne verbleibende Treffer bleibt sichtbar ausgewählt.
      for (const [select, value] of [[$filterAuthor, state.externalAudio ? '__external_audio__' : state.author || ''],
        [$filterYear, state.year || ''], [$filterCategory, state.category || '']]) {
        if (value && ![...select.options].some(option => option.value === value)) select.add(new Option(value, value));
        select.value = value;
      }
      await loadArticles();
      stopAudio();
      stopVideo();
      renderDetail(article);
      const notice = document.createElement('p');
      notice.className = 'detail-infographic-status';
      notice.setAttribute('role', 'status');
      notice.textContent = 'Artikel gespeichert.';
      $detail.querySelector('.detail-date-row').after(notice);
      state.currentArticleIdx = state.currentItems.findIndex(item => item.id === article.id);
      updateNavButtons();
      $articleEditor.close();
      $overlayClose.focus();
    } catch {
      $editorStatus.textContent = 'Die Datei wurde gespeichert. Die Ansicht konnte nicht aktualisiert werden. Bitte die Seite neu laden.';
    }
  } catch (error) {
    $editorStatus.textContent = error.message.includes('Entwurf bleibt')
      ? error.message : error.message + ' Ihr Entwurf bleibt im Editor erhalten.';
  } finally {
    articleEditorState.saving = false;
    $editorText.readOnly = false;
    $articleEditor.querySelectorAll('button').forEach(button => { button.disabled = false; });
    updateEditorSave();
    if ($articleEditor.open) $editorText.focus();
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-article-edit]');
  if (!button || !selectedTtsArticle || currentUser?.role !== 'admin') return;
  button.closest('details')?.removeAttribute('open');
  articleEditorState.id = selectedTtsArticle.id;
  articleEditorState.url = location.href;
  articleEditorState.focus = button.closest('details')?.querySelector('summary');
  articleEditorState.version = null;
  articleEditorState.original = '';
  $editorText.value = '';
  document.getElementById('article-editor-name').textContent = selectedTtsArticle.title;
  $articleEditor.showModal();
  loadEditorFile();
});
$editorText.addEventListener('input', updateEditorSave);
$editorSave.addEventListener('click', saveEditorFile);
document.getElementById('article-editor-reload').addEventListener('click', loadEditorFile);
for (const id of ['article-editor-close', 'article-editor-cancel']) document.getElementById(id).addEventListener('click', leaveArticleEditor);
$articleEditor.addEventListener('cancel', event => { event.preventDefault(); leaveArticleEditor(); });
$articleEditor.addEventListener('close', () => {
  if (articleEditorState.focus?.isConnected) articleEditorState.focus.focus();
});
document.addEventListener('keydown', event => {
  if (!$articleEditor.open) return;
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { event.preventDefault(); leaveArticleEditor(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); saveEditorFile(); }
}, true);
window.addEventListener('beforeunload', event => {
  if ($articleEditor.open && (editorDirty() || articleEditorState.saving)) { event.preventDefault(); event.returnValue = ''; }
});
