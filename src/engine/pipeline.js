"use strict";

/**
 * Staged, cached render pipeline for both render modes.
 *
 * HALFTONE
 * Only two operations are proportional to the pixel count, and neither runs at
 * document resolution: downscale the source to an "analysis" image, then measure
 * one average tone + colour per halftone cell. Everything downstream (grading,
 * bias, palette, spread, hue, saturation, radius, shape) works on the cell array
 * - typically 5k-40k entries - and is therefore effectively free. Only the final
 * rasterisation runs at output resolution.
 *
 * DITHER
 * Dithering decides a colour per pixel, so it cannot be reduced to cell
 * averages. Instead it runs on a grid of "dither pixels" whose count is the
 * parameter, and the result is scaled up with nearest-neighbour. That is what
 * gives the chunky bitmap look, what DPI-based scaling means in practice, and -
 * as with halftone - it means the preview and the full render come from the same
 * computation whenever the grid fits inside the preview.
 *
 * In both modes the expensive stage is cached and keyed, so dragging a slider
 * only re-runs what that slider actually affects.
 */

const { fitWithin } = require("./resample.js");
const { preprocess } = require("./preprocess.js");
const {
  computeGrid,
  scaleGrid,
  sampleCells,
  rasterize,
  rasterizeSeparated,
} = require("./halftone.js");
const { buildToneLUT, applyToneToImage } = require("./grade.js");
const { ditherToIndices, indicesToRGBA, indicesToMasks } = require("./dither.js");
const { makeZoneRange } = require("./tonemap.js");
const {
  extractPalette,
  applySpread,
  adjustPalette,
  resolveBackground,
  inkPalette,
  hexToPalette,
  paletteToHex,
  padPalette,
  paletteToLab,
} = require("./palette.js");
const { resolveResolution } = require("../state/params.js");

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
    /** Document resolution in PPI. Only used by the DPI scale mode. */
    this.docPPI = 72;
    this._analysis = null;
    this._cells = null;
    this._dither = null;
    this._basePalette = null;
    this.stats = {};
  }

  setSource(img) {
    this.source = img;
    this.sourceId++;
    this._analysis = null;
    this._cells = null;
    this._dither = null;
    this._basePalette = null;
  }

  hasSource() {
    return !!this.source;
  }

  /**
   * Grid resolution in the current scale mode: cells across the longest edge
   * for halftone, dither pixels across the longest edge for dither.
   */
  resolution(params) {
    return resolveResolution(params, Math.max(this.source.width, this.source.height), this.docPPI);
  }

  /* ------------------------------------------------------------------ *
   * Stage 1: analysis image (downscale + pre-process, and grade for dither)
   * ------------------------------------------------------------------ */

  _analysisSize(params, maxGrid) {
    const longest = Math.max(this.source.width, this.source.height);
    if (params.mode === "dither") {
      // One analysis pixel per dither pixel, exactly.
      let want = this.resolution(params);
      if (maxGrid) want = Math.min(want, maxGrid);
      return Math.max(8, Math.round(Math.min(longest, want)));
    }
    const wanted = this.resolution(params) * SAMPLES_PER_CELL_EDGE;
    return Math.round(Math.min(longest, Math.max(ANALYSIS_MIN, Math.min(ANALYSIS_MAX, wanted))));
  }

  _ensureAnalysis(params, maxGrid) {
    const target = this._analysisSize(params, maxGrid);
    const key = [
      this.sourceId,
      target,
      params.blur,
      params.sharpen,
      params.sharpenRadius,
      params.noiseReduction,
      // The dither path grades pixels, so the grade belongs to this stage there.
      params.mode === "dither"
        ? [
            params.contrast,
            params.gamma,
            params.blackPoint,
            params.whitePoint,
            params.exposure,
            params.invert,
          ].join(",")
        : "-",
    ].join("|");
    if (this._analysis && this._analysis.key === key) return this._analysis;

    const t0 = now();
    let img = fitWithin(this.source, target);
    // Pre-process radii are expressed per 1000px of the longest edge, so the
    // visual result is identical whatever resolution we analyse at.
    const scale = Math.max(img.width, img.height) / 1000;

    img = preprocess(img, params, scale);

    if (params.mode === "dither") {
      img = applyToneToImage(img, buildToneLUT(params), params.invert);
    }

    this.stats.analysisMs = now() - t0;
    this.stats.analysisSize = `${img.width}x${img.height}`;
    this._analysis = { key, img, target };
    this._cells = null;
    this._dither = null;
    return this._analysis;
  }

  /* ------------------------------------------------------------------ *
   * Stage 2a: halftone cell measurement
   * ------------------------------------------------------------------ */

  _ensureCells(params) {
    const analysis = this._ensureAnalysis(params);
    const key = `${analysis.key}|${this.resolution(params)}|${params.angle}|${params.lumaMode}`;
    if (this._cells && this._cells.key === key) return this._cells.cells;

    const t0 = now();
    const grid = computeGrid(
      analysis.img.width,
      analysis.img.height,
      this.resolution(params),
      params.angle
    );
    const cells = sampleCells(analysis.img, grid, params.lumaMode);
    this.stats.sampleMs = now() - t0;
    this.stats.cells = grid.cols * grid.rows;
    this._cells = { key, cells };
    return cells;
  }

  /* ------------------------------------------------------------------ *
   * Stage 2b: dither
   * ------------------------------------------------------------------ */

  _ensureDither(params, maxGrid) {
    const analysis = this._ensureAnalysis(params, maxGrid);
    const matchPalette = this._matchPalette(params);
    const key = [
      analysis.key,
      params.ditherAlgorithm,
      params.ditherStrength,
      params.serpentine,
      params.tonalMapping ? `${params.shadowSplit},${params.highlightSplit}` : "-",
      paletteToHex(matchPalette).join(","),
    ].join("|");
    if (this._dither && this._dither.key === key) return this._dither;

    const t0 = now();
    const indices = ditherToIndices(analysis.img, {
      labPal: paletteToLab(matchPalette),
      palette: matchPalette,
      algorithm: params.ditherAlgorithm,
      strength: params.ditherStrength,
      serpentine: params.serpentine,
      zoneRange: makeZoneRange(matchPalette.length, params),
    });
    this.stats.ditherMs = now() - t0;
    this.stats.cells = analysis.img.width * analysis.img.height;
    this._dither = {
      key,
      indices,
      width: analysis.img.width,
      height: analysis.img.height,
      exact: !maxGrid || this.resolution(params) <= maxGrid,
    };
    return this._dither;
  }

  /* ------------------------------------------------------------------ *
   * Stage 3: palette
   * ------------------------------------------------------------------ */

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
   * The palette used for *matching*, before hue/saturation/brightness.
   *
   * Colour adjustments are pointwise, so applying them to both the image and the
   * palette would leave the matching almost unchanged while costing a full pixel
   * pass. Matching against the unadjusted palette and emitting the adjusted one
   * is equivalent and keeps Hue at O(colours) in both modes.
   */
  _matchPalette(params) {
    let base;
    if (params.paletteLocked && Array.isArray(params.palette) && params.palette.length) {
      base = padPalette(hexToPalette(params.palette), params.palette.length);
    } else {
      base = this.extractPalette(params);
    }
    return applySpread(base, params.spread);
  }

  /** The palette actually emitted. */
  _outputPalette(params) {
    return adjustPalette(this._matchPalette(params), {
      hue: params.hue,
      saturation: params.saturation,
      brightness: params.brightness,
    });
  }

  /* ------------------------------------------------------------------ *
   * Stage 4: rasterisation
   * ------------------------------------------------------------------ */

  _rasterParams(params) {
    const palette = this._outputPalette(params);
    const background = resolveBackground(palette, params.background, params.invert);
    const ink = inkPalette(palette, background);

    let paperIndex = indexOfColour(palette, background);
    if (paperIndex < 0) {
      // An explicit background that is not part of the palette becomes its own
      // layer in the separated output.
      palette.push(background);
      paperIndex = palette.length - 1;
    }
    // Map an ink-palette index back to the full palette, so the separated
    // output knows which fill layer each dot belongs to.
    const inkToPaletteIndex = ink.map((c) => {
      const i = indexOfColour(palette, c);
      return i < 0 ? paperIndex : i;
    });

    return {
      radius: params.radius,
      shape: params.shape,
      gradeBias: params.gradeBias,
      radiusCurve: params.radiusCurve,
      invert: params.invert,
      toneLUT: buildToneLUT(params),
      // Dots may use every palette colour except the paper - see inkPalette().
      palette: ink,
      inkPalette: ink,
      inkToPaletteIndex,
      fullPalette: palette,
      paperIndex,
      background,
      colorAdjust: {
        hue: params.hue,
        saturation: params.saturation,
        brightness: params.brightness,
      },
    };
  }

  /**
   * Synchronous render.
   *
   * @param {object} params sanitised parameters
   * @param {{width?: number, height?: number, out?: Uint8ClampedArray,
   *          maxDitherGrid?: number}} [opts]
   *        `maxDitherGrid` caps the dither grid so previews stay fast; when the
   *        requested resolution exceeds it, the result is flagged `exact: false`.
   */
  render(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;

    if (params.mode === "dither") {
      const d = this._ensureDither(params, opts.maxDitherGrid);
      const palette = this._outputPalette(params);
      const t0 = now();
      const data = indicesToRGBA(d.indices, d.width, d.height, palette, width, height, opts.out);
      this.stats.rasterMs = now() - t0;
      return {
        data,
        width,
        height,
        palette: paletteToHex(palette),
        ink: paletteToHex(palette),
        background: palette[0] || [0, 0, 0],
        exact: d.exact,
      };
    }

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
      exact: true,
    };
  }

  /**
   * Render to one 8-bit coverage mask per palette colour, for the separated
   * fill-layer output. Masks are mutually exclusive and sum to 255, so the
   * stack reproduces the flat render regardless of layer order.
   *
   * @returns {{masks: Uint8ClampedArray[], palette: string[], paperIndex: number,
   *            width: number, height: number}}
   */
  renderSeparated(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;

    if (params.mode === "dither") {
      const d = this._ensureDither(params, opts.maxDitherGrid);
      const palette = this._outputPalette(params);
      const masks = indicesToMasks(d.indices, d.width, d.height, palette.length, width, height);
      return { masks, palette: paletteToHex(palette), paperIndex: 0, width, height };
    }

    const cells = this._ensureCells(params);
    const rp = this._rasterParams(params);
    const grid = scaleGrid(cells.grid, width, height);
    const outCells = { lum: cells.lum, rgb: cells.rgb, count: cells.count, grid };
    const masks = rasterizeSeparated(outCells, rp, width, height);
    return {
      masks,
      palette: paletteToHex(rp.fullPalette),
      paperIndex: rp.paperIndex,
      width,
      height,
    };
  }

  /**
   * Chunked render that yields to the event loop between bands so Photoshop's
   * UI keeps breathing on very large documents.
   */
  async renderAsync(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;
    const onProgress = opts.onProgress || noop;
    const shouldCancel = opts.shouldCancel || (() => false);

    onProgress(0.02);

    if (params.mode === "dither") {
      // The dither runs on a grid that is small by construction; the expansion
      // to output size is the part worth chunking.
      const d = this._ensureDither(params, opts.maxDitherGrid);
      if (shouldCancel()) return null;
      onProgress(0.5);
      const palette = this._outputPalette(params);
      const data = indicesToRGBA(d.indices, d.width, d.height, palette, width, height, opts.out);
      onProgress(1);
      return {
        data,
        width,
        height,
        palette: paletteToHex(palette),
        ink: paletteToHex(palette),
        background: palette[0] || [0, 0, 0],
        exact: d.exact,
      };
    }

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
      exact: true,
    };
  }
}

/* ------------------------------------------------------------------ */

function indexOfColour(palette, c) {
  for (let i = 0; i < palette.length; i++) {
    if (palette[i][0] === c[0] && palette[i][1] === c[1] && palette[i][2] === c[2]) return i;
  }
  return -1;
}

function noop() {}

function yieldToHost() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

module.exports = { HalftoneEngine, SAMPLES_PER_CELL_EDGE, ANALYSIS_MIN, ANALYSIS_MAX };
