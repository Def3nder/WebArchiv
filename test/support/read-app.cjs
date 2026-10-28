// Quelltext der App-Skripte (app-*.js und app.js) in der Reihenfolge aus index.html, als ein Text.
// Für Tests, die Funktionen unabhängig davon prüfen, in welcher Teildatei sie stehen.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function appFiles() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="(app(?:-[a-z-]+)?\.js)"/g)].map(match => match[1]);
}

function readApp() {
  return appFiles().map(file => fs.readFileSync(path.join(PUBLIC, file), 'utf8')).join('\n');
}

module.exports = readApp;
module.exports.appFiles = appFiles;
