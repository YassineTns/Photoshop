"use strict";

/**
 * Area-average (box) downscaling.
 *
 * Used to build the low resolution "analysis" image the halftone cells are
 * measured from. Area averaging is the right filter here: it is exactly the
 * same operation the cell sampler performs, so downscaling first changes the
 * measured cell tone by a negligible amount while cutting the cost of the only
 * O(width*height) stage by one to two orders of magnitude.
 */

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {number} tw target width
 * @param {number} th target height
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
function downscaleBox(img, tw, th) {
  const { data: src, width: sw, height: sh } = img;
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  if (tw >= sw && th >= sh) {
    return { data: new Uint8ClampedArray(src), width: sw, height: sh };
  }

  const out = new Uint8ClampedArray(tw * th * 4);
  const xRatio = sw / tw;
  const yRatio = sh / th;

  // Precompute the source column span for each target column.
  const xStarts = new Int32Array(tw + 1);
  for (let x = 0; x <= tw; x++) xStarts[x] = Math.min(sw, Math.round(x * xRatio));

  for (let y = 0; y < th; y++) {
    const sy0 = Math.min(sh - 1, Math.round(y * yRatio));
    const sy1 = Math.max(sy0 + 1, Math.min(sh, Math.round((y + 1) * yRatio)));
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.min(sw - 1, xStarts[x]);
      const sx1 = Math.max(sx0 + 1, xStarts[x + 1]);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let p = (sy * sw + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, p += 4) {
          const al = src[p + 3];
          // Weight colour by alpha so transparent pixels do not pull the
          // average towards whatever garbage sits in their colour channels.
          const wgt = al / 255;
          r += src[p] * wgt;
          g += src[p + 1] * wgt;
          b += src[p + 2] * wgt;
          a += al;
          n += wgt;
        }
      }
      const cnt = (sy1 - sy0) * (sx1 - sx0);
      const o = (y * tw + x) * 4;
      if (n > 1e-6) {
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
      }
      out[o + 3] = a / cnt;
    }
  }

  return { data: out, width: tw, height: th };
}

/**
 * Downscale so the longest edge is at most `maxLongest`, preserving aspect.
 * Returns the source untouched when it is already small enough.
 */
function fitWithin(img, maxLongest) {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxLongest) return img;
  const s = maxLongest / longest;
  return downscaleBox(img, Math.round(img.width * s), Math.round(img.height * s));
}

module.exports = { downscaleBox, fitWithin };
