const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Externe Prompt-Ziele erzeugen unter iOS kein zusätzliches leeres Fenster', () => {
  assert.match(APP, /const isIosPromptNavigation = \(\) => \/iPad\|iPhone\|iPod\//);
  assert.match(APP, /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/);
  assert.match(APP, /if \(new URL\(url\)\.hostname === 'gemini\.google\.com'\) return 'googlegemini:\/\/'/);
  assert.match(APP, /if \(opensExternalPrompt && isIosPromptNavigation\(\)\) \{[\s\S]*await copyArticle[\s\S]*window\.location\.assign\(iosPromptTarget\(selected\.url\)\);/);
  assert.match(APP, /if \(opensExternalPrompt\) window\.open\(selected\.url, '_blank', 'noopener,noreferrer'\)/);
});
