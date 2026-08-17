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
 * @property {number[][]} [toneCurve] control points [[x,y], ...] in 0..1
 */

/** The identity curve: two endpoints, nothing bent. */
const IDENTITY_CURVE = [
  [0, 0],
  [1, 1],
];

/**
 * Is this curve the identity, to within a pixel of 8-bit precision?
 * @param {number[][]} pts
 */
function isIdentityCurve(pts) {
  if (!pts || pts.length < 2) return true;
  for (const p of pts) {
    if (Math.abs(p[1] - p[0]) > 0.002) return false;
  }
  return true;
}

/**
 * Sort by x, clamp into range, and drop points that share an x.
 *
 * Two points at the same x would make the slope infinite and the interpolation
 * meaningless, and they are easy to produce by dragging one point onto another.
 *
 * @param {number[][]} pts
 * @returns {number[][]} at least two points, strictly increasing in x
 */
function normaliseCurve(pts) {
  const list = (Array.isArray(pts) ? pts : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [clamp(Number(p[0]), 0, 1), clamp(Number(p[1]), 0, 1)])
    .sort((a, b) => a[0] - b[0]);

  const out = [];
  for (const p of list) {
    if (out.length && p[0] - out[out.length - 1][0] < 1e-4) continue;
    out.push(p);
  }
  if (out.length < 2) return IDENTITY_CURVE.map((p) => p.slice());
  return out;
}

/**
 * Evaluate a curve through its control points.
 *
 * Monotone cubic interpolation (Fritsch-Carlson), not a plain natural spline.
 * The difference matters here: a natural spline through hand-placed points
 * overshoots between them, and an overshoot in a tone curve is a *reversal* -
 * a patch that gets darker as the source gets lighter, which shows up as a
 * false edge running through a gradient. Fritsch-Carlson limits the tangents so
 * the result can never turn back on itself, at the cost of being slightly less
 * smooth at the control points. That is the right trade for tone.
 *
 * @param {number[][]} pts normalised: sorted, distinct x
 * @param {number} x 0..1
 * @returns {number} 0..1
 */
function evalCurve(pts, x) {
  const n = pts.length;
  if (n < 2) return x;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];

  // Secant slopes, then tangents limited so no segment can overshoot.
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    d[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // A local extremum: the tangent must be flat, or the curve bulges past it.
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const h = pts[i + 1][0] - pts[i][0];
  const t = (x - pts[i][0]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const y = h00 * pts[i][1] + h10 * h * m[i] + h01 * pts[i + 1][1] + h11 * h * m[i + 1];
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * A curve as a 256 entry table.
 * @param {number[][]} pts
 * @returns {Float32Array}
 */
function curveLUT(pts) {
  const norm = normaliseCurve(pts);
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = evalCurve(norm, i / 255);
  return lut;
}

/**
 * Build a lookup table mapping an 8 bit luminance to a graded 0..1 value.
 *
 * Order of operations mirrors a classic grading chain:
 *   levels (black/white point) -> gamma -> contrast -> exposure -> curve
 *
 * The curve comes last, as it does in an image editor: the sliders set the
 * overall range and the curve shapes what is inside it. Doing it the other way
 * round would mean every slider move silently re-interpreted the points you had
 * placed.
 *
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

  // Named for the parameter, like every other field this reads. It was `curve`
  // for one revision and silently did nothing, which is the whole argument for
  // checking a feature end to end rather than trusting that it is wired.
  if (p.toneCurve && !isIdentityCurve(p.toneCurve)) {
    const pts = normaliseCurve(p.toneCurve);
    for (let i = 0; i < 256; i++) lut[i] = evalCurve(pts, lut[i]);
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

/**
 * Apply a tone LUT to every channel of an image, the way a Curves or Levels
 * adjustment would.
 *
 * The halftone path grades a single luminance value per cell, but the dither
 * path has to grade the actual pixels: dithering decides colour per pixel, so
 * the grade has to be in the data before quantisation happens.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {Float32Array} lut 256 entries, 0..1
 * @param {boolean} [invert]
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
function applyToneToImage(img, lut, invert) {
  // Collapse the LUT to bytes once, then it is a single lookup per channel.
  const map = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = invert ? 1 - lut[i] : lut[i];
    map[i] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
  }
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = map[src[i]];
    out[i + 1] = map[src[i + 1]];
    out[i + 2] = map[src[i + 2]];
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: img.width, height: img.height };
}

/** True when the LUT would leave the image untouched. */
function isIdentityLUT(lut, invert) {
  if (invert) return false;
  for (let i = 0; i < 256; i += 17) {
    if (Math.abs(lut[i] - i / 255) > 0.004) return false;
  }
  return true;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

module.exports = {
  IDENTITY_CURVE,
  isIdentityCurve,
  normaliseCurve,
  evalCurve,
  curveLUT,
  buildToneLUT,
  sampleLUT,
  biasCurve,
  inkToRadius,
  applyToneToImage,
  isIdentityLUT,
  clamp,
};
