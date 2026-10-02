/* WebArchiv — Einstellungen (pro Gerät im Browser): Schriftart, Darstellung, Textgröße.
   Gäste bekommen immer die Vorgaben. Wird vor app.js geladen. */

const DISPLAY_DEFAULTS = { font: 'system', theme: 'auto', textSize: 'normal' };
const DISPLAY_OPTIONS = {
  font: ['editorial', 'classic', 'modern', 'system'],
  theme: ['light', 'dark', 'auto'],
  textSize: ['small', 'normal', 'large', 'xlarge'],
};
const DISPLAY_STORAGE_KEYS = { font: 'wa-font', theme: 'wa-theme', textSize: 'wa-text-size' };
const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

let displayGuest = false;
let displaySettings = readDisplaySettings();

function readDisplaySettings() {
  const settings = {};
  for (const [key, storageKey] of Object.entries(DISPLAY_STORAGE_KEYS)) {
    let value = null;
    try { value = localStorage.getItem(storageKey); } catch { /* Speicher gesperrt */ }
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
}

function setDisplayGuest(isGuest) {
  displayGuest = isGuest;
  applyDisplaySettings();
}

function setDisplaySetting(key, value) {
  if (!DISPLAY_OPTIONS[key]?.includes(value)) return;
  displaySettings[key] = value;
  try { localStorage.setItem(DISPLAY_STORAGE_KEYS[key], value); } catch { /* Speicher gesperrt */ }
  applyDisplaySettings();
}

darkSchemeQuery.addEventListener('change', applyDisplaySettings);
applyDisplaySettings();

// ── Dialog ─────────────────────────────────────────────────────────────────
const $settingsDialog = document.getElementById('settings-dialog');
const $settingsForm = document.getElementById('settings-form');

function openSettingsDialog() {
  for (const key of Object.keys(DISPLAY_OPTIONS)) {
    const input = $settingsForm.querySelector(`input[name="${key}"][value="${displaySettings[key]}"]`);
    if (input) input.checked = true;
  }
  $settingsDialog.showModal();
  $settingsForm.querySelector('input:checked')?.focus();
}

function closeSettingsDialog() {
  if ($settingsDialog.open) $settingsDialog.close();
  document.getElementById('reindex-btn').focus();
}

// Änderungen wirken sofort, ohne Speichern-Knopf.
$settingsForm.addEventListener('change', event => {
  const input = event.target;
  if (input.type === 'radio') setDisplaySetting(input.name, input.value);
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
