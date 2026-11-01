'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderIndexForSession } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HEALTH = read('public/health.js');
const CSS = read('public/css/health.css');

test('Health-Check gibt es nur in der Admin-Shell (Markup, Menüeintrag, Skript, Styles)', () => {
  for (const role of [null, 'guest', 'user']) {
    const html = renderIndexForSession({ session: role ? { user: { role } } : {} });
    assert.doesNotMatch(html, /id="health-(?:notice|dialog)"|data-action="health"|health\.js|css\/health\.css/, String(role));
  }
  const admin = renderIndexForSession({ session: { user: { role: 'admin', mustChangePassword: false } } });
  assert.match(admin, /<aside id="health-notice" class="health-notice" role="status" aria-live="polite" hidden>/);
  assert.match(admin, /<dialog id="health-dialog" class="account-dialog account-dialog-wide health-dialog" aria-labelledby="health-title"/);
  assert.match(admin, /data-action="health" data-admin-only>Health-Check <span id="health-menu-count"/);
  assert.match(admin, /<script src="admin-tasks\.js[^"]*" data-admin-asset><\/script>\s*<script src="health\.js[^"]*" data-admin-asset><\/script>/);
  assert.match(admin, /<link rel="stylesheet" href="css\/health\.css[^"]*" data-admin-asset \/>/);
  assert.match(read('server.js'), /'\/health\.js',\s*'\/css\/health\.css',/, 'vor express.static geschützt');
});

test('health.js: Abfrage nur für Admins und sichtbare Seite, Hinweis nur bei Fehlern, „gelesen“ pro Gerät', () => {
  assert.match(HEALTH, /^\(\(\) => \{/m, 'gekapseltes Skript');
  assert.match(HEALTH, /const POLL_MS = 60 \* 1000;/);
  assert.match(HEALTH, /if \(currentUser\?\.role !== 'admin' \|\| document\.visibilityState !== 'visible'\) return;/);
  assert.match(HEALTH, /apiFetch\(`\/api\/health\/events\?after=/);
  assert.match(HEALTH, /if \(summary\.newErrors > 0 && !\$dialog\.open\) showNotice\(summary\);/);
  assert.match(HEALTH, /const SEEN_KEY = 'wa-health-seen';/);
  assert.match(HEALTH, /if \(!Number\.isFinite\(seen\)\) \{\s*rememberSeen\(summary\.lastId\);\s*return;/, 'erstes Mal: Historie gilt als gelesen');
  assert.match(HEALTH, /\$noticeDismiss\.addEventListener\('click', \(\) => hideNotice\(\{ markSeen: true \}\)\)/);
  assert.match(HEALTH, /WebArchivLayers\.float\(\$notice\);/, 'auch über offenen Ansichten bedienbar');
});

test('health.js: Dialog am Ebenen-Stapel, sicheres Markup, Einhängen über adminHooks', () => {
  assert.match(HEALTH, /WebArchivLayers\.open\(\$dialog, \{ name: 'health', onEscape: closeHealthDialog \}\)/);
  assert.doesNotMatch(HEALTH, /showModal\(|addEventListener\('keydown'/);
  assert.match(HEALTH, /apiFetch\('\/api\/health\/details'\)/);
  assert.match(HEALTH, /apiFetch\('\/api\/health\/events\/clear', \{ method: 'POST' \}\)/);
  // Alle Texte aus der Antwort laufen über esc(); innerHTML nur mit diesen Bausteinen.
  for (const field of ['entry.message', 'entry.detail', 'issue.path', 'issue.reason', 'index.error', 'server.node']) {
    assert.match(HEALTH, new RegExp(`esc\\(${field.replace('.', '\\.')}\\)`), field);
  }
  assert.match(HEALTH, /const previousUserChanged = adminHooks\.userChanged;[\s\S]*?userChanged: user => \{ previousUserChanged\(user\); startPolling\(\); \}/,
    'die Hooks von admin-tasks.js bleiben erhalten');
  assert.match(HEALTH, /actions: \{ \.\.\.adminHooks\.actions, health: openHealthDialog \}/);
  assert.match(HEALTH, /rememberSeen\(data\.events\.lastId\);/, 'Dialog gesehen = gelesen');
  assert.match(HEALTH, /row\('Dubletten', `\$\{number\(index\.duplicates\.linked\)\} verknüpft · \$\{number\(index\.duplicates\.open\)\} offen`\)/);
  assert.match(HEALTH, /\$dialog\.addEventListener\('click', event => \{\s*if \(event\.target !== \$dialog\) return;[\s\S]*?closeHealthDialog\(\);\s*\}\);/,
    'Klick neben den Dialog schließt ihn');
});

test('health.css: Hinweis oben rechts mit rotem Streifen, Ampelfarben aus den App-Variablen', () => {
  assert.match(CSS, /\.health-notice \{[^}]*position: fixed;[^}]*right: 16px;[^}]*border-left: 3px solid var\(--red\);/);
  assert.match(CSS, /\.health-notice\[hidden\] \{ display: none; \}/);
  assert.match(CSS, /\.health-notice \{[^}]*top: var\(--health-notice-top, /, 'Lage unter der Kopfzeile kommt aus health.js');
  assert.match(HEALTH, /\$notice\.style\.setProperty\('--health-notice-top', `\$\{Math\.round\(bottom\) \+ 12\}px`\);/);
  assert.match(HEALTH, /if \(\$notice\.hidden\) trackChrome\(true\);/, 'Scroll-Listener nur solange der Hinweis sichtbar ist');
  assert.match(CSS, /\.health-dot-ok \{ background: var\(--author-1\); \}/);
  assert.match(CSS, /\.health-dot-warning \{ background: var\(--accent\); \}/);
  assert.match(CSS, /\.health-dot-error \{ background: var\(--red\); \}/);
  assert.match(CSS, /\.health-pill \{[^}]*background: var\(--pill\);[^}]*color: var\(--bg\);/, 'Gesamtstufe als gefüllte Plakette');
  assert.match(CSS, /\.health-pill-ok \{ --pill: var\(--author-1\); \}\s*\.health-pill-ok::before \{ content: '✓'; \}/);
  assert.match(CSS, /\.health-grid \{ display: grid; grid-template-columns: repeat\(auto-fit, minmax\(260px, 1fr\)\);/);
});
