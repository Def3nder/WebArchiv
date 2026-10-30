'use strict';

// Verhaltenstests für public/layer-stack.js mit einem minimalen DOM-Nachbau
// (Ereignisweg Capture → Ziel → Bubble, Fokus, modale Dialoge).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLayerStack } = require('../public/layer-stack.js');

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

class Node {
  constructor(tag = 'div', doc = null) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = [];
    this.doc = doc;
  }
  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(node, next) {
    node.remove();
    node.parentNode = this;
    const index = next ? this.children.indexOf(next) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.tagName === '#DOCUMENT';
  }
  focus() { this.root().activeElement = this; }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.tagName === selector.toUpperCase()) return node;
    return null;
  }
  root() { let node = this; while (node.parentNode) node = node.parentNode; return node; }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    for (const node of event.bubbles ? path : [this]) {
      for (const listener of node.listeners.filter(l => l.type === event.type)) listener.fn(event);
      if (event.stopped) break;
    }
    return !event.defaultPrevented;
  }
  key(key, init = {}) {
    const event = new FakeEvent('keydown', { key, ...init });
    this.dispatchEvent(event);
    return event;
  }
}

class Dialog extends Node {
  constructor(id) {
    super('dialog');
    this.id = id;
    this.open = false;
    this.modalCalls = 0;
  }
  showModal() { this.open = true; this.modalCalls++; }
  // Wie im Browser: „close“ kommt verzögert; Tests lösen es bei Bedarf selbst aus.
  close() { this.open = false; }
}

function setup() {
  const doc = new Node('#document');
  doc.body = new Node('body');
  doc.append(doc.body);
  doc.activeElement = doc.body;
  const layers = createLayerStack(doc);
  const dialog = id => {
    const node = new Dialog(id);
    doc.body.append(node);
    return node;
  };
  const button = (parent = doc.body) => {
    const node = new Node('button');
    parent.append(node);
    return node;
  };
  return { doc, layers, dialog, button };
}

test('Stapel: oberste Ebene, Escape schließt genau eine und gibt den Fokus zurück', () => {
  const { doc, layers, dialog, button } = setup();
  const trigger = button();
  trigger.focus();
  const article = dialog('article');
  layers.open(article);
  const inner = button(article);
  inner.focus();
  const image = dialog('image');
  layers.open(image);
  assert.equal(layers.top().name, 'image');
  assert.equal(layers.count, 2);
  assert.equal(image.modalCalls, 1);

  const first = image.key('Escape');
  assert.equal(first.defaultPrevented, true, 'sonst schließt der Browser zusätzlich den nächsten Dialog');
  assert.equal(image.open, false);
  assert.equal(article.open, true);
  assert.equal(doc.activeElement, inner);

  article.key('Escape');
  assert.equal(article.open, false);
  assert.equal(layers.top(), null);
  assert.equal(doc.activeElement, trigger);
});

test('onEscape entscheidet selbst (z. B. Rückfrage oder history.back) statt sofort zu schließen', () => {
  const { layers, dialog } = setup();
  const editor = dialog('editor');
  let asked = 0;
  layers.open(editor, { onEscape: () => { asked++; } });
  editor.key('Escape');
  assert.equal(asked, 1);
  assert.equal(editor.open, true, 'bleibt offen, bis die Ebene selbst schließt');
  layers.close(editor);
  assert.equal(editor.open, false);
  assert.equal(layers.count, 0);
});

test('Element zuerst: behandelte Tasten erreichen weder Ebene noch Grundansicht', () => {
  const { layers, dialog, button } = setup();
  const manager = dialog('manager');
  layers.open(manager);
  const renameInput = button(manager);
  renameInput.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault(); });
  renameInput.key('Escape');
  assert.equal(manager.open, true, 'preventDefault des Eingabefelds');

  const editorText = button(manager);
  editorText.addEventListener('keydown', event => event.stopPropagation());
  editorText.key('Escape');
  assert.equal(manager.open, true, 'stopPropagation des Editors');
});

test('Grundansicht erhält Tasten nur ohne offene Ebene; onKey der obersten Ebene zuerst', () => {
  const { layers, dialog, button } = setup();
  const baseKeys = [];
  layers.setBase(event => baseKeys.push(event.key));
  const tile = button();
  tile.key('ArrowRight');
  assert.deepEqual(baseKeys, ['ArrowRight']);

  const article = dialog('article');
  const ownKeys = [];
  layers.open(article, { onKey: event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { ownKeys.push(event.key); return true; }
    return false;
  } });
  article.key('ArrowRight');
  article.key('ArrowUp');
  assert.deepEqual(ownKeys, ['ArrowRight']);
  assert.deepEqual(baseKeys, ['ArrowRight'], 'nichts reicht durch zur Kachelansicht');

  // onKey kann auch Escape übernehmen (z. B. stufenweises Schließen einer Vorschau).
  const manager = dialog('manager');
  let preview = true;
  layers.open(manager, { onKey: event => {
    if (event.key === 'Escape' && preview) { preview = false; return true; }
    return false;
  } });
  manager.key('Escape');
  assert.equal(manager.open, true);
  manager.key('Escape');
  assert.equal(manager.open, false);
});

test('cancel (Escape, Android-Zurück-Geste) läuft über dieselbe Schließlogik; cancel aus Dateifeldern nicht', () => {
  const { layers, dialog, button } = setup();
  const reader = dialog('reader');
  let escapes = 0;
  layers.open(reader, { onEscape: () => { escapes++; layers.close(reader); } });
  const fileInput = button(reader);
  const fromInput = new FakeEvent('cancel');
  fileInput.dispatchEvent(fromInput);
  assert.equal(escapes, 0);
  assert.equal(fromInput.defaultPrevented, false);

  const fromDialog = new FakeEvent('cancel', { bubbles: false });
  reader.dispatchEvent(fromDialog);
  assert.equal(fromDialog.defaultPrevented, true, 'kein natives Schließen am App-Code vorbei');
  assert.equal(escapes, 1);
  assert.equal(reader.open, false);
});

test('Direkt geschlossene oder entfernte Dialoge verschwinden aus dem Stapel', () => {
  const { layers, dialog, button } = setup();
  const trigger = button();
  trigger.focus();
  const settings = dialog('settings');
  layers.open(settings);
  settings.close();
  settings.dispatchEvent(new FakeEvent('close', { bubbles: false }));
  assert.equal(layers.count, 0);

  // Verspätetes „close“ eines inzwischen wieder geöffneten Dialogs zählt nicht.
  layers.open(settings);
  settings.close();
  layers.open(settings);
  settings.dispatchEvent(new FakeEvent('close', { bubbles: false }));
  assert.equal(layers.isOpen(settings), true);

  const extras = dialog('extras');
  layers.open(extras);
  extras.remove();
  assert.equal(layers.top().name, 'settings');
});

test('Schwebende Elemente wandern in die oberste passende Ebene und zurück an ihren Platz', () => {
  const { doc, layers, dialog } = setup();
  const miniPlayer = new Node('div');
  const after = new Node('div');
  doc.body.append(miniPlayer, after);
  layers.float(miniPlayer, { when: layer => layer.name === 'reader' || layer.name === 'extras' });
  const changes = [];
  layers.onChange(state => changes.push(state.count));

  const article = dialog('article');
  layers.open(article);
  assert.equal(miniPlayer.parentNode, doc.body, 'über dem Artikel bleibt er wie bisher darunter');
  const extras = dialog('extras');
  layers.open(extras);
  assert.equal(miniPlayer.parentNode, extras);
  const reader = dialog('reader');
  layers.open(reader);
  assert.equal(miniPlayer.parentNode, reader);
  const image = dialog('image');
  layers.open(image);
  assert.equal(miniPlayer.parentNode, reader, 'unter der Bildvollansicht bleibt er im Reader');
  assert.equal(layers.host(), image);

  layers.close(image);
  layers.close(reader);
  assert.equal(miniPlayer.parentNode, extras);
  layers.close(extras);
  assert.equal(miniPlayer.parentNode, doc.body);
  assert.equal(miniPlayer.nextSibling, after, 'zurück an die ursprüngliche Stelle');
  layers.close(article);
  assert.equal(layers.host(), doc.body);
  assert.deepEqual(changes, [1, 2, 3, 4, 3, 2, 1, 0]);
});

test('Tasten aus einem nicht angemeldeten Dialog erreichen weder die Ebene darunter noch die Grundansicht', () => {
  const { layers, dialog, button } = setup();
  const baseKeys = [];
  layers.setBase(event => baseKeys.push(event.key));
  // Noch nicht umgestellter Dialog ohne Ebene darunter (z. B. Einstellungen über den Kacheln).
  const settings = dialog('settings');
  settings.showModal();
  button(settings).key('ArrowRight');
  assert.deepEqual(baseKeys, []);

  // Über dem Artikel: Escape im Anbieterdialog darf nicht den Artikel schließen.
  const article = dialog('article');
  layers.open(article);
  const provider = dialog('provider');
  provider.showModal();
  const escape = button(provider).key('Escape');
  assert.equal(article.open, true);
  assert.equal(escape.defaultPrevented, false, 'der Dialog schließt sich selbst (natives cancel)');
});

test('Zweites open derselben Ebene ändert nichts; close ohne Fokus-Rückgabe', () => {
  const { doc, layers, dialog, button } = setup();
  const trigger = button();
  trigger.focus();
  const extras = dialog('extras');
  const first = layers.open(extras);
  assert.equal(layers.open(extras), first);
  assert.equal(extras.modalCalls, 1);
  const other = button();
  other.focus();
  first.close({ restoreFocus: false });
  assert.equal(doc.activeElement, other, 'z. B. wenn gleich die Extras-Verwaltung übernimmt');
});

test('Wischen ohne Scrollbereich in der obersten Ebene erreicht die Seite nicht; Scrollbereiche, Zoom und Regler bleiben frei', () => {
  const { doc, layers, dialog } = setup();
  const styles = new Map();
  doc.defaultView = { getComputedStyle: node => styles.get(node) || {}, visualViewport: { scale: 1 } };
  const swipe = (target, touches = 1) => {
    doc.body.dispatchEvent(Object.assign(new FakeEvent('touchstart'), {}));
    const event = new FakeEvent('touchmove', { touches: Array(touches).fill({}), cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const page = new Node('div');
  doc.body.append(page);
  assert.equal(swipe(page), false, 'ohne Ebene scrollt die Seite normal');

  const password = dialog('password');
  layers.open(password);
  const field = new Node('input');
  password.append(field);
  assert.equal(swipe(field), true, 'kleines Fenster: Wischen ginge sonst an die Seite');
  assert.equal(swipe(field, 2), false, 'zwei Finger: Zoomen bleibt möglich');
  doc.defaultView.visualViewport.scale = 2;
  assert.equal(swipe(field), false, 'vergrößert: Ausschnitt verschieben bleibt möglich');
  doc.defaultView.visualViewport.scale = 1;
  const slider = new Node('input');
  slider.type = 'range';
  password.append(slider);
  assert.equal(swipe(slider), false);

  const list = new Node('div');
  Object.assign(list, { scrollHeight: 900, clientHeight: 300 });
  styles.set(list, { overflowY: 'auto' });
  const row = new Node('div');
  list.append(row);
  password.append(list);
  assert.equal(swipe(row), false, 'echter Scrollbereich: overscroll-behavior regelt das Ende');
  Object.assign(list, { scrollHeight: 300 });
  assert.equal(swipe(row), true, 'Scrollbereich ohne Überlauf zählt nicht');
});
