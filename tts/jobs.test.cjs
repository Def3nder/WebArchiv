const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTtsJobs } = require('./jobs.cjs');

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
