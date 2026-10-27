'use strict';

// Verhaltenstests für public/aria-menu.js mit einem minimalen DOM-Nachbau
// (Ereignisweg Capture → Ziel → Bubble, Fokus, hidden, Attribute).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, detail: 1 }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
    this.immediateStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }
}

class Node {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.style = { transform: '' };
    this.listeners = [];
    this.dataset = {};
    this.textContent = '';
    this.rect = { left: 10, right: 110 };
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'hidden') this.hidden = !!value;
      else if (name === 'disabled') this.disabled = !!value;
      else this.setAttribute(name, value);
    }
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } return this; }
  replaceChildren(...nodes) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  get isConnected() { let node = this; while (node.parent) node = node.parent; return node === document; }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  matches(selector) {
    return selector.split(',').map(part => part.trim()).some(part => {
      const match = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!match) return false;
      return match[2] === undefined ? this.hasAttribute(match[1]) : this.getAttribute(match[1]) === match[2];
    });
  }
  closest(selector) { for (let node = this; node && node !== document; node = node.parent) if (node.matches?.(selector)) return node; return null; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return this.rect; }
  focus() { document.activeElement = this; }
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true || capture?.capture === true }); }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this; node; node = node.parent) path.unshift(node);
    const run = (node, capture) => {
      for (const listener of node.listeners.filter(l => l.type === event.type && l.capture === capture)) {
        listener.fn(event);
        if (event.immediateStopped) return false;
      }
      return !event.stopped;
    };
    for (const node of path.slice(0, -1)) if (!run(node, true)) return;
    if (!run(this, true) || !run(this, false)) return;
    if (!event.bubbles) return;
    for (const node of path.slice(0, -1).reverse()) if (!run(node, false)) return;
  }
  click(detail = 1) { this.dispatchEvent(new FakeEvent('click', { detail })); }
  key(key) { const event = new FakeEvent('keydown', { key }); this.dispatchEvent(event); return event; }
}

const document = new Node('#document');
document.body = new Node('body');
document.append(document.body);
document.activeElement = document.body;
document.createElement = tag => new Node(tag);
const originalGlobals = {
  document: globalThis.document, window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame, Event: globalThis.Event,
};
Object.assign(globalThis, {
  document,
  window: { innerWidth: 400 },
  requestAnimationFrame: fn => fn(),
  Event: FakeEvent,
});
// Die Suite läuft ohne Isolation: Globals für die übrigen Testdateien zurücksetzen.
after(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

const { create, bindSelect, keepInViewport } = require('../public/aria-menu.js');

function fixture({ items = ['Eins', 'Zwei', 'Drei'], ...options } = {}) {
  const root = new Node('div');
  const trigger = new Node('button', { 'aria-haspopup': 'menu' });
  const menu = new Node('div', { role: 'menu', hidden: true });
  const buttons = items.map((label, index) => {
    const item = new Node('button', { role: 'menuitem', 'data-index': index });
    item.textContent = label;
    return item;
  });
  menu.append(...buttons);
  root.append(trigger, menu);
  document.body.append(root);
  const controller = create({ trigger, menu, ...options });
  return { root, trigger, menu, buttons, controller, cleanup: () => { controller.close(); root.remove(); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Auslöser öffnet und schließt, aria-expanded folgt, Klick außerhalb schließt', async () => {
  const f = fixture();
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  f.trigger.click();
  await tick();
  assert.equal(f.menu.hidden, false);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
  f.trigger.click();
  assert.equal(f.menu.hidden, true);
  f.trigger.click();
  await tick();
  document.body.click();
  assert.equal(f.menu.hidden, true);
  assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');
  f.cleanup();
});

test('Es ist immer nur ein Menü offen', async () => {
  const a = fixture();
  const b = fixture();
  a.trigger.click();
  await tick();
  b.trigger.click();
  await tick();
  assert.equal(a.menu.hidden, true);
  assert.equal(b.menu.hidden, false);
  a.cleanup();
  b.cleanup();
});

test('Escape schließt nur das Menü, nicht den Dialog darunter, und gibt den Fokus zurück', async () => {
  let dialogClosed = 0;
  // Wie duplicates.js: späterer Capture-Handler am Dokument für den Dialog.
  document.addEventListener('keydown', event => { if (event.key === 'Escape') dialogClosed++; }, true);
  const f = fixture();
  f.trigger.click();
  await tick();
  const event = f.buttons[1].key('Escape');
  assert.equal(f.menu.hidden, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(dialogClosed, 0);
  assert.equal(document.activeElement, f.trigger);
  // Ohne offenes Menü erreicht Escape den Dialog wie bisher.
  f.trigger.key('Escape');
  assert.equal(dialogClosed, 1);
  f.cleanup();
});

test('Tastatur: Pfeile öffnen und wandern zyklisch, Pos1/Ende, gesperrte Einträge übersprungen, Tab schließt', async () => {
  const f = fixture({ items: ['Eins', 'Zwei', 'Drei', 'Vier'] });
  f.buttons[2].disabled = true;
  f.buttons[1].setAttribute('aria-checked', 'true');
  f.trigger.key('ArrowDown');
  await tick();
  assert.equal(f.menu.hidden, false);
  assert.equal(document.activeElement, f.buttons[1], 'markierter Eintrag erhält den Fokus');
  f.buttons[1].key('ArrowDown');
  assert.equal(document.activeElement, f.buttons[3], 'gesperrter Eintrag wird übersprungen');
  f.buttons[3].key('ArrowDown');
  assert.equal(document.activeElement, f.buttons[0], 'zyklisch zurück zum Anfang');
  f.buttons[0].key('ArrowUp');
  assert.equal(document.activeElement, f.buttons[3]);
  f.buttons[3].key('Home');
  assert.equal(document.activeElement, f.buttons[0]);
  f.buttons[0].key('End');
  assert.equal(document.activeElement, f.buttons[3]);
  f.buttons[3].key('Tab');
  assert.equal(f.menu.hidden, true);
  assert.equal(document.activeElement, f.buttons[3], 'Tab gibt den Fokus nicht zurück');
  f.cleanup();
});

test('Per Tastatur ausgelöster Klick (detail 0) fokussiert den ersten Eintrag', async () => {
  const f = fixture();
  f.trigger.click(0);
  await tick();
  assert.equal(document.activeElement, f.buttons[0]);
  f.cleanup();
});

test('Auswahl: Menü schließt vor der Aktion, Fokus beim Auslöser, delegierte Handler laufen weiter', async () => {
  const seen = [];
  let delegated = 0;
  document.addEventListener('click', event => { if (event.target.closest?.('[data-index]')) delegated++; });
  const f = fixture({
    onSelect: item => seen.push({ index: item.dataset.index, hidden: f.menu.hidden, focus: document.activeElement }),
  });
  f.trigger.click();
  await tick();
  f.buttons[2].click();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].index, '2');
  assert.equal(seen[0].hidden, true, 'Menü ist bei der Aktion schon geschlossen');
  assert.equal(seen[0].focus, f.trigger, 'Fokus liegt vor der Aktion beim Auslöser');
  assert.equal(delegated, 1, 'kein stopPropagation');
  f.trigger.click();
  await tick();
  f.buttons[0].disabled = true;
  f.buttons[0].click();
  assert.equal(seen.length, 1, 'gesperrte Einträge lösen nichts aus');
  f.cleanup();
});

test('keepOpen hält das Menü bei Mehrfachauswahl offen', async () => {
  const chosen = [];
  const f = fixture({ keepOpen: item => item.dataset.index !== '2', onSelect: item => chosen.push(item.dataset.index) });
  f.trigger.click();
  await tick();
  f.buttons[0].click();
  f.buttons[1].click();
  assert.equal(f.menu.hidden, false);
  f.buttons[2].click();
  assert.equal(f.menu.hidden, true);
  assert.deepEqual(chosen, ['0', '1', '2']);
  f.cleanup();
});

test('onBeforeOpen wird abgewartet; ein inzwischen geschlossenes Menü öffnet sich nicht erneut', async () => {
  let resolveLoad;
  const f = fixture({ onBeforeOpen: () => new Promise(resolve => { resolveLoad = resolve; }) });
  f.trigger.click(0);
  f.controller.close();
  resolveLoad();
  await tick();
  assert.equal(f.menu.hidden, true);
  assert.notEqual(document.activeElement, f.buttons[0]);
  f.cleanup();
});

test('Neu gerenderte Bereiche: abgehängte Menüs fangen kein Escape mehr ab', async () => {
  let reached = 0;
  document.addEventListener('keydown', event => { if (event.key === 'Escape') reached++; }, true);
  const old = fixture();
  old.trigger.click();
  await tick();
  old.root.remove(); // z. B. Artikeldetail neu gerendert, Menü war noch offen
  const fresh = fixture();
  fresh.trigger.key('Escape');
  assert.equal(reached, 1);
  fresh.cleanup();
});

test('Menüs werden horizontal in den sichtbaren Bereich geschoben', () => {
  const menu = new Node('div');
  menu.rect = { left: 350, right: 450 };
  keepInViewport(menu);
  assert.equal(menu.style.transform, 'translateX(-58px)');
  menu.rect = { left: -20, right: 80 };
  keepInViewport(menu);
  assert.equal(menu.style.transform, 'translateX(28px)');
  menu.rect = { left: 20, right: 120 };
  keepInViewport(menu);
  assert.equal(menu.style.transform, '');
});

test('Select-Spiegel: sichtbare Optionen als menuitemradio, Auswahl setzt Wert und löst change aus', async () => {
  const select = new Node('select');
  const changes = [];
  select.addEventListener('change', () => changes.push(select.value));
  select.value = 'b';
  select.options = [
    Object.assign(new Node('option'), { value: 'a', textContent: 'Alpha' }),
    Object.assign(new Node('option'), { value: 'b', textContent: 'Beta' }),
    Object.assign(new Node('option'), { value: 'p', textContent: 'Privat', hidden: true }),
  ];
  const root = new Node('div');
  const trigger = new Node('button', { class: 'filter-menu-trigger' });
  trigger.matches = selector => selector === '.filter-menu-trigger' || Node.prototype.matches.call(trigger, selector);
  const value = new Node('span', { 'data-filter-menu-value': '' });
  trigger.append(value);
  const menu = new Node('div', { role: 'menu', hidden: true });
  root.append(trigger, menu);
  document.body.append(root);
  root.querySelector = selector => (selector === '.filter-menu-trigger' ? trigger : Node.prototype.querySelector.call(root, selector));
  const controller = bindSelect(select, root);
  assert.equal(value.textContent, 'Beta');
  assert.deepEqual(menu.children.map(item => [item.textContent, item.getAttribute('role'), item.getAttribute('aria-checked')]),
    [['Alpha', 'menuitemradio', 'false'], ['Beta', 'menuitemradio', 'true']]);
  trigger.click();
  await tick();
  menu.children[0].click();
  assert.equal(select.value, 'a');
  assert.deepEqual(changes, ['a']);
  assert.equal(menu.hidden, true);
  controller.close();
  root.remove();
});
