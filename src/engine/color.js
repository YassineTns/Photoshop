"use strict";

/**
 * Colour space helpers.
 *
 * Everything here is plain JS with no UXP dependency so the engine can be unit
 * tested in Node. Values marked `0..255` are gamma encoded sRGB bytes, values
 * marked `0..1` are normalised.
 */

/* ------------------------------------------------------------------ *
 * sRGB <-> linear
 * ------------------------------------------------------------------ */

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/* ------------------------------------------------------------------ *
 * Luminance
 * ------------------------------------------------------------------ */

/**
 * Rec.709 luma computed directly on gamma encoded bytes. This is what most
 * halftone / screen-printing tools use: it tracks perceived ink coverage
 * closely and produces a visually even ramp on a black -> white gradient.
 * @returns {number} 0..1
 */
function luma709(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Rec.601 luma, slightly warmer weighting. @returns {number} 0..1 */
function luma601(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * CIE L* (perceptual lightness) derived from linear relative luminance.
 * Costlier but perceptually uniform. @returns {number} 0..1
 */
function perceptualL(r, g, b) {
  const y =
    0.2126 * SRGB_TO_LINEAR[r | 0] +
    0.7152 * SRGB_TO_LINEAR[g | 0] +
    0.0722 * SRGB_TO_LINEAR[b | 0];
  const l = y > 0.008856451679 ? 116 * Math.cbrt(y) - 16 : 903.2962962 * y;
  return l / 100;
}

const LUMA_MODES = {
  luma709,
  luma601,
  perceptual: perceptualL,
};

function getLumaFn(mode) {
  return LUMA_MODES[mode] || luma709;
}

/* ------------------------------------------------------------------ *
 * OKLab - used for quantisation, palette spread and nearest-colour
 * matching. Perceptually uniform, so palettes stay clean instead of muddy.
 * ------------------------------------------------------------------ */

/** @param {number} r 0..255 @param {number} g 0..255 @param {number} b 0..255 */
function rgbToOklab(r, g, b, out) {
  const lr = SRGB_TO_LINEAR[r & 255];
  const lg = SRGB_TO_LINEAR[g & 255];
  const lb = SRGB_TO_LINEAR[b & 255];

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const res = out || [0, 0, 0];
  res[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  res[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  res[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return res;
}

/** @returns {number[]} rgb 0..255 (rounded, clamped) */
function oklabToRgb(L, a, bb, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const res = out || [0, 0, 0];
  res[0] = clamp255(Math.round(linearToSrgb(lr) * 255));
  res[1] = clamp255(Math.round(linearToSrgb(lg) * 255));
  res[2] = clamp255(Math.round(linearToSrgb(lb) * 255));
  return res;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/* ------------------------------------------------------------------ *
 * HSL - used for the Hue / Saturation / Brightness controls so the
 * behaviour matches what users expect from Photoshop's own adjustment.
 * ------------------------------------------------------------------ */

/** @returns {number[]} [h 0..1, s 0..1, l 0..1] */
function rgbToHsl(r, g, b, out) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = rr > gg ? (rr > bb ? rr : bb) : gg > bb ? gg : bb;
  const min = rr < gg ? (rr < bb ? rr : bb) : gg < bb ? gg : bb;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h /= 6;
  }
  const res = out || [0, 0, 0];
  res[0] = h;
  res[1] = s;
  res[2] = l;
  return res;
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** @returns {number[]} rgb 0..255 */
function hslToRgb(h, s, l, out) {
  const res = out || [0, 0, 0];
  if (s <= 1e-9) {
    const v = clamp255(Math.round(l * 255));
    res[0] = res[1] = res[2] = v;
    return res;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  res[0] = clamp255(Math.round(hue2rgb(p, q, h + 1 / 3) * 255));
  res[1] = clamp255(Math.round(hue2rgb(p, q, h) * 255));
  res[2] = clamp255(Math.round(hue2rgb(p, q, h - 1 / 3) * 255));
  return res;
}

/**
 * Apply hue rotation / saturation scaling / brightness offset to one colour.
 *
 * Deliberately does NOT touch HSL lightness for hue+saturation, so changing
 * Hue never changes the halftone geometry (see engine/pipeline.js).
 *
 * @param {number[]} rgb    [r,g,b] 0..255
 * @param {object} adj      {hue: degrees, saturation: multiplier, brightness: -100..100}
 * @param {number[]} [out]
 */
const _hsl = [0, 0, 0];
function adjustColor(r, g, b, adj, out) {
  const res = out || [0, 0, 0];
  const hueShift = (adj.hue || 0) / 360;
  const sat = adj.saturation === undefined ? 1 : adj.saturation;
  const bright = (adj.brightness || 0) / 100;

  if (hueShift === 0 && sat === 1 && bright === 0) {
    res[0] = r;
    res[1] = g;
    res[2] = b;
    return res;
  }

  rgbToHsl(r, g, b, _hsl);
  let h = _hsl[0] + hueShift;
  h -= Math.floor(h);
  const s = Math.min(1, Math.max(0, _hsl[1] * sat));
  let l = _hsl[2];
  if (bright !== 0) {
    // Positive brightness lifts towards white, negative pulls towards black.
    l = bright > 0 ? l + (1 - l) * bright : l * (1 + bright);
    l = Math.min(1, Math.max(0, l));
  }
  return hslToRgb(h, s, l, res);
}

function isIdentityAdjust(adj) {
  return (
    (adj.hue || 0) === 0 &&
    (adj.saturation === undefined ? 1 : adj.saturation) === 1 &&
    (adj.brightness || 0) === 0
  );
}

/* ------------------------------------------------------------------ *
 * Hex helpers
 * ------------------------------------------------------------------ */

function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const v = (clamp255(Math.round(r)) << 16) | (clamp255(Math.round(g)) << 8) | clamp255(Math.round(b));
  return "#" + v.toString(16).padStart(6, "0").toUpperCase();
}

module.exports = {
  SRGB_TO_LINEAR,
  srgbToLinear,
  linearToSrgb,
  luma709,
  luma601,
  perceptualL,
  getLumaFn,
  LUMA_MODES,
  rgbToOklab,
  oklabToRgb,
  rgbToHsl,
  hslToRgb,
  adjustColor,
  isIdentityAdjust,
  hexToRgb,
  rgbToHex,
  clamp255,
};
