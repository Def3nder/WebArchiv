'use strict';

// Testarchiv (Review 3.5): Der echte Server läuft als eigener Prozess auf dem Archiv aus
// test/fixtures/smoke-archive.cjs; jeder Fall dort prüft seine erwarteten Ergebnisse über die API.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CASES } = require('./fixtures/smoke-archive.cjs');
const { startFixtureArchive } = require('./support/fixture-server.cjs');

describe('Testarchiv: Fälle über die API', () => {
  let dir;
  let server;
  let ctx;

  before(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webarchiv-fixture-'));
    ({ server, ctx } = await startFixtureArchive(dir));
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
