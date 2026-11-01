/* WebArchiv — Health-Check (nur Admin-Shell: data-admin-asset, server.js ADMIN_ASSET_PATHS).
 * - Schwebender Hinweis oben rechts, sobald neue Fehler vorliegen (/api/health/events).
 *   Warnungen lösen keinen Hinweis aus; sie zeigt nur der Dialog. „Gelesen bis“ merkt sich
 *   das Gerät (localStorage wa-health-seen).
 * - Dialog „Health-Check“ (Menü „Aktionen“ oder „Details“ im Hinweis): Gesamtampel, Index,
 *   Speicher, Dienste, Server und Meldungen aus /api/health/details.
 * Nutzt apiFetch, currentUser, esc und deviceStorage aus app.js; Anbindung über adminHooks. */
(() => {
const POLL_MS = 60 * 1000;
const SEEN_KEY = 'wa-health-seen';
const LEVEL_LABELS = { ok: 'Alles in Ordnung', warning: 'Warnung', error: 'Fehler' };
const SOURCE_LABELS = { server: 'Server', scraper: 'Scraper', cron: 'Cron' };

const $notice = document.getElementById('health-notice');
const $noticeTitle = document.getElementById('health-notice-title');
const $noticeText = document.getElementById('health-notice-text');
const $noticeDetails = document.getElementById('health-notice-details');
const $noticeDismiss = document.getElementById('health-notice-dismiss');
const $menuCount = document.getElementById('health-menu-count');
const $dialog = document.getElementById('health-dialog');
const $content = document.getElementById('health-content');
const $level = document.getElementById('health-level');
const $checked = document.getElementById('health-checked');
const $refresh = document.getElementById('health-refresh');
const $close = document.getElementById('health-close');

let latestSummary = null;
let pollTimer = null;
let loading = false;

// Der Hinweis bleibt auch über offenen Ansichten (Artikel, Dialoge) bedienbar.
WebArchivLayers.float($notice);

function seenId() {
  try { return Number.parseInt(deviceStorage()?.getItem(SEEN_KEY), 10); } catch { return Number.NaN; }
}
function rememberSeen(id) {
  try { deviceStorage()?.setItem(SEEN_KEY, String(id)); } catch { /* Speicher gesperrt */ }
}

// ── Zahlen, Größen, Zeiten ───────────────────────────────────────────────────
const number = value => Number(value || 0).toLocaleString('de-DE');
function gigabytes(bytes) {
  return (bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}
function seconds(ms) {
  return (ms / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' s';
}
function clock(ms) {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `heute ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `gestern ${time}`;
  if (today - date < 6 * 24 * 3600 * 1000) return `${date.toLocaleDateString('de-DE', { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${time}`;
}
function uptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days) return `${days} ${days === 1 ? 'Tag' : 'Tage'} ${hours} Std.`;
  if (hours) return `${hours} Std. ${minutes} Min.`;
  return `${minutes} Min.`;
}

// ── Hinweis oben rechts ──────────────────────────────────────────────────────
function updateMenuCount(count) {
  $menuCount.hidden = !count;
  $menuCount.textContent = count ? String(count) : '';
}

// Unter die Kopfzeile (sticky, z-index 100, je nach Breite ein- oder zweizeilig, blendet beim
// Scrollen aus) statt darüber: sonst verdeckt der Hinweis ihre Menüs.
const $chrome = document.getElementById('navigation-chrome');
function placeNotice() {
  const bottom = Math.max(0, $chrome?.getBoundingClientRect().bottom || 0);
  $notice.style.setProperty('--health-notice-top', `${Math.round(bottom) + 12}px`);
}
// app.js verschiebt die Kopfzeile in seinem eigenen Scroll-Handler: erst im nächsten Frame messen.
let placeFrame = 0;
function schedulePlaceNotice() {
  if (!placeFrame) placeFrame = requestAnimationFrame(() => { placeFrame = 0; placeNotice(); });
}
function trackChrome(on) {
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('scroll', schedulePlaceNotice, { passive: true });
  window[method]('resize', schedulePlaceNotice);
  $chrome?.[method]('transitionend', schedulePlaceNotice);
}

function showNotice(summary) {
  const count = summary.newErrors;
  $noticeTitle.textContent = count === 1 ? '1 neuer Fehler' : `${number(count)} neue Fehler`;
  $noticeText.textContent = summary.latest ? `${summary.latest.message} · ${clock(summary.latest.lastAt)}` : '';
  placeNotice();
  if ($notice.hidden) trackChrome(true);
  $notice.hidden = false;
}

function hideNotice({ markSeen = false } = {}) {
  if (!$notice.hidden) trackChrome(false);
  $notice.hidden = true;
  if (markSeen && latestSummary) {
    rememberSeen(latestSummary.lastId);
    updateMenuCount(0);
  }
}

async function poll() {
  if (currentUser?.role !== 'admin' || document.visibilityState !== 'visible') return;
  let seen = seenId();
  try {
    const r = await apiFetch(`/api/health/events?after=${Number.isFinite(seen) ? seen : 0}`);
    if (!r.ok) return;
    const summary = await r.json();
    // Erstes Mal auf diesem Gerät: Bisheriges gilt als gelesen, sonst meldete sich gleich alte Historie.
    if (!Number.isFinite(seen)) {
      rememberSeen(summary.lastId);
      return;
    }
    // Liste geleert oder Server-Datei neu: Zähler beginnt von vorn.
    if (summary.lastId < seen) {
      rememberSeen(summary.lastId);
      seen = summary.lastId;
    }
    latestSummary = summary;
    updateMenuCount(summary.newErrors);
    if (summary.newErrors > 0 && !$dialog.open) showNotice(summary);
    else if (!summary.newErrors) hideNotice();
  } catch { /* nächster Versuch beim nächsten Intervall */ }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (currentUser?.role !== 'admin') {
    hideNotice();
    updateMenuCount(0);
    return;
  }
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

$noticeDismiss.addEventListener('click', () => hideNotice({ markSeen: true }));
$noticeDetails.addEventListener('click', () => openHealthDialog());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });

// ── Dialog ───────────────────────────────────────────────────────────────────
const dot = level => `<span class="health-dot health-dot-${esc(level)}" aria-hidden="true"></span>`;
const row = (label, value, level = null) =>
  `<div class="health-row"><span>${esc(label)}</span><span${level && level !== 'ok' ? ` class="health-${esc(level)}"` : ''}>${value}</span></div>`;
const section = (title, level, body, extraClass = '') =>
  `<section class="health-section ${extraClass}"><h3>${dot(level)}${esc(title)} <span class="health-sr-only">(${esc(LEVEL_LABELS[level] || level)})</span></h3>${body}</section>`;

function renderIndex(index) {
  const run = index.lastRun;
  const watcher = index.watcher;
  const watcherText = !watcher.enabled ? 'abgeschaltet'
    : watcher.active ? `aktiv · ${number(watcher.directories)} Ordner` : 'nicht aktiv';
  const issues = index.scanIssues.length
    ? `<ul class="health-issues">${index.scanIssues.map(issue => `<li>${esc(issue.path)} (${esc(issue.reason)})</li>`).join('')}</ul>` : '';
  return section('Index', index.level, [
    row('Bestand', `${number(index.articles)} Artikel · ${number(index.audiobooks)} Hörbücher`),
    row('Dubletten', `${number(index.duplicates.linked)} verknüpft · ${number(index.duplicates.open)} offen`),
    row('Letzter Vollindex', run
      ? `${esc(clock(run.at))} · ${esc(seconds(run.durationMs))} · Cache ${number(run.cacheHits)}/${number(run.cacheMisses)}`
      : (index.running ? 'läuft gerade' : 'noch keiner'), run ? null : 'warning'),
    index.error ? row('Fehler', esc(index.error), 'error') : '',
    row('Datei-Watcher', esc(watcherText), watcher.enabled && !watcher.active ? 'warning' : null),
    row('Laufender Auftrag', esc(index.busy || '–')),
    row('Nicht lesbar', index.scanIssues.length ? `${number(index.scanIssues.length)} ${index.scanIssues.length === 1 ? 'Datei' : 'Dateien'}` : 'keine',
      index.scanIssues.length ? 'warning' : null),
    issues,
  ].join(''));
}

function renderDisks(disks) {
  const level = disks.reduce((worst, disk) => (disk.level === 'error' || worst === 'error' ? 'error'
    : disk.level === 'warning' || worst === 'warning' ? 'warning' : 'ok'), 'ok');
  const body = disks.map(disk => {
    if (disk.total === null) return row(disk.name, `nicht lesbar (${esc(disk.error)})`, 'warning');
    const used = Math.min(100, Math.max(0, Math.round((1 - disk.free / disk.total) * 100)));
    return row(disk.name, `${gigabytes(disk.free)} von ${gigabytes(disk.total)} GB frei`, disk.level)
      + `<div class="health-bar" role="img" aria-label="${used} % belegt"><i class="health-bar-${esc(disk.level)}" style="width:${used}%"></i></div>`;
  }).join('');
  return section('Speicher', level, body + '<p class="health-hint">Warnung unter 10 GB, Fehler unter 2 GB frei</p>');
}

function renderServices(services) {
  const { qwen, scrape } = services;
  const web = scrape.web
    ? (scrape.web.running ? 'läuft gerade' : `${esc(clock(scrape.web.startedAt))} · ${scrape.web.error ? esc(scrape.web.error) : `Exit ${esc(scrape.web.exitCode)}`}`)
    : 'seit dem Start keiner';
  const webFailed = scrape.web && !scrape.web.running && (scrape.web.error || (scrape.web.exitCode !== null && scrape.web.exitCode !== 0));
  const cron = scrape.cron ? `${esc(clock(scrape.cron.at))} · Exit ${esc(scrape.cron.exitCode)}` : 'kein Eintrag';
  return section('Dienste', [qwen.level, scrape.level].includes('error') ? 'error' : [qwen.level, scrape.level].includes('warning') ? 'warning' : 'ok', [
    row('Qwen-TTS', qwen.reachable ? 'erreichbar' : 'nicht erreichbar', qwen.reachable ? null : 'warning'),
    row('Scrape (Web-UI)', web, webFailed ? 'error' : null),
    row('Scrape (Cron)', cron, scrape.cron && scrape.cron.exitCode !== 0 ? 'error' : null),
  ].join(''));
}

function renderServer(server) {
  return section('Server', server.level, [
    row('Laufzeit', esc(uptime(server.uptimeSeconds))),
    row('Node.js', esc(server.node)),
    row('Arbeitsspeicher', `${number(Math.round(server.rss / 1024 ** 2))} MB`),
    row('CSP', esc(server.cspMode)),
  ].join(''));
}

function renderEvents(events) {
  const entries = events.entries.map((entry, index) => {
    const id = `health-event-${index}`;
    const count = entry.count > 1 ? ` <span class="health-count">· ${number(entry.count)} ×</span>` : '';
    const head = `${dot(entry.level)}<span class="health-event-text"><span class="health-chip">${esc(SOURCE_LABELS[entry.source] || entry.source)}</span>${esc(entry.message)}${count}</span><span class="health-time">${esc(clock(entry.lastAt))}</span>`;
    return entry.detail
      ? `<button type="button" class="health-event" aria-expanded="false" aria-controls="${id}">${head}</button><pre class="health-detail" id="${id}" hidden>${esc(entry.detail)}</pre>`
      : `<div class="health-event">${head}</div>`;
  }).join('');
  const body = entries || '<p class="health-hint">Keine Meldungen.</p>';
  const clear = events.entries.length ? '<div class="health-actions"><button type="button" class="detail-cat-pill" data-health-clear>Liste leeren</button></div>' : '';
  return section('Meldungen', events.level, `<p class="health-hint">Neueste zuerst; ein Klick zeigt Details.</p>${body}${clear}`, 'health-section-wide');
}

function render(details) {
  $level.hidden = false;
  $level.className = `health-pill health-pill-${details.level}`;
  $level.textContent = LEVEL_LABELS[details.level] || details.level;
  $checked.textContent = `geprüft ${clock(details.checkedAt)}`;
  $content.innerHTML = `<div class="health-grid">${renderIndex(details.index)}${renderDisks(details.disks)}${renderServices(details.services)}${renderServer(details.server)}</div>${renderEvents(details.events)}`;
}

async function loadDetails() {
  if (loading) return;
  loading = true;
  $refresh.disabled = true;
  if (!$content.childElementCount) $content.innerHTML = '<p class="health-hint">Wird geprüft …</p>';
  try {
    const r = await apiFetch('/api/health/details');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Der Health-Check ist fehlgeschlagen.');
    render(data);
    // Wer den Dialog gesehen hat, hat die Fehler bis hierher gelesen.
    rememberSeen(data.events.lastId);
    latestSummary = { ...(latestSummary || {}), lastId: data.events.lastId, newErrors: 0 };
    updateMenuCount(0);
    hideNotice();
  } catch (error) {
    $content.innerHTML = `<p class="health-hint health-error">${esc(error.message)}</p>`;
  } finally {
    loading = false;
    $refresh.disabled = false;
  }
}

function openHealthDialog() {
  hideNotice();
  if (!$dialog.open) {
    $content.scrollTop = 0;
    WebArchivLayers.open($dialog, { name: 'health', onEscape: closeHealthDialog });
  }
  $dialog.focus({ preventScroll: true });
  loadDetails();
}

function closeHealthDialog() {
  if ($dialog.open) WebArchivLayers.close($dialog);
}

$refresh.addEventListener('click', loadDetails);
$close.addEventListener('click', closeHealthDialog);
// Klick auf den abgedunkelten Hintergrund (außerhalb des Dialogrechtecks) schließt, wie bei den anderen Dialogen.
$dialog.addEventListener('click', event => {
  if (event.target !== $dialog) return;
  const rect = $dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeHealthDialog();
});
$content.addEventListener('click', async event => {
  const toggle = event.target.closest('.health-event[aria-controls]');
  if (toggle) {
    const detail = document.getElementById(toggle.getAttribute('aria-controls'));
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    return;
  }
  if (event.target.closest('[data-health-clear]')) {
    if (!confirm('Alle Meldungen aus der Liste entfernen?')) return;
    const r = await apiFetch('/api/health/events/clear', { method: 'POST' });
    if (r.ok) loadDetails();
  }
});

// ── Einhängen in app.js ──────────────────────────────────────────────────────
const previousUserChanged = adminHooks.userChanged;
Object.assign(adminHooks, {
  userChanged: user => { previousUserChanged(user); startPolling(); },
  actions: { ...adminHooks.actions, health: openHealthDialog },
});
startPolling();
})();
