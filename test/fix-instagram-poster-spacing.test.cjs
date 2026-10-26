const test = require('node:test');
const assert = require('node:assert/strict');
const { fixInstagramPosterSpacing, parseArguments } = require('../scripts/fix-instagram-poster-spacing.js');

test('Korrekturskript trennt Datum und Poster-Marker durch eine Leerzeile', () => {
  const original = '# Grafik\r\n\r\nDatum: 2026-10-25\r\nInstagram-Poster: Ja\r\n\r\nZusammenfassung: Text\r\n';
  assert.equal(fixInstagramPosterSpacing(original),
    '# Grafik\r\n\r\nDatum: 2026-10-25\r\n\r\nInstagram-Poster: Ja\r\n\r\nZusammenfassung: Text\r\n');
});

test('Korrekturskript lässt bereits getrennte und andere Marker unverändert', () => {
  assert.equal(fixInstagramPosterSpacing('Datum: 2026-10-25\n\nInstagram-Poster: Ja\n'), null);
  assert.equal(fixInstagramPosterSpacing('Titel\nInstagram-Poster: Ja\n'), null);
  assert.equal(fixInstagramPosterSpacing('Datum: 2026-10-25\nInstagram-Poster: Nein\n'), null);
});

test('Korrekturskript ist ohne --write immer ein Probelauf', () => {
  assert.deepEqual(parseArguments([]), {
    write: false,
    root: require('node:path').join(__dirname, '..', 'www', 'Infografiken'),
  });
  assert.equal(parseArguments(['--write']).write, true);
});
