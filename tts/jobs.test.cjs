const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTtsJobs } = require('./jobs.cjs');
const { installTtsRoutes } = require('./jobs.cjs');

test('Audio-Spiegelstruktur, MP3-Link und Schutz vorhandener Dateien ohne API-Aufruf', async () => {
  const dir = await fs.mkdtemp(path.join(__dirname, '.test-audio-'));
  try {
    const root = path.join(dir, 'www'), audioRoot = path.join(dir, 'audio');
    const relative = path.join('Autor', '2026', 'Unterordner', 'Grüße.md');
    const filePath = path.join(root, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'Testartikel');
    const article = { id: 'test', author: 'Autor', title: 'Grüße', filePath };
    let starts = 0;
    const expected = path.join(audioRoot, relative.replace(/\.md$/, '.mp3'));
    const url = '/audio-files/Autor/2026/Unterordner/Gr%C3%BC%C3%9Fe.mp3';
    const jobs = createTtsJobs({ root, audioRoot, getArticle: () => article,
      canAccessAuthor: () => true, busy: () => false,
      reindex: async () => { article.audioUrl = url; },
      mediaUrl: filename => { assert.equal(filename, expected); return url; },
      start: ({ inputPath, outputPath }) => {
        starts++;
        assert.equal(inputPath, filePath);
        assert.equal(outputPath, expected);
        return { cancel() {}, completion: fs.writeFile(outputPath, 'simulierte MP3', { flag: 'wx' })
          .then(() => ({ outputPath, chunks: 1 })) };
      },
    });
    const id = await jobs.launch(article.id, {});
    while (!jobs.status(id, {}).done) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(jobs.status(id, {}).status, 'succeeded');
    assert.equal(jobs.status(id, {}).audioUrl, url);
    await assert.rejects(fs.stat(filePath.replace(/\.md$/, '.mp3')), { code: 'ENOENT' });
    await assert.rejects(jobs.launch(article.id, {}), /existiert bereits/);
    assert.equal(starts, 1);
    await fs.unlink(expected);
    await fs.writeFile(filePath.replace(/\.md$/, '.mp3'), 'alte MP3');
    await assert.rejects(jobs.launch(article.id, {}), /existiert bereits/);
    assert.equal(starts, 1);
  } finally {
    // Ausschließlich das von diesem Test unter tts/ angelegte Verzeichnis löschen.
    assert.ok(dir.startsWith(path.join(__dirname, '.test-audio-')));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Autorenrechte, paralleler Start, Abbruch und Reindex-Fehler ohne erneute Synthese', async () => {
  const dir = await fs.mkdtemp(path.join(__dirname, '.test-audio-'));
  try {
    const root = path.join(dir, 'www'), audioRoot = path.join(dir, 'audio');
    const input = path.join(root, 'Autor', 'Text.md');
    await fs.mkdir(path.dirname(input), { recursive: true });
    await fs.writeFile(input, 'Text');
    const article = { id: 'a', author: 'Autor', filePath: input };
    let finish, reject, output, starts = 0, cancelled = 0;
    const jobs = createTtsJobs({ root, audioRoot, getArticle: () => article,
      canAccessAuthor: user => user.allowed, busy: () => false,
      reindex: async () => { throw new Error('Index offline'); }, mediaUrl: () => '/audio-files/Autor/Text.mp3',
      start: options => {
        output = options.outputPath; starts++;
        return { completion: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
          cancel() { cancelled++; reject(Object.assign(new Error('cancel'), { cancelled: true })); } };
      } });
    const admin = { allowed: true }, denied = { allowed: false };
    await assert.rejects(jobs.launch('a', denied), { status: 403 });
    const first = jobs.launch('a', admin);
    await assert.rejects(jobs.launch('a', admin), { status: 409 });
    const id = await first;
    assert.throws(() => jobs.status(id, denied), { status: 403 });
    assert.throws(() => jobs.cancel(id, denied), { status: 403 });
    assert.equal(jobs.latest(denied), null);
    jobs.cancel(id, admin);
    while (!jobs.status(id, admin).done) await new Promise(r => setTimeout(r, 5));
    assert.equal(cancelled, 1);
    assert.equal(jobs.status(id, admin).status, 'cancelled');
    const second = await jobs.launch('a', admin);
    await fs.writeFile(output, 'simuliert'); finish({ outputPath: output, chunks: 1 });
    while (!jobs.status(second, admin).done) await new Promise(r => setTimeout(r, 5));
    assert.equal(jobs.status(second, admin).status, 'succeeded');
    assert.match(jobs.status(second, admin).indexError, /Index offline/);
    assert.equal(starts, 2);
    assert.equal(await fs.readFile(output, 'utf8'), 'simuliert');
    await assert.rejects(jobs.launch('a', admin), /existiert bereits/);
    assert.equal(starts, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Alle TTS-Routen sind adminpflichtig; Providerwechsel verhindert Start', async () => {
  const express = require('express');
  const app = express(); app.use(express.json());
  let starts = 0, availableProvider = 'qwen', launchedProvider;
  const jobs = { launch: async (_id, _user, provider) => { starts++; launchedProvider = provider; return 'id'; }, latest: () => null,
    status: () => ({}), cancel() {} };
  installTtsRoutes(app, (req, res, next) => {
    if (req.get('x-test-admin') !== 'yes') return res.sendStatus(403);
    req.session = { user: { role: 'admin' } }; next();
  }, jobs, async () => ({ providers: ['qwen', 'openai'].map(provider => ({ provider,
    available: availableProvider === 'both' || provider === availableProvider })) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [route, method] of [['/api/tts', 'POST'], ['/api/tts/provider', 'GET'], ['/api/tts/latest', 'GET'], ['/api/tts/id/status', 'GET'], ['/api/tts/id/cancel', 'POST']]) {
      assert.equal((await fetch(base + route, { method })).status, 403);
    }
    for (const provider of ['openai', undefined, 'qwen']) {
      const response = await fetch(base + '/api/tts', { method: 'POST',
        headers: { 'x-test-admin': 'yes', 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: 'a', provider }) });
      assert.equal(response.status, provider === 'qwen' ? 202 : 409);
    }
    assert.equal(starts, 1);
    assert.equal(launchedProvider, 'qwen');
    availableProvider = 'openai'; // Qwen wird nach Anzeige des Dialogs gestoppt.
    const post = provider => fetch(base + '/api/tts', { method: 'POST',
      headers: { 'x-test-admin': 'yes', 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: 'a', provider }) });
    assert.equal((await post('qwen')).status, 409);
    assert.equal(starts, 1); // Keine stillschweigende kostenpflichtige Umschaltung.
    const info = await (await fetch(base + '/api/tts/provider', { headers: { 'x-test-admin': 'yes' } })).json();
    assert.equal(info.providers.find(p => p.available).provider, 'openai');
    assert.equal((await post('openai')).status, 202);
    assert.equal(starts, 2);
    availableProvider = 'both';
    assert.equal((await post('openai')).status, 202);
    assert.equal(launchedProvider, 'openai'); // Freie Auswahl trotz erreichbarem Qwen.
    assert.equal((await post('qwen')).status, 202);
    assert.equal(launchedProvider, 'qwen');
    availableProvider = 'qwen'; // OpenAI-Schlüssel wurde entfernt.
    assert.equal((await post('openai')).status, 409);
    assert.equal(starts, 4);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
