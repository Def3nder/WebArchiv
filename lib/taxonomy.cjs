'use strict';

// Automatische Filter-Kategorien. Jede Kategorie hat gewichtete Suchwörter;
// verglichen wird mit ganzen Wörtern des kleingeschriebenen Textes:
//   'stamm'  – Wörter, die so beginnen (liebe → nicht „lieber“: dafür '=liebe')
//   '=wort'  – nur genau dieses Wort (ehe, ego, sucht …)
//   '*stamm' – auch innerhalb zusammengesetzter Wörter (Kindheitstrauma)
//   'a b'    – Wortfolge
// Gewicht 3 = eindeutiges Themenwort, 0.5 = schwaches Indiz. Allgemeine Wörter
// (wissen, Wahrheit, Energie …) und Wörter mit zweiter Bedeutung („würde“,
// „versucht“, „Nervensystem“ für Gesellschaft) sind bewusst nicht enthalten.

const TAXONOMY = [
  { label: 'Sexualität', keys: {
    3: ['*sexualit', 'orgasm', 'tantr', 'libido', 'erotik', 'erotisch', 'cunnilingus', 'oralsex', 'analsex', 'masturb',
      'selbstbefriedigung', 'penetration', 'klitoris', 'vagina', 'vulva', 'penis', 'erektion', 'ejakulation', 'squirting',
      'yoni', 'lingam', 'gleitmittel', 'gleitgel', 'vorspiel', 'geschlechtsverkehr', 'sexleben', '*sexsucht', 'porno',
      'maithuna'],
    2: ['=sex', '=sexy', 'sexuell', 'erregung', 'erregt', 'stöhnen', 'g-punkt'],
    1: ['=lust', 'lustvoll', 'lustlos', 'begehren', 'sinnlich', 'beckenboden', '=eros', 'intimacy'],
    0.5: ['verlangen', 'leidenschaft', 'küssen', 'küsst', '=kuss', 'intimität', 'polarität', 'berührung'],
  } },
  { label: 'Beziehungen', keys: {
    3: ['paartherapie', '=ehe', '=ehen', 'ehefrau', 'ehemann', 'ehepartner', 'scheidung', 'heirat',
      '=dating', 'datest', 'verlieb', 'liebeskummer', '*partnerschaft', 'monogam', 'polyamor', 'untreue', 'fremdgeh',
      'affäre', 'relationship'],
    2: ['*beziehung', 'partner', '=paare', '=paaren', 'paardynamik', 'eifersucht', 'eifersüchtig', 'commitment', 'valentinstag'],
    1: ['bindung', 'trennung', 'romanti', '=liebe', '=lieben', '=liebt', '=liebst', '=geliebt', '=treue', '=treu'],
    0.5: ['=nähe', 'vertrauen', 'kuscheln', 'intimität', 'erziehung', 'eltern', '=streit', 'konflikt'],
  } },
  { label: 'Trauma & Heilung', keys: {
    3: ['*trauma', '*traumat', 'missbrauch', 'ptbs', 'mutterwunde', 'vaterwunde', 'dissoziation'],
    2: ['*heilung', '=heal', '=healed', '=healing', 'trauer', '=wunde', '=wunden', '*kindheitswunde', 'heilungsprozess', 'flashback'],
    1: ['=heilen', '=heilt', '=geheilt', '=heilst', '*kindheit', 'verletzung', 'verletzt', 'trigger', 'vergebung', '=täter'],
    0.5: ['*schmerz', 'verletzlich', 'betäub', 'überleben', '=opfer', 'vergib', 'verlust'],
  } },
  { label: 'Psychologie', keys: {
    3: ['psycholog', 'narziss', 'bindungsstil', 'gaslighting'],
    2: ['neurobiolog', 'dopamin', 'serotonin', 'oxytocin', 'amygdala', 'konditionier', 'vermeidend', 'bindungsangst',
      'depression', 'depressiv', 'schematherapie', 'tagträum', 'perfektionismus', '=sucht', 'süchtig', 'abhängigkeit',
      'selbstsabotage', 'opferrolle'],
    1.5: ['gehirn', '*therapie', 'therapeut', 'unterbewusst', 'manipulat', 'limbisch'],
    1: ['unbewusst', '*muster', '*angst', '=ängste', '=scham', 'beschämt', 'abhängig', '=schema', 'emotionale intelligenz',
      'psychisch'],
    0.5: ['emotion', 'mechanismus', 'verhalten', '=schuld', 'schuldgefühl', 'impuls', 'wut'],
  } },
  { label: 'Spiritualität', keys: {
    3: ['spiritu', 'erleuchtung', 'kundalini', 'mystik'],
    2: ['meditat', '=erwachen', '=erwachens', '=erwacht', '=seele', '=seelen', 'seelisch', 'göttlich', '=gebet', 'chakra',
      'karma', '=yoga', 'buddh', '=zen', 'transzend', '=gott', '=gottes', '=götter'],
    1.5: ['heilig', 'universum', 'bypass'],
    1: ['=bewusstsein', '=bewusstseins', '=ego', '=egos', 'religion', 'ritual', 'gnade', 'intuition', 'frequenz', 'vibration'],
    0.5: ['*energie', '=stille', 'präsenz', 'kirche', '=licht'],
  } },
  { label: 'Persönlichkeit', keys: {
    3: ['persönlichkeit', 'komfortzone', 'selbstwert', 'selbstliebe', 'selbstvertrauen', 'selbstachtung', 'selbstverurteilung', 'selbstmitgefühl'],
    2: ['selbstbewusst', 'authentisch', 'authentizit', 'integrität', 'disziplin', 'selbstverantwortung', 'selbstbild',
      'menschenwürde'],
    1.5: ['identität', 'charakter', 'unsicherheit', 'gewohnheit', 'selbstbestimmt', 'persönliche entwicklung'],
    1: ['=grenze', '=grenzen', '=mut', 'mutig', '=reife', '=reif', 'unreif', 'motivation', 'mission', 'selbstzweifel',
      'eigenschaft', 'potenzial', '=vergleich', 'vergleichen', 'ausreden'],
    0.5: ['verantwortung', 'stärke', '=ziel', '=ziele', '*wachstum', '=erfolg', 'ablehnung', 'scheitern', 'entscheidung',
      'loslassen', 'sanft', '=ego', '=echt', '=stark', '=wachsen', 'veränderung', '=traum', '=träume', 'dich selbst',
      'dir selbst'],
  } },
  { label: 'Gesundheit', keys: {
    3: ['gesundheit', 'menopause', 'perimenopause', 'wechseljahre', 'magnesium', 'vitamin', 'nahrungsergänzung', 'burnout',
      'ernährung', 'immunsystem', 'medikament', 'blutzucker', 'blutdruck'],
    2: ['*hormon', 'östrogen', 'progesteron', 'testosteron', 'cortisol', 'vagusnerv', 'menstruation', '*krankheit', '=darm'],
    1.5: ['nervensystem', 'erschöpf', 'symptom', 'diagnose', 'dysreguliert', '*regulier', '*regulation'],
    1: ['*stress', 'bakterien', 'alkohol', 'wohlbefinden', '=arzt', 'ärzt', '=krank', 'zyklus'],
    0.5: ['schlaf', '=gesund', '=gesunde', '=gesunden', 'atmung'],
  } },
  { label: 'Philosophie', keys: {
    3: ['philosoph', 'nietzsche', 'sokrates', 'platon', '=kant', 'stoisch', 'stoiker', 'stoizismus', 'frankl', 'camus',
      'seneca', 'aurel', 'gilgamesch', 'ethik', 'tugend'],
    2: ['existenz', 'sterblich', 'vergänglich', 'menschsein', '=moral'],
    1: ['=sinn', '=sinnes', 'sinnlos', 'sinnvoll', 'lebenssinn', '*freiheit', '=tod', '=todes', 'sterben', '=glück',
      'erkenntnis', 'weisheit', 'paradox', '=leid', '=leiden'],
    0.5: ['wahrheit', 'realität', 'wirklichkeit', 'bedeutung', 'glücklich'],
  } },
  { label: 'Männer & Frauen', keys: {
    3: ['maskulin', 'feminin', 'männlichkeit', 'weiblichkeit', 'polarität', 'patriarchat', 'feminismus'],
    2: ['männlich', 'weiblich', '=geschlecht', '=geschlechter', 'geschlechterrolle', '=gender', 'nice guy'],
    1: ['attraktiv', 'attraktion', 'anziehung', 'beschützer', 'kompliment', '=alpha', 'mutterwunde', '=männer', '=männern',
      '=frauen', '=mann', '=mannes', '=frau'],
    0.5: ['partnerin'],
  } },
  { label: 'Achtsamkeit', keys: {
    3: ['achtsam', 'mindfulness', 'innehalten', 'entschleunig', 'gelassenheit'],
    2: ['dankbarkeit', 'dankbar', 'gegenwart', 'gegenwärtig', 'hier und jetzt'],
    1: ['augenblick', '=atem', '=atmen', 'atmung', 'durchatmen', 'entspann', 'präsenz', 'akzeptanz', 'akzeptier', 'loslassen',
      'meditat'],
    0.5: ['=stille', '=ruhe', 'innerer frieden', 'innere ruhe', 'aufmerksamkeit', 'wahrnehm'],
  } },
  { label: 'Gesellschaft', keys: {
    3: ['*gesellschaft', 'politi', 'regime', 'diktatur', '=nazi', 'nazis', 'nationalsozial', 'hitler', 'völkermord',
      'genozid', 'holocaust', 'konzentrationslager', 'propaganda', 'ideologie', 'kapitalismus'],
    2: ['*kultur', '=krieg', 'kriege', 'konformität', 'konsum', 'wirtschaft', 'demokratie', 'social media'],
    1.5: ['gehorsam', 'herrschaft', 'autorität', '=staat', 'bevölkerung', 'zeitalter', 'werbung', '=medien'],
    1: ['=normen', '=norm', 'tabu', 'kollektiv', 'generation', 'religion', 'deutschland', 'internet', 'smartphone', 'scrollen',
      ],
    0.5: ['=sozial', '=soziale', '=sozialen', '=system', '=systeme', '=geld', 'reichtum'],
  } },
  { label: 'Selbsterkenntnis', keys: {
    3: ['selbsterkenntnis', 'selbstreflexion', 'innenschau', 'introspektion', 'selbstbeobachtung', 'selbstwahrnehmung',
      'schattenarbeit', 'selbsterforschung'],
    2: ['reflexion', 'reflektier', 'tagebuch', 'selbstbetrug', 'selbstehrlich', 'innere arbeit'],
    1: ['=schatten', 'spiegel', 'beobachter', 'sich selbst erkennen', 'wer du bist', 'innere stimme'],
    0.5: ['bewusst werden', 'erkennst', 'wahrnehm'],
  } },
];

const TAXONOMY_LABELS = new Set(TAXONOMY.map(bucket => bucket.label));
const MAX_CATEGORIES = 3;
// Treffer im Titel zählen mehrfach: Gerade kurze Beiträge nennen ihr Thema dort.
const TITLE_WEIGHT = 3;
// Eine Kategorie braucht eine Mindestpunktzahl (wächst leicht mit der Textlänge)
// und muss nah genug an der stärksten Kategorie des Artikels liegen.
const MIN_SCORE = 2;
const MIN_SCORE_PER_100_WORDS = 0.3;
const RELATIVE_THRESHOLD = 0.35;
// Erreicht keine Kategorie die Mindestpunktzahl (kurze Beiträge), genügt für
// die stärkste allein schon ein deutliches Signal.
const FALLBACK_SCORE = 1.5;

// Wortregeln einmal vorbereiten: Einzelwörter nach Modus, Wortfolgen getrennt.
const RULES = { exact: new Map(), prefix: [], infix: [], phrases: [] };
TAXONOMY.forEach((bucket, index) => {
  for (const [weight, keys] of Object.entries(bucket.keys)) {
    for (const key of keys) {
      const rule = { index, weight: Number(weight) };
      if (key.includes(' ')) RULES.phrases.push({ ...rule, text: ` ${key}` });
      else if (key.startsWith('=')) {
        const word = key.slice(1);
        RULES.exact.set(word, [...(RULES.exact.get(word) || []), rule]);
      } else if (key.startsWith('*')) RULES.infix.push({ ...rule, text: key.slice(1) });
      else RULES.prefix.push({ ...rule, text: key });
    }
  }
});

// Treffer je Wort zwischenspeichern: Der Wortschatz des Archivs ist begrenzt,
// die Regeln werden so pro Wort nur einmal geprüft.
const wordCache = new Map();
function rulesForWord(word) {
  let hits = wordCache.get(word);
  if (hits) return hits;
  hits = [...(RULES.exact.get(word) || [])];
  for (const rule of RULES.prefix) if (word.startsWith(rule.text)) hits.push(rule);
  for (const rule of RULES.infix) if (word.includes(rule.text)) hits.push(rule);
  wordCache.set(word, hits);
  return hits;
}

const tokenize = text => String(text || '').toLowerCase().match(/[a-zäöüß]+(?:-[a-zäöüß]+)*/g) || [];

function addScores(scores, words, factor) {
  for (const word of words) {
    for (const rule of rulesForWord(word)) scores[rule.index] += rule.weight * factor;
    // Bindestrich-Komposita („Pornografie-Sucht“) zusätzlich in ihren Teilen prüfen.
    if (word.includes('-')) {
      for (const part of word.split('-')) for (const rule of rulesForWord(part)) scores[rule.index] += rule.weight * factor;
    }
  }
  const joined = ` ${words.join(' ')} `;
  for (const rule of RULES.phrases) {
    let pos = 0;
    while ((pos = joined.indexOf(rule.text, pos)) !== -1) { scores[rule.index] += rule.weight * factor; pos += rule.text.length; }
  }
}

function categoryScores(text, title = '') {
  const scores = TAXONOMY.map(() => 0);
  const words = tokenize(text);
  addScores(scores, words, 1);
  if (title) addScores(scores, tokenize(title), TITLE_WEIGHT);
  return { scores, wordCount: words.length };
}

// Höchstens drei Kategorien, die stärkste zuerst. Ohne ausreichende Treffer
// bleibt ein Artikel bewusst ohne Kategorie, statt zufällig einsortiert zu werden.
function autoCategorize(text, title = '') {
  const { scores, wordCount } = categoryScores(text, title);
  const minimum = MIN_SCORE + MIN_SCORE_PER_100_WORDS * wordCount / 100;
  const all = scores.map((score, index) => ({ label: TAXONOMY[index].label, score }))
    .sort((a, b) => b.score - a.score);
  const ranked = all.filter(entry => entry.score >= minimum);
  if (!ranked.length) return all[0].score >= FALLBACK_SCORE ? [all[0].label] : [];
  const threshold = ranked[0].score * RELATIVE_THRESHOLD;
  return ranked.filter(entry => entry.score >= threshold).slice(0, MAX_CATEGORIES).map(entry => entry.label);
}

// Filter-Kategorien: ausdrücklich in „Kategorien:“ genannte Taxonomie-Labels
// zählen immer (zuerst), danach die automatisch erkannten.
function mergeCategories(tags, autoCategories) {
  const explicit = (tags || []).filter(tag => TAXONOMY_LABELS.has(tag));
  return [...new Set([...explicit, ...autoCategories])].slice(0, MAX_CATEGORIES);
}

module.exports = { TAXONOMY, TAXONOMY_LABELS, MAX_CATEGORIES, autoCategorize, categoryScores, mergeCategories, tokenize };
