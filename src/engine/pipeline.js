"use strict";

/**
 * Staged, cached render pipeline.
 *
 * The design goal is that only two operations are ever proportional to the
 * pixel count, and neither of them runs at full document resolution:
 *
 *   1. downscale the source to an "analysis" image (a few hundred pixels wide)
 *   2. blur it and measure one average tone + colour per halftone cell
 *
 * Everything else - grading, bias, palette, spread, hue, saturation, radius
 * mapping - works on the cell array (typically 5k-40k entries) and is therefore
 * effectively free. Only the final rasterisation runs at the output resolution,
 * and its cost is proportional to the ink actually laid down.
 *
 * Practical consequence: dragging Hue, Contrast or Radius never re-touches a
 * single source pixel, and the preview and the full resolution render are
 * produced from the *same* cell data, so they cannot drift apart.
 */

const { fitWithin } = require("./resample.js");
const { gaussianBlurRGBA } = require("./blur.js");
const { computeGrid, scaleGrid, sampleCells, rasterize } = require("./halftone.js");
const { buildToneLUT } = require("./grade.js");
const {
  extractPalette,
  applySpread,
  adjustPalette,
  resolveBackground,
  inkPalette,
  hexToPalette,
  paletteToHex,
  padPalette,
} = require("./palette.js");

/** Samples along a cell edge in the analysis image. 8 -> 64 samples per cell. */
const SAMPLES_PER_CELL_EDGE = 8;
const ANALYSIS_MIN = 480;
const ANALYSIS_MAX = 3000;

/** How many cell rows to rasterise between async yields. */
const RASTER_CHUNK_ROWS = 24;

class HalftoneEngine {
  constructor() {
    /** @type {{data: Uint8ClampedArray, width: number, height: number}|null} */
    this.source = null;
    this.sourceId = 0;
    this._analysis = null; // {key, img, scaleFromSource}
    this._cells = null; // {key, cells}
    this._basePalette = null; // {key, palette}
    this.stats = {};
  }

  /**
   * @param {{data: Uint8ClampedArray, width: number, height: number}} img
   */
  setSource(img) {
    this.source = img;
    this.sourceId++;
    this._analysis = null;
    this._cells = null;
    this._basePalette = null;
  }

  hasSource() {
    return !!this.source;
  }

  /* ------------------------------------------------------------------ *
   * Stage 1: analysis image (downscale + blur)
   * ------------------------------------------------------------------ */

  _analysisSize(params) {
    const longest = Math.max(this.source.width, this.source.height);
    const wanted = params.density * SAMPLES_PER_CELL_EDGE;
    return Math.round(Math.min(longest, Math.max(ANALYSIS_MIN, Math.min(ANALYSIS_MAX, wanted))));
  }

  _ensureAnalysis(params) {
    const target = this._analysisSize(params);
    const key = `${this.sourceId}|${target}|${params.blur}`;
    if (this._analysis && this._analysis.key === key) return this._analysis;

    const t0 = now();
    let img = fitWithin(this.source, target);
    const scale = this.source.width / img.width;

    if (params.blur > 0) {
      // Blur is expressed per 1000px of the longest edge, so the visual result
      // is identical whatever resolution we analyse at.
      const sigma = (params.blur * Math.max(img.width, img.height)) / 1000;
      img = gaussianBlurRGBA(img, sigma);
    }

    this.stats.analysisMs = now() - t0;
    this.stats.analysisSize = `${img.width}x${img.height}`;
    this._analysis = { key, img, scale };
    this._cells = null; // cells depend on the analysis image
    return this._analysis;
  }

  /* ------------------------------------------------------------------ *
   * Stage 2: cell measurement
   * ------------------------------------------------------------------ */

  _ensureCells(params) {
    const analysis = this._ensureAnalysis(params);
    const key = `${analysis.key}|${params.density}|${params.angle}|${params.lumaMode}`;
    if (this._cells && this._cells.key === key) return this._cells.cells;

    const t0 = now();
    const grid = computeGrid(analysis.img.width, analysis.img.height, params.density, params.angle);
    const cells = sampleCells(analysis.img, grid, params.lumaMode);
    this.stats.sampleMs = now() - t0;
    this.stats.cells = grid.cols * grid.rows;
    this._cells = { key, cells };
    return cells;
  }

  /* ------------------------------------------------------------------ *
   * Stage 3: palette
   * ------------------------------------------------------------------ */

  /**
   * Palette extracted from the image (ignores manual overrides).
   * @returns {number[][]}
   */
  extractPalette(params) {
    const analysis = this._ensureAnalysis(params);
    const key = `${analysis.key}|${params.colorCount}|${params.quantMethod}`;
    if (this._basePalette && this._basePalette.key === key) return this._basePalette.palette;
    const t0 = now();
    const palette = extractPalette(analysis.img, {
      count: params.colorCount,
      method: params.quantMethod,
    });
    this.stats.paletteMs = now() - t0;
    this._basePalette = { key, palette };
    return palette;
  }

  extractPaletteHex(params) {
    return paletteToHex(this.extractPalette(params));
  }

  /**
   * The palette actually used for rendering: manual or extracted, then spread,
   * then hue/saturation/brightness.
   */
  _resolvePalette(params) {
    let base;
    if (params.paletteLocked && Array.isArray(params.palette) && params.palette.length) {
      base = padPalette(hexToPalette(params.palette), params.palette.length);
    } else {
      base = this.extractPalette(params);
    }
    const spread = applySpread(base, params.spread);
    return adjustPalette(spread, {
      hue: params.hue,
      saturation: params.saturation,
      brightness: params.brightness,
    });
  }

  /* ------------------------------------------------------------------ *
   * Stage 4: rasterisation
   * ------------------------------------------------------------------ */

  _rasterParams(params) {
    const palette = this._resolvePalette(params);
    const background = resolveBackground(palette, params.background, params.invert);
    return {
      radius: params.radius,
      shape: params.shape,
      gradeBias: params.gradeBias,
      radiusCurve: params.radiusCurve,
      invert: params.invert,
      toneLUT: buildToneLUT(params),
      // Dots may use every palette colour except the paper - see inkPalette().
      palette: inkPalette(palette, background),
      fullPalette: palette,
      background,
      colorAdjust: {
        hue: params.hue,
        saturation: params.saturation,
        brightness: params.brightness,
      },
    };
  }

  /**
   * Synchronous render. Fine for previews and small documents.
   *
   * @param {object} params sanitised parameters
   * @param {{width?: number, height?: number, out?: Uint8ClampedArray}} [opts]
   * @returns {{data: Uint8ClampedArray, width: number, height: number, palette: string[], background: number[]}}
   */
  render(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;
    const cells = this._ensureCells(params);
    const rp = this._rasterParams(params);
    const grid = scaleGrid(cells.grid, width, height);
    const outCells = { lum: cells.lum, rgb: cells.rgb, count: cells.count, grid };

    const t0 = now();
    const data = rasterize(outCells, rp, width, height, opts.out);
    this.stats.rasterMs = now() - t0;

    return {
      data,
      width,
      height,
      palette: paletteToHex(rp.fullPalette),
      ink: paletteToHex(rp.palette),
      background: rp.background,
    };
  }

  /**
   * Chunked render that yields to the event loop between bands so Photoshop's
   * UI keeps breathing on very large documents.
   *
   * @param {object} params
   * @param {{width?: number, height?: number, out?: Uint8ClampedArray,
   *          onProgress?: (t:number)=>void, shouldCancel?: ()=>boolean,
   *          yieldEvery?: number}} [opts]
   */
  async renderAsync(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;
    const onProgress = opts.onProgress || noop;
    const shouldCancel = opts.shouldCancel || (() => false);

    onProgress(0.02);
    const cells = this._ensureCells(params);
    if (shouldCancel()) return null;
    onProgress(0.2);

    const rp = this._rasterParams(params);
    const grid = scaleGrid(cells.grid, width, height);
    const outCells = { lum: cells.lum, rgb: cells.rgb, count: cells.count, grid };

    const data = opts.out || new Uint8ClampedArray(width * height * 4);
    const t0 = now();
    const chunkRows = opts.yieldEvery || RASTER_CHUNK_ROWS;

    for (let row = 0; row < grid.rows; row += chunkRows) {
      rasterize(outCells, rp, width, height, data, {
        rowStart: row,
        rowEnd: Math.min(grid.rows, row + chunkRows),
        skipBackground: row !== 0,
      });
      onProgress(0.2 + 0.8 * Math.min(1, (row + chunkRows) / grid.rows));
      if (shouldCancel()) return null;
      await yieldToHost();
    }
    this.stats.rasterMs = now() - t0;

    return {
      data,
      width,
      height,
      palette: paletteToHex(rp.fullPalette),
      ink: paletteToHex(rp.palette),
      background: rp.background,
    };
  }
}

/* ------------------------------------------------------------------ */

function noop() {}

function yieldToHost() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

module.exports = { HalftoneEngine, SAMPLES_PER_CELL_EDGE, ANALYSIS_MIN, ANALYSIS_MAX };
