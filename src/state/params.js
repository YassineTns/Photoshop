"use strict";

/**
 * Single source of truth for the parameter set.
 *
 * The UI is generated from PARAM_DEFS, presets are validated against it, and
 * persisted renders are migrated through it. Adding a control means adding one
 * entry here.
 */

const SCHEMA_VERSION = 1;

/**
 * @typedef {object} ParamDef
 * @property {string} key
 * @property {string} label
 * @property {"slider"|"choice"|"toggle"|"palette"|"color"} type
 * @property {*} def default value
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {number} [decimals]
 * @property {string} [unit]
 * @property {string} [section]
 * @property {string[]} [options]
 * @property {string} [hint]
 */

/** @type {ParamDef[]} */
const PARAM_DEFS = [
  // ------------------------------------------------------------- Halftone
  {
    key: "density",
    label: "Density",
    section: "halftone",
    type: "slider",
    def: 90,
    min: 8,
    max: 400,
    step: 1,
    decimals: 0,
    unit: " cells",
    hint: "Cells across the longest edge. Resolution independent, so the preview matches the full render.",
  },
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
    hint: "0 = dot area follows tone (classic AM screen). 1 = dot radius follows tone (harder).",
  },
  {
    key: "angle",
    label: "Angle",
    section: "halftone",
    type: "slider",
    def: 0,
    min: 0,
    max: 90,
    step: 1,
    decimals: 0,
    unit: "°",
  },
  {
    key: "blur",
    label: "Blur",
    section: "halftone",
    type: "slider",
    def: 0,
    min: 0,
    max: 40,
    step: 0.1,
    decimals: 1,
    hint: "Pre-blur in resolution independent units (px per 1000px of the longest edge).",
  },
  {
    key: "shape",
    label: "Shape",
    section: "halftone",
    type: "choice",
    def: "circle",
    options: ["circle", "square", "diamond", "cross", "line"],
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
  },
  {
    key: "palette",
    label: "Palette",
    section: "colors",
    type: "palette",
    def: ["#161616", "#F5EBD8", "#EC3E32"],
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
    hint: "auto = lightest palette colour (darkest when Invert is on).",
  },

  // ---------------------------------------------------------------- Grade
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
    hint: "Bends the tone -> dot size curve without moving pure black or pure white.",
  },
  {
    key: "lumaMode",
    label: "Luma",
    section: "grade",
    type: "choice",
    def: "luma709",
    options: ["luma709", "luma601", "perceptual"],
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
    hint: "Dots grow in the highlights instead of the shadows, and the paper flips to the dark end.",
  },
];

const SECTIONS = [
  { id: "halftone", label: "Halftone" },
  { id: "colors", label: "Colors" },
  { id: "grade", label: "Grade" },
  { id: "adjust", label: "Color Adjustments" },
];

const DEF_BY_KEY = Object.create(null);
for (const d of PARAM_DEFS) DEF_BY_KEY[d.key] = d;

/** @returns {object} a fresh default parameter object */
function defaultParams() {
  const p = { version: SCHEMA_VERSION };
  for (const d of PARAM_DEFS) {
    p[d.key] = Array.isArray(d.def) ? d.def.slice() : d.def;
  }
  return p;
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
        if (d.options.indexOf(v) >= 0) out[d.key] = v;
        break;
      case "toggle":
        out[d.key] = !!v;
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
  return out;
}

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
      for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

function cloneParams(p) {
  const out = {};
  for (const k of Object.keys(p)) out[k] = Array.isArray(p[k]) ? p[k].slice() : p[k];
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  PARAM_DEFS,
  SECTIONS,
  DEF_BY_KEY,
  defaultParams,
  sanitizeParams,
  paramsEqual,
  cloneParams,
  normalizeHex,
};
