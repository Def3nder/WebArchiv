'use strict';

// Browser-Test der Handy-Ansicht (Review 3.5): Chromium mit Pixel-7-Profil (Touch, schmale Ansicht) auf dem Testarchiv.
// Echte Wischgesten über das DevTools-Protokoll (Input.dispatchTouchEvent): sie laufen durch denselben Weg wie ein
// Finger. Ob ein Wischen die Seite erreicht hätte, zeigt ein Listener auf window: Er sieht, ob die Ebenen-Verwaltung
// (public/layer-stack.js) das touchmove gesperrt hat. Grenze: Chromium ist nicht Safari auf dem iPhone – iOS-eigene
// Effekte (automatisches Vergrößern, Gummiband) prüft das nicht, nur unsere Logik dafür.
/* global document, window, location, getComputedStyle, WebArchivLayers -- in page.evaluate(), läuft im Browser */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const { USERS } = require('../fixtures/smoke-archive.cjs');
const { startFixtureArchive } = require('../support/fixture-server.cjs');

const B09 = 'Joe Turan/2026/2026-04-01_gruppe';

describe('Handy-Ansicht (Chromium, Pixel 7, Touch)', () => {
  let dir;
  let server;
  let passwords;
  let browser;
  let context;
  let page;
  let cdp;
  let skip = null;
  const errors = [];

  before(async () => {
    try {
      browser = await chromium.launch();
    } catch (error) {
      skip = `Chromium fehlt (npx playwright install chromium): ${error.message.split('\n')[0]}`;
      return;
    }
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'webarchiv-mobile-'));
    ({ server, passwords } = await startFixtureArchive(dir));
    context = await browser.newContext({ ...devices['Pixel 7'], baseURL: server.base });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  });

  after(async () => {
    await browser?.close();
    await server?.stop();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const closeLayers = async () => {
    for (let i = 0; i < 5 && await page.evaluate(() => typeof WebArchivLayers !== 'undefined' && !!WebArchivLayers.top()); i++) {
      await page.keyboard.press('Escape');
    }
  };
  const run = (name, fn) => it(name, async t => {
    if (skip) return t.skip(skip);
    await closeLayers();
    await fn();
    assert.deepEqual(errors.splice(0), [], 'Konsolenfehler oder CSP-Verstöße');
  });

  // Finger von (x1, y1) nach (x2, y2) in Schritten; Pausen, damit die Seite jede Bewegung verarbeitet.
  async function swipe(x1, y1, x2, y2, steps = 8) {
    const point = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x1, y1) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: point(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps),
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  // Wischen beobachten: Hat die Ebenen-Verwaltung jede Bewegung gesperrt, und hat sich die Seite verschoben?
  // Nach dem Öffnen kann sich die Scrollposition noch setzen (Playwright scrollt den Menüknopf ins Bild).
  async function waitScrollStable() {
    let last = null;
    for (let i = 0; i < 20; i++) {
      const now = await page.evaluate(() => window.scrollY);
      if (now === last) return;
      last = now;
      await page.waitForTimeout(100);
    }
  }
  async function watchSwipe(x1, y1, x2, y2) {
    await waitScrollStable();
    await page.evaluate(() => {
      window.__moves = [];
      window.__swipeListener ||= event => window.__moves.push(event.defaultPrevented);
      window.addEventListener('touchmove', window.__swipeListener, { passive: true });
    });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await swipe(x1, y1, x2, y2);
    return page.evaluate(start => ({
      moves: window.__moves.length,
      allBlocked: window.__moves.length > 0 && window.__moves.every(Boolean),
      pageMoved: window.scrollY !== start,
    }), scrollBefore);
  }
  const fontSize = selector => page.evaluate(sel => getComputedStyle(document.querySelector(sel)).fontSize, selector);
  const waitOpen = (id, open = true) => page.waitForFunction(([dialogId, state]) => document.getElementById(dialogId).open === state, [id, open]);
  const adminAction = async action => {
    await page.tap('#reindex-btn');
    await page.tap(`#admin-menu [data-action="${action}"]`);
  };

  run('Eingabefelder 16 px, Filter behalten ihre Größe, keine waagrechte Verschiebung', async () => {
    await page.goto('/');
    await page.locator('.card').first().waitFor();
    assert.equal(await fontSize('#search-input'), '16px', 'Suchfeld: sonst vergrößert iOS beim Antippen');
    assert.equal(await fontSize('#login-email'), '16px');
    assert.notEqual(await fontSize('#filter-author'), '16px', 'Filter bleiben klein (sonst passt die Zeile nicht)');
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
    assert.ok(widths.page <= widths.view, `Seite ${widths.page} px breiter als die Ansicht ${widths.view} px`);
  });

  run('Kennwort-Dialog: Wischen unter dem Dialog und im Dialog erreicht die Seite nicht', async () => {
    await page.evaluate(async ({ email, password }) => {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(`Anmeldung ${res.status}`);
    }, { email: USERS.admin.email, password: passwords.admin });
    await page.reload();
    await page.locator('#reindex-btn').waitFor({ state: 'visible' });
    await page.evaluate(() => window.scrollTo(0, 300));
    await adminAction('password');
    await waitOpen('password-dialog');
    assert.equal(await fontSize('#password-current'), '16px');
    // Nach oben wischen (das schöbe die Seite nach unten); nach unten zu ziehen schließt den Dialog absichtlich.
    const box = await page.locator('#password-dialog').boundingBox();
    const centerX = box.x + box.width / 2;
    const below = box.y + box.height + (839 - box.y - box.height) / 2;
    const outside = await watchSwipe(centerX, below, centerX, below - 150);
    assert.ok(outside.moves > 0 && outside.allBlocked && !outside.pageMoved, `unter dem Dialog: ${JSON.stringify(outside)}`);
    const inside = await watchSwipe(centerX, box.y + box.height - 30, centerX, box.y + 30);
    assert.ok(inside.moves > 0 && inside.allBlocked && !inside.pageMoved, `im kleinen Dialog (nichts zu scrollen): ${JSON.stringify(inside)}`);
    assert.equal(await page.evaluate(() => document.getElementById('password-dialog').open), true, 'Dialog bleibt offen');
    await page.keyboard.press('Escape');
    await waitOpen('password-dialog', false);
  });

  run('Benutzerverwaltung (fast bildschirmbreit): Wischen im schmalen Rand daneben ist gesperrt', async () => {
    await adminAction('users');
    await waitOpen('user-admin');
    const box = await page.locator('#user-admin').boundingBox();
    assert.ok(box.x >= 4, `Rand neben dem Dialog: ${box.x} px`);
    const beside = await watchSwipe(box.x / 2, box.y + 300, box.x / 2, box.y + 100);
    assert.ok(beside.moves > 0 && beside.allBlocked && !beside.pageMoved, `daneben: ${JSON.stringify(beside)}`);
    assert.equal(await page.evaluate(() => document.getElementById('user-admin').open), true, 'Dialog bleibt offen');
    await page.keyboard.press('Escape');
    await waitOpen('user-admin', false);
  });

  run('Einstellungen bei niedriger Ansicht (Dialog scrollt selbst): daneben gesperrt, im Dialog scrollt er', async () => {
    // Erst öffnen, dann die Ansicht verkleinern: Bei 420 px Höhe läge der Menüeintrag außerhalb.
    await adminAction('settings');
    await waitOpen('settings-dialog');
    await page.setViewportSize({ width: 412, height: 420 });
    try {
      const dialog = page.locator('#settings-dialog');
      assert.ok(await dialog.evaluate(node => node.scrollHeight > node.clientHeight + 1), 'Dialog muss selbst scrollen');
      const box = await dialog.boundingBox();
      // Ziel ist auf dem Hintergrund der Dialog selbst; weil er scrollen kann, ging das Wischen früher an die Seite.
      const beside = await watchSwipe(box.x / 2, box.y + box.height - 40, box.x / 2, box.y + 40);
      assert.ok(beside.moves > 0 && beside.allBlocked && !beside.pageMoved, `daneben: ${JSON.stringify(beside)}`);
      const inside = await watchSwipe(box.x + box.width / 2, box.y + box.height - 40, box.x + box.width / 2, box.y + 60);
      assert.ok(inside.moves > 0 && !inside.allBlocked, `im Dialog bleibt Scrollen erlaubt: ${JSON.stringify(inside)}`);
      await page.waitForFunction(() => document.getElementById('settings-dialog').scrollTop > 0);
      await page.keyboard.press('Escape');
      await waitOpen('settings-dialog', false);
    } finally {
      await page.setViewportSize(devices['Pixel 7'].viewport);
    }
  });

  run('Nach unten ziehen schließt Health-Check und Artikelansicht', async () => {
    await adminAction('health');
    await waitOpen('health-dialog');
    await page.waitForFunction(() => !document.getElementById('health-level').hidden);
    const health = await page.locator('#health-title').boundingBox();
    await swipe(health.x + 20, health.y + 5, health.x + 20, health.y + 260);
    await waitOpen('health-dialog', false);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.fill('#search-input', 'Beziehung und Partnerschaft');
    await page.locator(`.card[data-id="${B09}"]`).tap();
    await page.waitForFunction(id => document.getElementById('article-overlay').open
      && decodeURIComponent(location.hash).includes(id), B09);
    await page.locator('#article-overlay .author-badge').first().waitFor();
    const title = await page.locator('#article-overlay .overlay-panel').boundingBox();
    // Aus dem Textbereich unter der Galerie ziehen (die Galerie wischt seitwärts).
    await swipe(title.x + title.width / 2, title.y + title.height * 0.55, title.x + title.width / 2, title.y + title.height * 0.55 + 260);
    await waitOpen('article-overlay', false);
    await page.fill('#search-input', '');
  });

  run('Scraper-Zentrale auf dem Handy: Karten einspaltig, nichts ragt heraus, Formular einspaltig', async () => {
    await adminAction('scraper-center');
    await waitOpen('scraper-center');
    await page.waitForFunction(() => document.querySelectorAll('#scraper-center .scraper-source').length > 0);
    const layout = await page.evaluate(() => {
      const dialog = document.getElementById('scraper-center');
      const facts = getComputedStyle(document.querySelector('#scraper-center .scraper-facts')).gridTemplateColumns.split(' ').length;
      return { overflow: dialog.scrollWidth - dialog.clientWidth, facts, page: document.documentElement.scrollWidth - window.innerWidth };
    });
    assert.deepEqual(layout, { overflow: 0, facts: 1, page: 0 });
    await page.tap('#scraper-add');
    const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.scraper-form-grid')).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1);
    assert.equal(await fontSize('#scraper-form-name'), '16px', 'kein Auto-Zoom auf dem iPhone');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('scraper-form').hidden, null);
    await page.keyboard.press('Escape');
    await waitOpen('scraper-center', false);
  });

  // Zwei Finger von (x ± from) nach (x ± to) auf gleicher Höhe.
  async function pinch(x, y, from, to, steps = 8) {
    const points = d => [{ x: x - d, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }, { x: x + d, y, id: 2, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + ((to - from) * i) / steps) });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  const tap = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };

  run('Bild-Extra eines Hörbuchs: Doppeltippen und Pinch zoomen, ein Finger verschiebt, Tippen schließt', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => {
      const select = document.getElementById('filter-author');
      select.value = 'Hörbücher';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('.card[data-id="Hörbücher/Mit Extras"]').tap();
    await page.locator('[data-book-extras]').tap();
    await page.locator('#book-extras .book-extra-card img').tap();
    await waitOpen('img-fullscreen');
    await page.waitForFunction(() => document.getElementById('img-fullscreen-img').complete);
    const zoom = () => page.evaluate(() => {
      const img = document.getElementById('img-fullscreen-img');
      const m = img.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/);
      return m ? { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) } : { x: 0, y: 0, scale: 1 };
    });
    const box = await page.locator('#img-fullscreen-img').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('img-fullscreen')).touchAction), 'pan-y',
      'Seiten-Zoom des Browsers aus, Zoomen übernimmt die Vollansicht');

    // Doppeltippen links neben der Mitte: vergrößert dort, die Ansicht bleibt offen.
    await tap(cx - 60, cy);
    await page.waitForTimeout(80);
    await tap(cx - 60, cy);
    await page.waitForTimeout(400);
    let state = await zoom();
    assert.equal(state.scale, 2, JSON.stringify(state));
    assert.ok(state.x > 0, `Stelle unter dem Finger bleibt: ${JSON.stringify(state)}`);
    assert.equal(await page.evaluate(() => document.getElementById('img-fullscreen').open), true, 'Doppeltippen schließt nicht');

    // Ein Finger verschiebt (nicht blättern, nicht schließen), höchstens bis zum Bildrand.
    await swipe(cx, cy, cx - 400, cy);
    state = await zoom();
    assert.ok(Math.abs(state.x + box.width / 2) < 1, `bis zum rechten Bildrand: ${JSON.stringify(state)}`);
    assert.equal(await page.evaluate(() => document.getElementById('img-fullscreen').open), true);

    // Doppeltippen zurück, dann stufenlos mit zwei Fingern.
    await tap(cx, cy);
    await page.waitForTimeout(80);
    await tap(cx, cy);
    await page.waitForTimeout(400);
    assert.equal((await zoom()).scale, 1);
    await pinch(cx, cy, 40, 100);
    state = await zoom();
    assert.ok(state.scale > 2.2 && state.scale < 2.8, `Pinch ×2,5: ${JSON.stringify(state)}`);
    await pinch(cx, cy, 100, 20);
    assert.equal((await zoom()).scale, 1, 'Zusammenziehen geht zurück auf 1');

    // Einfaches Tippen schließt (nach der Wartezeit fürs Doppeltippen).
    await tap(cx, cy);
    await waitOpen('img-fullscreen', false);
    await page.keyboard.press('Escape');
  });

  run('iPhone-Kennung: Viewport mit maximum-scale=1 (kein Auto-Zoom), Android ohne', async () => {
    const meta = target => target.evaluate(() => document.querySelector('meta[name="viewport"]').content);
    assert.doesNotMatch(await meta(page), /maximum-scale/, 'Android: Pinch-Zoom bleibt frei');
    const iphone = await browser.newContext({ ...devices['iPhone 15'], baseURL: server.base });
    try {
      const iphonePage = await iphone.newPage();
      await iphonePage.goto('/');
      assert.match(await meta(iphonePage), /maximum-scale=1/);
    } finally {
      await iphone.close();
    }
  });
});
