/* WebArchiv — Admin-Aufgaben: Audio erzeugen (TTS), Archiv neu einlesen,
 * Scrapen und Scrape-Log. Wird nur in der Admin-Shell geladen (data-admin-asset,
 * server.js ADMIN_ASSET_PATHS) und nutzt die globalen Hilfen aus app.js
 * (apiFetch, currentUser, loadMeta, loadArticles, renderDetail, …).
 * Die Anbindung an app.js erfolgt über adminHooks (siehe unten). */
(() => {
const $scrapeBackdrop = document.getElementById('scrape-backdrop');
const $scrapeClose    = document.getElementById('scrape-close');
const $scrapeTitle    = document.getElementById('scrape-title');
const $scrapeStatus   = document.getElementById('scrape-status');
const $scrapeOutput   = document.getElementById('scrape-output');

// ── Audio erzeugen: bestätigter Start und wiederaufnehmbares Status-Polling ──
let ttsStarting = false;
let ttsActive = false;
let ttsJobId = null;
let ttsPollGeneration = 0;
let ttsReturnFocus = null;
const $ttsStatus = document.getElementById('tts-status');
const $ttsOutput = document.getElementById('tts-output');
const $ttsCancel = document.getElementById('tts-cancel');
const $ttsAudio = document.getElementById('tts-audio');
const $ttsActivity = document.getElementById('tts-activity');
const $ttsReindex = document.getElementById('tts-reindex');

function updateTtsActions() {
  const disabled = !selectedTtsArticle || !$overlay.open || ttsStarting || ttsActive;
  const startMenu = document.getElementById('tts-start-menu');
  if (startMenu) startMenu.disabled = disabled;
  document.querySelectorAll('[data-tts-action="start"]').forEach(button => { button.disabled = disabled; });
}
function rememberTtsJob(id) {
  ttsJobId = id;
  try {
    if (id) sessionStorage.setItem('wa-tts-job', id);
    else sessionStorage.removeItem('wa-tts-job');
  } catch { /* Status bleibt über den Server wiederauffindbar. */ }
}
function clearTtsUI() {
  ++ttsPollGeneration;
  rememberTtsJob(null);
  ttsActive = false;
  if (!$ttsOverlay) return;
  if ($ttsOverlay.open) WebArchivLayers.close($ttsOverlay, { restoreFocus: false });
  $ttsOutput.textContent = '';
  $ttsStatus.textContent = '';
  $ttsAudio.hidden = true;
}
// Dialog am Ebenen-Stapel: Escape schließt nur die Anzeige, Tab bleibt im Dialog
// (nativ), andere Tasten erreichen den Artikel darunter nicht.
function openTtsModal() {
  ++ttsPollGeneration;
  if (!$ttsOverlay.open) {
    ttsReturnFocus = document.activeElement;
    WebArchivLayers.open($ttsOverlay, { name: 'tts', onEscape: closeTtsModal, returnFocus: false });
  }
  document.body.style.overflow = 'hidden';
  $ttsOutput.textContent = '';
  $ttsStatus.textContent = 'Auftrag wird geladen …';
  $ttsAudio.hidden = true;
  $ttsReindex.hidden = true;
  $ttsCancel.disabled = true;
  $ttsActivity.hidden = false;
  document.getElementById('tts-article').textContent = '';
  document.getElementById('tts-close').focus();
}
function closeTtsModal() {
  ++ttsPollGeneration;
  if ($ttsOverlay.open) WebArchivLayers.close($ttsOverlay, { restoreFocus: false });
  document.body.style.overflow = !$overlay.open ? '' : 'hidden';
  if (ttsReturnFocus?.isConnected) ttsReturnFocus.focus();
  else if ($overlay.open) $overlayClose.focus();
  else $reindexBtn.focus();
}
function chooseTtsProvider(article, providers) {
  const dialog = document.getElementById('tts-provider-dialog');
  const options = document.getElementById('tts-provider-options');
  const start = document.getElementById('tts-provider-start');
  const description = document.getElementById('tts-provider-description');
  const status = document.getElementById('tts-provider-status');
  document.getElementById('tts-provider-article').textContent = article.title;
  options.replaceChildren();
  const radios = [];
  for (const provider of providers) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'tts-provider';
    radio.value = provider.provider;
    radio.disabled = !provider.available;
    radio.checked = provider.provider === 'qwen' && provider.available;
    const text = document.createElement('span');
    text.textContent = provider.label + (provider.available ? '' : ' – nicht verfügbar');
    label.append(radio); label.append(text);
    options.append(label);
    radios.push(radio);
  }
  const selectedProvider = () => providers.find(p => p.available
    && radios.some(radio => radio.checked && radio.value === p.provider));
  status.textContent = providers.map(p => `${p.label}: ${p.status}`).join('\n');
  const update = () => {
    const selected = selectedProvider();
    start.disabled = !selected;
    description.textContent = selected?.confirmation || (providers.some(p => p.available)
      ? 'Wählen Sie einen Anbieter. Erst der Startbutton bestätigt die Generierung.'
      : 'Kein Anbieter verfügbar. Bitte Server oder API-Schlüssel prüfen.');
  };
  for (const radio of radios) radio.onchange = update;
  update();
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const selected = selectedProvider();
      resolve(dialog.returnValue === 'start' ? selected || null : null);
    }, { once: true });
    // Ebenen-Stapel: Escape schließt den Dialog (close → resolve(null)).
    WebArchivLayers.open(dialog, { name: 'tts-provider' });
    (radios.find(radio => radio.checked) || radios.find(radio => !radio.disabled)
      || dialog.querySelector('button')).focus();
  });
}

async function runTts() {
  const article = selectedTtsArticle;
  if (!article || !$overlay.open || currentUser?.role !== 'admin' || ttsStarting || ttsActive) return;
  ttsStarting = true;
  let startUncertain = false;
  updateTtsActions();
  try {
    const providerResponse = await apiFetch('/api/tts/provider');
    const info = await providerResponse.json();
    if (!providerResponse.ok) throw new Error(info.error || 'TTS-Provider nicht verfügbar.');
    if (currentUser?.role !== 'admin' || !$overlay.open || selectedTtsArticle?.id !== article.id) return;
    const provider = await chooseTtsProvider(article, info.providers);
    if (!provider || currentUser?.role !== 'admin' || !$overlay.open || selectedTtsArticle?.id !== article.id) return;
    const startRequest = async replaceExisting => {
      const response = await apiFetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: article.id, provider: provider.provider, replaceExisting }),
      });
      return { response, data: await response.json() };
    };
    startUncertain = true;
    let { response, data } = await startRequest(false);
    if (response.status === 409 && data.code === 'audio_exists') {
      startUncertain = false;
      const replace = window.confirm('Für diesen Artikel ist bereits eine Audiodatei vorhanden. Soll sie durch eine neu erzeugte Version ersetzt werden? Die vorhandene Datei wird nach erfolgreicher Erzeugung in den Papierkorb verschoben.');
      if (!replace) return;
      if (currentUser?.role !== 'admin' || !$overlay.open || selectedTtsArticle?.id !== article.id) return;
      startUncertain = true;
      ({ response, data } = await startRequest(true));
    }
    if (!response.ok) {
      startUncertain = false;
      throw new Error(data.error || 'Audio-Auftrag konnte nicht gestartet werden.');
    }
    if (currentUser?.role !== 'admin') return;
    openTtsModal();
    document.getElementById('tts-article').textContent = article.title;
    $ttsStatus.textContent = 'Audio-Auftrag wurde gestartet.';
    rememberTtsJob(data.jobId);
    ttsActive = true;
    if ($ttsOverlay.open) watchTts(data.jobId);
  } catch (error) {
    openTtsModal();
    $ttsActivity.hidden = true;
    $ttsStatus.textContent = error.message + (startUncertain
      ? ' Bei unklarer Verbindung „Status aktualisieren“ verwenden; der Auftrag könnte bereits laufen.' : '');
  } finally {
    ttsStarting = false;
    updateTtsActions();
  }
}
async function showTtsJob() {
  if (currentUser?.role !== 'admin') return;
  openTtsModal();
  const generation = ttsPollGeneration;
  try {
    // Funktioniert auch nach Reload oder in einem zweiten Browserfenster.
    const response = await apiFetch('/api/tts/latest');
    const data = await response.json();
    if (generation !== ttsPollGeneration) return;
    if (!response.ok) throw new Error(data.error || 'Auftrag nicht verfügbar.');
    rememberTtsJob(data.jobId);
    if (data.jobId) watchTts(data.jobId);
    else {
      ttsActive = false;
      updateTtsActions();
      $ttsActivity.hidden = true;
      $ttsStatus.textContent = 'Kein gespeicherter Audio-Auftrag vorhanden.';
    }
  } catch (error) {
    if (generation !== ttsPollGeneration) return;
    $ttsActivity.hidden = true;
    $ttsStatus.textContent = error.message;
  }
}
async function refreshTtsArticle(articleId) {
  await loadMeta();
  await loadArticles();
  if ($overlay.open && selectedTtsArticle?.id === articleId) {
    const article = await fetchArticle(articleId);
    if ($overlay.open && selectedTtsArticle?.id === articleId) {
      stopAudio();
      stopVideo();
      renderDetail(article);
    }
  }
}
function formatTtsOutput(output) {
  const pad = value => String(value).padStart(2, '0');
  return String(output || '').replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?= \[)/gm,
    (original, timestamp) => {
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return original;
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
  );
}
async function watchTts(jobId) {
  const generation = ++ttsPollGeneration;
  let failures = 0;
  while (generation === ttsPollGeneration && $ttsOverlay.open) {
    try {
      const response = await apiFetch(`/api/tts/${encodeURIComponent(jobId)}/status`);
      if (generation !== ttsPollGeneration) return;
      if ([401, 403, 404].includes(response.status)) {
        rememberTtsJob(null);
        ttsActive = false;
        updateTtsActions();
        $ttsOutput.textContent = '';
        $ttsCancel.disabled = true;
        $ttsActivity.hidden = true;
        $ttsStatus.textContent = 'Auftrag nicht verfügbar oder keine Berechtigung.';
        return;
      }
      if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
      const s = await response.json();
      if (generation !== ttsPollGeneration) return;
      failures = 0;
      ttsActive = !s.done;
      updateTtsActions();
      document.getElementById('tts-article').textContent = s.title;
      const nextOutput = formatTtsOutput(s.output);
      if ($ttsOutput.textContent !== nextOutput) {
        const scrollTop = $ttsOutput.scrollTop;
        const atBottom = scrollTop + $ttsOutput.clientHeight >= $ttsOutput.scrollHeight - 24;
        $ttsOutput.textContent = nextOutput;
        $ttsOutput.scrollTop = atBottom ? $ttsOutput.scrollHeight : scrollTop;
      }
      const labels = { starting: 'Start wird vorbereitet …', running: 'Sprachgenerierung läuft …',
        cancelling: 'Abbruch angefordert …', indexing: 'MP3 fertig – Artikelindex wird aktualisiert …',
        succeeded: 'Fertig. Die MP3 wurde erzeugt.', failed: 'Sprachgenerierung fehlgeschlagen.', cancelled: 'Audio-Auftrag abgebrochen.' };
      $ttsStatus.textContent = s.indexError || s.error || ((labels[s.status] || s.status)
        + (!s.done && s.total ? ` · Chunk ${s.current || 0} von ${s.total}` : ''));
      $ttsCancel.disabled = s.done || ['cancelling', 'indexing'].includes(s.status);
      $ttsActivity.hidden = s.done;
      $ttsReindex.hidden = !s.indexError;
      if (s.done) {
        if (s.status === 'succeeded' && (s.audioUrl?.startsWith('/files/') || s.audioUrl?.startsWith('/audio-files/'))) {
          $ttsAudio.href = s.audioUrl;
          $ttsAudio.hidden = false;
          try { await refreshTtsArticle(s.articleId); }
          catch {
            if (generation === ttsPollGeneration) $ttsStatus.textContent += ' Die Artikelansicht konnte nicht aktualisiert werden. Bitte neu laden; die MP3 ist fertig.';
          }
        }
        return;
      }
    } catch {
      if (generation !== ttsPollGeneration) return;
      $ttsStatus.textContent = 'Verbindung unterbrochen; der Auftrag kann weiterlaufen. Status aktualisieren oder später wieder öffnen.';
      if (++failures >= 3) { $ttsActivity.hidden = true; return; }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
document.getElementById('tts-close')?.addEventListener('click', closeTtsModal);
document.getElementById('tts-backdrop')?.addEventListener('click', closeTtsModal);
document.getElementById('tts-refresh')?.addEventListener('click', showTtsJob);
$ttsReindex?.addEventListener('click', async () => {
  await runReindex();
  if (ttsJobId && $ttsOverlay.open) watchTts(ttsJobId);
});
$ttsCancel?.addEventListener('click', async () => {
  if (!ttsJobId || $ttsCancel.disabled) return;
  $ttsCancel.disabled = true;
  const generation = ttsPollGeneration;
  try {
    const response = await apiFetch(`/api/tts/${encodeURIComponent(ttsJobId)}/cancel`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || 'Abbruch konnte nicht angefordert werden.');
    if (generation === ttsPollGeneration) watchTts(ttsJobId);
  } catch (error) {
    if (generation !== ttsPollGeneration) return;
    $ttsStatus.textContent = error.message;
    $ttsCancel.disabled = false;
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-tts-action]');
  if (!button || button.disabled) return;
  if (button.dataset.ttsAction === 'start') runTts();
  else showTtsJob();
});

async function runReindex() {
  if (!confirm('Archiv neu indizieren?')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  try {
    const r = await apiFetch('/api/reindex', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      alert(data.error || 'Ein anderer Auftrag läuft bereits.');
      return;
    }
    await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/reindex/status');
          const status = await sr.json();
          if (status.processed) {
            $count.textContent = `${status.processed.toLocaleString('de-DE')} Artikel verarbeitet…`;
          }
          if (status.done) { clearInterval(poll); resolve(); }
        } catch { clearInterval(poll); resolve(); }
      }, 600);
    });
    await loadMeta();
    state.page = 1;
    await loadArticles();
  } finally {
    $reindexBtn.disabled = false;
    $reindexBtn.textContent = '↺';
  }
}

// Scrape-Fenster: Dialog am Ebenen-Stapel (Escape schließt, Fokus zurück zum Auslöser).
function openScrapeModal(title) {
  if (!$scrapeOverlay.open) WebArchivLayers.open($scrapeOverlay, { name: 'scrape', onEscape: closeScrapeModal });
  document.body.style.overflow = 'hidden';
  if ($scrapeTitle) $scrapeTitle.textContent = title || 'Scrapen';
  $scrapeOutput.textContent = '';
  $scrapeStatus.textContent = '';
}
function closeScrapeModal() {
  if ($scrapeOverlay.open) WebArchivLayers.close($scrapeOverlay);
  document.body.style.overflow = '';
}
$scrapeClose?.addEventListener('click', closeScrapeModal);
$scrapeBackdrop?.addEventListener('click', closeScrapeModal);

async function runScrape() {
  if (!confirm('Neue Beiträge scrapen (Blog, Facebook, Telegram)? Das kann einige Minuten dauern.')) return;
  $reindexBtn.disabled = true;
  $reindexBtn.textContent = '…';
  openScrapeModal('Scrapen');
  $scrapeStatus.textContent = 'Scrape läuft …';
  try {
    const r = await apiFetch('/api/scrape', { method: 'POST' });
    const data = await r.json();
    if (!data.started) {
      // Die Sperre meldet, was gerade läuft (Scrape, Reindex, Audio …).
      $scrapeStatus.textContent = data.error || 'Ein anderer Auftrag läuft bereits.';
      return;
    }
    // 1) Scrape-Lauf: Ausgabe live anzeigen, bis fertig.
    const result = await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/scrape/status');
          const s = await sr.json();
          if (typeof s.output === 'string') {
            $scrapeOutput.textContent = s.output;
            $scrapeOutput.scrollTop = $scrapeOutput.scrollHeight;
          }
          if (s.done) { clearInterval(poll); resolve(s); }
        } catch { clearInterval(poll); resolve(null); }
      }, 1000);
    });
    if (result && result.exitCode === -1) {
      $scrapeStatus.textContent = 'Fehler: Scraper konnte nicht gestartet werden — ' + (result.error || 'unbekannt');
      return;
    }
    // 2) Anschließender, serverseitig angestoßener Reindex.
    $scrapeStatus.textContent = `Scrape fertig (Exit ${result ? result.exitCode : '?'}) — Index wird aktualisiert …`;
    await new Promise(resolve => {
      const poll = setInterval(async () => {
        try {
          const sr = await apiFetch('/api/reindex/status');
          const st = await sr.json();
          if (st.processed) {
            $count.textContent = `${st.processed.toLocaleString('de-DE')} Artikel verarbeitet…`;
          }
          if (st.done) { clearInterval(poll); resolve(); }
        } catch { clearInterval(poll); resolve(); }
      }, 600);
    });
    await loadMeta();
    state.page = 1;
    await loadArticles();
    $scrapeStatus.textContent = 'Fertig. Der Index wurde aktualisiert.';
  } catch (e) {
    $scrapeStatus.textContent = 'Abgebrochen: ' + ((e && e.message) || e);
  } finally {
    $reindexBtn.disabled = false;
    $reindexBtn.textContent = '↺';
  }
}

async function showScrapeLog() {
  openScrapeModal('Scrape-Log (letzte 100 Zeilen)');
  $scrapeStatus.textContent = 'Lade …';
  try {
    const r = await apiFetch('/api/scrape/log');
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('application/json')) {
      // Kein JSON -> vermutlich läuft eine ältere Server-Version ohne diese Route.
      $scrapeOutput.textContent =
        `Log-Endpoint nicht verfügbar (HTTP ${r.status}).\n` +
        `Vermutlich läuft eine ältere Server-Version — bitte die aktuelle server.js ` +
        `deployen und den Dienst neu starten (sudo systemctl restart nodeapp).`;
      $scrapeStatus.textContent = 'Fehler';
    } else {
      const data = await r.json();
      $scrapeOutput.textContent = data.text || '(leer)';
      $scrapeStatus.textContent = 'scraper/scrape_all.log';
    }
  } catch (e) {
    $scrapeOutput.textContent = 'Konnte das Log nicht laden: ' + ((e && e.message) || e);
    $scrapeStatus.textContent = 'Fehler';
  }
  // Beim Öffnen ans untere Ende scrollen (neueste Zeilen), nach oben scrollbar.
  requestAnimationFrame(() => { $scrapeOutput.scrollTop = $scrapeOutput.scrollHeight; });
}

// ── Einhängen in app.js ─────────────────────────────────────────────────────
Object.assign(adminHooks, {
  articleChanged: updateTtsActions,
  userChanged: user => { if (user?.role !== 'admin') clearTtsUI(); },
  ttsBusy: () => ttsStarting || ttsActive,
  actions: {
    ...adminHooks.actions,
    reindex: runReindex,
    scrape: runScrape,
    log: showScrapeLog,
    tts: runTts,
    'tts-job': showTtsJob,
  },
});
updateTtsActions();
})();
