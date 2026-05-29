/**
 * Liest users.json, hasht alle Einträge mit "password"-Feld und schreibt die
 * Datei zurück. Danach enthält sie nur noch "passwordHash", kein Klartext.
 *
 * Nutzung:
 *   1. users.json anlegen/bearbeiten — Klartext-Passwort im Feld "password"
 *   2. node scripts/hash-passwords.js
 *
 * Passwort ändern:
 *   "passwordHash"-Zeile löschen, "password": "NeuesPasswort" eintragen,
 *   Skript erneut ausführen.
 */

const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, '..', 'users.json');

async function main() {
  let users;
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    console.error('Fehler beim Lesen von users.json:', err.message);
    process.exit(1);
  }

  let changed = 0;

  for (const u of users) {
    if (u.password) {
      u.passwordHash = await bcrypt.hash(u.password, 12);
      delete u.password;
      changed++;
      console.log(`✓ Passwort gehashed: ${u.email}`);
    } else if (u.passwordHash) {
      console.log(`  Bereits gehashed:  ${u.email}`);
    } else {
      console.warn(`! Kein Passwort für: ${u.email}`);
    }
  }

  if (changed > 0) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log(`\n${changed} Passwort(e) gehashed — users.json aktualisiert.`);
  } else {
    console.log('\nKeine Änderungen notwendig.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
