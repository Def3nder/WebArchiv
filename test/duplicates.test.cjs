const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs/promises');

const {
  normalizeDuplicateText, buildDuplicateProfile, compareDuplicateProfiles,
  detectDuplicateCandidates, createDuplicateStore, decisionStillApplies, loadDuplicateConfig,
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
  const config = loadDuplicateConfig(path.join(__dirname, '..', 'config.json'));
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
