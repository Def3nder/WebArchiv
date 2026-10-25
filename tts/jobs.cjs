// Auftragsverwaltung: nur ein Worker, keine automatische Wiederholung der Synthese.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startTts } = require('./spawn_tts.cjs');

function createTtsJobs({ root, audioRoot, getArticle, canAccessAuthor, busy, reindex, mediaUrl,
  selectedVoice = async () => null, start = startTts }) {
  const jobs = new Map();
  let active = null;
  let stopping = false;
  const fail = (message, status = 409, apiCode = null) => Object.assign(new Error(message), {
    status, ...(apiCode ? { apiCode } : {}),
  });
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
  async function launch(articleId, user, expectedProvider, replaceExisting = false) {
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
      const legacyName = names.find(name => name.toLowerCase() === basename.toLowerCase());
      const legacyOutput = legacyName ? path.join(parent, legacyName) : null;
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
      const targetName = (await fs.readdir(targetDir)).find(name => name.toLowerCase() === basename.toLowerCase());
      const existingOutput = targetName ? path.join(targetDir, targetName) : null;
      const existingFiles = [legacyOutput, existingOutput].filter(Boolean);
      if (existingFiles.length && replaceExisting !== true) {
        throw fail('Für diesen Artikel existiert bereits eine Audiodatei.', 409, 'audio_exists');
      }
      if (stopping) throw fail('Server wird beendet.');
      const qwenVoiceId = expectedProvider === 'qwen' ? await selectedVoice() : null;
      const replacementOutput = existingFiles.length
        ? path.join(targetDir, `.${path.basename(basename, '.mp3')}.${randomUUID()}.replacement.mp3`)
        : output;
      jobs.set(state.id, job);
      state.voiceId = qwenVoiceId;
      state.replacedExisting = false;
      state.status = 'running';
      job.worker = start({ inputPath: input, outputPath: replacementOutput, expectedProvider, qwenVoiceId,
        onEvent: event => capture(state, event) });
      job.completion = job.worker.completion.then(async result => {
        state.exitCode = 0;
        const stat = await fs.lstat(replacementOutput);
        if (path.resolve(result.outputPath) !== replacementOutput || !stat.isFile() || stat.size === 0) {
          throw fail('Der Worker hat keine gültige MP3-Datei erzeugt.', 500);
        }
        if (existingFiles.length) {
          const audioArchive = await fs.realpath(audioRoot);
          const trashRoot = path.join(audioArchive, 'Trash');
          try { await fs.mkdir(trashRoot); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          const trashStat = await fs.lstat(trashRoot);
          if (!trashStat.isDirectory() || trashStat.isSymbolicLink() || await fs.realpath(trashRoot) !== trashRoot) {
            throw fail('Ungültiger Audio-Papierkorb.', 403);
          }
          const batch = path.join(trashRoot,
            `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}`);
          await fs.mkdir(batch);
          const moved = [];
          try {
            for (const sourceFile of existingFiles) {
              const inAudio = sourceFile === audioArchive || sourceFile.startsWith(audioArchive + path.sep);
              const origin = inAudio ? 'audio' : 'www';
              const base = inAudio ? audioArchive : archive;
              const relativeSource = path.relative(base, sourceFile);
              if (relativeSource.startsWith('..' + path.sep) || path.isAbsolute(relativeSource) || relativeSource === '..') {
                throw fail('Ungültiger Pfad der vorhandenen Audiodatei.', 403);
              }
              const trashFile = path.join(batch, origin, relativeSource);
              await fs.mkdir(path.dirname(trashFile), { recursive: true });
              await fs.rename(sourceFile, trashFile);
              moved.push({ sourceFile, trashFile });
            }
            await fs.rename(replacementOutput, output);
            state.replacedExisting = true;
          } catch (error) {
            for (const item of moved.reverse()) {
              try { await fs.rename(item.trashFile, item.sourceFile); } catch {}
            }
            throw error;
          }
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
      }).catch(async error => {
        if (replacementOutput !== output) {
          try { await fs.unlink(replacementOutput); } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') capture(state, { type: 'warning', message: `Temporäre MP3 konnte nicht entfernt werden: ${cleanupError.message}` });
          }
        }
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

function installTtsRoutes(app, requireAdmin, jobs, providerInfo = require('./provider-config.cjs').providerInfo, voices = null) {
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      res.status(error.status || 500).json({ error: error.message, ...(error.apiCode ? { code: error.apiCode } : {}) });
    }
  };
  app.post('/api/tts', requireAdmin, route(async (req, res) => {
    const info = await providerInfo();
    const selected = info.providers.find(p => p.provider === req.body?.provider && p.available);
    if (!selected) return res.status(409).json({ error: 'Der gewählte TTS-Anbieter ist nicht verfügbar. Bitte „Audio erzeugen“ erneut aufrufen und einen verfügbaren Anbieter auswählen. Es wurde kein Auftrag gestartet.' });
    const jobId = await jobs.launch(req.body?.articleId, req.session.user, selected.provider,
      req.body?.replaceExisting === true);
    res.status(202).json({ jobId });
  }));
  app.get('/api/tts/provider', requireAdmin, route(async (_req, res) => {
    const info = await providerInfo();
    if (voices) {
      const voiceId = await voices.selectedVoice();
      const qwen = info.providers.find(provider => provider.provider === 'qwen');
      if (qwen) {
        qwen.voiceId = voiceId;
        if (voiceId) qwen.confirmation += ` Verwendete Stimme: ${voiceId}.`;
        else qwen.confirmation += ' Verwendete Stimme: Standardstimme des Qwen-Servers.';
      }
    }
    res.json(info);
  }));
  if (voices) {
    app.get('/api/tts/settings', requireAdmin, route(async (_req, res) => res.json(await voices.getSettings())));
    app.put('/api/tts/settings', requireAdmin, route(async (req, res) => {
      res.json(await voices.select(req.body?.voiceId, req.session.user));
    }));
    app.get('/api/tts/server-settings', requireAdmin, route(async (_req, res) => {
      res.json(await voices.serverSettings());
    }));
    app.put('/api/tts/server-settings', requireAdmin, route(async (req, res) => {
      res.json(await voices.saveServerSettings(req.body));
    }));
    app.post('/api/tts/voices', requireAdmin, route(async (req, res) => {
      res.status(202).json(await voices.createVoice(req.body || {}));
    }));
    app.get('/api/tts/voices/jobs/:jobId', requireAdmin, route(async (req, res) => {
      res.json(await voices.voiceJob(req.params.jobId));
    }));
    app.delete('/api/tts/voices/jobs/:jobId', requireAdmin, route(async (req, res) => {
      res.json(await voices.cancelVoiceJob(req.params.jobId));
    }));
    app.patch('/api/tts/voices/:voiceId', requireAdmin, route(async (req, res) => {
      res.json(await voices.renameVoice(req.params.voiceId, req.body?.name, req.session.user));
    }));
    app.delete('/api/tts/voices/:voiceId', requireAdmin, route(async (req, res) => {
      res.json(await voices.trashVoice(req.params.voiceId));
    }));
    app.get('/api/tts/voices/:voiceId/preview-audio', requireAdmin, route(async (req, res) => {
      const local = await voices.cachedPreviewAudio(req.params.voiceId);
      res.type('audio/mpeg');
      res.set('Content-Length', String(local.size));
      res.set('ETag', `"sha256-${local.sha256}"`);
      res.sendFile(local.file);
    }));
    app.post('/api/tts/voices-preview', requireAdmin, route(async (req, res) => {
      res.status(202).json(await voices.startPreview(req.body?.voiceId));
    }));
    app.get('/api/tts/voices-preview/:jobId', requireAdmin, route(async (req, res) => {
      res.json(await voices.previewStatus(req.params.jobId));
    }));
    app.delete('/api/tts/voices-preview/:jobId', requireAdmin, route(async (req, res) => {
      res.json(await voices.cancelPreview(req.params.jobId));
    }));
    app.get('/api/tts/voices-preview/:jobId/audio', requireAdmin, route(async (req, res) => {
      const local = await voices.previewAudio(req.params.jobId);
      res.type('audio/mpeg');
      res.set('Content-Length', String(local.size));
      res.set('ETag', `"sha256-${local.sha256}"`);
      res.sendFile(local.file);
    }));
  }
  app.get('/api/tts/latest', requireAdmin, route((req, res) => res.json({ jobId: jobs.latest(req.session.user) })));
  app.get('/api/tts/:jobId/status', requireAdmin, route((req, res) => res.json(jobs.status(req.params.jobId, req.session.user))));
  app.post('/api/tts/:jobId/cancel', requireAdmin, route((req, res) => {
    jobs.cancel(req.params.jobId, req.session.user);
    res.status(202).json({ accepted: true });
  }));
}
module.exports = { createTtsJobs, installTtsRoutes };
