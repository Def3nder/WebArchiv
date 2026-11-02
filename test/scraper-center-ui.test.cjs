'use strict';

// Scraper-Zentrale, Oberfläche: nur in der Admin-Shell, ersetzt „Neue Beiträge scrapen“ und „Scrape-Log anzeigen“,
// Dialog am Ebenen-Stapel, sicheres Markup, Läufe über das bestehende Scrape-Fenster.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderIndexForSession } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SCRIPT = read('public/scraper-center.js');
const TASKS = read('public/admin-tasks.js');

test('Scraper-Zentrale gibt es nur in der Admin-Shell; ein Menüeintrag statt zwei', () => {
  for (const role of [null, 'user']) {
    const html = renderIndexForSession({ session: role ? { user: { role } } : {} });
    assert.doesNotMatch(html, /id="scraper-center"|scraper-center\.js|css\/scraper-center\.css|data-action="scraper-center"/, String(role));
  }
  const admin = renderIndexForSession({ session: { user: { role: 'admin', mustChangePassword: false } } });
  assert.match(admin, /data-action="scraper-center" data-admin-only>Scraper-Zentrale<\/button>/);
  assert.doesNotMatch(admin, /data-action="scrape"|data-action="log"/, 'in der Zentrale aufgegangen');
  assert.match(admin, /<dialog id="scraper-center" class="account-dialog account-dialog-wide scraper-center-dialog"/);
  assert.match(admin, /<script src="scraper-center\.js[^"]*" data-admin-asset><\/script>/);
  assert.match(read('server.js'), /'\/scraper-center\.js',\s*'\/css\/scraper-center\.css',/, 'vor express.static geschützt');
});

test('scraper-center.js: Dialog am Ebenen-Stapel, Texte über esc(), nur https-Links, Einhängen über adminHooks', () => {
  assert.match(SCRIPT, /^\(\(\) => \{/m, 'gekapseltes Skript');
  assert.match(SCRIPT, /WebArchivLayers\.open\(\$dialog, \{ name: 'scraper-center', onEscape:/);
  assert.doesNotMatch(SCRIPT, /showModal\(|addEventListener\('keydown'/);
  for (const value of ['source.name', 'action.text', 'article.title || article.id', 'error.message']) {
    assert.ok(SCRIPT.includes(`esc(${value})`), value);
  }
  assert.match(SCRIPT, /const sourceLink = url => \(\/\^https:\\\/\\\/\/i\.test\(url\)/, 'nur https wird zum Link');
  assert.match(SCRIPT, /rel="noopener noreferrer"/);
  assert.match(SCRIPT, /actions: \{ \.\.\.adminHooks\.actions, 'scraper-center': openScraperCenter \}/);
  assert.match(SCRIPT, /adminHooks\.actions\['scrape-source'\]\?\.\(source\.name\)/);
  assert.match(SCRIPT, /confirm\(`Quelle „\$\{source\.name\}“ entfernen\? Die bereits gescrapten Artikel bleiben im Archiv\.`\)/);
  // Nach unten wischen und Klick daneben schließen wie bei den anderen Dialogen.
  assert.match(read('public/app.js'), /\['#scraper-center', '#scraper-close'\],/);
  assert.match(SCRIPT, /\$dialog\.addEventListener\('click', event => \{\s*if \(event\.target !== \$dialog\) return;/);
});

test('admin-tasks.js: Einzelquelle über /api/scraper/run im bestehenden Scrape-Fenster', () => {
  assert.match(TASKS, /async function runScrape\(\{ source = null \} = \{\}\)/);
  assert.match(TASKS, /apiFetch\('\/api\/scraper\/run', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ source \}\) \}\)/);
  assert.match(TASKS, /'scrape-source': source => runScrape\(\{ source \}\),/);
});

test('scraper-center.css: Karten und Formular einspaltig auf schmalen Bildschirmen', () => {
  const css = read('public/css/scraper-center.css');
  assert.match(css, /@media \(max-width: 600px\) \{[^}]*\.scraper-form-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.scraper-content \{ min-height: 0; overflow-y: auto;/);
});
