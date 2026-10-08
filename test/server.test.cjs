const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArticle, linkInfographics, buildArticleSearchIndex, parseArticleSearchQuery,
  buildInfographicMarkdown, slugify, normalizeNewInfographicMarkdown, mergeCategories, parsePromptDefinition,
} = require('../server.js');

test('liest URL und Prompt aus einer Prompt-Datei getrennt', () => {
  const definition = parsePromptDefinition([
    '\uFEFFURL:',
    'https://chatgpt.com/example?mode=test',
    '',
    'PROMPT:',
    'Erste Zeile.',
    '',
    'Zweite Zeile.',
  ].join('\r\n'));

  assert.equal(definition.url, 'https://chatgpt.com/example?mode=test');
  assert.equal(definition.prompt, 'Erste Zeile.\n\nZweite Zeile.');
});

test('Prompt-Dateien erlauben nur HTTP(S)-URLs und einen nicht leeren Prompt', () => {
  assert.throws(
    () => parsePromptDefinition('URL:\nfile:///tmp/test\n\nPROMPT:\nText'),
    /HTTP oder HTTPS/
  );
  assert.throws(
    () => parsePromptDefinition('URL:\nhttps://example.com\n\nPROMPT:\n'),
    /Prompt ist leer/
  );
});

test('beginnt einen Blogartikel mit dem ersten Inhalt nach dem Datum', () => {
  const markdown = [
    '# Kann Berührung wirklich Medizin sein?',
    '',
    '*Quelle: https://example.com/blogartikel*',
    '',
    '**Datum: 2026-09-17**',
    '',
    'Erster Absatz des Artikels.',
    '',
    'Quelle: Studie im Artikeltext.',
    '',
    'Joe Turan',
  ].join('\n');

  const article = parseArticle(markdown, '2026-09-17_blogartikel.md');

  assert.equal(article.sourceUrl, 'https://example.com/blogartikel');
  assert.equal(
    article.body,
    'Erster Absatz des Artikels.\n\nQuelle: Studie im Artikeltext.\n\nJoe Turan'
  );
});

test('liest bekannte Metadaten direkt nach dem Datum weiterhin', () => {
  const markdown = [
    '# Artikel mit Metadaten',
    '',
    '**Datum: 2026-09-18**',
    '',
    '**Audioquickie: 42**',
    '**Kategorien: Körper, Gesundheit**',
    '',
    'Artikelinhalt.',
  ].join('\n');

  const article = parseArticle(markdown, '2026-09-18_metadaten.md');

  assert.equal(article.episodeNum, 42);
  assert.deepEqual(article.tags, ['Körper', 'Gesundheit']);
  assert.equal(article.body, 'Artikelinhalt.');
});

test('Audioquickie-Nummern sind als Zahl und mit Raute durchsuchbar', () => {
  const index = buildArticleSearchIndex([
    { id: 'Stefan/2961', title: 'Ein anderer Titel', author: 'Stefan Hiene', episodeNum: 2961, categories: [], excerpt: '' },
    { id: 'Stefan/2962', title: 'Noch ein Titel', author: 'Stefan Hiene', episodeNum: 2962, categories: [], excerpt: '' },
  ]);
  for (const query of ['2961', '#2961']) {
    const parsed = parseArticleSearchQuery(query, ['2025', '2026']);
    assert.equal(parsed.text, '2961');
    assert.deepEqual(parsed.dateConstraints, []);
    assert.equal(index.search(parsed.text)[0].item.id, 'Stefan/2961');
  }
  assert.deepEqual(parseArticleSearchQuery('2026 2961', ['2025', '2026']), {
    dateConstraints: [{ kind: 'prefix', value: '2026' }],
    text: '2961',
  });
});

// ── Infografik-Gruppen ─────────────────────────────────────────────────────
function entry(author, stem, extra = {}) {
  return {
    id: `${author}/2026/${stem}`, author, year: '2026', filePath: `/www/${author}/2026/${stem}.md`,
    categories: [], tags: [], audioUrl: null, ownImage: true, hasBody: author !== 'Infografiken', ...extra,
  };
}
const memberIds = (groups, anchorId) => (groups.get(anchorId) || []).map(member => member.id);

test('Infografiken mit Episodennummer im Namen finden ihren Artikel', () => {
  const list = [
    entry('Stefan Hiene', '2026-01-02_Audioquickie_2961', { audioUrl: '/files/a.mp3', categories: ['Verstand'], tags: ['Sucht'] }),
    entry('Infografiken', '2026-01-02_Audioquickie_2961'),
    entry('Infografiken', '2026-01-02_Audioquickie_2961_2'),
    entry('Infografiken', '2026-01-03_Audioquickie_2962'),
  ];
  const { groups, anchorOf } = linkInfographics(list);

  assert.deepEqual(memberIds(groups, 'Stefan Hiene/2026/2026-01-02_Audioquickie_2961'),
    ['Infografiken/2026/2026-01-02_Audioquickie_2961', 'Infografiken/2026/2026-01-02_Audioquickie_2961_2']);
  assert.equal(list[2].audioUrl, '/files/a.mp3');
  assert.equal(list[2].inheritedAudioAuthor, 'Stefan Hiene');
  assert.deepEqual(list[2].categories, ['Verstand']);
  assert.deepEqual(list[2].tags, ['Sucht']);
  // Ohne Artikel und ohne Varianten bleibt die Grafik einzeln.
  assert.equal(anchorOf.has('Infografiken/2026/2026-01-03_Audioquickie_2962'), false);
});

test('Varianten ohne Artikel werden unter der Basis-Infografik gruppiert', () => {
  const list = [
    entry('Infografiken', '2026-02-01_thema'),
    entry('Infografiken', '2026-02-01_thema_3'),
    entry('Infografiken', '2026-02-01_thema_2'),
  ];
  const { groups } = linkInfographics(list);
  assert.deepEqual(memberIds(groups, 'Infografiken/2026/2026-02-01_thema'),
    ['Infografiken/2026/2026-02-01_thema_2', 'Infografiken/2026/2026-02-01_thema_3']);
});

test('Infografik mit eigenem Text ist ein Original; ihre Varianten gehören zu ihr', () => {
  const list = [
    entry('Facebook', '2026-06-15_angst'),
    entry('Infografiken', '2026-06-15_angst', { hasBody: true, categories: ['Angst'] }),
    entry('Infografiken', '2026-06-15_angst_2', { hasBody: true }),
  ];
  const { groups, anchorOf } = linkInfographics(list);
  assert.equal(anchorOf.has('Infografiken/2026/2026-06-15_angst'), false);
  assert.deepEqual(memberIds(groups, 'Infografiken/2026/2026-06-15_angst'), ['Infografiken/2026/2026-06-15_angst_2']);
  assert.deepEqual(list[2].categories, ['Angst']);
  assert.equal(groups.has('Facebook/2026/2026-06-15_angst'), false);
});

test('Mehrdeutiger Basisartikel: eindeutiger Kandidat mit Audio, sonst keine Gruppe', () => {
  const withAudio = [
    entry('Coaching', '2026-03-01_x', { audioUrl: '/files/x.mp3' }),
    entry('Telegram', '2026-03-01_x'),
    entry('Infografiken', '2026-03-01_x'),
  ];
  assert.deepEqual(memberIds(linkInfographics(withAudio).groups, 'Coaching/2026/2026-03-01_x'), ['Infografiken/2026/2026-03-01_x']);

  const ambiguous = [entry('Coaching', '2026-03-01_y'), entry('Telegram', '2026-03-01_y'), entry('Infografiken', '2026-03-01_y')];
  assert.equal(linkInfographics(ambiguous).anchorOf.size, 0);
});

test('Mehrdeutiger Basisartikel folgt der konfigurierten Autoren-Priorität', () => {
  const list = [
    entry('Telegram', '2026-10-07_thema'),
    entry('Facebook', '2026-10-07_thema'),
    entry('Joe Turan', '2026-10-07_thema'),
    entry('Infografiken', '2026-10-07_thema'),
  ];
  const { groups } = linkInfographics(list, ['Joe Turan', 'Facebook', 'Telegram']);
  assert.deepEqual(memberIds(groups, 'Joe Turan/2026/2026-10-07_thema'), ['Infografiken/2026/2026-10-07_thema']);

  const withoutJoe = list.filter(article => article.author !== 'Joe Turan');
  const fallback = linkInfographics(withoutJoe, ['Joe Turan', 'Facebook', 'Telegram']);
  assert.deepEqual(memberIds(fallback.groups, 'Facebook/2026/2026-10-07_thema'), ['Infografiken/2026/2026-10-07_thema']);
});

test('Varianten _2 eines normalen Artikels und gleiches Jahr als Bedingung', () => {
  const list = [
    entry('Joe Turan', '2026-04-01_blog'),
    entry('Infografiken', '2026-04-01_blog_2'),
    { ...entry('Infografiken', '2026-04-01_blog'), id: 'Infografiken/2025/2026-04-01_blog', year: '2025' },
  ];
  const { groups, anchorOf } = linkInfographics(list);
  assert.deepEqual(memberIds(groups, 'Joe Turan/2026/2026-04-01_blog'), ['Infografiken/2026/2026-04-01_blog_2']);
  assert.equal(anchorOf.has('Infografiken/2025/2026-04-01_blog'), false);
});

test('Neue Grafik übernimmt keine Kategorien-Zeile', () => {
  const source = [
    '# Titel', '', '**Datum:** 2026-01-02', '', '**Audioquickie:** 2961', '', '**Kategorien:** Verstand, Sucht', '', '****', '', 'Body',
  ].join('\n');
  assert.equal(buildInfographicMarkdown(source, 2),
    ['# Titel (2)', '', '**Datum:** 2026-01-02', '', '**Audioquickie:** 2961', ''].join('\n'));
});

// ── Neue eigenständige Infografik ──────────────────────────────────────────
test('Dateiname aus dem Titel: Umlaute, Sonderzeichen, Länge', () => {
  assert.equal(slugify('Wie läuft’s? Größe & Übung – 100 %!'), 'wie-laeuft-s-groesse-uebung-100');
  assert.equal(slugify('Élan vital'), 'elan-vital');
  assert.equal(slugify('„«»“'), '');
  const long = slugify('Wort '.repeat(40));
  assert.ok(long.length <= 80 && !long.endsWith('-'));
});

test('Vorlage: leere Kategorien und Platzhalter [Inhalt] werden entfernt', () => {
  const template = '# Mein Titel\n\nDatum: 2026-09-29\nKategorien: []\n\n----\n\n[Inhalt]\n';
  assert.equal(normalizeNewInfographicMarkdown(template), '# Mein Titel\n\nDatum: 2026-09-29\n\n----\n');
  const filled = '# Mein Titel\r\n\r\nDatum: 2026-09-29\r\nKategorien: [Angst, Mut]\r\n\r\n----\r\n\r\nEigener Text.';
  const result = normalizeNewInfographicMarkdown(filled);
  assert.equal(result, '# Mein Titel\n\nDatum: 2026-09-29\nKategorien: Angst, Mut\n\n----\n\nEigener Text.\n');
  const parsed = parseArticle(result, '2026-09-29_mein-titel.md');
  assert.deepEqual(parsed.tags, ['Angst', 'Mut']);
  assert.equal(parsed.body, 'Eigener Text.');
  assert.equal(parseArticle(normalizeNewInfographicMarkdown(template), 'x.md').body, '');
});

test('Angehakte Kategorien werden beim Speichern eingefügt bzw. ergänzt', () => {
  const template = '# Titel\n\nDatum: 2026-09-29\n\n----\n\n[Inhalt]\n';
  assert.equal(normalizeNewInfographicMarkdown(template, ['Psychologie', 'Achtsamkeit', 'Unbekannt']),
    '# Titel\n\nDatum: 2026-09-29\nKategorien: Psychologie, Achtsamkeit\n\n----\n');
  const typed = '# Titel\n\nDatum: 2026-09-29\nKategorien: [Mut, Psychologie]\n\n----\n\nText.';
  assert.equal(normalizeNewInfographicMarkdown(typed, ['Psychologie', 'Gesundheit']),
    '# Titel\n\nDatum: 2026-09-29\nKategorien: Mut, Psychologie, Gesundheit\n\n----\n\nText.\n');
});

test('Filter-Kategorien aus der Kategorien-Zeile zählen zuerst', () => {
  assert.deepEqual(mergeCategories(['Mut', 'Achtsamkeit'], ['Psychologie', 'Achtsamkeit']), ['Achtsamkeit', 'Psychologie']);
  assert.deepEqual(mergeCategories(['Gesundheit'], ['A', 'B', 'C', 'D', 'E']), ['Gesundheit', 'A', 'B', 'C', 'D']);
});
