const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt wertet nur die ersten 72 Byte aus.
const ROLES = ['admin', 'user'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Vergleich gegen einen Dummy-Hash, damit unbekannte E-Mails nicht schneller abgewiesen werden.
const DUMMY_HASH = bcrypt.hashSync('webarchiv-dummy-password', 4);
const fail = (status, message) => Object.assign(new Error(message), { status });
const sameEmail = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function readJson(file, fallback) {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Temporäre Datei im selben Verzeichnis, danach atomar ersetzen; Rechte/Eigentümer bleiben erhalten.
async function writeJsonAtomic(file, data, io, defaultMode) {
  let stat = null;
  try { stat = await io.stat(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const mode = stat ? stat.mode & 0o777 : defaultMode;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    const handle = await io.open(temp, 'wx', mode);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
      if (process.platform !== 'win32') {
        if (stat) await handle.chown(stat.uid, stat.gid).catch(() => {});
        await handle.chmod(mode);
      }
      await handle.sync();
    } finally { await handle.close(); }
    await io.rename(temp, file);
  } catch (err) {
    await io.unlink(temp).catch(() => {});
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw fail(500, `${path.basename(file)} konnte nicht gespeichert werden: keine Schreibberechtigung.`);
    }
    throw err;
  }
}

function normalizeEmail(value) {
  const email = String(value ?? '').trim();
  if (!EMAIL_RE.test(email) || email.length > 254) throw fail(400, 'Bitte eine gültige E-Mail-Adresse angeben.');
  return email;
}
function normalizeRole(value) {
  if (!ROLES.includes(value)) throw fail(400, 'Die Rolle muss „user“ oder „admin“ sein.');
  return value;
}
function normalizeAuthors(value, label = 'Autorenliste') {
  if (value === null) return null;
  if (!Array.isArray(value)) throw fail(400, `${label} ist ungültig.`);
  const out = [];
  for (const raw of value) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > 200 || /[\\/\0]/.test(name)) throw fail(400, `${label} enthält einen ungültigen Autorennamen.`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
function checkPassword(value) {
  if (typeof value !== 'string' || [...value].length < MIN_PASSWORD) {
    throw fail(400, `Das Kennwort muss mindestens ${MIN_PASSWORD} Zeichen lang sein.`);
  }
  if (Buffer.byteLength(value) > MAX_PASSWORD_BYTES) throw fail(400, 'Das Kennwort ist zu lang (höchstens 72 Byte).');
  return value;
}
function checkMustChange(value) {
  if (typeof value !== 'boolean') throw fail(400, 'Bitte festlegen, ob das Kennwort bei der nächsten Anmeldung geändert werden muss.');
  return value;
}

function createUserStore({ usersFile, publicFile, io = fs }) {
  let users = [];
  let usersShape = null;   // null = reine Liste, sonst Objekt mit weiteren Schlüsseln (z. B. _comment)
  let publicDoc = {};
  let publicAuthors = [];
  let queue = Promise.resolve();

  function parseUsers(parsed) {
    if (Array.isArray(parsed)) return { list: parsed, shape: null };
    if (parsed && Array.isArray(parsed.users)) return { list: parsed.users, shape: parsed };
    throw new Error('users.json enthält weder eine Liste noch ein Feld "users".');
  }
  function loadUsers() {
    const { list, shape } = parseUsers(readJson(usersFile, []));
    users = list;
    usersShape = shape;
  }
  function loadPublic() {
    publicDoc = readJson(publicFile, {}) || {};
    const list = publicDoc['public-directories'];
    publicAuthors = Array.isArray(list) ? list.filter(a => typeof a === 'string') : [];
  }
  // Schreibvorgänge nacheinander; jede Änderung liest die Datei frisch ein,
  // damit Handänderungen (z. B. per hash-passwords.js) nicht überschrieben werden.
  function exclusive(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }
  function mutateUsers(change) {
    return exclusive(async () => {
      loadUsers();
      const result = await change(users);
      await writeJsonAtomic(usersFile, usersShape ? { ...usersShape, users } : users, io, 0o600);
      return result;
    });
  }

  const find = (list, email) => list.find(u => sameEmail(u.email, email));
  // Öffentliche Autoren sieht jeder Nutzer ohnehin; in der Nutzerliste werden sie nicht gespeichert.
  const withoutPublic = authors => authors === null ? null : authors.filter(a => !publicAuthors.includes(a));
  const adminCount = list => list.filter(u => u.role === 'admin').length;
  function requireUser(list, email) {
    const user = find(list, email);
    if (!user) throw fail(404, 'Nutzer nicht gefunden.');
    return user;
  }
  function publicView(u) {
    return {
      email: u.email,
      role: u.role,
      allowedAuthors: u.allowedAuthors ?? null,
      mustChangePassword: !!u.mustChangePassword,
      hasPassword: !!u.passwordHash,
    };
  }

  return {
    load() {
      try { loadUsers(); } catch (err) { console.error('WARNING: users.json nicht geladen —', err.message); }
      try { loadPublic(); } catch (err) { console.warn('public-directories.txt nicht geladen —', err.message); }
    },
    get publicAuthors() { return publicAuthors; },
    list: () => users.map(publicView),

    // Rechte werden bei jeder Anfrage frisch aufgelöst; öffentliche Autoren kommen immer hinzu.
    sessionUser(auth) {
      const user = auth && find(users, auth.email);
      if (!user || (user.sessionVersion || 0) !== (auth.sessionVersion || 0)) return null;
      const own = user.allowedAuthors ?? null;
      return {
        email: user.email,
        role: user.role,
        allowedAuthors: own === null ? null : [...new Set([...own, ...publicAuthors])],
        mustChangePassword: !!user.mustChangePassword,
        sessionVersion: user.sessionVersion || 0,
      };
    },

    async authenticate(email, password) {
      const user = find(users, email);
      const ok = await bcrypt.compare(String(password || ''), user?.passwordHash || DUMMY_HASH);
      return ok && user?.passwordHash ? { email: user.email, sessionVersion: user.sessionVersion || 0 } : null;
    },

    async create(input) {
      const email = normalizeEmail(input?.email);
      const role = normalizeRole(input?.role);
      const allowedAuthors = normalizeAuthors(input?.allowedAuthors);
      const passwordHash = await bcrypt.hash(checkPassword(input?.password), BCRYPT_ROUNDS);
      const mustChangePassword = checkMustChange(input?.mustChangePassword);
      return mutateUsers(list => {
        if (find(list, email)) throw fail(409, 'Diese E-Mail-Adresse ist bereits vergeben.');
        const user = { email, passwordHash, role, allowedAuthors: withoutPublic(allowedAuthors), mustChangePassword };
        list.push(user);
        return publicView(user);
      });
    },

    async update(email, input, actorEmail) {
      const role = input?.role === undefined ? undefined : normalizeRole(input.role);
      const allowedAuthors = input?.allowedAuthors === undefined ? undefined : normalizeAuthors(input.allowedAuthors);
      const mustChangePassword = input?.mustChangePassword === undefined ? undefined : checkMustChange(input.mustChangePassword);
      return mutateUsers(list => {
        const user = requireUser(list, email);
        if (role !== undefined && role !== user.role) {
          if (sameEmail(user.email, actorEmail)) throw fail(409, 'Die eigene Rolle kann nicht geändert werden.');
          if (user.role === 'admin' && adminCount(list) <= 1) throw fail(409, 'Der letzte Administrator kann nicht herabgestuft werden.');
          user.role = role;
        }
        if (allowedAuthors !== undefined) user.allowedAuthors = withoutPublic(allowedAuthors);
        if (mustChangePassword !== undefined) user.mustChangePassword = mustChangePassword;
        return publicView(user);
      });
    },

    // Neues Kennwort durch den Admin; andere Sitzungen des Nutzers werden ungültig.
    async setPassword(email, input) {
      const passwordHash = await bcrypt.hash(checkPassword(input?.password), BCRYPT_ROUNDS);
      const mustChangePassword = checkMustChange(input?.mustChangePassword);
      return mutateUsers(list => {
        const user = requireUser(list, email);
        user.passwordHash = passwordHash;
        delete user.password;
        user.mustChangePassword = mustChangePassword;
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        return { ...publicView(user), sessionVersion: user.sessionVersion };
      });
    },

    async remove(email, actorEmail) {
      return mutateUsers(list => {
        const user = requireUser(list, email);
        if (sameEmail(user.email, actorEmail)) throw fail(409, 'Der eigene Zugang kann nicht gelöscht werden.');
        if (user.role === 'admin' && adminCount(list) <= 1) throw fail(409, 'Der letzte Administrator kann nicht gelöscht werden.');
        list.splice(list.indexOf(user), 1);
        return { deleted: true };
      });
    },

    async changeOwnPassword(email, input) {
      const current = String(input?.currentPassword || '');
      const next = checkPassword(input?.newPassword);
      const user = find(users, email);
      if (!user || !(await bcrypt.compare(current, user.passwordHash || DUMMY_HASH))) {
        throw fail(400, 'Das aktuelle Kennwort ist nicht korrekt.');
      }
      if (next === current) throw fail(400, 'Das neue Kennwort muss sich vom bisherigen unterscheiden.');
      const passwordHash = await bcrypt.hash(next, BCRYPT_ROUNDS);
      return mutateUsers(list => {
        const fresh = requireUser(list, email);
        if (fresh.passwordHash !== user.passwordHash) throw fail(409, 'Das Kennwort wurde inzwischen geändert. Bitte erneut anmelden.');
        fresh.passwordHash = passwordHash;
        fresh.mustChangePassword = false;
        fresh.sessionVersion = (fresh.sessionVersion || 0) + 1;
        return { sessionVersion: fresh.sessionVersion };
      });
    },

    async setPublicAuthors(value) {
      const authors = normalizeAuthors(value, 'Liste der öffentlichen Autoren');
      if (authors === null) throw fail(400, 'Liste der öffentlichen Autoren ist ungültig.');
      return exclusive(async () => {
        loadPublic();
        const doc = { ...publicDoc, 'public-directories': authors };
        await writeJsonAtomic(publicFile, doc, io, 0o644);
        publicDoc = doc;
        publicAuthors = authors;
        return { publicAuthors };
      });
    },
  };
}

function installUserRoutes(app, { store, requireAuth, requireAdmin, getAuthors }) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.method !== 'GET' && req.get('sec-fetch-site') === 'cross-site') {
        throw fail(403, 'Änderungen sind nur aus dem Archiv erlaubt.');
      }
      res.json(await handler(req));
    } catch (error) {
      if (!error.status) console.error('Benutzerverwaltung:', error);
      res.status(error.status || 500).json({ error: error.status ? error.message : 'Die Änderung konnte nicht gespeichert werden.' });
    }
  };
  const actor = req => req.session.user.email;
  const overview = req => ({
    users: store.list(),
    authors: getAuthors(),
    publicAuthors: store.publicAuthors,
    self: actor(req),
  });

  app.get('/api/users', requireAdmin, route(overview));
  app.post('/api/users', requireAdmin, route(req => store.create(req.body)));
  app.patch('/api/users/:email', requireAdmin, route(req => store.update(req.params.email, req.body, actor(req))));
  app.post('/api/users/:email/password', requireAdmin, route(async req => {
    const result = await store.setPassword(req.params.email, req.body);
    // Eigene Sitzung bleibt gültig, wenn der Admin sein eigenes Kennwort neu vergibt.
    if (sameEmail(result.email, actor(req))) req.session.user.sessionVersion = result.sessionVersion;
    delete result.sessionVersion;
    return result;
  }));
  app.delete('/api/users/:email', requireAdmin, route(req => store.remove(req.params.email, actor(req))));
  app.put('/api/public-authors', requireAdmin, route(req => store.setPublicAuthors(req.body?.authors)));
  app.post('/api/me/password', requireAuth, route(async req => {
    const { sessionVersion } = await store.changeOwnPassword(actor(req), req.body);
    req.session.user = { ...store.sessionUser({ email: actor(req), sessionVersion }) };
    return { changed: true };
  }));
}

module.exports = { createUserStore, installUserRoutes, MIN_PASSWORD };
