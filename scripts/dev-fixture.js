#!/usr/bin/env node
// WebArchiv lokal auf dem Testarchiv starten (npm run dev:fixture): baut test/fixtures/smoke-archive.cjs in einem
// temporären Ordner, startet server.js darauf und bereitet alle Fälle vor (verknüpfte und ignorierte Dubletten,
// Grafik-Umzug, privates Hörbuch) – derselbe Stand wie in test/fixture-archive.test.cjs. So lässt sich jeder Fall
// im Browser ansehen, ohne das echte Archiv. Strg+C beendet und löscht den Ordner.
//
//   npm run dev:fixture                    → http://localhost:3100
//   PORT=3200 npm run dev:fixture          → anderer Port
//   npm run dev:fixture -- --keep          → Ordner nach dem Beenden behalten (Pfad wird angezeigt)
//
// Kennwörter sind Testwerte und gelten nur für diesen Lauf; der Datei-Watcher ist an, Änderungen im
// Testordner erscheinen also nach wenigen Sekunden.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CASES, USERS } = require('../test/fixtures/smoke-archive.cjs');
const { startFixtureArchive } = require('../test/support/fixture-server.cjs');

const keep = process.argv.includes('--keep');
const port = process.env.PORT || '3100';

async function main() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webarchiv-dev-fixture-'));
  console.log(`Testarchiv wird gebaut: ${dir}`);
  let server;
  let passwords;
  try {
    ({ server, passwords } = await startFixtureArchive(dir, { echo: true, env: { PORT: port, WATCH_ARCHIVE: '1' } }));
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }

  console.log(`\nTestarchiv läuft: ${server.base.replace('127.0.0.1', 'localhost')}  (${CASES.length} Fälle, CSP erzwungen)`);
  console.log('Anmeldungen (nur für diesen Lauf):');
  for (const [role, user] of Object.entries(USERS)) console.log(`  ${role.padEnd(7)} ${user.email.padEnd(20)} ${passwords[role]}`);
  console.log('  Gast    ohne Anmeldung – sieht nur Videos, PDF, Infografiken');
  console.log(`Fälle und erwartete Ergebnisse: test/fixtures/smoke-archive.cjs\nBeenden mit Strg+C${keep ? ' (Ordner bleibt erhalten)' : ''}.\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    if (keep) console.log(`\nTestarchiv behalten: ${dir}`);
    else await fs.promises.rm(dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Stirbt der Server von selbst, nicht weiterlaufen und den Ordner trotzdem aufräumen.
  server.exited.then(async code => {
    if (stopping) return;
    console.error(`
Server beendet (${code}).`);
    await stop();
  });
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
