// Dubletten zwischen einem kanonischen Blog und privaten Facebook-Quellen.
// Erkennung und Entscheidungen bleiben bewusst getrennt: kein Treffer wird
// automatisch verknüpft oder ausgeblendet.

const fsSync = require('fs');
const fs = require('fs/promises');
const crypto = require('crypto');
const { createJsonState } = require('./lib/atomic-file.cjs');

const DEFAULT_CONFIG = Object.freeze({
  blogAuthor: 'Joe Turan',
  facebookAuthors: ['Facebook'],
  maxDateDistanceDays: 730,
  minimumTokens: 35,
});

function loadDuplicateConfig(file) {
  let value = {};
  try {
    const document = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    value = document?.duplicates || {};
  } catch { /* Standardwerte verwenden */ }
  const facebookAuthors = Array.isArray(value.facebookAuthors)
    ? [...new Set(value.facebookAuthors.map(String).map(item => item.trim()).filter(Boolean))]
    : DEFAULT_CONFIG.facebookAuthors;
  return {
    blogAuthor: String(value.blogAuthor || DEFAULT_CONFIG.blogAuthor).trim(),
    facebookAuthors,
    maxDateDistanceDays: Number.isFinite(Number(value.maxDateDistanceDays))
      ? Math.max(1, Number(value.maxDateDistanceDays))
      : DEFAULT_CONFIG.maxDateDistanceDays,
    minimumTokens: Number.isFinite(Number(value.minimumTokens))
      ? Math.max(10, Number(value.minimumTokens))
      : DEFAULT_CONFIG.minimumTokens,
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
    normalized,
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

function compareDuplicateProfiles(blog, facebook, config = DEFAULT_CONFIG) {
  const left = blog.duplicateProfile;
  const right = facebook.duplicateProfile;
  if (!left || !right || left.tokenCount < config.minimumTokens || right.tokenCount < config.minimumTokens) return null;
  const days = dateDistanceDays(blog.date, facebook.date);
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

function detectDuplicateCandidates(articles, config = DEFAULT_CONFIG) {
  const blogs = articles.filter(article => article.author === config.blogAuthor && article.duplicateProfile);
  const facebook = articles.filter(article => config.facebookAuthors.includes(article.author) && article.duplicateProfile);
  const byShingle = new Map();
  for (const blog of blogs) {
    for (const shingle of blog.duplicateProfile.shingles) {
      const ids = byShingle.get(shingle);
      if (ids) ids.add(blog);
      else byShingle.set(shingle, new Set([blog]));
    }
  }
  const result = [];
  for (const source of facebook) {
    const sharedCounts = new Map();
    for (const shingle of source.duplicateProfile.shingles) {
      for (const blog of byShingle.get(shingle) || []) {
        sharedCounts.set(blog, (sharedCounts.get(blog) || 0) + 1);
      }
    }
    const matches = [];
    for (const [blog, shared] of sharedCounts) {
      if (shared < 8 && blog.duplicateProfile.hash !== source.duplicateProfile.hash) continue;
      const similarity = compareDuplicateProfiles(blog, source, config);
      if (similarity) matches.push({ blog, facebook: source, ...similarity });
    }
    matches.sort((a, b) => b.score - a.score || String(b.blog.date).localeCompare(String(a.blog.date)));
    result.push(...matches.slice(0, 3));
  }
  return result.sort((a, b) => b.score - a.score || String(b.facebook.date).localeCompare(String(a.facebook.date)));
}

function createDuplicateStore({ file, io = fs }) {
  // Änderungen wirken erst, wenn die Datei geschrieben ist (createJsonState).
  const state = createJsonState({
    file, io,
    fromDocument: parsed => (Array.isArray(parsed?.decisions) ? parsed.decisions.filter(Boolean) : []),
    toDocument: decisions => ({ version: 1, decisions }),
  });
  const load = () => { state.load(); };

  const keyOf = (blogId, facebookId) => `${blogId}\0${facebookId}`;
  // Ändert die übergebene Liste (Kopie aus state.update) an Ort und Stelle.
  function upsert(decisions, { blogId, facebookId, status, blogHash, facebookHash, user, migrations = [] }) {
    if (!['linked', 'ignored'].includes(status)) throw new Error('Ungültiger Dublettenstatus.');
    const now = new Date().toISOString();
    const existing = decisions.find(item => keyOf(item.blogId, item.facebookId) === keyOf(blogId, facebookId));
    const decision = {
      blogId, facebookId, status, blogHash, facebookHash,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
      createdBy: existing?.createdBy || String(user || ''),
      migrations: migrations.length ? migrations : (existing?.migrations || []),
    };
    const kept = decisions.filter(item => keyOf(item.blogId, item.facebookId) !== keyOf(blogId, facebookId)
      && (status !== 'linked' || item.status !== 'linked' || item.facebookId !== facebookId));
    decisions.splice(0, decisions.length, ...kept, decision);
    return decision;
  }
  return {
    load,
    all() { return state.value.map(decision => ({ ...decision })); },
    find(blogId, facebookId) {
      const key = keyOf(blogId, facebookId);
      return state.value.find(item => keyOf(item.blogId, item.facebookId) === key) || null;
    },
    linkedCanonicalId(facebookId) {
      return state.value.find(item => item.status === 'linked' && item.facebookId === facebookId)?.blogId || null;
    },
    async set(input) {
      return { ...await state.update(decisions => upsert(decisions, input)) };
    },
    async setMany(inputs) {
      if (!Array.isArray(inputs) || !inputs.length) return [];
      for (const input of inputs) {
        if (!['linked', 'ignored'].includes(input?.status)) throw new Error('Ungültiger Dublettenstatus.');
      }
      const stored = await state.update(decisions => inputs.map(input => upsert(decisions, input)));
      return stored.map(decision => ({ ...decision }));
    },
    async remove(blogId, facebookId) {
      await state.update(decisions => {
        const index = decisions.findIndex(item => keyOf(item.blogId, item.facebookId) === keyOf(blogId, facebookId));
        if (index < 0) return false;
        decisions.splice(index, 1);
        return true;
      });
    },
  };
}

function decisionStillApplies(decision, blog, facebook) {
  if (!decision || !blog?.duplicateProfile || !facebook?.duplicateProfile) return false;
  if (decision.status === 'linked') return true;
  return decision.blogHash === blog.duplicateProfile.hash
    && decision.facebookHash === facebook.duplicateProfile.hash;
}

module.exports = {
  DEFAULT_CONFIG,
  loadDuplicateConfig,
  normalizeDuplicateText,
  // Auch vom Dubletten-Werkzeug (duplicates-tool/) genutzt.
  wordShingles,
  overlap,
  dateDistanceDays,
  buildDuplicateProfile,
  compareDuplicateProfiles,
  detectDuplicateCandidates,
  createDuplicateStore,
  decisionStillApplies,
};
