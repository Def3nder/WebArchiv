'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installArticleRoutes } = require('../modules/articles.cjs');
const { buildArticleSearchIndex } = require('../lib/article-index.cjs');
const { shareIdFor } = require('../lib/share-ids.cjs');

const article = (id, fields = {}) => {
  const [author, year] = id.split('/');
  return {
    id, author, year, date: `${year}-01-10`, title: id, categories: [], tags: [], excerpt: '',
    filePath: `/www/${id}.md`, ownImage: false, imageUrl: `/files/${id}.jpg`, ...fields,
  };
};

// Blogartikel mit Foto und Infografik, Telegram, eine verknüpfte Facebook-Dublette und ein gesperrter Autor.
function fixture() {
  const blog = article('Joe/2026/achtsamkeit', { title: 'Achtsamkeit im Alltag', date: '2026-03-02', ownImage: true, categories: ['Achtsamkeit'] });
  const info = article('Infografiken/2026/achtsamkeit_1', {
    title: 'Achtsamkeit (Grafik)', date: '2026-03-02', ownImage: true, instagramPoster: true,
    inheritedAudioAuthor: 'Geheim', audioUrl: '/audio/x.mp3', hasExternalAudio: true,
  });
  const telegram = article('Telegram/2026/notiz', { title: 'Kurze Notiz', date: '2026-02-01' });
  const facebook = article('Facebook/2026/achtsamkeit', { title: 'Achtsamkeit (Facebook)', date: '2026-03-01' });
  const secret = article('Geheim/2025/intern', { title: 'Intern', date: '2025-05-05' });
  const articles = [blog, info, facebook, telegram, secret];
  const archive = {
    articles,
    articleById: new Map(articles.map(item => [item.id, item])),
    infographicGroups: new Map([[blog.id, [info]]]),
    groupAnchorOf: new Map([[info.id, blog.id]]),
    meta: { authors: ['Facebook', 'Geheim', 'Infografiken', 'Joe', 'Telegram'], years: ['2026', '2025'], categories: ['Achtsamkeit'] },
    fuseIndex: buildArticleSearchIndex(articles),
  };
  return { blog, info, telegram, facebook, secret, archive };
}

const USERS = {
  admin: { email: 'admin@example.test', role: 'admin', allowedAuthors: null },
  guest: { email: null, role: 'guest', allowedAuthors: ['Joe', 'Infografiken', 'Telegram', 'Facebook'] },
};

async function start(t, data, { bodies = async () => ({ bodyHtml: '<p>Text</p>' }) } = {}) {
  const canAccessAuthor = (user, author) => !!user && (user.allowedAuthors === null || user.allowedAuthors.includes(author));
  const marks = new Set([data.blog.id]);
  const app = express();
  installArticleRoutes(app, {
    attachUser: (req, _res, next) => { req.user = USERS[req.get('x-user') || 'guest']; next(); },
    archive: data.archive,
    bookmarks: { idsFor: email => (email ? marks : new Set()), has: (email, id) => !!email && marks.has(id) },
    articleBodies: { get: bodies },
    canAccessAuthor,
    duplicateCanonicalFor: (item, user) => (item.id === data.facebook.id && (!user || canAccessAuthor(user, data.blog.author)) ? data.blog : null),
    canUploadInfographic: user => user.role === 'admin',
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url, user = 'guest') => {
    const res = await fetch(base + url, { headers: { 'x-user': user } });
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  };
}

const ids = res => res.data.items.map(item => item.id);

test('Liste: ACL, Dubletten und Telegram ausgeblendet, interne Felder entfernt', async t => {
  const data = fixture();
  const call = await start(t, data);
  let res = await call('/api/articles');
  assert.equal(res.cache, 'no-store');
  assert.deepEqual(ids(res), [data.blog.id, data.info.id]);
  assert.equal(res.data.items[0].filePath, undefined);
  assert.equal(res.data.items[0].bookmarked, false, 'Gäste haben keine Lesezeichen');
  // Geerbtes Audio ohne Recht am Ursprung bleibt verborgen; der Anzeigeautor ist der des Hauptartikels.
  assert.deepEqual([res.data.items[1].audioUrl, res.data.items[1].displayAuthor], [null, 'Joe']);

  res = await call('/api/articles', 'admin');
  assert.deepEqual(ids(res), [data.blog.id, data.info.id, data.secret.id]);
  assert.equal(res.data.items[1].audioUrl, '/audio/x.mp3');
  assert.equal(res.data.items[1].bookmarked, true, 'Kachel der Infografik übernimmt das Lesezeichen des Ankers');

  res = await call('/api/articles?telegram=1');
  assert.deepEqual(ids(res), [data.blog.id, data.info.id, data.telegram.id]);
  res = await call('/api/articles?author=Geheim');
  assert.deepEqual(res.data, { total: 0, page: 1, limit: 24, pages: 0, items: [] });
  res = await call('/api/articles?bookmarks=1', 'admin');
  assert.deepEqual(ids(res), [data.blog.id]);
});

test('Liste: Kacheln, Infografik-Filter, Suche und Seitenwerte', async t => {
  const data = fixture();
  const call = await start(t, data);
  let res = await call('/api/articles?group=1');
  assert.deepEqual(ids(res), [data.blog.id]);
  assert.equal(res.data.total, 2, 'Kachel zählt Artikel und Grafik');
  assert.deepEqual(res.data.items[0].images.map(image => image.kind), ['photo', 'infographic']);

  res = await call('/api/articles?author=Infografiken&infographic=poster');
  assert.deepEqual(ids(res), [data.info.id]);
  res = await call('/api/articles?author=Infografiken&infographic=classic');
  assert.deepEqual(ids(res), []);

  res = await call('/api/articles?q=Achtsamkeit%20Alltag');
  assert.equal(ids(res)[0], data.blog.id);
  res = await call('/api/articles?q=2025', 'admin');
  assert.deepEqual(ids(res), [data.secret.id]);

  res = await call('/api/articles?page=abc&limit=1');
  assert.deepEqual([res.data.page, res.data.limit, res.data.pages, ids(res).length], [1, 1, 2, 1]);

  res = await call('/api/articles?infographicReview=1');
  assert.deepEqual([res.status, res.data], [403, { error: 'Der Infografik-Prüfmodus ist nur für Administratoren verfügbar.' }]);
  res = await call('/api/articles?infographicReview=1', 'admin');
  assert.deepEqual(ids(res), [data.info.id]);
});

test('Einzelartikel: Gruppe, Dublette, feste Fehlercodes', async t => {
  const data = fixture();
  let failure = null;
  const call = await start(t, data, { bodies: async () => { if (failure) throw failure; return { bodyHtml: '<p>Text</p>' }; } });
  const url = id => `/api/articles/${encodeURI(id)}`;

  let res = await call(url(data.info.id), 'admin');
  assert.equal(res.status, 200);
  assert.deepEqual([res.data.id, res.data.requestedId, res.data.bodyHtml], [data.blog.id, data.info.id, '<p>Text</p>']);
  assert.deepEqual([res.data.canUploadInfographic, res.data.bookmarked, res.data.images.length], [true, true, 2]);
  assert.equal(res.data.shareId, shareIdFor(data.blog.id), 'Teilen-ID des geöffneten Ankers');
  assert.match(res.data.shareId, /^[A-Za-z0-9_-]{12}$/);

  res = await call(url(data.facebook.id));
  assert.deepEqual([res.data.id, res.data.requestedId, res.data.canUploadInfographic], [data.blog.id, data.facebook.id, false]);
  res = await call(url(data.blog.id));
  assert.equal(res.data.requestedId, undefined);

  res = await call(url('Joe/2026/fehlt'));
  assert.deepEqual([res.status, res.data], [404, { error: 'Nicht gefunden.', code: 'not_found' }]);
  res = await call(url(data.secret.id));
  assert.deepEqual([res.status, res.data], [403, { error: 'Kein Zugriff.', code: 'forbidden' }]);

  failure = Object.assign(new Error('ENOENT: /www/Joe/2026/achtsamkeit.md'), { code: 'ENOENT' });
  res = await call(url(data.blog.id));
  assert.deepEqual([res.status, res.data], [404, { error: 'Nicht gefunden.', code: 'not_found' }]);

  failure = new Error('EACCES: /www/Joe/2026/achtsamkeit.md');
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try { res = await call(url(data.blog.id)); } finally { console.error = original; }
  assert.deepEqual([res.status, res.data], [500, { error: 'Der Artikel konnte nicht geladen werden.' }]);
  assert.equal(logged.length, 1);
});

test('Facetten: Autoren nach Rechten gefiltert', async t => {
  const data = fixture();
  const call = await start(t, data);
  let res = await call('/api/meta');
  assert.deepEqual(res.data, {
    authors: ['Facebook', 'Infografiken', 'Joe', 'Telegram'], years: ['2026', '2025'], categories: ['Achtsamkeit'],
  });
  res = await call('/api/meta', 'admin');
  assert.equal(res.data.authors.length, 5);
});
