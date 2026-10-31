'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { resolveMediaRequest, installMediaRoutes } = require('../modules/media-files.cjs');
const { AUDIOBOOK_AUTHOR, createAudiobookLibrary, createProgressStore } = require('../modules/audiobooks.cjs');

const SECRET = 'GEHEIMER-INHALT';
const USERS = {
  guest: { email: null, role: 'guest', allowedAuthors: ['Videos', 'Infografiken'] },
  reader: { email: 'leser@example.test', role: 'user', allowedAuthors: ['Videos', AUDIOBOOK_AUTHOR] },
  admin: { email: 'admin@example.test', role: 'admin', allowedAuthors: null },
};

// Entspricht canAccessAuthor in server.js.
function canAccessAuthor(user, author) {
  if (!user) return false;
  if (author === AUDIOBOOK_AUTHOR && user.role === 'guest') return false;
  if (user.allowedAuthors === null) return true;
  return user.allowedAuthors.includes(author);
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webarchiv-media-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const www = path.join(dir, 'www');
  const audio = path.join(dir, 'audio');
  await write(path.join(www, 'Videos', '2026', 'clip.jpg'), 'oeffentlich');
  await write(path.join(www, 'Joe Turan', '2026', 'geheim.jpg'), SECRET);
  await write(path.join(www, 'Infografiken', '2026', 'grafik.png'), 'grafik');
  await write(path.join(www, 'Infografiken', 'trash', '2026', 'vorgang', 'alt.png'), SECRET);
  await write(path.join(audio, 'Videos', '2026', 'clip.mp3'), 'oeffentlich');
  await write(path.join(audio, 'Joe Turan', '2026', 'geheim.mp3'), SECRET);
  await write(path.join(audio, 'trash', 'alt.mp3'), SECRET);
  await write(path.join(audio, 'Hoerbuecher', 'Privat - Buch', '01 - Intro.mp3'), SECRET);
  await write(path.join(audio, 'Hoerbuecher', 'Offen - Buch', '01 - Intro.m4b'), 'buch');
  await write(path.join(dir, 'users.json'), SECRET);

  const progress = createProgressStore({ file: path.join(dir, 'progress.json') });
  progress.load();
  const audiobooks = createAudiobookLibrary({
    audioRoot: audio, progress, excerpt: text => text, renderMarkdown: text => text,
  });
  await audiobooks.rebuild();
  const privateBook = audiobooks.books.find(book => book.bookDir === 'Privat - Buch');
  await progress.setPrivate(privateBook.id, true);

  const app = express();
  installMediaRoutes(app, {
    wwwDir: www, audioDir: audio, infographicsAuthor: 'Infografiken', audiobookAuthor: AUDIOBOOK_AUTHOR,
    audiobooks, canAccessAuthor,
    attachUser: (req, _res, next) => { req.user = USERS[req.get('x-test-user') || 'guest']; next(); },
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  // Pfade unverändert senden (wie curl --path-as-is oder ein Proxy ohne URI-Bereinigung).
  const get = (requestPath, user = 'guest') => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: requestPath, headers: { 'x-test-user': user } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    }).on('error', reject);
  });
  return { www, get };
}

test('resolveMediaRequest: Punktsegmente werden abgewiesen, normale Pfade aufgelöst', () => {
  const root = path.resolve('archiv-wurzel');
  const ok = resolveMediaRequest(root, 'Joe Turan/2026/Ä ö & Bild.jpg');
  assert.equal(ok.relPath, 'Joe Turan/2026/Ä ö & Bild.jpg');
  assert.deepEqual(ok.segments, ['Joe Turan', '2026', 'Ä ö & Bild.jpg']);
  assert.equal(ok.absPath, path.join(root, 'Joe Turan', '2026', 'Ä ö & Bild.jpg'));
  for (const bad of ['', 'Videos/../Joe Turan/x.jpg', 'Videos/./x.jpg', 'Videos\\..\\x.jpg', '../users.json',
    'Videos//x.jpg', 'Videos/.. /x.jpg', 'Videos/x.jpg\0.png', 'Videos/']) {
    assert.equal(resolveMediaRequest(root, bad), null, bad);
  }
});

test('/files: Autorrechte gelten wie bisher', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/files/Videos/2026/clip.jpg')).status, 200);
  assert.equal((await get('/files/Joe%20Turan/2026/geheim.jpg')).status, 403);
  const admin = await get('/files/Joe%20Turan/2026/geheim.jpg', 'admin');
  assert.equal(admin.status, 200);
  assert.equal(admin.body, SECRET);
});

test('/files: Umgehung über öffentliche Autoren mit .., kodierten Trennern und Backslash ist gesperrt', async t => {
  const { get } = await fixture(t);
  for (const requestPath of [
    '/files/Videos/../Joe%20Turan/2026/geheim.jpg',
    '/files/Videos/%2e%2e/Joe%20Turan/2026/geheim.jpg',
    '/files/Videos/%2E%2E/Joe%20Turan/2026/geheim.jpg',
    '/files/Videos%2f..%2fJoe%20Turan/2026/geheim.jpg',
    '/files/Videos%2F%2e%2e%2FJoe%20Turan/2026/geheim.jpg',
    '/files/Videos/..%5cJoe%20Turan/2026/geheim.jpg',
    '/files/Videos/2026/..%2f..%2f..%2fusers.json',
    '/files/Infografiken/2026/../trash/2026/vorgang/alt.png',
  ]) {
    const response = await get(requestPath);
    assert.equal(response.status, 400, requestPath);
    assert.doesNotMatch(response.body, new RegExp(SECRET), requestPath);
  }
});

test('/files: Infografik-Papierkorb bleibt auch für Admins gesperrt', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/files/Infografiken/2026/grafik.png')).status, 200);
  assert.equal((await get('/files/Infografiken/trash/2026/vorgang/alt.png', 'admin')).status, 404);
  assert.equal((await get('/files/Infografiken/TRASH/2026/vorgang/alt.png', 'admin')).status, 404);
});

test('/audio-files: Umgehung von Autorrechten, Papierkorb und privaten Hörbüchern ist gesperrt', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/audio-files/Videos/2026/clip.mp3')).status, 200);
  assert.equal((await get('/audio-files/Joe%20Turan/2026/geheim.mp3')).status, 403);
  for (const [requestPath, user] of [
    ['/audio-files/Videos/../Joe%20Turan/2026/geheim.mp3', 'guest'],
    ['/audio-files/Videos/%2e%2e/Joe%20Turan/2026/geheim.mp3', 'guest'],
    ['/audio-files/Videos%2f..%2ftrash/alt.mp3', 'admin'],
    ['/audio-files/Videos/../Hoerbuecher/Privat%20-%20Buch/01%20-%20Intro.mp3', 'guest'],
    ['/audio-files/Videos/%2e%2e/Hoerbuecher/Privat%20-%20Buch/01%20-%20Intro.mp3', 'reader'],
    ['/audio-files/Hoerbuecher/Offen%20-%20Buch/..%2fPrivat%20-%20Buch/01%20-%20Intro.mp3', 'reader'],
  ]) {
    const response = await get(requestPath, user);
    assert.equal(response.status, 400, requestPath);
    assert.doesNotMatch(response.body, new RegExp(SECRET), requestPath);
  }
  assert.equal((await get('/audio-files/trash/alt.mp3', 'admin')).status, 404);
});

test('/audio-files: Hörbuchrechte und private Bücher wie bisher', async t => {
  const { get } = await fixture(t);
  const open = await get('/audio-files/Hoerbuecher/Offen%20-%20Buch/01%20-%20Intro.m4b', 'reader');
  assert.equal(open.status, 200);
  assert.match(open.type, /^audio\/mp4/);
  assert.equal((await get('/audio-files/Hoerbuecher/Offen%20-%20Buch/01%20-%20Intro.m4b', 'guest')).status, 403);
  assert.equal((await get('/audio-files/Hoerbuecher/Privat%20-%20Buch/01%20-%20Intro.mp3', 'reader')).status, 404);
  assert.equal((await get('/audio-files/Hoerbuecher/Privat%20-%20Buch/01%20-%20Intro.mp3', 'admin')).status, 200);
});
