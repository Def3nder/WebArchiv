/* WebArchiv — Scraper-Zentrale (nur Admin-Shell: data-admin-asset, server.js ADMIN_ASSET_PATHS).
 * Dialog mit allen Scraper-Quellen aus /api/scraper/sources: letzter Lauf, Ergebnis, neue Artikel (verlinkt),
 * Fehler und notwendige Aktionen; Quellen hinzufügen, bearbeiten, pausieren, entfernen und einzeln scrapen.
 * Läufe und Log zeigt das bestehende Scrape-Fenster aus admin-tasks.js (adminHooks.actions scrape, scrape-source, log).
 * Nutzt apiFetch, esc und adminHooks aus app.js. */
(() => {
const TYPE_LABELS = { blog: 'Blog', facebook: 'Facebook', telegram: 'Telegram' };
const LEVEL_LABELS = { ok: 'Alles in Ordnung', info: 'Hinweise', warning: 'Warnung', error: 'Fehler' };
const TRIGGER_LABELS = { web: 'Web', cron: 'Cron', manual: 'von Hand' };

const $dialog = document.getElementById('scraper-center');
const $content = document.getElementById('scraper-content');
const $level = document.getElementById('scraper-level');
const $refresh = document.getElementById('scraper-refresh');
const $close = document.getElementById('scraper-close');
const $runAll = document.getElementById('scraper-run-all');
const $log = document.getElementById('scraper-log');
const $add = document.getElementById('scraper-add');
const $form = document.getElementById('scraper-form');
const $formTitle = document.getElementById('scraper-form-title');
const $formError = document.getElementById('scraper-form-error');
const $formCancel = document.getElementById('scraper-form-cancel');
const field = id => document.getElementById(`scraper-form-${id}`);

let sources = [];
let editing = null;
let loading = false;

// ── Zahlen und Zeiten ────────────────────────────────────────────────────────
function when(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  if (!ms) return '–';
  const date = new Date(ms);
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `heute ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `gestern ${time}`;
  return `${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${time}`;
}
const duration = ms => (typeof ms === 'number' ? `${Math.max(1, Math.round(ms / 1000)).toLocaleString('de-DE')} s` : '');
// Nur https-Adressen werden zum Link; alles andere bleibt Text.
const sourceLink = url => (/^https:\/\//i.test(url)
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https:\/\/(www\.)?/i, ''))}</a>`
  : esc(url));

// ── Darstellung ──────────────────────────────────────────────────────────────
function resultText(last) {
  if (!last) return 'noch kein Lauf';
  if (last.running) return 'läuft gerade …';
  if (last.status === 'failed') return 'abgebrochen';
  return `${(last.saved || 0).toLocaleString('de-DE')} neu · ${(last.skipped || 0).toLocaleString('de-DE')} bereits vorhanden`;
}

function renderSource(source, index) {
  const last = source.last;
  const lastText = last
    ? [when(last.finishedAt || last.startedAt), duration(last.durationMs), TRIGGER_LABELS[last.trigger] || ''].filter(Boolean).join(' · ')
    : '–';
  const actions = source.actions.length
    ? `<ul class="scraper-actions">${source.actions.map(action => `<li class="scraper-action scraper-action-${esc(action.level)}">${esc(action.text)}</li>`).join('')}</ul>`
    : '';
  const articles = last?.newArticles || [];
  const listId = `scraper-new-${index}`;
  const newList = articles.length
    ? `<button type="button" class="scraper-new-toggle" data-scraper="toggle" aria-expanded="false" aria-controls="${listId}">
         ${articles.length === 1 ? '1 neuer Artikel' : `${articles.length} neue Artikel`} im letzten Lauf</button>
       <ul id="${listId}" class="scraper-new-list" hidden>${articles.map(article => (article.exists
    ? `<li><a href="#/article/${encodeURIComponent(article.id)}" data-scraper-article>${esc(article.title || article.id)}</a></li>`
    : `<li class="scraper-new-missing">${esc(article.id)} <span>(nicht mehr im Index)</span></li>`)).join('')}</ul>`
    : '';
  return `<article class="scraper-source scraper-source-${esc(source.level)}${source.active ? '' : ' is-paused'}" data-name="${esc(source.name)}">
    <header class="scraper-source-head">
      <span class="scraper-dot scraper-dot-${esc(source.level)}" aria-hidden="true"></span>
      <span class="scraper-type">${esc(TYPE_LABELS[source.type] || source.type)}</span>
      <h3>${esc(source.name)}</h3>
      ${source.active ? '' : '<span class="scraper-paused">pausiert</span>'}
    </header>
    <p class="scraper-url">${sourceLink(source.url)}</p>
    <dl class="scraper-facts">
      <div><dt>Letzter Lauf</dt><dd>${esc(lastText)}</dd></div>
      <div><dt>Ergebnis</dt><dd class="${last?.status === 'failed' ? 'scraper-failed' : ''}">${esc(resultText(last))}</dd></div>
      <div><dt>Neu in 30 Tagen</dt><dd>${(source.newLast30Days || 0).toLocaleString('de-DE')}</dd></div>
    </dl>
    ${actions}
    ${newList}
    <div class="scraper-buttons">
      <button type="button" class="detail-cat-pill" data-scraper="run">Jetzt scrapen</button>
      <button type="button" class="detail-cat-pill" data-scraper="edit">Bearbeiten</button>
      <button type="button" class="detail-cat-pill" data-scraper="${source.active ? 'pause' : 'resume'}">${source.active ? 'Pausieren' : 'Fortsetzen'}</button>
      <button type="button" class="detail-cat-pill scraper-remove" data-scraper="remove">Entfernen</button>
    </div>
  </article>`;
}

function render(data) {
  sources = data.sources || [];
  $level.hidden = false;
  $level.className = `scraper-pill scraper-pill-${data.level}`;
  $level.textContent = LEVEL_LABELS[data.level] || data.level;
  const cron = data.cron || {};
  const cookies = data.cookies || {};
  const status = [
    `<span class="scraper-status-item scraper-status-${esc(cron.level)}">Cron: ${cron.lastRunAt ? `${esc(when(cron.lastRunAt))} · Exit ${esc(cron.exitCode)}` : 'kein Lauf gefunden'}${cron.text ? ` – ${esc(cron.text)}` : ''}</span>`,
    `<span class="scraper-status-item">Facebook-Anmeldung: ${cookies.exists ? (cookies.sessionExpiresAt ? `gültig bis ${esc(new Date(cookies.sessionExpiresAt).toLocaleDateString('de-DE'))}` : 'unvollständig') : 'cookies.txt fehlt'}</span>`,
  ];
  if (data.usesExample) status.push('<span class="scraper-status-item">Quellen aus der Vorlage (scraper-config.json entsteht beim ersten Speichern)</span>');
  $content.innerHTML = `<p class="scraper-status">${status.join('')}</p>${sources.length
    ? sources.map(renderSource).join('')
    : '<p class="account-hint">Noch keine Quellen. „Quelle hinzufügen“ legt die erste an.</p>'}`;
}

async function load() {
  if (loading) return;
  loading = true;
  $refresh.disabled = true;
  if (!$content.childElementCount) $content.innerHTML = '<p class="account-hint">Wird geladen …</p>';
  try {
    const r = await apiFetch('/api/scraper/sources');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Die Scraper-Zentrale konnte nicht geladen werden.');
    render(data);
  } catch (error) {
    $content.innerHTML = `<p class="login-error">${esc(error.message)}</p>`;
  } finally {
    loading = false;
    $refresh.disabled = false;
  }
}

async function send(method, url, body) {
  const r = await apiFetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Die Änderung ist fehlgeschlagen.');
  return data;
}
const sourceUrl = name => `/api/scraper/sources/${encodeURIComponent(name)}`;

// ── Formular ─────────────────────────────────────────────────────────────────
function showForm(source = null) {
  editing = source;
  $formTitle.textContent = source ? `Quelle „${source.name}“ bearbeiten` : 'Quelle hinzufügen';
  field('type').value = source?.type || 'facebook';
  field('name').value = source?.name || '';
  field('url').value = source?.url || '';
  field('file-author').value = source?.fileAuthor || '';
  field('exclude').value = source?.exclude || '';
  field('signature-name').value = source?.signature?.name || '';
  field('signature-website').value = source?.signature?.website || '';
  // Name ist zugleich der Ordner, der Typ bestimmt den Scraper: beim Bearbeiten fest.
  field('type').disabled = !!source;
  field('name').disabled = !!source;
  $formError.hidden = true;
  $form.hidden = false;
  $content.hidden = true;
  (source ? field('url') : field('name')).focus();
}

function hideForm() {
  editing = null;
  $form.hidden = true;
  $content.hidden = false;
}

$form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = {
    type: field('type').value,
    name: field('name').value,
    url: field('url').value,
    fileAuthor: field('file-author').value,
    exclude: field('exclude').value,
    signatureName: field('signature-name').value,
    signatureWebsite: field('signature-website').value,
  };
  try {
    if (editing) await send('PUT', sourceUrl(editing.name), body);
    else await send('POST', '/api/scraper/sources', body);
    hideForm();
    await load();
  } catch (error) {
    $formError.textContent = error.message;
    $formError.hidden = false;
  }
});
$formCancel.addEventListener('click', hideForm);

// ── Aktionen je Quelle ───────────────────────────────────────────────────────
async function sourceAction(action, source, button) {
  if (action === 'run') {
    await adminHooks.actions['scrape-source']?.(source.name);
    return load();
  }
  if (action === 'edit') return showForm(source);
  if (action === 'remove' && !confirm(`Quelle „${source.name}“ entfernen? Die bereits gescrapten Artikel bleiben im Archiv.`)) return;
  button.disabled = true;
  try {
    if (action === 'pause' || action === 'resume') await send('PUT', `${sourceUrl(source.name)}/active`, { active: action === 'resume' });
    if (action === 'remove') await send('DELETE', sourceUrl(source.name));
    await load();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
}

$content.addEventListener('click', event => {
  const link = event.target.closest('[data-scraper-article]');
  if (link) {
    // Erst die Zentrale schließen, dann den Artikel öffnen (er liegt sonst unter dem Dialog).
    event.preventDefault();
    closeScraperCenter();
    location.hash = link.getAttribute('href');
    return;
  }
  const button = event.target.closest('[data-scraper]');
  if (!button) return;
  if (button.dataset.scraper === 'toggle') {
    const list = document.getElementById(button.getAttribute('aria-controls'));
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    return;
  }
  const name = button.closest('[data-name]')?.dataset.name;
  const source = sources.find(item => item.name === name);
  if (source) sourceAction(button.dataset.scraper, source, button);
});

// ── Dialog ───────────────────────────────────────────────────────────────────
function openScraperCenter() {
  if (!$dialog.open) {
    hideForm();
    $content.scrollTop = 0;
    WebArchivLayers.open($dialog, { name: 'scraper-center', onEscape: () => (editing !== null || !$form.hidden ? hideForm() : closeScraperCenter()) });
  }
  $dialog.focus({ preventScroll: true });
  load();
}

function closeScraperCenter() {
  if ($dialog.open) WebArchivLayers.close($dialog);
}

$refresh.addEventListener('click', load);
$close.addEventListener('click', closeScraperCenter);
$runAll.addEventListener('click', async () => {
  await adminHooks.actions.scrape?.();
  load();
});
$log.addEventListener('click', () => adminHooks.actions.log?.());
$add.addEventListener('click', () => showForm());
// Klick auf den abgedunkelten Hintergrund (außerhalb des Dialogrechtecks) schließt, wie bei den anderen Dialogen.
$dialog.addEventListener('click', event => {
  if (event.target !== $dialog) return;
  const rect = $dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeScraperCenter();
});

Object.assign(adminHooks, {
  actions: { ...adminHooks.actions, 'scraper-center': openScraperCenter },
});
})();
