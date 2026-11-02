'use strict';

// Gemeinsame Namen der klassischen Browser-Skripte (Review 3.5): ESLint prüft je Datei, dieser Test das
// Zusammenspiel – tote gemeinsame Namen (wie in 2.11) und Namen, die zwei gleichzeitig geladene Skripte deklarieren.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ESLint } = require('eslint');
const { PUBLIC, BUNDLE_SOURCES, classicScripts, parse, topLevelDeclarations, exposedNames } = require('./support/browser-globals.cjs');
const { renderIndexForSession } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const MODULES = new Set(['markdown-editors.js', 'markdown-live-preview.js', 'article-editor.js', 'audiobook-extras-manager.js']);
const astOf = file => parse(file, file.endsWith('.mjs') || MODULES.has(file) ? 'module' : 'script');

test('Gemeinsame Namen der Browser-Skripte: jeder wird irgendwo benutzt', () => {
  const files = [...classicScripts(), ...BUNDLE_SOURCES];
  const asts = new Map(files.map(file => [file, astOf(file)]));
  // Bezeichner über alle Browser-Quellen zählen: Nur die Deklaration selbst (1×) heißt tot.
  const uses = new Map();
  for (const ast of asts.values()) {
    for (const token of ast.tokens) if (token.type === 'Identifier') uses.set(token.value, (uses.get(token.value) || 0) + 1);
  }
  const dead = [];
  for (const file of classicScripts()) {
    const ast = asts.get(file);
    const names = [...topLevelDeclarations(ast).map(entry => entry.name), ...exposedNames(ast)];
    for (const name of names) if ((uses.get(name) || 0) <= 1) dead.push(`${file}: ${name}`);
  }
  assert.deepEqual(dead, []);
});

test('Je Shell (Gast, Nutzer, Admin) deklarieren keine zwei geladenen Skripte denselben Namen', () => {
  const shells = {
    guest: {},
    user: { user: { role: 'user', mustChangePassword: false } },
    admin: { user: { role: 'admin', mustChangePassword: false } },
  };
  for (const [shell, session] of Object.entries(shells)) {
    const html = renderIndexForSession({ session });
    const scripts = [...html.matchAll(/<script src="([^"?]+\.js)/g)].map(match => match[1]).filter(file => !file.startsWith('vendor/'));
    const owner = new Map();
    const clashes = [];
    for (const file of scripts) {
      for (const { name } of topLevelDeclarations(astOf(file))) {
        if (owner.has(name) && owner.get(name) !== file) clashes.push(`${name}: ${owner.get(name)} + ${file}`);
        else owner.set(name, file);
      }
    }
    assert.deepEqual(clashes, [], shell);
  }
  // password.js und user-admin.js teilen Namen (eslint.config.js: NEVER_TOGETHER) – nur, weil keine Shell beide lädt.
  const admin = renderIndexForSession({ session: shells.admin });
  const user = renderIndexForSession({ session: shells.user });
  assert.match(admin, /user-admin\.js/);
  assert.doesNotMatch(admin, /src="password\.js/);
  assert.match(user, /src="password\.js/);
  assert.doesNotMatch(user, /user-admin\.js/);
});

test('Artikel-Editor im Bündel: Rückfrage beim Verlassen des Artikels ist global erreichbar', () => {
  // app.js/app-detail.js rufen typeof leaveArticleEditor === 'function' auf; ohne window lief das ins Leere.
  const editor = fs.readFileSync(path.join(PUBLIC, 'article-editor.js'), 'utf8');
  assert.match(editor, /^window\.leaveArticleEditor = leaveArticleEditor;$/m);
  assert.match(editor, /^window\.articleEditorState = articleEditorState;$/m);
  const bundle = fs.readFileSync(path.join(PUBLIC, 'vendor', 'article-editor.bundle.js'), 'utf8');
  assert.match(bundle, /window\.leaveArticleEditor=/, 'Bündel neu bauen: npm run build:editor');
  assert.match(bundle, /window\.articleEditorState=/);
});

test('ESLint erfasst die Browser-Skripte mit den gemeinsamen Namen', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  assert.equal(await eslint.isPathIgnored(path.join(ROOT, 'public', 'app.js')), false);
  assert.equal(await eslint.isPathIgnored(path.join(ROOT, 'public', 'vendor', 'article-editor.bundle.js')), true);
  // pinchZoomed stammt aus touch-gestures.js, ist für app.js also ein bekannter gemeinsamer Name.
  const [result] = await eslint.lintText('pinchZoomed();\napiFech("/api/me");\nfunction close() {}\n',
    { filePath: path.join(ROOT, 'public', 'app.js') });
  assert.deepEqual(result.messages.map(message => `${message.ruleId}:${message.line}`),
    ['no-undef:2', 'no-redeclare:3'], 'Tippfehler und überschriebene Browser-Funktion');
});
