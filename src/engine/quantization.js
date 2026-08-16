"use strict";

/**
 * Colour quantisation.
 *
 * Three real algorithms are provided:
 *   - mediancut   : classic, fast, deterministic, good spatial coverage
 *   - kmeans      : median cut used as the seed, then Lloyd iterations in OKLab
 *   - popularity  : most frequent cells of a coarse RGB histogram
 *
 * `kmeans` is the default: seeding with median cut removes the usual random
 * initialisation lottery, and 8-12 iterations over a subsampled pixel set costs
 * a few milliseconds even for a 24 megapixel image while giving noticeably
 * cleaner, less muddy palettes than median cut alone.
 */

const { rgbToOklab, oklabToRgb, luma709 } = require("./color.js");

const DEFAULT_MAX_SAMPLES = 24000;

/**
 * Subsample an RGBA buffer into a flat Uint8Array of RGB triplets.
 * Fully transparent pixels are skipped so a cut-out layer does not drag the
 * palette towards black.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {number} [maxSamples]
 * @returns {Uint8Array} length = n*3
 */
function extractSamples(img, maxSamples = DEFAULT_MAX_SAMPLES) {
  const { data, width: w, height: h } = img;
  const total = w * h;
  const stride = Math.max(1, Math.floor(Math.sqrt(total / maxSamples)));
  const cols = Math.ceil(w / stride);
  const rows = Math.ceil(h / stride);
  const out = new Uint8Array(cols * rows * 3);
  let n = 0;
  for (let y = 0; y < h; y += stride) {
    let p = y * w * 4;
    for (let x = 0; x < w; x += stride) {
      const i = p + x * 4;
      if (data[i + 3] < 8) continue;
      out[n++] = data[i];
      out[n++] = data[i + 1];
      out[n++] = data[i + 2];
    }
  }
  return out.subarray(0, n);
}

/* ------------------------------------------------------------------ *
 * Median cut
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array} samples flat RGB triplets
 * @param {number} count target colour count
 * @returns {number[][]} palette as [r,g,b] arrays
 */
function medianCut(samples, count) {
  const n = samples.length / 3;
  if (n === 0) return [[0, 0, 0]];
  // Index array so we sort references rather than moving triplets around.
  let boxes = [{ idx: buildIndex(n), depth: 0 }];

  while (boxes.length < count) {
    // Split the box with the largest weighted extent.
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.idx.length < 2) continue;
      const ext = boxExtent(samples, b.idx);
      const score = ext.range * Math.log2(b.idx.length + 1);
      if (score > bestScore) {
        bestScore = score;
        best = i;
        b._axis = ext.axis;
      }
    }
    if (best < 0) break;

    const box = boxes[best];
    const axis = box._axis;
    const idx = box.idx;
    // Sort by the widest axis and split at the median.
    const arr = Array.from(idx);
    arr.sort((a, b) => samples[a * 3 + axis] - samples[b * 3 + axis]);
    const mid = arr.length >> 1;
    const left = Int32Array.from(arr.slice(0, mid));
    const right = Int32Array.from(arr.slice(mid));
    if (left.length === 0 || right.length === 0) break;
    boxes.splice(best, 1, { idx: left, depth: box.depth + 1 }, { idx: right, depth: box.depth + 1 });
  }

  return boxes.map((b) => boxMean(samples, b.idx));
}

function buildIndex(n) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return idx;
}

function boxExtent(samples, idx) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 3;
    const r = samples[p], g = samples[p + 1], b = samples[p + 2];
    if (r < rmin) rmin = r;
    if (r > rmax) rmax = r;
    if (g < gmin) gmin = g;
    if (g > gmax) gmax = g;
    if (b < bmin) bmin = b;
    if (b > bmax) bmax = b;
  }
  // Raw channel ranges. Weighting these by luminance coefficients (an obvious
  // looking "perceptual" tweak) makes the splitter almost blind to the blue
  // axis and collapses saturated blues into their neighbours, so don't.
  const rr = rmax - rmin;
  const gg = gmax - gmin;
  const bb = bmax - bmin;
  if (rr >= gg && rr >= bb) return { axis: 0, range: rr };
  if (gg >= bb) return { axis: 1, range: gg };
  return { axis: 2, range: bb };
}

function boxMean(samples, idx) {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i] * 3;
    r += samples[p];
    g += samples[p + 1];
    b += samples[p + 2];
  }
  const n = Math.max(1, idx.length);
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/* ------------------------------------------------------------------ *
 * k-means in OKLab, seeded by median cut
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array} samples flat RGB triplets
 * @param {number} count
 * @param {number} [iterations]
 * @returns {number[][]} palette
 */
function kmeans(samples, count, iterations = 10) {
  const n = samples.length / 3;
  if (n === 0) return [[0, 0, 0]];
  if (n <= count) return dedupe(triplets(samples));

  const seed = medianCut(samples, count);

  // Pre-convert every sample to OKLab once.
  const lab = new Float32Array(n * 3);
  const tmp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    rgbToOklab(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], tmp);
    lab[i * 3] = tmp[0];
    lab[i * 3 + 1] = tmp[1];
    lab[i * 3 + 2] = tmp[2];
  }

  const k = seed.length;
  const cent = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) {
    rgbToOklab(seed[i][0], seed[i][1], seed[i][2], tmp);
    cent[i * 3] = tmp[0];
    cent[i * 3 + 1] = tmp[1];
    cent[i * 3 + 2] = tmp[2];
  }

  const sums = new Float64Array(k * 3);
  const counts = new Uint32Array(k);
  const assign = new Int32Array(n);

  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    let moved = 0;
    // Track the worst-fitting sample so an empty cluster can be revived there.
    let farthestI = 0;
    let farthestD = -1;

    for (let i = 0; i < n; i++) {
      const L = lab[i * 3];
      const A = lab[i * 3 + 1];
      const B = lab[i * 3 + 2];
      let bestD = Infinity;
      let bestJ = 0;
      for (let j = 0; j < k; j++) {
        const dL = L - cent[j * 3];
        const dA = A - cent[j * 3 + 1];
        const dB = B - cent[j * 3 + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestD) {
          bestD = d;
          bestJ = j;
        }
      }
      if (bestD > farthestD) {
        farthestD = bestD;
        farthestI = i;
      }
      if (assign[i] !== bestJ) {
        assign[i] = bestJ;
        moved++;
      }
      sums[bestJ * 3] += L;
      sums[bestJ * 3 + 1] += A;
      sums[bestJ * 3 + 2] += B;
      counts[bestJ]++;
    }

    let revived = false;
    for (let j = 0; j < k; j++) {
      if (counts[j] === 0) {
        // A dead centroid silently shrinks the palette below the requested
        // colour count. Respawn it on the worst represented sample instead.
        cent[j * 3] = lab[farthestI * 3];
        cent[j * 3 + 1] = lab[farthestI * 3 + 1];
        cent[j * 3 + 2] = lab[farthestI * 3 + 2];
        revived = true;
        continue;
      }
      cent[j * 3] = sums[j * 3] / counts[j];
      cent[j * 3 + 1] = sums[j * 3 + 1] / counts[j];
      cent[j * 3 + 2] = sums[j * 3 + 2] / counts[j];
    }
    if (it > 0 && moved === 0 && !revived) break; // converged
  }

  const out = [];
  for (let j = 0; j < k; j++) {
    out.push(oklabToRgb(cent[j * 3], cent[j * 3 + 1], cent[j * 3 + 2]));
  }
  return out.length ? out : seed;
}

/* ------------------------------------------------------------------ *
 * Popularity (coarse histogram)
 * ------------------------------------------------------------------ */

function popularity(samples, count, bits = 4) {
  const n = samples.length / 3;
  if (n === 0) return [[0, 0, 0]];
  const shift = 8 - bits;
  const size = 1 << (bits * 3);
  const hist = new Uint32Array(size);
  const accR = new Float64Array(size);
  const accG = new Float64Array(size);
  const accB = new Float64Array(size);

  for (let i = 0; i < n; i++) {
    const r = samples[i * 3];
    const g = samples[i * 3 + 1];
    const b = samples[i * 3 + 2];
    const key = ((r >> shift) << (bits * 2)) | ((g >> shift) << bits) | (b >> shift);
    hist[key]++;
    accR[key] += r;
    accG[key] += g;
    accB[key] += b;
  }

  const used = [];
  for (let i = 0; i < size; i++) if (hist[i]) used.push(i);
  used.sort((a, b) => hist[b] - hist[a]);

  const out = [];
  for (let i = 0; i < used.length && out.length < count; i++) {
    const key = used[i];
    const c = hist[key];
    out.push([Math.round(accR[key] / c), Math.round(accG[key] / c), Math.round(accB[key] / c)]);
  }
  return out.length ? out : [[0, 0, 0]];
}

/* ------------------------------------------------------------------ */

function triplets(samples) {
  const out = [];
  for (let i = 0; i < samples.length; i += 3) out.push([samples[i], samples[i + 1], samples[i + 2]]);
  return out;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const METHODS = {
  kmeans: (samples, count) => kmeans(samples, count),
  mediancut: (samples, count) => medianCut(samples, count),
  popularity: (samples, count) => popularity(samples, count),
};

const METHOD_IDS = Object.keys(METHODS);

/**
 * @param {Uint8Array} samples
 * @param {number} count
 * @param {string} method
 * @returns {number[][]} palette sorted dark -> light
 */
function quantize(samples, count, method = "kmeans") {
  const fn = METHODS[method] || METHODS.kmeans;
  const pal = dedupe(fn(samples, Math.max(1, count | 0)));
  pal.sort((a, b) => luma709(a[0], a[1], a[2]) - luma709(b[0], b[1], b[2]));
  return pal;
}

module.exports = {
  extractSamples,
  medianCut,
  kmeans,
  popularity,
  quantize,
  METHODS,
  METHOD_IDS,
  DEFAULT_MAX_SAMPLES,
};
