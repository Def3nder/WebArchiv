'use strict';

// Artikel-Liste, Einzelartikel und Facetten (/api/meta). Die Liste filtert erst nach
// den Autorrechten (ACL), dann nach Dubletten, Lesezeichen, Telegram, Filtern und
// Suche; Kachelansichten fassen Artikel und ihre Infografiken zu einer Kachel zusammen.

const { httpError, apiError, jsonRoute } = require('../lib/http-errors.cjs');
const { parseArticleSearchQuery } = require('../lib/article-parser.cjs');
const { articleDisplayAuthor } = require('../lib/article-index.cjs');
const { INFOGRAPHICS_AUTHOR } = require('../lib/infographics.cjs');
const { shareIdFor } = require('../lib/share-ids.cjs');

// Telegram ist in Listen ausgeblendet, außer mit ?telegram=1 oder author=Telegram.
const TELEGRAM_AUTHOR = 'Telegram';

// Ungültige Werte (z. B. page=abc) ergaben früher NaN und damit eine leere Seite.
function paginationParams(page, limit) {
  return {
    page: Math.max(1, parseInt(page, 10) || 1),
    limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 24)),
  };
}

// Was ein Nutzer von Artikeln und Infografik-Gruppen sieht.
// archive: Indexzustand aus server.js (Felder erst beim Aufruf lesen).
function createArticleViews({ archive, canAccessAuthor }) {
  // Anker der Gruppe, zu der eine Infografik gehört – nur wenn der Nutzer ihn sehen
  // darf. Sonst (z. B. Gast ohne Recht am Artikel) bleibt die Infografik einzeln.
  function visibleGroupAnchor(article, user, { hideTelegram = false } = {}) {
    const anchor = archive.articleById.get(archive.groupAnchorOf.get(article?.id));
    if (!anchor || !canAccessAuthor(user, anchor.author)) return null;
    if (hideTelegram && anchor.author === TELEGRAM_AUTHOR) return null;
    return anchor;
  }

  // Nur interne Felder entfernen und geerbtes Audio ohne Recht am Ursprung verbergen.
  function exposeArticleForUser(article, user) {
    const {
      filePath, inheritedAudioAuthor, inheritedAudioArticleId,
      ownImage, hasBody, infographicBase, infographicOrdinal, duplicateProfile, ...rest
    } = article;
    const exposed = inheritedAudioAuthor && !canAccessAuthor(user, inheritedAudioAuthor)
      ? { ...rest, audioUrl: null, hasExternalAudio: false, episodeNum: null }
      : rest;
    // Die echte Autorenzuordnung bleibt für ACL und Routing unverändert. Für die
    // Anzeige übernimmt jede verknüpfte Infografik jedoch den Autor ihres
    // sichtbaren Hauptartikels – auch wenn Telegram in der Liste ausgeblendet ist.
    if (article.author !== INFOGRAPHICS_AUTHOR) return exposed;
    return { ...exposed, displayAuthor: articleDisplayAuthor(article, visibleGroupAnchor(article, user)) };
  }

  // Eine Infografik-Kachel öffnet ihren Anker (auch einen ausgeblendeten Telegram-Artikel);
  // dessen Lesezeichen gilt deshalb auch für die Kachel.
  function isBookmarkedTile(item, user, marks) {
    return marks.has(item.id) || marks.has(visibleGroupAnchor(item, user)?.id);
  }

  // Bilder einer Gruppe: eigenes Artikelfoto (kein standard.jpg), dann die
  // Infografiken in Reihenfolge. null, wenn der Nutzer keine Grafik der Gruppe sieht.
  function groupImagesFor(anchor, user) {
    const members = (archive.infographicGroups.get(anchor.id) || [])
      .filter(member => member.ownImage && canAccessAuthor(user, member.author));
    if (!members.length) return null;
    const images = anchor.ownImage
      ? [{ id: anchor.id, url: anchor.imageUrl, kind: anchor.author === INFOGRAPHICS_AUTHOR ? 'infographic' : 'photo' }]
      : [];
    for (const member of members) images.push({ id: member.id, url: member.imageUrl, kind: 'infographic' });
    return images;
  }

  function exposeGroupForUser(anchor, user) {
    const exposed = exposeArticleForUser(anchor, user);
    const images = groupImagesFor(anchor, user);
    return images ? { ...exposed, imageUrl: images[0].url, images } : exposed;
  }

  return { visibleGroupAnchor, exposeArticleForUser, isBookmarkedTile, groupImagesFor, exposeGroupForUser };
}

// attachUser setzt req.user (Gast oder angemeldeter Nutzer); bookmarks: Lesezeichen-Speicher;
// articleBodies: gerenderte Artikeltexte; canUploadInfographic: aus der Infografik-Verwaltung.
function installArticleRoutes(app, {
  attachUser, archive, bookmarks, articleBodies, canAccessAuthor, duplicateCanonicalFor, canUploadInfographic,
}) {
  const {
    visibleGroupAnchor, exposeArticleForUser, isBookmarkedTile, groupImagesFor, exposeGroupForUser,
  } = createArticleViews({ archive, canAccessAuthor });

  app.get('/api/meta', attachUser, jsonRoute(req => {
    const user = req.user;
    const authors = user.allowedAuthors === null
      ? archive.meta.authors
      : archive.meta.authors.filter(a => user.allowedAuthors.includes(a));
    return { authors, years: archive.meta.years, categories: archive.meta.categories };
  }, { label: 'Facetten' }));

  app.get('/api/articles', attachUser, jsonRoute(req => {
    const {
      q, author, year, category, page = '1', limit = '24', telegram, externalAudio,
      instagram, infographic, infographicReview,
    } = req.query;
    const user = req.user;
    const infographicReviewMode = infographicReview === '1';
    if (infographicReviewMode && user.role !== 'admin') {
      throw httpError(403, 'Der Infografik-Prüfmodus ist nur für Administratoren verfügbar.');
    }
    const marks = bookmarks.idsFor(user.email);
    const onlyBookmarks = req.query.bookmarks === '1';
    let filtered = archive.articles;

    // ACL pre-filter: restrict to allowed authors
    if (user.allowedAuthors !== null) {
      filtered = filtered.filter(a => user.allowedAuthors.includes(a.author));
    }

    // Bestätigte Facebook-Dubletten verschwinden aus allen normalen Ansichten,
    // sofern der Nutzer ihren kanonischen Blogartikel sehen darf.
    filtered = filtered.filter(article => !duplicateCanonicalFor(article, user));

    // Nur Artikel mit Lesezeichen (Gäste: keine). Die übrigen Filter gelten weiter.
    if (onlyBookmarks) filtered = filtered.filter(a => marks.has(a.id));

    // "Telegram"-Artikel standardmäßig ausblenden; einbeziehen bei telegram=1,
    // wenn explizit nach Autor "Telegram" gefiltert wird oder bei Lesezeichen.
    const hideTelegram = telegram !== '1' && author !== TELEGRAM_AUTHOR && !onlyBookmarks;
    if (hideTelegram) {
      filtered = filtered.filter(a => a.author !== TELEGRAM_AUTHOR);
    }

    if (author) {
      if (!canAccessAuthor(user, author)) {
        return { total: 0, page: 1, limit: 24, pages: 0, items: [] };
      }
      filtered = filtered.filter(a => a.author === author);
    }
    const infographicFilter = author === INFOGRAPHICS_AUTHOR
      ? (infographic === 'classic' ? 'classic' : ((infographic === 'poster' || instagram === '1') ? 'poster' : 'all'))
      : 'all';
    const instagramPosterMode = infographicFilter === 'poster';
    const classicInfographicMode = infographicFilter === 'classic';
    if (instagramPosterMode) filtered = filtered.filter(a => a.instagramPoster && a.ownImage);
    if (classicInfographicMode) filtered = filtered.filter(a => !a.instagramPoster && a.ownImage);
    if (infographicReviewMode) filtered = filtered.filter(a => a.author === INFOGRAPHICS_AUTHOR && a.ownImage);
    if (year)     filtered = filtered.filter(a => a.year === year);
    if (category) filtered = filtered.filter(a => a.categories.includes(category));
    if (externalAudio === '1') {
      filtered = filtered.filter(a =>
        a.hasExternalAudio &&
        (!a.inheritedAudioAuthor || canAccessAuthor(user, a.inheritedAudioAuthor))
      );
    }

    if (q) {
      // Query in Tokens zerlegen: Datums-Tokens → Datumsfilter, Rest → Fuse-Text.
      // So sind Text-Suche und Datumseingrenzung kombinierbar ("Achtsamkeit 2025").
      const { dateConstraints, text } = parseArticleSearchQuery(q, archive.meta.years);
      // Datums-Tokens als Filter anwenden (AND)
      for (const dq of dateConstraints) {
        filtered = dq.kind === 'exact'
          ? filtered.filter(a => a.date === dq.value)
          : filtered.filter(a => a.date && a.date.startsWith(dq.value));
      }
      // Restlicher Text über Fuse, auf die gefilterte Teilmenge eingeschränkt. Ohne
      // Trefferlimit: Ein Limit vor dem Filtern ließ bei allgemeinen Begriffen
      // Treffer des gewählten Autors wegfallen; schneller war es nicht.
      if (text && archive.fuseIndex) {
        const filteredIds = new Set(filtered.map(a => a.id));
        const results = archive.fuseIndex.search(text);
        filtered = results.filter(r => filteredIds.has(r.item.id)).map(r => r.item);
      }
    }

    const { page: p, limit: lim } = paginationParams(page, limit);

    // Kachelansichten: Artikel und ihre Infografiken als eine Kachel. Eine Gruppe
    // erscheint an der ersten Stelle, an der der Anker oder eine Grafik passt.
    // Nicht für die Liste und nicht beim Autorenfilter „Infografiken“.
    if (req.query.group === '1' && author !== INFOGRAPHICS_AUTHOR) {
      const tiles = [];
      const seen = new Set();
      let total = 0;
      for (const article of filtered) {
        const tile = visibleGroupAnchor(article, user, { hideTelegram }) || article;
        if (seen.has(tile.id)) continue;
        seen.add(tile.id);
        const images = groupImagesFor(tile, user);
        // Bei Lesezeichen zählt jede Kachel einmal (ein Lesezeichen = ein Treffer).
        total += onlyBookmarks ? 1 : 1 + (images ? images.length - (tile.ownImage ? 1 : 0) : 0);
        tiles.push(tile);
      }
      const items = tiles.slice((p - 1) * lim, p * lim)
        .map(tile => ({ ...exposeGroupForUser(tile, user), bookmarked: isBookmarkedTile(tile, user, marks) }));
      return { total, page: p, limit: lim, pages: Math.ceil(tiles.length / lim), items };
    }

    const total = filtered.length;
    const items = filtered.slice((p - 1) * lim, p * lim)
      .map(article => ({ ...exposeArticleForUser(article, user), bookmarked: isBookmarkedTile(article, user, marks) }));

    return { total, page: p, limit: lim, pages: Math.ceil(total / lim), items };
  }, { label: 'Artikelliste', fallback: 'Die Artikel konnten nicht geladen werden.' }));

  app.get('/api/articles/*', attachUser, jsonRoute(async req => {
    const id = req.params[0];
    const requested = archive.articleById.get(id);
    if (!requested) throw apiError('not_found');

    const canonical = duplicateCanonicalFor(requested, req.user);
    const visibleRequested = canonical || requested;
    if (!canAccessAuthor(req.user, visibleRequested.author)) throw apiError('forbidden');
    // Eine gruppierte Infografik öffnet ihre Gruppe; requestedId sagt, welches Bild gemeint war.
    const anchor = visibleGroupAnchor(visibleRequested, req.user);
    const article = anchor || visibleRequested;

    const { bodyHtml } = await articleBodies.get(article.filePath);
    const rest = exposeGroupForUser(article, req.user);
    return {
      ...rest, bodyHtml, canUploadInfographic: canUploadInfographic(req.user, article),
      // Kurze ID für den Teilen-Link /a/<shareId> (lib/share-ids.cjs).
      shareId: shareIdFor(article.id),
      bookmarked: bookmarks.has(req.user.email, article.id),
      ...((anchor || canonical) ? { requestedId: id } : {}),
    };
  }, {
    label: 'Artikel', fallback: 'Der Artikel konnte nicht geladen werden.',
    // Datei inzwischen entfernt: bis zum nächsten Reindex wie „nicht gefunden“ behandeln.
    mapError: error => (error.code === 'ENOENT' ? apiError('not_found') : null),
  }));
}

module.exports = { TELEGRAM_AUTHOR, paginationParams, createArticleViews, installArticleRoutes };
