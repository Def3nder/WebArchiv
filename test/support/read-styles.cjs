// Alle Stylesheets der App in der Reihenfolge aus index.html, als ein Text.
// Für Tests, die Regeln unabhängig davon prüfen, in welcher Teildatei sie stehen.
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function styleFiles() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  return [...html.matchAll(/<link rel="stylesheet" href="(css\/[^"?]+\.css)"/g)].map(match => match[1]);
}

function readStyles() {
  return styleFiles().map(file => fs.readFileSync(path.join(PUBLIC, file), 'utf8')).join('\n');
}

module.exports = readStyles;
module.exports.styleFiles = styleFiles;
