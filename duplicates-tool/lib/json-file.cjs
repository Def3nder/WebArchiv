// Atomisches Schreiben von JSON (Temp-Datei + rename), wie user-store.cjs im WebArchiv.
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

async function writeJsonAtomic(file, data, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    const handle = await io.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await io.rename(temp, file);
  } catch (error) {
    await io.unlink(temp).catch(() => {});
    throw error;
  }
}

module.exports = { writeJsonAtomic };
