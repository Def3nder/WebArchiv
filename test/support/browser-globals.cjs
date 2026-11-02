// Gemeinsame globale Namen der Browser-Skripte – für ESLint (eslint.config.js) und den Test auf tote bzw. doppelte
// Namen (test/browser-globals.test.cjs). Die klassischen Skripte in public/ teilen ihre Funktionen und Konstanten
// bewusst über den globalen Gültigkeitsbereich; die Liste entsteht hier aus dem Quelltext statt von Hand.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// Klassische Skripte in der Reihenfolge aus index.html (ohne die gebündelten vendor/-Dateien).
function classicScripts() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"?]+\.js)"/g)].map(match => match[1]).filter(file => !file.startsWith('vendor/'));
}

// Quellen der esbuild-Bündel (ES-Module bzw. CommonJS für duplicate-diff.js); sie laufen nicht als eigene Skripte.
const BUNDLE_SOURCES = [
  'markdown-editors.js', 'markdown-live-preview.js', 'article-editor.js', 'audiobook-extras-manager.js',
  'markdown-commands.mjs', 'duplicate-diff.js',
];

function parse(file, sourceType) {
  const source = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  return espree.parse(source, { ecmaVersion: 'latest', sourceType, range: true, tokens: true });
}

function patternNames(node, names = []) {
  if (!node) return names;
  if (node.type === 'Identifier') names.push(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach(p => patternNames(p.type === 'RestElement' ? p.argument : p.value, names));
  else if (node.type === 'ArrayPattern') node.elements.forEach(e => patternNames(e, names));
  else if (node.type === 'RestElement') patternNames(node.argument, names);
  else if (node.type === 'AssignmentPattern') patternNames(node.left, names);
  return names;
}

// Oberste Deklarationen eines klassischen Skripts: [{ name, kind }].
function topLevelDeclarations(ast) {
  const declared = [];
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') declared.push({ name: node.id.name, kind: node.type });
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        for (const name of patternNames(declaration.id)) declared.push({ name, kind: node.kind });
      }
    }
  }
  return declared;
}

// Ausdrücklich veröffentlichte Namen: window.X = …, globalThis.X = …, root.X = … (UMD-Hülle).
function exposedNames(ast) {
  const names = [];
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed
        && node.left.object.type === 'Identifier' && ['window', 'globalThis', 'self', 'root'].includes(node.left.object.name)) {
      names.push(node.left.property.name);
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'range' || key === 'loc') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return names;
}

const sourceTypeOf = file => (file.endsWith('.mjs') || ['markdown-editors.js', 'markdown-live-preview.js',
  'article-editor.js', 'audiobook-extras-manager.js'].includes(file) ? 'module' : 'script');

// Alle gemeinsamen Namen: { name → [Dateien] }.
function sharedBrowserGlobals() {
  const shared = new Map();
  const add = (name, file) => shared.set(name, [...new Set([...(shared.get(name) || []), file])]);
  for (const file of classicScripts()) {
    const ast = parse(file, 'script');
    for (const { name } of topLevelDeclarations(ast)) add(name, file);
    for (const name of exposedNames(ast)) add(name, file);
  }
  for (const file of BUNDLE_SOURCES) {
    for (const name of exposedNames(parse(file, sourceTypeOf(file) === 'module' ? 'module' : 'script'))) add(name, file);
  }
  return shared;
}

module.exports = { PUBLIC, BUNDLE_SOURCES, classicScripts, parse, topLevelDeclarations, exposedNames, sharedBrowserGlobals };
