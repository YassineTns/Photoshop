"use strict";

/**
 * Synthetic test images. Deterministic - no randomness that is not seeded, so
 * failures are always reproducible.
 */

function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  const px = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px[0] = px[1] = px[2] = 0;
      px[3] = 255;
      fn(x, y, px);
      const i = (y * w + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = px[3];
    }
  }
  return { data, width: w, height: h };
}

const solid = (w, h, r, g, b, a = 255) =>
  makeImage(w, h, (x, y, p) => {
    p[0] = r;
    p[1] = g;
    p[2] = b;
    p[3] = a;
  });

const black = (w, h) => solid(w, h, 0, 0, 0);
const white = (w, h) => solid(w, h, 255, 255, 255);

/** Horizontal black -> white ramp. */
const gradient = (w, h) =>
  makeImage(w, h, (x, y, p) => {
    const v = Math.round((x / (w - 1)) * 255);
    p[0] = p[1] = p[2] = v;
  });

/** Vertical bands of saturated flat colours. */
const flats = (w, h) => {
  const cols = [
    [230, 30, 40],
    [250, 200, 40],
    [30, 120, 220],
    [20, 20, 24],
    [245, 240, 225],
  ];
  return makeImage(w, h, (x, y, p) => {
    const c = cols[Math.min(cols.length - 1, Math.floor((x / w) * cols.length))];
    p[0] = c[0];
    p[1] = c[1];
    p[2] = c[2];
  });
};

/** A deterministic pseudo-random number generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A stand-in for a photograph: smooth low frequency lighting, a subject with a
 * different hue, some high frequency texture and a hard edge.
 */
const photo = (w, h, seed = 1234) => {
  const rand = rng(seed);
  const noise = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) noise[i] = rand();
  return makeImage(w, h, (x, y, p) => {
    const u = x / w;
    const v = y / h;
    // Broad lighting gradient.
    let l = 0.25 + 0.6 * (1 - v) + 0.2 * Math.sin(u * 6.283 * 1.5);
    // A round "subject".
    const dx = u - 0.42;
    const dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    let tint = [1, 1, 1];
    if (d < 0.26) {
      l = l * 0.55 + 0.18;
      tint = [1.25, 0.85, 0.72];
    }
    // Hard edge.
    if (u > 0.82) l *= 0.35;
    l += (noise[y * w + x] - 0.5) * 0.06;
    l = Math.max(0, Math.min(1, l));
    p[0] = Math.round(Math.min(255, l * 255 * tint[0]));
    p[1] = Math.round(Math.min(255, l * 255 * tint[1]));
    p[2] = Math.round(Math.min(255, l * 255 * tint[2]));
  });
};

/** Half opaque red, half fully transparent. */
const withAlpha = (w, h) =>
  makeImage(w, h, (x, y, p) => {
    p[0] = 220;
    p[1] = 40;
    p[2] = 40;
    p[3] = x < w / 2 ? 255 : 0;
  });

module.exports = { makeImage, solid, black, white, gradient, flats, photo, withAlpha, rng };
