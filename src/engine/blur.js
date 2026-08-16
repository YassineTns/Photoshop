"use strict";

/**
 * Fast separable blur.
 *
 * Three successive box passes converge to a very close approximation of a true
 * Gaussian (central limit theorem) at O(1) cost per pixel per pass, which keeps
 * 6000x4000 images usable. Box widths are derived with the standard
 * "boxes for Gauss" solution so the resulting sigma matches the request.
 */

/**
 * @param {number} sigma
 * @param {number} n number of boxes
 * @returns {number[]} odd box widths
 */
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/**
 * Horizontal box blur on one interleaved channel of an RGBA buffer.
 * `src` and `dst` are Float32Array(w*h) planes.
 */
function boxBlurH(src, dst, w, h, r) {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let ti = row;
    let li = row;
    let ri = row + r;
    const fv = src[row];
    const lv = src[row + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1)];
    for (let j = 0; j <= r; j++) {
      val += (ri < row + w ? src[ri] : lv) - fv;
      dst[ti] = val * iarr;
      ri++;
      ti++;
    }
    for (let j = r + 1; j < w - r; j++) {
      val += src[ri] - src[li];
      dst[ti] = val * iarr;
      ri++;
      li++;
      ti++;
    }
    for (let j = Math.max(r + 1, w - r); j < w; j++) {
      val += lv - (li < row + w ? src[li] : lv);
      dst[ti] = val * iarr;
      li++;
      ti++;
    }
  }
}

/** Vertical box blur on a Float32 plane. */
function boxBlurV(src, dst, w, h, r) {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let ti = x;
    let li = x;
    let ri = x + r * w;
    const fv = src[x];
    const lv = src[x + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[x + Math.min(j, h - 1) * w];
    for (let j = 0; j <= r; j++) {
      val += (ri < w * h ? src[ri] : lv) - fv;
      dst[ti] = val * iarr;
      ri += w;
      ti += w;
    }
    for (let j = r + 1; j < h - r; j++) {
      val += src[ri] - src[li];
      dst[ti] = val * iarr;
      ri += w;
      li += w;
      ti += w;
    }
    for (let j = Math.max(r + 1, h - r); j < h; j++) {
      val += lv - (li < w * h ? src[li] : lv);
      dst[ti] = val * iarr;
      li += w;
      ti += w;
    }
  }
}

/**
 * Gaussian-approximating blur of an RGBA buffer. Alpha is left untouched
 * (the halftone render is opaque, and blurring alpha would only bleed edges).
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {number} sigma in pixels
 * @returns {{data: Uint8ClampedArray, width: number, height: number}} new image
 */
function gaussianBlurRGBA(img, sigma) {
  const { width: w, height: h } = img;
  if (!(sigma > 0.05) || w < 2 || h < 2) {
    return { data: new Uint8ClampedArray(img.data), width: w, height: h };
  }
  const src = img.data;
  const n = w * h;
  const out = new Uint8ClampedArray(src.length);
  // Copy alpha straight through.
  for (let i = 3; i < src.length; i += 4) out[i] = src[i];

  const boxes = boxesForGauss(sigma, 3);
  // The sliding-window kernels assume the radius fits inside the image.
  const maxR = Math.max(0, Math.floor((Math.min(w, h) - 1) / 2));
  const a = new Float32Array(n);
  const b = new Float32Array(n);

  for (let c = 0; c < 3; c++) {
    for (let i = 0, p = c; i < n; i++, p += 4) a[i] = src[p];
    for (let k = 0; k < boxes.length; k++) {
      const r = Math.min((boxes[k] - 1) >> 1, maxR);
      boxBlurH(a, b, w, h, r);
      boxBlurV(b, a, w, h, r);
    }
    for (let i = 0, p = c; i < n; i++, p += 4) out[p] = a[i];
  }

  return { data: out, width: w, height: h };
}

module.exports = { gaussianBlurRGBA, boxesForGauss };
