// Dubletten zwischen Ordner A (Original) und Ordner B (Kandidat).
// Erkennung übernommen aus WebArchiv/duplicates.cjs: Wort-Shingles, Enthaltensein,
// Jaccard, Titelähnlichkeit und Datumsabstand. Kein Treffer wird automatisch verschoben.
'use strict';

const fsSync = require('fs');
const fs = require('fs/promises');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./json-file.cjs');

const DEFAULT_THRESHOLDS = Object.freeze({
  maxDateDistanceDays: 730,
  minimumTokens: 35,
  // Mindest-Kosinusähnlichkeit (in %) der Inhaltswörter für „inhaltlich ähnlich“; 100 = aus.
  minContentSimilarity: 45,
});

function numberOr(value, fallback) {
  return Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback;
}

function normalizeThresholds(value = {}) {
  return {
    maxDateDistanceDays: Math.max(1, Math.round(numberOr(value.maxDateDistanceDays, DEFAULT_THRESHOLDS.maxDateDistanceDays))),
    minimumTokens: Math.max(10, Math.round(numberOr(value.minimumTokens, DEFAULT_THRESHOLDS.minimumTokens))),
    minContentSimilarity: Math.min(100, Math.max(20, Math.round(numberOr(value.minContentSimilarity, DEFAULT_THRESHOLDS.minContentSimilarity)))),
  };
}

// Häufige deutsche Funktionswörter tragen keinen Inhalt und bleiben beim Inhaltsvergleich außen vor.
const STOPWORDS = new Set(`aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes
auch auf aus bei bin bis bist da damit dann das dass dein deine deinem deinen deiner dem den denn der des dessen dich
die dies diese diesem diesen dieser dieses dir doch dort du durch ein eine einem einen einer eines er es etwas euch
euer eure für gegen gewesen hab habe haben hat hatte hätte ich ihm ihn ihnen ihr ihre ihrem ihren ihrer im in indem
ins ist jede jedem jeden jeder jedes jene jetzt kann kein keine keinem keinen keiner können könnte man manche mehr
mein meine meinem meinen meiner mich mir mit muss musst nach nicht nichts noch nun nur ob oder ohne sehr sein seine
seinem seinen seiner selbst sich sie sind so solche soll sollte sondern sonst über um und uns unser unsere unter
viel vom von vor war waren warst was weil weiter welche wenn wer werde werden wie wieder will wir wird wirst wo
wollen würde zu zum zur zwar zwischen schon immer ganz einfach genau dabei darum daher denen diesem eben wirklich`.split(/\s+/));

// Sehr einfache Grundformbildung, damit „Beziehungen“/„Beziehung“ oder „liebst“/„lieben“ zusammenfallen.
function stemWord(word) {
  if (word.length <= 5) return word;
  return word.replace(/(ungen|heiten|keiten|ern|em|en|er|es|st|e|n|s)$/, '') || word;
}

function contentTerms(tokens) {
  const terms = new Map();
  for (const token of tokens) {
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    const term = stemWord(token);
    terms.set(term, (terms.get(term) || 0) + 1);
  }
  return terms;
}

function normalizeDuplicateText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase('de-DE')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/www\.\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_>#~\[\](){}|]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordShingles(tokens, size = 5) {
  const result = new Set();
  for (let i = 0; i <= tokens.length - size; i++) result.add(tokens.slice(i, i + size).join(' '));
  return result;
}

function buildDuplicateProfile(title, body) {
  const normalized = normalizeDuplicateText(body);
  const tokens = normalized ? normalized.split(' ') : [];
  const titleNormalized = normalizeDuplicateText(title);
  return {
    hash: crypto.createHash('sha256').update(normalized).digest('hex'),
    tokenCount: tokens.length,
    shingles: wordShingles(tokens),
    titleTokens: new Set(titleNormalized ? titleNormalized.split(' ') : []),
    terms: contentTerms(tokens),
  };
}

function overlap(left, right) {
  if (!left?.size || !right?.size) return { shared: 0, containment: 0, jaccard: 0 };
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return {
    shared,
    containment: shared / small.size,
    jaccard: shared / (left.size + right.size - shared),
  };
}

function dateDistanceDays(left, right) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(left || '') || !/^\d{4}-\d{2}-\d{2}$/.test(right || '')) return null;
  return Math.round(Math.abs(Date.parse(left) - Date.parse(right)) / 86400000);
}

function compareDuplicateProfiles(original, candidate, config = DEFAULT_THRESHOLDS) {
  const left = original.duplicateProfile;
  const right = candidate.duplicateProfile;
  if (!left || !right || left.tokenCount < config.minimumTokens || right.tokenCount < config.minimumTokens) return null;
  const days = dateDistanceDays(original.date, candidate.date);
  const exact = left.hash === right.hash;
  const body = overlap(left.shingles, right.shingles);
  const title = overlap(left.titleTokens, right.titleTokens);
  const dateScore = days === null ? 0.5 : Math.max(0, 1 - days / config.maxDateDistanceDays);
  const score = exact ? 1 : (body.containment * 0.62 + body.jaccard * 0.23 + title.jaccard * 0.1 + dateScore * 0.05);
  if (!exact && (body.shared < 8 || body.containment < 0.55 || score < 0.62)) return null;
  if (!exact && days !== null && days > config.maxDateDistanceDays && body.containment < 0.9) return null;
  const reasons = [];
  if (exact) reasons.push('Normalisierte Wortfolge identisch');
  else {
    if (body.containment >= 0.85) reasons.push('Inhalt nahezu vollständig enthalten');
    else reasons.push('Hohe Textüberschneidung');
    if (title.jaccard >= 0.6) reasons.push('Ähnlicher Titel');
  }
  if (days !== null) reasons.push(`${days} Tag${days === 1 ? '' : 'e'} Abstand`);
  return {
    method: 'text',
    score: Math.round(score * 1000) / 1000,
    exact,
    sharedShingles: body.shared,
    containment: Math.round(body.containment * 1000) / 1000,
    titleSimilarity: Math.round(title.jaccard * 1000) / 1000,
    days,
    reasons,
  };
}

// ─── Inhaltliche Ähnlichkeit (unabhängig von Titel und Wortreihenfolge) ────
// TF-IDF-Vektoren über die Inhaltswörter beider Seiten; Kosinusähnlichkeit über einen
// invertierten Index, damit nicht jedes Paar einzeln verglichen werden muss.

function buildContentIndex(originals, candidates) {
  const documents = [...originals, ...candidates].filter(article => article.duplicateProfile?.terms?.size);
  const documentFrequency = new Map();
  for (const article of documents) {
    for (const term of article.duplicateProfile.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const total = documents.length || 1;
  // Wörter, die in sehr vielen Texten vorkommen, unterscheiden nichts.
  const maxFrequency = Math.max(3, Math.floor(total * 0.15));
  const vectors = new Map();
  for (const article of documents) {
    const vector = new Map();
    let norm = 0;
    for (const [term, count] of article.duplicateProfile.terms) {
      const df = documentFrequency.get(term);
      if (df > maxFrequency) continue;
      const weight = (1 + Math.log(count)) * Math.log(1 + total / df);
      vector.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, weight] of vector) vector.set(term, weight / norm);
    vectors.set(article, vector);
  }
  const postings = new Map();
  for (const original of originals) {
    for (const [term, weight] of vectors.get(original) || []) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([original, weight]);
    }
  }
  return { vectors, postings };
}

function contentSimilarities(index, candidate) {
  const scores = new Map();
  for (const [term, weight] of index.vectors.get(candidate) || []) {
    for (const [original, originalWeight] of index.postings.get(term) || []) {
      scores.set(original, (scores.get(original) || 0) + weight * originalWeight);
    }
  }
  return scores;
}

function contentMatch(original, candidate, cosine, config) {
  const left = original.duplicateProfile;
  const right = candidate.duplicateProfile;
  if (left.tokenCount < config.minimumTokens || right.tokenCount < config.minimumTokens) return null;
  const threshold = config.minContentSimilarity / 100;
  if (threshold >= 1 || cosine < threshold) return null;
  const days = dateDistanceDays(original.date, candidate.date);
  if (days !== null && days > config.maxDateDistanceDays && cosine < 0.85) return null;
  const body = overlap(left.shingles, right.shingles);
  const title = overlap(left.titleTokens, right.titleTokens);
  const reasons = [cosine >= 0.8 ? 'Inhaltlich sehr ähnlich' : 'Inhaltlich ähnlich'];
  if (body.containment < 0.3) reasons.push('Anders formuliert');
  if (title.jaccard < 0.2) reasons.push('Anderer Titel');
  if (days !== null) reasons.push(`${days} Tag${days === 1 ? '' : 'e'} Abstand`);
  return {
    method: 'content',
    score: Math.round(Math.min(cosine, 0.999) * 1000) / 1000,
    exact: false,
    contentSimilarity: Math.round(cosine * 1000) / 1000,
    sharedShingles: body.shared,
    containment: Math.round(body.containment * 1000) / 1000,
    titleSimilarity: Math.round(title.jaccard * 1000) / 1000,
    days,
    reasons,
  };
}

// Jeder Kandidat aus B bekommt höchstens drei Original-Treffer aus A – aus dem
// Wortfolgen-Vergleich (Shingles) und dem inhaltlichen Vergleich zusammen.
function detectDuplicateCandidates(originals, candidates, config = DEFAULT_THRESHOLDS) {
  config = { ...DEFAULT_THRESHOLDS, ...config };
  const contentIndex = config.minContentSimilarity < 100 ? buildContentIndex(originals, candidates) : null;
  const byShingle = new Map();
  for (const original of originals) {
    if (!original.duplicateProfile) continue;
    for (const shingle of original.duplicateProfile.shingles) {
      const items = byShingle.get(shingle);
      if (items) items.add(original);
      else byShingle.set(shingle, new Set([original]));
    }
  }
  const byHash = new Map();
  for (const original of originals) {
    const hash = original.duplicateProfile?.hash;
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(original);
  }
  const result = [];
  for (const candidate of candidates) {
    if (!candidate.duplicateProfile) continue;
    const sharedCounts = new Map();
    for (const original of byHash.get(candidate.duplicateProfile.hash) || []) sharedCounts.set(original, 0);
    for (const shingle of candidate.duplicateProfile.shingles) {
      for (const original of byShingle.get(shingle) || []) {
        sharedCounts.set(original, (sharedCounts.get(original) || 0) + 1);
      }
    }
    const matches = [];
    const found = new Set();
    for (const [original, shared] of sharedCounts) {
      if (shared < 8 && original.duplicateProfile.hash !== candidate.duplicateProfile.hash) continue;
      const similarity = compareDuplicateProfiles(original, candidate, config);
      if (similarity) {
        matches.push({ original, candidate, ...similarity });
        found.add(original);
      }
    }
    if (contentIndex) {
      for (const [original, cosine] of contentSimilarities(contentIndex, candidate)) {
        if (found.has(original)) continue;
        const similarity = contentMatch(original, candidate, cosine, config);
        if (similarity) matches.push({ original, candidate, ...similarity });
      }
    }
    matches.sort((a, b) => b.score - a.score || String(b.original.date).localeCompare(String(a.original.date)));
    result.push(...matches.slice(0, 3));
  }
  return result.sort((a, b) => b.score - a.score || String(b.candidate.date).localeCompare(String(a.candidate.date)));
}

// „Ignorieren“-Entscheidungen, gebunden an absolute Pfade und Texthashes:
// Ändert sich einer der Texte, ist der Treffer wieder offen.
function createDecisionStore({ file, io = fs }) {
  let decisions = [];
  let queue = Promise.resolve();

  function load() {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      decisions = Array.isArray(parsed?.decisions) ? parsed.decisions.filter(Boolean) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`${file} nicht geladen —`, error.message);
      decisions = [];
    }
  }

  function persist() {
    const run = queue.then(() => writeJsonAtomic(file, { version: 1, decisions }, io));
    queue = run.catch(error => console.error('Entscheidungen konnten nicht gespeichert werden:', error.message));
    return run;
  }

  const keyOf = (originalPath, candidatePath) => `${originalPath}\0${candidatePath}`;
  return {
    load,
    all() { return decisions.map(decision => ({ ...decision })); },
    find(originalPath, candidatePath) {
      const key = keyOf(originalPath, candidatePath);
      return decisions.find(item => keyOf(item.originalPath, item.candidatePath) === key) || null;
    },
    async ignore({ originalPath, candidatePath, originalHash, candidateHash }) {
      const previous = decisions;
      const key = keyOf(originalPath, candidatePath);
      decisions = decisions.filter(item => keyOf(item.originalPath, item.candidatePath) !== key);
      decisions.push({ originalPath, candidatePath, originalHash, candidateHash, status: 'ignored', updatedAt: new Date().toISOString() });
      try { await persist(); }
      catch (error) { decisions = previous; throw error; }
    },
    async remove(originalPath, candidatePath) {
      const previousLength = decisions.length;
      const key = keyOf(originalPath, candidatePath);
      decisions = decisions.filter(item => keyOf(item.originalPath, item.candidatePath) !== key);
      if (decisions.length !== previousLength) await persist();
    },
  };
}

function decisionStillApplies(decision, original, candidate) {
  if (!decision || !original?.duplicateProfile || !candidate?.duplicateProfile) return false;
  return decision.originalHash === original.duplicateProfile.hash
    && decision.candidateHash === candidate.duplicateProfile.hash;
}

module.exports = {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  normalizeDuplicateText,
  buildDuplicateProfile,
  compareDuplicateProfiles,
  detectDuplicateCandidates,
  createDecisionStore,
  decisionStillApplies,
};
