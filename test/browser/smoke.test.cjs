'use strict';

// Browser-Smoke-Test (Review 3.5): echter Server auf dem Testarchiv (test/fixtures/smoke-archive.cjs), CSP erzwungen,
// Desktop-Chromium über Playwright. Jeder Ablauf scheitert auch an Konsolenfehlern und CSP-Verstößen.
// Eigenes Skript (npm run test:browser), nicht Teil von npm test: dauert länger und braucht einen Browser.
// Fehlt Chromium, wird übersprungen (npx playwright install chromium).
/* global document, location, getComputedStyle, WebArchivLayers -- in page.evaluate(), läuft im Browser */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { USERS } = require('../fixtures/smoke-archive.cjs');
const { startFixtureArchive } = require('../support/fixture-server.cjs');

const B09 = 'Joe Turan/2026/2026-04-01_gruppe';
const G40 = 'Infografiken/2026/2026-03-10_telegram-grafik_1';
const card = id => `.card[data-id="${id}"]`;

describe('Browser-Smoke-Test (Chromium, Testarchiv)', () => {
  let dir;
  let server;
  let passwords;
  let browser;
  let page;
  let skip = null;
  const errors = [];

  before(async () => {
    try {
      browser = await chromium.launch();
    } catch (error) {
      skip = `Chromium fehlt (npx playwright install chromium): ${error.message.split('\n')[0]}`;
      return;
    }
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webarchiv-browser-'));
    ({ server, passwords } = await startFixtureArchive(dir));
    const context = await browser.newContext({ viewport: { width: 1200, height: 640 }, baseURL: server.base });
    page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  });

  after(async () => {
    await browser?.close();
    await server?.stop();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  // Fehler seit dem letzten Aufruf: leer, sonst scheitert der Ablauf mit den Meldungen.
  const noErrors = () => assert.deepEqual(errors.splice(0), [], 'Konsolenfehler oder CSP-Verstöße');
  // Jeder Ablauf beginnt ohne offene Ebene, auch wenn der vorige mittendrin gescheitert ist.
  const closeLayers = async () => {
    for (let i = 0; i < 5 && await page.evaluate(() => typeof WebArchivLayers !== 'undefined' && !!WebArchivLayers.top()); i++) await page.keyboard.press('Escape');
  };
  const run = (name, fn) => it(name, async t => {
    if (skip) return t.skip(skip);
    await closeLayers();
    await fn();
    noErrors();
  });

  const badge = id => page.locator(`${card(id)} .author-badge`).textContent();
  const search = async (text, id) => {
    await page.fill('#search-input', text);
    await page.locator(card(id)).waitFor();
  };
  // Die App merkt sich Suche und Filter pro Nutzer: Jeder Ablauf setzt beides selbst.
  const showList = async ({ author = '', text = '' } = {}) => {
    await page.fill('#search-input', text);
    await page.evaluate(value => {
      const select = document.getElementById('filter-author');
      if (select.value === value) return;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, author);
  };
  // Offen und geladen: Die Adresse nennt den Artikel und sein Badge steht in der Ansicht.
  const openArticle = async id => {
    await page.locator(card(id)).click();
    await page.waitForFunction(articleId => document.getElementById('article-overlay').open
      && decodeURIComponent(location.hash).includes(articleId)
      && document.querySelector('#article-overlay .author-badge'), id);
  };
  // Geschlossene Dialoge müssen unsichtbar sein (der Health-Dialog stand einmal geschlossen am Seitenende).
  const closedDialogsInvisible = () => page.evaluate(() => [...document.querySelectorAll('dialog:not([open])')]
    .filter(dialog => getComputedStyle(dialog).display !== 'none').map(dialog => dialog.id));
  const adminAction = async action => {
    await page.click('#reindex-btn');
    await page.click(`#admin-menu [data-action="${action}"]`);
  };
  const isOpen = id => page.evaluate(dialogId => document.getElementById(dialogId).open, id);

  run('Gast: nur öffentliche Autoren, Badge „Infografiken“ ohne Recht am Hauptartikel', async () => {
    await page.goto('/');
    await page.locator('.card').first().waitFor();
    const authors = await page.locator('.card').evaluateAll(cards => [...new Set(cards.map(item => item.dataset.author))]);
    assert.deepEqual(authors.filter(author => !['Videos', 'PDF', 'Infografiken'].includes(author)), []);
    await search('Gruppe Grafik 1', 'Infografiken/2026/2026-04-01_gruppe_1');
    assert.equal(await badge('Infografiken/2026/2026-04-01_gruppe_1'), 'Infografiken');
    assert.deepEqual(await closedDialogsInvisible(), []);
  });

  run('Anmelden über den Dialog', async () => {
    await page.fill('#search-input', '');
    await page.click('#login-btn');
    await page.waitForFunction(() => document.getElementById('login-overlay').open);
    await page.fill('#login-email', USERS.admin.email);
    await page.fill('#login-password', passwords.admin);
    await page.click('#login-submit');
    await page.locator('#reindex-btn').waitFor({ state: 'visible' });
    assert.equal(await isOpen('login-overlay'), false);
  });

  run('Kacheln: Gruppe mit drei Bildern, Badge vom Hauptartikel auch bei ausgeblendetem Telegram', async () => {
    await showList();
    await search('Beziehung und Partnerschaft', B09);
    assert.equal(await page.locator(`${card(B09)} .card-gallery-slide`).count(), 3);
    assert.equal(await badge(B09), 'Joe Turan');
    await search('Telegram-Grafik', G40);
    assert.equal(await badge(G40), 'Telegram', 'G40: eigene Kachel, Badge vom Telegram-Artikel');
  });

  run('Volltextsuche: Lupe als Schalter findet Text innerhalb von Wörtern', async () => {
    await showList();
    await page.click('#search-fulltext');
    assert.equal(await page.getAttribute('#search-fulltext', 'aria-pressed'), 'true');
    await search('auerteig', 'Joe Turan/2026/2026-05-08_umzug');
    await page.click('#search-fulltext');
    await page.fill('#search-input', '');
  });

  run('Artikel: Galerie, Bild-Tasten scrollen, ←/→ blättern, Vollbild, Escape', async () => {
    // Autorfilter statt Suche: ←/→ braucht Nachbarn in der Liste.
    await showList({ author: 'Joe Turan' });
    await openArticle(B09);
    await page.locator('#article-overlay .detail-gallery-item').nth(2).waitFor();
    assert.equal(await page.locator('#article-overlay .detail-gallery-item').count(), 3);
    assert.equal(await page.locator('#article-overlay .author-badge').first().textContent(), 'Joe Turan');
    const panel = page.locator('#article-overlay .overlay-panel');
    const scroll = () => panel.evaluate(node => ({ top: node.scrollTop, scrollable: node.scrollHeight > node.clientHeight + 1 }));
    assert.ok((await scroll()).scrollable, 'Artikel muss für die Prüfung scrollbar sein');
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('#article-overlay .overlay-panel').scrollTop > 0);

    // B09 ist der älteste Joe-Turan-Artikel, also der letzte der Liste: erst ← zum Nachbarn, dann → zurück.
    const showing = () => page.evaluate(() => decodeURIComponent(location.hash).replace(/^#\/article\//, ''));
    assert.equal(await showing(), B09);
    await page.keyboard.press('ArrowLeft');
    // Erst wenn der Nachbar geladen ist (Badge, keine Galerie mehr), zählt → von ihm aus.
    await page.waitForFunction(id => !decodeURIComponent(location.hash).endsWith(id)
      && document.querySelector('#article-overlay .author-badge')
      && !document.querySelector('#article-overlay .detail-gallery-item'), B09);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(id => decodeURIComponent(location.hash).endsWith(id), B09);
    await page.locator('#article-overlay .detail-gallery-item').nth(2).waitFor();

    await page.locator('#article-overlay .detail-gallery-item[data-index="1"]').click();
    await page.waitForFunction(() => document.getElementById('img-fullscreen').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('img-fullscreen').open);
    assert.equal(await isOpen('article-overlay'), true, 'Escape schließt nur die oberste Ebene');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('article-overlay').open);
  });

  run('Lesezeichen setzen und filtern', async () => {
    await showList();
    await search('Beziehung und Partnerschaft', B09);
    await openArticle(B09);
    await page.click('#detail-bookmark-btn');
    await page.waitForFunction(() => document.getElementById('detail-bookmark-btn').getAttribute('aria-pressed') === 'true');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('article-overlay').open);
    await page.fill('#search-input', '');
    await page.click('#bookmark-btn');
    await page.waitForFunction(id => {
      const cards = [...document.querySelectorAll('.card')];
      return cards.length === 1 && cards[0].dataset.id === id;
    }, B09);
    await page.click('#bookmark-btn');
  });

  run('Verknüpfte Dublette: Direktlink auf den Quellbeitrag öffnet den Blogartikel', async () => {
    await page.goto(`/#/article/${encodeURIComponent('Facebook/2026/2026-05-01_verknuepft-fb')}`);
    await page.waitForFunction(() => document.getElementById('article-overlay').open);
    await page.locator('#article-overlay h1, #article-overlay h2').filter({ hasText: 'Wandern in den Bergen' }).first().waitFor();
    assert.equal(await page.locator('#article-overlay .author-badge').first().textContent(), 'Joe Turan');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('article-overlay').open);
  });

  run('Dialoge am Ebenen-Stapel: Einstellungen, Kennwort, Benutzerverwaltung, Health-Check', async () => {
    await adminAction('settings');
    await page.waitForFunction(() => document.getElementById('settings-dialog').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

    await adminAction('password');
    await page.waitForFunction(() => document.getElementById('password-dialog').open);
    await page.mouse.click(5, 320); // daneben klicken
    await page.waitForFunction(() => !document.getElementById('password-dialog').open);

    await adminAction('users');
    await page.waitForFunction(() => document.getElementById('user-admin').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('user-admin').open);

    await adminAction('health');
    await page.waitForFunction(() => document.getElementById('health-dialog').open
      && !document.getElementById('health-level').hidden);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('health-dialog').open);

    assert.equal(await page.evaluate(() => WebArchivLayers.top()), null, 'kein Dialog mehr am Stapel');
    assert.deepEqual(await closedDialogsInvisible(), []);
  });

  run('Scraper-Zentrale: Stufen, neue Artikel, Quelle hinzufügen, pausieren und entfernen', async () => {
    // „Jetzt scrapen“/„Alle scrapen“ bleiben unberührt: Sie starteten den echten Scraper.
    await showList();
    await adminAction('scraper-center');
    await page.waitForFunction(() => document.querySelectorAll('#scraper-center .scraper-source').length === 5);
    assert.equal(await page.textContent('#scraper-level'), 'Fehler');
    const card = name => page.locator(`#scraper-center .scraper-source[data-name="${name}"]`);
    assert.equal(await card('Facebook').locator('.scraper-action-error').count(), 1, 'abgebrochen');
    assert.equal(await card('Facebook').locator('.scraper-action-warning').count(), 2, 'Anmeldung, keine Beiträge');
    assert.equal(await card('Gruppe Pausiert').locator('.scraper-paused').textContent(), 'pausiert');

    await card('Joe Turan').locator('[data-scraper="toggle"]').click();
    assert.deepEqual(await card('Joe Turan').locator('.scraper-new-list li').allTextContents(),
      ['Gartenjahr', 'Joe Turan/2026/2026-12-31_nicht-mehr-da (nicht mehr im Index)']);

    await page.click('#scraper-add');
    await page.selectOption('#scraper-form-type', 'telegram');
    await page.fill('#scraper-form-name', 'Browser Kanal');
    await page.fill('#scraper-form-url', 'https://t.me/browserkanal');
    await page.click('#scraper-form-save');
    await page.locator('#scraper-form-error').filter({ hasText: 't.me/s/' }).waitFor();
    errors.splice(0); // 400 der absichtlich falschen Adresse
    await page.fill('#scraper-form-url', 'https://t.me/s/browserkanal');
    await page.click('#scraper-form-save');
    await card('Browser Kanal').waitFor();
    await card('Browser Kanal').locator('[data-scraper="pause"]').click();
    await card('Browser Kanal').locator('.scraper-paused').waitFor();
    page.once('dialog', dialog => dialog.accept());
    await card('Browser Kanal').locator('[data-scraper="remove"]').click();
    await card('Browser Kanal').waitFor({ state: 'detached' });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('scraper-center').open);
    assert.deepEqual(await closedDialogsInvisible(), []);
  });

  run('Neuer Artikel: Typ umschalten, Vorschau des Dateinamens, Ralf-Artikel ohne Bild speichern und öffnen', async () => {
    await showList();
    await adminAction('new-article');
    await page.waitForFunction(() => document.getElementById('article-new').open);
    const view = () => page.evaluate(() => ({
      type: document.querySelector('input[name="article-new-type"]:checked').value,
      file: document.getElementById('article-new-filename').textContent,
      pick: document.getElementById('article-new-pick').textContent,
      save: !document.getElementById('article-new-save').disabled,
    }));
    assert.equal((await view()).type, 'infographic', 'ohne gemerkte Wahl zuerst Infografik');
    await page.fill('#article-new-text', '# Smoke: Neuer Artikel\n\nDatum: 2027-03-04\n\n----\n\nErster Absatz.\n');
    let state = await view();
    assert.match(state.file, /Infografiken\/2027\/2027-03-04_smoke-neuer-artikel\.md/);
    assert.deepEqual([state.pick, state.save], ['Grafik auswählen', false], 'Infografik braucht eine Grafik');

    await page.click('.article-new-type label:has(input[value="article"])');
    state = await view();
    assert.match(state.file, /Ralf\/2027\/2027-03-04_Smoke - Neuer Artikel\.md/);
    assert.deepEqual([state.type, state.pick, state.save], ['article', 'Bild auswählen', true], 'Artikel: Bild optional');
    await page.locator('#article-new-categories input').first().check();

    // Escape mit Eingaben fragt nach; „Abbrechen“ in der Rückfrage lässt den Dialog offen.
    page.once('dialog', dialog => dialog.dismiss());
    await page.keyboard.press('Escape');
    assert.equal(await isOpen('article-new'), true);

    await page.click('#article-new-save');
    const id = 'Ralf/2027/2027-03-04_Smoke - Neuer Artikel';
    await page.waitForFunction(articleId => document.getElementById('article-overlay').open
      && decodeURIComponent(location.hash).includes(articleId)
      && document.querySelector('#article-overlay .author-badge')?.textContent === 'Ralf', id);
    assert.equal(await isOpen('article-new'), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('wa-new-article-type')), 'article', 'Wahl gemerkt');
    await page.keyboard.press('Escape');
    assert.deepEqual(await closedDialogsInvisible(), []);
  });

  run('Audio-Auftrag fertig: MP3 im Dialog anhören und herunterladen, Dialog schließt', async () => {
    // Fertiger Auftrag ohne TTS-Dienst: Status-Antworten vorgeben, die MP3 ist eine echte Datei des Testarchivs.
    const audioUrl = '/files/Ralf/2026/2026-03-03_audio-daneben.mp3';
    await page.route('**/api/tts/latest', route => route.fulfill({ json: { jobId: 'smoke-job' } }));
    await page.route('**/api/tts/smoke-job/status', route => route.fulfill({
      json: { done: true, status: 'succeeded', title: 'Audio daneben', output: '', audioUrl, articleId: 'Ralf/2026/2026-03-03_audio-daneben' },
    }));
    try {
      await adminAction('tts-job');
      await page.waitForFunction(() => !document.getElementById('tts-player').hidden);
      const state = await page.evaluate(() => {
        const download = document.getElementById('tts-download');
        return { player: new URL(document.getElementById('tts-player').src).pathname, href: download.getAttribute('href'),
          download: download.download, target: download.target, hidden: download.hidden };
      });
      assert.deepEqual(state, { player: audioUrl, href: audioUrl, download: '2026-03-03_audio-daneben.mp3', target: '', hidden: false });
      await page.evaluate(() => document.getElementById('tts-player').play());
      await page.waitForFunction(() => !document.getElementById('tts-player').paused);
      await page.click('#tts-close');
      await page.waitForFunction(() => !document.getElementById('tts-overlay').open);
      assert.equal(await page.evaluate(() => document.getElementById('tts-player').paused), true, 'Schließen hält die Wiedergabe an');
    } finally {
      await page.unroute('**/api/tts/latest');
      await page.unroute('**/api/tts/smoke-job/status');
    }
  });

  run('Hörbuch öffnen und abspielen', async () => {
    await showList({ author: 'Hörbücher' });
    await page.locator(card('Hörbücher/Testbuch Normal')).click();
    await page.locator('#book-player [data-book="toggle"]').waitFor();
    await page.click('#book-player [data-book="toggle"]');
    await page.waitForFunction(() => document.querySelector('#book-player [data-book="toggle"]').getAttribute('aria-label') === 'Pause'
      || document.querySelector('#book-player [data-book-ui="time"]').textContent.includes('0:01'));
    await page.keyboard.press('Escape');
  });
});
