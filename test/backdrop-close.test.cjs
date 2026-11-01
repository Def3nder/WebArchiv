'use strict';

// Klick neben den Dialog schließt „Kennwort ändern“ (Admin- und Nutzer-Shell) und „Benutzerverwaltung“.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const USER_ADMIN = read('user-admin.js');
const PASSWORD = read('password.js');

function loadHelper(source) {
  const start = source.indexOf('function outsideDialog(');
  const end = source.indexOf('closeOnBackdrop($pwDialog');
  assert.ok(start > 0 && end > start, 'Hilfsfunktionen vorhanden');
  return new Function(`${source.slice(start, end)}; return closeOnBackdrop;`)();
}

function fakeDialog() {
  const listeners = {};
  const dialog = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left: 100, right: 500, top: 50, bottom: 450 }),
    fire(type, { x, y, target = dialog }) { listeners[type]({ type, clientX: x, clientY: y, target }); },
  };
  return dialog;
}

for (const [file, source] of [['user-admin.js', USER_ADMIN], ['password.js', PASSWORD]]) {
  test(`${file}: Klick auf den Hintergrund schließt, aus dem Dialog gezogene Markierung nicht`, () => {
    const closeOnBackdrop = loadHelper(source);
    const dialog = fakeDialog();
    let closed = 0;
    closeOnBackdrop(dialog, () => closed++);
    const outside = { x: 20, y: 300 };
    const inside = { x: 300, y: 300 };

    dialog.fire('pointerdown', outside);
    dialog.fire('click', outside);
    assert.equal(closed, 1, 'Druck und Klick daneben');

    // Markierung im Eingabefeld begonnen und daneben losgelassen: click landet am Dialog, schließt aber nicht.
    dialog.fire('pointerdown', { ...inside, target: {} });
    dialog.fire('click', outside);
    assert.equal(closed, 1, 'Druck im Dialog');

    // Klick in den Innenabstand des Dialogs (target ist der Dialog selbst, aber innerhalb des Rechtecks).
    dialog.fire('pointerdown', inside);
    dialog.fire('click', inside);
    assert.equal(closed, 1, 'Innenabstand');
  });

  test(`${file}: Kennwort-Dialog schließt per Klick daneben nur wie Escape`, () => {
    assert.match(source, /closeOnBackdrop\(\$pwDialog, \(\) => \{ if \(!pwState\.forced && !pwState\.busy\) finishPasswordDialog\(false\); \}\);/);
  });
}

test('Benutzerverwaltung schließt per Klick daneben über closeUserAdmin (Rückfrage bei Änderungen)', () => {
  assert.match(USER_ADMIN, /closeOnBackdrop\(\$ua, closeUserAdmin\);/);
  assert.match(USER_ADMIN, /function closeUserAdmin\(\) \{\s*if \(ua\.busy \|\| !uaConfirmDiscard\(\)\) return;/);
});
