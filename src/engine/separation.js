"use strict";

/**
 * Ink separation and multi-screen halftoning.
 *
 * WHY THIS EXISTS
 * ---------------
 * The single-screen renderer puts one opaque dot per cell, coloured by whichever
 * palette entry is nearest. That is a poster, not a print. A real press lays each
 * ink down on its own screen at its own angle, and the inks are transparent, so
 * they overprint: cyan over magenta gives blue, and the four screens interleave
 * into a rosette instead of a moiré.
 *
 * Reproducing that needs two things this file provides:
 *
 *  1. SEPARATION - how much of each ink is needed to reach a given colour. Inks
 *     are subtractive, so this is solved in optical density space
 *     (D = -log10 reflectance), where overprinting is addition. With more than
 *     three inks the system is underdetermined and needs regularising, and the
 *     choice of penalty matters more than it looks: an L2 (ridge) penalty
 *     minimises the norm by SPREADING coverage across every ink, so pure black
 *     came out as 0.59 key plus a third of everything else. An L1 penalty
 *     promotes sparsity instead, which is both the correct prior for ink - a
 *     press uses as few plates as it can - and what makes a pure ink resolve to
 *     itself. This is non-negative lasso by proximal gradient.
 *
 *  2. ANGLES - the classic screen angles exist because 30 degrees apart is the
 *     maximum separation three screens can have, and yellow goes at 0 because it
 *     is the least visible. Anything closer than about 15 degrees beats into a
 *     moiré, which is exactly what a naive "same angle for every ink" render
 *     produces.
 */

const { SRGB_TO_LINEAR, luma709 } = require("./color.js");

/**
 * Classic screen angles, in the order inks are assigned (darkest first, which
 * for a typical palette puts the key ink at 45 degrees where the eye is least
 * sensitive to the pattern).
 */
const CLASSIC_ANGLES = [45, 15, 75, 0, 30, 60, 22.5, 67.5, 52.5];

/**
 * @param {number} count number of inks
 * @param {number} baseAngle global rotation applied to all screens
 * @param {number} spread 0..1 scales how far apart the screens sit; 0 collapses
 *        them onto one angle (useful for a deliberately flat, graphic look)
 * @returns {number[]} angle per ink, in degrees
 */
function screenAngles(count, baseAngle, spread) {
  const s = spread === undefined ? 1 : Math.max(0, Math.min(1, spread));
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = CLASSIC_ANGLES[i % CLASSIC_ANGLES.length];
    // Interpolate towards the first angle as spread goes to zero.
    const collapsed = CLASSIC_ANGLES[0] + (a - CLASSIC_ANGLES[0]) * s;
    out.push(((baseAngle || 0) + collapsed) % 180);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Density space
 * ------------------------------------------------------------------ */

/**
 * Minimum reflectance, so pure black does not blow the logarithm up.
 *
 * Deliberately low. Raising it towards a "realistic" ink reflectance (1-2%)
 * collapses the basis: a saturated cyan reflects essentially no red, so its red
 * density and the key ink's red density become equal and the columns stop being
 * distinguishable, at which point the solver cannot tell black from cyan.
 */
const MIN_REFLECTANCE = 0.004;

/**
 * sRGB byte triple -> optical density triple.
 * Linearising first matters: density is about light, not about the gamma
 * encoded number.
 */
function toDensity(rgb, out) {
  const res = out || [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const lin = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(rgb[c])))];
    res[c] = -Math.log10(Math.max(MIN_REFLECTANCE, lin));
  }
  return res;
}

/**
 * Precompute the density each ink adds over the paper, once per render.
 *
 * @param {number[][]} inks rgb triples
 * @param {number[]} paper rgb
 * @returns {{d: Float64Array, gram: Float64Array, count: number}}
 */
function buildInkBasis(inks, paper) {
  const n = inks.length;
  const paperD = toDensity(paper);
  const d = new Float64Array(n * 3);
  const t = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    toDensity(inks[k], t);
    d[k * 3] = t[0] - paperD[0];
    d[k * 3 + 1] = t[1] - paperD[1];
    d[k * 3 + 2] = t[2] - paperD[2];
  }
  return { d, paperD, count: n };
}

/**
 * Non-negative lasso by proximal gradient descent.
 *
 * Solves  min ||A c - b||^2 + lambda ||c||_1   subject to  0 <= c <= maxCoverage,
 * where A is the ink density basis and b the target density above paper. Since c
 * is constrained non-negative, the L1 subgradient is just a constant lambda, so
 * the proximal step collapses to "push every coverage down a little, then clamp
 * at zero" - soft thresholding, for free.
 *
 * Accelerated with FISTA momentum. Plain proximal gradient is far too slow here:
 * the ink basis is badly conditioned (every ink is dark in some channel, so the
 * columns are strongly correlated) and 40 unaccelerated iterations left pure
 * black sitting at 0.6 key plus a third of everything else instead of converging
 * to the exact 1.0 key that fits it perfectly. Momentum gets there in a fraction
 * of the steps, and this still runs per *cell* - a few thousand solves - not per
 * pixel.
 *
 * @param {object} basis from buildInkBasis
 * @param {number[]} targetRGB
 * @param {Float64Array} out coverage per ink, 0..maxCoverage
 * @param {number} [lambda] sparsity weight
 * @param {number} [maxCoverage]
 */
function unmix(basis, targetRGB, out, lambda = 0.015, maxCoverage = 1) {
  const n = basis.count;
  const d = basis.d;
  const target = toDensity(targetRGB);
  const b0 = target[0] - basis.paperD[0];
  const b1 = target[1] - basis.paperD[1];
  const b2 = target[2] - basis.paperD[2];

  for (let k = 0; k < n; k++) out[k] = 0;

  // Step size from the basis magnitude keeps the iteration stable whatever the
  // palette looks like.
  let norm = 0;
  for (let k = 0; k < n; k++) {
    norm += d[k * 3] * d[k * 3] + d[k * 3 + 1] * d[k * 3 + 1] + d[k * 3 + 2] * d[k * 3 + 2];
  }
  const step = norm > 1e-9 ? 1 / norm : 0;
  if (!step) return out;
  // The sparsity weight has to scale with the basis, otherwise it is measured in
  // different units for every palette: a light-ink palette has small densities,
  // a fixed lambda then dwarfs the data term and drives every coverage to zero.
  const shrink = (lambda * norm) / n;

  // FISTA: `y` is the extrapolated point the gradient is taken at, `prev` the
  // previous iterate. Scratch buffers are reused across calls because this is
  // invoked once per cell.
  const y = scratchY(n);
  const prev = scratchPrev(n);
  for (let k = 0; k < n; k++) {
    y[k] = 0;
    prev[k] = 0;
  }
  let t = 1;

  for (let it = 0; it < 60; it++) {
    // residual = A y - b
    let r0 = -b0;
    let r1 = -b1;
    let r2 = -b2;
    for (let k = 0; k < n; k++) {
      const c = y[k];
      if (c === 0) continue;
      r0 += c * d[k * 3];
      r1 += c * d[k * 3 + 1];
      r2 += c * d[k * 3 + 2];
    }
    for (let k = 0; k < n; k++) {
      const g = r0 * d[k * 3] + r1 * d[k * 3 + 1] + r2 * d[k * 3 + 2];
      // Gradient step on the data term, then the L1 proximal step: subtract a
      // constant and clamp at zero, which is what drives unused inks to exactly
      // zero instead of merely small.
      let c = y[k] - step * g * 2 - step * shrink;
      if (c < 0) c = 0;
      else if (c > maxCoverage) c = maxCoverage;
      out[k] = c;
    }
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const mom = (t - 1) / tNext;
    let delta = 0;
    for (let k = 0; k < n; k++) {
      const d2 = out[k] - prev[k];
      if (d2 > delta) delta = d2;
      else if (-d2 > delta) delta = -d2;
      y[k] = out[k] + mom * d2;
      prev[k] = out[k];
    }
    t = tNext;
    // Most cells are flat or near-paper and settle in a handful of iterations;
    // only the awkward ones need the full budget. Bailing early on those is
    // what keeps a per-cell solver affordable.
    if (it > 3 && delta < 2e-4) break;
  }
  return out;
}

let _y = null;
let _prev = null;
function scratchY(n) {
  if (!_y || _y.length < n) _y = new Float64Array(n);
  return _y;
}
function scratchPrev(n) {
  if (!_prev || _prev.length < n) _prev = new Float64Array(n);
  return _prev;
}

/**
 * Order inks the way a press would: darkest (the key) first, then by how much
 * each contributes, so the most visible screen lands on the least visible angle.
 * @param {number[][]} inks
 * @returns {number[]} indices into `inks`
 */
function inkOrder(inks) {
  return inks
    .map((c, i) => ({ i, l: luma709(c[0], c[1], c[2]) }))
    .sort((a, b) => a.l - b.l)
    .map((e) => e.i);
}

module.exports = {
  CLASSIC_ANGLES,
  screenAngles,
  toDensity,
  buildInkBasis,
  unmix,
  inkOrder,
  MIN_REFLECTANCE,
};
