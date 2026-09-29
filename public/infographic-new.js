// Neue eigenständige Infografik (Admin, Aktionen-Menü): Markdown-Vorlage und Grafik
// werden in einem Schritt gespeichert (keine .md ohne Bild), danach wird die neue
// Infografik geöffnet. Den Dateinamen bildet der Server aus Datum + Titel-Slug.
const $infoNew = document.getElementById('infographic-new');
const $infoNewText = document.getElementById('infographic-new-text');
const $infoNewFilename = document.getElementById('infographic-new-filename');
const $infoNewFile = document.getElementById('infographic-new-file');
const $infoNewPreview = document.getElementById('infographic-new-preview');
const $infoNewImageName = document.getElementById('infographic-new-image-name');
const $infoNewStatus = document.getElementById('infographic-new-status');
const $infoNewSave = document.getElementById('infographic-new-save');
const INFO_NEW_IMAGE_HINT = 'PNG oder JPG, höchstens 10 MB';
const infoNewState = { template: '', file: null, previewUrl: null, saving: false };

function infoNewToday() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Wie slugify() in server.js – hier nur für die Vorschau des Dateinamens.
function infoNewSlug(title) {
  return String(title || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/, '');
}
function infoNewTarget() {
  const text = $infoNewText.value;
  const title = (text.split(/\r?\n/).find(line => line.trim()) || '')
    .replace(/^#+\s*/, '').replace(/[*_]/g, '').trim();
  const date = (text.match(/^[ \t*_]*datum:[ \t*_]*(\d{4}-\d{2}-\d{2})\b/im) || [])[1] || '';
  const slug = /\[titel\]/i.test(title) ? '' : infoNewSlug(title);
  return { slug, date };
}
function updateInfoNew() {
  const { slug, date } = infoNewTarget();
  $infoNewFilename.textContent = slug && date
    ? `Datei: Infografiken/${date.slice(0, 4)}/${date}_${slug}.md (bei gleichem Namen mit -2, -3 …)`
    : 'Datei: bitte Titel in der ersten Zeile und ein Datum (JJJJ-MM-TT) eintragen.';
  $infoNewSave.disabled = infoNewState.saving || !slug || !date || !infoNewState.file;
}
function setInfoNewFile(file) {
  if (infoNewState.previewUrl) URL.revokeObjectURL(infoNewState.previewUrl);
  infoNewState.file = file;
  infoNewState.previewUrl = file ? URL.createObjectURL(file) : null;
  $infoNewPreview.hidden = !file;
  if (file) $infoNewPreview.src = infoNewState.previewUrl;
  else $infoNewPreview.removeAttribute('src');
  const size = file && (file.size < 1024 * 1024
    ? `${Math.max(1, Math.round(file.size / 1024))} KB`
    : `${(file.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`);
  $infoNewImageName.textContent = file ? `${file.name} (${size})` : INFO_NEW_IMAGE_HINT;
  updateInfoNew();
}
// Häkchen für die Filter-Kategorien (aus dem Kategorie-Filter übernommen).
const $infoNewCategories = document.getElementById('infographic-new-categories');
function renderInfoNewCategories() {
  const labels = [...$filterCategory.options].map(option => option.value).filter(Boolean);
  $infoNewCategories.innerHTML = labels.map(label =>
    `<label class="infographic-new-category"><input type="checkbox" value="${esc(label)}" /> ${esc(label)}</label>`
  ).join('');
}
function infoNewCheckedCategories() {
  return [...$infoNewCategories.querySelectorAll('input:checked')].map(input => input.value);
}
function infoNewDirty() {
  return $infoNewText.value !== infoNewState.template || !!infoNewState.file || infoNewCheckedCategories().length > 0;
}

function openNewInfographic() {
  if (currentUser?.role !== 'admin') return;
  infoNewState.template = `# [Titel]\n\nDatum: ${infoNewToday()}\n\n----\n\n[Inhalt]\n`;
  $infoNewText.value = infoNewState.template;
  renderInfoNewCategories();
  $infoNewStatus.textContent = '';
  setInfoNewFile(null);
  $infoNew.showModal();
  // „[Titel]“ gleich markieren, damit man lostippen kann.
  $infoNewText.focus();
  $infoNewText.setSelectionRange(2, 9);
}
function leaveNewInfographic() {
  if (!$infoNew.open) return true;
  if (infoNewState.saving) return false;
  if (infoNewDirty() && !confirm('Eingaben verwerfen?')) return false;
  $infoNew.close();
  setInfoNewFile(null);
  return true;
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Die Grafik konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

async function saveNewInfographic() {
  if ($infoNewSave.disabled) return;
  infoNewState.saving = true;
  $infoNewText.readOnly = true;
  $infoNew.querySelectorAll('button').forEach(button => { button.disabled = true; });
  $infoNewStatus.textContent = 'Infografik wird gespeichert und das Archiv aktualisiert …';
  let created = null;
  try {
    const image = await readFileBase64(infoNewState.file);
    const response = await fetch('/api/new-infographic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: $infoNewText.value, image, categories: infoNewCheckedCategories() }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* keine JSON-Antwort */ }
    if (!response.ok) throw new Error(data.error || 'Die Infografik konnte nicht gespeichert werden.');
    created = data.id;
  } catch (error) {
    $infoNewStatus.textContent = error.message + ' Ihre Eingaben bleiben erhalten.';
  } finally {
    infoNewState.saving = false;
    $infoNewText.readOnly = false;
    $infoNew.querySelectorAll('button').forEach(button => { button.disabled = false; });
    updateInfoNew();
  }
  if (!created) return;
  infoNewState.template = $infoNewText.value;
  $infoNewCategories.innerHTML = '';
  setInfoNewFile(null);
  $infoNew.close();
  await loadMeta();
  await loadArticles();
  openArticle(created);
}

$infoNewText.addEventListener('input', updateInfoNew);
document.getElementById('infographic-new-pick').addEventListener('click', () => {
  $infoNewFile.value = '';
  $infoNewFile.click();
});
$infoNewFile.addEventListener('change', () => {
  const file = $infoNewFile.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  const isImage = ['image/png', 'image/jpeg'].includes(file.type) || /\.(png|jpe?g)$/.test(name);
  if (!isImage) { $infoNewStatus.textContent = 'Bitte eine PNG- oder JPG-Datei auswählen.'; return; }
  if (file.size > INFOGRAPHIC_MAX_BYTES) { $infoNewStatus.textContent = 'Die Bilddatei ist größer als 10 MB.'; return; }
  $infoNewStatus.textContent = '';
  setInfoNewFile(file);
});
$infoNewSave.addEventListener('click', saveNewInfographic);
for (const id of ['infographic-new-close', 'infographic-new-cancel']) {
  document.getElementById(id).addEventListener('click', leaveNewInfographic);
}
$infoNew.addEventListener('cancel', event => { event.preventDefault(); leaveNewInfographic(); });
// Tasten gehören dem Dialog (keine Artikel-Navigation, kein Schließen darunter).
document.addEventListener('keydown', event => {
  if (!$infoNew.open) return;
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { event.preventDefault(); leaveNewInfographic(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); saveNewInfographic(); }
}, true);
window.addEventListener('beforeunload', event => {
  if ($infoNew.open && (infoNewDirty() || infoNewState.saving)) { event.preventDefault(); event.returnValue = ''; }
});
