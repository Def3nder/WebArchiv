/* WebArchiv — Prüfmodus „Infografiken prüfen“ (nur Admins).
 * Poster-Markierungen werden seitenübergreifend gesammelt und gemeinsam über
 * /api/infographic-review gespeichert. Wird nur in der Admin-Shell geladen
 * (data-admin-asset, server.js ADMIN_ASSET_PATHS) und nutzt die globalen Hilfen
 * aus app.js (state, loadArticles, setLayout, openGalleryFullscreen, …).
 * Die Anbindung erfolgt über den Platzhalter infographicReview und adminHooks. */
(() => {
const $infographicReviewSave = document.getElementById('infographic-review-save');
const review = {
  saving: false,
  baseline: new Map(),
  changes: new Map(),
  returnList: null,
};

function infographicReviewValue(id, fallback = false) {
  if (review.changes.has(id)) return review.changes.get(id);
  if (review.baseline.has(id)) return review.baseline.get(id);
  return fallback === true;
}

function rememberInfographicReviewItems(items) {
  for (const item of items) {
    if (!review.baseline.has(item.id)) {
      review.baseline.set(item.id, item.instagramPoster === true);
    }
  }
}

function updateInfographicReviewSaveButton(message = '') {
  if (!$infographicReviewSave) return;
  const count = review.changes.size;
  $infographicReviewSave.hidden = !isInfographicReviewMode();
  $infographicReviewSave.disabled = review.saving;
  $infographicReviewSave.textContent = message || (count ? `Speichern (${count})` : 'Abbrechen');
}

function syncInfographicReviewMark(id) {
  const enabled = infographicReviewValue(id);
  $app.querySelectorAll('[data-review-poster-id]').forEach(input => {
    if (input.dataset.reviewPosterId !== id) return;
    input.checked = enabled;
    input.closest('.infographic-review-card')?.classList.toggle('is-poster', enabled);
    input.setAttribute('aria-label', enabled ? 'Poster-Markierung entfernen' : 'Als Poster markieren');
    input.closest('.poster-review-toggle')?.setAttribute('title', enabled
      ? 'Poster-Markierung entfernen'
      : 'Als Poster markieren');
  });
  if ($fullscreenPosterCheckbox?.dataset.reviewId === id) {
    $fullscreenPosterCheckbox.checked = enabled;
    $fullscreenPosterCheckbox.setAttribute('aria-label', enabled
      ? 'Poster-Markierung entfernen'
      : 'Als Poster markieren');
  }
  updateInfographicReviewSaveButton();
}

function setInfographicReviewMark(id, enabled) {
  if (!isInfographicReviewMode() || !review.baseline.has(id)) return;
  if (enabled === review.baseline.get(id)) review.changes.delete(id);
  else review.changes.set(id, enabled);
  syncInfographicReviewMark(id);
}

function setInfographicReviewChrome() {
  const active = isInfographicReviewMode();
  document.body.classList.toggle('mode-infographic-review', active);
  $filterAuthor.disabled = active;
  const authorMenuTrigger = filterAriaRoot($filterAuthor)?.querySelector('.filter-menu-trigger');
  if (authorMenuTrigger) authorMenuTrigger.disabled = active;
  $filterLayout.querySelectorAll('button').forEach(button => { button.disabled = active; });
  const menuItem = $adminMenu.querySelector('[data-action="review-infographics"]');
  if (menuItem) menuItem.textContent = active ? 'Prüfmodus beenden' : 'Infografiken prüfen';
  updateInfographicReviewSaveButton();
  syncTelegramInstagramButton();
}

function resetInfographicReviewState() {
  infographicReview.active = false;
  review.saving = false;
  review.baseline.clear();
  review.changes.clear();
  review.returnList = null;
  setInfographicReviewChrome();
}

async function enterInfographicReview() {
  if (currentUser?.role !== 'admin' || isInfographicReviewMode()) return;
  const snapshot = snapshotSessionView();
  review.returnList = {
    ...snapshot.list,
    listPosition: snapshot.view.listPosition,
  };
  review.baseline.clear();
  review.changes.clear();
  infographicReview.active = true;
  Object.assign(state, {
    q: '', author: INFOGRAPHICS_AUTHOR, externalAudio: false, year: '', category: '',
    infographicFilter: 'all', bookmarks: false, page: 1,
  });
  $searchInput.value = '';
  $searchClear.classList.remove('visible');
  $filterAuthor.value = INFOGRAPHICS_AUTHOR;
  $filterYear.value = '';
  $filterCategory.value = '';
  setInfographicFilter('all');
  setBookmarkFilter(false);
  setLayout('tall');
  [$filterAuthor, $filterYear, $filterCategory].forEach(syncFilterAriaMenu);
  applyBookMode();
  setInfographicReviewChrome();
  await loadArticles();
  scrollToResults('auto');
}

async function leaveInfographicReview({ discard = false } = {}) {
  if (!isInfographicReviewMode()) return true;
  if (!discard && review.changes.size
      && !confirm('Ungespeicherte Poster-Markierungen verwerfen und den Prüfmodus beenden?')) return false;
  const previous = review.returnList;
  resetInfographicReviewState();
  if (!previous) return true;
  Object.assign(state, previous, { infographicFilter: 'all' });
  $searchInput.value = state.q;
  $searchClear.classList.toggle('visible', !!state.q);
  setTelegram(state.telegram);
  setBookmarkFilter(state.bookmarks);
  setLayout(previous.layout || 'tall');
  $filterLimit.value = String(state.limit);
  applySavedFilterControls();
  syncFilterAriaMenu($filterLimit);
  await loadArticles();
  await restoreListPosition(previous.listPosition);
  saveCurrentViewState();
  return true;
}

async function saveInfographicReview() {
  if (!isInfographicReviewMode() || review.saving || !review.changes.size) return;
  const changes = [...review.changes].map(([id, enabled]) => ({
    id,
    enabled,
    expected: review.baseline.get(id),
  }));
  review.saving = true;
  updateInfographicReviewSaveButton('Speichert …');
  try {
    const response = await apiFetch('/api/infographic-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Poster-Markierungen konnten nicht gespeichert werden.');
    for (const item of data.updated || []) review.baseline.set(item.id, item.instagramPoster === true);
    review.changes.clear();
    review.saving = false;
    await leaveInfographicReview({ discard: true });
  } catch (error) {
    alert(error.message || 'Poster-Markierungen konnten nicht gespeichert werden.');
  } finally {
    review.saving = false;
    if (isInfographicReviewMode()) updateInfographicReviewSaveButton();
  }
}

function renderInfographicReviewCard(poster, idx) {
  const author = poster.displayAuthor || INFOGRAPHICS_AUTHOR;
  const hue = authorHue(author);
  const delay = Math.min(idx * 30, 300);
  const selected = infographicReviewValue(poster.id, poster.instagramPoster);
  const actionLabel = selected ? 'Poster-Markierung entfernen' : 'Als Poster markieren';
  return `
    <article class="card instagram-poster-card infographic-review-card${selected ? ' is-poster' : ''}"
      data-id="${esc(poster.id)}" data-poster-index="${idx}" style="animation-delay:${delay}ms">
      <button type="button" class="instagram-poster-image infographic-review-image"
        aria-label="${esc(poster.title || 'Infografik')} im Vollbild öffnen">
        <img src="${esc(poster.imageUrl)}" alt="${esc(poster.title || 'Infografik')}" loading="lazy" data-fallback />
        <span class="instagram-poster-badge instagram-poster-author" style="--author-hue:${hue}">${esc(author.replace(/_/g, ' '))}</span>
        ${responsiveDateMarkup(poster.date, 'instagram-poster-badge instagram-poster-date')}
      </button>
      <label class="poster-review-toggle" title="${actionLabel}">
        <input type="checkbox" data-review-poster-id="${esc(poster.id)}" aria-label="${actionLabel}"${selected ? ' checked' : ''} />
        <span class="poster-review-check" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.4 3.4 7.6-8"/></svg>
        </span>
        <span class="visually-hidden">Poster</span>
      </label>
    </article>`;
}

$infographicReviewSave?.addEventListener('click', () => {
  if (review.changes.size) void saveInfographicReview();
  else void leaveInfographicReview();
});
$fullscreenPosterCheckbox?.addEventListener('change', event => {
  const id = event.currentTarget.dataset.reviewId;
  if (id) setInfographicReviewMark(id, event.currentTarget.checked);
});

window.addEventListener('beforeunload', event => {
  if (!isInfographicReviewMode() || !review.changes.size) return;
  event.preventDefault();
  event.returnValue = '';
});

// Im Prüfmodus schaltet die Leertaste die Poster-Markierung des aktuell
// gezeigten Bildes. Hat die Checkbox selbst den Fokus, bleibt ihre native
// Tastaturbedienung zuständig, damit die Markierung nicht doppelt wechselt.
document.addEventListener('keydown', e => {
  if ((e.key === ' ' || e.code === 'Space') && $imgFullscreen.open
      && isInfographicReviewMode() && $fullscreenPosterToggle && !$fullscreenPosterToggle.hidden) {
    if (e.target === $fullscreenPosterCheckbox) return;
    const target = e.target?.nodeType === Node.ELEMENT_NODE ? e.target : e.target?.parentElement;
    const interactive = target?.closest(
      'input, textarea, select, button, a, audio, video, [contenteditable]:not([contenteditable="false"]), [role="slider"]',
    );
    if (interactive) return;
    e.preventDefault();
    if (e.repeat) return;
    const id = $fullscreenPosterCheckbox.dataset.reviewId;
    if (id) setInfographicReviewMark(id, !$fullscreenPosterCheckbox.checked);
  }
});

// ── Einhängen in app.js ─────────────────────────────────────────────────────
Object.assign(infographicReview, {
  hasChanges: () => review.changes.size > 0,
  value: infographicReviewValue,
  mark: setInfographicReviewMark,
  remember: rememberInfographicReviewItems,
  reset: resetInfographicReviewState,
  renderCard: renderInfographicReviewCard,
});
adminHooks.actions['review-infographics'] = () => {
  if (isInfographicReviewMode()) void leaveInfographicReview();
  else void enterInfographicReview();
};
})();
