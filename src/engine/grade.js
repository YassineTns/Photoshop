"use strict";

/**
 * Tonal grading applied to the luminance signal *before* it is converted into
 * a dot radius. Everything is expressed as a 256 entry lookup table so the
 * per-cell cost is a single array read.
 */

/**
 * @typedef {object} GradeParams
 * @property {number} contrast    multiplier around mid grey, 0..3 (1 = none)
 * @property {number} blackPoint  input black, 0..255
 * @property {number} whitePoint  input white, 0..255
 * @property {number} gamma       0.1..3 (1 = none)
 * @property {number} exposure    -100..100 additive lift, in %
 */

/**
 * Build a lookup table mapping an 8 bit luminance to a graded 0..1 value.
 * Order of operations mirrors a classic grading chain:
 *   levels (black/white point) -> gamma -> contrast -> exposure
 * @param {GradeParams} p
 * @returns {Float32Array} 256 entries, 0..1
 */
function buildToneLUT(p) {
  const lut = new Float32Array(256);
  const black = clamp(p.blackPoint === undefined ? 0 : p.blackPoint, 0, 254);
  const white = clamp(p.whitePoint === undefined ? 255 : p.whitePoint, black + 1, 255);
  const invRange = 1 / (white - black);
  const gamma = clamp(p.gamma === undefined ? 1 : p.gamma, 0.05, 8);
  const invGamma = 1 / gamma;
  const contrast = clamp(p.contrast === undefined ? 1 : p.contrast, 0, 4);
  const exposure = (p.exposure || 0) / 100;

  for (let i = 0; i < 256; i++) {
    let v = (i - black) * invRange;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (gamma !== 1) v = Math.pow(v, invGamma);
    if (contrast !== 1) v = (v - 0.5) * contrast + 0.5;
    if (exposure !== 0) v += exposure;
    lut[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return lut;
}

/**
 * Apply a graded LUT to a normalised 0..1 luminance with linear interpolation
 * between LUT entries (cell averages are continuous, not 8 bit).
 * @param {Float32Array} lut
 * @param {number} v 0..1
 */
function sampleLUT(lut, v) {
  const x = (v < 0 ? 0 : v > 1 ? 1 : v) * 255;
  const i = x | 0;
  if (i >= 255) return lut[255];
  const f = x - i;
  return lut[i] * (1 - f) + lut[i + 1] * f;
}

/**
 * Schlick's bias function - a cheap, monotonic, C1-continuous curve control.
 * bias = 0 is the identity, bias > 0 pushes values up (fatter dots),
 * bias < 0 pushes values down (thinner dots). Endpoints stay pinned at 0 and 1
 * so pure black and pure white never drift.
 *
 * @param {number} v 0..1
 * @param {number} bias -1..1
 */
function biasCurve(v, bias) {
  if (!bias) return v;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  // Map bias -1..1 to a Schlick parameter in (0,1); 0.5 is the identity.
  const b = 0.5 + clamp(bias, -0.98, 0.98) * 0.5;
  const k = 1 / b - 2;
  return v / (k * (1 - v) + 1);
}

/**
 * Ink amount -> dot radius.
 *
 * Dot *area* is made proportional to the ink amount, i.e. radius ~ sqrt(ink).
 * That is what keeps a black->white gradient reading as an even ramp instead of
 * bunching up in the shadows, and it is how real amplitude modulated screens
 * behave. `curve` blends between area-proportional (0) and radius-proportional
 * (1) if a harder look is wanted.
 *
 * @param {number} ink 0..1
 * @param {number} maxRadius pixels
 * @param {number} curve 0..1
 */
function inkToRadius(ink, maxRadius, curve) {
  const v = ink < 0 ? 0 : ink > 1 ? 1 : ink;
  const c = curve === undefined ? 0 : clamp(curve, 0, 1);
  const areaBased = Math.sqrt(v);
  const r = c === 0 ? areaBased : areaBased * (1 - c) + v * c;
  return r * maxRadius;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = { buildToneLUT, sampleLUT, biasCurve, inkToRadius, clamp };
