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
});

function normalizeThresholds(value = {}) {
  return {
    maxDateDistanceDays: Number.isFinite(Number(value.maxDateDistanceDays)) && value.maxDateDistanceDays !== ''
      ? Math.max(1, Math.round(Number(value.maxDateDistanceDays)))
      : DEFAULT_THRESHOLDS.maxDateDistanceDays,
    minimumTokens: Number.isFinite(Number(value.minimumTokens)) && value.minimumTokens !== ''
      ? Math.max(10, Math.round(Number(value.minimumTokens)))
      : DEFAULT_THRESHOLDS.minimumTokens,
  };
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
    score: Math.round(score * 1000) / 1000,
    exact,
    sharedShingles: body.shared,
    containment: Math.round(body.containment * 1000) / 1000,
    titleSimilarity: Math.round(title.jaccard * 1000) / 1000,
    days,
    reasons,
  };
}

// Jeder Kandidat aus B bekommt höchstens drei Original-Treffer aus A.
function detectDuplicateCandidates(originals, candidates, config = DEFAULT_THRESHOLDS) {
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
    for (const [original, shared] of sharedCounts) {
      if (shared < 8 && original.duplicateProfile.hash !== candidate.duplicateProfile.hash) continue;
      const similarity = compareDuplicateProfiles(original, candidate, config);
      if (similarity) matches.push({ original, candidate, ...similarity });
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
