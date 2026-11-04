/* WebArchiv — Neuer Artikel (nur Admin-Shell: data-admin-asset, server.js ADMIN_ASSET_PATHS).
 * Ein Dialog für zwei Typen, oben umschaltbar (das Gerät merkt sich den letzten):
 * - Infografik: Markdown + Grafik (Pflicht) → POST /api/new-infographic, Datei Infografiken/<Jahr>/<Datum>_<slug>.md
 * - Artikel:    Markdown + Bild (optional) → POST /api/new-article, Datei Ralf/<Jahr>/<Datum>_<lesbarer Titel>.md
 * Den Dateinamen bildet der Server; hier steht nur die Vorschau. Nach dem Speichern öffnet sich der neue Eintrag.
 * Nutzt apiFetch, esc, currentUser, $filterCategory, loadMeta, loadArticles, openArticle und adminHooks aus app.js. */
(() => {
const TYPE_STORAGE_KEY = 'wa-new-article-type';
const TYPES = {
  infographic: {
    url: '/api/new-infographic',
    folder: 'Infografiken',
    stem: title => slug(title),
    imageRequired: true,
    textLabel: 'Markdown: Titel, Datum und optional eigener Text',
    pick: 'Grafik auswählen',
    hint: 'PNG oder JPG, höchstens 10 MB',
    saving: 'Infografik wird gespeichert und das Archiv aktualisiert …',
    failed: 'Die Infografik konnte nicht gespeichert werden.',
  },
  article: {
    url: '/api/new-article',
    folder: 'Ralf',
    stem: title => readableStem(title),
    imageRequired: false,
    textLabel: 'Markdown: Titel, Datum und Text',
    pick: 'Bild auswählen',
    hint: 'Optional: PNG oder JPG, höchstens 10 MB (sonst das Standardbild)',
    saving: 'Artikel wird gespeichert und das Archiv aktualisiert …',
    failed: 'Der Artikel konnte nicht gespeichert werden.',
  },
};

const $dialog = document.getElementById('article-new');
const $text = document.getElementById('article-new-text');
const $textLabel = document.getElementById('article-new-text-label');
const $filename = document.getElementById('article-new-filename');
const $file = document.getElementById('article-new-file');
const $pick = document.getElementById('article-new-pick');
const $unpick = document.getElementById('article-new-unpick');
const $preview = document.getElementById('article-new-preview');
const $imageName = document.getElementById('article-new-image-name');
const $status = document.getElementById('article-new-status');
const $save = document.getElementById('article-new-save');
const $categories = document.getElementById('article-new-categories');
const $typeInputs = [...document.querySelectorAll('input[name="article-new-type"]')];
const state = { template: '', file: null, previewUrl: null, saving: false };

function today() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Wie slugify() in lib/infographics.cjs – hier nur für die Vorschau des Dateinamens.
function slug(title) {
  return String(title || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}
// Wie readableFileStem() in lib/new-article.cjs (test/new-article.test.cjs vergleicht beide).
function readableStem(title) {
  let stem = String(title || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/:/g, ' - ')
    .replace(/[\\/|]/g, '-')
    .replace(/[*?"<>#%]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*-\s*){2,}/g, ' - ')
    .trim();
  if (stem.length > 100) stem = stem.slice(0, 100).replace(/\s+\S*$/, '') || stem.slice(0, 100);
  return stem.replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');
}

function currentType() {
  return $typeInputs.find(input => input.checked)?.value === 'article' ? 'article' : 'infographic';
}
function storedType() {
  try { return localStorage.getItem(TYPE_STORAGE_KEY) === 'article' ? 'article' : 'infographic'; } catch { return 'infographic'; }
}
function setType(type) {
  for (const input of $typeInputs) input.checked = input.value === type;
  applyType();
}
function applyType() {
  const type = TYPES[currentType()];
  $textLabel.textContent = type.textLabel;
  $pick.textContent = type.pick;
  if (!state.file) $imageName.textContent = type.hint;
  update();
}

function target() {
  const text = $text.value;
  const title = (text.split(/\r?\n/).find(line => line.trim()) || '')
    .replace(/^#+\s*/, '').replace(/[*_]/g, '').trim();
  const date = (text.match(/^[ \t*_]*datum:[ \t*_]*(\d{4}-\d{2}-\d{2})\b/im) || [])[1] || '';
  const stem = /\[titel\]/i.test(title) ? '' : TYPES[currentType()].stem(title);
  return { stem, date };
}
function update() {
  const type = TYPES[currentType()];
  const { stem, date } = target();
  $filename.textContent = stem && date
    ? `Datei: ${type.folder}/${date.slice(0, 4)}/${date}_${stem}.md (bei gleichem Namen mit -2, -3 …)`
    : 'Datei: bitte Titel in der ersten Zeile und ein Datum (JJJJ-MM-TT) eintragen.';
  $save.disabled = state.saving || !stem || !date || (type.imageRequired && !state.file);
}
function setFile(file) {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.file = file;
  state.previewUrl = file ? URL.createObjectURL(file) : null;
  $preview.hidden = !file;
  $unpick.hidden = !file;
  if (file) $preview.src = state.previewUrl;
  else $preview.removeAttribute('src');
  const size = file && (file.size < 1024 * 1024
    ? `${Math.max(1, Math.round(file.size / 1024))} KB`
    : `${(file.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`);
  $imageName.textContent = file ? `${file.name} (${size})` : TYPES[currentType()].hint;
  update();
}
// Häkchen für die Filter-Kategorien (aus dem Kategorie-Filter übernommen).
function renderCategories() {
  const labels = [...$filterCategory.options].map(option => option.value).filter(Boolean);
  $categories.innerHTML = labels.map(label =>
    `<label class="article-new-category"><input type="checkbox" value="${esc(label)}" /> ${esc(label)}</label>`
  ).join('');
}
function checkedCategories() {
  return [...$categories.querySelectorAll('input:checked')].map(input => input.value);
}
function dirty() {
  return $text.value !== state.template || !!state.file || checkedCategories().length > 0;
}

function openNewArticle() {
  if (currentUser?.role !== 'admin') return;
  state.template = `# [Titel]\n\nDatum: ${today()}\n\n----\n\n[Inhalt]\n`;
  $text.value = state.template;
  renderCategories();
  $status.textContent = '';
  setType(storedType());
  setFile(null);
  // Ebenen-Stapel: Escape fragt bei Eingaben nach (leaveNewArticle).
  WebArchivLayers.open($dialog, { name: 'article-new', onEscape: leaveNewArticle });
  // „[Titel]“ gleich markieren, damit man lostippen kann.
  $text.focus();
  $text.setSelectionRange(2, 9);
}
function leaveNewArticle() {
  if (!$dialog.open) return true;
  if (state.saving) return false;
  if (dirty() && !confirm('Eingaben verwerfen?')) return false;
  $dialog.close();
  setFile(null);
  return true;
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

async function saveNewArticle() {
  if ($save.disabled) return;
  const type = TYPES[currentType()];
  state.saving = true;
  $text.readOnly = true;
  const controls = [...$dialog.querySelectorAll('button, input[name="article-new-type"]')];
  controls.forEach(control => { control.disabled = true; });
  $status.textContent = type.saving;
  let created = null;
  try {
    const body = { markdown: $text.value, categories: checkedCategories() };
    if (state.file) body.image = await readFileBase64(state.file);
    const response = await apiFetch(type.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch { /* keine JSON-Antwort */ }
    if (!response.ok) throw new Error(data.error || type.failed);
    created = data.id;
  } catch (error) {
    $status.textContent = error.message + ' Ihre Eingaben bleiben erhalten.';
  } finally {
    state.saving = false;
    $text.readOnly = false;
    controls.forEach(control => { control.disabled = false; });
    update();
  }
  if (!created) return;
  state.template = $text.value;
  $categories.innerHTML = '';
  setFile(null);
  $dialog.close();
  await loadMeta();
  await loadArticles();
  openArticle(created);
}

$text.addEventListener('input', update);
for (const input of $typeInputs) {
  input.addEventListener('change', () => {
    try { localStorage.setItem(TYPE_STORAGE_KEY, currentType()); } catch { /* Speicher gesperrt */ }
    applyType();
  });
}
$pick.addEventListener('click', () => {
  $file.value = '';
  $file.click();
});
$unpick.addEventListener('click', () => {
  $status.textContent = '';
  setFile(null);
});
$file.addEventListener('change', () => {
  const file = $file.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  const isImage = ['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/.test(name);
  if (!isImage) { $status.textContent = 'Bitte eine PNG- oder JPG-Datei auswählen.'; return; }
  if (file.size > INFOGRAPHIC_MAX_BYTES) { $status.textContent = 'Die Bilddatei ist größer als 10 MB.'; return; }
  $status.textContent = '';
  setFile(file);
});
$save.addEventListener('click', saveNewArticle);
for (const id of ['article-new-close', 'article-new-cancel']) {
  document.getElementById(id).addEventListener('click', leaveNewArticle);
}
// Klick auf den abgedunkelten Hintergrund (außerhalb des Dialogrechtecks) schließt, wie bei den anderen Dialogen;
// bei Eingaben wird vorher gefragt.
$dialog.addEventListener('click', event => {
  if (event.target !== $dialog) return;
  const rect = $dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) leaveNewArticle();
});
// Strg/Cmd+Enter speichert; Escape und übrige Tasten regelt der Ebenen-Stapel.
$dialog.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
  event.preventDefault();
  saveNewArticle();
});
window.addEventListener('beforeunload', event => {
  if ($dialog.open && (dirty() || state.saving)) { event.preventDefault(); event.returnValue = ''; }
});

Object.assign(adminHooks, {
  actions: { ...adminHooks.actions, 'new-article': openNewArticle },
});
})();
