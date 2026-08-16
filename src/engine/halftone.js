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
  const labPal = paletteToLab(p.palette);
  const centre = [0, 0];
  const adj = p.colorAdjust || {};
  const adjOut = [0, 0, 0];

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
      const r = inkToRadius(ink, maxRadius, p.radiusCurve);
      if (r <= 0.008) continue;

      // --- colour: cell mean -> hue/sat/bright -> nearest palette -----
      const q = ci * 3;
      const cr = cells.rgb[q] / cnt;
      const cg = cells.rgb[q + 1] / cnt;
      const cb = cells.rgb[q + 2] / cnt;
      adjustColor(cr, cg, cb, adj, adjOut);
      const pi = nearestIndex(labPal, adjOut[0], adjOut[1], adjOut[2]);
      const col3 = p.palette[pi];

      cellCentre(grid, col, row, centre);
      drawDot(buf, width, height, centre[0], centre[1], r, grid.cell, shape, col3);
    }
  }

  return buf;
}

function fillBackground(buf, bg) {
  const r = bg[0], g = bg[1], b = bg[2];
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
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
function drawDot(buf, w, h, cx, cy, r, cell, shape, colour) {
  const cr = colour[0], cg = colour[1], cb = colour[2];

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
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    let i = (y * w + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      const dx = x + 0.5 - cx;
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
  sampleCells,
  rasterize,
  drawDot,
  fillBackground,
  buildToneLUT,
};
