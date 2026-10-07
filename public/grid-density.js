/* WebArchiv — Berechnung einer größenstabilen Kacheldichte */
(function exposeGridDensity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WebArchivGridDensity = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createGridDensity() {
  'use strict';

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizedGap(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function maxColumns(containerWidth, gap, options = {}) {
    const width = positiveNumber(containerWidth, 1);
    const spacing = normalizedGap(gap);
    const minimum = Math.max(1, Math.round(positiveNumber(options.minColumns, 1)));
    const maximum = Math.max(minimum, Math.round(positiveNumber(options.maxColumns, 8)));
    const minimumCardWidth = positiveNumber(options.minCardWidth, 110);
    const fitting = Math.floor((width + spacing) / (minimumCardWidth + spacing));
    return Math.max(minimum, Math.min(maximum, fitting));
  }

  function cardWidthForColumns(containerWidth, gap, columns) {
    const width = positiveNumber(containerWidth, 1);
    const spacing = normalizedGap(gap);
    const count = Math.max(1, Math.round(positiveNumber(columns, 1)));
    return Math.max(1, (width - spacing * (count - 1)) / count);
  }

  function columnsForCardWidth(containerWidth, gap, preferredWidth, options = {}) {
    const width = positiveNumber(containerWidth, 1);
    const spacing = normalizedGap(gap);
    const target = positiveNumber(preferredWidth, width);
    const minimum = Math.max(1, Math.round(positiveNumber(options.minColumns, 1)));
    const maximum = maxColumns(width, spacing, options);
    const approximate = Math.round((width + spacing) / (target + spacing));
    return Math.max(minimum, Math.min(maximum, approximate));
  }

  return { maxColumns, cardWidthForColumns, columnsForCardWidth };
}));
