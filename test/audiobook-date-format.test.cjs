const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const audiobooks = fs.readFileSync(path.join(ROOT, 'public', 'audiobooks.js'), 'utf8');

test('Hörbuch-Detailansicht zeigt nur den ausgeschriebenen Monat und das Jahr', () => {
  const match = app.match(/function formatMonthYear\(d\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'formatMonthYear fehlt');

  const context = {};
  vm.runInNewContext(`${match[0]}; result = formatMonthYear('2025-09-25');`, context);
  assert.equal(context.result, 'September 2025');
  assert.match(audiobooks, /detail-date-block[^\n]*formatMonthYear\(book\.date\)/);
});
