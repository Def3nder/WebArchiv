/* WebArchiv — Artikel-Detailansicht
 * Artikel öffnen und schließen, Lesezeichen und renderDetail (Kopf, Bilder, Text, Aktionen).
 * Klassisches Skript vor app.js: Es enthält nur Deklarationen; die Funktionen greifen
 * zur Laufzeit auf den Zustand und die DOM-Referenzen aus app.js zu (gemeinsamer
 * globaler Gültigkeitsbereich der klassischen Skripte). Kein Code, der beim Laden läuft
 * und dabei app.js braucht. */

// ── Article detail overlay ─────────────────────────────────────────────────
// dir: Richtung beim Blättern (für die Vollansicht: erstes/letztes Bild);
// image/deepLink: Link auf ein Bild der Gruppe → direkt in der Vollansicht öffnen.
async function openArticle(id, {
  dir = 0,
  image = null,
  deepLink = false,
  historyMode = 'push',
  detailPosition = null,
  restoring = false,
} = {}) {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) return;
  if ($overlay.hidden) lastListPosition = captureListPosition();
  if (!detailPosition) lastDetailPosition = null;
  selectedTtsArticle = null;
  adminHooks.articleChanged();
  $overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  // Beim Artikel-Wechsel laufende Medien stoppen
  stopAudio();
  stopVideo();
  $detail.innerHTML = `<div style="padding:80px 40px;text-align:center;color:var(--text-muted)"><div class="spinner" style="margin:0 auto"></div></div>`;

  // Beim Wiederherstellen/Zurücknavigieren keinen zusätzlichen Verlaufseintrag erzeugen.
  const articleHash = `#/article/${sanitizeForId(id)}`;
  if (historyMode === 'replace') history.replaceState(APP_VIEW_HISTORY_STATE, '', articleHash);
  else if (historyMode === 'push') history.pushState(APP_VIEW_HISTORY_STATE, '', articleHash);

  try {
    const article = await fetchArticle(id);
    // Eine gruppierte Infografik liefert ihre Gruppe (requestedId = angefragtes Bild).
    state.currentArticleIdx = state.currentItems.findIndex(a => a.id === id);
    if (state.currentArticleIdx < 0) state.currentArticleIdx = state.currentItems.findIndex(a => a.id === article.id);
    if (article.id !== id) history.replaceState(APP_VIEW_HISTORY_STATE, '', `#/article/${sanitizeForId(article.id)}`);
    currentViewItemId = article.id;
    updateNavButtons();
    renderDetail(article);
    const panel = $overlay.querySelector('.overlay-panel');
    if (panel && !detailPosition) {
      panel.scrollTop = 0;
      lastDetailPosition = captureDetailPosition();
    }

    const urls = detailImageUrls(article);
    const $fs = document.getElementById('img-fullscreen');
    const requestedIdx = (article.images || []).findIndex(img => img.id === article.requestedId);
    if (image && urls.length > 1) {
      openGalleryFullscreen(urls, image - 1, article.id);
    } else if (deepLink && requestedIdx >= 0 && urls.length > 1) {
      openGalleryFullscreen(urls, requestedIdx, article.id);
    } else if (!$fs.hidden) {
      // Blättern in der Vollansicht: beim nächsten Artikel mit Bild 1, rückwärts mit dem letzten.
      if (urls.length) openGalleryFullscreen(urls, dir < 0 ? urls.length - 1 : 0, article.id);
      else closeImageFullscreen();
    }
    if (detailPosition) await restoreDetailPosition(detailPosition);
    if (!restoring) saveCurrentViewState();
    return true;
  } catch (err) {
    // Geschützter Artikel + Gast (403) → Anmeldung anbieten statt "nicht gefunden".
    // Overlay ausblenden, aber Deep-Link im Hash lassen, damit die Anmeldung den
    // Artikel danach automatisch öffnet (siehe login()).
    if (err && err.status === 403 && (!currentUser || currentUser.role === 'guest')) {
      $overlay.hidden = true;
      stopAudio();
      stopVideo();
      pendingLoginDeepLink = parseArticleHash(location.hash);
      showLogin('Dieser Artikel ist geschützt. Bitte melden Sie sich an.');
      return false;
    }
    if (restoring) {
      $overlay.hidden = true;
      document.body.style.overflow = '';
      currentViewItemId = '';
      lastDetailPosition = null;
      history.replaceState(APP_VIEW_HISTORY_STATE, '', '#/');
      return false;
    }
    $detail.innerHTML = `<div style="padding:40px"><p>Artikel nicht gefunden.</p></div>`;
    return false;
  }
}

function closeOverlay() {
  if (typeof leaveArticleEditor === 'function' && !leaveArticleEditor()) return;
  selectedTtsArticle = null;
  adminHooks.articleChanged();
  $overlay.hidden = true;
  document.body.style.overflow = '';
  currentViewItemId = '';
  lastDetailPosition = null;
  stopAudio();
  stopVideo();
  history.pushState(APP_VIEW_HISTORY_STATE, '', '#/');
  // Hörfortschritt und „zuletzt gehört“ in der Liste auffrischen.
  if (isBookMode()) loadArticles();
  // Lesezeichen-Ansicht: entfernte Lesezeichen erst nach dem Schließen aus der Liste
  // nehmen (beim Blättern im Artikel bleibt die Reihenfolge stabil). Verzögert, damit
  // ein gleichzeitig gesetzter Filter (Kategorie-Klick) zuerst lädt.
  if (bookmarksChanged && state.bookmarks && !isBookMode()) setTimeout(loadArticles, 0);
  bookmarksChanged = false;
  saveCurrentViewState();
}

// ── Lesezeichen ───────────────────────────────────────────────────────────
let bookmarksChanged = false;

function bookmarkUrl(id) {
  return '/api/bookmarks/' + String(id).split('/').map(encodeURIComponent).join('/');
}

function showBookmarkState(button, on) {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
  button.title = on ? 'Lesezeichen entfernen' : 'Lesezeichen setzen';
}

// Klick setzt bzw. löscht das Lesezeichen; Kachel und Listeneintrag ziehen mit.
async function toggleBookmark(article, button) {
  if (button.dataset.busy) return;
  const on = !article.bookmarked;
  button.dataset.busy = '1';
  showBookmarkState(button, on);
  try {
    const r = await apiFetch(bookmarkUrl(article.id), { method: on ? 'PUT' : 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Lesezeichen konnte nicht gespeichert werden.');
    }
    article.bookmarked = on;
    bookmarksChanged = true;
    // Eine Infografik-Kachel öffnet ihren Anker: Kachel-ID ist dann requestedId.
    const ids = new Set([article.id, article.requestedId].filter(Boolean));
    state.currentItems.forEach(item => { if (ids.has(item.id)) item.bookmarked = on; });
    $app.querySelectorAll('.card').forEach(card => {
      const mark = ids.has(card.dataset.id) && card.querySelector('.card-bookmark');
      if (mark) mark.hidden = !on;
    });
  } catch (err) {
    showBookmarkState(button, !on);
    if (err.code !== 'session_expired') alert(err.message);
  } finally {
    delete button.dataset.busy;
  }
}

function renderDetail(article) {
  if (article.kind === 'audiobook') return renderBookDetail(article);
  selectedTtsArticle = article;
  adminHooks.articleChanged();
  const hue = authorHue(article.author);

  // Gruppe: Bildleiste (drei 9:16-Bilder nebeneinander, bei zwei je halbe Breite,
  // ab vier waagerecht wischbar). Klick öffnet das Bild in der Vollansicht.
  const images = article.images?.length > 1 ? article.images : null;
  const heroHtml = images
    ? `<div class="detail-gallery${images.length > 3 ? ' is-scrollable' : ''}" style="--gallery-cols:${images.length === 2 ? 2 : 3}">
        ${images.map((image, i) => `<button type="button" class="detail-gallery-item${image.kind === 'photo' ? ' is-photo' : ''}" data-index="${i}" aria-label="Bild ${i + 1} von ${images.length} vergrößern"><img src="${esc(image.url)}" alt="" loading="lazy" /></button>`).join('')}
      </div>`
    : article.imageUrl
    ? `<div class="detail-hero">
        <img src="${esc(article.imageUrl)}" alt="" id="detail-hero-img" />
        <button class="detail-hero-expand" id="detail-hero-expand" aria-label="Vollbild">${svgExpand()}</button>
        <a class="detail-hero-download" href="${esc(article.imageUrl)}" download aria-label="Bild herunterladen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v12m0 0l-4-4m4 4l4-4"/><rect x="4" y="18" width="16" height="2" rx="1"/>
          </svg>
        </a>
      </div>`
    : `<div class="detail-hero"><div class="detail-hero-placeholder">${svgImage(true)}</div></div>`;

  const cats = (article.categories || []).map(c =>
    `<span class="detail-cat-pill" data-cat="${esc(c)}">${esc(c)}</span>`
  ).join('');
  const tagPills = (article.tags || []).map(t =>
    `<span class="detail-cat-pill" style="opacity:.7">${esc(t)}</span>`
  ).join('');

  const audioHtml = article.audioUrl ? renderAudioPlayer(article) : '';
  const videoHtml = article.videoUrl ? renderVideoPlayer(article.videoUrl) : '';
  const pdfHtml   = article.pdfUrl   ? renderPdfEmbed(article.pdfUrl)     : '';

  const hasBody = !!(article.bodyHtml && article.bodyHtml.trim());
  const copyBtnHtml = hasBody
    ? `<div class="detail-copy-wrap">
        <button type="button" class="detail-cat-pill detail-copy-btn" id="detail-copy-btn" aria-label="Kopieroptionen" title="Kopieroptionen" aria-haspopup="menu" aria-controls="copy-prompt-menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
            </svg>
        </button>
        <div class="copy-prompt-menu" id="copy-prompt-menu" role="menu" hidden></div>
      </div>`
    : '';
  const bookmarkBtnHtml = currentUser && currentUser.role !== 'guest'
    ? `<button type="button" class="detail-cat-pill detail-bookmark-btn${article.bookmarked ? ' active' : ''}" id="detail-bookmark-btn" aria-pressed="${article.bookmarked ? 'true' : 'false'}" aria-label="Lesezeichen" title="${article.bookmarked ? 'Lesezeichen entfernen' : 'Lesezeichen setzen'}">${svgBookmark()}</button>`
    : '';
  const shareBtnHtml = `<button class="detail-cat-pill detail-share-btn" id="detail-share-btn" aria-label="Link teilen" title="Link zum Artikel teilen">${svgShare()}<span class="detail-share-text">Teilen</span></button>`;
  const infographicBtnHtml = article.canUploadInfographic
    ? `<div class="detail-infographic-wrap">
        <button type="button" class="detail-cat-pill detail-infographic-btn" id="detail-infographic-btn" aria-label="Infografiken verwalten" title="Infografiken verwalten">Infografiken</button>
      </div>`
    : '';
  const dateHtml = `<div class="detail-date-row">
        <span class="detail-date-block">${article.date ? esc(formatDate(article.date)) : ''}</span>
        <div class="detail-action-row">
          ${currentUser?.role === 'admin' ? `<div class="detail-tts-menu"><button type="button" class="detail-cat-pill" id="detail-actions-btn" aria-haspopup="menu" aria-controls="detail-actions-menu" aria-expanded="false" title="Artikel bearbeiten und Audio erzeugen">Aktionen</button><div class="copy-prompt-menu" id="detail-actions-menu" role="menu" hidden><button type="button" role="menuitem" class="header-menu-item" data-article-edit>Artikel editieren</button><button type="button" role="menuitem" class="header-menu-item" data-tts-action="start" ${adminHooks.ttsBusy() ? 'disabled' : ''}>Audio erzeugen</button><button type="button" role="menuitem" class="header-menu-item" data-tts-action="show">Audio-Auftrag anzeigen</button></div></div>` : ''}
          ${infographicBtnHtml}
          ${copyBtnHtml}
          ${shareBtnHtml}
          ${bookmarkBtnHtml}
        </div>
      </div>`;
  const summaryHtml = article.summary
    ? `<div class="detail-summary"><span class="detail-summary-label">Zusammenfassung:</span> ${esc(article.summary)}</div>`
    : '';
  const sourceHtml = article.sourceUrl
    ? `<div class="detail-source"><em>Quelle: <a href="${esc(article.sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(article.sourceUrl)}</a></em></div>`
    : '';

  $detail.innerHTML = `
    ${heroHtml}
    <div class="detail-content">
      <div class="detail-meta">
        <span class="author-badge" style="--author-hue:${hue}">${esc(article.author.replace(/_/g,' '))}</span>
        ${article.episodeNum ? `<span class="detail-episode">#${article.episodeNum}</span>` : ''}
      </div>
      <h1 class="detail-title">${esc(article.title)}</h1>
      ${(cats || tagPills) ? `<div class="detail-categories">${cats}${tagPills ? `<span style="color:var(--text-dim);font-size:.7rem;align-self:center;margin-left:4px">|</span>${tagPills}` : ''}</div>` : ''}
      ${dateHtml}
      ${sourceHtml}
      ${summaryHtml}
      <div class="detail-divider"></div>
      ${audioHtml}
      ${videoHtml}
      <div class="detail-body">${article.bodyHtml || ''}</div>
      ${pdfHtml}
    </div>`;

  // Fullscreen image handler
  if (images) {
    const urls = images.map(image => image.url);
    $detail.querySelectorAll('.detail-gallery-item').forEach(item => {
      item.addEventListener('click', () => openGalleryFullscreen(urls, Number(item.dataset.index), article.id));
    });
  } else if (article.imageUrl) {
    const openFs = () => openImageFullscreen(article.imageUrl);
    prepareImageFile(article.imageUrl); // für „Bild herunterladen“ (Teilen-Menü)
    document.getElementById('detail-hero-expand')?.addEventListener('click', e => { e.stopPropagation(); openFs(); });
    document.getElementById('detail-hero-img')?.addEventListener('click', openFs);
  }

  // Category pill → filter (Copy-Button ausschließen)
  $detail.querySelectorAll('.detail-cat-pill:not(.detail-copy-btn)').forEach(pill => {
    pill.addEventListener('click', () => {
      const cat = pill.dataset.cat;
      if (!cat) return;
      closeOverlay();
      $filterCategory.value = cat;
      state.category = cat;
      state.page = 1;
      loadArticles();
    });
  });

  // Admin-Aktionen (Editor, Audio): gemeinsames ARIA-Menü. Die Einträge selbst
  // bedienen delegierte Handler ([data-article-edit], [data-tts-action]).
  WebArchivAriaMenu.create({
    trigger: document.getElementById('detail-actions-btn'),
    menu: document.getElementById('detail-actions-menu'),
  });

  const $bookmarkDetailBtn = document.getElementById('detail-bookmark-btn');
  $bookmarkDetailBtn?.addEventListener('click', () => toggleBookmark(article, $bookmarkDetailBtn));

  // Teilen-Button → Vorschau-fähigen Link (/a/<id>) teilen bzw. kopieren.
  // navigator.share (mobil) öffnet direkt das System-Teilen-Menü (z. B. WhatsApp),
  // sonst wird der Link in die Zwischenablage kopiert.
  const $shareBtn = document.getElementById('detail-share-btn');
  if ($shareBtn) {
    $shareBtn.addEventListener('click', async () => {
      const url = `${location.origin}/a/${sanitizeForId(article.id)}`;
      if (navigator.share) {
        try { await navigator.share({ title: article.title, url }); } catch { /* abgebrochen */ }
        return;
      }
      const $txt = $shareBtn.querySelector('.detail-share-text');
      try {
        await navigator.clipboard.writeText(url);
        if ($txt) { const orig = $txt.textContent; $txt.textContent = 'Kopiert!'; setTimeout(() => { $txt.textContent = orig; }, 1500); }
      } catch { /* Zwischenablage nicht verfügbar */ }
    });
  }

  // Copy-Button → zwei Klick-Zonen:
  //   Icon  → öffnet Menü mit Prompt-Varianten (vorangestellt)
  //   "copy" → nur Titel + Body
  document.getElementById('detail-infographic-btn')?.addEventListener('click', ev => {
    ev.stopPropagation();
    window.openInfographicManager?.(article);
  });

  const $copyBtn  = document.getElementById('detail-copy-btn');
  const $copyMenu = document.getElementById('copy-prompt-menu');

  if ($copyBtn) {
    // Kopiert Artikel, optional mit vorangestelltem Prompt-Text
    // Eigene Text-Extraktion, weil innerText bei <ol> die Nummerierung verschluckt.
    const extractBodyText = (root) => {
      if (!root) return '';
      const blocks = [];
      for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.replace(/\s+/g, ' ').trim();
          if (t) blocks.push(t);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName;
        if (tag === 'OL') {
          const start = parseInt(node.getAttribute('start') || '1', 10);
          let i = 0;
          for (const li of node.children) {
            if (li.tagName === 'LI') {
              const t = (li.innerText || li.textContent || '').trim();
              if (t) blocks.push(`${start + i}. ${t}`);
              i++;
            }
          }
        } else if (tag === 'UL') {
          for (const li of node.children) {
            if (li.tagName === 'LI') {
              const t = (li.innerText || li.textContent || '').trim();
              if (t) blocks.push(`- ${t}`);
            }
          }
        } else {
          const t = (node.innerText || node.textContent || '').trim();
          if (t) blocks.push(t);
        }
      }
      return blocks.join('\n\n');
    };

    const copyArticle = async (promptText = '') => {
      const bodyText = extractBodyText($detail.querySelector('.detail-body')).trim();
      const articleText = `${article.title}\n\n---\n\n${bodyText}`;
      const prefix = promptText.trim() ? promptText.trim() + '\n\n' : '';
      try {
        await navigator.clipboard.writeText(prefix + articleText);
        $copyBtn.classList.add('copied');
        setTimeout(() => $copyBtn.classList.remove('copied'), 1000);
      } catch (err) {
        console.warn('Clipboard write failed', err);
      }
    };

    const isIosPromptNavigation = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const iosPromptTarget = url => {
      try {
        // Die normale Gemini-Webadresse bleibt innerhalb des iOS-Webviews.
        // Das von der Gemini-App registrierte Schema öffnet stattdessen direkt
        // einen neuen Chat; der Prompt liegt bereits in der Zwischenablage.
        if (new URL(url).hostname === 'gemini.google.com') return 'googlegemini://';
      } catch { /* Die Serverantwort enthält regulär bereits eine geprüfte URL. */ }
      return url;
    };

    // Erster Eintrag: nur Artikel; die Prompts werden beim ersten Öffnen geladen.
    let promptItems = null;
    const buildMenu = async () => {
      if (promptItems) return;
      promptItems = [{ file: null, label: 'Artikel' }];
      try {
        const r = await fetch('/api/prompts');
        if (r.ok) promptItems.push(...await r.json());
      } catch { /* nur "Artikel" anbieten */ }
      $copyMenu.innerHTML = promptItems.map((it, i) =>
        `<button type="button" role="menuitem" class="copy-prompt-item${i === 0 ? ' is-article' : ''}" data-prompt-index="${i}">${esc(it.label)}</button>`
      ).join('');
    };
    const choosePrompt = async item => {
      const selected = promptItems[Number(item.dataset.promptIndex)] || promptItems[0];
      const opensExternalPrompt = !!(selected.file && selected.url);
      if (opensExternalPrompt && isIosPromptNavigation()) {
        // iOS hinterlässt bei window.open aus einer installierten Web-App
        // gelegentlich einen leeren weißen Browserkontext. Eine Navigation
        // im aktuellen Kontext übergibt externe URLs direkt an Safari.
        await copyArticle(selected.prompt || '');
        window.location.assign(iosPromptTarget(selected.url));
        return;
      }
      void copyArticle(selected.prompt || '');
      if (opensExternalPrompt) window.open(selected.url, '_blank', 'noopener,noreferrer');
    };
    WebArchivAriaMenu.create({
      trigger: $copyBtn,
      menu: $copyMenu,
      onBeforeOpen: buildMenu,
      onSelect: item => { void choosePrompt(item); },
    });
  }

  // Wire up audio player
  if (article.audioUrl) {
    wireAudioPlayer(article.audioUrl, article);
  }


  // Scroll overlay to top
  $overlay.querySelector('.overlay-panel').scrollTop = 0;
}
