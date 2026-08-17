"use strict";

/**
 * Pre-processing applied before tone is measured or dithered.
 *
 * Both operations reuse the O(1)-per-pixel box blur, so the whole chain stays
 * linear in pixel count even at the largest analysis sizes.
 */

const { gaussianBlurRGBA } = require("./blur.js");

/**
 * Unsharp mask: out = src + amount * (src - blurred).
 *
 * Applied before dithering it does real work rather than being cosmetic: a
 * dither has no tonal resolution to spare, so lifting local contrast first is
 * what keeps fine detail from dissolving into noise.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {number} amount 0..200 (percent)
 * @param {number} radius in pixels
 * @param {number} [threshold] 0..255, ignore differences below this
 */
function unsharpMask(img, amount, radius, threshold = 0) {
  if (!(amount > 0) || !(radius > 0)) return img;
  const k = amount / 100;
  const blurred = gaussianBlurRGBA(img, radius);
  const src = img.data;
  const bl = blurred.data;
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const s = src[i + c];
      const d = s - bl[i + c];
      out[i + c] = Math.abs(d) < threshold ? s : s + k * d;
    }
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: img.width, height: img.height };
}

/**
 * Edge-preserving noise reduction.
 *
 * A true bilateral filter costs O(radius^2) per pixel. This approximates it in
 * one linear pass: blur once, then blend towards the blurred value only where
 * the local difference is small. Flat, noisy areas smooth out; edges, where the
 * difference is large, are left alone. That is the behaviour that matters here,
 * because unfiltered sensor noise turns into a field of isolated dots the moment
 * it is dithered.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {number} amount 0..100
 * @param {number} [radius]
 */
function reduceNoise(img, amount, radius = 1.6) {
  if (!(amount > 0)) return img;
  const strength = Math.min(1, amount / 100);
  // The threshold rises with the amount: stronger settings treat larger
  // differences as noise rather than detail.
  const threshold = 4 + strength * 44;
  const blurred = gaussianBlurRGBA(img, radius);
  const src = img.data;
  const bl = blurred.data;
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    // Decide edge-ness once per pixel, from the largest channel difference, so
    // colour fringes are treated as edges too.
    let maxDiff = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(src[i + c] - bl[i + c]);
      if (d > maxDiff) maxDiff = d;
    }
    // 1 when flat, 0 when clearly an edge, smooth in between.
    const t = maxDiff >= threshold ? 0 : 1 - (maxDiff / threshold) * (maxDiff / threshold);
    const mix = t * strength;
    for (let c = 0; c < 3; c++) {
      out[i + c] = src[i + c] * (1 - mix) + bl[i + c] * mix;
    }
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: img.width, height: img.height };
}

/**
 * Apply the whole pre-processing chain in the order a retoucher would:
 * denoise, then blur, then sharpen.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {object} params
 * @param {number} scale pixels per resolution-independent unit
 */
function preprocess(img, params, scale) {
  let out = img;
  if (params.noiseReduction > 0) {
    out = reduceNoise(out, params.noiseReduction, Math.max(0.8, 1.6 * scale));
  }
  if (params.blur > 0) {
    out = gaussianBlurRGBA(out, params.blur * scale);
  }
  if (params.sharpen > 0) {
    out = unsharpMask(out, params.sharpen, Math.max(0.5, params.sharpenRadius * scale));
  }
  return out;
}

module.exports = { unsharpMask, reduceNoise, preprocess };
