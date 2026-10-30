/* WebArchiv — Ebenen-Stapel für modale Dialoge
 *
 * Alle Ebenen über der Seite (Artikel, Bildvollansicht, eBook-Reader, Extras,
 * Admin-Fenster und die übrigen Dialoge) sind modale <dialog>. Der Stapel kennt
 * ihre Reihenfolge und regelt für alle gleich:
 *  - Tastatur in fester Reihenfolge: zuerst das Element selbst (Eingaben, Menüs,
 *    Editor; wer eine Taste behandelt, ruft preventDefault oder stopPropagation),
 *    dann die oberste Ebene (onKey, Escape), zuletzt die Grundansicht (setBase),
 *    aber nur, solange keine Ebene offen ist. Ein einziger Listener am Dokument in
 *    der Bubble-Phase: Die Ladereihenfolge der Skripte spielt keine Rolle mehr.
 *  - Escape und „cancel“ (Escape, Android-Zurück-Geste) rufen onEscape der
 *    obersten Ebene, sonst schließt sie sich. Ein behandeltes Escape wird mit
 *    preventDefault quittiert; ohne das schlösse der Browser mit demselben
 *    Tastendruck zusätzlich den nun obersten Dialog.
 *  - Fokus-Rückgabe an den Auslöser beim Schließen.
 *  - Wischen, das in der obersten Ebene nichts scrollen kann, erreicht die Seite nicht.
 *  - Schwebende Elemente (Miniplayer, Sprechblase): Alles außerhalb des obersten
 *    modalen Dialogs liegt darunter und ist nicht bedienbar. float() hängt ein
 *    Element in die oberste passende Ebene und beim Schließen zurück an seinen Platz.
 */
(function exposeLayerStack(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebArchivLayers = api.createLayerStack(root.document);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createLayerStackApi() {
  'use strict';

  function createLayerStack(doc) {
    const entries = [];
    const floating = [];
    const listeners = new Set();
    const wiredDialogs = new WeakSet();
    let base = null;

    const isLive = entry => entry.dialog.isConnected && entry.dialog.open;
    const entryFor = dialog => entries.find(entry => entry.dialog === dialog) || null;

    // Offen aus dem DOM entfernte oder anderweitig geschlossene Dialoge fallen heraus.
    function prune() {
      let changed = false;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!isLive(entries[i])) { entries.splice(i, 1); changed = true; }
      }
      if (changed) changedState();
    }

    function top() {
      prune();
      return entries.at(-1) || null;
    }

    function view(entry) {
      return entry ? { dialog: entry.dialog, name: entry.name } : null;
    }

    function rehome() {
      for (const item of floating) {
        const host = [...entries].reverse().find(entry => isLive(entry) && item.when(view(entry)));
        if (host) {
          if (item.element.parentNode !== host.dialog) host.dialog.append(item.element);
        } else if (item.element.parentNode !== item.home || !item.element.isConnected) {
          const next = item.next?.parentNode === item.home ? item.next : null;
          item.home.insertBefore(item.element, next);
        }
      }
    }

    function changedState() {
      rehome();
      const snapshot = { top: view(entries.at(-1)), count: entries.length };
      for (const listener of listeners) listener(snapshot);
    }

    function finish(entry, { restoreFocus = true } = {}) {
      const index = entries.indexOf(entry);
      if (index < 0) return;
      entries.splice(index, 1);
      changedState();
      const target = entry.returnFocus;
      if (restoreFocus && target?.isConnected && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    }

    function escape(entry) {
      if (entry.onEscape) entry.onEscape();
      else close(entry.dialog);
    }

    function wireDialog(dialog) {
      if (wiredDialogs.has(dialog)) return;
      wiredDialogs.add(dialog);
      // Auch das Abbrechen eines Datei-Eingabefelds sendet ein bubbelndes cancel;
      // nur das cancel des Dialogs selbst ist ein Schließwunsch.
      dialog.addEventListener('cancel', event => {
        if (event.target !== dialog) return;
        const entry = entryFor(dialog);
        if (!entry) return;
        event.preventDefault();
        escape(entry);
      });
      // Direkt per dialog.close() oder Formular geschlossen: aus dem Stapel nehmen.
      // „close“ kommt verzögert an; ist der Dialog bis dahin wieder offen, gilt es nicht.
      dialog.addEventListener('close', () => {
        const entry = entryFor(dialog);
        if (entry && !dialog.open) finish(entry);
      });
    }

    // options: name, onEscape(), onKey(event) → true = behandelt, returnFocus
    // (Element; Standard: das beim Öffnen fokussierte Element; false = keine Rückgabe).
    function open(dialog, options = {}) {
      const existing = entryFor(dialog);
      if (existing && isLive(existing)) return existing.handle;
      if (existing) entries.splice(entries.indexOf(existing), 1);
      wireDialog(dialog);
      const entry = {
        dialog,
        name: options.name || dialog.id || '',
        onEscape: options.onEscape || null,
        onKey: options.onKey || null,
        returnFocus: options.returnFocus === false ? null : (options.returnFocus || doc.activeElement || null),
      };
      entry.handle = { dialog, close: closeOptions => close(dialog, closeOptions) };
      if (!dialog.open) dialog.showModal();
      entries.push(entry);
      changedState();
      return entry.handle;
    }

    // restoreFocus: false, wenn gleich eine andere Ebene den Fokus übernimmt.
    function close(dialog, { restoreFocus = true } = {}) {
      const entry = entryFor(dialog);
      if (dialog.open) dialog.close();
      if (entry) finish(entry, { restoreFocus });
    }

    function onKeydown(event) {
      if (event.defaultPrevented) return;
      // Tasten aus einem (noch) nicht angemeldeten Dialog gehören diesem Dialog:
      // nicht die angemeldete Ebene darunter schließen, nicht in der Grundansicht blättern.
      const owner = event.target?.closest?.('dialog');
      if (owner && !entryFor(owner)) return;
      const entry = top();
      if (!entry) {
        base?.(event);
        return;
      }
      if (entry.onKey?.(event) === true || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        escape(entry);
      }
      // Alle übrigen Tasten bleiben bei der Ebene; die Grundansicht erhält nichts.
    }

    doc.addEventListener('keydown', onKeydown);

    // Kann eine Wischgeste in der obersten Ebene nichts scrollen (z. B. das kleine
    // Kennwortfenster), gäbe Safari sie an die Seite dahinter weiter: Weder
    // html.modal-open noch overscroll-behavior (wirkt nur an echten Scrollbereichen)
    // verhindern das. Entschieden wird einmal je Geste, bei der ersten Bewegung.
    function scrollsWithin(target, dialog) {
      const style = node => doc.defaultView?.getComputedStyle?.(node) || {};
      for (let node = target; node && node !== doc; node = node.parentNode) {
        const { overflowX = '', overflowY = '' } = style(node);
        if (/auto|scroll/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) return true;
        if (/auto|scroll/.test(overflowX) && node.scrollWidth > node.clientWidth + 1) return true;
        if (node === dialog) break;
      }
      return false;
    }

    let touchBlocked = null;
    function onTouchmove(event) {
      if (touchBlocked === null) {
        const entry = entries.length ? top() : null;
        touchBlocked = !!entry && event.touches?.length === 1
          // Vergrößert: Der Finger verschiebt den sichtbaren Ausschnitt.
          && !((doc.defaultView?.visualViewport?.scale ?? 1) > 1.01)
          && event.target?.type !== 'range'
          && !scrollsWithin(event.target, entry.dialog);
      }
      if (touchBlocked && event.cancelable !== false) event.preventDefault();
    }
    doc.addEventListener('touchstart', () => { touchBlocked = null; }, { passive: true });
    doc.addEventListener('touchmove', onTouchmove, { passive: false });

    return {
      open,
      close,
      top: () => view(top()),
      isOpen: dialog => { prune(); return !!entryFor(dialog); },
      get count() { prune(); return entries.length; },
      // Tastatur der Grundansicht (Kachel- und Artikelnavigation), nur ohne offene Ebene.
      setBase(handler) { base = handler; },
      // Wohin vorübergehend angezeigte Elemente gehören (z. B. eine Sprechblase).
      host: () => top()?.dialog || doc.body,
      // when({ dialog, name }) → true: Das Element gehört in diese Ebene (Standard: jede).
      float(element, { when = () => true } = {}) {
        floating.push({ element, when, home: element.parentNode, next: element.nextSibling });
        rehome();
      },
      onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  return { createLayerStack };
}));
