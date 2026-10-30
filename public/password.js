/* WebArchiv — eigenes Kennwort ändern.
   Die Benutzerverwaltung wird ausschließlich in der Admin-Shell geladen. */

const MIN_PASSWORD_LENGTH = 8;

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
  // Ebenen-Stapel: Escape schließt nur ohne Pflichtwechsel und ohne laufende Anfrage.
  WebArchivLayers.open($pwDialog, {
    name: 'password', returnFocus: false,
    onEscape: () => { if (!pwState.forced && !pwState.busy) finishPasswordDialog(false); },
  });
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
    finishPasswordDialog(true);
    // Ein Admin mit erzwungenem Kennwortwechsel hat bis hierhin bewusst nur die
    // normale Shell erhalten. Erst die neue Anfrage rendert die Admin-Oberfläche.
    if (me.role === 'admin') {
      location.reload();
      return;
    }
    applyUserUI(currentUser);
    if (!pwState.forced) showAccountNotice('Ihr Kennwort wurde geändert.');
  } catch (error) {
    if (error.code === 'session_expired') finishPasswordDialog(false);
    else showPasswordError(error.message, $pwCurrent);
  } finally {
    pwState.busy = false;
    $pwSubmit.disabled = false;
  }
});
document.getElementById('password-cancel').addEventListener('click', () => finishPasswordDialog(false));
document.getElementById('password-logout').addEventListener('click', () => finishPasswordDialog(false));

function showAccountNotice(message) {
  const notice = document.createElement('div');
  notice.className = 'account-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 3500);
}
