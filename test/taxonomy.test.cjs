const test = require('node:test');
const assert = require('node:assert/strict');
const { TAXONOMY, autoCategorize, categoryScores, mergeCategories, MAX_CATEGORIES } = require('../lib/taxonomy.cjs');

const score = (text, label, title = '') => categoryScores(text, title).scores[TAXONOMY.findIndex(b => b.label === label)];

test('Suchwörter treffen ganze Wörter statt beliebiger Teilstrings', () => {
  // „ehe“ steckt in gehen/sehen/geschehen, „würde“ ist meist Konjunktiv,
  // „sucht“ steckt in versucht/Sehnsucht, „reife“ in begreifen.
  assert.equal(score('Wir gehen, sehen und verstehen, was geschehen ist.', 'Beziehungen'), 0);
  assert.equal(score('Ich würde es versuchen, er versucht es, voller Sehnsucht.', 'Psychologie'), 0);
  assert.equal(score('Er würde es begreifen.', 'Persönlichkeit'), 0);
  assert.ok(score('Unsere Ehe war schwierig.', 'Beziehungen') > 0);
  assert.ok(score('Die Sucht bestimmte sein Leben.', 'Psychologie') > 0);
});

test('Komposita: lange Stämme treffen auch im Wortinneren, Nervensystem zählt nicht als Gesellschaft', () => {
  assert.ok(score('Ein Kindheitstrauma wirkt lange nach.', 'Trauma & Heilung') > 0);
  assert.ok(score('Das ist ein Beziehungsmuster.', 'Beziehungen') > 0);
  assert.equal(score('Dein Nervensystem braucht Ruhe.', 'Gesellschaft'), 0);
  assert.ok(score('Dein Nervensystem braucht Ruhe.', 'Gesundheit') > 0);
  assert.ok(score('Gegen Pornografie-Sucht hilft …', 'Psychologie') > 0);
});

test('Der Titel zählt stärker als derselbe Begriff im Text', () => {
  assert.ok(score('Text.', 'Spiritualität', 'Die Seele') > score('Die Seele. Text.', 'Spiritualität'));
});

test('Höchstens drei Kategorien, nur oberhalb der Mindestschwelle, die stärkste zuerst', () => {
  const text = 'Orgasmus und Sexualität. Tantra. Libido. Beziehung, Partner, Ehe. Trauma und Heilung. '
    + 'Spiritualität und Meditation. Selbstwert und Selbstliebe. Gesundheit und Hormone. Philosophie.';
  const categories = autoCategorize(text, 'Sexualität und Orgasmus');
  assert.ok(categories.length <= MAX_CATEGORIES);
  assert.equal(categories[0], 'Sexualität');
  // Ein einzelnes schwaches Indiz reicht nicht.
  assert.deepEqual(autoCategorize('Ein ruhiger Spaziergang im Park, danach Kaffee mit Freunden und ein gutes Buch.'), []);
  assert.deepEqual(autoCategorize('Wir gehen spazieren und sehen, was geschehen wird.'), []);
});

test('Typische Artikel landen in der passenden Kategorie', () => {
  assert.equal(autoCategorize('Wie eine Narzisstin manipuliert, und warum Gaslighting so wirkt.', 'Narzissmus erkennen')[0], 'Psychologie');
  assert.equal(autoCategorize('Magnesium, Vitamin D und Schlaf in der Perimenopause.', 'Was in den Wechseljahren hilft')[0], 'Gesundheit');
  assert.equal(autoCategorize('Über Propaganda, Gehorsam und das NS-Regime.', 'Die Sprache, die dem Völkermord vorausgeht')[0], 'Gesellschaft');
  assert.ok(autoCategorize('Der Mann führt, die Frau empfängt: Polarität zwischen Männlichkeit und Weiblichkeit.', 'Männer und Frauen')
    .includes('Männer & Frauen'));
});

test('Jede Kategorie ist einzigartig benannt und hat Suchwörter', () => {
  assert.equal(new Set(TAXONOMY.map(b => b.label)).size, TAXONOMY.length);
  for (const bucket of TAXONOMY) assert.ok(Object.values(bucket.keys).flat().length > 5, bucket.label);
  assert.deepEqual(mergeCategories(['Achtsamkeit'], ['Psychologie', 'Achtsamkeit', 'Gesundheit', 'Philosophie']),
    ['Achtsamkeit', 'Psychologie', 'Gesundheit']);
});
