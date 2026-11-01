'use strict';

// Volltextsuche ohne Index: Jeder Artikel trägt intern einen normalisierten Suchtext
// (Titel, Zusammenfassung, Text). Eine Suche prüft ihn per Teilstring – auch innerhalb
// von Wörtern („angst“ findet „Verlustangst“). Gemessen am Bestand (7.164 Artikel,
// 25 Mio. Zeichen): rund 15 ms pro Suche, deshalb kein invertierter Index.

// Klein, ohne Akzente und Umlautpunkte (ä → a, wie NFKD), ß → ss; alles außer Buchstaben
// und Ziffern wird zu einem Leerzeichen. So treffen Phrasen auch über Zeilenumbrüche
// und Markdown-Zeichen hinweg.
function foldSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// "inneres kind" in Anführungszeichen = Phrase, sonst einzelne Wörter; alle müssen vorkommen.
function parseFulltextQuery(query) {
  const terms = [];
  const source = String(query || '');
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const term = foldSearchText(match[1] ?? match[2]);
    if (term) terms.push(term);
  }
  return terms;
}

function matchesFulltext(searchText, terms) {
  if (!searchText || !terms.length) return false;
  return terms.every(term => searchText.includes(term));
}

module.exports = { foldSearchText, parseFulltextQuery, matchesFulltext };
