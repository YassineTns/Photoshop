"use strict";

/**
 * Tonal zone colour mapping.
 *
 * By default a pixel or cell takes whichever palette colour is nearest to it.
 * That is faithful, but it means a dark red and a dark blue both collapse onto
 * whatever single dark entry exists, and the palette's lighter colours never
 * appear in shadow areas even when they would read better.
 *
 * Tonal mapping instead splits the palette into shadow / midtone / highlight
 * bands and restricts matching to the band the pixel's luminance falls in. The
 * palette is already sorted dark to light, so each band owns a contiguous slice
 * of indices - which is what makes this a cheap index range rather than a
 * per-pixel search over a subset.
 *
 * Bands overlap by one entry when the palette is big enough. Without the
 * overlap, error diffusion cannot carry error across a band boundary and the
 * boundary shows up as a hard contour.
 */

/**
 * @param {number} paletteCount
 * @param {number} shadowSplit    luminance 0..1 where shadows end
 * @param {number} highlightSplit luminance 0..1 where highlights begin
 * @returns {{bands: number[][], i1: number, i2: number}|null}
 *          null when the palette is too small to split meaningfully
 */
function zoneBands(paletteCount, shadowSplit, highlightSplit) {
  const n = paletteCount;
  if (n < 3) return null;

  let s = clamp01(shadowSplit);
  let h = clamp01(highlightSplit);
  if (h < s) {
    const t = s;
    s = h;
    h = t;
  }

  // Index boundaries, keeping at least one colour per band.
  let i1 = Math.round(n * s);
  let i2 = Math.round(n * h);
  i1 = Math.min(Math.max(i1, 1), n - 2);
  i2 = Math.min(Math.max(i2, i1 + 1), n - 1);

  const overlap = n >= 4 ? 1 : 0;
  const bands = [
    [0, Math.min(n, i1 + overlap)],
    [Math.max(0, i1 - overlap), Math.min(n, i2 + overlap)],
    [Math.max(0, i2 - overlap), n],
  ];
  return { bands, i1, i2 };
}

/**
 * Build the `zoneRange` callback the renderers take.
 *
 * @param {number} paletteCount
 * @param {object} params {tonalMapping, shadowSplit, highlightSplit}
 * @returns {((L:number)=>number[])|null} null when mapping is off or impossible
 */
function makeZoneRange(paletteCount, params) {
  if (!params || !params.tonalMapping) return null;
  const z = zoneBands(paletteCount, params.shadowSplit, params.highlightSplit);
  if (!z) return null;

  let s = clamp01(params.shadowSplit);
  let h = clamp01(params.highlightSplit);
  if (h < s) {
    const t = s;
    s = h;
    h = t;
  }
  const [shadow, mid, high] = z.bands;
  return (L) => (L < s ? shadow : L < h ? mid : high);
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

module.exports = { zoneBands, makeZoneRange };
