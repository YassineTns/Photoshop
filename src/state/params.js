"use strict";

/**
 * Single source of truth for the parameter set.
 *
 * The UI is generated from PARAM_DEFS, presets are validated against it, and
 * persisted renders are migrated through it. Adding a control means adding one
 * entry here.
 *
 * Two visibility mechanisms keep the panel from becoming a wall of sliders:
 *   - `modes`  : which render mode(s) a parameter belongs to
 *   - `showIf` : a predicate on the current parameters
 */

const SCHEMA_VERSION = 2;

const MODES = ["halftone", "dither"];

/**
 * @typedef {object} ParamDef
 * @property {string} key
 * @property {string} label
 * @property {"slider"|"choice"|"chips"|"toggle"|"palette"|"color"} type
 * @property {*} def default value
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {number} [decimals]
 * @property {string} [unit]
 * @property {string} [section]
 * @property {string[]} [options]
 * @property {string[]} [modes]     restrict to these render modes
 * @property {(p: object) => boolean} [showIf]
 * @property {string} [hint]
 */

/** Populated lazily to avoid a require cycle with the engine. */
let _ditherIds = null;
function ditherAlgorithmIds() {
  if (!_ditherIds) {
    // eslint-disable-next-line global-require
    _ditherIds = require("../engine/dither.js").ALGORITHM_IDS;
  }
  return _ditherIds;
}

/** @type {ParamDef[]} */
const PARAM_DEFS = [
  // ----------------------------------------------------------------- Mode
  {
    key: "mode",
    label: "Mode",
    section: "mode",
    type: "choice",
    def: "halftone",
    options: MODES,
    hint: "Halftone varies dot size on a grid. Dither picks one palette colour per pixel.",
  },

  // ---------------------------------------------------------------- Scale
  {
    key: "scaleMode",
    label: "Scale by",
    section: "scale",
    type: "choice",
    def: "relative",
    options: ["relative", "dpi"],
    optionLabels: { relative: "Relative", dpi: "DPI" },
    hint: "Relative is resolution independent. DPI derives the grid from the document's own resolution.",
  },
  {
    key: "dpi",
    label: "DPI",
    section: "scale",
    type: "slider",
    def: 150,
    min: 5,
    max: 300,
    step: 1,
    decimals: 0,
    showIf: (p) => p.scaleMode === "dpi",
    hint: "Target output density. The grid is docPixels x (dpi / documentResolution).",
  },
  {
    key: "density",
    label: "Density",
    section: "scale",
    type: "slider",
    def: 90,
    min: 8,
    max: 400,
    step: 1,
    decimals: 0,
    unit: " cells",
    modes: ["halftone"],
    showIf: (p) => p.scaleMode !== "dpi",
    hint: "Cells across the longest edge. Resolution independent, so the preview matches the full render.",
  },
  {
    key: "ditherResolution",
    label: "Resolution",
    section: "scale",
    type: "slider",
    def: 400,
    min: 24,
    max: 2400,
    step: 1,
    decimals: 0,
    unit: " px",
    modes: ["dither"],
    showIf: (p) => p.scaleMode !== "dpi",
    hint: "Dither pixels across the longest edge. Lower values give the chunky bitmap look.",
  },
  {
    key: "angle",
    label: "Angle",
    section: "scale",
    type: "slider",
    def: 0,
    min: 0,
    max: 90,
    step: 1,
    decimals: 0,
    unit: "°",
    modes: ["halftone"],
  },

  // ------------------------------------------------------------- Halftone
  {
    key: "radius",
    label: "Radius",
    section: "halftone",
    type: "slider",
    def: 100,
    min: 0,
    max: 200,
    step: 1,
    decimals: 0,
    unit: "%",
    modes: ["halftone"],
    hint: "Maximum dot size as a percentage of the cell half-size. Above 100% dots overlap.",
  },
  {
    key: "radiusCurve",
    label: "Dot Curve",
    section: "halftone",
    type: "slider",
    def: 0,
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    modes: ["halftone"],
    hint: "0 = dot area follows tone (classic AM screen). 1 = dot radius follows tone (harder).",
  },
  {
    key: "shape",
    label: "Shape",
    section: "halftone",
    type: "chips",
    def: "circle",
    options: ["circle", "ellipse", "square", "diamond", "cross", "line"],
    modes: ["halftone"],
    hint: "Ellipse joins its neighbours gradually, avoiding the hard 50% tone jump a circle makes.",
  },
  {
    key: "dotGain",
    label: "Dot Gain",
    section: "halftone",
    type: "slider",
    def: 0,
    min: 0,
    max: 40,
    step: 0.5,
    decimals: 1,
    unit: "%",
    modes: ["halftone"],
    hint: "Simulates a press spreading ink a fixed width around every dot edge. A radius offset, not a tonal curve.",
  },
  {
    key: "screenType",
    label: "Screen",
    section: "halftone",
    type: "choice",
    def: "am",
    options: ["am", "fm"],
    optionLabels: { am: "AM", fm: "FM" },
    modes: ["halftone"],
    hint: "AM varies dot size on a grid. FM keeps every dot the same size and varies how many there are - a stochastic screen.",
  },
  {
    key: "screenMode",
    label: "Screens",
    section: "halftone",
    type: "choice",
    def: "single",
    options: ["single", "perInk"],
    modes: ["halftone"],
    hint: "perInk gives every ink its own angle and overprints them, producing a rosette instead of a moire.",
  },
  {
    key: "screenSpread",
    label: "Angle Spread",
    section: "halftone",
    type: "slider",
    def: 1,
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    modes: ["halftone"],
    showIf: (p) => p.screenMode === "perInk",
    hint: "1 uses the classic 45/15/75/0 separation. 0 collapses every screen onto one angle.",
  },
  {
    key: "edgeAware",
    label: "Edge Aware",
    section: "halftone",
    type: "toggle",
    def: false,
    modes: ["halftone"],
    hint: "Cells straddling an edge take the tone of the dominant side instead of averaging across it.",
  },

  // --------------------------------------------------------------- Dither
  {
    key: "ditherAlgorithm",
    label: "Algorithm",
    section: "dither",
    type: "chips",
    def: "floydsteinberg",
    get options() {
      return ditherAlgorithmIds();
    },
    modes: ["dither"],
  },
  {
    key: "ditherStrength",
    label: "Amount",
    section: "dither",
    type: "slider",
    def: 1,
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    modes: ["dither"],
    hint: "0 posterises with no pattern at all; 1 is the full dither.",
  },
  {
    key: "serpentine",
    label: "Serpentine",
    section: "dither",
    type: "toggle",
    def: true,
    modes: ["dither"],
    hint: "Alternate the scan direction each row. Cancels most directional error-diffusion artefacts.",
  },

  // ---------------------------------------------------------------- Press
  {
    key: "jitterPosition",
    label: "Offset",
    section: "press",
    type: "slider",
    def: 0,
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
    unit: "%",
    modes: ["halftone"],
    hint: "Nudges each dot off its grid position, as a percentage of the cell.",
  },
  {
    key: "jitterSize",
    label: "Size Vary",
    section: "press",
    type: "slider",
    def: 0,
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
    unit: "%",
    modes: ["halftone"],
  },
  {
    key: "jitterAngle",
    label: "Rotate",
    section: "press",
    type: "slider",
    def: 0,
    min: 0,
    max: 180,
    step: 1,
    decimals: 0,
    unit: "°",
    modes: ["halftone"],
    hint: "Random per-dot rotation. Only visible on shapes that are not round.",
  },
  {
    key: "misregistration",
    label: "Off-register",
    section: "press",
    type: "slider",
    def: 0,
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
    unit: "%",
    modes: ["halftone"],
    showIf: (p) => p.screenMode === "perInk",
    hint: "Each ink plate lands slightly off the others, as a real press does. This is most of what makes a print look printed.",
  },
  {
    key: "seed",
    label: "Seed",
    section: "press",
    type: "slider",
    def: 1,
    min: 1,
    max: 999,
    step: 1,
    decimals: 0,
    modes: ["halftone"],
    hint: "All imperfection is derived from this, so the same seed always gives the same result.",
  },

  // ---------------------------------------------------------- Pre-process
  {
    key: "blur",
    label: "Blur",
    section: "preprocess",
    type: "slider",
    def: 0,
    min: 0,
    max: 40,
    step: 0.1,
    decimals: 1,
    hint: "Resolution independent units (px per 1000px of the longest edge).",
  },
  {
    key: "sharpen",
    label: "Sharpen",
    section: "preprocess",
    type: "slider",
    def: 0,
    min: 0,
    max: 200,
    step: 1,
    decimals: 0,
    unit: "%",
    hint: "Unsharp mask. Worth using before a dither, which has no tonal resolution to spare.",
  },
  {
    key: "sharpenRadius",
    label: "Sharpen R",
    section: "preprocess",
    type: "slider",
    def: 2,
    min: 0.3,
    max: 10,
    step: 0.1,
    decimals: 1,
    showIf: (p) => p.sharpen > 0,
  },
  {
    key: "noiseReduction",
    label: "Noise Red.",
    section: "preprocess",
    type: "slider",
    def: 0,
    min: 0,
    max: 100,
    step: 1,
    decimals: 0,
    hint: "Edge-preserving smoothing. Stops sensor noise turning into a field of stray dots.",
  },

  // --------------------------------------------------------------- Colors
  {
    key: "colorCount",
    label: "Colors",
    section: "colors",
    type: "slider",
    def: 3,
    min: 2,
    max: 8,
    step: 1,
    decimals: 0,
  },
  {
    key: "spread",
    label: "Spread",
    section: "colors",
    type: "slider",
    def: 0.35,
    min: 0,
    max: 1,
    step: 0.01,
    decimals: 2,
    hint: "Pushes palette entries apart in OKLab for a punchier, screen-printed separation.",
  },
  {
    key: "quantMethod",
    label: "Method",
    section: "colors",
    type: "choice",
    def: "kmeans",
    options: ["kmeans", "mediancut", "popularity"],
    optionLabels: { kmeans: "K-Means", mediancut: "Median Cut", popularity: "Popularity" },
  },
  {
    key: "palette",
    label: "Palette",
    section: "colors",
    type: "palette",
    def: ["#161616", "#F5EBD8", "#EC3E32"],
  },
  {
    // Not a control of its own: rendered as a small lock badge on each swatch.
    // Locked entries survive re-extraction, so you can pin your brand red and
    // let the engine choose the rest.
    key: "lockedSwatches",
    label: "Locked swatches",
    section: "colors",
    type: "internal",
    def: [],
  },
  {
    key: "paletteLocked",
    label: "Lock palette",
    section: "colors",
    type: "toggle",
    def: true,
    hint: "When off, the palette is re-extracted from the image on every render.",
  },
  {
    key: "background",
    label: "Background",
    section: "colors",
    type: "color",
    def: "auto",
    modes: ["halftone"],
    hint: "auto = lightest palette colour (darkest when Invert is on).",
  },

  // ----------------------------------------------------------- Tonal zones
  {
    key: "tonalMapping",
    label: "Tonal zones",
    section: "tonal",
    type: "toggle",
    def: false,
    hint: "Restrict shadows, midtones and highlights each to their own slice of the palette.",
  },
  {
    key: "shadowSplit",
    label: "Shadows",
    section: "tonal",
    type: "slider",
    def: 0.33,
    min: 0.05,
    max: 0.6,
    step: 0.01,
    decimals: 2,
    showIf: (p) => p.tonalMapping,
  },
  {
    key: "highlightSplit",
    label: "Highlights",
    section: "tonal",
    type: "slider",
    def: 0.66,
    min: 0.4,
    max: 0.95,
    step: 0.01,
    decimals: 2,
    showIf: (p) => p.tonalMapping,
  },

  // ---------------------------------------------------------------- Grade
  {
    key: "toneCurve",
    label: "Curve",
    section: "grade",
    type: "curve",
    def: [
      [0, 0],
      [1, 1],
    ],
    hint:
      "Shape the tone directly. Applied after the sliders above, as Curves is " +
      "in an image editor: they set the range, this shapes what is inside it. " +
      "Drag a point, click the grid to add one, alt-click a point to remove it.",
  },
  {
    key: "contrast",
    label: "Contrast",
    section: "grade",
    type: "slider",
    def: 1,
    min: 0,
    max: 3,
    step: 0.01,
    decimals: 2,
  },
  {
    key: "gamma",
    label: "Gamma",
    section: "grade",
    type: "slider",
    def: 1,
    min: 0.1,
    max: 3,
    step: 0.01,
    decimals: 2,
  },
  {
    key: "blackPoint",
    label: "Black",
    section: "grade",
    type: "slider",
    def: 0,
    min: 0,
    max: 254,
    step: 1,
    decimals: 0,
  },
  {
    key: "whitePoint",
    label: "White",
    section: "grade",
    type: "slider",
    def: 255,
    min: 1,
    max: 255,
    step: 1,
    decimals: 0,
  },
  {
    key: "exposure",
    label: "Exposure",
    section: "grade",
    type: "slider",
    def: 0,
    min: -100,
    max: 100,
    step: 1,
    decimals: 0,
    unit: "%",
  },
  {
    key: "gradeBias",
    label: "Grade Bias",
    section: "grade",
    type: "slider",
    def: 0,
    min: -1,
    max: 1,
    step: 0.01,
    decimals: 2,
    modes: ["halftone"],
    hint: "Bends the tone -> dot size curve without moving pure black or pure white.",
  },
  {
    key: "lumaMode",
    label: "Luma",
    section: "grade",
    type: "choice",
    def: "luma709",
    options: ["luma709", "luma601", "perceptual"],
    optionLabels: { luma709: "Luma 709", luma601: "Luma 601", perceptual: "Perceptual" },
  },

  // ----------------------------------------------------------- Adjustments
  {
    key: "hue",
    label: "Hue",
    section: "adjust",
    type: "slider",
    def: 0,
    min: -180,
    max: 180,
    step: 1,
    decimals: 0,
    unit: "°",
  },
  {
    key: "saturation",
    label: "Saturation",
    section: "adjust",
    type: "slider",
    def: 1,
    min: 0,
    max: 3,
    step: 0.01,
    decimals: 2,
  },
  {
    key: "brightness",
    label: "Brightness",
    section: "adjust",
    type: "slider",
    def: 0,
    min: -100,
    max: 100,
    step: 1,
    decimals: 0,
  },
  {
    key: "invert",
    label: "Invert",
    section: "adjust",
    type: "toggle",
    def: false,
    hint: "Halftone: dots grow in the highlights and the paper flips. Dither: the tone curve inverts.",
  },

  // ---------------------------------------------------------------- Batch
  {
    key: "batchScope",
    label: "Scope",
    section: "batch",
    type: "choice",
    def: "selection",
    options: ["selection", "group", "document"],
    hint: "Which layers Batch Apply touches. Existing halftone output is always skipped.",
  },
  {
    key: "batchSharedPalette",
    label: "Shared palette",
    section: "batch",
    type: "toggle",
    def: true,
    hint: "Extract the palette once from the first layer and pin it for the rest, so a sequence does not crawl.",
  },

  // --------------------------------------------------------------- Output
  {
    key: "useSelection",
    label: "Use selection",
    section: "output",
    type: "toggle",
    def: true,
    hint: "Confine the render to the active selection when there is one. The grid still anchors to the layer, so dots do not shift when the selection changes.",
  },
  {
    key: "output",
    label: "Output",
    section: "output",
    type: "choice",
    def: "flat",
    options: ["flat", "separated"],
    hint: "Separated writes one solid-colour fill layer per palette colour, each with its own mask.",
  },
];

const SECTIONS = [
  { id: "mode", label: "Mode" },
  { id: "scale", label: "Scale" },
  { id: "halftone", label: "Halftone", modes: ["halftone"] },
  { id: "press", label: "Press Imperfection", modes: ["halftone"] },
  { id: "dither", label: "Dither", modes: ["dither"] },
  { id: "preprocess", label: "Pre-process" },
  { id: "colors", label: "Colors" },
  { id: "tonal", label: "Tonal Zones" },
  { id: "grade", label: "Grade" },
  { id: "adjust", label: "Color Adjustments" },
  { id: "output", label: "Output" },
  { id: "batch", label: "Batch" },
];

const DEF_BY_KEY = Object.create(null);
for (const d of PARAM_DEFS) DEF_BY_KEY[d.key] = d;

/** @returns {object} a fresh default parameter object */
function defaultParams() {
  const p = { version: SCHEMA_VERSION };
  for (const d of PARAM_DEFS) {
    p[d.key] = Array.isArray(d.def)
      ? d.def.map((e) => (Array.isArray(e) ? e.slice() : e))
      : d.def;
  }
  return p;
}

/**
 * Should this parameter be shown for the current state?
 * @param {ParamDef} def
 * @param {object} params
 */
function isVisible(def, params) {
  // Internal params carry state but have no row of their own.
  if (def.type === "internal") return false;
  if (def.modes && def.modes.indexOf(params.mode) < 0) return false;
  if (def.showIf && !def.showIf(params)) return false;
  return true;
}

function sectionVisible(section, params) {
  if (section.modes && section.modes.indexOf(params.mode) < 0) return false;
  return PARAM_DEFS.some((d) => d.section === section.id && isVisible(d, params));
}

/**
 * Coerce and clamp an arbitrary object into a valid parameter set.
 * Unknown keys are dropped, missing keys fall back to the default.
 * @param {object} raw
 * @returns {object}
 */
function sanitizeParams(raw) {
  const out = defaultParams();
  if (!raw || typeof raw !== "object") return out;

  for (const d of PARAM_DEFS) {
    const v = raw[d.key];
    if (v === undefined || v === null) continue;
    switch (d.type) {
      case "slider": {
        const n = Number(v);
        if (!Number.isFinite(n)) break;
        out[d.key] = Math.min(d.max, Math.max(d.min, n));
        break;
      }
      case "choice":
      case "chips":
        if (d.options.indexOf(v) >= 0) out[d.key] = v;
        break;
      case "toggle":
        out[d.key] = !!v;
        break;
      case "curve":
        // Untrusted like everything else read back from disk: the normaliser
        // sorts, clamps, drops duplicate x values and guarantees two points.
        if (Array.isArray(v)) out[d.key] = normaliseCurve(v);
        break;
      case "internal":
        if (Array.isArray(v)) {
          out[d.key] = v
            .map((n) => Math.round(Number(n)))
            .filter((n) => Number.isFinite(n) && n >= 0 && n < 64);
        }
        break;
      case "palette":
        if (Array.isArray(v)) {
          const hexes = v
            .filter((c) => typeof c === "string" && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c.trim()))
            .map((c) => normalizeHex(c));
          if (hexes.length) out[d.key] = hexes;
        }
        break;
      case "color":
        if (typeof v === "string") {
          out[d.key] = v === "auto" ? "auto" : normalizeHex(v) || "auto";
        }
        break;
      default:
        break;
    }
  }

  // colorCount and the palette length must agree.
  out.colorCount = Math.min(8, Math.max(2, Math.round(out.colorCount)));
  if (out.whitePoint <= out.blackPoint) out.whitePoint = Math.min(255, out.blackPoint + 1);
  if (out.highlightSplit <= out.shadowSplit) {
    out.highlightSplit = Math.min(0.95, out.shadowSplit + 0.05);
  }
  return out;
}

/**
 * A curve as stored: sorted, clamped, at least two points, no duplicate x.
 * Shared with the engine so the panel and the renderer can never disagree
 * about what a given set of points means.
 */
const { normaliseCurve } = require("../engine/grade.js");

function normalizeHex(c) {
  let h = String(c).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

function paramsEqual(a, b) {
  if (!a || !b) return false;
  for (const d of PARAM_DEFS) {
    const va = a[d.key];
    const vb = b[d.key];
    if (Array.isArray(va) || Array.isArray(vb)) {
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        // The curve is an array of pairs, so equality is one level deeper.
        if (Array.isArray(va[i]) || Array.isArray(vb[i])) {
          if (!Array.isArray(va[i]) || !Array.isArray(vb[i])) return false;
          if (va[i][0] !== vb[i][0] || va[i][1] !== vb[i][1]) return false;
        } else if (va[i] !== vb[i]) return false;
      }
    } else if (va !== vb) return false;
  }
  return true;
}

function cloneParams(p) {
  const out = {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    // Deep enough for the curve's array of pairs; nothing here nests further.
    out[k] = Array.isArray(v) ? v.map((e) => (Array.isArray(e) ? e.slice() : e)) : v;
  }
  return out;
}

/**
 * Resolve the grid resolution (cells or dither pixels across the longest edge)
 * for the current scale mode.
 *
 * DPI mode needs the document's own resolution to be meaningful: a 300 ppi
 * document rendered at 150 dpi wants one output pixel per two document pixels.
 *
 * @param {object} params
 * @param {number} sourceLongestPx longest edge of the document in pixels
 * @param {number} [docPPI] document resolution; 72 is assumed when unknown
 */
function resolveResolution(params, sourceLongestPx, docPPI) {
  const relative = params.mode === "dither" ? params.ditherResolution : params.density;
  if (params.scaleMode !== "dpi") return relative;
  const ppi = docPPI && docPPI > 1 ? docPPI : 72;
  const inches = sourceLongestPx / ppi;
  const cells = inches * params.dpi;
  const def = DEF_BY_KEY[params.mode === "dither" ? "ditherResolution" : "density"];
  return Math.min(def.max, Math.max(def.min, Math.round(cells)));
}

module.exports = {
  SCHEMA_VERSION,
  MODES,
  PARAM_DEFS,
  SECTIONS,
  DEF_BY_KEY,
  defaultParams,
  sanitizeParams,
  paramsEqual,
  cloneParams,
  normalizeHex,
  isVisible,
  sectionVisible,
  resolveResolution,
};
