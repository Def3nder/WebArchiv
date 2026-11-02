'use strict';

// ESLint (Review 28.10., 3.5): bewusst nur drei Regeln – nicht deklarierte Namen, unbenutzte Variablen und
// Doppeldeklarationen. Kein Stilregelwerk; es soll Tippfehler und toten Code finden, bevor sie auffallen.
// ESLint liest "type" aus package.json nicht: Modulart je Ordner hier angeben.
const fs = require('node:fs');
const globals = require('globals');
const { PUBLIC, BUNDLE_SOURCES, classicScripts, sharedBrowserGlobals } = require('./test/support/browser-globals.cjs');

const UNUSED = { ignoreRestSiblings: true, caughtErrors: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_' };
const RULES = {
  'no-undef': 'error',
  // Weggelassene Felder per Rest-Destrukturierung ({ intern, ...rest }) sind gewollt; ein führender Unterstrich
  // markiert bewusst ungenutzte Parameter (Express erkennt Fehler-Handler nur an vier Parametern: _next).
  'no-unused-vars': ['error', UNUSED],
  'no-redeclare': 'error',
};
const BROWSER_CODE = ['public/**', 'duplicates-tool/public/**'];

const node = (files, sourceType) => ({
  files,
  ignores: BROWSER_CODE,
  languageOptions: { ecmaVersion: 'latest', sourceType, globals: { ...globals.node } },
  rules: RULES,
});

// Browser: Die klassischen Skripte teilen Funktionen und Konstanten über den globalen Gültigkeitsbereich. Jedes
// Skript kennt die Namen der übrigen (aus dem Quelltext ermittelt, test/support/browser-globals.cjs); deklariert es
// selbst einen davon oder einen Browser-Namen (open, close …), meldet no-redeclare das. Oberste Deklarationen
// prüft no-unused-vars nicht (vars: 'local'): Sie werden absichtlich in anderen Dateien benutzt – tote gemeinsame
// Namen findet test/browser-globals.test.cjs. password.js (Gast-/Nutzer-Shell) und user-admin.js (Admin-Shell)
// werden nie zusammen geladen und dürfen dieselben Namen haben.
const NEVER_TOGETHER = { 'password.js': ['user-admin.js'], 'user-admin.js': ['password.js'] };
const shared = sharedBrowserGlobals();
const sharedFor = file => Object.fromEntries([...shared]
  .filter(([, files]) => files.some(other => other !== file && !(NEVER_TOGETHER[file] || []).includes(other)))
  .map(([name]) => [name, 'writable']));
const BROWSER_RULES = {
  ...RULES,
  'no-unused-vars': ['error', { ...UNUSED, vars: 'local' }],
  'no-redeclare': ['error', { builtinGlobals: true }],
};
// Globale Namen aus vendor/: duplicateTextDiff (esbuild --global-name, npm run build:duplicate-diff).
const VENDOR = { duplicateTextDiff: 'readonly' };
// UMD-Hüllen fragen typeof module ab, damit Node-Tests sie laden können.
const umd = file => (/module\.exports/.test(fs.readFileSync(`${PUBLIC}/${file}`, 'utf8')) ? { module: 'readonly' } : {});
const browser = (files, sourceType, extraGlobals = {}) => ({
  files,
  languageOptions: { ecmaVersion: 'latest', sourceType, globals: { ...globals.browser, ...VENDOR, ...extraGlobals } },
  rules: sourceType === 'script' ? BROWSER_RULES : RULES,
});

module.exports = [
  {
    // Laufzeitdaten, Fremdcode und gebündelte Ausgaben nie.
    ignores: [
      '**/node_modules/**', 'public/vendor/**',
      'www/**', 'audio/**', 'archiv/**', 'download/**', 'graft/**', 'tts-server/**',
      '.test/**', '.npm-cache/**', '.claude/**',
    ],
  },
  node(['**/*.cjs'], 'commonjs'),
  node(['*.js', 'scripts/**/*.js', 'duplicates-tool/**/*.js'], 'commonjs'),
  node(['**/*.mjs', 'tts/**/*.js', 'scraper/**/*.js', 'epub-tool/**/*.js'], 'module'),
  ...classicScripts().map(file => browser([`public/${file}`], 'script', { ...sharedFor(file), ...umd(file) })),
  // Quellen der esbuild-Bündel: ES-Module, die die gemeinsamen Namen der App benutzen; duplicate-diff.js ist CommonJS.
  browser(BUNDLE_SOURCES.filter(file => file !== 'duplicate-diff.js').map(file => `public/${file}`), 'module',
    Object.fromEntries([...shared.keys()].map(name => [name, 'writable']))),
  browser(['public/duplicate-diff.js'], 'commonjs'),
  // Neue Skripte, die (noch) nicht in index.html stehen, bleiben nicht ungeprüft.
  {
    ...browser(['public/**/*.js'], 'script', Object.fromEntries([...shared.keys()].map(name => [name, 'writable']))),
    ignores: ['public/vendor/**', ...[...classicScripts(), ...BUNDLE_SOURCES].map(file => `public/${file}`)],
    rules: { ...RULES, 'no-unused-vars': ['error', { ...UNUSED, vars: 'local' }] },
  },
  browser(['duplicates-tool/public/**/*.js'], 'script'),
];
