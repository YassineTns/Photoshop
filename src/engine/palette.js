"use strict";

/**
 * Palette construction: extraction from the image, spread, colour adjustment,
 * nearest-colour matching and background selection.
 */

const {
  rgbToOklab,
  oklabToRgb,
  luma709,
  hexToRgb,
  rgbToHex,
  adjustColor,
} = require("./color.js");
const { extractSamples, quantize } = require("./quantization.js");

/**
 * Extract a palette from an image.
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {{count: number, method: string, maxSamples?: number}} opts
 * @returns {number[][]} palette, dark -> light
 */
function extractPalette(img, opts) {
  const samples = extractSamples(img, opts.maxSamples);
  const pal = quantize(samples, opts.count, opts.method);
  return padPalette(pal, opts.count);
}

/**
 * Guarantee exactly `count` entries. If quantisation collapsed (flat artwork,
 * fewer distinct colours than requested) the widest luminance gap is split so
 * the UI always shows the number of swatches the user asked for.
 */
function padPalette(pal, count) {
  const out = pal.map((c) => c.slice());
  if (out.length === 0) return [[0, 0, 0]].slice(0, count);
  let guard = 64;
  while (out.length < count && guard-- > 0) {
    if (out.length === 1) {
      const c = out[0];
      const l = luma709(c[0], c[1], c[2]);
      // Split towards whichever end has more room.
      const target = l > 0.5 ? [0, 0, 0] : [255, 255, 255];
      out.push(mix(c, target, 0.5));
    } else {
      let bestGap = -1;
      let bestI = 0;
      for (let i = 0; i < out.length - 1; i++) {
        const gap = Math.abs(
          luma709(out[i + 1][0], out[i + 1][1], out[i + 1][2]) -
            luma709(out[i][0], out[i][1], out[i][2])
        );
        if (gap > bestGap) {
          bestGap = gap;
          bestI = i;
        }
      }
      out.splice(bestI + 1, 0, mix(out[bestI], out[bestI + 1], 0.5));
    }
    out.sort((a, b) => luma709(a[0], a[1], a[2]) - luma709(b[0], b[1], b[2]));
  }
  return out.slice(0, Math.max(1, count));
}

function mix(a, b, t) {
  const la = rgbToOklab(a[0], a[1], a[2]);
  const lb = rgbToOklab(b[0], b[1], b[2]);
  return oklabToRgb(
    la[0] + (lb[0] - la[0]) * t,
    la[1] + (lb[1] - la[1]) * t,
    la[2] + (lb[2] - la[2]) * t
  );
}

/**
 * Spread pushes palette entries away from their common centroid in OKLab.
 *
 * Lightness is expanded harder than chroma (x1.0 vs x0.6): that is what gives
 * the punchy, poster-like separation of a screen print without tipping colours
 * out of gamut and turning them muddy. spread = 0 leaves the palette untouched.
 *
 * @param {number[][]} pal
 * @param {number} spread 0..1
 * @returns {number[][]} new palette
 */
function applySpread(pal, spread) {
  if (!spread || pal.length < 2) return pal.map((c) => c.slice());
  const s = Math.max(0, Math.min(1, spread));
  const labs = pal.map((c) => rgbToOklab(c[0], c[1], c[2]));
  let cl = 0, ca = 0, cb = 0;
  for (const l of labs) {
    cl += l[0];
    ca += l[1];
    cb += l[2];
  }
  cl /= labs.length;
  ca /= labs.length;
  cb /= labs.length;

  const kL = 1 + s * 1.0;
  const kC = 1 + s * 0.6;
  return labs.map((l) =>
    oklabToRgb(
      clamp01(cl + (l[0] - cl) * kL),
      ca + (l[1] - ca) * kC,
      cb + (l[2] - cb) * kC
    )
  );
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Apply Hue / Saturation / Brightness to a palette.
 *
 * Doing it here rather than per pixel is exact for these HSL operations (they
 * are pointwise) and reduces the cost from O(width*height) to O(colours).
 */
function adjustPalette(pal, adj) {
  return pal.map((c) => adjustColor(c[0], c[1], c[2], adj));
}

/**
 * Precompute the OKLab coordinates of a palette for fast nearest matching.
 * @param {number[][]} pal
 * @returns {Float32Array} length pal.length*3
 */
function paletteToLab(pal) {
  const out = new Float32Array(pal.length * 3);
  const t = [0, 0, 0];
  for (let i = 0; i < pal.length; i++) {
    rgbToOklab(pal[i][0], pal[i][1], pal[i][2], t);
    out[i * 3] = t[0];
    out[i * 3 + 1] = t[1];
    out[i * 3 + 2] = t[2];
  }
  return out;
}

/**
 * Nearest palette index for an sRGB colour, matched in OKLab.
 * @param {Float32Array} labPal from paletteToLab
 */
const _lab = [0, 0, 0];
function nearestIndex(labPal, r, g, b) {
  rgbToOklab(r | 0, g | 0, b | 0, _lab);
  const n = labPal.length / 3;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dL = _lab[0] - labPal[i * 3];
    const dA = _lab[1] - labPal[i * 3 + 1];
    const dB = _lab[2] - labPal[i * 3 + 2];
    const d = dL * dL + dA * dA + dB * dB;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Which palette entry should the paper be?
 * Lightest when dots sit on light paper, darkest when inverted.
 * @returns {number} index
 */
function pickBackgroundIndex(pal, invert) {
  let best = 0;
  let bestL = invert ? Infinity : -Infinity;
  for (let i = 0; i < pal.length; i++) {
    const l = luma709(pal[i][0], pal[i][1], pal[i][2]);
    if (invert ? l < bestL : l > bestL) {
      bestL = l;
      best = i;
    }
  }
  return best;
}

/**
 * Resolve the background colour from params.
 * @param {number[][]} pal
 * @param {string} background "auto" | hex
 * @param {boolean} invert
 * @returns {number[]} rgb
 */
function resolveBackground(pal, background, invert) {
  if (background && background !== "auto") {
    const rgb = hexToRgb(background);
    if (rgb) return rgb;
  }
  return pal[pickBackgroundIndex(pal, invert)] || [255, 255, 255];
}

/**
 * The set of colours dots are actually allowed to take.
 *
 * The paper colour is removed from it. This matters a great deal: if the paper
 * colour stays in the ink set, every cell lighter than the mid point matches it
 * and gets a paper-coloured dot, which is invisible - the whole highlight half
 * of the tonal range silently disappears and a gradient stops dead half way.
 * Removing it means tone is carried purely by dot *size*, which is how a real
 * spot-colour screen works.
 *
 * An entry only counts as "the paper" if it is genuinely close to the
 * background, so an explicit background colour that is not part of the palette
 * leaves the ink set untouched.
 *
 * @param {number[][]} pal
 * @param {number[]} background rgb
 * @param {number} [threshold] OKLab distance
 * @returns {number[][]} at least one colour
 */
function inkPalette(pal, background, threshold = 0.06) {
  if (pal.length <= 1) return pal.map((c) => c.slice());
  const lab = paletteToLab(pal);
  const bg = rgbToOklab(background[0], background[1], background[2]);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const d = Math.hypot(bg[0] - lab[i * 3], bg[1] - lab[i * 3 + 1], bg[2] - lab[i * 3 + 2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD > threshold) return pal.map((c) => c.slice());
  const out = pal.filter((_, i) => i !== best).map((c) => c.slice());
  return out.length ? out : pal.map((c) => c.slice());
}

function paletteToHex(pal) {
  return pal.map((c) => rgbToHex(c[0], c[1], c[2]));
}

function hexToPalette(hexes) {
  const out = [];
  for (const h of hexes || []) {
    const rgb = hexToRgb(h);
    if (rgb) out.push(rgb);
  }
  return out;
}

module.exports = {
  extractPalette,
  inkPalette,
  padPalette,
  applySpread,
  adjustPalette,
  paletteToLab,
  nearestIndex,
  pickBackgroundIndex,
  resolveBackground,
  paletteToHex,
  hexToPalette,
};
