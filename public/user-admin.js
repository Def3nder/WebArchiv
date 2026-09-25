/* WebArchiv — Kennwort ändern und Benutzerverwaltung.
   Wird vor app.js geladen; Funktionen aus app.js (apiFetch, esc, applyUserUI …)
   werden erst beim Aufruf verwendet. */

const MIN_PASSWORD_LENGTH = 8;
const SVG_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const TELEGRAM_AUTHOR = 'Telegram';

async function accountRequest(url, options = {}) {
  const init = { cache: 'no-store', ...options };
  if (init.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...init.headers };
    init.body = JSON.stringify(init.body);
  }
  const response = await apiFetch(url, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Die Anfrage ist fehlgeschlagen.');
  return result;
}

function passwordLength(value) {
  return [...value].length;
}

// Gut lesbare Zeichen ohne Verwechslungsgefahr (kein 0/O, 1/l/I).
function generatePassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out = [];
  const bytes = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    if (bytes[0] < 256 - (256 % alphabet.length)) out.push(alphabet[bytes[0] % alphabet.length]);
  }
  return out.join('');
}

// ── Eigenes Kennwort ändern ────────────────────────────────────────────────
const $pwDialog = document.getElementById('password-dialog');
const $pwForm = document.getElementById('password-form');
const $pwCurrent = document.getElementById('password-current');
const $pwNew = document.getElementById('password-new');
const $pwRepeat = document.getElementById('password-repeat');
const $pwError = document.getElementById('password-error');
const $pwSubmit = document.getElementById('password-submit');
const pwState = { forced: false, resolve: null, promise: null, busy: false };

function openPasswordDialog({ forced }) {
  if ($pwDialog.open) return pwState.promise;
  pwState.forced = forced;
  $pwForm.reset();
  $pwError.hidden = true;
  document.getElementById('password-username').value = currentUser?.email || '';
  document.getElementById('password-title').textContent = forced ? 'Neues Kennwort festlegen' : 'Kennwort ändern';
  document.getElementById('password-intro').textContent = forced
    ? 'Bitte legen Sie vor dem Weiterarbeiten ein eigenes Kennwort fest. Als aktuelles Kennwort gilt das Kennwort, das Sie vom Administrator erhalten haben.'
    : `Angemeldet als ${currentUser?.email || ''}. Andere angemeldete Geräte werden nach der Änderung abgemeldet.`;
  document.getElementById('password-cancel').hidden = forced;
  document.getElementById('password-logout').hidden = !forced;
  pwState.promise = new Promise(resolve => { pwState.resolve = resolve; });
  $pwDialog.showModal();
  $pwCurrent.focus();
  return pwState.promise;
}

function finishPasswordDialog(changed) {
  if ($pwDialog.open) $pwDialog.close();
  pwState.resolve?.(changed);
  pwState.resolve = null;
  if (!changed || !pwState.forced) $reindexBtn.focus();
}

function showPasswordError(message, field) {
  $pwError.textContent = message;
  $pwError.hidden = false;
  field?.focus();
}

$pwForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (pwState.busy) return;
  const current = $pwCurrent.value;
  const next = $pwNew.value;
  if (!current) return showPasswordError('Bitte das aktuelle Kennwort eingeben.', $pwCurrent);
  if (passwordLength(next) < MIN_PASSWORD_LENGTH) return showPasswordError(`Das neue Kennwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`, $pwNew);
  if (next !== $pwRepeat.value) return showPasswordError('Die beiden neuen Kennwörter stimmen nicht überein.', $pwRepeat);
  if (next === current) return showPasswordError('Das neue Kennwort muss sich vom bisherigen unterscheiden.', $pwNew);
  pwState.busy = true;
  $pwSubmit.disabled = true;
  $pwError.hidden = true;
  try {
    await accountRequest('/api/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    const me = await accountRequest('/api/me');
    currentUser = me;
    applyUserUI(currentUser);
    finishPasswordDialog(true);
    if (!pwState.forced) showAccountNotice('Ihr Kennwort wurde geändert.');
  } catch (error) {
    if (error.message === 'Session expired') finishPasswordDialog(false);
    else showPasswordError(error.message, $pwCurrent);
  } finally {
    pwState.busy = false;
    $pwSubmit.disabled = false;
  }
});
document.getElementById('password-cancel').addEventListener('click', () => finishPasswordDialog(false));
document.getElementById('password-logout').addEventListener('click', () => finishPasswordDialog(false));
$pwDialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (!pwState.forced && !pwState.busy) finishPasswordDialog(false);
});

// Kurze Bestätigung unterhalb des Headers.
function showAccountNotice(message) {
  const notice = document.createElement('div');
  notice.className = 'account-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 3500);
}

// ── Benutzerverwaltung ─────────────────────────────────────────────────────
const $ua = document.getElementById('user-admin');
const $uaUsers = document.getElementById('user-admin-panel-users');
const $uaPublic = document.getElementById('user-admin-panel-public');
const $uaStatus = document.getElementById('user-admin-status');
const ua = { users: [], authors: [], publicAuthors: [], self: '', tab: 'users', view: 'list', target: null, dirty: false, busy: false };

function uaSetStatus(message, isError = false) {
  $uaStatus.textContent = message || '';
  $uaStatus.classList.toggle('is-error', !!isError);
}

function uaConfirmDiscard() {
  return !ua.dirty || confirm('Ungespeicherte Änderungen verwerfen?');
}

async function uaLoad() {
  const data = await accountRequest('/api/users');
  ua.users = data.users;
  ua.authors = data.authors;
  ua.publicAuthors = data.publicAuthors;
  ua.self = data.self;
}

async function openUserAdmin() {
  if (currentUser?.role !== 'admin') return;
  ua.tab = 'users';
  ua.view = 'list';
  ua.dirty = false;
  uaSetStatus('Nutzer werden geladen …');
  $uaUsers.innerHTML = '';
  $uaPublic.innerHTML = '';
  uaSelectTab('users');
  $ua.showModal();
  try {
    await uaLoad();
    uaSetStatus('');
    uaRender();
  } catch (error) {
    uaSetStatus(error.message, true);
  }
}

function closeUserAdmin() {
  if (ua.busy || !uaConfirmDiscard()) return;
  ua.dirty = false;
  $ua.close();
  $reindexBtn.focus();
}

function uaSelectTab(tab) {
  ua.tab = tab;
  for (const name of ['users', 'public']) {
    const selected = name === tab;
    document.getElementById(`user-admin-tab-${name}`).setAttribute('aria-selected', String(selected));
    document.getElementById(`user-admin-panel-${name}`).hidden = !selected;
  }
}

function uaRender() {
  if (ua.tab === 'public') return uaRenderPublic();
  if (ua.view === 'form') return uaRenderForm();
  if (ua.view === 'password') return uaRenderPasswordReset();
  return uaRenderList();
}

function sameEmailClient(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function uaAuthorSummary(user) {
  if (user.allowedAuthors === null) return 'Alle Autoren';
  // Öffentliche Autoren sieht jeder Nutzer ohnehin; auch wenn sie zusätzlich in
  // users.json stehen, zählen sie nur zum öffentlichen Teil.
  const own = user.allowedAuthors.filter(a => !ua.publicAuthors.includes(a));
  const shared = ua.publicAuthors.length;
  const text = own.length ? `${own.length === 1 ? '1 Autor' : `${own.length} Autoren`}: ${own.join(', ')}` : 'Keine eigenen Autoren';
  return shared ? `${text} · zusätzlich ${shared} öffentlich` : text;
}

function uaRenderList() {
  const items = [...ua.users].sort((a, b) => a.email.localeCompare(b.email, 'de')).map(user => {
    const isSelf = sameEmailClient(user.email, ua.self);
    return `<li class="ua-user">
      <div class="ua-user-main">
        <div class="ua-user-name">
          <strong>${esc(user.email)}</strong>
          <span class="ua-badge${user.role === 'admin' ? ' is-admin' : ''}">${user.role === 'admin' ? 'Admin' : 'User'}</span>
          ${isSelf ? '<span class="ua-badge is-self">Sie</span>' : ''}
          ${user.mustChangePassword ? '<span class="ua-badge is-warn">Kennwortänderung ausstehend</span>' : ''}
          ${user.hasPassword ? '' : '<span class="ua-badge is-warn">Kein Kennwort</span>'}
        </div>
        <p class="ua-user-authors">${esc(uaAuthorSummary(user))}</p>
      </div>
      <div class="ua-user-actions">
        <button type="button" class="detail-cat-pill" data-ua="edit" data-email="${esc(user.email)}">Bearbeiten</button>
        <button type="button" class="detail-cat-pill" data-ua="password" data-email="${esc(user.email)}">Kennwort neu vergeben</button>
        <button type="button" class="detail-cat-pill ua-danger ua-icon-btn" data-ua="delete" data-email="${esc(user.email)}"
          ${isSelf ? 'disabled title="Der eigene Zugang kann nicht gelöscht werden." aria-label="Löschen nicht möglich"'
            : 'title="Benutzer löschen" aria-label="Benutzer löschen"'}>${SVG_TRASH}</button>
      </div>
    </li>`;
  }).join('');
  $uaUsers.innerHTML = `
    <div class="ua-toolbar">
      <p class="ua-count">${ua.users.length === 1 ? '1 Nutzer' : `${ua.users.length} Nutzer`}</p>
      <button type="button" class="detail-cat-pill account-primary" data-ua="new">Neuer Nutzer</button>
    </div>
    <ul class="ua-user-list">${items || '<li class="ua-empty">Noch keine Nutzer angelegt.</li>'}</ul>`;
}

// Autorenauswahl: Schalter „alle/ausgewählte“ plus durchsuchbare Checkliste.
function uaAuthorPickerHtml({ id, selected, lockPublic, allowAll }) {
  const all = allowAll && selected === null;
  const chosen = new Set(selected || []);
  const names = [...new Set([...ua.authors, ...chosen])].sort((a, b) => a.localeCompare(b, 'de'));
  const rows = names.map(name => {
    const locked = lockPublic && ua.publicAuthors.includes(name);
    const tags = [];
    if (!ua.authors.includes(name)) tags.push('<span class="ua-tag is-warn">nicht mehr vorhanden</span>');
    if (locked) tags.push('<span class="ua-tag">durch öffentlichen Zugang</span>');
    else if (ua.publicAuthors.includes(name)) tags.push('<span class="ua-tag">öffentlich</span>');
    if (name === TELEGRAM_AUTHOR) tags.push('<span class="ua-tag">standardmäßig ausgeblendet</span>');
    return `<li data-name="${esc(name.toLowerCase())}">
      <label class="ua-author${locked ? ' is-locked' : ''}">
        <input type="checkbox" value="${esc(name)}" ${chosen.has(name) || locked ? 'checked' : ''} ${locked ? 'disabled data-locked' : ''} />
        <span class="ua-author-name">${esc(name)}</span>${tags.join('')}
      </label>
    </li>`;
  }).join('');
  return `
    <div class="ua-picker" id="${id}">
      ${allowAll ? `<div class="ua-radio-row" role="radiogroup" aria-label="Zugelassene Autoren">
        <label class="ua-radio"><input type="radio" name="${id}-mode" value="all" ${all ? 'checked' : ''} /> Alle Autoren<span class="ua-radio-hint">, auch künftige</span></label>
        <label class="ua-radio"><input type="radio" name="${id}-mode" value="some" ${all ? '' : 'checked'} /> Nur ausgewählte Autoren</label>
      </div>` : ''}
      <div class="ua-picker-body" ${all ? 'hidden' : ''}>
        <div class="ua-picker-tools">
          <input type="search" class="login-input ua-picker-search" placeholder="Autor suchen …" aria-label="Autor suchen" />
          <button type="button" class="detail-cat-pill" data-picker="all">Alle</button>
          <button type="button" class="detail-cat-pill" data-picker="none">Keine</button>
        </div>
        <ul class="ua-author-list">${rows || '<li class="ua-empty">Keine Autoren im Archiv gefunden.</li>'}</ul>
        <p class="ua-picker-count" aria-live="polite"></p>
      </div>
    </div>`;
}

function uaPickerUpdate(picker) {
  const boxes = [...picker.querySelectorAll('.ua-author-list input:not([data-locked])')];
  const locked = picker.querySelectorAll('.ua-author-list input[data-locked]').length;
  const count = boxes.filter(box => box.checked).length;
  picker.querySelector('.ua-picker-count').textContent =
    `${count} von ${boxes.length} ausgewählt${locked ? ` · ${locked} öffentlich immer sichtbar` : ''}`;
  const mode = picker.querySelector('input[type=radio]:checked');
  picker.querySelector('.ua-picker-body').hidden = mode?.value === 'all';
}

function uaPickerValue(picker) {
  const mode = picker.querySelector('input[type=radio]:checked');
  if (mode?.value === 'all') return null;
  // Öffentliche (gesperrte) Autoren werden nicht gespeichert; der Server entfernt sie ebenfalls.
  return [...picker.querySelectorAll('.ua-author-list input:not([data-locked])')]
    .filter(box => box.checked)
    .map(box => box.value);
}

function uaPasswordFieldsHtml() {
  return `
    <div class="login-field">
      <label for="ua-password" class="login-label">Kennwort</label>
      <div class="ua-password-row">
        <input id="ua-password" type="password" class="login-input" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required />
        <button type="button" class="detail-cat-pill" data-ua="pw-toggle">Anzeigen</button>
        <button type="button" class="detail-cat-pill" data-ua="pw-generate">Erzeugen</button>
        <button type="button" class="detail-cat-pill" data-ua="pw-copy">Kopieren</button>
      </div>
      <p class="account-hint">Mindestens ${MIN_PASSWORD_LENGTH} Zeichen. Teilen Sie das Kennwort dem Nutzer auf sicherem Weg mit.</p>
    </div>
    <fieldset class="ua-fieldset">
      <legend>Bei der nächsten Anmeldung</legend>
      <label class="ua-radio"><input type="radio" name="ua-must" value="yes" checked /> Nutzer muss das Kennwort ändern</label>
      <label class="ua-radio"><input type="radio" name="ua-must" value="no" /> Nutzer behält dieses Kennwort</label>
    </fieldset>`;
}

function uaFormButtons(saveLabel) {
  return `<div class="ua-form-footer">
      <p id="ua-form-error" class="login-error" role="alert" hidden></p>
      <div class="account-buttons">
        <button type="button" class="detail-cat-pill" data-ua="back">Abbrechen</button>
        <button type="submit" class="detail-cat-pill account-primary">${saveLabel}</button>
      </div>
    </div>`;
}

function uaRenderForm() {
  const user = ua.target ? ua.users.find(u => sameEmailClient(u.email, ua.target)) : null;
  const isSelf = user && sameEmailClient(user.email, ua.self);
  const role = user?.role || 'user';
  $uaUsers.innerHTML = `
    <form class="ua-form" id="ua-form" novalidate>
      <h3 class="ua-form-title${user ? ' ua-mobile-hidden' : ''}">${user ? `Nutzer bearbeiten` : 'Neuer Nutzer'}</h3>
      <div class="login-field">
        <label for="ua-email" class="login-label">E-Mail (Benutzername)</label>
        <input id="ua-email" type="email" class="login-input" autocomplete="off" value="${esc(user?.email || '')}"
          ${user ? 'readonly' : 'required'} />
      </div>
      <fieldset class="ua-fieldset ua-fieldset-inline">
        <legend>Rolle</legend>
        <label class="ua-radio"><input type="radio" name="ua-role" value="user" ${role === 'user' ? 'checked' : ''} ${isSelf ? 'disabled' : ''} /> User<span class="ua-radio-hint"> – liest die zugelassenen Autoren</span></label>
        <label class="ua-radio"><input type="radio" name="ua-role" value="admin" ${role === 'admin' ? 'checked' : ''} ${isSelf ? 'disabled' : ''} /> Admin<span class="ua-radio-hint"> – zusätzlich Verwaltung, Scrapen, Audio, Editor</span></label>
        ${isSelf ? '<p class="account-hint">Die eigene Rolle kann nicht geändert werden.</p>' : ''}
      </fieldset>
      <div class="ua-fieldset ua-fieldset-authors" role="group" aria-labelledby="ua-authors-legend">
        <p class="ua-legend" id="ua-authors-legend">Zugelassene Autoren</p>
        ${uaAuthorPickerHtml({ id: 'ua-form-picker', selected: user ? user.allowedAuthors : [], lockPublic: true, allowAll: true })}
      </div>
      ${user ? '' : uaPasswordFieldsHtml()}
      ${uaFormButtons(user ? 'Änderungen speichern' : 'Nutzer anlegen')}
    </form>`;
  uaPickerUpdate(document.getElementById('ua-form-picker'));
  (user ? document.querySelector('#ua-form input[type=radio]:not([disabled])') : document.getElementById('ua-email'))?.focus();
}

function uaRenderPasswordReset() {
  $uaUsers.innerHTML = `
    <form class="ua-form" id="ua-password-form" novalidate>
      <h3 class="ua-form-title">Kennwort neu vergeben</h3>
      <p class="account-hint">Für <strong>${esc(ua.target)}</strong>. Bestehende Anmeldungen dieses Nutzers werden beendet.</p>
      ${uaPasswordFieldsHtml()}
      ${uaFormButtons('Kennwort speichern')}
    </form>`;
  document.getElementById('ua-password').focus();
}

function uaRenderPublic() {
  $uaPublic.innerHTML = `
    <form class="ua-form" id="ua-public-form" novalidate>
      <p class="account-hint">Diese Autoren sieht jeder <strong>ohne Anmeldung</strong>. Angemeldete Nutzer sehen sie zusätzlich zu ihren eigenen Autoren.</p>
      ${uaAuthorPickerHtml({ id: 'ua-public-picker', selected: ua.publicAuthors, lockPublic: false, allowAll: false })}
      <p id="ua-public-warning" class="ua-warning" hidden>Kein öffentlicher Zugang: Das Archiv ist dann nur mit Anmeldung nutzbar.</p>
      <div class="ua-form-footer">
        <p id="ua-form-error" class="login-error" role="alert" hidden></p>
        <div class="account-buttons">
          <button type="submit" class="detail-cat-pill account-primary">Öffentlichen Zugang speichern</button>
        </div>
      </div>
    </form>`;
  uaPublicUpdate();
}

function uaPublicUpdate() {
  const picker = document.getElementById('ua-public-picker');
  if (!picker) return;
  uaPickerUpdate(picker);
  document.getElementById('ua-public-warning').hidden = uaPickerValue(picker).length > 0;
}

function uaFormError(message) {
  const el = document.getElementById('ua-form-error');
  el.textContent = message;
  el.hidden = !message;
}

function uaMustChange() {
  return document.querySelector('input[name="ua-must"]:checked')?.value === 'yes';
}

function uaCheckPassword() {
  const value = document.getElementById('ua-password').value;
  if (passwordLength(value) < MIN_PASSWORD_LENGTH) {
    uaFormError(`Das Kennwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    document.getElementById('ua-password').focus();
    return null;
  }
  return value;
}

async function uaSubmit(task, successMessage) {
  if (ua.busy) return;
  ua.busy = true;
  $ua.querySelectorAll('form button').forEach(b => { b.disabled = true; });
  uaFormError('');
  try {
    await task();
    ua.dirty = false;
    ua.view = 'list';
    await uaLoad();
    uaRender();
    uaSetStatus(successMessage);
  } catch (error) {
    uaFormError(error.message);
  } finally {
    ua.busy = false;
    $ua.querySelectorAll('form button').forEach(b => { b.disabled = false; });
  }
}

const emailPath = email => `/api/users/${encodeURIComponent(email)}`;

$ua.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'ua-form') {
    const existing = ua.target;
    const allowedAuthors = uaPickerValue(document.getElementById('ua-form-picker'));
    const role = form.querySelector('input[name="ua-role"]:checked')?.value;
    if (existing) {
      const body = { allowedAuthors };
      if (!sameEmailClient(existing, ua.self)) body.role = role;
      return uaSubmit(() => accountRequest(emailPath(existing), { method: 'PATCH', body }), `Änderungen für ${existing} gespeichert.`);
    }
    const email = document.getElementById('ua-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      uaFormError('Bitte eine gültige E-Mail-Adresse angeben.');
      return document.getElementById('ua-email').focus();
    }
    const password = uaCheckPassword();
    if (password === null) return;
    return uaSubmit(() => accountRequest('/api/users', { method: 'POST',
      body: { email, role, allowedAuthors, password, mustChangePassword: uaMustChange() } }), `Nutzer ${email} angelegt.`);
  }
  if (form.id === 'ua-password-form') {
    const password = uaCheckPassword();
    if (password === null) return;
    const target = ua.target;
    return uaSubmit(() => accountRequest(`${emailPath(target)}/password`, { method: 'POST',
      body: { password, mustChangePassword: uaMustChange() } }), `Neues Kennwort für ${target} gespeichert.`);
  }
  if (form.id === 'ua-public-form') {
    const authors = uaPickerValue(document.getElementById('ua-public-picker'));
    return uaSubmit(async () => {
      await accountRequest('/api/public-authors', { method: 'PUT', body: { authors } });
      ua.tab = 'public';
      // Eigene Sicht (Autorenfilter, Liste) auf den neuen Stand bringen.
      loadMeta().then(() => loadArticles()).catch(() => {});
    }, 'Öffentlicher Zugang gespeichert.');
  }
});

$ua.addEventListener('click', async event => {
  const pickerButton = event.target.closest('[data-picker]');
  if (pickerButton) {
    const picker = pickerButton.closest('.ua-picker');
    const on = pickerButton.dataset.picker === 'all';
    picker.querySelectorAll('.ua-author-list li:not([hidden]) input:not([data-locked])').forEach(box => { box.checked = on; });
    ua.dirty = true;
    uaPickerUpdate(picker);
    if (picker.id === 'ua-public-picker') uaPublicUpdate();
    return;
  }
  const button = event.target.closest('[data-ua]');
  if (!button || button.disabled) return;
  const action = button.dataset.ua;
  const email = button.dataset.email;
  const pw = document.getElementById('ua-password');
  if (action === 'new' || action === 'edit' || action === 'password') {
    ua.view = action === 'password' ? 'password' : 'form';
    ua.target = action === 'new' ? null : email;
    ua.dirty = false;
    uaSetStatus('');
    uaRender();
  } else if (action === 'back') {
    if (!uaConfirmDiscard()) return;
    ua.dirty = false;
    ua.view = 'list';
    uaRender();
  } else if (action === 'delete') {
    if (!confirm(`Nutzer ${email} wirklich löschen? Das kann nicht rückgängig gemacht werden.`)) return;
    uaSetStatus('');
    try {
      await accountRequest(emailPath(email), { method: 'DELETE' });
      await uaLoad();
      uaRender();
      uaSetStatus(`Nutzer ${email} gelöscht.`);
    } catch (error) {
      uaSetStatus(error.message, true);
    }
  } else if (action === 'pw-toggle') {
    pw.type = pw.type === 'password' ? 'text' : 'password';
    button.textContent = pw.type === 'password' ? 'Anzeigen' : 'Verbergen';
  } else if (action === 'pw-generate') {
    pw.value = generatePassword();
    pw.type = 'text';
    $ua.querySelector('[data-ua="pw-toggle"]').textContent = 'Verbergen';
    ua.dirty = true;
  } else if (action === 'pw-copy') {
    if (!pw.value) return;
    try {
      await navigator.clipboard.writeText(pw.value);
      button.textContent = 'Kopiert';
    } catch {
      pw.type = 'text';
      pw.select();
      button.textContent = 'Strg+C';
    }
    setTimeout(() => { button.textContent = 'Kopieren'; }, 1500);
  }
});

$ua.addEventListener('input', event => {
  const picker = event.target.closest('.ua-picker');
  if (event.target.classList.contains('ua-picker-search')) {
    const query = event.target.value.trim().toLowerCase();
    picker.querySelectorAll('.ua-author-list li[data-name]').forEach(li => { li.hidden = !li.dataset.name.includes(query); });
    return;
  }
  ua.dirty = true;
  if (picker) {
    uaPickerUpdate(picker);
    if (picker.id === 'ua-public-picker') uaPublicUpdate();
  }
});

for (const tab of ['users', 'public']) {
  document.getElementById(`user-admin-tab-${tab}`).addEventListener('click', () => {
    if (ua.tab === tab || ua.busy || !uaConfirmDiscard()) return;
    ua.dirty = false;
    ua.view = 'list';
    uaSetStatus('');
    uaSelectTab(tab);
    uaRender();
  });
}
document.getElementById('user-admin-close').addEventListener('click', closeUserAdmin);
$ua.addEventListener('cancel', event => { event.preventDefault(); closeUserAdmin(); });

// Tastatur in den Dialogen nicht an die Artikelnavigation weiterreichen.
document.addEventListener('keydown', event => {
  if ($ua.open || $pwDialog.open) event.stopImmediatePropagation();
}, true);
window.addEventListener('beforeunload', event => {
  if ($ua.open && ua.dirty) { event.preventDefault(); event.returnValue = ''; }
});
