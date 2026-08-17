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
  refineCellsEdgeAware,
  rasterize,
  rasterizeSeparated,
  rasterizeScreens,
  rasterizeScreensSeparated,
} = require("./halftone.js");
const { screenAngles, buildInkBasis, unmix, inkOrder } = require("./separation.js");
const { blueNoiseMatrix } = require("./dither.js");
const { inkOffset } = require("./jitter.js");
const { halftoneSVG, screensSVG, BUSY_SHAPE_COUNT } = require("./svg.js");
const { buildToneLUT, applyToneToImage, biasCurve } = require("./grade.js");
const { ditherToIndices, indicesToRGBA, indicesToMasks } = require("./dither.js");
const { makeZoneRange } = require("./tonemap.js");
const {
  extractPalette,
  applySpread,
  adjustPalette,
  inkPalette,
  hexToPalette,
  paletteToHex,
  padPalette,
  paletteToLab,
  nearestIndex,
  pickBackgroundIndex,
} = require("./palette.js");
const { hexToRgb, adjustColor, getLumaFn } = require("./color.js");
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
    this._screens = null;
    this._basePalette = null;
    this._cellColors = null;
    this._hist = null;
    this.stats = {};
  }

  setSource(img) {
    this.source = img;
    this.sourceId++;
    this._analysis = null;
    this._cells = null;
    this._dither = null;
    this._screens = null;
    this._basePalette = null;
    this._cellColors = null;
    this._hist = null;
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
    this._screens = null;
    return this._analysis;
  }

  /* ------------------------------------------------------------------ *
   * Stage 2a: halftone cell measurement
   * ------------------------------------------------------------------ */

  _ensureCells(params) {
    const analysis = this._ensureAnalysis(params);
    const key = `${analysis.key}|${this.resolution(params)}|${params.angle}|${params.lumaMode}|${params.edgeAware}`;
    if (this._cells && this._cells.key === key) return this._cells.cells;

    const t0 = now();
    const grid = computeGrid(
      analysis.img.width,
      analysis.img.height,
      this.resolution(params),
      params.angle
    );
    const cells = sampleCells(analysis.img, grid, params.lumaMode);
    if (params.edgeAware) refineCellsEdgeAware(analysis.img, grid, cells);
    this.stats.sampleMs = now() - t0;
    this.stats.cells = grid.cols * grid.rows;
    this._cells = { key, cells };
    return cells;
  }

  /**
   * Which palette entry each cell resolves to.
   *
   * This is a third of the per-frame cost and almost none of it is ever new.
   * Deciding a cell's colour means converting its mean RGB to OKLab and
   * searching the palette - and neither depends on radius, dot curve, shape,
   * dot gain, screen type, jitter or any other geometry control. Before this
   * cache, dragging the Radius slider redid a hundred and sixty thousand OKLab
   * conversions per frame to arrive at exactly the answers it already had.
   *
   * The key is everything that genuinely changes the answer: the cells
   * themselves, the palette being matched against, and the hue/saturation/
   * brightness adjustment, which is applied to both sides of the comparison.
   *
   * @returns {Uint8Array} one palette index per cell
   */
  _ensureCellColors(params, cells, rp) {
    const count = cells.grid.cols * cells.grid.rows;
    const key = [
      this._cells ? this._cells.key : "",
      count,
      paletteToHex(rp.palette).join(","),
      params.hue,
      params.saturation,
      params.brightness,
    ].join("|");
    if (this._cellColors && this._cellColors.key === key) return this._cellColors.index;

    const t0 = now();
    const labPal = paletteToLab(rp.palette);
    const adj = rp.colorAdjust || {};
    const out = new Uint8Array(count);
    const tmp = [0, 0, 0];

    for (let ci = 0; ci < count; ci++) {
      const cnt = cells.count[ci];
      if (cnt === 0) continue;
      const q = ci * 3;
      adjustColor(cells.rgb[q] / cnt, cells.rgb[q + 1] / cnt, cells.rgb[q + 2] / cnt, adj, tmp);
      out[ci] = nearestIndex(labPal, tmp[0], tmp[1], tmp[2]);
    }

    this.stats.colorMs = now() - t0;
    this._cellColors = { key, index: out };
    return out;
  }

  /**
   * A luminance histogram of the analysis image, for the curve editor.
   *
   * Deliberately of the *source*, before any grading: the curve editor shows
   * where the tones are so you can decide where to put a point, and a histogram
   * that already had the curve applied would move under your hand as you drew.
   *
   * @param {object} params
   * @param {number} [bins]
   * @returns {number[]|null}
   */
  histogram(params, bins = 64) {
    if (!this.source) return null;
    const key = `${this.sourceId}|${bins}|${params.lumaMode}`;
    if (this._hist && this._hist.key === key) return this._hist.bins;

    // The analysis image is already downscaled and pre-processed, which is both
    // fast and the right signal: it is what the cells are measured from.
    const img = this._ensureAnalysis(params).img;
    const lumaFn = getLumaFn(params.lumaMode);
    const out = new Array(bins).fill(0);
    const data = img.data;
    const last = bins - 1;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      const v = lumaFn(data[i], data[i + 1], data[i + 2]);
      let b = (v * bins) | 0;
      if (b < 0) b = 0;
      else if (b > last) b = last;
      out[b]++;
    }
    this._hist = { key, bins: out };
    return out;
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
   * Stage 2c: per-ink screens (halftone, screenMode "perInk")
   * ------------------------------------------------------------------ */

  /**
   * One screen per ink, each on its own grid at its own angle, each carrying the
   * coverage of that ink per cell.
   *
   * Sampling is repeated per ink because the grids genuinely differ - that is
   * the whole point - but it runs on the analysis image, so N passes over a few
   * hundred thousand pixels is cheap next to what it buys.
   */
  _ensureScreens(params) {
    const analysis = this._ensureAnalysis(params);
    const rp = this._rasterParams(params);
    // Separate against the UNADJUSTED inks: hue and saturation are pointwise
    // recolouring, so applying them here would only invalidate the cache and
    // change nothing about which ink goes where.
    const inks = rp.inkIndices.map((i) => rp.matchPalette[i]);
    const matchBg =
      params.background && params.background !== "auto"
        ? rp.background
        : rp.matchPalette[rp.paperIndex];
    const order = inkOrder(inks);
    const angles = screenAngles(inks.length, params.angle, params.screenSpread);

    const key = [
      analysis.key,
      this.resolution(params),
      params.angle,
      params.screenSpread,
      params.lumaMode,
      params.edgeAware,
      params.contrast,
      params.gamma,
      params.blackPoint,
      params.whitePoint,
      params.exposure,
      params.gradeBias,
      params.invert,
      rp.matchPalette.join(","),
      matchBg.join(","),
    ].join("|");
    if (this._screens && this._screens.key === key) {
      // Colours are recoloured on the way out, so a cached screen set is still
      // valid after a hue or saturation change.
      return this._recolourScreens(this._screens, rp);
    }

    const t0 = now();
    const basis = buildInkBasis(inks, matchBg);
    const lut = rp.toneLUT;
    const cov = new Float64Array(inks.length);
    const graded = [0, 0, 0];

    // One sampling pass per distinct angle; identical angles share their grid.
    const gridCache = new Map();
    const cellCache = new Map();
    const screens = [];

    for (let rank = 0; rank < order.length; rank++) {
      const k = order[rank];
      const angle = angles[rank];
      const akey = angle.toFixed(4);
      if (!gridCache.has(akey)) {
        const g = computeGrid(
          analysis.img.width,
          analysis.img.height,
          this.resolution(params),
          angle
        );
        const c = sampleCells(analysis.img, g, params.lumaMode);
        if (params.edgeAware) refineCellsEdgeAware(analysis.img, g, c);
        gridCache.set(akey, g);
        cellCache.set(akey, c);
      }
      const grid = gridCache.get(akey);
      const cells = cellCache.get(akey);
      const n = grid.cols * grid.rows;
      const coverage = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const cnt = cells.count[i];
        if (!cnt) continue;
        // Grade the cell colour per channel, then invert, then separate. Doing
        // it here rather than per pixel keeps this O(cells).
        for (let ch = 0; ch < 3; ch++) {
          const v = sampleLUTByte(lut, cells.rgb[i * 3 + ch] / cnt);
          graded[ch] = params.invert ? 255 - v : v;
        }
        unmix(basis, graded, cov);
        coverage[i] = biasCurve(Math.min(1, cov[k]), params.gradeBias);
      }

      screens.push({
        grid,
        cov: coverage,
        count: cells.count,
        color: inks[k],
        inkSlot: k,
        paletteIndex: rp.inkIndices[k],
        angle,
      });
    }

    this.stats.screenMs = now() - t0;
    this.stats.screens = screens.length;
    this.stats.cells = screens.reduce((a, s2) => a + s2.grid.cols * s2.grid.rows, 0);
    this._screens = { key, screens, rp };
    return this._recolourScreens(this._screens, rp);
  }

  /** Point a cached screen set at the currently adjusted ink colours. */
  _recolourScreens(cached, rp) {
    for (const sc of cached.screens) {
      const idx = rp.inkIndices[sc.inkSlot];
      if (idx !== undefined && rp.fullPalette[idx]) sc.color = rp.fullPalette[idx];
    }
    cached.rp = rp;
    return cached;
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

  /**
   * Decide, once, which palette entry is the paper and which are inks - and do
   * it on the *unadjusted* palette, by index.
   *
   * Deciding on the adjusted palette instead would mean Hue could silently
   * re-pick a different paper (luminance ordering can flip under rotation), and
   * it would make every hue change invalidate the cached screens. Indices are
   * stable; only the colours they map to move.
   *
   * @returns {{match: number[][], out: number[][], paperIndex: number,
   *            inkIndices: number[], background: number[]}}
   */
  _paletteStructure(params) {
    const match = this._matchPalette(params).map((c) => c.slice());
    const out = adjustPalette(match, {
      hue: params.hue,
      saturation: params.saturation,
      brightness: params.brightness,
    });

    let paperIndex;
    let background;
    const explicit = params.background && params.background !== "auto" ? hexToRgb(params.background) : null;

    if (explicit) {
      background = explicit;
      // An explicit paper that matches a palette entry consumes it, so the
      // engine does not also try to print with it.
      const near = inkPalette(match, explicit);
      if (near.length < match.length) {
        paperIndex = match.findIndex((c) => !near.some((k) => k[0] === c[0] && k[1] === c[1] && k[2] === c[2]));
      } else {
        match.push(explicit.slice());
        out.push(explicit.slice());
        paperIndex = match.length - 1;
      }
    } else {
      paperIndex = pickBackgroundIndex(match, params.invert);
      background = out[paperIndex];
    }
    if (paperIndex < 0 || paperIndex >= match.length) paperIndex = 0;

    const inkIndices = [];
    for (let i = 0; i < match.length; i++) if (i !== paperIndex) inkIndices.push(i);
    if (!inkIndices.length) inkIndices.push(paperIndex);

    return { match, out, paperIndex, inkIndices, background };
  }

  /* ------------------------------------------------------------------ *
   * Stage 4: rasterisation
   * ------------------------------------------------------------------ */

  _rasterParams(params) {
    const st = this._paletteStructure(params);
    const ink = st.inkIndices.map((i) => st.out[i]);
    // Blue noise drives FM screening: no low-frequency energy, so the dots read
    // as an even grain instead of a pattern. Built once and cached.
    let fmThreshold = null;
    if (params.screenType === "fm") {
      const m = blueNoiseMatrix(64);
      fmThreshold = (col, row) => m.data[(row % m.size) * m.size + (col % m.size)];
    }

    return {
      radius: params.radius,
      shape: params.shape,
      screenType: params.screenType,
      fmThreshold,
      jitter: {
        jitterPosition: params.jitterPosition,
        jitterSize: params.jitterSize,
        jitterAngle: params.jitterAngle,
        seed: params.seed,
      },
      dotGain: params.dotGain,
      waveAmount: params.waveAmount,
      waveLength: params.waveLength,
      gradeBias: params.gradeBias,
      radiusCurve: params.radiusCurve,
      invert: params.invert,
      toneLUT: buildToneLUT(params),
      // Dots may use every palette colour except the paper - see inkPalette().
      palette: ink,
      inkPalette: ink,
      inkToPaletteIndex: st.inkIndices.slice(),
      fullPalette: st.out,
      matchPalette: st.match,
      inkIndices: st.inkIndices,
      paperIndex: st.paperIndex,
      background: st.background,
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
  /**
   * @param {object} params
   * @param {object} [opts]
   * @param {number} [opts.width]  the *virtual* render width
   * @param {number} [opts.height] the *virtual* render height
   * @param {{x:number,y:number,width:number,height:number}} [opts.view]
   *        a window of that virtual render to actually produce. This is how
   *        zooming works: the grid is still built for the full virtual size, so
   *        a dot sits in exactly the same place whether you are looking at the
   *        whole image or at one corner of it at 1:1 - it is the same render,
   *        cropped, not a different one derived at a different scale. Cells
   *        outside the window are skipped, so the cost is the window's rather
   *        than the document's.
   */
  render(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;
    const view = opts.view || null;
    const outW = view ? view.width : width;
    const outH = view ? view.height : height;

    if (params.mode === "dither") {
      const d = this._ensureDither(params, opts.maxDitherGrid);
      const palette = this._outputPalette(params);
      const t0 = now();
      const data = indicesToRGBA(
        d.indices, d.width, d.height, palette, width, height, opts.out, view
      );
      this.stats.rasterMs = now() - t0;
      return {
        data,
        width: outW,
        height: outH,
        palette: paletteToHex(palette),
        ink: paletteToHex(palette),
        background: palette[0] || [0, 0, 0],
        exact: d.exact,
      };
    }

    if (params.screenMode === "perInk") {
      const { screens, rp: srp } = this._ensureScreens(params);
      const t0 = now();
      if (view) {
        srp.viewX = view.x;
        srp.viewY = view.y;
      }
      const data = rasterizeScreens(
        this._scaleScreens(screens, width, height, params),
        srp,
        outW,
        outH,
        opts.out
      );
      this.stats.rasterMs = now() - t0;
      return {
        data,
        width: outW,
        height: outH,
        palette: paletteToHex(srp.fullPalette),
        ink: paletteToHex(srp.palette),
        background: srp.background,
        angles: screens.map((sc) => sc.angle),
        exact: true,
      };
    }

    const cells = this._ensureCells(params);
    const rp = this._rasterParams(params);
    rp.cellColor = this._ensureCellColors(params, cells, rp);
    const grid = scaleGrid(cells.grid, width, height);
    const outCells = { lum: cells.lum, rgb: cells.rgb, count: cells.count, grid };
    if (view) {
      rp.viewX = view.x;
      rp.viewY = view.y;
    }

    const t0 = now();
    const data = rasterize(outCells, rp, outW, outH, opts.out);
    this.stats.rasterMs = now() - t0;

    return {
      data,
      width: outW,
      height: outH,
      palette: paletteToHex(rp.fullPalette),
      ink: paletteToHex(rp.palette),
      background: rp.background,
      exact: true,
    };
  }

  /**
   * Re-express every screen's grid at the output resolution.
   *
   * Misregistration is applied here rather than at measurement time because it
   * is a rendering offset in output pixels: derived from the scaled cell size,
   * it looks identical on a preview and on a full render.
   */
  _scaleScreens(screens, width, height, params) {
    const amount = params ? params.misregistration : 0;
    const seed = params ? params.seed : 0;
    const off = [0, 0];
    return screens.map((sc, i) => {
      const grid = scaleGrid(sc.grid, width, height);
      inkOffset(i, amount, grid.cell, seed, off);
      return {
        grid,
        cov: sc.cov,
        count: sc.count,
        color: sc.color,
        inkSlot: sc.inkSlot,
        paletteIndex: sc.paletteIndex,
        angle: sc.angle,
        offsetX: off[0],
        offsetY: off[1],
      };
    });
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
      return {
        masks,
        palette: paletteToHex(palette),
        paperIndex: 0,
        blend: "normal",
        exclusive: true,
        width,
        height,
      };
    }

    if (params.screenMode === "perInk") {
      const { screens, rp: srp } = this._ensureScreens(params);
      const scaled = this._scaleScreens(screens, width, height, params);
      const inkMasks = rasterizeScreensSeparated(scaled, srp, width, height);
      // Transparent inks overlap by design, so the masks are NOT exclusive and
      // the fill layers must be set to Multiply over an opaque paper.
      const paper = new Uint8ClampedArray(width * height).fill(255);
      const masks = [];
      const palette = [];
      masks.push(paper);
      palette.push(paletteToHex([srp.background])[0]);
      for (let i = 0; i < scaled.length; i++) {
        masks.push(inkMasks[i]);
        palette.push(paletteToHex([scaled[i].color])[0]);
      }
      return {
        masks,
        palette,
        paperIndex: 0,
        blend: "multiply",
        exclusive: false,
        width,
        height,
      };
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
      blend: "normal",
      exclusive: true,
      width,
      height,
    };
  }

  /**
   * Export the render as SVG.
   *
   * Halftone only: dithering is one shape per pixel, so even a modest grid runs
   * to hundreds of thousands of rectangles and no viewer would open the result.
   * The caller is told that rather than handed a useless file.
   *
   * @returns {{svg: string, shapes: number, busy: boolean}}
   */
  renderSVG(params, opts = {}) {
    if (!this.source) throw new Error("HalftoneEngine: no source set");
    if (params.mode === "dither") {
      throw new Error(
        "SVG export covers halftone mode only. A dither is one shape per pixel, " +
          "which no vector application can usefully open."
      );
    }
    const width = opts.width || this.source.width;
    const height = opts.height || this.source.height;

    let res;
    if (params.screenMode === "perInk") {
      const { screens, rp } = this._ensureScreens(params);
      res = screensSVG(this._scaleScreens(screens, width, height, params), rp, width, height);
    } else {
      const cells = this._ensureCells(params);
      const rp = this._rasterParams(params);
      const grid = scaleGrid(cells.grid, width, height);
      res = halftoneSVG(
        { lum: cells.lum, rgb: cells.rgb, count: cells.count, grid },
        rp,
        width,
        height
      );
    }
    return { svg: res.svg, shapes: res.shapes, busy: res.shapes > BUSY_SHAPE_COUNT };
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

    if (params.screenMode === "perInk") {
      const { screens, rp: srp } = this._ensureScreens(params);
      if (shouldCancel()) return null;
      onProgress(0.2);
      const scaled = this._scaleScreens(screens, width, height, params);
      const data = opts.out || new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < scaled.length; i++) {
        rasterizeScreens(scaled, srp, width, height, data, {
          screenStart: i,
          screenEnd: i + 1,
          skipBackground: i !== 0,
        });
        onProgress(0.2 + 0.8 * ((i + 1) / scaled.length));
        if (shouldCancel()) return null;
        // eslint-disable-next-line no-await-in-loop
        await yieldToHost();
      }
      return {
        data,
        width,
        height,
        palette: paletteToHex(srp.fullPalette),
        ink: paletteToHex(srp.palette),
        background: srp.background,
        angles: scaled.map((sc) => sc.angle),
        exact: true,
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

/** Sample a 0..1 tone LUT with a 0..255 input, returning 0..255. */
function sampleLUTByte(lut, v) {
  const x = v < 0 ? 0 : v > 255 ? 255 : v;
  const i = x | 0;
  const f = x - i;
  const a = lut[i];
  const b = i >= 255 ? lut[255] : lut[i + 1];
  return (a + (b - a) * f) * 255;
}

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
