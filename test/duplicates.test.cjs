const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');

const {
  normalizeDuplicateText, buildDuplicateProfile, compareDuplicateProfiles,
  detectDuplicateCandidates, createDuplicateStore, decisionStillApplies, loadDuplicateConfig,
  finishDuplicateLinks, BOOKMARK_MOVE_WARNING, createDuplicateDetection, DEFAULT_CONFIG,
} = require('../duplicates.cjs');

const article = (author, id, title, body, date = '2026-01-01') => ({
  author, id, title, date, duplicateProfile: buildDuplicateProfile(title, body),
});

test('normalisiert Markdown, URLs, Großschreibung und Satzzeichen stabil', () => {
  assert.equal(normalizeDuplicateText('**Größe** – siehe https://example.org!'), 'größe siehe');
});

test('erkennt identische und leicht erweiterte Blogfassungen', () => {
  const base = 'Berührung kann den Körper beruhigen und Sicherheit vermitteln. '.repeat(12);
  const facebook = article('Facebook', 'Facebook/2026/a', 'Berührung und Heilung', base);
  const exact = article('Joe Turan', 'Joe Turan/2026/a', 'Berührung und Heilung', base, '2026-01-08');
  const expanded = article('Joe Turan', 'Joe Turan/2026/b', 'Warum Berührung heilsam ist', `${base}Ein zusätzlicher Absatz für den Blog.`, '2026-01-10');
  assert.equal(compareDuplicateProfiles(exact, facebook).exact, true);
  assert.ok(compareDuplicateProfiles(expanded, facebook).score >= 0.8);
  assert.equal(detectDuplicateCandidates([facebook, exact, expanded]).length, 2);
});

test('kurze oder nur thematisch ähnliche Texte werden nicht vorgeschlagen', () => {
  const short = article('Facebook', 'Facebook/2026/kurz', 'Angst', 'Angst ist ein Gefühl und darf da sein.');
  const other = article('Joe Turan', 'Joe Turan/2026/kurz', 'Angst verstehen', 'Angst ist ein Gefühl und darf da sein.');
  assert.equal(compareDuplicateProfiles(other, short), null);
});

test('Telegram und nicht konfigurierte Facebook-Autoren bleiben unberücksichtigt', () => {
  const body = 'Ein ausreichend langer identischer Beispieltext über das Leben und die innere Entwicklung. '.repeat(10);
  const blog = article('Joe Turan', 'Joe Turan/2026/a', 'Titel', body);
  const telegram = article('Telegram', 'Telegram/2026/a', 'Titel', body);
  const publicFacebook = article('Joe Turan Facebook', 'Joe Turan Facebook/2026/a', 'Titel', body);
  assert.deepEqual(detectDuplicateCandidates([blog, telegram, publicFacebook]), []);
});

test('Facebook und Coaching sind konfigurierte Quellen, Telegram bleibt ausgeschlossen', () => {
  // config.json ist nicht eingecheckt; die Vorlage enthält dieselbe Dubletten-Konfiguration.
  const config = loadDuplicateConfig(path.join(__dirname, '..', 'example-config.json'));
  assert.deepEqual(config.facebookAuthors, ['Facebook', 'Coaching']);
  const body = 'Ein ausreichend langer identischer Beispieltext über das Leben und die innere Entwicklung. '.repeat(10);
  const blog = article(config.blogAuthor, 'Joe Turan/2026/a', 'Titel', body);
  const sources = ['Facebook', 'Coaching', 'Telegram'].map(author => article(author, `${author}/2026/a`, 'Titel', body));
  assert.deepEqual(detectDuplicateCandidates([blog, ...sources], config).map(item => item.facebook.author), ['Facebook', 'Coaching']);
});

test('ignorierte Entscheidung gilt nur für unveränderte Inhalte, Verknüpfung dauerhaft', () => {
  const body = 'Ein ausreichend langer Text für die Prüfung einer gespeicherten Entscheidung. '.repeat(10);
  const blog = article('Joe Turan', 'b', 'Titel', body);
  const facebook = article('Facebook', 'f', 'Titel', body);
  const ignored = { status: 'ignored', blogHash: blog.duplicateProfile.hash, facebookHash: facebook.duplicateProfile.hash };
  assert.equal(decisionStillApplies(ignored, blog, facebook), true);
  facebook.duplicateProfile = buildDuplicateProfile('Titel', `${body} geändert`);
  assert.equal(decisionStillApplies(ignored, blog, facebook), false);
  assert.equal(decisionStillApplies({ status: 'linked' }, blog, facebook), true);
});

test('Store ersetzt Entscheidungen atomar und erlaubt nur eine Verknüpfung pro Facebook-Artikel', async () => {
  const root = path.join(process.cwd(), '.test');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'webarchiv-duplicates-'));
  test.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'decisions.json');
  const store = createDuplicateStore({ file });
  store.load();
  await store.set({ blogId: 'b1', facebookId: 'f', status: 'linked', blogHash: '1', facebookHash: '2', user: 'admin' });
  await store.set({ blogId: 'b2', facebookId: 'f', status: 'linked', blogHash: '3', facebookHash: '2', user: 'admin' });
  assert.equal(store.all().length, 1);
  assert.equal(store.linkedCanonicalId('f'), 'b2');
  await store.remove('b2', 'f');
  assert.deepEqual(store.all(), []);
});

test('Store speichert eine Sammelauswahl gemeinsam und behält nur ein Blogziel je Facebook-Artikel', async () => {
  const root = path.join(process.cwd(), '.test');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'webarchiv-duplicates-batch-'));
  test.after(async () => fs.rm(dir, { recursive: true, force: true }));
  const store = createDuplicateStore({ file: path.join(dir, 'decisions.json') });
  store.load();
  await store.setMany([
    { blogId: 'b1', facebookId: 'f1', status: 'linked', blogHash: '1', facebookHash: '2', user: 'admin' },
    { blogId: 'b2', facebookId: 'f2', status: 'linked', blogHash: '3', facebookHash: '4', user: 'admin' },
    { blogId: 'b3', facebookId: 'f1', status: 'linked', blogHash: '5', facebookHash: '2', user: 'admin' },
  ]);
  assert.equal(store.all().length, 2);
  assert.equal(store.linkedCanonicalId('f1'), 'b3');
  assert.equal(store.linkedCanonicalId('f2'), 'b2');
});

test('Abschluss einer Verknüpfung: Lesezeichenfehler wird Hinweis, der Index wird trotzdem aktualisiert', async () => {
  const calls = [];
  const logged = [];
  const log = { error: (...args) => logged.push(args) };
  const migrations = [{ from: 'Infografiken/2025/a_1.png', to: 'Infografiken/2026/b_1.png' }];
  const failingBookmarks = { replaceArticleIds: async () => { throw Object.assign(new Error('EACCES: bookmarks.json'), { code: 'EACCES' }); } };
  const warning = await finishDuplicateLinks({
    replacements: [{ oldId: 'f1', newId: 'b1' }], migrations, bookmarks: failingBookmarks, log,
    refreshMigrations: async list => calls.push(['years', list]),
    refreshState: () => calls.push('state'),
  });
  assert.equal(warning, BOOKMARK_MOVE_WARNING);
  assert.deepEqual(calls, [['years', migrations]]);
  assert.equal(logged.length, 1, 'Ursache steht im Log');

  const moved = [];
  const ok = await finishDuplicateLinks({
    replacements: [{ oldId: 'f2', newId: 'b2' }], migrations: [], log,
    bookmarks: { replaceArticleIds: async list => moved.push(...list) },
    refreshMigrations: async () => calls.push('years'),
    refreshState: () => calls.push('state'),
  });
  assert.equal(ok, null);
  assert.deepEqual(moved, [{ oldId: 'f2', newId: 'b2' }]);
  assert.deepEqual(calls.at(-1), 'state');
});

test('Erkennung mit Zwischenspeicher: rechnet nur neu, wenn sich Blog- oder Quellartikel ändern', () => {
  const base = 'Berührung kann den Körper beruhigen und Sicherheit vermitteln. '.repeat(12);
  const facebook = article('Facebook', 'Facebook/2026/a', 'Berührung und Heilung', base, '2026-01-02');
  const blog = article('Joe Turan', 'Joe Turan/2026/a', 'Berührung und Heilung', base, '2026-01-08');
  const other = article('Joe Turan', 'Joe Turan/2026/b', 'Etwas ganz anderes', 'Völlig anderer Text über Gärten und Bäume. '.repeat(12));
  const infographic = { author: 'Infografiken', id: 'Infografiken/2026/x', title: 'Grafik', date: '2026-01-08', duplicateProfile: null };
  let runs = 0;
  const detection = createDuplicateDetection({ detect: (list, config) => { runs++; return detectDuplicateCandidates(list, config); } });
  // Jede Veröffentlichung erzeugt Kopien der Artikel, die Profile bleiben dieselben Objekte.
  const publish = list => list.map(item => ({ ...item }));

  const first = detection.candidates(publish([facebook, blog, other, infographic]), DEFAULT_CONFIG);
  assert.equal(first.reused, false);
  assert.equal(first.candidates.length, 1);

  // Infografik geändert oder hinzugekommen: kein neuer Lauf, Ergebnis zeigt auf die neuen Objekte.
  const current = publish([facebook, blog, other, { ...infographic, title: 'Neu' }, { ...infographic, id: 'Infografiken/2026/y' }]);
  const second = detection.candidates(current, DEFAULT_CONFIG);
  assert.equal(second.reused, true);
  assert.equal(runs, 1);
  assert.equal(second.candidates[0].blog, current[1]);
  assert.equal(second.candidates[0].facebook, current[0]);
  assert.deepEqual(
    second.candidates.map(({ blog: b, facebook: f, ...rest }) => ({ blog: b.id, facebook: f.id, ...rest })),
    detectDuplicateCandidates(current).map(({ blog: b, facebook: f, ...rest }) => ({ blog: b.id, facebook: f.id, ...rest })),
    'wiederverwendetes Ergebnis entspricht einer frischen Erkennung');

  // Jede relevante Änderung löst eine neue Erkennung aus.
  const changes = [
    [facebook, { ...blog, duplicateProfile: buildDuplicateProfile(blog.title, base + ' Neuer Absatz.') }, other],
    [facebook, { ...blog, date: '2026-03-01' }, other],
    [facebook, blog],
    [facebook, blog, other, article('Facebook', 'Facebook/2026/neu', 'Neu', base)],
    [blog, facebook, other],
  ];
  for (const list of changes) {
    const before = runs;
    assert.equal(detection.candidates(publish(list), DEFAULT_CONFIG).reused, false);
    assert.equal(runs, before + 1);
  }
  // Andere Konfiguration: ebenfalls neu.
  const config = { ...DEFAULT_CONFIG };
  assert.equal(detection.candidates(publish([blog, facebook, other]), config).reused, false);
  assert.equal(detection.candidates(publish([blog, facebook, other]), config).reused, true);
});
