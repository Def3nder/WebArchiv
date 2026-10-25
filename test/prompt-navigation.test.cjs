const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('Externe Prompt-Ziele erzeugen unter iOS kein zusätzliches leeres Fenster', () => {
  assert.match(APP, /const isIosPromptNavigation = \(\) => \/iPad\|iPhone\|iPod\//);
  assert.match(APP, /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/);
  assert.match(APP, /if \(new URL\(url\)\.hostname === 'gemini\.google\.com'\) return 'googlegemini:\/\/'/);
  assert.match(APP, /if \(opensExternalPrompt && isIosPromptNavigation\(\)\) \{[\s\S]*await copyArticle[\s\S]*window\.location\.assign\(iosPromptTarget\(selected\.url\)\);/);
  assert.match(APP, /if \(opensExternalPrompt\) window\.open\(selected\.url, '_blank', 'noopener,noreferrer'\)/);
});

test('Das Copy-Menü bleibt auch bei schmalen Viewports vollständig sichtbar', () => {
  assert.match(APP, /await buildMenu\(\);[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?keepFilterAriaMenuVisible\(\$copyMenu\)/);
  assert.match(CSS, /\.copy-prompt-menu \{[\s\S]*?min-width:\s*min\(200px, calc\(100vw - 16px\)\);[\s\S]*?max-width:\s*calc\(100vw - 16px\);/);
  assert.match(CSS, /\.detail-copy-wrap > \.copy-prompt-menu \{ width:\s*max-content; \}/);
  assert.match(CSS, /\.copy-prompt-item \{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
});
