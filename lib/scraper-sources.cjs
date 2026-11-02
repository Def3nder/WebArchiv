'use strict';

// Scraper-Zentrale, reine Hilfen: Quellen aus scraper-config.json lesen und prüfen, den Stand je Quelle aus
// scrape-status.json zusammenfassen, Ablauf der Facebook-Cookies ermitteln (nur Ablaufdaten, nie Werte) und daraus
// notwendige Aktionen ableiten. Routen und Dateien: modules/scraper-center.cjs.

const { httpError } = require('./http-errors.cjs');

// Typ (wie scrape_all.js) → Abschnitt in scraper-config.json; Reihenfolge = Ablauf des Scrapers.
const SOURCE_SECTIONS = { blog: 'Blog', facebook: 'Facebook', telegram: 'Telegram' };
// Autorenordner mit eigener Bedeutung im Archiv: Dort darf kein Scraper hineinschreiben.
const RESERVED_NAMES = ['infografiken', 'pdf', 'videos', 'hörbücher', 'hoerbuecher'];
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const DAY = 24 * 3600 * 1000;
// Ab hier gilt eine aktive Quelle ohne neue Artikel als auffällig, ein Cron-Lauf als ausgefallen.
const STALE_DAYS = 14;
const CRON_MAX_AGE = 26 * 3600 * 1000;
const COOKIE_WARN_DAYS = 7;
// Facebook-Anmeldung: ohne diese beiden Cookies kein Login.
const FACEBOOK_SESSION_COOKIES = ['c_user', 'xs'];

function emptyConfig() {
  return Object.fromEntries(Object.values(SOURCE_SECTIONS).map(section => [section, []]));
}

// Quellen als flache Liste in Ablaufreihenfolge.
function listSources(doc) {
  const sources = [];
  for (const [type, section] of Object.entries(SOURCE_SECTIONS)) {
    for (const entry of Array.isArray(doc?.[section]) ? doc[section] : []) {
      sources.push({
        type,
        name: String(entry.Name || ''),
        url: String(entry.URL || ''),
        outputPath: String(entry.OutputPath || ''),
        active: entry.Aktiv !== false,
        fileAuthor: entry.FileAuthor === undefined ? null : String(entry.FileAuthor),
        signature: entry.Signature ? { name: String(entry.Signature.Name || ''), website: String(entry.Signature.Website || '') } : null,
        exclude: entry.Exclude === undefined ? null : String(entry.Exclude),
      });
    }
  }
  return sources;
}

function findSource(doc, name) {
  const wanted = String(name || '').trim().toLowerCase();
  for (const [type, section] of Object.entries(SOURCE_SECTIONS)) {
    const list = Array.isArray(doc?.[section]) ? doc[section] : [];
    const index = list.findIndex(entry => String(entry.Name || '').toLowerCase() === wanted);
    if (index >= 0) return { type, section, index, entry: list[index] };
  }
  return null;
}

function cleanText(value, label, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) throw httpError(400, `${label} ist zu lang (höchstens ${max} Zeichen).`);
  return text;
}

// Prüft die Eingaben einer neuen oder geänderten Quelle und liefert den Eintrag für scraper-config.json.
// Der Name ist zugleich der Autorenordner (www/<Name>) und lässt sich deshalb nicht ändern.
function sourceEntry(input, { doc, existing = null }) {
  const type = existing ? existing.type : String(input?.type || '');
  if (!SOURCE_SECTIONS[type]) throw httpError(400, 'Unbekannter Quellentyp (Blog, Facebook oder Telegram).');
  const name = existing ? String(existing.entry.Name) : cleanText(input?.name, 'Der Name', 60);
  if (!existing) {
    if (!name || name.startsWith('.') || FORBIDDEN_NAME_CHARS.test(name)) {
      throw httpError(400, 'Der Name ist zugleich der Ordnername: keine Schrägstriche, Doppelpunkte, Anführungszeichen oder führenden Punkte.');
    }
    if (RESERVED_NAMES.includes(name.toLowerCase())) throw httpError(400, `„${name}“ ist ein reservierter Archivordner.`);
    if (findSource(doc, name)) throw httpError(409, `Eine Quelle „${name}“ gibt es schon.`);
  }

  const urlText = cleanText(input?.url, 'Die URL', 300);
  let url;
  try { url = new URL(urlText); } catch { throw httpError(400, 'Die URL ist ungültig.'); }
  if (url.protocol !== 'https:') throw httpError(400, 'Nur https-Adressen sind erlaubt.');
  const host = url.hostname.toLowerCase();
  if (type === 'facebook' && !(host === 'facebook.com' || host.endsWith('.facebook.com'))) {
    throw httpError(400, 'Eine Facebook-Quelle braucht eine Adresse auf facebook.com.');
  }
  if (type === 'telegram' && !(host === 't.me' && /^\/s\/[\w]+\/?$/.test(url.pathname))) {
    throw httpError(400, 'Eine Telegram-Quelle braucht die öffentliche Vorschau-Adresse https://t.me/s/<Kanal>.');
  }

  const entry = { Name: name, URL: url.href, OutputPath: `../www/${name}` };
  const fileAuthor = cleanText(input?.fileAuthor, 'Der Dateiautor', 60);
  if (fileAuthor) {
    if (FORBIDDEN_NAME_CHARS.test(fileAuthor)) throw httpError(400, 'Der Dateiautor darf keine Sonderzeichen wie / : * ? " < > | enthalten.');
    entry.FileAuthor = fileAuthor;
  }
  const signatureName = cleanText(input?.signatureName, 'Der Signaturname', 80);
  const signatureWebsite = cleanText(input?.signatureWebsite, 'Die Signatur-Website', 120);
  if (signatureWebsite && !signatureName) throw httpError(400, 'Eine Signatur braucht einen Namen.');
  if (signatureName) entry.Signature = { Name: signatureName, Website: signatureWebsite };
  const exclude = cleanText(input?.exclude, 'Der Ausschluss-Ausdruck', 200);
  if (exclude) {
    try { new RegExp(exclude, 'i'); } catch (error) { throw httpError(400, `Ungültiger Ausschluss-Ausdruck: ${error.message}`); }
    entry.Exclude = exclude;
  }
  if (existing && existing.entry.Aktiv === false) entry.Aktiv = false;
  return { type, section: SOURCE_SECTIONS[type], entry };
}

// cookies.txt (Netscape-Format): nur Anzahl und Ablaufzeit der Facebook-Anmeldung, nie Namen-Werte-Paare.
function cookieExpiry(text) {
  if (typeof text !== 'string') return { exists: false, count: 0, sessionExpiresAt: null };
  let count = 0;
  const session = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (!line.trim() || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    count += 1;
    const [domain, , , , expiry, name] = fields;
    if (/facebook\.com$/i.test(domain.trim()) && FACEBOOK_SESSION_COOKIES.includes(name.trim())) {
      const seconds = Number(expiry);
      // 0 = Sitzungs-Cookie (läuft mit dem Browser ab): für den Scraper sofort ungültig.
      session.push(seconds > 0 ? seconds * 1000 : 0);
    }
  }
  const complete = FACEBOOK_SESSION_COOKIES.length === session.length;
  return { exists: true, count, sessionExpiresAt: complete ? Math.min(...session) : null };
}

// Stand einer Quelle aus den Läufen (neueste zuerst): letzter Lauf, letzter Lauf mit neuen Artikeln, Neue in 30 Tagen.
function summarizeSource(source, runs, now = Date.now()) {
  let last = null;
  let lastNewAt = null;
  let newLast30Days = 0;
  for (const run of Array.isArray(runs) ? runs : []) {
    const entry = (run.sources || []).find(item => item.type === source.type && item.name === source.name);
    if (!entry || entry.status === 'paused') continue;
    const at = Date.parse(entry.finishedAt || entry.startedAt || run.startedAt) || null;
    if (!last) last = { ...entry, runId: run.id, trigger: run.trigger, running: !entry.finishedAt && !run.finishedAt };
    if (entry.saved > 0 && at && (!lastNewAt || at > lastNewAt)) lastNewAt = at;
    if (at && now - at <= 30 * DAY) newLast30Days += entry.saved || 0;
  }
  return { last, lastNewAt, newLast30Days };
}

const LEVEL_ORDER = { error: 3, warning: 2, info: 1, ok: 0 };
const worstLevel = actions => actions.reduce((worst, action) => (LEVEL_ORDER[action.level] > LEVEL_ORDER[worst] ? action.level : worst), 'ok');

// Notwendige Aktionen einer Quelle: { level: error|warning|info, code, text }.
function sourceActions(source, summary, { cookies, now = Date.now() }) {
  const actions = [];
  const add = (level, code, text) => actions.push({ level, code, text });
  if (!source.active) add('info', 'paused', 'Pausiert – läuft nur noch gezielt mit „Jetzt scrapen“.');
  const last = summary.last;
  if (!last) {
    if (source.active) add('info', 'never-run', 'Noch kein Lauf erfasst.');
  } else if (last.status === 'failed') {
    add('error', 'failed', `Letzter Lauf abgebrochen: ${last.error || 'unbekannter Fehler'} – Log ansehen.`);
  }
  if (source.type === 'facebook' && source.active) {
    if (!cookies?.exists) add('error', 'cookies-missing', 'scraper/cookies.txt fehlt – Facebook-Cookies exportieren und ablegen.');
    else if (!cookies.sessionExpiresAt || cookies.sessionExpiresAt <= now) add('error', 'cookies-expired', 'Facebook-Anmeldung abgelaufen – cookies.txt erneuern.');
    else if (cookies.sessionExpiresAt - now < COOKIE_WARN_DAYS * DAY) {
      add('warning', 'cookies-expiring', `Facebook-Anmeldung läuft in ${Math.ceil((cookies.sessionExpiresAt - now) / DAY)} Tag(en) ab – cookies.txt erneuern.`);
    }
  }
  const warnings = last?.warnings || {};
  if (warnings['no-posts']) add('warning', 'no-posts', 'Keine Beiträge gefunden – Anmeldung oder Adresse prüfen.');
  if (warnings['cookies-missing'] && source.type !== 'facebook') add('warning', 'cookies-missing', 'Der Lauf meldete eine fehlende Cookie-Datei.');
  if ((warnings['dom-fallback'] || 0) >= 3) {
    add('info', 'dom-fallback', `${warnings['dom-fallback']}× Ersatz-Auslesen – Facebook hat vermutlich sein Layout geändert.`);
  }
  if (source.active && last && summary.lastNewAt && now - summary.lastNewAt > STALE_DAYS * DAY) {
    add('info', 'stale', `Seit ${Math.floor((now - summary.lastNewAt) / DAY)} Tagen keine neuen Artikel.`);
  }
  return { actions, level: worstLevel(actions) };
}

// Letzter Cron-Lauf ({ at, exitCode } aus cron-scrape.log): ausgefallen, wenn älter als 26 Stunden.
function cronState(lastRun, now = Date.now()) {
  if (!lastRun) return { lastRunAt: null, exitCode: null, level: 'info', text: 'Kein Cron-Lauf in cron-scrape.log gefunden.' };
  const age = now - lastRun.at;
  if (lastRun.exitCode !== 0) return { lastRunAt: lastRun.at, exitCode: lastRun.exitCode, level: 'error', text: `Letzter Cron-Lauf mit Exit-Code ${lastRun.exitCode}.` };
  if (age > CRON_MAX_AGE) return { lastRunAt: lastRun.at, exitCode: 0, level: 'warning', text: `Seit ${Math.floor(age / 3600000)} Stunden kein Cron-Lauf.` };
  return { lastRunAt: lastRun.at, exitCode: 0, level: 'ok', text: null };
}

module.exports = {
  SOURCE_SECTIONS, RESERVED_NAMES, STALE_DAYS, COOKIE_WARN_DAYS,
  emptyConfig, listSources, findSource, sourceEntry, cookieExpiry, summarizeSource, sourceActions, cronState, worstLevel,
};
