'use strict';

// Testarchiv (Review 3.5): die Kombinationen, die der Code unterscheidet – Artikel und Medien, Infografik-Gruppen,
// Instagram-Poster, Dubletten (auch mit Grafiken), Zugriffsrechte und Hörbücher. Jeder Fall nennt Zweck, Dateien,
// optionale Vorbereitung über die echten Routen und die erwarteten Ergebnisse. build() legt das Archiv in einem
// leeren Ordner an; test/fixture-archive.test.cjs startet den Server darauf und prüft die Fälle über die API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');

const MEDIA = path.join(__dirname, 'smoke');

// ── Texte ────────────────────────────────────────────────────────────────────
// Jeder Satz kommt nur in einem Text vor; so überlappen Dublettenpaare nur dort, wo ein Fall es will.
const SENTENCES = [
  'Eine Beziehung lebt davon, dass beide Partner einander zuhören und sich gegenseitig ernst nehmen.',
  'Wer in der Partnerschaft seine Bedürfnisse offen anspricht, vermeidet viele stille Missverständnisse.',
  'Nähe entsteht nicht durch große Gesten, sondern durch kleine Aufmerksamkeiten im ganz normalen Alltag.',
  'Streit gehört dazu, solange beide danach wieder aufeinander zugehen und den Faden neu aufnehmen.',
  'Vertrauen wächst langsam und braucht Verlässlichkeit, Ehrlichkeit und ein gutes Stück Geduld.',
  'Am Abend hilft ein kurzer Spaziergang, den Tag hinter sich zu lassen und den Kopf zu ordnen.',
  'Achtsamkeit bedeutet, den gegenwärtigen Moment wahrzunehmen, ohne ihn sofort zu bewerten.',
  'Schon drei bewusste Atemzüge können die innere Unruhe spürbar dämpfen und Abstand schaffen.',
  'Wer regelmäßig meditiert, bemerkt Gedankenschleifen früher und kann freundlicher mit sich umgehen.',
  'Der Körper meldet Stress oft lange bevor der Verstand ihn als solchen erkennt und benennt.',
  'Im Garten zeigt sich jedes Frühjahr, wie viel Kraft in einem unscheinbaren Samenkorn steckt.',
  'Tomaten mögen einen sonnigen Standort, lockeren Boden und regelmäßiges Gießen am frühen Morgen.',
  'Kompost verwandelt Küchenabfälle in wertvolle Erde und schließt einen kleinen natürlichen Kreislauf.',
  'Im Herbst sammeln sich die Blätter unter der alten Linde zu einem bunten, raschelnden Teppich.',
  'Eine gute Besprechung beginnt mit einer klaren Frage und endet mit verbindlichen nächsten Schritten.',
  'Viele Aufgaben werden leichter, wenn man sie in kleine, überschaubare Etappen aufteilt.',
  'Pausen sind kein Luxus, sondern eine Voraussetzung dafür, über Stunden konzentriert zu arbeiten.',
  'Wer seine Woche am Montag plant, gewinnt am Freitag oft unerwartet freie Zeit zurück.',
  'Rückmeldungen wirken am besten, wenn sie konkret, zeitnah und freundlich formuliert sind.',
  'Brot backen verlangt vor allem Zeit, denn ein guter Teig braucht viele Stunden Ruhe.',
  'Sauerteig entwickelt mit jedem Füttern mehr Säure und ein immer kräftigeres Aroma.',
  'Frische Kräuter geben einfachen Gerichten eine überraschende Tiefe und eine leichte Note.',
  'Eine Suppe aus Wurzelgemüse wärmt an kalten Tagen und lässt sich wunderbar vorbereiten.',
  'Beim Wandern in den Bergen ändert sich das Wetter manchmal innerhalb weniger Minuten.',
  'Eine gut gepackte Tasche enthält Wasser, eine Jacke gegen Regen und eine kleine Karte.',
  'Oben auf dem Gipfel belohnt der weite Blick für jeden mühsamen Schritt des Aufstiegs.',
  'Der Abstieg fordert die Knie oft mehr als der Weg nach oben und verdient volle Aufmerksamkeit.',
  'Kinder lernen am meisten, wenn sie selbst ausprobieren dürfen und Fehler machen können.',
  'Vorlesen am Abend stärkt die Bindung und weckt ganz nebenbei die Freude an Geschichten.',
  'Geschwister streiten heftig und versöhnen sich oft schneller, als Erwachsene es erwarten.',
  'Ein fester Rhythmus im Tagesablauf gibt kleinen Kindern Sicherheit und Orientierung.',
  'Musik kann Erinnerungen wecken, die lange verschüttet schienen und plötzlich wieder da sind.',
  'Ein Instrument zu lernen erfordert tägliche Übung, auch wenn es nur wenige Minuten sind.',
  'Im Chor zu singen verbindet Menschen, die sich sonst vielleicht nie begegnet wären.',
  'Leise Musik im Hintergrund hilft manchen beim Lesen, andere lenkt sie nur ab.',
  'Alte Fotos erzählen Geschichten über Menschen, Orte und Zeiten, die längst vergangen sind.',
  'Ein Tagebuch hilft, Gedanken zu sortieren und Entwicklungen über Jahre hinweg zu sehen.',
  'Briefe mit der Hand zu schreiben verlangsamt das Denken auf eine wohltuende Weise.',
  'Bücher aus der Bibliothek erinnern daran, wie viel Wissen frei für alle zugänglich ist.',
  'Fahrradfahren in der Stadt ist oft schneller als die Fahrt mit dem Auto im dichten Verkehr.',
  'Ein gut eingestellter Sattel schont den Rücken auch auf längeren Strecken über Land.',
  'Wer im Winter radelt, braucht helle Lichter, warme Handschuhe und etwas Gelassenheit.',
  'Am Fluss entlang führt ein breiter Weg, der im Sommer von vielen Familien genutzt wird.',
  'Ein ruhiger Sonntag ohne Termine kann mehr Erholung bringen als ein ganzer Kurzurlaub.',
  'Freundschaften brauchen Pflege, besonders wenn das Leben alle Beteiligten stark fordert.',
  'Ein ehrliches Gespräch unter Freunden klärt oft mehr als lange Grübeleien allein.',
  'Gemeinsames Kochen verbindet und endet meistens an einem gut gedeckten, fröhlichen Tisch.',
  'Wer anderen hilft, erlebt häufig selbst eine stille und tiefe Form von Zufriedenheit.',
  'Ein Umzug ist eine Gelegenheit, sich von Dingen zu trennen, die nur noch Platz beanspruchen.',
  'Die erste Nacht in einer neuen Wohnung klingt fremd, bis die Geräusche vertraut werden.',
  'Nachbarn, die man grüßt, machen aus einem Haus mit vielen Türen ein echtes Zuhause.',
  'Ordnung entsteht leichter, wenn jedes Ding einen festen Platz hat und dorthin zurückkehrt.',
  'Früh am Morgen ist die Luft am klarsten und die Straßen gehören den Vögeln.',
  'Ein Glas Wasser nach dem Aufstehen weckt den Körper sanfter als die erste Tasse Kaffee.',
  'Kurze Bewegungspausen am Schreibtisch lösen Verspannungen, bevor sie zu Schmerzen werden.',
  'Ausreichend Schlaf ist eine der wirksamsten Maßnahmen für Gesundheit und gute Laune.',
  'Ein Spaziergang im Regen kann überraschend befreiend wirken, wenn man passend angezogen ist.',
  'Wer neue Gewohnheiten aufbauen will, beginnt am besten mit einem einzigen kleinen Schritt.',
  'Ein voller Kalender fühlt sich produktiv an, lässt aber oft keinen Raum für das Wesentliche.',
  'Beim Lesen eines guten Romans vergeht die Zeit, ohne dass man es überhaupt bemerkt.',
  'Ein Fehler ist meist nur der Hinweis darauf, dass ein anderer Weg besser funktioniert.',
  'Wer Dankbarkeit übt, richtet den Blick häufiger auf das, was im Leben bereits gelingt.',
  'Ein aufgeräumter Schreibtisch erleichtert den Einstieg in eine schwierige Aufgabe am Morgen.',
  'Gespräche am Küchentisch sind oft ehrlicher als jede förmliche Unterhaltung im Wohnzimmer.',
  'Ein Ehrenamt schenkt neue Kontakte und das gute Gefühl, wirklich gebraucht zu werden.',
  'Wer langsam isst, merkt früher, wann er satt ist, und genießt jede Mahlzeit bewusster.',
  'Ein kurzer Anruf bei einem alten Bekannten kann einen ganzen grauen Tag aufhellen.',
  'Am Meer wirkt die Weite des Horizonts beruhigend auf viele unruhige Gedanken.',
];
// Jeder Blogartikel („Joe Turan“) wird mit jedem Quellbeitrag („Facebook“, „Coaching“) verglichen: Die Sätze der
// Dublettenpaare (D22–D30) kommen deshalb nirgends sonst in Blog- oder Quelltexten vor.
const some = (...indexes) => indexes.map(index => SENTENCES[index]).join(' ');
// Texte aus Satzbereichen; jeder Bereich gehört genau einem Fall.
const text = (from, count) => SENTENCES.slice(from, from + count).join(' ');

function md({ title, date, summary, tags, quelle, audioquickie, poster, body = '' }) {
  const lines = [title];
  if (date !== null) lines.push(`Datum: ${date}`);
  if (audioquickie) lines.push(`Audioquickie: ${audioquickie}`);
  if (poster) lines.push('Instagram-Poster: Ja');
  if (tags) lines.push(`Kategorien: ${tags}`);
  if (quelle) lines.push(`Quelle: ${quelle}`);
  if (summary) lines.push('Zusammenfassung:', summary);
  lines.push('****', '');
  if (body) lines.push(body, '');
  return lines.join('\n');
}

// Datei-Bausteine: { path (relativ zum Archivordner), kind, … }
const article = (file, fields) => ({ path: `www/${file}.md`, kind: 'text', content: md(fields) });
// Platzhalter-Infografik: Kopf ohne Text, wie ihn der Server aus dem Blogkopf schreibt (Titel, Datum aus dem
// Dateinamen; ohne Datum-Zeile zählte eine Poster-Zeile zum Titel).
const placeholder = (file, title, extra = {}) => article(file,
  { title, date: path.basename(file).slice(0, 10), ...extra });
const image = (file, label) => ({ path: `www/${file}`, kind: 'image', label });
const sound = file => ({ path: file, kind: 'copy', from: 'silence.mp3' });
const raw = (file, content) => ({ path: file, kind: 'text', content });

const id = file => file; // Artikel-IDs sind Autor/Jahr/Dateistamm ohne .md.

// ── Benutzer, öffentliche Autoren, Einstellungen ─────────────────────────────
const USERS = {
  admin: { email: 'admin@smoke.test', role: 'admin', allowedAuthors: null },
  // Whitelist: nur „Stefan Hiene“ (plus öffentliche Autoren).
  reader: { email: 'leser@smoke.test', role: 'user', allowedAuthors: ['Stefan Hiene'] },
  // Ohne Einschränkung, aber kein Admin (private Hörbücher).
  member: { email: 'alle@smoke.test', role: 'user', allowedAuthors: null },
  // Muss erst ein neues Kennwort festlegen.
  fresh: { email: 'neu@smoke.test', role: 'user', allowedAuthors: null, mustChangePassword: true },
};
const PUBLIC_AUTHORS = ['Videos', 'PDF', 'Infografiken'];
const CONFIG = {
  authorPriority: ['Joe Turan', 'Facebook', 'Coaching', 'Ralf', 'Stefan Hiene', 'Telegram', 'Infografiken', 'PDF', 'Videos'],
  duplicates: { blogAuthor: 'Joe Turan', facebookAuthors: ['Facebook', 'Coaching'], maxDateDistanceDays: 730, minimumTokens: 35 },
  audiobooks: { skipLongSeconds: 600, skipShortSeconds: 30 },
};
const AUTHORS = ['Joe Turan', 'Facebook', 'Coaching', 'Joe Turan Facebook', 'Telegram', 'Stefan Hiene', 'Ralf',
  'Infografiken', 'PDF', 'Videos', 'Autor A', 'Autor B'];

// Hilfen für die Erwartungen (ctx kommt aus dem Test: as(rolle).get/post, tiles, list, detail, duplicates …).
const ids = items => items.map(item => item.id);
const tileOf = (tiles, articleId) => tiles.find(tile => tile.id === articleId);

// ── Fälle ────────────────────────────────────────────────────────────────────
const CASES = [
  // A. Artikel und Medien
  {
    id: 'A01', title: 'Artikel mit eigenem Bild',
    files: [article('Ralf/2026/2026-03-01_eigenes-bild', { title: 'Eigenes Bild', date: '2026-03-01', body: text(0, 3) }),
      image('Ralf/2026/2026-03-01_eigenes-bild.jpg', 'A01')],
    async check(ctx) {
      const detail = await ctx.detail('admin', id('Ralf/2026/2026-03-01_eigenes-bild'));
      assert.match(detail.imageUrl, /2026-03-01_eigenes-bild\.jpg/);
      assert.equal(detail.images, undefined, 'ohne Infografiken keine Bildergruppe');
    },
  },
  {
    id: 'A02', title: 'Artikel ohne Bild nimmt standard.jpg des Autors',
    files: [article('Ralf/2026/2026-03-02_ohne-bild', { title: 'Ohne Bild', date: '2026-03-02', body: text(3, 2) })],
    async check(ctx) {
      assert.match((await ctx.detail('admin', id('Ralf/2026/2026-03-02_ohne-bild'))).imageUrl, /Ralf\/standard\.jpg/);
    },
  },
  {
    id: 'A03', title: 'Audio neben dem Artikel',
    files: [article('Ralf/2026/2026-03-03_audio-daneben', { title: 'Audio daneben', date: '2026-03-03', body: text(5, 2) }),
      sound('www/Ralf/2026/2026-03-03_audio-daneben.mp3')],
    async check(ctx) {
      const detail = await ctx.detail('admin', id('Ralf/2026/2026-03-03_audio-daneben'));
      assert.match(detail.audioUrl, /^\/files\/Ralf\/2026\/2026-03-03_audio-daneben\.mp3/);
      assert.equal(detail.hasExternalAudio, false);
    },
  },
  {
    id: 'A04', title: 'Audio unter audio/<Autor>/… (extern)',
    files: [article('Ralf/2026/2026-03-04_audio-extern', { title: 'Audio extern', date: '2026-03-04', body: text(7, 2) }),
      sound('audio/Ralf/2026/2026-03-04_audio-extern.mp3')],
    async check(ctx) {
      const detail = await ctx.detail('admin', id('Ralf/2026/2026-03-04_audio-extern'));
      assert.match(detail.audioUrl, /^\/audio-files\/Ralf\/2026\/2026-03-04_audio-extern\.mp3/);
      assert.equal(detail.hasExternalAudio, true);
      assert.ok(ids(await ctx.list('admin', { externalAudio: '1' })).includes(id('Ralf/2026/2026-03-04_audio-extern')));
    },
  },
  {
    id: 'A05', title: 'Video und PDF (öffentliche Autoren)',
    files: [article('Videos/2026/2026-03-05_video', { title: 'Ein Video', date: '2026-03-05', body: text(9, 1) }),
      { path: 'www/Videos/2026/2026-03-05_video.mp4', kind: 'copy', from: 'clip.mp4' },
      article('PDF/2026/2026-03-05_dokument', { title: 'Ein Dokument', date: '2026-03-05', body: text(10, 1) }),
      { path: 'www/PDF/2026/2026-03-05_dokument.pdf', kind: 'pdf' }],
    async check(ctx) {
      assert.match((await ctx.detail('guest', id('Videos/2026/2026-03-05_video'))).videoUrl, /2026-03-05_video\.mp4/);
      assert.match((await ctx.detail('guest', id('PDF/2026/2026-03-05_dokument'))).pdfUrl, /2026-03-05_dokument\.pdf/);
    },
  },
  {
    id: 'A06', title: 'Audioquickie-Nummer',
    files: [article('Stefan Hiene/2026/2026-03-06_Audioquickie_2961',
      { title: 'Audioquickie 2961', date: '2026-03-06', audioquickie: '2961', body: text(11, 2) })],
    async check(ctx) {
      assert.equal((await ctx.detail('admin', id('Stefan Hiene/2026/2026-03-06_Audioquickie_2961'))).episodeNum, 2961);
    },
  },
  {
    id: 'A07', title: 'Datumsformate: deutsch und nur aus dem Dateinamen',
    files: [article('Ralf/2026/2026-03-07_datum-deutsch', { title: 'Datum deutsch', date: '07.03.2026', body: text(13, 1) }),
      raw('www/Ralf/2026/2026-03-08_ohne-datum.md', `${text(14, 2)}\n`)],
    async check(ctx) {
      assert.equal((await ctx.detail('admin', id('Ralf/2026/2026-03-07_datum-deutsch'))).date, '2026-03-07');
      assert.equal((await ctx.detail('admin', id('Ralf/2026/2026-03-08_ohne-datum'))).date, '2026-03-08');
    },
  },
  {
    id: 'A08', title: 'Telegram ist ohne Schalter ausgeblendet',
    files: [article('Telegram/2026/2026-03-09_telegram', { title: 'Telegram-Beitrag', date: '2026-03-09', body: text(16, 2) })],
    async check(ctx) {
      const tg = id('Telegram/2026/2026-03-09_telegram');
      assert.ok(!ids(await ctx.list('admin')).includes(tg));
      assert.ok(ids(await ctx.list('admin', { telegram: '1' })).includes(tg));
      assert.ok(ids(await ctx.list('admin', { author: 'Telegram' })).includes(tg));
    },
  },

  // B. Infografiken
  {
    id: 'B09', title: 'Artikel mit Foto und zwei Platzhalter-Infografiken: eine Kachel, Kategorien vom Artikel',
    files: [article('Joe Turan/2026/2026-04-01_gruppe', { title: 'Beziehung und Partnerschaft', date: '2026-04-01', body: text(0, 5) }),
      image('Joe Turan/2026/2026-04-01_gruppe.jpg', 'B09 Foto'),
      placeholder('Infografiken/2026/2026-04-01_gruppe_1', 'Gruppe Grafik 1'), image('Infografiken/2026/2026-04-01_gruppe_1.png', 'B09 _1'),
      placeholder('Infografiken/2026/2026-04-01_gruppe_2', 'Gruppe Grafik 2'), image('Infografiken/2026/2026-04-01_gruppe_2.png', 'B09 _2')],
    async check(ctx) {
      const anchor = id('Joe Turan/2026/2026-04-01_gruppe');
      const tiles = await ctx.tiles('admin');
      const tile = tileOf(tiles, anchor);
      assert.deepEqual(tile.images.map(image => [image.id, image.kind]), [
        [anchor, 'photo'], ['Infografiken/2026/2026-04-01_gruppe_1', 'infographic'], ['Infografiken/2026/2026-04-01_gruppe_2', 'infographic']]);
      assert.ok(!tileOf(tiles, 'Infografiken/2026/2026-04-01_gruppe_1'), 'Mitglieder keine eigenen Kacheln');
      const member = await ctx.detail('admin', 'Infografiken/2026/2026-04-01_gruppe_2');
      assert.deepEqual([member.id, member.requestedId], [anchor, 'Infografiken/2026/2026-04-01_gruppe_2'], 'öffnet die Gruppe');
      const info = (await ctx.list('admin', { author: 'Infografiken' })).find(item => item.id === 'Infografiken/2026/2026-04-01_gruppe_1');
      const own = await ctx.detail('admin', anchor);
      assert.ok(own.categories.length > 0, 'Artikel hat Kategorien');
      assert.deepEqual(info.categories, own.categories, 'Mitglied erbt die Kategorien');
    },
  },
  {
    id: 'B10', title: 'Eigenständige Infografik mit eigenem Text',
    files: [article('Infografiken/2026/2026-04-02_eigenstaendig', { title: 'Eigenständige Grafik', date: '2026-04-02', body: text(18, 2) }),
      image('Infografiken/2026/2026-04-02_eigenstaendig.png', 'B10')],
    async check(ctx) {
      const tile = tileOf(await ctx.tiles('admin'), 'Infografiken/2026/2026-04-02_eigenstaendig');
      assert.ok(tile && !tile.images, 'eigene Kachel ohne Gruppe');
    },
  },
  {
    id: 'B11', title: 'Infografik mit eigenem Audio ist eigenständig, obwohl es den Artikel gibt',
    files: [article('Joe Turan/2026/2026-04-03_mit-audio-grafik', { title: 'Mit Audio-Grafik', date: '2026-04-03', body: text(5, 2) }),
      placeholder('Infografiken/2026/2026-04-03_mit-audio-grafik_1', 'Grafik mit Audio'),
      image('Infografiken/2026/2026-04-03_mit-audio-grafik_1.png', 'B11'),
      sound('www/Infografiken/2026/2026-04-03_mit-audio-grafik_1.mp3')],
    async check(ctx) {
      const detail = await ctx.detail('admin', 'Infografiken/2026/2026-04-03_mit-audio-grafik_1');
      assert.equal(detail.id, 'Infografiken/2026/2026-04-03_mit-audio-grafik_1');
      assert.equal(detail.requestedId, undefined);
      assert.ok(tileOf(await ctx.tiles('admin'), 'Infografiken/2026/2026-04-03_mit-audio-grafik_1'));
    },
  },
  {
    id: 'B12', title: 'Basis-Infografik mit Text und Varianten _1/_2 (ohne Artikel): Basis ist Anker',
    files: [article('Infografiken/2026/2026-04-04_basis', { title: 'Basis mit Text', date: '2026-04-04', body: text(22, 2) }),
      image('Infografiken/2026/2026-04-04_basis.png', 'B12 Basis'),
      placeholder('Infografiken/2026/2026-04-04_basis_1', 'Basis 1'), image('Infografiken/2026/2026-04-04_basis_1.png', 'B12 _1'),
      placeholder('Infografiken/2026/2026-04-04_basis_2', 'Basis 2'), image('Infografiken/2026/2026-04-04_basis_2.png', 'B12 _2')],
    async check(ctx) {
      const tile = tileOf(await ctx.tiles('admin'), 'Infografiken/2026/2026-04-04_basis');
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-04-04_basis', 'Infografiken/2026/2026-04-04_basis_1',
        'Infografiken/2026/2026-04-04_basis_2']);
    },
  },
  {
    id: 'B13', title: 'Basis-Infografik ohne Text und ohne Artikel, mit _1: Basis ist Anker',
    files: [placeholder('Infografiken/2026/2026-04-05_basis-leer', 'Basis leer'), image('Infografiken/2026/2026-04-05_basis-leer.png', 'B13 Basis'),
      placeholder('Infografiken/2026/2026-04-05_basis-leer_1', 'Basis leer 1'), image('Infografiken/2026/2026-04-05_basis-leer_1.png', 'B13 _1')],
    async check(ctx) {
      const tile = tileOf(await ctx.tiles('admin'), 'Infografiken/2026/2026-04-05_basis-leer');
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-04-05_basis-leer', 'Infografiken/2026/2026-04-05_basis-leer_1']);
    },
  },
  {
    id: 'B14', title: 'Endung _2961 ohne verkürzten Stamm gehört zum Namen (Audioquickie)',
    files: [placeholder('Infografiken/2026/2026-03-06_Audioquickie_2961', 'Audioquickie-Grafik'),
      image('Infografiken/2026/2026-03-06_Audioquickie_2961.png', 'B14')],
    async check(ctx) {
      const anchor = id('Stefan Hiene/2026/2026-03-06_Audioquickie_2961');
      const tile = tileOf(await ctx.tiles('admin'), anchor);
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-03-06_Audioquickie_2961'], 'ohne eigenes Foto nur die Grafik');
    },
  },
  {
    id: 'B15', title: 'Gleicher Stamm bei zwei Autoren: Priorität, sonst der einzige mit Audio',
    files: [article('Joe Turan/2026/2026-04-06_gleicher-stamm', { title: 'Gleicher Stamm (Blog)', date: '2026-04-06', body: text(7, 2) }),
      article('Ralf/2026/2026-04-06_gleicher-stamm', { title: 'Gleicher Stamm (Ralf)', date: '2026-04-06', body: text(9, 1) }),
      placeholder('Infografiken/2026/2026-04-06_gleicher-stamm_1', 'Gleicher Stamm 1'),
      image('Infografiken/2026/2026-04-06_gleicher-stamm_1.png', 'B15 Priorität'),
      article('Autor A/2026/2026-04-07_ohne-prioritaet', { title: 'Ohne Priorität A', date: '2026-04-07', body: text(27, 1) }),
      sound('www/Autor A/2026/2026-04-07_ohne-prioritaet.mp3'),
      article('Autor B/2026/2026-04-07_ohne-prioritaet', { title: 'Ohne Priorität B', date: '2026-04-07', body: text(28, 1) }),
      placeholder('Infografiken/2026/2026-04-07_ohne-prioritaet_1', 'Ohne Priorität 1'),
      image('Infografiken/2026/2026-04-07_ohne-prioritaet_1.png', 'B15 Audio')],
    async check(ctx) {
      const tiles = await ctx.tiles('admin');
      assert.deepEqual(ids(tileOf(tiles, 'Joe Turan/2026/2026-04-06_gleicher-stamm').images), ['Infografiken/2026/2026-04-06_gleicher-stamm_1']);
      assert.equal(tileOf(tiles, 'Ralf/2026/2026-04-06_gleicher-stamm').images, undefined);
      assert.deepEqual(ids(tileOf(tiles, 'Autor A/2026/2026-04-07_ohne-prioritaet').images), ['Infografiken/2026/2026-04-07_ohne-prioritaet_1']);
      assert.equal(tileOf(tiles, 'Autor B/2026/2026-04-07_ohne-prioritaet').images, undefined);
    },
  },
  {
    id: 'B16', title: 'Infografik ohne eigenes Audio erbt das Audio des Artikels',
    files: [article('Joe Turan/2026/2026-04-08_audio-gruppe', { title: 'Audio-Gruppe', date: '2026-04-08', body: text(14, 2) }),
      sound('www/Joe Turan/2026/2026-04-08_audio-gruppe.mp3'),
      placeholder('Infografiken/2026/2026-04-08_audio-gruppe_1', 'Audio-Gruppe 1'), image('Infografiken/2026/2026-04-08_audio-gruppe_1.png', 'B16')],
    async check(ctx) {
      const member = (await ctx.list('admin', { author: 'Infografiken' })).find(item => item.id === 'Infografiken/2026/2026-04-08_audio-gruppe_1');
      assert.match(member.audioUrl, /2026-04-08_audio-gruppe\.mp3/);
    },
  },
  {
    id: 'B17', title: 'Infografik im Papierkorb erscheint nie',
    files: [placeholder('Infografiken/trash/2026-04-09_geloescht', 'Gelöscht'), image('Infografiken/trash/2026-04-09_geloescht.png', 'B17')],
    async check(ctx) {
      const all = ids(await ctx.list('admin', { author: 'Infografiken' }));
      assert.ok(!all.some(item => item.includes('geloescht')));
    },
  },
  {
    id: 'B18', title: 'Gast: Infografik eines nicht sichtbaren Artikels ist eigene Kachel, geerbtes Audio verborgen',
    files: [],
    async check(ctx) {
      const tiles = await ctx.tiles('guest');
      for (const member of ['Infografiken/2026/2026-04-01_gruppe_1', 'Infografiken/2026/2026-04-01_gruppe_2']) {
        const tile = tileOf(tiles, member);
        assert.ok(tile && !tile.images, member);
      }
      const inherited = await ctx.detail('guest', 'Infografiken/2026/2026-04-08_audio-gruppe_1');
      assert.equal(inherited.audioUrl, null, 'kein Recht am Artikel, also kein Audio');
    },
  },

  // C. Instagram-Poster
  {
    id: 'C19', title: 'Poster und klassische Grafik in einer Artikelgruppe; Filter „Poster“ und „Klassisch“',
    files: [article('Joe Turan/2026/2026-04-10_poster-gruppe', { title: 'Poster-Gruppe', date: '2026-04-10', body: text(16, 2) }),
      placeholder('Infografiken/2026/2026-04-10_poster-gruppe_1', 'Klassisch'), image('Infografiken/2026/2026-04-10_poster-gruppe_1.png', 'C19 klassisch'),
      placeholder('Infografiken/2026/2026-04-10_poster-gruppe_2', 'Poster', { poster: true }),
      image('Infografiken/2026/2026-04-10_poster-gruppe_2.png', 'C19 Poster')],
    async check(ctx) {
      const poster = ids(await ctx.list('admin', { author: 'Infografiken', infographic: 'poster' }));
      const classic = ids(await ctx.list('admin', { author: 'Infografiken', infographic: 'classic' }));
      assert.ok(poster.includes('Infografiken/2026/2026-04-10_poster-gruppe_2') && !poster.includes('Infografiken/2026/2026-04-10_poster-gruppe_1'));
      assert.ok(classic.includes('Infografiken/2026/2026-04-10_poster-gruppe_1') && !classic.includes('Infografiken/2026/2026-04-10_poster-gruppe_2'));
      const tile = tileOf(await ctx.tiles('admin'), 'Joe Turan/2026/2026-04-10_poster-gruppe');
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-04-10_poster-gruppe_1', 'Infografiken/2026/2026-04-10_poster-gruppe_2']);
    },
  },
  {
    id: 'C20', title: 'Eigenständiges Poster mit eigenem Text',
    files: [article('Infografiken/2026/2026-04-11_poster-allein', { title: 'Poster allein', date: '2026-04-11', poster: true, body: text(33, 2) }),
      image('Infografiken/2026/2026-04-11_poster-allein.png', 'C20')],
    async check(ctx) {
      assert.ok(ids(await ctx.list('admin', { author: 'Infografiken', infographic: 'poster' })).includes('Infografiken/2026/2026-04-11_poster-allein'));
      assert.ok(tileOf(await ctx.tiles('admin'), 'Infografiken/2026/2026-04-11_poster-allein'));
    },
  },

  // D. Dubletten (Blog „Joe Turan“, Quellen „Facebook“ und „Coaching“)
  {
    id: 'D22', title: 'Offener Treffer, Wortlaut gleich',
    files: [article('Joe Turan/2026/2026-05-01_dublette-gleich', { title: 'Achtsam im Alltag', date: '2026-05-01', body: some(35, 36, 37, 56) }),
      article('Facebook/2026/2026-04-28_dublette-gleich-fb', { title: 'Achtsam im Alltag', date: '2026-04-28', body: some(35, 36, 37, 56) })],
    async check(ctx) {
      const pair = ctx.pending.find(item => item.blog.id === 'Joe Turan/2026/2026-05-01_dublette-gleich');
      assert.equal(pair?.facebook.id, 'Facebook/2026/2026-04-28_dublette-gleich-fb');
      assert.equal(pair.exact, true);
    },
  },
  {
    id: 'D23', title: 'Offener Treffer, nur überlappend (Coaching)',
    files: [article('Joe Turan/2026/2026-05-02_dublette-teil', { title: 'Ordnung und Zuhause', date: '2026-05-02', body: some(48, 49, 50, 51) }),
      article('Coaching/2026/2026-04-25_dublette-teil-coaching',
        { title: 'Ordnung und Zuhause im Coaching', date: '2026-04-25', body: some(48, 49, 50, 57, 58) })],
    async check(ctx) {
      const pair = ctx.pending.find(item => item.blog.id === 'Joe Turan/2026/2026-05-02_dublette-teil');
      assert.equal(pair?.facebook.id, 'Coaching/2026/2026-04-25_dublette-teil-coaching');
      assert.equal(pair.exact, false);
    },
  },
  {
    id: 'D24', title: 'Kein Treffer: zu kurz bzw. überlappend und über 730 Tage auseinander; wortgleich zählt trotz Abstand',
    files: [article('Joe Turan/2026/2026-05-03_kurz', { title: 'Kurz', date: '2026-05-03', body: text(40, 1) }),
      article('Facebook/2026/2026-05-03_kurz-fb', { title: 'Kurz', date: '2026-05-03', body: text(40, 1) }),
      article('Joe Turan/2026/2026-05-04_weit', { title: 'Radfahren in der Stadt', date: '2026-05-04', body: some(41, 42, 43, 59) }),
      article('Facebook/2023/2023-01-10_weit-fb', { title: 'Radfahren in der Stadt', date: '2023-01-10', body: some(41, 42, 43, 60) }),
      article('Joe Turan/2026/2026-05-11_weit-gleich', { title: 'Gartenjahr', date: '2026-05-11', body: some(44, 45, 46, 61) }),
      article('Facebook/2022/2022-02-01_weit-gleich-fb', { title: 'Gartenjahr', date: '2022-02-01', body: some(44, 45, 46, 61) })],
    async check(ctx) {
      const blogs = ctx.pending.map(item => item.blog.id);
      assert.ok(!blogs.includes('Joe Turan/2026/2026-05-03_kurz'), 'unter 35 Wörtern');
      assert.ok(!blogs.includes('Joe Turan/2026/2026-05-04_weit'), 'überlappend und zu weit auseinander');
      assert.ok(blogs.includes('Joe Turan/2026/2026-05-11_weit-gleich'), 'wortgleich zählt auch über 730 Tage');
    },
  },
  {
    id: 'D25', title: 'Verknüpftes Paar: Quellbeitrag überall durch den Blogartikel ersetzt',
    files: [article('Joe Turan/2026/2026-05-05_verknuepft', { title: 'Wandern in den Bergen', date: '2026-05-05', body: some(23, 24, 25, 62) }),
      article('Facebook/2026/2026-05-01_verknuepft-fb', { title: 'Wandern in den Bergen', date: '2026-05-01', body: some(23, 24, 25, 62) })],
    async setup(ctx) {
      await ctx.duplicateAction({ action: 'link', blogId: 'Joe Turan/2026/2026-05-05_verknuepft', facebookId: 'Facebook/2026/2026-05-01_verknuepft-fb' });
    },
    async check(ctx) {
      assert.ok(!ids(await ctx.list('admin')).includes('Facebook/2026/2026-05-01_verknuepft-fb'));
      const opened = await ctx.detail('admin', 'Facebook/2026/2026-05-01_verknuepft-fb');
      assert.deepEqual([opened.id, opened.requestedId], ['Joe Turan/2026/2026-05-05_verknuepft', 'Facebook/2026/2026-05-01_verknuepft-fb']);
      assert.ok(ctx.duplicates.linked.some(item => item.facebookId === 'Facebook/2026/2026-05-01_verknuepft-fb'));
    },
  },
  {
    id: 'D26', title: 'Ignoriertes Paar: beide sichtbar, kein offener Treffer',
    files: [article('Joe Turan/2026/2026-05-06_ignoriert', { title: 'Kinder lernen', date: '2026-05-06', body: some(27, 28, 29, 63) }),
      article('Facebook/2026/2026-05-02_ignoriert-fb', { title: 'Kinder lernen', date: '2026-05-02', body: some(27, 28, 29, 63) })],
    async setup(ctx) {
      await ctx.duplicateAction({ action: 'ignore', blogId: 'Joe Turan/2026/2026-05-06_ignoriert', facebookId: 'Facebook/2026/2026-05-02_ignoriert-fb' });
    },
    async check(ctx) {
      assert.ok(!ctx.pending.some(item => item.blog.id === 'Joe Turan/2026/2026-05-06_ignoriert'));
      assert.ok(ctx.duplicates.ignored.some(item => item.facebookId === 'Facebook/2026/2026-05-02_ignoriert-fb'));
      const all = ids(await ctx.list('admin'));
      assert.ok(all.includes('Joe Turan/2026/2026-05-06_ignoriert') && all.includes('Facebook/2026/2026-05-02_ignoriert-fb'));
    },
  },
  {
    id: 'D27', title: 'Ignoriert, dann Text geändert: wieder offener Treffer',
    files: [article('Joe Turan/2026/2026-05-07_geaendert', { title: 'Musik verbindet', date: '2026-05-07', body: some(31, 32, 33, 64) }),
      article('Facebook/2026/2026-05-03_geaendert-fb', { title: 'Musik verbindet', date: '2026-05-03', body: some(31, 32, 33, 64) })],
    async setup(ctx) {
      await ctx.duplicateAction({ action: 'ignore', blogId: 'Joe Turan/2026/2026-05-07_geaendert', facebookId: 'Facebook/2026/2026-05-03_geaendert-fb' });
    },
    edit: { file: 'www/Facebook/2026/2026-05-03_geaendert-fb.md', append: `\n${SENTENCES[34]}\n` },
    async check(ctx) {
      assert.ok(ctx.pending.some(item => item.blog.id === 'Joe Turan/2026/2026-05-07_geaendert'
        && item.facebook.id === 'Facebook/2026/2026-05-03_geaendert-fb'));
    },
  },
  {
    id: 'D28', title: 'Quellbeitrag mit Infografik und Poster: Verknüpfen mit Umzug zum Blog-Namen',
    files: [article('Joe Turan/2026/2026-05-08_umzug', { title: 'Freundschaft pflegen', date: '2026-05-08', body: some(19, 20, 21, 65) }),
      article('Facebook/2026/2026-05-05_umzug-fb', { title: 'Freundschaft pflegen', date: '2026-05-05', body: some(19, 20, 21, 65) }),
      placeholder('Infografiken/2026/2026-05-05_umzug-fb_1', 'Umzug klassisch'), image('Infografiken/2026/2026-05-05_umzug-fb_1.png', 'D28 _1'),
      placeholder('Infografiken/2026/2026-05-05_umzug-fb_2', 'Umzug Poster', { poster: true }), image('Infografiken/2026/2026-05-05_umzug-fb_2.png', 'D28 Poster')],
    async setup(ctx) {
      ctx.migrations.D28 = await ctx.duplicateAction({ action: 'link', migrateImages: true,
        blogId: 'Joe Turan/2026/2026-05-08_umzug', facebookId: 'Facebook/2026/2026-05-05_umzug-fb' });
    },
    async check(ctx) {
      // Je Grafik ziehen Bild und .md um (eine Migration je Datei).
      assert.deepEqual(ctx.migrations.D28.migrations.map(item => item.to).sort(), [
        'Infografiken/2026/2026-05-08_umzug_1.md', 'Infografiken/2026/2026-05-08_umzug_1.png',
        'Infografiken/2026/2026-05-08_umzug_2.md', 'Infografiken/2026/2026-05-08_umzug_2.png']);
      const tile = tileOf(await ctx.tiles('admin'), 'Joe Turan/2026/2026-05-08_umzug');
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-05-08_umzug_1', 'Infografiken/2026/2026-05-08_umzug_2']);
      assert.ok(ids(await ctx.list('admin', { author: 'Infografiken', infographic: 'poster' })).includes('Infografiken/2026/2026-05-08_umzug_2'),
        'Poster-Markierung zieht mit um');
    },
  },
  {
    id: 'D29', title: 'Blog und Quelle haben Infografiken: Umzug nummeriert hinter den Blog-Grafiken weiter',
    files: [article('Joe Turan/2026/2026-05-09_beide', { title: 'Brot backen', date: '2026-05-09', body: some(11, 12, 13, 66) }),
      placeholder('Infografiken/2026/2026-05-09_beide_1', 'Beide Blog'), image('Infografiken/2026/2026-05-09_beide_1.png', 'D29 Blog'),
      article('Facebook/2026/2026-05-06_beide-fb', { title: 'Brot backen', date: '2026-05-06', body: some(11, 12, 13, 66) }),
      placeholder('Infografiken/2026/2026-05-06_beide-fb_1', 'Beide Quelle'), image('Infografiken/2026/2026-05-06_beide-fb_1.png', 'D29 Quelle')],
    async setup(ctx) {
      await ctx.duplicateAction({ action: 'link', migrateImages: true, blogId: 'Joe Turan/2026/2026-05-09_beide', facebookId: 'Facebook/2026/2026-05-06_beide-fb' });
    },
    async check(ctx) {
      const tile = tileOf(await ctx.tiles('admin'), 'Joe Turan/2026/2026-05-09_beide');
      assert.deepEqual(ids(tile.images), ['Infografiken/2026/2026-05-09_beide_1', 'Infografiken/2026/2026-05-09_beide_2']);
    },
  },
  {
    id: 'D30', title: '„Joe Turan Facebook“ und Telegram werden nie verglichen',
    files: [article('Joe Turan/2026/2026-05-10_ausgeschlossen', { title: 'Nachbarschaft', date: '2026-05-10', body: some(38, 47, 55, 67) }),
      article('Joe Turan Facebook/2026/2026-05-10_ausgeschlossen-jtf', { title: 'Nachbarschaft', date: '2026-05-10', body: some(38, 47, 55, 67) }),
      article('Telegram/2026/2026-05-10_ausgeschlossen-tg', { title: 'Nachbarschaft', date: '2026-05-10', body: some(38, 47, 55, 67) })],
    async check(ctx) {
      assert.ok(!ctx.pending.some(item => item.blog.id === 'Joe Turan/2026/2026-05-10_ausgeschlossen'));
    },
  },

  // E. Zugriff
  {
    id: 'E31', title: 'Gast sieht nur öffentliche Autoren',
    files: [],
    async check(ctx) {
      const authors = new Set((await ctx.list('guest')).map(item => item.author));
      assert.deepEqual([...authors].filter(author => !PUBLIC_AUTHORS.includes(author)), []);
      assert.equal((await ctx.as('guest').get(`/api/articles/${encodeURI('Ralf/2026/2026-03-01_eigenes-bild')}`)).status, 403);
    },
  },
  {
    id: 'E32', title: 'Nutzer mit Whitelist: eigener Autor plus öffentliche, sonst kein Zugriff',
    files: [],
    async check(ctx) {
      const authors = new Set((await ctx.list('reader')).map(item => item.author));
      assert.deepEqual([...authors].filter(author => ![...PUBLIC_AUTHORS, 'Stefan Hiene'].includes(author)), []);
      assert.ok(authors.has('Stefan Hiene'));
      assert.equal((await ctx.as('reader').get(`/api/articles/${encodeURI('Joe Turan/2026/2026-04-01_gruppe')}`)).status, 403);
    },
  },
  {
    id: 'E33', title: 'Admin sieht alle Autoren (ohne Telegram-Schalter ohne Telegram)',
    files: [],
    async check(ctx) {
      const authors = new Set((await ctx.list('admin')).map(item => item.author));
      for (const author of ['Joe Turan', 'Facebook', 'Coaching', 'Ralf', 'Stefan Hiene', 'Infografiken', 'PDF', 'Videos', 'Autor A', 'Autor B']) {
        assert.ok(authors.has(author), author);
      }
      assert.ok(!authors.has('Telegram'));
    },
  },
  {
    id: 'E34', title: 'Nutzer mit Pflicht-Kennwortänderung kommt nicht an die Artikel',
    files: [],
    async check(ctx) {
      const res = await ctx.as('fresh').get('/api/articles');
      assert.equal(res.status, 403);
      assert.equal(res.data.code, 'password_change_required');
    },
  },

  // F. Hörbücher (audio/Hoerbuecher/<Buch>/)
  {
    id: 'F35', title: 'Hörbuch mit Cover, Abstract und zwei Tracks',
    files: [sound('audio/Hoerbuecher/Testbuch Normal/01 Anfang.mp3'), sound('audio/Hoerbuecher/Testbuch Normal/02 Ende.mp3'),
      { path: 'audio/Hoerbuecher/Testbuch Normal/cover.jpg', kind: 'image', label: 'F35' },
      raw('audio/Hoerbuecher/Testbuch Normal/abstract.md', `${text(36, 2)}\n`)],
    async check(ctx) {
      const book = (await ctx.books('member')).find(item => item.title === 'Testbuch Normal');
      assert.equal(book?.trackCount, 2);
      assert.equal((await ctx.as('guest').get('/api/audiobooks')).ok, false, 'Hörbücher sind nie öffentlich');
    },
  },
  {
    id: 'F36', title: 'Nur-eBook ohne Tracks',
    files: [raw('audio/Hoerbuecher/Nur Text/Nur Text.md', `# Nur Text\n\n${text(37, 2)}\n`)],
    async check(ctx) {
      const book = (await ctx.books('member')).find(item => item.title === 'Nur Text');
      assert.deepEqual([book?.trackCount, book?.ebookOnly], [0, true]);
    },
  },
  {
    id: 'F37', title: 'Privates Hörbuch: nur Admins, und nur in der Sortierung „privat“',
    files: [sound('audio/Hoerbuecher/Privatbuch/01.mp3')],
    async setup(ctx) {
      const book = (await ctx.books('admin')).find(item => item.title === 'Privatbuch');
      const res = await ctx.as('admin').put(`/api/audiobook-private/${encodeURI(book.id)}`, { private: true });
      assert.equal(res.status, 200, JSON.stringify(res.data));
    },
    async check(ctx) {
      const titles = async (role, query) => (await ctx.books(role, query)).map(item => item.title);
      assert.ok(!(await titles('member')).includes('Privatbuch'));
      assert.ok(!(await titles('member', { sort: 'private' })).includes('Privatbuch'));
      assert.ok(!(await titles('admin')).includes('Privatbuch'));
      assert.ok((await titles('admin', { sort: 'private' })).includes('Privatbuch'));
    },
  },
  {
    id: 'F38', title: 'Hörbuch mit Extras',
    files: [sound('audio/Hoerbuecher/Mit Extras/01.mp3'), raw('audio/Hoerbuecher/Mit Extras/extras/Kapitel 1.md', `# Kapitel 1\n\n${text(38, 1)}\n`),
      // Bild-Extra: öffnet die Bildvollansicht (Zoomen per Pinch/Doppeltippen im Handy-Browsertest).
      { path: 'audio/Hoerbuecher/Mit Extras/extras/Karte.png', kind: 'image', label: 'F38 Karte' }],
    async check(ctx) {
      const book = (await ctx.books('member')).find(item => item.title === 'Mit Extras');
      const res = await ctx.as('member').get(`/api/audiobooks/${encodeURI(book.id)}`);
      assert.equal(res.data.hasExtras, true);
      const extras = await ctx.as('member').get(`/api/audiobook-extras/${book.id.split('/').map(encodeURIComponent).join('/')}`);
      assert.deepEqual(extras.data.extras.map(extra => extra.type).sort(), ['image', 'markdown']);
    },
  },

  // G. Badge: Eine Infografik zeigt den Autor ihres Hauptartikels (displayAuthor, Kachel und Poster-Kachel), aber nur,
  // wenn der Nutzer den Hauptartikel sehen darf; sonst „Infografiken“. Die Artikelansicht öffnet ohnehin den Anker.
  {
    id: 'G39', title: 'Badge der Infografiken: Autor des Hauptartikels, sonst „Infografiken“',
    files: [],
    async check(ctx) {
      const badges = async (role, params = {}) => new Map((await ctx.list(role, { author: 'Infografiken', ...params }))
        .map(item => [item.id, item.displayAuthor]));
      const admin = await badges('admin');
      const expected = {
        'Infografiken/2026/2026-04-01_gruppe_1': 'Joe Turan', // B09 Platzhalter
        'Infografiken/2026/2026-04-01_gruppe_2': 'Joe Turan',
        'Infografiken/2026/2026-04-02_eigenstaendig': 'Infografiken', // B10 eigenständig
        'Infografiken/2026/2026-04-03_mit-audio-grafik_1': 'Infografiken', // B11 eigenes Audio, nicht gruppiert
        'Infografiken/2026/2026-04-04_basis_1': 'Infografiken', // B12 Anker ist die Basis-Infografik
        'Infografiken/2026/2026-04-05_basis-leer_1': 'Infografiken', // B13
        'Infografiken/2026/2026-03-06_Audioquickie_2961': 'Stefan Hiene', // B14
        'Infografiken/2026/2026-04-06_gleicher-stamm_1': 'Joe Turan', // B15 Priorität
        'Infografiken/2026/2026-04-07_ohne-prioritaet_1': 'Autor A', // B15 einziger mit Audio
        'Infografiken/2026/2026-04-08_audio-gruppe_1': 'Joe Turan', // B16
        'Infografiken/2026/2026-04-10_poster-gruppe_1': 'Joe Turan', // C19
        'Infografiken/2026/2026-04-11_poster-allein': 'Infografiken', // C20
        'Infografiken/2026/2026-05-08_umzug_2': 'Joe Turan', // D28 nach dem Umzug zum Blogartikel
        'Infografiken/2026/2026-05-09_beide_2': 'Joe Turan', // D29
      };
      assert.deepEqual(Object.fromEntries(Object.keys(expected).map(id => [id, admin.get(id)])), expected);
      // Poster-Kachel („Instagram-Poster von …“) nutzt denselben Wert.
      assert.equal((await badges('admin', { infographic: 'poster' })).get('Infografiken/2026/2026-04-10_poster-gruppe_2'), 'Joe Turan');
      // Ohne Recht am Hauptartikel: „Infografiken“ (Gast und Whitelist-Nutzer sehen Joe Turan nicht).
      for (const role of ['guest', 'reader']) {
        assert.equal((await badges(role)).get('Infografiken/2026/2026-04-01_gruppe_1'), 'Infografiken', role);
      }
      assert.equal((await badges('reader')).get('Infografiken/2026/2026-03-06_Audioquickie_2961'), 'Stefan Hiene', 'Whitelist-Autor');
      // Auch als eigene Kachel in der Gruppenansicht (Gast): Badge „Infografiken“.
      assert.equal(tileOf(await ctx.tiles('guest'), 'Infografiken/2026/2026-04-01_gruppe_1').displayAuthor, 'Infografiken');
    },
  },
  {
    id: 'G40', title: 'Infografik eines Telegram-Artikels: einzeln, solange Telegram ausgeblendet ist, aber mit Badge „Telegram“',
    files: [article('Telegram/2026/2026-03-10_telegram-grafik', { title: 'Telegram mit Grafik', date: '2026-03-10', body: text(52, 2) }),
      placeholder('Infografiken/2026/2026-03-10_telegram-grafik_1', 'Telegram-Grafik'),
      image('Infografiken/2026/2026-03-10_telegram-grafik_1.png', 'G40')],
    async check(ctx) {
      const member = 'Infografiken/2026/2026-03-10_telegram-grafik_1';
      const anchor = id('Telegram/2026/2026-03-10_telegram-grafik');
      const hidden = tileOf(await ctx.tiles('admin'), member);
      assert.ok(hidden && !hidden.images, 'ohne Telegram-Schalter eigene Kachel');
      assert.equal(hidden.displayAuthor, 'Telegram', 'Badge trotzdem vom Hauptartikel');
      const shown = await ctx.tiles('admin', { telegram: '1' });
      assert.deepEqual(ids(tileOf(shown, anchor).images), [member], 'mit Telegram-Schalter eine Gruppe');
      assert.ok(!tileOf(shown, member));
      assert.equal((await ctx.detail('admin', member)).id, anchor, 'öffnet den Telegram-Artikel');
      // Telegram ist nicht öffentlich: Der Gast sieht die Grafik einzeln mit „Infografiken“.
      assert.equal(tileOf(await ctx.tiles('guest'), member).displayAuthor, 'Infografiken');
    },
  },

  // H. Scraper-Zentrale (Daten unter SCRAPER_DIR: writeScraperData unten)
  {
    id: 'H41', title: 'Übersicht: Quellen in Ablaufreihenfolge, letzter Lauf, neue Artikel verlinkt, Cron und Anmeldung',
    files: [],
    async check(ctx) {
      const { data } = await ctx.as('admin').get('/api/scraper/sources');
      assert.deepEqual(data.sources.map(source => `${source.type}:${source.name}:${source.active}`), [
        'blog:Joe Turan:true', 'facebook:Facebook:true', 'facebook:Gruppe Pausiert:false', 'telegram:Telegram:true', 'telegram:Kanal Neu:true']);
      const blog = data.sources[0];
      assert.deepEqual([blog.last.trigger, blog.last.saved, blog.last.skipped, blog.newLast30Days], ['cron', 1, 3, 1]);
      assert.deepEqual(blog.last.newArticles, [
        { id: 'Joe Turan/2026/2026-05-11_weit-gleich', title: 'Gartenjahr', exists: true },
        { id: 'Joe Turan/2026/2026-12-31_nicht-mehr-da', title: null, exists: false },
      ]);
      assert.equal(data.cron.level, 'ok');
      assert.equal(data.cookies.exists, true);
      assert.ok(data.cookies.sessionExpiresAt > Date.now(), 'Ablaufdatum der Test-Cookies');
      assert.ok(!JSON.stringify(data).includes('TESTWERT'), 'nie Cookie-Werte');
      assert.equal(data.usesExample, false);
    },
  },
  {
    id: 'H42', title: 'Notwendige Aktionen: abgebrochen, Anmeldung läuft bald ab, pausiert, lange nichts Neues, noch nie gelaufen',
    files: [],
    async check(ctx) {
      const { data } = await ctx.as('admin').get('/api/scraper/sources');
      const codes = Object.fromEntries(data.sources.map(source => [source.name, `${source.level}:${source.actions.map(action => action.code).join(',')}`]));
      assert.deepEqual(codes, {
        'Joe Turan': 'ok:',
        Facebook: 'error:failed,cookies-expiring,no-posts',
        'Gruppe Pausiert': 'info:paused',
        Telegram: 'info:stale',
        'Kanal Neu': 'info:never-run',
      });
      assert.equal(data.level, 'error');
    },
  },
  {
    id: 'H43', title: 'Quellen verwalten: Prüfung, hinzufügen, bearbeiten, pausieren, entfernen',
    files: [],
    async check(ctx) {
      const admin = ctx.as('admin');
      const bad = await admin.post('/api/scraper/sources', { type: 'facebook', name: 'Infografiken', url: 'https://facebook.com/x' });
      assert.equal(bad.status, 400, 'reservierter Name');
      const wrongUrl = await admin.post('/api/scraper/sources', { type: 'telegram', name: 'H43 Kanal', url: 'https://t.me/h43' });
      assert.equal(wrongUrl.status, 400);
      assert.equal((await admin.post('/api/scraper/sources', { type: 'telegram', name: 'H43 Kanal', url: 'https://t.me/s/h43' })).status, 200);
      assert.equal((await admin.put(`/api/scraper/sources/${encodeURIComponent('H43 Kanal')}`, { url: 'https://t.me/s/h43neu' })).status, 200);
      assert.equal((await admin.put(`/api/scraper/sources/${encodeURIComponent('H43 Kanal')}/active`, { active: false })).status, 200);
      let source = (await admin.get('/api/scraper/sources')).data.sources.find(item => item.name === 'H43 Kanal');
      assert.deepEqual([source.url, source.active, source.actions.map(action => action.code)], ['https://t.me/s/h43neu', false, ['paused']]);
      assert.equal((await admin.del(`/api/scraper/sources/${encodeURIComponent('H43 Kanal')}`)).status, 200);
      source = (await admin.get('/api/scraper/sources')).data.sources.find(item => item.name === 'H43 Kanal');
      assert.equal(source, undefined);
      assert.equal((await admin.post('/api/scraper/run', { source: 'Gibt es nicht' })).status, 404);
    },
  },
  {
    id: 'H44', title: 'Scraper-Zentrale nur für Admins',
    files: [],
    async check(ctx) {
      // Gäste sind dank öffentlicher Autoren gültige Besucher: 403 „Nur für Administratoren“, nicht 401.
      const guest = await ctx.as('guest').get('/api/scraper/sources');
      assert.deepEqual([guest.status, guest.data.code], [403, 'admin_required']);
      assert.equal((await ctx.as('member').get('/api/scraper/sources')).status, 403);
      assert.equal((await ctx.as('member').post('/api/scraper/sources', { type: 'telegram', name: 'X', url: 'https://t.me/s/x' })).status, 403);
    },
  },
  {
    id: 'H45', title: 'Health-Check: Facebook-Anmeldung läuft bald ab → Warnung bei „Scrape“',
    files: [],
    async check(ctx) {
      const { data } = await ctx.as('admin').get('/api/health/details');
      assert.deepEqual([data.services.scrape.login.needed, data.services.scrape.login.level], [true, 'warning']);
      assert.match(data.services.scrape.login.text, /läuft am \d{2}\.\d{2}\.\d{4} ab/);
      assert.equal(data.services.scrape.level, 'warning');
    },
  },
];

// ── Aufbau ───────────────────────────────────────────────────────────────────
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

async function renderImage(label, extension) {
  const hue = [...label].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
    <rect width="100%" height="100%" fill="hsl(${hue}, 45%, 42%)"/>
    <text x="50%" y="55%" font-family="sans-serif" font-size="${Math.min(44, Math.floor(760 / label.length))}" fill="#fff"
      text-anchor="middle">${label}</text></svg>`;
  const image = sharp(Buffer.from(svg));
  return extension === '.png' ? image.png().toBuffer() : image.jpeg({ quality: 70 }).toBuffer();
}

// Scraper-Zentrale (Fälle H): Quellen, Läufe, Test-Cookies (Werte sind Platzhalter) und Cron-Log, Zeiten relativ zu jetzt.
const SCRAPER_SOURCES = {
  Blog: [{ Name: 'Joe Turan', URL: 'https://www.joeturan.com/blog', OutputPath: '../www/Joe Turan' }],
  Facebook: [
    { Name: 'Facebook', URL: 'https://www.facebook.com/beispielseite/', OutputPath: '../www/Facebook', FileAuthor: 'Joe Turan' },
    { Name: 'Gruppe Pausiert', URL: 'https://www.facebook.com/groups/12345/', OutputPath: '../www/Gruppe Pausiert', Aktiv: false },
  ],
  Telegram: [
    { Name: 'Telegram', URL: 'https://t.me/s/joeturan', OutputPath: '../www/Telegram' },
    { Name: 'Kanal Neu', URL: 'https://t.me/s/kanalneu', OutputPath: '../www/Kanal Neu' },
  ],
};
const COOKIE_DAYS_LEFT = 3;

async function writeScraperData(write) {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const entry = (type, name, at, fields) => ({
    type, name, status: 'ok', startedAt: iso(at - 10000), finishedAt: iso(at), durationMs: 10000,
    saved: 0, skipped: 3, error: null, warnings: {}, newFiles: [], ...fields,
  });
  const recent = now - 3600 * 1000;
  const older = now - 20 * 24 * 3600 * 1000;
  const runs = [
    { id: iso(recent - 60000), trigger: 'cron', startedAt: iso(recent - 60000), finishedAt: iso(recent), exitCode: 1, phases: ['blog', 'facebook', 'telegram'],
      sources: [
        entry('blog', 'Joe Turan', recent - 40000, { saved: 1, newFiles: ['Joe Turan/2026/2026-05-11_weit-gleich.md', 'Joe Turan/2026/2026-12-31_nicht-mehr-da.md'] }),
        entry('facebook', 'Facebook', recent - 20000, { status: 'failed', saved: 0, skipped: 0, error: 'page.goto: Timeout 30000ms exceeded', warnings: { 'no-posts': 1 } }),
        { type: 'facebook', name: 'Gruppe Pausiert', status: 'paused' },
        entry('telegram', 'Telegram', recent, { warnings: { 'dom-fallback': 1 } }),
      ] },
    { id: iso(older), trigger: 'web', startedAt: iso(older), finishedAt: iso(older + 60000), exitCode: 0, phases: ['telegram'],
      sources: [entry('telegram', 'Telegram', older + 60000, { saved: 2 })] },
  ];
  const expiry = Math.floor((now + COOKIE_DAYS_LEFT * 24 * 3600 * 1000) / 1000);
  const cookie = name => ['.facebook.com', 'TRUE', '/', 'TRUE', expiry, name, 'TESTWERT'].join('\t');
  const pad = n => String(n).padStart(2, '0');
  const cron = new Date(recent);
  const cronLine = `${cron.getFullYear()}-${pad(cron.getMonth() + 1)}-${pad(cron.getDate())} ${pad(cron.getHours())}:${pad(cron.getMinutes())}:${pad(cron.getSeconds())} Scraper exit 0`;
  await write('scraper/scraper-config.json', JSON.stringify(SCRAPER_SOURCES, null, 2));
  await write('scraper/scrape-status.json', JSON.stringify({ version: 1, runs }, null, 2));
  await write('scraper/cookies.txt', ['# Netscape HTTP Cookie File', cookie('c_user'), cookie('xs')].join('\n') + '\n');
  await write('scraper/cron-scrape.log', `${cronLine}\n`);
}

// Legt das Archiv samt Nutzern, öffentlichen Autoren und Einstellungen unter dir an.
// Gibt Pfade und die (pro Lauf neuen) Kennwörter zurück.
async function build(dir) {
  const write = async (relative, data) => {
    const file = path.join(dir, relative);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, data);
  };
  for (const author of AUTHORS) await write(`www/${author}/standard.jpg`, await renderImage(`${author} (Standard)`, '.jpg'));
  for (const testCase of CASES) {
    for (const file of testCase.files) {
      if (file.kind === 'text') await write(file.path, file.content);
      else if (file.kind === 'image') await write(file.path, await renderImage(file.label, path.extname(file.path).toLowerCase()));
      else if (file.kind === 'copy') await write(file.path, await fs.promises.readFile(path.join(MEDIA, file.from)));
      else if (file.kind === 'pdf') await write(file.path, PDF);
    }
  }
  const passwords = {};
  const users = Object.entries(USERS).map(([role, user]) => {
    passwords[role] = crypto.randomBytes(12).toString('base64url');
    return { ...user, mustChangePassword: !!user.mustChangePassword, passwordHash: bcrypt.hashSync(passwords[role], 4) };
  });
  await write('users.json', JSON.stringify({ users }, null, 2));
  await write('public-directories.txt', JSON.stringify({ 'public-directories': PUBLIC_AUTHORS }, null, 2));
  await write('config.json', JSON.stringify(CONFIG, null, 2));
  await writeScraperData(write);
  return {
    passwords,
    env: {
      WWW_DIR: path.join(dir, 'www'),
      AUDIO_DIR: path.join(dir, 'audio'),
      CONFIG_FILE: path.join(dir, 'config.json'),
      USERS_FILE: path.join(dir, 'users.json'),
      PUBLIC_DIRS_FILE: path.join(dir, 'public-directories.txt'),
      SESSIONS_FILE: path.join(dir, 'sessions.json'),
      INDEX_CACHE_FILE: path.join(dir, 'index-cache.json'),
      HEALTH_EVENTS_FILE: path.join(dir, 'health-events.json'),
      BOOKMARKS_FILE: path.join(dir, 'bookmarks.json'),
      DUPLICATES_FILE: path.join(dir, 'duplicate-decisions.json'),
      AUDIOBOOK_PROGRESS_FILE: path.join(dir, 'audiobook-progress.json'),
      AUDIOBOOK_PRIVATE_FILE: path.join(dir, 'audiobook-private.json'),
      TTS_SETTINGS_FILE: path.join(dir, 'tts-settings.json'),
      TTS_VOICE_PREVIEW_DIR: path.join(dir, 'tts-voice-previews'),
      SCRAPER_DIR: path.join(dir, 'scraper'),
    },
  };
}

module.exports = { CASES, USERS, PUBLIC_AUTHORS, CONFIG, SENTENCES, build };
