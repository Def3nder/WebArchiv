'use strict';

// Neuer eigener Artikel (Admin, Dialog „Neuer Artikel“, Typ „Artikel“): fester Autor und
// lesbarer Dateiname wie bei den vorhandenen Dateien dieses Autors
// („2026-11-04_ChatGPT - Steckbrief.md“), nicht der Slug der Infografiken.

const fs = require('fs');
const path = require('path');

const NEW_ARTICLE_AUTHOR = 'Ralf';
// Zeichen, nicht Bytes: Umlaute brauchen in UTF-8 zwei Bytes, Linux erlaubt 255 Bytes je Name.
const MAX_TITLE_CHARS = 100;

// Titel → lesbarer Dateiname ohne Datum und Endung. Unter Windows verbotene Zeichen und
// Steuerzeichen fallen weg; „:“ wird zu „ - “ (wie „ChatGPT - Steckbrief“), Schrägstriche und
// „|“ werden zu „-“. „#“ und „%“ fallen weg, weil sie in Links und Pfaden stören.
function readableFileStem(title) {
  let stem = String(title || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/:/g, ' - ')
    .replace(/[\\/|]/g, '-')
    .replace(/[*?"<>#%]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*-\s*){2,}/g, ' - ')
    .trim();
  if (stem.length > MAX_TITLE_CHARS) stem = stem.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '') || stem.slice(0, MAX_TITLE_CHARS);
  // Keine führenden Punkte/Striche (versteckte Datei, Optionen) und kein Punkt oder Leerzeichen am
  // Ende (Windows schneidet beides ab).
  return stem.replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');
}

// Belegt, wenn es den Stamm schon als Artikel oder Begleitdatei gibt (Groß/Klein egal).
function articleStemExists(dir, stem) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const wanted = stem.toLowerCase();
  return names.some(name => path.parse(name).name.toLowerCase() === wanted);
}

module.exports = { NEW_ARTICLE_AUTHOR, MAX_TITLE_CHARS, readableFileStem, articleStemExists };
