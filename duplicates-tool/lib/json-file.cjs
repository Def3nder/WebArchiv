// Atomares Schreiben von JSON über lib/atomic-file.cjs des WebArchiv; legt den Ordner bei Bedarf an.
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { writeJsonAtomic: writeArchiveJson } = require('../../lib/atomic-file.cjs');

async function writeJsonAtomic(file, data, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true });
  return writeArchiveJson(file, data, io, 0o600);
}

module.exports = { writeJsonAtomic };
