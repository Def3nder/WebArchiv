#!/usr/bin/env node
// Einmalige Umstellung: Artikel-Anhänge heißen <Stamm>_1, _2, ...;
// eigenständige Infografiken behalten <Stamm> als Artikel samt Hauptbild.
// Ohne --apply werden ausschließlich die geplanten Änderungen angezeigt.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArticle, linkInfographics, infographicAttachmentStem,
  retitleInfographicMarkdown, moveInfographicFiles } = require('../server.js');

const DEFAULT_WWW = path.join(__dirname, '..', 'www');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const SECTIONS = new Set(['all', '1', '1.1', '1.2', '1.3', '2', '3']);

function selectedForMigration(member, anchor, section) {
  if (section === '2' || section === '3') return false; // Nur Anzeige, keine Umbenennung.
  if (section === '1.3') return anchor.author === 'Infografiken';
  if (section === '1.1') return anchor.author !== 'Infografiken' && !member.hasBody;
  if (section === '1.2') return anchor.author !== 'Infografiken' && member.hasBody;
  return true;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// _1 wurde erst durch diese Migration eingeführt. Auch eine einzelne Datei ist
// deshalb ein Marker; der Papierkorb gehört ausdrücklich nicht zum aktiven Archiv.
async function collectMigrationMarkers(infographicRoot) {
  const markers = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'trash') await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const match = /^(.*)_1\.(?:md|png|jpe?g)$/i.exec(entry.name);
      if (!match) continue;
      const stem = match[1].toLowerCase();
      if (!markers.has(stem)) {
        markers.set(stem, path.relative(infographicRoot, path.join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  }
  await walk(infographicRoot);
  return markers;
}

async function collectArticles(wwwRoot, audioRoot = path.join(path.dirname(wwwRoot), 'audio')) {
  const articles = [];
  const audioFilesByDir = new Map();
  async function hasExternalAudio(dir, stem) {
    if (!audioFilesByDir.has(dir)) {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      audioFilesByDir.set(dir, new Set(entries.filter(entry => entry.isFile() || entry.isSymbolicLink())
        .map(entry => entry.name.toLowerCase())));
    }
    return audioFilesByDir.get(dir).has((stem + '.mp3').toLowerCase());
  }
  async function walk(dir, author, year) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const fileNames = new Set(entries.filter(entry => entry.isFile() || entry.isSymbolicLink())
      .map(entry => entry.name.toLowerCase()));
    const imageStems = new Set(entries.filter(entry => entry.isFile()
      && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map(entry => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (author === 'Infografiken' && entry.name === 'trash') continue;
        await walk(file, author, /^\d{4}$/.test(entry.name) ? entry.name : year);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stem = entry.name.slice(0, -3);
        const parsed = parseArticle(await fs.readFile(file, 'utf8'), file);
        const relativeDir = path.relative(path.join(wwwRoot, author), dir);
        const externalAudioDir = path.join(audioRoot, author, relativeDir);
        const ownAudio = fileNames.has((stem + '.mp3').toLowerCase())
          || await hasExternalAudio(externalAudioDir, stem);
        const ownImage = imageStems.has(stem.toLowerCase());
        articles.push({
          id: [author, relativeDir, stem].filter(Boolean).join('/').replace(/\\/g, '/'),
          author, year: year || parsed.date?.slice(0, 4) || '', filePath: file,
          hasBody: !!parsed.body.trim(), ownAudio, audioUrl: ownAudio ? 'eigene Audio-Datei' : null,
          ownImage, categories: [], tags: [],
        });
      }
    }
  }
  for (const entry of await fs.readdir(wwwRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(path.join(wwwRoot, entry.name), entry.name, '');
  }
  return articles;
}

// Vor der Umbenennung erkennt die App eine Variante mit eigenem Text bei einer
// leeren Basis-Infografik noch nicht als Anhang. Wenn kein normaler Artikel den
// Stamm beansprucht, ist die vorhandene Basis dennoch ihr eindeutiger Anker.
function linkStandaloneInfographicVariants(articles, groups, anchorOf) {
  const key = (year, stem) => `${year}/${stem}`;
  const baseInfographics = new Map(articles.filter(article => article.author === 'Infografiken')
    .map(article => [key(article.year, path.basename(article.filePath, '.md')), article]));
  const articleStems = new Set(articles.filter(article => article.author !== 'Infografiken')
    .map(article => key(article.year, path.basename(article.filePath, '.md'))));
  for (const info of articles) {
    if (info.author !== 'Infografiken' || anchorOf.has(info.id) || info.ownAudio
      || !Number.isInteger(info.infographicOrdinal) || info.infographicOrdinal < 2) continue;
    const baseKey = key(info.year, info.infographicBase);
    const base = baseInfographics.get(baseKey);
    if (!base || !base.ownImage || articleStems.has(baseKey)) continue;
    anchorOf.set(info.id, base.id);
    groups.set(base.id, [...(groups.get(base.id) || []), info]);
  }
  for (const members of groups.values()) members.sort((a, b) => a.infographicOrdinal - b.infographicOrdinal);
}

async function planMigration(wwwRoot, { section = 'all' } = {}) {
  if (!SECTIONS.has(section)) throw new Error('Ungültiger Bereich. Erlaubt: 1, 1.1, 1.2, 1.3, 2, 3, all.');
  const requestedRoot = path.resolve(wwwRoot);
  const root = await fs.realpath(requestedRoot);
  const infographicRoot = path.join(root, 'Infografiken');
  if (!(await fs.lstat(infographicRoot)).isDirectory() || !inside(root, infographicRoot)) {
    throw new Error('Kein gültiges Infografiken-Verzeichnis.');
  }
  const configPath = path.join(path.dirname(requestedRoot), 'config.json');
  let authorPriority = [];
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (Array.isArray(config.authorPriority)) authorPriority = config.authorPriority.filter(a => typeof a === 'string');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const articles = await collectArticles(root, path.join(path.dirname(requestedRoot), 'audio'));
  const migrationMarkers = await collectMigrationMarkers(infographicRoot);
  const articleById = new Map(articles.map(article => [article.id, article]));
  const { groups, anchorOf } = linkInfographics(articles, authorPriority);
  linkStandaloneInfographicVariants(articles, groups, anchorOf);
  const changes = [];
  const skipped = [];
  const alreadyMigrated = [];

  for (const [anchorId, members] of groups) {
    const anchor = articleById.get(anchorId);
    const baseStem = path.basename(anchor.filePath, '.md');
    const marker = migrationMarkers.get(baseStem.toLowerCase());
    const selectedMembers = members.filter(member => selectedForMigration(member, anchor, section));
    if (!selectedMembers.length && !marker) continue;
    const dir = path.join(infographicRoot, anchor.year);
    if (!/^\d{4}$/.test(anchor.year) || !inside(infographicRoot, dir)) {
      if (selectedMembers.length) skipped.push({ anchorId, reason: 'kein gültiges Jahresverzeichnis' });
      continue;
    }
    if (anchor.author === 'Infografiken' && !anchor.hasBody && !anchor.ownAudio
      && articles.some(article => article.author !== 'Infografiken' && article.year === anchor.year
        && path.basename(article.filePath, '.md') === baseStem)) {
      if (selectedMembers.length) skipped.push({ anchorId, reason: 'Basis ohne eigenen Inhalt und gleichnamige Artikel: Zuordnung mehrdeutig' });
      continue;
    }
    const ordinals = members.map(member => member.infographicOrdinal);
    if (new Set(ordinals).size !== ordinals.length) {
      if (selectedMembers.length) skipped.push({ anchorId, reason: 'mehrdeutige Nummerierung (z. B. Basis und _1 zugleich)' });
      continue;
    }
    if (marker) {
      if (anchor.author !== 'Infografiken'
        && members.some(member => path.basename(member.filePath, '.md').toLowerCase() === baseStem.toLowerCase())) {
        if (selectedMembers.length) skipped.push({ anchorId, reason: 'alte Basis und _1 zugleich vorhanden; Zuordnung manuell prüfen' });
      } else {
        alreadyMigrated.push({ anchorId, marker });
      }
      continue;
    }
    if (!selectedMembers.length) continue;
    if (selectedMembers.some(member => member.author !== 'Infografiken' || !member.ownImage
      || member.ownAudio || path.dirname(member.filePath) !== dir)) {
      skipped.push({ anchorId, reason: 'Gruppe enthält eine eigenständige, unvollständige oder anderswo liegende Grafik' });
      continue;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const bundles = [];
    let problem = '';
    for (const member of selectedMembers) {
      const oldStem = path.basename(member.filePath, '.md');
      const files = entries.filter(entry => entry.name.toLowerCase().startsWith(oldStem.toLowerCase() + '.'));
      const images = files.filter(entry => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
      if (files.length !== 2 || images.length !== 1 || files.some(entry => !entry.isFile())
        || !files.some(entry => entry.name.toLowerCase() === oldStem.toLowerCase() + '.md')) {
        problem = `unvollständige oder zusätzliche Dateien bei ${oldStem}`;
        break;
      }
      bundles.push({ member, files: files.map(entry => path.join(dir, entry.name)) });
    }
    if (problem) {
      skipped.push({ anchorId, reason: problem });
      continue;
    }
    const sources = new Set(bundles.flatMap(bundle => bundle.files).map(file => file.toLowerCase()));
    const blockedStems = new Set(entries
      .filter(entry => !sources.has(path.join(dir, entry.name).toLowerCase()))
      .map(entry => path.basename(entry.name, path.extname(entry.name)).toLowerCase()));
    const mappings = [];
    const renames = [];
    for (const bundle of bundles) {
      const oldStem = path.basename(bundle.member.filePath, '.md');
      const ordinal = members.indexOf(bundle.member) + 1;
      const newStem = infographicAttachmentStem(baseStem, ordinal);
      if (newStem === oldStem) continue;
      if (blockedStems.has(newStem.toLowerCase())) {
        problem = `Zielstamm bereits belegt: ${newStem}`;
        break;
      }
      for (const source of bundle.files) {
        const target = path.join(dir, newStem + path.extname(source));
        if (Buffer.byteLength(path.basename(target)) > 255) {
          problem = `Zieldateiname zu lang: ${path.basename(target)}`;
          break;
        }
        const mapping = { source, target };
        if (path.extname(source).toLowerCase() === '.md') {
          mapping.content = retitleInfographicMarkdown(
            await fs.readFile(source, 'utf8'), bundle.member.infographicOrdinal, ordinal);
        }
        mappings.push(mapping);
      }
      if (problem) break;
      renames.push({ id: bundle.member.id, from: oldStem, to: newStem });
    }
    if (problem) {
      skipped.push({ anchorId, reason: problem });
      continue;
    }
    if (mappings.length) changes.push({ anchorId, mappings, renames });
  }
  const infographics = articles.filter(article => article.author === 'Infografiken' && article.ownImage)
    .map(article => {
      const anchorId = anchorOf.get(article.id) || null;
      return { id: article.id, anchorId, anchorAuthor: articleById.get(anchorId)?.author || null,
        hasBody: article.hasBody };
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'de'));
  const standalone = infographics.filter(article => !article.anchorId).length;
  return { root, section, changes, skipped, alreadyMigrated, infographics, standalone };
}

function formatMigrationReport(plan) {
  const targetById = new Map(plan.changes.flatMap(change => change.renames.map(rename => [
    rename.id, rename.id.slice(0, rename.id.lastIndexOf('/') + 1) + rename.to,
  ])));
  const skipByAnchor = new Map(plan.skipped.map(item => [item.anchorId, item.reason]));
  const migratedByAnchor = new Map(plan.alreadyMigrated.map(item => [item.anchorId, item.marker]));
  const migrated = plan.infographics.filter(item => item.anchorId && migratedByAnchor.has(item.anchorId));
  const assigned = plan.infographics.filter(item => item.anchorId && !migratedByAnchor.has(item.anchorId));
  const articleAttachments = assigned.filter(item => item.anchorAuthor !== 'Infografiken');
  const headerOnly = articleAttachments.filter(item => !item.hasBody);
  const withBody = articleAttachments.filter(item => item.hasBody);
  const infographicAttachments = assigned.filter(item => item.anchorAuthor === 'Infografiken');
  const standalone = plan.infographics.filter(item => !item.anchorId);
  const lines = [`Ausgewählter Bereich: ${plan.section === 'all' ? 'alle zugeordneten Infografiken' : plan.section}`];
  const show = (items) => {
    for (const item of items) {
      const target = targetById.get(item.id);
      const warning = skipByAnchor.get(item.anchorId || item.id);
      const marker = item.anchorId ? migratedByAnchor.get(item.anchorId) : null;
      lines.push(`  ${item.id}${target ? ` → ${target}` : ''}`
        + `${item.anchorId ? ` | Artikel: ${item.anchorId}` : ''}`
        + `${marker ? ` | BEREITS MIGRIERT (_1: ${marker})` : ''}`
        + `${warning ? ` | ÜBERSPRUNGEN: ${warning}` : ''}`);
    }
    if (!items.length) lines.push('  (keine)');
  };
  lines.push(`1. Infografiken, die einen zugewiesenen Artikel haben (${assigned.length})`);
  lines.push('', '');
  lines.push(`1.1 Davon nur mit Kopf oder leerer MD-Datei (${headerOnly.length})`);
  show(headerOnly);
  lines.push('', '');
  lines.push(`1.2 Davon mit eigenem Textkörper (${withBody.length})`);
  show(withBody);
  lines.push('', '');
  lines.push(`1.3 Infografiken, die eine Infografik als Artikeltext haben (${infographicAttachments.length})`);
  show(infographicAttachments);
  lines.push('', '');
  lines.push(`2. Infografiken, die keinen zugewiesenen Artikel haben (${standalone.length})`);
  show(standalone);
  lines.push('', '');
  lines.push(`3. Bereits migrierte Infografiken (${migrated.length})`);
  show(migrated);
  const shownAnchors = new Set(plan.infographics.flatMap(item => [item.id, item.anchorId].filter(Boolean)));
  for (const item of plan.skipped.filter(item => !shownAnchors.has(item.anchorId))) {
    lines.push(`ÜBERSPRUNGEN ${item.anchorId}: ${item.reason}`);
  }
  lines.push(`${plan.changes.length} Gruppen geplant, ${plan.alreadyMigrated.length} bereits migriert, ${plan.skipped.length} übersprungen; ${plan.standalone} eigenständige Infografiken unverändert.`);
  if (plan.section === '2' || plan.section === '3') lines.push(`Bereich ${plan.section} ist nur zur Anzeige da; hier ist keine Migration nötig.`);
  return lines.join('\n');
}

async function applyMigration(plan) {
  if (plan.skipped.length) throw new Error('Wegen übersprungener Gruppen nichts geändert. Konflikte zuerst prüfen.');
  const undo = [];
  try {
    for (const change of plan.changes) undo.push(await moveInfographicFiles(change.mappings));
  } catch (error) {
    for (const rollback of undo.reverse()) await rollback();
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  let wwwRoot = DEFAULT_WWW;
  let apply = false;
  let section = 'all';
  let sectionSpecified = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--root' && args[i + 1]) wwwRoot = path.resolve(args[++i]);
    else if (args[i] === '--section' && args[i + 1] && !sectionSpecified) {
      section = args[++i];
      sectionSpecified = true;
    }
    else throw new Error('Nutzung: node scripts/migrate-infographic-names.js [--root PFAD_ZU_WWW] [--section 1|1.1|1.2|1.3|2|3|all] [--apply]');
  }
  const plan = await planMigration(wwwRoot, { section });
  console.log(formatMigrationReport(plan));
  if (!apply) console.log('Vorschau: keine Dateien geändert. Zum Ausführen --apply angeben.');
  else if (section === '2' || section === '3') console.log(`Bereich ${section}: keine Dateien umzubenennen.`);
  else {
    await applyMigration(plan);
    console.log('Migration abgeschlossen. Die App jetzt neu einlesen bzw. den Server neu starten.');
  }
  return plan;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { collectArticles, planMigration, formatMigrationReport, applyMigration, main };
