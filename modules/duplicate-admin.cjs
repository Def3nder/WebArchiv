'use strict';

// Dubletten (Admin): Blog-/Quellen-Paare anzeigen, vergleichen, ignorieren,
// verknüpfen und die Infografiken des Quellartikels zum Blogartikel umziehen.
// Die Erkennung selbst (Kandidaten, Entscheidungsspeicher) liegt in lib/duplicates.cjs;
// den abgeleiteten Zustand (archive.duplicateCandidates, archive.duplicateCanonicalOf)
// berechnet refreshDuplicateState in server.js.

const fs = require('fs');
const path = require('path');
const { httpError, jsonRoute } = require('../lib/http-errors.cjs');
const { writeFileAtomic } = require('../lib/atomic-file.cjs');
const { isPathInside, resolveUnder } = require('../lib/archive-files.cjs');
const {
  INFOGRAPHICS_AUTHOR, infographicYearsFromMigrations, infographicStemExists, infographicAttachmentStem,
  validateInfographicHeader, buildInfographicMarkdown,
} = require('../lib/infographics.cjs');
const { finishDuplicateLinks } = require('../lib/duplicates.cjs');

// archive: Indexzustand aus server.js (Felder erst beim Aufruf lesen).
// infographics: { conflictingBase, firstAvailableOrdinal, filesFor } aus der Infografik-Verwaltung.
// refreshInfographicsForYears / refreshState: gezielter Teil-Reindex bzw. nur Dublettenstatus.
function createDuplicateAdmin({
  archive, wwwDir, store, config, bookmarks, infographics, refreshInfographicsForYears, refreshState,
}) {
  function infographicViews(article) {
    return (archive.infographicGroups.get(article.id) || [])
      .filter(item => item.ownImage)
      .map(item => ({
        id: item.id,
        title: item.title,
        imageUrl: item.imageUrl,
      }));
  }

  function articleView(article) {
    if (!article) return null;
    const views = infographicViews(article);
    return {
      id: article.id,
      author: article.author,
      title: article.title,
      date: article.date,
      excerpt: article.excerpt,
      sourceUrl: article.sourceUrl,
      imageUrl: article.ownImage ? article.imageUrl : null,
      hasOwnImage: !!article.ownImage,
      hash: article.duplicateProfile?.hash || '',
      infographicCount: views.length,
      infographics: views,
    };
  }

  function decisionView(decision) {
    const blog = archive.articleById.get(decision.blogId);
    const facebook = archive.articleById.get(decision.facebookId);
    return {
      ...decision,
      blog: articleView(blog),
      facebook: articleView(facebook),
      missing: !blog || !facebook,
      changed: !!(blog && facebook && (
        decision.blogHash !== blog.duplicateProfile?.hash
        || decision.facebookHash !== facebook.duplicateProfile?.hash
      )),
    };
  }

  function pair(blogId, facebookId) {
    const blog = archive.articleById.get(blogId);
    const facebook = archive.articleById.get(facebookId);
    if (!blog || !facebook) throw httpError(404, 'Einer der Artikel wurde nicht gefunden.');
    if (blog.author !== config.blogAuthor || !config.facebookAuthors.includes(facebook.author)) {
      throw httpError(400, 'Diese Autoren können nicht als Blog-/Quellen-Dublette verknüpft werden.');
    }
    return { blog, facebook };
  }

  function nextInfographicTarget(blog, reserved) {
    if (infographics.conflictingBase(blog)) {
      throw httpError(409, 'Unter diesem Dateistamm existiert eine eigenständige oder anders zugeordnete Infografik.');
    }
    const year = blog.year || blog.date?.slice(0, 4) || '';
    if (!/^\d{4}$/.test(year)) throw httpError(400, 'Der Blogartikel hat kein gültiges Jahr.');
    const dir = resolveUnder(wwwDir, INFOGRAPHICS_AUTHOR, year);
    if (!dir) throw httpError(400, 'Kein gültiges Infografik-Ziel gefunden.');
    const baseStem = path.basename(blog.filePath, '.md');
    for (let ordinal = infographics.firstAvailableOrdinal(blog); ordinal < 1000; ordinal++) {
      const stem = infographicAttachmentStem(baseStem, ordinal);
      if (!reserved.has(stem.toLowerCase()) && !infographicStemExists(dir, stem)) {
        reserved.add(stem.toLowerCase());
        return { dir, stem, ordinal };
      }
    }
    throw httpError(409, 'Es konnte kein freier Infografik-Dateiname gefunden werden.');
  }

  function planMigration(blog, facebook) {
    const bundles = [];
    for (const info of archive.infographicGroups.get(facebook.id) || []) {
      if (!info.ownImage) continue;
      if (info.hasBody) throw httpError(409, `„${info.title}“ enthält eigenen Text und wird nicht automatisch migriert.`);
      bundles.push({ kind: 'infographic', sourceArticle: info, files: infographics.filesFor(info) });
    }
    const reserved = new Set();
    return bundles.map(bundle => {
      const target = nextInfographicTarget(blog, reserved);
      const mappings = bundle.files.map(source => ({
        source,
        target: path.join(target.dir, target.stem + path.extname(source).toLowerCase()),
      }));
      return { ...bundle, ...target, mappings };
    });
  }

  function publicMigrationPlan(plan) {
    return plan.map(bundle => ({
      kind: bundle.kind,
      target: path.relative(wwwDir, path.join(bundle.dir, bundle.stem)).replace(/\\/g, '/'),
      files: bundle.mappings.map(item => path.basename(item.target)),
    }));
  }

  async function migrateInfographics(blog, facebook) {
    const plan = planMigration(blog, facebook);
    if (!plan.length) return { migrations: [], rollback: async () => {} };
    const blogContent = await fs.promises.readFile(blog.filePath, 'utf8');
    const header = validateInfographicHeader(blogContent);
    if (!header.hasTitle || !header.date) throw httpError(400, 'Der Blogartikel hat keinen gültigen Titel- und Datumskopf.');

    const moved = [];
    const created = [];
    const overwrittenMarkdown = [];
    const archiveRoot = await fs.promises.realpath(wwwDir);
    const isInsideArchive = file => isPathInside(archiveRoot, file);
    // Jeder Schritt läuft auch, wenn ein früherer scheitert; Fehler stehen im Log.
    const logFailure = label => error => console.error(`Dubletten-Migration zurückrollen (${label}):`, error);
    const rollback = async () => {
      for (const file of [...created].reverse()) await fs.promises.unlink(file).catch(logFailure(file));
      for (const item of [...overwrittenMarkdown].reverse()) {
        await writeFileAtomic(item.path, item.content).catch(logFailure(item.path));
      }
      for (const mapping of [...moved].reverse()) {
        await fs.promises.rename(mapping.target, mapping.source).catch(logFailure(mapping.target));
      }
    };
    try {
      for (const bundle of plan) {
        await fs.promises.mkdir(bundle.dir, { recursive: true });
        const realTargetDir = await fs.promises.realpath(bundle.dir);
        if (!isInsideArchive(realTargetDir)) throw httpError(403, 'Das Infografik-Ziel liegt außerhalb des Archivs.');
        for (const mapping of bundle.mappings) {
          const source = path.resolve(mapping.source);
          const target = path.resolve(mapping.target);
          if (!isPathInside(wwwDir, source) || !isPathInside(wwwDir, target)) {
            throw httpError(403, 'Ein Medienpfad liegt außerhalb des Archivs.');
          }
          const stat = await fs.promises.lstat(source);
          if (stat.isSymbolicLink() || !stat.isFile()) throw httpError(409, 'Symbolische Links können nicht migriert werden.');
          const realSource = await fs.promises.realpath(source);
          if (!isInsideArchive(realSource)) throw httpError(403, 'Eine Quelldatei liegt außerhalb des Archivs.');
          try { await fs.promises.access(target); throw httpError(409, `Zieldatei existiert bereits: ${path.basename(target)}`); }
          catch (error) { if (error.status) throw error; if (error.code !== 'ENOENT') throw error; }
        }

        const mdMapping = bundle.mappings.find(item => path.extname(item.source).toLowerCase() === '.md');
        for (const mapping of bundle.mappings) {
          await fs.promises.rename(mapping.source, mapping.target);
          moved.push(mapping);
        }
        const mdTarget = path.join(bundle.dir, bundle.stem + '.md');
        if (mdMapping) {
          overwrittenMarkdown.push({ path: mdTarget, content: await fs.promises.readFile(mdTarget) });
          await writeFileAtomic(mdTarget, buildInfographicMarkdown(blogContent, bundle.ordinal));
        } else {
          await fs.promises.writeFile(mdTarget, buildInfographicMarkdown(blogContent, bundle.ordinal), { flag: 'wx' });
          created.push(mdTarget);
        }
      }
    } catch (error) {
      await rollback();
      throw error;
    }

    const migrations = plan.flatMap(bundle => [
      ...bundle.mappings.map(item => ({
        from: path.relative(wwwDir, item.source).replace(/\\/g, '/'),
        to: path.relative(wwwDir, item.target).replace(/\\/g, '/'),
      })),
      ...(!bundle.mappings.some(item => path.extname(item.source).toLowerCase() === '.md') ? [{
        from: null,
        to: path.relative(wwwDir, path.join(bundle.dir, bundle.stem + '.md')).replace(/\\/g, '/'),
      }] : []),
    ]);
    return { migrations, rollback };
  }

  async function linkPair({ blogId, facebookId, userEmail, migrateImages = false, deferDecision = false }) {
    const { blog, facebook } = pair(blogId, facebookId);
    const existing = store.find(blogId, facebookId);
    const migrationResult = migrateImages
      ? await migrateInfographics(blog, facebook)
      : { migrations: [], rollback: async () => {} };
    const decision = {
      blogId, facebookId, status: 'linked',
      blogHash: blog.duplicateProfile.hash,
      facebookHash: facebook.duplicateProfile.hash,
      user: userEmail,
      migrations: [...(existing?.migrations || []), ...migrationResult.migrations],
    };
    if (!deferDecision) {
      try { await store.set(decision); }
      catch (error) { await migrationResult.rollback(); throw error; }
    }
    return { blogId, facebookId, migrations: migrationResult.migrations, decision, rollback: migrationResult.rollback };
  }

  // Nach gespeicherten Verknüpfungen: Lesezeichen umziehen, dann nur die betroffenen
  // Infografik-Jahrgänge (oder bloß den Dublettenstatus) neu ableiten. Liefert einen
  // Hinweis, falls die Lesezeichen nicht umgezogen werden konnten.
  function finishLinked(linked) {
    return finishDuplicateLinks({
      replacements: linked.map(item => ({ oldId: item.facebookId, newId: item.blogId })),
      migrations: linked.flatMap(item => item.migrations),
      bookmarks,
      refreshMigrations: migrations => refreshInfographicsForYears(infographicYearsFromMigrations(migrations)),
      refreshState,
    });
  }

  return { articleView, decisionView, pair, planMigration, publicMigrationPlan, migrateInfographics, linkPair, finishLinked };
}

// deps wie createDuplicateAdmin, dazu requireAdmin, lock (Archiv-Sperre) und
// articleBodies (gerenderte Artikeltexte für den Vergleich).
function installDuplicateRoutes(app, deps) {
  const { requireAdmin, lock, archive, store, config, articleBodies, refreshState } = deps;
  const admin = createDuplicateAdmin(deps);

  app.get('/api/duplicates', requireAdmin, jsonRoute(() => {
    const decisions = store.all();
    const pending = archive.duplicateCandidates.map(candidate => ({
      blog: admin.articleView(candidate.blog),
      facebook: admin.articleView(candidate.facebook),
      score: candidate.score,
      exact: candidate.exact,
      containment: candidate.containment,
      titleSimilarity: candidate.titleSimilarity,
      days: candidate.days,
      reasons: candidate.reasons,
    }));
    const linked = decisions.filter(item => item.status === 'linked').map(admin.decisionView);
    const ignored = decisions.filter(item => item.status === 'ignored').map(admin.decisionView);
    return { pending, linked, ignored, config };
  }, { label: 'Dubletten', fallback: 'Die Dubletten konnten nicht geladen werden.' }));

  app.get('/api/duplicates/compare', requireAdmin, jsonRoute(async req => {
    const { blog, facebook } = admin.pair(String(req.query.blogId || ''), String(req.query.facebookId || ''));
    const read = async article => ({ ...admin.articleView(article), ...await articleBodies.get(article.filePath) });
    let migration = [];
    let migrationUnavailable = '';
    try { migration = admin.publicMigrationPlan(admin.planMigration(blog, facebook)); }
    catch (error) {
      // Eigene Gründe (z. B. Infografik mit eigenem Text) gehen an die Oberfläche, Systemfehler nur ins Log.
      if (!error.status) console.error('Dublettenvergleich – Migration planen:', error);
      migrationUnavailable = error.status ? error.message : 'Die Migration kann gerade nicht geplant werden.';
    }
    const [blogView, facebookView] = await Promise.all([read(blog), read(facebook)]);
    return { blog: blogView, facebook: facebookView, migration, migrationUnavailable };
  }, { label: 'Dublettenvergleich', fallback: 'Der Vergleich konnte nicht geladen werden.' }));

  app.post('/api/duplicates/batch', requireAdmin, jsonRoute(async req => {
    if (lock.busy) throw lock.conflictError();
    const rawItems = req.body?.items;
    if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 500) {
      throw httpError(400, 'Bitte 1 bis 500 Dublettenpaare auswählen.');
    }
    const items = rawItems.map(item => ({
      blogId: String(item?.blogId || ''),
      facebookId: String(item?.facebookId || ''),
    }));
    const facebookIds = new Set();
    for (const item of items) {
      admin.pair(item.blogId, item.facebookId);
      if (facebookIds.has(item.facebookId)) {
        throw httpError(400, 'Ein Quellartikel darf nur einmal in einer Sammelaktion vorkommen.');
      }
      facebookIds.add(item.facebookId);
    }

    // Zwischen Prüfung oben und hier liegt nur synchroner Code; die Sperre ist frei.
    return lock.run('Dubletten-Sammelaktion', async () => {
      const prepared = [];
      const failed = [];
      for (const item of items) {
        try {
          prepared.push(await admin.linkPair({
            ...item,
            userEmail: req.session.user.email,
            migrateImages: !!req.body?.migrateImages,
            deferDecision: true,
          }));
        } catch (error) {
          failed.push({ ...item, error: error.status ? error.message : 'Verknüpfung fehlgeschlagen.' });
          if (!error.status) console.error('Dubletten-Sammelaktion:', error);
        }
      }
      try {
        if (prepared.length) await store.setMany(prepared.map(item => item.decision));
      } catch (error) {
        for (const item of [...prepared].reverse()) await item.rollback();
        throw error;
      }
      const warning = await admin.finishLinked(prepared);
      const migrations = prepared.flatMap(item => item.migrations);
      return { ok: failed.length === 0, linked: prepared.length, failed, migrations, ...(warning ? { warning } : {}) };
    });
  }, { label: 'Dubletten-Sammelaktion', fallback: 'Die Sammelaktion ist fehlgeschlagen.' }));

  app.post('/api/duplicates', requireAdmin, jsonRoute(req => lock.run('Dublettenaktion', async () => {
    const action = String(req.body?.action || '');
    const blogId = String(req.body?.blogId || '');
    const facebookId = String(req.body?.facebookId || '');
    if (action === 'reset') {
      await store.remove(blogId, facebookId);
      refreshState();
      return { ok: true };
    }
    const { blog, facebook } = admin.pair(blogId, facebookId);
    if (action === 'ignore') {
      await store.set({
        blogId, facebookId, status: 'ignored',
        blogHash: blog.duplicateProfile.hash,
        facebookHash: facebook.duplicateProfile.hash,
        user: req.session.user.email,
      });
      refreshState();
      return { ok: true };
    }
    if (!['link', 'migrate'].includes(action)) throw httpError(400, 'Unbekannte Dublettenaktion.');
    const existing = store.find(blogId, facebookId);
    if (action === 'migrate' && existing?.status !== 'linked') {
      throw httpError(409, 'Grafiken können erst nach dem Verknüpfen migriert werden.');
    }
    const result = await admin.linkPair({
      blogId, facebookId,
      userEmail: req.session.user.email,
      migrateImages: !!req.body?.migrateImages || action === 'migrate',
    });
    const warning = await admin.finishLinked([result]);
    return { ok: true, migrations: result.migrations, ...(warning ? { warning } : {}) };
  }), { label: 'Dublettenverwaltung', fallback: 'Die Dublettenaktion ist fehlgeschlagen.' }));
}

module.exports = { createDuplicateAdmin, installDuplicateRoutes };
