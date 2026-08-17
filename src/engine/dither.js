"use strict";

/**
 * Dithering / bitmapping engine.
 *
 * This is the second rasteriser, sitting alongside halftone.js. Where halftone
 * varies the *size* of a dot per cell, dithering picks one palette colour per
 * pixel and distributes the resulting error so the eye integrates it back into
 * the original tone.
 *
 * Two families, both real:
 *
 *   ORDERED - a threshold matrix is tiled across the image and added to the
 *   pixel before quantisation. Stateless, so it parallelises and never smears;
 *   the matrix is what gives each variant its texture (Bayer's cross-hatch,
 *   clustered dots' newsprint grain, blue noise's isotropic sparkle).
 *
 *   ERROR DIFFUSION - each pixel is quantised, and the difference between what
 *   was wanted and what was available is pushed onto neighbours not yet visited.
 *   Sequential and self-correcting, which is why it holds detail far better than
 *   ordered dithering at the cost of directional artefacts. Serpentine scanning
 *   (alternating row direction) cancels most of those.
 *
 * RESOLUTION INDEPENDENCE
 * Dithering is inherently a pixel-level operation, so it is run on a grid of
 * "dither pixels" whose count is a parameter, then scaled to the output with
 * nearest-neighbour. That is what DPI-based scaling means in practice, it gives
 * the chunky bitmap look on purpose, and - like the halftone path - it means the
 * preview and the full-resolution render come from the same computation.
 */

const { rgbToOklab } = require("./color.js");

/* ================================================================== *
 * Ordered dithering: threshold matrices
 * ================================================================== */

/**
 * Bayer / recursive dispersed-dot matrix of size 2^n.
 * @param {number} n power of two exponent (1 -> 2x2, 2 -> 4x4, ...)
 * @returns {{size: number, data: Float32Array}} values normalised to (0,1)
 */
function bayerMatrix(n) {
  let m = [[0, 2], [3, 1]];
  for (let k = 1; k < n; k++) {
    const s = m.length;
    const next = [];
    for (let y = 0; y < s * 2; y++) next.push(new Array(s * 2).fill(0));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + s] = v + 2;
        next[y + s][x] = v + 3;
        next[y + s][x + s] = v + 1;
      }
    }
    m = next;
  }
  const size = m.length;
  const data = new Float32Array(size * size);
  const denom = size * size;
  for (let y = 0; y < size; y++) {
    // Thresholds sit at the CENTRE of their bin, not the bottom. A matrix with
    // L levels can only represent tone in steps of 1/L; centring halves the
    // worst-case error from 1/L to 1/(2L) at no cost, and it costs nothing to
    // get right. Every matrix builder below does the same.
    for (let x = 0; x < size; x++) data[y * size + x] = (m[y][x] + 0.5) / denom;
  }
  return { size, data };
}

/**
 * Clustered-dot matrix: thresholds grow outward from a centre, so ink gathers
 * into growing blobs. This is the ordered dither that most resembles a printed
 * halftone screen.
 */
function clusteredMatrix(size, angled) {
  const n = size * size;
  const cells = [];
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Toroidal distance to the cluster centre, optionally on a 45 degree
      // lattice which is what a real screen uses.
      const dx = Math.min(Math.abs(x - c), size - Math.abs(x - c));
      const dy = Math.min(Math.abs(y - c), size - Math.abs(y - c));
      const d = angled ? Math.abs(dx) + Math.abs(dy) : Math.sqrt(dx * dx + dy * dy);
      cells.push({ x, y, d, tie: (x * 7 + y * 13) % n });
    }
  }
  cells.sort((a, b) => a.d - b.d || a.tie - b.tie);
  const data = new Float32Array(n);
  cells.forEach((cell, i) => {
    data[cell.y * size + cell.x] = (i + 0.5) / n;
  });
  return { size, data };
}

/** A matrix built from a 1-D ramp, giving line screens. */
function lineMatrix(size, dir) {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let t;
      if (dir === "horizontal") t = y;
      else if (dir === "vertical") t = x;
      else t = (x + y) % size; // diagonal
      data[y * size + x] = (t + 0.5) / size;
    }
  }
  return { size, data };
}

/**
 * Blue-noise matrix via void-and-cluster (Ulichney).
 *
 * Blue noise has no low-frequency energy, so unlike Bayer it produces no visible
 * grid or cross-hatch - just an even, organic sparkle. Building it is a one-off
 * cost, so the result is cached.
 */
let _blueNoiseCache = null;
function blueNoiseMatrix(size = 64) {
  if (_blueNoiseCache && _blueNoiseCache.size === size) return _blueNoiseCache;

  const n = size * size;
  const binary = new Uint8Array(n);
  const filtered = new Float32Array(n);

  // Deterministic initial scatter: ~10% of pixels, from a fixed LCG.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const initialCount = Math.max(1, Math.round(n * 0.1));
  let placed = 0;
  while (placed < initialCount) {
    const i = Math.floor(rand() * n);
    if (!binary[i]) {
      binary[i] = 1;
      placed++;
    }
  }

  // Gaussian energy kernel, wrapped toroidally. sigma 1.5 is Ulichney's value.
  const R = Math.min(7, size >> 1);
  const sigma = 1.5;
  const kernel = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) });
    }
  }

  const recomputeAll = () => {
    filtered.fill(0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!binary[y * size + x]) continue;
        for (const k of kernel) {
          const yy = (y + k.dy + size) % size;
          const xx = (x + k.dx + size) % size;
          filtered[yy * size + xx] += k.w;
        }
      }
    }
  };

  const splat = (idx, sign) => {
    const y = (idx / size) | 0;
    const x = idx % size;
    for (const k of kernel) {
      const yy = (y + k.dy + size) % size;
      const xx = (x + k.dx + size) % size;
      filtered[yy * size + xx] += sign * k.w;
    }
  };

  const tightestCluster = () => {
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] && filtered[i] > bestV) {
        bestV = filtered[i];
        best = i;
      }
    }
    return best;
  };

  const largestVoid = () => {
    let best = -1;
    let bestV = Infinity;
    for (let i = 0; i < n; i++) {
      if (!binary[i] && filtered[i] < bestV) {
        bestV = filtered[i];
        best = i;
      }
    }
    return best;
  };

  recomputeAll();

  // Phase 1: relax the initial pattern until moving the tightest cluster into
  // the largest void is a no-op.
  for (let guard = 0; guard < n * 4; guard++) {
    const cluster = tightestCluster();
    binary[cluster] = 0;
    splat(cluster, -1);
    const voidIdx = largestVoid();
    if (voidIdx === cluster) {
      binary[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    binary[voidIdx] = 1;
    splat(voidIdx, 1);
  }

  const rank = new Int32Array(n).fill(-1);
  const prototype = Uint8Array.from(binary);

  // Phase 2: remove points one at a time, ranking downward.
  let count = placed;
  for (let r = count - 1; r >= 0; r--) {
    const cluster = tightestCluster();
    binary[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = r;
  }

  // Phase 3: re-add from the prototype, ranking upward.
  binary.set(prototype);
  recomputeAll();
  for (let r = count; r < n; r++) {
    const voidIdx = largestVoid();
    binary[voidIdx] = 1;
    splat(voidIdx, 1);
    rank[voidIdx] = r;
  }

  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = ((rank[i] < 0 ? 0 : rank[i]) + 0.5) / n;
  _blueNoiseCache = { size, data };
  return _blueNoiseCache;
}

/** Deterministic white noise matrix. */
function randomMatrix(size = 32) {
  const n = size * size;
  const data = new Float32Array(n);
  let seed = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    data[i] = (seed >>> 8) / 0xffffff;
  }
  return { size, data };
}

/* ================================================================== *
 * Error diffusion kernels
 * ================================================================== */

/**
 * Each kernel is a list of [dx, dy, weight]; weights are normalised on use.
 * dy = 0 entries must have dx > 0 (the pixel has not been visited yet).
 */
const DIFFUSION_KERNELS = {
  floydsteinberg: [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]],
  falsefloydsteinberg: [[1, 0, 3], [0, 1, 3], [1, 1, 2]],
  jarvis: [
    [1, 0, 7], [2, 0, 5],
    [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
    [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
  ],
  stucki: [
    [1, 0, 8], [2, 0, 4],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
    [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
  ],
  atkinson: [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]],
  burkes: [
    [1, 0, 8], [2, 0, 4],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
  ],
  sierra3: [
    [1, 0, 5], [2, 0, 3],
    [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2],
    [-1, 2, 2], [0, 2, 3], [1, 2, 2],
  ],
  sierra2: [
    [1, 0, 4], [2, 0, 3],
    [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1],
  ],
  sierralite: [[1, 0, 2], [-1, 1, 1], [0, 1, 1]],
  stevensonarce: [
    [2, 0, 32],
    [-3, 1, 12], [-1, 1, 26], [1, 1, 30], [3, 1, 16],
    [-2, 2, 12], [0, 2, 26], [2, 2, 12],
    [-3, 3, 5], [-1, 3, 12], [1, 3, 12], [3, 3, 5],
  ],
};

/**
 * Atkinson deliberately discards 25% of the error (its weights sum to 6/8),
 * which is why it blows out highlights and shadows into clean flat areas - the
 * classic early Macintosh look. Keep that; do not "fix" it.
 */
const KERNEL_TOTALS = {
  atkinson: 8,
};

/* ================================================================== *
 * Algorithm registry
 * ================================================================== */

/**
 * @typedef {object} DitherAlgorithm
 * @property {string} id
 * @property {string} label
 * @property {"ordered"|"diffusion"|"threshold"} family
 * @property {() => {size:number, data:Float32Array}} [matrix] lazily built
 * @property {string} [kernel]
 */

const _matrixCache = new Map();
function cachedMatrix(id, build) {
  if (!_matrixCache.has(id)) _matrixCache.set(id, build());
  return _matrixCache.get(id);
}

/** @type {DitherAlgorithm[]} */
const ALGORITHMS = [
  { id: "threshold", label: "Threshold", family: "threshold" },

  { id: "bayer2", label: "Bayer 2×2", family: "ordered", matrix: () => cachedMatrix("bayer2", () => bayerMatrix(1)) },
  { id: "bayer4", label: "Bayer 4×4", family: "ordered", matrix: () => cachedMatrix("bayer4", () => bayerMatrix(2)) },
  { id: "bayer8", label: "Bayer 8×8", family: "ordered", matrix: () => cachedMatrix("bayer8", () => bayerMatrix(3)) },
  { id: "bayer16", label: "Bayer 16×16", family: "ordered", matrix: () => cachedMatrix("bayer16", () => bayerMatrix(4)) },

  { id: "cluster4", label: "Clustered 4×4", family: "ordered", matrix: () => cachedMatrix("cluster4", () => clusteredMatrix(4, false)) },
  { id: "cluster6", label: "Clustered 6×6", family: "ordered", matrix: () => cachedMatrix("cluster6", () => clusteredMatrix(6, false)) },
  { id: "cluster8", label: "Clustered 8×8", family: "ordered", matrix: () => cachedMatrix("cluster8", () => clusteredMatrix(8, false)) },
  { id: "cluster45", label: "Clustered 45°", family: "ordered", matrix: () => cachedMatrix("cluster45", () => clusteredMatrix(8, true)) },

  { id: "lineh", label: "Line H", family: "ordered", matrix: () => cachedMatrix("lineh", () => lineMatrix(8, "horizontal")) },
  { id: "linev", label: "Line V", family: "ordered", matrix: () => cachedMatrix("linev", () => lineMatrix(8, "vertical")) },
  { id: "linediag", label: "Line 45°", family: "ordered", matrix: () => cachedMatrix("linediag", () => lineMatrix(8, "diagonal")) },

  { id: "bluenoise", label: "Blue Noise", family: "ordered", matrix: () => cachedMatrix("bluenoise", () => blueNoiseMatrix(64)) },
  { id: "whitenoise", label: "White Noise", family: "ordered", matrix: () => cachedMatrix("whitenoise", () => randomMatrix(32)) },

  { id: "floydsteinberg", label: "Floyd–Steinberg", family: "diffusion", kernel: "floydsteinberg" },
  { id: "falsefloydsteinberg", label: "False F–S", family: "diffusion", kernel: "falsefloydsteinberg" },
  { id: "jarvis", label: "Jarvis", family: "diffusion", kernel: "jarvis" },
  { id: "stucki", label: "Stucki", family: "diffusion", kernel: "stucki" },
  { id: "atkinson", label: "Atkinson", family: "diffusion", kernel: "atkinson" },
  { id: "burkes", label: "Burkes", family: "diffusion", kernel: "burkes" },
  { id: "sierra3", label: "Sierra 3", family: "diffusion", kernel: "sierra3" },
  { id: "sierra2", label: "Sierra 2", family: "diffusion", kernel: "sierra2" },
  { id: "sierralite", label: "Sierra Lite", family: "diffusion", kernel: "sierralite" },
  { id: "stevensonarce", label: "Stevenson–Arce", family: "diffusion", kernel: "stevensonarce" },
];

const ALGORITHM_IDS = ALGORITHMS.map((a) => a.id);
const ALGORITHM_BY_ID = Object.create(null);
for (const a of ALGORITHMS) ALGORITHM_BY_ID[a.id] = a;

function getAlgorithm(id) {
  return ALGORITHM_BY_ID[id] || ALGORITHM_BY_ID.floydsteinberg;
}

/** Grouped for the UI. */
const ALGORITHM_FAMILIES = [
  { id: "threshold", label: "None" },
  { id: "ordered", label: "Ordered" },
  { id: "diffusion", label: "Diffusion" },
];

/* ================================================================== *
 * The dither pass
 * ================================================================== */

/**
 * Nearest palette entry in OKLab, restricted to a range of indices.
 *
 * The candidate range is how tonal zone mapping is enforced: pass the slice of
 * the (luminance sorted) palette that this tonal zone owns.
 */
function nearestInRange(labPal, L, a, b, from, to) {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < to; i++) {
    const dL = L - labPal[i * 3];
    const dA = a - labPal[i * 3 + 1];
    const dB = b - labPal[i * 3 + 2];
    const d = dL * dL + dA * dA + dB * dB;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Best two-colour mix for a pixel.
 *
 * Naively adding the threshold matrix to the pixel value and then matching in
 * OKLab does NOT reproduce the right average: the perturbation is linear in
 * sRGB while the decision boundary sits wherever OKLab puts it, so a black to
 * white ramp comes out measurably light (0.84 ink where 0.94 was wanted) and
 * ordered dithering disagrees with error diffusion about exposure.
 *
 * Instead, pick the nearest palette entry A, then find the entry B whose segment
 * towards A best contains the pixel, and the mixing ratio t along it.
 * Emitting B for a fraction t of the pixels makes the *average* exactly the
 * best two-colour approximation, in the same space the error diffusion path
 * measures its error. Both families then agree on tone.
 *
 * For a two-colour palette this reduces to classic thresholding with the
 * correct crossover.
 *
 * @returns {number} t, the fraction of pixels that should take colour B
 */
function bestMix(palette, a, r, g, b, from, to, outB) {
  const ca = palette[a];
  let bestT = 0;
  let bestErr = Infinity;
  let bestJ = a;
  const pr = r - ca[0];
  const pg = g - ca[1];
  const pb = b - ca[2];

  for (let j = from; j < to; j++) {
    if (j === a) continue;
    const cb = palette[j];
    const dr = cb[0] - ca[0];
    const dg = cb[1] - ca[1];
    const db = cb[2] - ca[2];
    const denom = dr * dr + dg * dg + db * db;
    if (denom < 1e-6) continue;
    let t = (pr * dr + pg * dg + pb * db) / denom;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const er = pr - t * dr;
    const eg = pg - t * dg;
    const eb = pb - t * db;
    const err = er * er + eg * eg + eb * eb;
    if (err < bestErr) {
      bestErr = err;
      bestT = t;
      bestJ = j;
    }
  }
  outB[0] = bestJ;
  return bestT;
}

/**
 * Dither an image to palette indices.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 *        already graded and pre-processed
 * @param {object} opts
 * @param {Float32Array} opts.labPal   OKLab coordinates of the palette
 * @param {number[][]} opts.palette    rgb, sorted dark -> light
 * @param {string} opts.algorithm
 * @param {number} opts.strength       0 = no dithering (hard posterise), 1 = full
 * @param {boolean} opts.serpentine
 * @param {(L:number)=>number[]} [opts.zoneRange] tonal zone -> [from, to)
 * @returns {Uint8Array} one palette index per pixel
 */
function ditherToIndices(img, opts) {
  const { data, width: w, height: h } = img;
  const out = new Uint8Array(w * h);
  const labPal = opts.labPal;
  const paletteCount = labPal.length / 3;
  const algo = getAlgorithm(opts.algorithm);
  const strength = opts.strength === undefined ? 1 : opts.strength;
  const zoneRange = opts.zoneRange;
  const lab = [0, 0, 0];
  const bRef = [0];

  const rangeFor = (r, g, b) => {
    if (!zoneRange) return null;
    // Tonal zone is chosen from luminance, so a zone owns a contiguous slice of
    // the (already luminance sorted) palette.
    return zoneRange((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
  };

  if (algo.family === "threshold" || algo.family === "ordered") {
    const matrix = algo.family === "ordered" ? algo.matrix() : null;
    const msize = matrix ? matrix.size : 1;
    const mdata = matrix ? matrix.data : null;

    for (let y = 0; y < h; y++) {
      const mrow = matrix ? (y % msize) * msize : 0;
      let p = y * w * 4;
      for (let x = 0; x < w; x++, p += 4) {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const range = rangeFor(r, g, b);
        const from = range ? range[0] : 0;
        const to = range ? range[1] : paletteCount;

        rgbToOklab(r, g, b, lab);
        const a = nearestInRange(labPal, lab[0], lab[1], lab[2], from, to);
        if (!mdata) {
          out[y * w + x] = a;
          continue;
        }
        let t = bestMix(opts.palette, a, r, g, b, from, to, bRef);
        // strength 0 collapses the mix to its nearest end: a hard posterise
        // with no pattern at all. strength 1 is the true average.
        if (strength !== 1) t += ((t < 0.5 ? 0 : 1) - t) * (1 - strength);
        out[y * w + x] = mdata[mrow + (x % msize)] < t ? bRef[0] : a;
      }
    }
    return out;
  }

  /* ---- error diffusion ---- */

  const kernel = DIFFUSION_KERNELS[algo.kernel] || DIFFUSION_KERNELS.floydsteinberg;
  let total = KERNEL_TOTALS[algo.kernel];
  if (!total) {
    total = 0;
    for (const k of kernel) total += k[2];
  }
  const invTotal = 1 / total;
  const serpentine = opts.serpentine !== false;

  // Error accumulates in float RGB; a full-frame buffer keeps the code simple
  // and costs 12 bytes per pixel on a grid that is a few megapixels at most.
  const err = new Float32Array(w * h * 3);

  for (let y = 0; y < h; y++) {
    const rightward = !serpentine || y % 2 === 0;
    const xStart = rightward ? 0 : w - 1;
    const xEnd = rightward ? w : -1;
    const xStep = rightward ? 1 : -1;

    for (let x = xStart; x !== xEnd; x += xStep) {
      const i = y * w + x;
      const p = i * 4;
      const e = i * 3;
      const r = clamp255(data[p] + err[e] * strength);
      const g = clamp255(data[p + 1] + err[e + 1] * strength);
      const b = clamp255(data[p + 2] + err[e + 2] * strength);

      rgbToOklab(r, g, b, lab);
      const range = rangeFor(r, g, b);
      const idx = range
        ? nearestInRange(labPal, lab[0], lab[1], lab[2], range[0], range[1])
        : nearestInRange(labPal, lab[0], lab[1], lab[2], 0, paletteCount);
      out[i] = idx;

      const chosen = opts.palette[idx];
      const er = r - chosen[0];
      const eg = g - chosen[1];
      const eb = b - chosen[2];

      for (let k = 0; k < kernel.length; k++) {
        const kx = kernel[k][0] * xStep; // mirror the kernel on right-to-left rows
        const ky = kernel[k][1];
        const nx = x + kx;
        const ny = y + ky;
        if (nx < 0 || nx >= w || ny >= h) continue;
        const ne = (ny * w + nx) * 3;
        const wgt = kernel[k][2] * invTotal;
        err[ne] += er * wgt;
        err[ne + 1] += eg * wgt;
        err[ne + 2] += eb * wgt;
      }
    }
  }

  return out;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Expand palette indices to an RGBA image, scaling up with nearest-neighbour
 * so the bitmap stays crisp instead of being smoothed into mush.
 *
 * @param {Uint8Array} indices
 * @param {number} iw
 * @param {number} ih
 * @param {number[][]} palette   output colours (may differ from the matching
 *        palette: hue/saturation recolour after the fact, see pipeline.js)
 * @param {number} ow
 * @param {number} oh
 * @param {Uint8ClampedArray} [out]
 */
function indicesToRGBA(indices, iw, ih, palette, ow, oh, out, view) {
  // `view` renders a window of a larger virtual output, which is what zooming
  // is: ow/oh stay the *virtual* size so the nearest-neighbour mapping is
  // unchanged, and only the window is written. Without that, a zoomed view
  // would resample the grid differently and show different pixels.
  const vx = view ? view.x : 0;
  const vy = view ? view.y : 0;
  const bw = view ? view.width : ow;
  const bh = view ? view.height : oh;
  const buf = out || new Uint8ClampedArray(bw * bh * 4);
  const xMap = new Int32Array(bw);
  for (let x = 0; x < bw; x++) {
    xMap[x] = Math.min(iw - 1, Math.max(0, (((x + vx) * iw) / ow) | 0));
  }
  for (let y = 0; y < bh; y++) {
    const sy = Math.min(ih - 1, Math.max(0, (((y + vy) * ih) / oh) | 0));
    const srow = sy * iw;
    let p = y * bw * 4;
    for (let x = 0; x < bw; x++, p += 4) {
      const c = palette[indices[srow + xMap[x]]] || palette[0];
      buf[p] = c[0];
      buf[p + 1] = c[1];
      buf[p + 2] = c[2];
      buf[p + 3] = 255;
    }
  }
  return buf;
}

/**
 * Expand palette indices into one 8-bit coverage mask per palette entry, for
 * the colour-separated output. Nearest-neighbour, same mapping as above, so the
 * masks line up exactly with the composite.
 *
 * @returns {Uint8ClampedArray[]} one mask per palette entry
 */
function indicesToMasks(indices, iw, ih, paletteCount, ow, oh) {
  const masks = [];
  for (let i = 0; i < paletteCount; i++) masks.push(new Uint8ClampedArray(ow * oh));
  const xMap = new Int32Array(ow);
  for (let x = 0; x < ow; x++) xMap[x] = Math.min(iw - 1, ((x * iw) / ow) | 0);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(ih - 1, ((y * ih) / oh) | 0);
    const srow = sy * iw;
    const orow = y * ow;
    for (let x = 0; x < ow; x++) {
      const idx = indices[srow + xMap[x]];
      if (idx < paletteCount) masks[idx][orow + x] = 255;
    }
  }
  return masks;
}

module.exports = {
  ALGORITHMS,
  ALGORITHM_IDS,
  ALGORITHM_FAMILIES,
  getAlgorithm,
  ditherToIndices,
  indicesToRGBA,
  indicesToMasks,
  bayerMatrix,
  clusteredMatrix,
  lineMatrix,
  blueNoiseMatrix,
  randomMatrix,
  DIFFUSION_KERNELS,
};
