'use strict';

// Testarchiv (Review 3.5): Der echte Server läuft als eigener Prozess auf dem Archiv aus
// test/fixtures/smoke-archive.cjs; jeder Fall dort prüft seine erwarteten Ergebnisse über die API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CASES, USERS, build } = require('./fixtures/smoke-archive.cjs');
const { startFixtureServer, client } = require('./support/fixture-server.cjs');

describe('Testarchiv: Fälle über die API', () => {
  let dir;
  let server;
  const ctx = { migrations: {} };

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webarchiv-fixture-'));
    const { env, passwords } = await build(dir);
    server = await startFixtureServer(env);
    const clients = { guest: client(server.base) };
    for (const [role, user] of Object.entries(USERS)) {
      clients[role] = client(server.base);
      await clients[role].login(user.email, passwords[role]);
    }
    const query = params => new URLSearchParams(params).toString();
    // Alle Seiten einer Liste (höchstens 100 Einträge je Seite).
    const allPages = async (role, url, params) => {
      const items = [];
      for (let page = 1; ; page++) {
        const res = await clients[role].get(`${url}?${query({ limit: '100', ...params, page: String(page) })}`);
        assert.equal(res.status, 200, `${url} ${JSON.stringify(params)}: ${JSON.stringify(res.data)}`);
        items.push(...res.data.items);
        if (page >= (res.data.pages || 1)) return items;
      }
    };
    Object.assign(ctx, {
      as: role => clients[role],
      list: (role, params = {}) => allPages(role, '/api/articles', params),
      tiles: (role, params = {}) => allPages(role, '/api/articles', { ...params, group: '1' }),
      books: (role, params = {}) => allPages(role, '/api/audiobooks', params),
      async detail(role, id) {
        const res = await clients[role].get(`/api/articles/${encodeURI(id)}`);
        assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.data)}`);
        return res.data;
      },
      async duplicateAction(body) {
        const res = await clients.admin.post('/api/duplicates', body);
        assert.equal(res.status, 200, `${JSON.stringify(body)}: ${JSON.stringify(res.data)}`);
        return res.data;
      },
    });

    // Vorbereitung über die echten Routen, danach Dateiänderungen und ein frischer Reindex.
    for (const testCase of CASES) if (testCase.setup) await testCase.setup(ctx);
    const edits = CASES.filter(testCase => testCase.edit);
    for (const { edit } of edits) await fs.promises.appendFile(path.join(dir, edit.file), edit.append);
    if (edits.length) {
      assert.equal((await clients.admin.post('/api/reindex')).status, 200);
      for (let i = 0; (await clients.admin.get('/api/reindex/status')).data.running; i++) {
        assert.ok(i < 300, 'Reindex wird nicht fertig');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    ctx.duplicates = (await clients.admin.get('/api/duplicates')).data;
    ctx.pending = ctx.duplicates.pending;
  });

  after(async () => {
    await server?.stop();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  for (const testCase of CASES) {
    it(`${testCase.id} ${testCase.title}`, () => testCase.check(ctx));
  }

  it('Keine Konsolenfehler des Servers beim Aufbau und bei allen Fällen', () => {
    const errors = server.log().split('\n').filter(line => /error|fehler/i.test(line) && !/Index-Cache/.test(line));
    assert.deepEqual(errors, []);
  });
});
