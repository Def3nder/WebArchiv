/* WebArchiv — Richtungssteuerung für Ergebnisseiten per Wischgeste und Tastatur */
(function exposePageSwipe(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebArchivPageSwipe = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPageSwipe() {
  'use strict';

  const EDGE_INSET = 30;
  const TARGET_EDGE_ZONE = 30;
  const MIN_X = 80;
  const X_DOMINANCE = 1;

  function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // Safari muss schon bei der ersten Bewegung wissen, ob die Anwendung die
  // Geste übernimmt. Gleichstand gehört dem vertikalen Seitenscrollen.
  function movementIntent(gesture) {
    if (!gesture) return 'none';
    const dx = finiteNumber(gesture.currentX) - finiteNumber(gesture.startX);
    const dy = finiteNumber(gesture.currentY) - finiteNumber(gesture.startY);
    if (dx === 0 && dy === 0) return 'pending';
    return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
  }

  // Rückgabe wie bei pageDirection: +1 = nächste, -1 = vorherige Seite.
  // Modifizierte Pfeiltasten bleiben Browser- und Betriebssystem-Kürzeln vorbehalten.
  function keyDirection(event) {
    if (!event || event.defaultPrevented || event.altKey || event.ctrlKey
        || event.metaKey || event.shiftKey) return 0;
    if (event.key === 'ArrowRight') return 1;
    if (event.key === 'ArrowLeft') return -1;
    return 0;
  }

  // Rückgabe: +1 = nächste Seite, -1 = vorherige Seite, 0 = keine Seitengeste.
  function pageDirection(gesture, options = {}) {
    if (!gesture || gesture.multiple || gesture.blocked) return 0;

    const viewportWidth = finiteNumber(gesture.viewportWidth);
    const startX = finiteNumber(gesture.startX, -1);
    const edgeInset = Math.max(EDGE_INSET, finiteNumber(options.edgeInset, EDGE_INSET));
    if (viewportWidth <= edgeInset * 2
        || startX < edgeInset
        || startX > viewportWidth - edgeInset) return 0;

    const dx = finiteNumber(gesture.endX) - startX;
    const dy = finiteNumber(gesture.endY) - finiteNumber(gesture.startY);
    const endX = finiteNumber(gesture.endX, -1);
    const minX = Math.max(1, finiteNumber(options.minX, MIN_X));
    const dominance = Math.max(1, finiteNumber(options.xDominance, X_DOMINANCE));
    const targetEdgeZone = Math.max(
      TARGET_EDGE_ZONE,
      finiteNumber(options.targetEdgeZone, TARGET_EDGE_ZONE),
    );
    if (Math.abs(dx) < minX || Math.abs(dx) <= Math.abs(dy) * dominance) return 0;

    // Die Geste beginnt im Inhalt und wirft die aktuelle Ergebnisseite aus dem
    // Bildschirm: links hinaus = nächste, rechts hinaus = vorherige Seite.
    if (dx < 0 && endX <= targetEdgeZone) return 1;
    if (dx > 0 && endX >= viewportWidth - targetEdgeZone) return -1;
    return 0;
  }

  return {
    EDGE_INSET,
    TARGET_EDGE_ZONE,
    MIN_X,
    X_DOMINANCE,
    movementIntent,
    keyDirection,
    pageDirection,
  };
}));
