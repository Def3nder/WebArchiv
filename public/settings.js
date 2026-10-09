/* WebArchiv — Anzeige-Einstellungen im Browser.
   Gäste bekommen immer die Vorgaben. Wird vor app.js geladen. */

const DISPLAY_DEFAULTS = {
  font: 'system', theme: 'light', textSize: 'normal', filterLabels: 'auto',
  cardCategories: 'visible', resetFilters: 'visible',
};
const DISPLAY_OPTIONS = {
  font: ['editorial', 'classic', 'modern', 'system'],
  theme: ['light', 'dark', 'auto'],
  textSize: ['small', 'normal', 'large', 'xlarge'],
  filterLabels: ['auto', 'hidden'],
  cardCategories: ['visible', 'hidden'],
  resetFilters: ['visible', 'hidden'],
};
const DISPLAY_STORAGE_KEYS = {
  font: 'wa-font',
  theme: 'wa-theme',
  textSize: 'wa-text-size',
  filterLabels: 'wa-filter-labels',
  cardCategories: 'wa-card-categories',
  resetFilters: 'wa-reset-filters',
};
const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

let displayGuest = false;
let displayUserKey = '';
let displaySettings = readDisplaySettings();

function displayStorageKey(key) {
  const base = DISPLAY_STORAGE_KEYS[key];
  // Nur die Filter-Einstellung ist zusätzlich nach Nutzer getrennt. Da
  // localStorage gerätegebunden ist, ergibt sich Nutzer + Gerät ohne Serverdaten.
  return key === 'filterLabels' && displayUserKey ? `${base}:${displayUserKey}` : base;
}

function readDisplaySettings() {
  const settings = {};
  for (const key of Object.keys(DISPLAY_STORAGE_KEYS)) {
    let value = null;
    try { value = localStorage.getItem(displayStorageKey(key)); } catch { /* Speicher gesperrt */ }
    settings[key] = DISPLAY_OPTIONS[key].includes(value) ? value : DISPLAY_DEFAULTS[key];
  }
  return settings;
}

// „Automatisch“ folgt der Systemeinstellung und wechselt live mit.
function applyDisplaySettings() {
  const settings = displayGuest ? DISPLAY_DEFAULTS : displaySettings;
  document.body.dataset.font = settings.font;
  document.body.dataset.theme = settings.theme === 'auto'
    ? (darkSchemeQuery.matches ? 'dark' : 'light')
    : settings.theme;
  document.body.dataset.textSize = settings.textSize;
  document.body.dataset.filterLabels = settings.filterLabels;
  document.body.dataset.cardCategories = settings.cardCategories;
  document.body.dataset.resetFilters = settings.resetFilters;
  if (typeof updateFilterLabelLayout === 'function') requestAnimationFrame(updateFilterLabelLayout);
}

function setDisplayUser(user) {
  displayGuest = !user || user.role === 'guest';
  const nextUserKey = displayGuest
    ? ''
    : encodeURIComponent(String(user.email || 'user').trim().toLowerCase());
  if (nextUserKey !== displayUserKey) {
    displayUserKey = nextUserKey;
    displaySettings = readDisplaySettings();
  }
  applyDisplaySettings();
}

function setDisplaySetting(key, value) {
  if (!DISPLAY_OPTIONS[key]?.includes(value)) return;
  displaySettings[key] = value;
  try { localStorage.setItem(displayStorageKey(key), value); } catch { /* Speicher gesperrt */ }
  applyDisplaySettings();
}

darkSchemeQuery.addEventListener('change', applyDisplaySettings);
applyDisplaySettings();

// ── Dialog ─────────────────────────────────────────────────────────────────
const $settingsDialog = document.getElementById('settings-dialog');
const $settingsForm = document.getElementById('settings-form');

function openSettingsDialog() {
  for (const key of Object.keys(DISPLAY_OPTIONS)) {
    const control = $settingsForm.elements?.namedItem(key)
      || $settingsForm.querySelector(`[name="${key}"]`);
    if (control) control.value = displaySettings[key];
  }
  $settingsDialog.showModal();
  // Den Dialog selbst fokussieren. Insbesondere mobile Browser öffnen sonst
  // beim showModal()-Autofokus sofort das erste Auswahlfeld.
  $settingsDialog.focus({ preventScroll: true });
}

function closeSettingsDialog() {
  if ($settingsDialog.open) $settingsDialog.close();
  document.getElementById('reindex-btn').focus();
}

// Änderungen wirken sofort, ohne Speichern-Knopf.
$settingsForm.addEventListener('change', event => {
  const control = event.target;
  if (control.matches?.('select[name]')) setDisplaySetting(control.name, control.value);
});
$settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  closeSettingsDialog();
});
$settingsDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeSettingsDialog();
});
// Klick auf den abgedunkelten Hintergrund schließt den Dialog.
$settingsDialog.addEventListener('click', event => {
  if (event.target !== $settingsDialog) return;
  const rect = $settingsDialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) closeSettingsDialog();
});
