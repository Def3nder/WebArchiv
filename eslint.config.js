'use strict';

// ESLint (Review 28.10., 3.5): bewusst nur drei Regeln – nicht deklarierte Namen, unbenutzte Variablen und
// Doppeldeklarationen. Kein Stilregelwerk; es soll Tippfehler und toten Code finden, bevor sie auffallen.
// ESLint liest "type" aus package.json nicht: Modulart je Ordner hier angeben.
const globals = require('globals');

const RULES = {
  'no-undef': 'error',
  // Weggelassene Felder per Rest-Destrukturierung ({ intern, ...rest }) sind gewollt; ein führender Unterstrich
  // markiert bewusst ungenutzte Parameter (Express erkennt Fehler-Handler nur an vier Parametern: _next).
  'no-unused-vars': ['error', {
    ignoreRestSiblings: true, caughtErrors: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_',
  }],
  'no-redeclare': 'error',
};

const node = (files, sourceType) => ({
  files,
  languageOptions: { ecmaVersion: 'latest', sourceType, globals: { ...globals.node } },
  rules: RULES,
});

module.exports = [
  {
    // Browser-Code folgt in einem eigenen Schritt; Laufzeitdaten und Fremdcode nie.
    ignores: [
      '**/node_modules/**', 'public/**', 'duplicates-tool/public/**',
      'www/**', 'audio/**', 'archiv/**', 'download/**', 'graft/**', 'tts-server/**',
      '.test/**', '.npm-cache/**', '.claude/**',
    ],
  },
  node(['**/*.cjs'], 'commonjs'),
  node(['*.js', 'scripts/**/*.js', 'duplicates-tool/**/*.js'], 'commonjs'),
  node(['**/*.mjs', 'tts/**/*.js', 'scraper/**/*.js', 'epub-tool/**/*.js'], 'module'),
];
