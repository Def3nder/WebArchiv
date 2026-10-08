const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Ein erfolgreicher Infografik-Upload aktualisiert den geöffneten Artikel', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(
    app,
    /const detailPosition = captureDetailPosition\(\)[\s\S]*?await uploadInfographic\(article, file\)[\s\S]*?await loadArticles\(\)[\s\S]*?currentViewItemId === article\.id[\s\S]*?await openArticle\(article\.id, \{ historyMode: 'none', detailPosition \}\)/,
  );
});
