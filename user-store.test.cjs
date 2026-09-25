const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { createUserStore } = require('./user-store.cjs');

async function fixture(t, { users, publicDirs = ['Videos'] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-users-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const usersFile = path.join(dir, 'users.json');
  const publicFile = path.join(dir, 'public-directories.txt');
  const hash = await bcrypt.hash('altes-kennwort', 4);
  const initial = users ?? {
    _comment: 'bleibt erhalten',
    users: [
      { email: 'Admin@example.org', passwordHash: hash, role: 'admin', allowedAuthors: null },
      { email: 'leser@example.org', passwordHash: hash, role: 'user', allowedAuthors: ['Joe Turan'], extra: 1 },
    ],
  };
  await fs.writeFile(usersFile, JSON.stringify(initial));
  await fs.writeFile(publicFile, JSON.stringify({ 'public-directories': publicDirs, note: 'x' }));
  const store = createUserStore({ usersFile, publicFile });
  store.load();
  const readUsers = async () => JSON.parse(await fs.readFile(usersFile, 'utf8'));
  return { store, dir, usersFile, publicFile, readUsers };
}
const newUser = { email: 'neu@example.org', role: 'user', allowedAuthors: ['PDF'], password: 'geheim123', mustChangePassword: true };

test('Anlegen erhält Dateiformat und unbekannte Felder, speichert nur den Hash', async t => {
  const f = await fixture(t);
  const created = await f.store.create(newUser);
  assert.deepEqual(created, { email: 'neu@example.org', role: 'user', allowedAuthors: ['PDF'], mustChangePassword: true, hasPassword: true });
  const saved = await f.readUsers();
  assert.equal(saved._comment, 'bleibt erhalten');
  assert.equal(saved.users[1].extra, 1);
  assert.equal(saved.users[2].password, undefined);
  assert.ok(await bcrypt.compare('geheim123', saved.users[2].passwordHash));
  assert.deepEqual((await fs.readdir(f.dir)).sort(), ['public-directories.txt', 'users.json']);
  await assert.rejects(f.store.create({ ...newUser, email: 'NEU@example.org' }), { status: 409 });
});

test('Eingaben werden geprüft', async t => {
  const f = await fixture(t);
  for (const input of [
    { ...newUser, email: 'keine-mail' },
    { ...newUser, role: 'root' },
    { ...newUser, allowedAuthors: 'PDF' },
    { ...newUser, allowedAuthors: ['../etc'] },
    { ...newUser, password: 'kurz' },
    { ...newUser, password: 'ä'.repeat(40) },
    { ...newUser, mustChangePassword: undefined },
  ]) await assert.rejects(f.store.create(input), { status: 400 });
});

test('Anmeldung und Sitzungsauflösung inklusive öffentlicher Autoren', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.authenticate('leser@example.org', 'falsch'), null);
  assert.equal(await f.store.authenticate('unbekannt@example.org', 'altes-kennwort'), null);
  const auth = await f.store.authenticate('LESER@example.org', 'altes-kennwort');
  assert.deepEqual(auth, { email: 'leser@example.org', sessionVersion: 0 });
  const session = f.store.sessionUser(auth);
  assert.deepEqual(session.allowedAuthors, ['Joe Turan', 'Videos']);
  assert.equal(f.store.sessionUser({ email: 'admin@example.org' }).allowedAuthors, null);
  // Alte Sitzungen ohne sessionVersion bleiben gültig.
  assert.ok(f.store.sessionUser({ email: 'leser@example.org' }));
});

test('Rechte ändern wirkt sofort; eigene Rolle und letzter Admin sind geschützt', async t => {
  const f = await fixture(t);
  await f.store.update('leser@example.org', { allowedAuthors: null, role: 'admin' }, 'admin@example.org');
  assert.equal(f.store.sessionUser({ email: 'leser@example.org' }).role, 'admin');
  await assert.rejects(f.store.update('admin@example.org', { role: 'user' }, 'admin@example.org'), { status: 409 });
  await f.store.update('leser@example.org', { role: 'user' }, 'admin@example.org');
  await assert.rejects(f.store.update('admin@example.org', { role: 'user' }, 'leser@example.org'), { status: 409 });
  await assert.rejects(f.store.update('fehlt@example.org', { role: 'user' }, 'admin@example.org'), { status: 404 });
});

test('Löschen: nicht sich selbst und nicht den letzten Admin', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.remove('admin@example.org', 'admin@example.org'), { status: 409 });
  await assert.rejects(f.store.remove('admin@example.org', 'leser@example.org'), { status: 409 });
  await f.store.remove('leser@example.org', 'admin@example.org');
  assert.equal(f.store.sessionUser({ email: 'leser@example.org' }), null);
  assert.equal((await f.readUsers()).users.length, 1);
});

test('Kennwort neu vergeben beendet alte Sitzungen und setzt die Änderungspflicht', async t => {
  const f = await fixture(t);
  const old = await f.store.authenticate('leser@example.org', 'altes-kennwort');
  await f.store.setPassword('leser@example.org', { password: 'neues-kennwort', mustChangePassword: true });
  assert.equal(f.store.sessionUser(old), null);
  const auth = await f.store.authenticate('leser@example.org', 'neues-kennwort');
  assert.equal(f.store.sessionUser(auth).mustChangePassword, true);
  await f.store.setPassword('leser@example.org', { password: 'behalten-123', mustChangePassword: false });
  const kept = await f.store.authenticate('leser@example.org', 'behalten-123');
  assert.equal(f.store.sessionUser(kept).mustChangePassword, false);
});

test('Eigenes Kennwort ändern prüft das alte Kennwort und hebt die Pflicht auf', async t => {
  const f = await fixture(t);
  await f.store.setPassword('leser@example.org', { password: 'start-kennwort', mustChangePassword: true });
  await assert.rejects(f.store.changeOwnPassword('leser@example.org', { currentPassword: 'falsch', newPassword: 'anderes-kennwort' }), { status: 400 });
  await assert.rejects(f.store.changeOwnPassword('leser@example.org', { currentPassword: 'start-kennwort', newPassword: 'start-kennwort' }), { status: 400 });
  const { sessionVersion } = await f.store.changeOwnPassword('leser@example.org', { currentPassword: 'start-kennwort', newPassword: 'eigenes-kennwort' });
  const session = f.store.sessionUser({ email: 'leser@example.org', sessionVersion });
  assert.equal(session.mustChangePassword, false);
  assert.ok(await f.store.authenticate('leser@example.org', 'eigenes-kennwort'));
});

test('Handänderungen an users.json werden beim nächsten Speichern übernommen', async t => {
  const f = await fixture(t);
  const data = await f.readUsers();
  data.users.push({ email: 'hand@example.org', passwordHash: 'x', role: 'user', allowedAuthors: [] });
  await fs.writeFile(f.usersFile, JSON.stringify(data));
  await f.store.create(newUser);
  assert.deepEqual((await f.readUsers()).users.map(u => u.email),
    ['Admin@example.org', 'leser@example.org', 'hand@example.org', 'neu@example.org']);
});

test('Gleichzeitige Änderungen gehen nicht verloren; Listenformat bleibt Liste', async t => {
  const f = await fixture(t, { users: [] });
  await Promise.all([1, 2, 3].map(i => f.store.create({ ...newUser, email: `n${i}@example.org` })));
  const saved = await f.readUsers();
  assert.ok(Array.isArray(saved));
  assert.equal(saved.length, 3);
});

test('Öffentliche Autoren werden beim Speichern aus der Nutzerliste entfernt', async t => {
  const f = await fixture(t);
  await f.store.update('leser@example.org', { allowedAuthors: ['Videos', 'Joe Turan'] }, 'admin@example.org');
  const created = await f.store.create({ ...newUser, allowedAuthors: ['Videos', 'PDF'] });
  assert.deepEqual(created.allowedAuthors, ['PDF']);
  assert.deepEqual((await f.readUsers()).users[1].allowedAuthors, ['Joe Turan']);
  assert.deepEqual(f.store.sessionUser({ email: 'leser@example.org' }).allowedAuthors, ['Joe Turan', 'Videos']);
});

test('Öffentliche Autoren werden gespeichert und wirken sofort', async t => {
  const f = await fixture(t);
  await f.store.setPublicAuthors(['PDF', 'PDF', ' Infografiken ']);
  assert.deepEqual(f.store.publicAuthors, ['PDF', 'Infografiken']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.publicFile, 'utf8')), { 'public-directories': ['PDF', 'Infografiken'], note: 'x' });
  assert.deepEqual(f.store.sessionUser({ email: 'leser@example.org' }).allowedAuthors, ['Joe Turan', 'PDF', 'Infografiken']);
  await assert.rejects(f.store.setPublicAuthors(null), { status: 400 });
});
