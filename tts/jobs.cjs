// Auftragsverwaltung: nur ein Worker, keine automatische Wiederholung der Synthese.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startTts } = require('./spawn_tts.cjs');

function createTtsJobs({ root, audioRoot, getArticle, canAccessAuthor, busy, reindex, mediaUrl, start = startTts }) {
  const jobs = new Map();
  let active = null;
  let stopping = false;
  const fail = (message, status = 409) => Object.assign(new Error(message), { status });
  function prune() {
    const finished = [...jobs.values()].filter(j => j.state.done);
    for (const j of finished) {
      if (Date.now() - j.state.finishedAt > 86400000 || jobs.size > 50) jobs.delete(j.state.id);
    }
  }
  function authorized(id, user) {
    prune();
    const job = jobs.get(id);
    if (!job) throw fail('Audio-Auftrag nicht gefunden.', 404);
    const article = getArticle(job.state.articleId);
    if (!article || !canAccessAuthor(user, job.author) || !canAccessAuthor(user, article.author)) {
      throw fail('Kein Zugriff auf diesen Artikel.', 403);
    }
    return job;
  }
  function capture(state, event) {
    state.output = (state.output + `${event.time || new Date().toISOString()} [${event.type.toUpperCase()}] ${event.message}\n`).slice(-20000);
    if (Number.isInteger(event.current)) state.current = event.current;
    if (Number.isInteger(event.total)) state.total = event.total;
  }
  async function launch(articleId, user) {
    if (typeof articleId !== 'string' || !articleId) throw fail('Artikel-ID fehlt.', 400);
    const article = getArticle(articleId);
    if (!article) throw fail('Artikel nicht gefunden.', 404);
    if (!canAccessAuthor(user, article.author)) throw fail('Kein Zugriff auf diesen Artikel.', 403);
    if (stopping || active || busy()) throw fail('Es läuft bereits ein Audio-, Scrape- oder Index-Auftrag.');
    const state = { id: randomUUID(), articleId, title: article.title, status: 'starting', done: false,
      startedAt: Date.now(), finishedAt: null, current: null, total: null, output: '', error: null,
      indexError: null, exitCode: null, audioUrl: null };
    const job = { state, author: article.author, worker: null, completion: null };
    active = job; // Reservierung vor dem ersten await, auch für parallele HTTP-Anfragen.
    try {
      const archive = await fs.realpath(root);
      const source = path.resolve(article.filePath);
      const input = await fs.realpath(source);
      const inside = p => p.startsWith(archive + path.sep);
      // Auch Autorengrenzen dürfen durch Dateisymlinks nicht umgangen werden.
      const authorRoot = await fs.realpath(path.join(root, article.author));
      if (!inside(input) || authorRoot !== path.join(archive, article.author) || !input.startsWith(authorRoot + path.sep)
          || path.extname(source).toLowerCase() !== '.md' || !(await fs.stat(input)).isFile()) {
        throw fail('Ungültiger Artikelpfad.', 403);
      }
      const parent = await fs.realpath(path.dirname(source));
      if (!inside(parent) || (!parent.startsWith(authorRoot + path.sep) && parent !== authorRoot)) {
        throw fail('Ungültiges Ausgabeverzeichnis.', 403);
      }
      const basename = path.basename(source, path.extname(source)) + '.mp3';
      const names = await fs.readdir(parent);
      if (names.some(name => name.toLowerCase() === basename.toLowerCase())) {
        throw fail('Eine MP3 für diesen Artikel existiert bereits. Sie wird nicht überschrieben.');
      }
      const relative = path.relative(path.resolve(root), source);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..') {
        throw fail('Ungültiger Artikelpfad.', 403);
      }
      // Spiegelstruktur unter audio/. Jeden vorhandenen Elternpfad vor dem
      // Anlegen weiterer Ordner prüfen, damit Symlinks kein fremdes Ziel öffnen.
      await fs.mkdir(audioRoot, { recursive: true });
      let targetDir = await fs.realpath(audioRoot);
      for (const part of path.dirname(relative).split(path.sep)) {
        const next = path.join(targetDir, part);
        try { await fs.mkdir(next); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = await fs.lstat(next);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(next) !== next) {
          throw fail('Ungültiges Audio-Ausgabeverzeichnis.', 403);
        }
        targetDir = next;
      }
      const output = path.join(targetDir, basename);
      if ((await fs.readdir(targetDir)).some(name => name.toLowerCase() === basename.toLowerCase())) {
        throw fail('Eine MP3 für diesen Artikel existiert bereits. Sie wird nicht überschrieben.');
      }
      if (stopping) throw fail('Server wird beendet.');
      jobs.set(state.id, job);
      state.status = 'running';
      job.worker = start({ inputPath: input, outputPath: output, onEvent: event => capture(state, event) });
      job.completion = job.worker.completion.then(async result => {
        state.exitCode = 0;
        const stat = await fs.lstat(output);
        if (path.resolve(result.outputPath) !== output || !stat.isFile() || stat.size === 0) {
          throw fail('Der Worker hat keine gültige MP3-Datei erzeugt.', 500);
        }
        state.audioUrl = mediaUrl(path.join(audioRoot, path.dirname(relative), basename));
        state.status = 'indexing';
        try {
          await reindex();
          if (!getArticle(articleId)?.audioUrl) throw new Error('MP3 noch nicht im Artikelindex gefunden.');
        } catch (error) {
          state.indexError = 'MP3 wurde erzeugt, aber der Index konnte nicht aktualisiert werden. Bitte „Archiv neu einlesen“ ausführen. ' + error.message;
        }
        state.status = 'succeeded';
      }).catch(error => {
        state.status = error.cancelled ? 'cancelled' : 'failed';
        state.exitCode = error.exitCode ?? state.exitCode;
        state.error = error.cancelled ? 'Audio-Auftrag abgebrochen.' : error.message;
      }).finally(() => {
        state.done = true;
        state.finishedAt = Date.now();
        active = null;
        prune();
      });
      return state.id;
    } catch (error) {
      active = null;
      jobs.delete(state.id);
      throw error;
    }
  }
  return {
    get running() { return !!active || stopping; },
    launch,
    status(id, user) {
      const { state } = authorized(id, user);
      if (state.indexError && getArticle(state.articleId)?.audioUrl === state.audioUrl) state.indexError = null;
      return { ...state };
    },
    latest(user) {
      prune();
      return [...jobs.values()].reverse().find(j => canAccessAuthor(user, j.author)
        && getArticle(j.state.articleId) && canAccessAuthor(user, getArticle(j.state.articleId).author))?.state.id || null;
    },
    cancel(id, user) {
      const job = authorized(id, user);
      if (!job.state.done && job.state.status !== 'indexing') {
        job.state.status = 'cancelling';
        job.worker.cancel();
      }
    },
    async shutdown() {
      stopping = true;
      active?.worker?.cancel();
      await active?.completion;
    },
  };
}

function installTtsRoutes(app, requireAdmin, jobs) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
  };
  app.post('/api/tts', requireAdmin, route(async (req, res) => {
    const jobId = await jobs.launch(req.body?.articleId, req.session.user);
    res.status(202).json({ jobId });
  }));
  app.get('/api/tts/latest', requireAdmin, route((req, res) => res.json({ jobId: jobs.latest(req.session.user) })));
  app.get('/api/tts/:jobId/status', requireAdmin, route((req, res) => res.json(jobs.status(req.params.jobId, req.session.user))));
  app.post('/api/tts/:jobId/cancel', requireAdmin, route((req, res) => {
    jobs.cancel(req.params.jobId, req.session.user);
    res.status(202).json({ accepted: true });
  }));
}
module.exports = { createTtsJobs, installTtsRoutes };
