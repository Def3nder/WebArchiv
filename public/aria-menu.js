/* WebArchiv — gemeinsame ARIA-Menükomponente
 *
 * Ein Menü besteht aus einem Auslöser (Button mit aria-haspopup="menu") und einem
 * Popup (role="menu", hidden) mit Einträgen (role="menuitem", "menuitemradio"
 * oder "menuitemcheckbox"). Die Komponente übernimmt für alle Menüs gleich:
 * Öffnen/Schließen, aria-expanded, Pfeiltasten, Pos1/Ende, Tab, Escape (nur das
 * Menü, nicht den Dialog darunter), Klick außerhalb, Fokus-Rückgabe und das
 * Einpassen in den sichtbaren Fensterbereich. Es ist immer höchstens ein Menü offen.
 *
 * Fachliche Inhalte bleiben beim Aufrufer: onSelect(item, event) führt die Aktion
 * aus. Das Menü schließt sich vorher; nur bei Bedienung per Tastatur kehrt der Fokus
 * zum Auslöser zurück (damit ein von der Aktion geöffneter Dialog den Fokus behält),
 * nach einem Mausklick behält das Menü keinen Fokus. keepOpen(item)
 * hält das Menü stattdessen offen (Mehrfachauswahl, laufende Anfrage).
 */
(function exposeAriaMenu(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebArchivAriaMenu = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createAriaMenuApi() {
  'use strict';

  const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
  const VIEWPORT_MARGIN = 8;
  const menus = new Set();
  let documentWired = false;

  // Horizontal in den Viewport schieben; die Ausrichtung am Auslöser bestimmt das CSS.
  function keepInViewport(menu, margin = VIEWPORT_MARGIN) {
    menu.style.transform = '';
    const rect = menu.getBoundingClientRect();
    let shift = rect.left < margin ? margin - rect.left : 0;
    if (rect.right + shift > window.innerWidth - margin) {
      shift += window.innerWidth - margin - rect.right - shift;
    }
    if (shift) menu.style.transform = `translateX(${Math.round(shift)}px)`;
  }

  function enabledItems(menu) {
    return [...menu.querySelectorAll(ITEM_SELECTOR)].filter(item => !item.disabled && !item.hidden);
  }

  function moveFocus(menu, direction) {
    const items = enabledItems(menu);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    const next = direction === 'first' ? 0
      : direction === 'last' ? items.length - 1
        : (current + direction + items.length) % items.length;
    items[next].focus();
  }

  function openMenu() {
    return [...menus].find(controller => controller.isOpen) || null;
  }

  // Menüs in neu gerenderten Bereichen (z. B. Artikeldetail) ersetzen ihre
  // Vorgänger; nicht mehr eingehängte Menüs werden vergessen.
  function forgetDetachedMenus() {
    for (const controller of menus) {
      if (!controller.trigger.isConnected) menus.delete(controller);
    }
  }

  function wireDocument() {
    if (documentWired || typeof document === 'undefined') return;
    documentWired = true;
    document.addEventListener('click', event => {
      for (const controller of menus) {
        if (controller.isOpen && !controller.contains(event.target)) controller.close();
      }
    });
    // Capture-Phase: Escape schließt nur das Menü, nicht den Dialog darunter.
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const controller = openMenu();
      if (!controller) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      controller.close({ restoreFocus: true });
    }, true);
  }

  function create({
    trigger, menu, onSelect = null, keepOpen = null, onBeforeOpen = null, onOpen = null, onClose = null,
  }) {
    if (!trigger || !menu) return null;
    wireDocument();
    forgetDetachedMenus();
    let openRequest = 0;

    const controller = {
      trigger,
      menu,
      get isOpen() { return menu.isConnected && !menu.hidden; },
      contains(target) { return trigger.contains(target) || menu.contains(target); },
      async open({ focus = false } = {}) {
        for (const other of menus) if (other !== controller && other.isOpen) other.close();
        const request = ++openRequest;
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        if (onBeforeOpen) await onBeforeOpen();
        if (request !== openRequest || menu.hidden) return;
        onOpen?.();
        requestAnimationFrame(() => {
          if (menu.hidden) return;
          keepInViewport(menu);
          if (!focus) return;
          const items = enabledItems(menu);
          (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0])?.focus();
        });
      },
      close({ restoreFocus = false } = {}) {
        openRequest++;
        if (menu.hidden && trigger.getAttribute('aria-expanded') !== 'true') return;
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        onClose?.();
        if (restoreFocus && trigger.isConnected) trigger.focus();
      },
      toggle(options) {
        if (controller.isOpen) controller.close();
        else controller.open(options);
      },
      destroy() { controller.close(); menus.delete(controller); },
    };

    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      // detail === 0: per Tastatur (Enter/Leertaste) ausgelöst → erster Eintrag fokussieren.
      controller.toggle({ focus: event.detail === 0 });
    });
    trigger.addEventListener('keydown', event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      controller.open({ focus: true });
    });
    menu.addEventListener('click', event => {
      const item = event.target.closest(ITEM_SELECTOR);
      if (!item || item.disabled || !menu.contains(item)) return;
      // Kein stopPropagation: Einträge wie „Artikel editieren“ oder „Audio erzeugen“
      // werden zusätzlich über delegierte Klick-Handler am Dokument bedient.
      // Per Tastatur (detail 0) zurück zum Auslöser, per Maus behält das Menü keinen Fokus.
      if (!keepOpen?.(item)) {
        const byKeyboard = event.detail === 0;
        controller.close({ restoreFocus: byKeyboard });
        if (!byKeyboard && menu.contains(document.activeElement)) document.activeElement.blur?.();
      }
      onSelect?.(item, event);
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(menu, event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        moveFocus(menu, event.key === 'Home' ? 'first' : 'last');
      } else if (event.key === 'Tab') {
        controller.close();
      }
    });

    menus.add(controller);
    return controller;
  }

  // Desktop-Menü als Spiegel eines nativen <select> (Touch-Geräte nutzen das Select
  // selbst). Beide Varianten teilen denselben Wert; Auswahl löst „change“ aus.
  const selectMenus = new Map();

  function syncSelect(select) {
    const entry = selectMenus.get(select);
    if (!entry) return;
    const { root, controller } = entry;
    const value = root.querySelector('[data-filter-menu-value]');
    const visibleOptions = [...select.options].filter(option => !option.hidden);
    const selected = visibleOptions.find(option => option.value === select.value) || visibleOptions[0];
    if (value) value.textContent = selected?.textContent || '';
    controller.menu.replaceChildren(...visibleOptions.map(option => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'header-menu-item';
      item.dataset.filterValue = option.value;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.value === select.value));
      item.disabled = option.disabled;
      item.textContent = option.textContent;
      return item;
    }));
    controller.trigger.title = selected?.textContent || '';
  }

  function bindSelect(select, root) {
    if (!select || !root || selectMenus.has(select)) return selectMenus.get(select)?.controller || null;
    const trigger = root.querySelector('.filter-menu-trigger');
    const menu = root.querySelector('[role="menu"]');
    const controller = create({
      trigger, menu,
      onBeforeOpen: () => syncSelect(select),
      onSelect: item => {
        select.value = item.dataset.filterValue;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });
    if (!controller) return null;
    selectMenus.set(select, { root, controller });
    select.addEventListener('change', () => queueMicrotask(() => syncSelect(select)));
    syncSelect(select);
    return controller;
  }

  function selectController(select) {
    return selectMenus.get(select)?.controller || null;
  }

  // Sofort beim Laden registrieren: Der Escape-Handler muss vor denen der Dialoge
  // (z. B. duplicates.js, ebenfalls Capture-Phase) laufen, sonst schlösse Escape
  // den Dialog statt des darin geöffneten Menüs.
  wireDocument();

  return { create, bindSelect, syncSelect, selectController, keepInViewport, ITEM_SELECTOR };
}));
