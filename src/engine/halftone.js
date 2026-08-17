"use strict";

/**
 * The halftone core: grid construction, cell sampling and antialiased
 * rasterisation.
 *
 * The pipeline is split so that the only work proportional to the pixel count
 * is (a) the optional blur and (b) one sampling pass. Everything downstream -
 * grading, palette, hue/saturation, radius mapping - operates on cell averages,
 * i.e. on a few thousand values instead of tens of millions. See pipeline.js.
 */

const { getLumaFn, adjustColor } = require("./color.js");
const { dotJitter, isIdentity: jitterIsIdentity } = require("./jitter.js");
const { buildToneLUT, sampleLUT, biasCurve, inkToRadius } = require("./grade.js");
const { getShape } = require("./shapes.js");
const { paletteToLab, nearestIndex } = require("./palette.js");

/**
 * @typedef {object} Grid
 * @property {number} cell   cell size in pixels (float)
 * @property {number} cols
 * @property {number} rows
 * @property {number} cos
 * @property {number} sin
 * @property {number} gminX  grid-space origin
 * @property {number} gminY
 * @property {number} cx     image centre
 * @property {number} cy
 */

/**
 * Build the sampling grid.
 *
 * `density` is expressed as "cells across the longest edge", which makes every
 * parameter resolution independent: the low-res preview and the full-res render
 * produce the same picture, just at different pixel counts.
 *
 * @param {number} w
 * @param {number} h
 * @param {number} density
 * @param {number} angleDeg
 * @returns {Grid}
 */
function computeGrid(w, h, density, angleDeg) {
  const maxDim = Math.max(w, h);
  const cell = Math.max(1.2, maxDim / Math.max(1, density));
  const a = ((angleDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;

  let gminX = Infinity, gmaxX = -Infinity, gminY = Infinity, gmaxY = -Infinity;
  const corners = [[0, 0], [w, 0], [0, h], [w, h]];
  for (const [px, py] of corners) {
    const dx = px - cx;
    const dy = py - cy;
    const gx = dx * cos + dy * sin;
    const gy = -dx * sin + dy * cos;
    if (gx < gminX) gminX = gx;
    if (gx > gmaxX) gmaxX = gx;
    if (gy < gminY) gminY = gy;
    if (gy > gmaxY) gmaxY = gy;
  }

  const cols = Math.max(1, Math.ceil((gmaxX - gminX) / cell));
  const rows = Math.max(1, Math.ceil((gmaxY - gminY) / cell));
  // Centre the grid on the image so the dot pattern is symmetric.
  gminX -= (cols * cell - (gmaxX - gminX)) / 2;
  gminY -= (rows * cell - (gmaxY - gminY)) / 2;

  return { cell, cols, rows, cos, sin, gminX, gminY, cx, cy, w, h };
}

/**
 * Re-express a grid in the coordinate system of a different output size.
 *
 * Column and row counts are preserved exactly, which is what guarantees the
 * preview and the full resolution render describe the identical dot layout -
 * they are literally the same cells, just scaled.
 *
 * @param {Grid} g
 * @param {number} width
 * @param {number} height
 * @returns {Grid}
 */
function scaleGrid(g, width, height) {
  if (width === g.w && height === g.h) return g;
  const scale = Math.max(width, height) / Math.max(g.w, g.h);
  return {
    cell: g.cell * scale,
    cols: g.cols,
    rows: g.rows,
    cos: g.cos,
    sin: g.sin,
    gminX: g.gminX * scale,
    gminY: g.gminY * scale,
    cx: width / 2,
    cy: height / 2,
    w: width,
    h: height,
  };
}

/**
 * Grid-space cell centre back-projected into image space.
 * @param {Grid} g
 */
function cellCentre(g, col, row, out) {
  const gx = g.gminX + (col + 0.5) * g.cell;
  const gy = g.gminY + (row + 0.5) * g.cell;
  const res = out || [0, 0];
  res[0] = g.cx + gx * g.cos - gy * g.sin;
  res[1] = g.cy + gx * g.sin + gy * g.cos;
  return res;
}

/**
 * @typedef {object} CellData
 * @property {Float32Array} lum   raw mean luminance per cell, 0..1
 * @property {Float32Array} rgb   mean colour per cell, 3 floats per cell, 0..255
 * @property {Uint32Array}  count opaque pixel count per cell
 * @property {Grid} grid
 */

/**
 * Single pass over the pixels: assign every pixel to its cell and accumulate
 * luminance and colour. This is the only O(width*height) step besides blur.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {Grid} grid
 * @param {string} lumaMode
 * @param {{yStart?: number, yEnd?: number, acc?: CellData}} [opts] for chunking
 * @returns {CellData}
 */
function sampleCells(img, grid, lumaMode, opts = {}) {
  const { data, width: w, height: h } = img;
  const n = grid.cols * grid.rows;
  const acc =
    opts.acc || {
      lum: new Float32Array(n),
      rgb: new Float32Array(n * 3),
      count: new Uint32Array(n),
      grid,
      lumaMode,
    };
  const lumaFn = getLumaFn(lumaMode);
  const { cell, cols, rows, cos, sin, gminX, gminY, cx, cy } = grid;
  const invCell = 1 / cell;
  const lum = acc.lum;
  const rgb = acc.rgb;
  const count = acc.count;

  const yStart = opts.yStart || 0;
  const yEnd = opts.yEnd === undefined ? h : Math.min(h, opts.yEnd);

  for (let y = yStart; y < yEnd; y++) {
    const dy = y + 0.5 - cy;
    const dx0 = 0.5 - cx;
    let gx = dx0 * cos + dy * sin;
    let gy = -dx0 * sin + dy * cos;
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4, gx += cos, gy -= sin) {
      if (data[p + 3] < 8) continue;
      let col = ((gx - gminX) * invCell) | 0;
      let row = ((gy - gminY) * invCell) | 0;
      if (col < 0) col = 0;
      else if (col >= cols) col = cols - 1;
      if (row < 0) row = 0;
      else if (row >= rows) row = rows - 1;
      const ci = row * cols + col;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      lum[ci] += lumaFn(r, g, b);
      const q = ci * 3;
      rgb[q] += r;
      rgb[q + 1] += g;
      rgb[q + 2] += b;
      count[ci]++;
    }
  }
  return acc;
}

/**
 * Refine cell means so a cell straddling an edge reports the tone of whichever
 * side dominates it, instead of a grey average of both.
 *
 * One mean-shift iteration: re-average, weighting each pixel by how close it is
 * to the cell's current mean colour. Cells inside a flat area barely move; cells
 * on a hard edge snap to the majority side. That is what stops dots hovering at
 * half size all along a contour, which is the main source of ragged edges at low
 * density.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img
 * @param {Grid} grid
 * @param {CellData} cells modified in place
 * @param {number} [strength] 0..1
 */
function refineCellsEdgeAware(img, grid, cells, strength = 1) {
  const { data, width: w, height: h } = img;
  const n = grid.cols * grid.rows;
  const { cell, cols, rows, cos, sin, gminX, gminY, cx, cy } = grid;
  const invCell = 1 / cell;

  // Current means, as the reference each pixel is weighted against.
  const meanR = new Float32Array(n);
  const meanG = new Float32Array(n);
  const meanB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cells.count[i];
    if (!c) continue;
    meanR[i] = cells.rgb[i * 3] / c;
    meanG[i] = cells.rgb[i * 3 + 1] / c;
    meanB[i] = cells.rgb[i * 3 + 2] / c;
  }

  const lumW = new Float32Array(n);
  const rgbW = new Float32Array(n * 3);
  const wSum = new Float32Array(n);
  const lumaFn = getLumaFn(cells.lumaMode);
  // Tolerance in squared RGB distance. Generous enough that noise does not
  // fragment a flat cell, tight enough that a real edge splits.
  const sigma2 = 3 * 48 * 48;

  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dx0 = 0.5 - cx;
    let gx = dx0 * cos + dy * sin;
    let gy = -dx0 * sin + dy * cos;
    let p = y * w * 4;
    for (let x = 0; x < w; x++, p += 4, gx += cos, gy -= sin) {
      if (data[p + 3] < 8) continue;
      let col = ((gx - gminX) * invCell) | 0;
      let row = ((gy - gminY) * invCell) | 0;
      if (col < 0) col = 0;
      else if (col >= cols) col = cols - 1;
      if (row < 0) row = 0;
      else if (row >= rows) row = rows - 1;
      const ci = row * cols + col;

      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const dr = r - meanR[ci];
      const dg = g - meanG[ci];
      const db = b - meanB[ci];
      const wgt = Math.exp(-(dr * dr + dg * dg + db * db) / sigma2);

      lumW[ci] += lumaFn(r, g, b) * wgt;
      const q = ci * 3;
      rgbW[q] += r * wgt;
      rgbW[q + 1] += g * wgt;
      rgbW[q + 2] += b * wgt;
      wSum[ci] += wgt;
    }
  }

  const s = Math.max(0, Math.min(1, strength));
  for (let i = 0; i < n; i++) {
    const c = cells.count[i];
    if (!c || wSum[i] < 1e-6) continue;
    // Blend towards the refined mean, expressed back in "sum over count" form
    // so the rest of the pipeline keeps working unchanged.
    const k = c / wSum[i];
    cells.lum[i] = cells.lum[i] * (1 - s) + lumW[i] * k * s;
    for (let ch = 0; ch < 3; ch++) {
      cells.rgb[i * 3 + ch] = cells.rgb[i * 3 + ch] * (1 - s) + rgbW[i * 3 + ch] * k * s;
    }
  }
  return cells;
}

/**
 * @typedef {object} RasterParams
 * @property {number} radius        percent of the cell half size, 0..200
 * @property {string} shape
 * @property {number} gradeBias     -1..1
 * @property {number} radiusCurve   0..1
 * @property {boolean} invert
 * @property {Float32Array} toneLUT
 * @property {number[][]} palette   already spread + colour adjusted
 * @property {number[]} background  rgb
 * @property {object} colorAdjust   {hue, saturation, brightness}
 */

/**
 * Turn cell data into pixels.
 *
 * @param {CellData} cells
 * @param {RasterParams} p
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} [out] reused RGBA buffer
 * @param {{rowStart?: number, rowEnd?: number, skipBackground?: boolean}} [chunk]
 * @returns {Uint8ClampedArray}
 */
function rasterize(cells, p, width, height, out, chunk = {}) {
  const grid = cells.grid;
  const buf = out || new Uint8ClampedArray(width * height * 4);

  if (!chunk.skipBackground) fillBackground(buf, p.background);

  const shape = getShape(p.shape);
  const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
  const gain = (grid.cell * (p.dotGain || 0)) / 100;
  const labPal = paletteToLab(p.palette);
  const centre = [0, 0];
  const adj = p.colorAdjust || {};
  const adjOut = [0, 0, 0];
  const jit = p.jitter && !jitterIsIdentity(p.jitter) ? p.jitter : null;
  const jOut = [0, 0, 1, 0];
  const fm = p.screenType === "fm" ? p.fmThreshold : null;
  const cellColor = p.cellColor || null;

  const rowStart = chunk.rowStart || 0;
  const rowEnd = chunk.rowEnd === undefined ? grid.rows : Math.min(grid.rows, chunk.rowEnd);

  for (let row = rowStart; row < rowEnd; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const ci = row * grid.cols + col;
      const cnt = cells.count[ci];
      if (cnt === 0) continue;

      // --- geometry: luminance -> grade -> ink -> radius --------------
      const L = cells.lum[ci] / cnt;
      const graded = sampleLUT(p.toneLUT, L);
      let ink = p.invert ? graded : 1 - graded;
      ink = biasCurve(ink, p.gradeBias);
      let r;
      if (fm) {
        // Frequency modulation: every dot is the same size and the *number* of
        // them carries the tone. Comparing the ink against a blue-noise
        // threshold is what places them - blue noise because it has no
        // low-frequency energy, so the result reads as an even grain rather
        // than as a pattern.
        if (ink <= fm(col, row)) continue;
        r = maxRadius;
      } else {
        r = inkToRadius(ink, maxRadius, p.radiusCurve);
        if (r <= 0.008) continue;
      }
      // Dot gain models a press spreading ink by a fixed width around every
      // edge, which is a radius offset - not a tonal curve like Grade Bias.
      r += gain;

      // --- colour: cell mean -> hue/sat/bright -> nearest palette -----
      // The pipeline caches this per cell, because it depends on none of the
      // geometry controls; computing it here is the fallback for callers that
      // do not (the SVG exporter, and any direct use of the rasteriser).
      let pi;
      if (cellColor) {
        pi = cellColor[ci];
      } else {
        const q = ci * 3;
        adjustColor(cells.rgb[q] / cnt, cells.rgb[q + 1] / cnt, cells.rgb[q + 2] / cnt, adj, adjOut);
        pi = nearestIndex(labPal, adjOut[0], adjOut[1], adjOut[2]);
      }
      const col3 = p.palette[pi];

      cellCentre(grid, col, row, centre);
      let rot = 0;
      if (jit) {
        dotJitter(col, row, jit, grid.cell, jOut);
        centre[0] += jOut[0];
        centre[1] += jOut[1];
        r *= jOut[2];
        rot = jOut[3];
        if (r <= 0.008) continue;
      }
      drawDot(buf, width, height, centre[0], centre[1], r, grid.cell, shape, col3, rot);
    }
  }

  return buf;
}

/**
 * @typedef {object} Screen
 * @property {Grid} grid
 * @property {Float32Array} cov    ink coverage per cell, 0..1
 * @property {Uint32Array} count   opaque pixel count per cell
 * @property {number[]} color      ink colour, rgb
 * @property {number} paletteIndex index into the full palette
 */

/**
 * Rasterise a set of independently angled ink screens, overprinting them.
 *
 * This is the difference between a poster and a print. Each ink gets its own
 * grid at its own angle and the inks composite by *multiply*, because real ink
 * is transparent: cyan over magenta gives blue, and the offset screens interlock
 * into a rosette instead of beating into a moiré.
 *
 * @param {Screen[]} screens
 * @param {object} p {radius, shape, radiusCurve, dotGain, background}
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray} [out]
 * @param {{screenStart?: number, screenEnd?: number, skipBackground?: boolean}} [chunk]
 */
function rasterizeScreens(screens, p, width, height, out, chunk = {}) {
  const buf = out || new Uint8ClampedArray(width * height * 4);
  if (!chunk.skipBackground) fillBackground(buf, p.background);

  const shape = getShape(p.shape);
  const centre = [0, 0];
  const first = chunk.screenStart || 0;
  const last = chunk.screenEnd === undefined ? screens.length : Math.min(screens.length, chunk.screenEnd);

  const jit = p.jitter && !jitterIsIdentity(p.jitter) ? p.jitter : null;
  const jOut = [0, 0, 1, 0];
  const fm = p.screenType === "fm" ? p.fmThreshold : null;

  for (let s = first; s < last; s++) {
    const screen = screens[s];
    const grid = screen.grid;
    const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
    const gain = (grid.cell * (p.dotGain || 0)) / 100;
    const colour = screen.color;
    // Misregistration: the whole plate lands a hair off, so it is a constant
    // offset for the screen rather than per-dot noise.
    const mx = screen.offsetX || 0;
    const my = screen.offsetY || 0;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const ci = row * grid.cols + col;
        if (screen.count[ci] === 0) continue;
        let r;
        if (fm) {
          if (screen.cov[ci] <= fm(col, row + s * 97)) continue;
          r = maxRadius;
        } else {
          r = inkToRadius(screen.cov[ci], maxRadius, p.radiusCurve);
          if (r <= 0.008) continue;
        }
        r += gain;
        cellCentre(grid, col, row, centre);
        centre[0] += mx;
        centre[1] += my;
        let rot = 0;
        if (jit) {
          dotJitter(col, row + s * 31, jit, grid.cell, jOut);
          centre[0] += jOut[0];
          centre[1] += jOut[1];
          r *= jOut[2];
          rot = jOut[3];
          if (r <= 0.008) continue;
        }
        drawDotMultiply(buf, width, height, centre[0], centre[1], r, grid.cell, shape, colour, rot);
      }
    }
  }
  return buf;
}

/**
 * Draw one transparent-ink dot: `out = out · (1 − a + a·ink)`.
 *
 * The lerp is between "leave the pixel alone" and "multiply it by the ink", so
 * partial coverage from the antialiasing band behaves exactly like partial ink
 * area, which is what keeps overprints clean at the dot edges.
 */
function drawDotMultiply(buf, w, h, cx, cy, r, cell, shape, colour, rot) {
  const rc = rot ? Math.cos(-rot) : 1;
  const rs = rot ? Math.sin(-rot) : 0;
  const ir = colour[0] / 255;
  const ig = colour[1] / 255;
  const ib = colour[2] / 255;

  const apply = (x, y, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
    const i = (y * w + x) * 4;
    buf[i] = buf[i] * (1 - a + a * ir);
    buf[i + 1] = buf[i + 1] * (1 - a + a * ig);
    buf[i + 2] = buf[i + 2] * (1 - a + a * ib);
    buf[i + 3] = 255;
  };

  if (r < 0.5) {
    const area = Math.min(1, shape.area(r, cell));
    if (area <= 0.0005) return;
    const fx = cx - 0.5;
    const fy = cy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    apply(x0, y0, area * (1 - tx) * (1 - ty));
    apply(x0 + 1, y0, area * tx * (1 - ty));
    apply(x0, y0 + 1, area * (1 - tx) * ty);
    apply(x0 + 1, y0 + 1, area * tx * ty);
    return;
  }

  const ext = shape.extent(r, cell) + 1;
  const x0 = Math.max(0, Math.floor(cx - ext));
  const x1 = Math.min(w, Math.ceil(cx + ext));
  const y0 = Math.max(0, Math.floor(cy - ext));
  const y1 = Math.min(h, Math.ceil(cy + ext));
  const sdf = shape.sdf;
  for (let y = y0; y < y1; y++) {
    const dy0 = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const dx0 = x + 0.5 - cx;
      const dx = rot ? dx0 * rc - dy0 * rs : dx0;
      const dy = rot ? dx0 * rs + dy0 * rc : dy0;
      const d = sdf(dx, dy, r, cell);
      if (d >= 0.5) continue;
      apply(x, y, d <= -0.5 ? 1 : 0.5 - d);
    }
  }
}

/**
 * One coverage mask per ink screen, for the separated output.
 *
 * Unlike the opaque model these masks are NOT mutually exclusive - overlapping
 * is the whole point of a rosette - so the fill layers they feed must be set to
 * Multiply, and the paper layer stays fully opaque underneath.
 *
 * @returns {Uint8ClampedArray[]} one mask per screen, in screen order
 */
function rasterizeScreensSeparated(screens, p, width, height) {
  const shape = getShape(p.shape);
  const centre = [0, 0];
  const masks = [];

  for (const screen of screens) {
    const mask = new Uint8ClampedArray(width * height);
    const grid = screen.grid;
    const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
    const gain = (grid.cell * (p.dotGain || 0)) / 100;

    const paint = (x, y, a) => {
      if (x < 0 || y < 0 || x >= w0 || y >= h0 || a <= 0) return;
      const i = y * w0 + x;
      // Coverage accumulates, it does not replace: two dots of the same ink
      // overlapping are still that ink.
      const v = mask[i] / 255;
      mask[i] = (v + a * (1 - v)) * 255;
    };
    const w0 = width;
    const h0 = height;

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const ci = row * grid.cols + col;
        if (screen.count[ci] === 0) continue;
        let r = inkToRadius(screen.cov[ci], maxRadius, p.radiusCurve);
        if (r <= 0.008) continue;
        r += gain;
        cellCentre(grid, col, row, centre);
        stampCoverage(paint, centre[0], centre[1], r, grid.cell, shape);
      }
    }
    masks.push(mask);
  }
  return masks;
}

/** Shared traversal for coverage stamping, used by the separated screens path. */
function stampCoverage(paint, cx, cy, r, cell, shape) {
  if (r < 0.5) {
    const area = Math.min(1, shape.area(r, cell));
    if (area <= 0.0005) return;
    const fx = cx - 0.5;
    const fy = cy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    paint(x0, y0, area * (1 - tx) * (1 - ty));
    paint(x0 + 1, y0, area * tx * (1 - ty));
    paint(x0, y0 + 1, area * (1 - tx) * ty);
    paint(x0 + 1, y0 + 1, area * tx * ty);
    return;
  }
  const ext = shape.extent(r, cell) + 1;
  const sdf = shape.sdf;
  for (let y = Math.floor(cy - ext); y <= Math.ceil(cy + ext); y++) {
    const dy = y + 0.5 - cy;
    for (let x = Math.floor(cx - ext); x <= Math.ceil(cx + ext); x++) {
      const d = sdf(x + 0.5 - cx, dy, r, cell);
      if (d >= 0.5) continue;
      paint(x, y, d <= -0.5 ? 1 : 0.5 - d);
    }
  }
}

/**
 * Rasterise into one 8-bit coverage mask per palette entry instead of a
 * composite, for the colour-separated output.
 *
 * The masks are mutually exclusive and sum to 255 everywhere: painting colour i
 * with coverage a does `mask_i = mask_i(1-a) + 255a` and `mask_j *= (1-a)` for
 * every other j. That is ordinary alpha compositing performed per channel, so
 * the separation reproduces the flat render exactly *and* is independent of the
 * order the fill layers end up stacked in - which matters, because dots of
 * different colours overlap and layer order would otherwise decide the result.
 *
 * @param {CellData} cells
 * @param {RasterParams} p    p.palette is the full palette; p.paperIndex is the
 *                            entry the paper uses
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray[]} one mask per palette entry
 */
function rasterizeSeparated(cells, p, width, height) {
  const grid = cells.grid;
  // One mask per FULL palette entry (p.palette holds only the inks).
  const n = p.fullPalette.length;
  const masks = [];
  for (let i = 0; i < n; i++) masks.push(new Uint8ClampedArray(width * height));
  // The paper starts covering everything; ink eats into it.
  const paper = masks[p.paperIndex];
  paper.fill(255);

  const shape = getShape(p.shape);
  const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
  const gain = (grid.cell * (p.dotGain || 0)) / 100;
  const labPal = paletteToLab(p.inkPalette);
  const centre = [0, 0];
  const adj = p.colorAdjust || {};
  const adjOut = [0, 0, 0];

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const ci = row * grid.cols + col;
      const cnt = cells.count[ci];
      if (cnt === 0) continue;

      const L = cells.lum[ci] / cnt;
      const graded = sampleLUT(p.toneLUT, L);
      let ink = p.invert ? graded : 1 - graded;
      ink = biasCurve(ink, p.gradeBias);
      let r = inkToRadius(ink, maxRadius, p.radiusCurve);
      if (r <= 0.008) continue;
      r += gain;

      const q = ci * 3;
      adjustColor(cells.rgb[q] / cnt, cells.rgb[q + 1] / cnt, cells.rgb[q + 2] / cnt, adj, adjOut);
      const inkIdx = nearestIndex(labPal, adjOut[0], adjOut[1], adjOut[2]);
      const target = p.inkToPaletteIndex[inkIdx];

      cellCentre(grid, col, row, centre);
      drawDotMasks(masks, width, height, centre[0], centre[1], r, grid.cell, shape, target);
    }
  }
  return masks;
}

/**
 * Mask-writing twin of drawDot. The traversal is duplicated rather than shared
 * behind a callback because a per-pixel indirect call costs more than the whole
 * coverage computation.
 */
function drawDotMasks(masks, w, h, cx, cy, r, cell, shape, target) {
  const n = masks.length;

  const paint = (x, y, a) => {
    if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
    const i = y * w + x;
    const ia = 1 - a;
    for (let m = 0; m < n; m++) {
      masks[m][i] = m === target ? masks[m][i] * ia + 255 * a : masks[m][i] * ia;
    }
  };

  if (r < 0.5) {
    const area = Math.min(1, shape.area(r, cell));
    if (area <= 0.0005) return;
    const fx = cx - 0.5;
    const fy = cy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    paint(x0, y0, area * (1 - tx) * (1 - ty));
    paint(x0 + 1, y0, area * tx * (1 - ty));
    paint(x0, y0 + 1, area * (1 - tx) * ty);
    paint(x0 + 1, y0 + 1, area * tx * ty);
    return;
  }

  const ext = shape.extent(r, cell) + 1;
  let x0 = Math.max(0, Math.floor(cx - ext));
  let x1 = Math.min(w, Math.ceil(cx + ext));
  let y0 = Math.max(0, Math.floor(cy - ext));
  let y1 = Math.min(h, Math.ceil(cy + ext));
  const sdf = shape.sdf;
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x < x1; x++) {
      const d = sdf(x + 0.5 - cx, dy, r, cell);
      if (d >= 0.5) continue;
      paint(x, y, d <= -0.5 ? 1 : 0.5 - d);
    }
  }
}

/**
 * Paint the paper colour across the whole frame.
 *
 * Written once as a short seed run and then doubled with `copyWithin`, which is
 * a memmove rather than a JS loop: each pass moves twice as many bytes as the
 * last, so the whole buffer is filled in log2(n) native block copies instead of
 * n/4 interpreted iterations.
 *
 * This is worth the trickery because it is not a marginal cost. On a 6000x4000
 * render the naive per-pixel loop was 95ms of a 223ms render - 43% of the total,
 * spent writing a colour that is about to be covered up. Measured on the same
 * 96MB buffer: naive 65ms, this 10ms.
 *
 * The doubling form is used rather than filling a Uint32Array view, which is
 * just as fast, because packing RGBA into one word assumes little-endian byte
 * order and this does not.
 */
function fillBackground(buf, bg) {
  const n = buf.length;
  if (n === 0) return;
  const r = bg[0], g = bg[1], b = bg[2];

  // Seed: one block of whole pixels, then double until the buffer is full.
  const seed = Math.min(n, 256);
  for (let i = 0; i < seed; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  let filled = seed;
  while (filled < n) {
    const take = Math.min(filled, n - filled);
    buf.copyWithin(filled, 0, take);
    filled += take;
  }
}

/**
 * Draw a single antialiased dot.
 *
 * Two regimes:
 *  - r >= 0.5px : signed distance field coverage, 1px transition band.
 *  - r <  0.5px : the dot is smaller than a pixel, so its exact analytic area
 *    is splatted bilinearly onto the 4 neighbouring pixels. Without this the
 *    highlight end of a gradient would clamp to a fixed half-covered pixel and
 *    the ramp would visibly stop being smooth.
 */
function drawDot(buf, w, h, cx, cy, r, cell, shape, colour, rot) {
  const cr = colour[0], cg = colour[1], cb = colour[2];
  const rc = rot ? Math.cos(-rot) : 1;
  const rs = rot ? Math.sin(-rot) : 0;

  if (r < 0.5) {
    const area = Math.min(1, shape.area(r, cell));
    if (area <= 0.0005) return;
    const fx = cx - 0.5;
    const fy = cy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    blend(buf, w, h, x0, y0, area * (1 - tx) * (1 - ty), cr, cg, cb);
    blend(buf, w, h, x0 + 1, y0, area * tx * (1 - ty), cr, cg, cb);
    blend(buf, w, h, x0, y0 + 1, area * (1 - tx) * ty, cr, cg, cb);
    blend(buf, w, h, x0 + 1, y0 + 1, area * tx * ty, cr, cg, cb);
    return;
  }

  const ext = shape.extent(r, cell) + 1;
  let x0 = Math.floor(cx - ext);
  let x1 = Math.ceil(cx + ext);
  let y0 = Math.floor(cy - ext);
  let y1 = Math.ceil(cy + ext);
  if (x1 < 0 || y1 < 0 || x0 >= w || y0 >= h) return;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w) x1 = w;
  if (y1 > h) y1 = h;

  const sdf = shape.sdf;
  // The interior fast path only applies to an unrotated dot: a span is a
  // horizontal run, and rotating the sampling frame is exactly what stops the
  // interior being horizontal.
  const span = rot ? null : shape.span;

  for (let y = y0; y < y1; y++) {
    const dy0 = y + 0.5 - cy;
    const rowBase = y * w * 4;

    // Split the row into [x0, inA) edge, [inA, inB) interior, [inB, x1) edge.
    // Everything in the interior is fully covered by definition of `span`, so
    // it is a straight store with no distance evaluation and no blend. On a
    // 13px dot that is roughly three quarters of its pixels.
    let inA = x1;
    let inB = x1;
    if (span) {
      const sp = span(dy0, r, cell);
      if (sp > 0) {
        const a = Math.ceil(cx - sp - 0.5);
        const b = Math.floor(cx + sp - 0.5) + 1;
        inA = a < x0 ? x0 : a > x1 ? x1 : a;
        inB = b < inA ? inA : b > x1 ? x1 : b;
      }
    }

    let i = rowBase + x0 * 4;
    for (let x = x0; x < inA; x++, i += 4) {
      const dx0 = x + 0.5 - cx;
      // Rotate the sample point, not the shape: a rotated dot is the same
      // signed distance field read in a turned frame.
      const dx = rot ? dx0 * rc - dy0 * rs : dx0;
      const dy = rot ? dx0 * rs + dy0 * rc : dy0;
      const d = sdf(dx, dy, r, cell);
      if (d >= 0.5) continue;
      const a = d <= -0.5 ? 1 : 0.5 - d;
      if (a >= 0.999) {
        buf[i] = cr;
        buf[i + 1] = cg;
        buf[i + 2] = cb;
        buf[i + 3] = 255;
      } else {
        const ia = 1 - a;
        buf[i] = cr * a + buf[i] * ia;
        buf[i + 1] = cg * a + buf[i + 1] * ia;
        buf[i + 2] = cb * a + buf[i + 2] * ia;
        buf[i + 3] = 255;
      }
    }

    i = rowBase + inA * 4;
    for (let x = inA; x < inB; x++, i += 4) {
      buf[i] = cr;
      buf[i + 1] = cg;
      buf[i + 2] = cb;
      buf[i + 3] = 255;
    }

    i = rowBase + inB * 4;
    for (let x = inB; x < x1; x++, i += 4) {
      const dx0 = x + 0.5 - cx;
      const dx = rot ? dx0 * rc - dy0 * rs : dx0;
      const dy = rot ? dx0 * rs + dy0 * rc : dy0;
      const d = sdf(dx, dy, r, cell);
      if (d >= 0.5) continue;
      const a = d <= -0.5 ? 1 : 0.5 - d;
      if (a >= 0.999) {
        buf[i] = cr;
        buf[i + 1] = cg;
        buf[i + 2] = cb;
        buf[i + 3] = 255;
      } else {
        const ia = 1 - a;
        buf[i] = cr * a + buf[i] * ia;
        buf[i + 1] = cg * a + buf[i + 1] * ia;
        buf[i + 2] = cb * a + buf[i + 2] * ia;
        buf[i + 3] = 255;
      }
    }
  }
}

function blend(buf, w, h, x, y, a, r, g, b) {
  if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
  const i = (y * w + x) * 4;
  const ia = 1 - a;
  buf[i] = r * a + buf[i] * ia;
  buf[i + 1] = g * a + buf[i + 1] * ia;
  buf[i + 2] = b * a + buf[i + 2] * ia;
  buf[i + 3] = 255;
}

module.exports = {
  computeGrid,
  scaleGrid,
  cellCentre,
  rasterizeSeparated,
  rasterizeScreens,
  rasterizeScreensSeparated,
  refineCellsEdgeAware,
  drawDotMultiply,
  sampleCells,
  rasterize,
  drawDot,
  fillBackground,
  buildToneLUT,
};
