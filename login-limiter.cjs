'use strict';

// Begrenzung fehlgeschlagener Kennwortprüfungen (Anmeldung, eigenes Kennwort
// ändern). Rein im Arbeitsspeicher: Ein Neustart setzt alle Zähler zurück.
// Drei Zähler:
//  - Konto + IP (5): sperrt den Angreifer für dieses Konto, nicht den Inhaber.
//    Wer nur die E-Mail kennt, kann ein Konto damit nicht mehr aussperren.
//  - Konto gesamt (50): bremst verteiltes Durchprobieren von vielen Adressen.
//  - IP (30): bremst das Durchprobieren vieler Konten von einer Adresse.

const MINUTE = 60 * 1000;

function createLoginLimiter({
  windowMs = 15 * MINUTE, lockMs = 15 * MINUTE, maxPerAccountIp = 5, maxPerAccount = 50, maxPerIp = 30,
  maxEntries = 10000, now = Date.now,
} = {}) {
  const buckets = new Map();

  const normalizedAccount = account => String(account || '').trim().toLowerCase();
  const accountKey = account => `a:${normalizedAccount(account)}`;
  const ipKey = ip => `i:${String(ip || 'unbekannt')}`;
  const pairKey = (ip, account) => `p:${String(ip || 'unbekannt')}|${normalizedAccount(account)}`;

  function current(key) {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    const time = now();
    if (bucket.lockedUntil > time) return bucket;
    if (!bucket.lockedUntil && time - bucket.first < windowMs) return bucket;
    buckets.delete(key);
    return null;
  }

  function prune() {
    if (buckets.size <= maxEntries) return;
    for (const key of [...buckets.keys()]) current(key);
    // Notfalls die ältesten Einträge verwerfen, damit der Speicher begrenzt bleibt.
    for (const key of buckets.keys()) {
      if (buckets.size <= maxEntries) break;
      buckets.delete(key);
    }
  }

  function count(key, max) {
    const time = now();
    const bucket = current(key) || { count: 0, first: time, lockedUntil: 0 };
    bucket.count++;
    if (bucket.count >= max) bucket.lockedUntil = time + lockMs;
    buckets.set(key, bucket);
  }

  return {
    // { allowed: true } oder { allowed: false, retryAfterSeconds }
    check(ip, account) {
      const time = now();
      const lockedUntil = Math.max(
        current(pairKey(ip, account))?.lockedUntil || 0,
        current(accountKey(account))?.lockedUntil || 0,
        current(ipKey(ip))?.lockedUntil || 0,
      );
      if (lockedUntil <= time) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - time) / 1000)) };
    },
    failure(ip, account) {
      count(pairKey(ip, account), maxPerAccountIp);
      count(accountKey(account), maxPerAccount);
      count(ipKey(ip), maxPerIp);
      prune();
    },
    // Erfolgreiche Prüfung setzt die Kontozähler zurück; die IP-Grenze bleibt.
    success(ip, account) {
      buckets.delete(pairKey(ip, account));
      buckets.delete(accountKey(account));
    },
  };
}

function tooManyAttemptsError(limit) {
  const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
  return Object.assign(
    new Error(`Zu viele Anmeldeversuche. Bitte in ${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'} erneut versuchen.`),
    { status: 429, retryAfter: limit.retryAfterSeconds },
  );
}

module.exports = { createLoginLimiter, tooManyAttemptsError };
