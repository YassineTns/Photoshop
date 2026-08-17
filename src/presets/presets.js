"use strict";

/**
 * Built-in starting points. Each preset is nothing more than a partial
 * parameter object merged over the defaults, so anything the UI can produce a
 * preset can reproduce.
 */

const { defaultParams, sanitizeParams } = require("../state/params.js");

/** @type {{id: string, name: string, params: object}[]} */
const BUILTIN_PRESETS = [
  {
    id: "classic-bw",
    name: "Classic B&W",
    params: {
      mode: "halftone",
      density: 110,
      radius: 108,
      radiusCurve: 0,
      angle: 45,
      blur: 0.6,
      shape: "circle",
      colorCount: 2,
      spread: 0,
      palette: ["#111111", "#FFFFFF"],
      paletteLocked: true,
      background: "#FFFFFF",
      contrast: 1.15,
      gamma: 1,
      gradeBias: 0,
      hue: 0,
      saturation: 1,
      invert: false,
    },
  },
  {
    id: "soft-print",
    name: "Soft Print",
    params: {
      mode: "halftone",
      density: 80,
      radius: 96,
      radiusCurve: 0,
      angle: 0,
      blur: 2.4,
      shape: "circle",
      colorCount: 4,
      spread: 0.2,
      palette: ["#2B2B33", "#6E7A8A", "#C9BFAE", "#F3EDE2"],
      paletteLocked: true,
      background: "#F3EDE2",
      contrast: 0.95,
      gamma: 1.05,
      gradeBias: 0.08,
      hue: 0,
      saturation: 0.85,
      invert: false,
    },
  },
  {
    id: "comic",
    name: "Comic",
    params: {
      mode: "halftone",
      density: 70,
      radius: 125,
      radiusCurve: 0.15,
      angle: 15,
      blur: 1.2,
      shape: "circle",
      colorCount: 3,
      spread: 0.55,
      palette: ["#161616", "#F5EBD8", "#EC3E32"],
      paletteLocked: true,
      background: "#F5EBD8",
      contrast: 1.45,
      gamma: 0.95,
      gradeBias: 0.12,
      hue: 0,
      saturation: 1.25,
      invert: false,
    },
  },
  {
    id: "newspaper",
    name: "Newspaper",
    params: {
      mode: "halftone",
      density: 150,
      radius: 112,
      radiusCurve: 0,
      angle: 45,
      blur: 0.8,
      shape: "circle",
      colorCount: 2,
      spread: 0.1,
      palette: ["#1A1815", "#DCD6C6"],
      paletteLocked: true,
      background: "#DCD6C6",
      contrast: 1.35,
      gamma: 1.1,
      blackPoint: 10,
      whitePoint: 245,
      gradeBias: -0.05,
      hue: 0,
      saturation: 0.4,
      invert: false,
    },
  },
  {
    id: "rgb-pop",
    name: "RGB Pop",
    params: {
      mode: "halftone",
      density: 95,
      radius: 132,
      radiusCurve: 0.2,
      angle: 0,
      blur: 1.0,
      shape: "circle",
      colorCount: 5,
      spread: 0.75,
      paletteLocked: false,
      background: "auto",
      contrast: 1.3,
      gamma: 1,
      gradeBias: 0.15,
      hue: 0,
      saturation: 1.6,
      invert: false,
    },
  },
  {
    id: "retro-poster",
    name: "Retro Poster",
    params: {
      mode: "halftone",
      density: 60,
      radius: 118,
      radiusCurve: 0.1,
      angle: 30,
      blur: 2.0,
      shape: "diamond",
      colorCount: 4,
      spread: 0.5,
      palette: ["#22201E", "#D9534F", "#E8B33C", "#EFE6D2"],
      paletteLocked: true,
      background: "#EFE6D2",
      contrast: 1.2,
      gamma: 1.15,
      gradeBias: 0.1,
      hue: 0,
      saturation: 1.1,
      invert: false,
    },
  },

  /* ------------------------------------------------------------------ *
   * Dither presets
   * ------------------------------------------------------------------ */

  {
    id: "mac-classic",
    name: "Mac Classic",
    params: {
      mode: "dither",
      ditherAlgorithm: "atkinson",
      ditherResolution: 420,
      ditherStrength: 1,
      serpentine: true,
      colorCount: 2,
      palette: ["#000000", "#FFFFFF"],
      paletteLocked: true,
      spread: 0,
      sharpen: 60,
      sharpenRadius: 1.5,
      contrast: 1.15,
      gamma: 1,
      hue: 0,
      saturation: 1,
      invert: false,
    },
  },
  {
    id: "newsprint-dither",
    name: "Newsprint Dither",
    params: {
      mode: "dither",
      ditherAlgorithm: "cluster45",
      ditherResolution: 700,
      ditherStrength: 1,
      colorCount: 2,
      palette: ["#1A1815", "#DCD6C6"],
      paletteLocked: true,
      spread: 0.1,
      blur: 0.4,
      contrast: 1.25,
      gamma: 1.05,
      saturation: 0.4,
      invert: false,
    },
  },
  {
    id: "handheld-green",
    name: "Handheld Green",
    params: {
      mode: "dither",
      ditherAlgorithm: "bayer4",
      ditherResolution: 220,
      ditherStrength: 1,
      colorCount: 4,
      palette: ["#0F380F", "#306230", "#8BAC0F", "#9BBC0F"],
      paletteLocked: true,
      spread: 0,
      sharpen: 40,
      contrast: 1.2,
      tonalMapping: false,
      saturation: 1,
      invert: false,
    },
  },
  {
    id: "blue-noise-photo",
    name: "Blue Noise",
    params: {
      mode: "dither",
      ditherAlgorithm: "bluenoise",
      ditherResolution: 900,
      ditherStrength: 1,
      colorCount: 6,
      paletteLocked: false,
      spread: 0.2,
      noiseReduction: 25,
      sharpen: 30,
      contrast: 1.05,
      saturation: 1.05,
      invert: false,
    },
  },
  {
    id: "zone-poster",
    name: "Zone Poster",
    params: {
      mode: "dither",
      ditherAlgorithm: "stucki",
      ditherResolution: 500,
      ditherStrength: 1,
      colorCount: 6,
      palette: ["#141021", "#3B2D5C", "#B8456A", "#E8804F", "#F2C46B", "#FBF3DC"],
      paletteLocked: true,
      spread: 0.3,
      tonalMapping: true,
      shadowSplit: 0.3,
      highlightSplit: 0.68,
      contrast: 1.2,
      saturation: 1.15,
      invert: false,
    },
  },
];

/**
 * Merge a preset over the defaults and validate.
 * @param {object} preset entry from BUILTIN_PRESETS or a user preset
 * @returns {object} full parameter set
 */
function presetToParams(preset) {
  return sanitizeParams(Object.assign(defaultParams(), preset && preset.params));
}

function findPreset(list, id) {
  return (list || []).find((p) => p.id === id) || null;
}

/**
 * Build a user preset record from the current parameters.
 * @param {string} name
 * @param {object} params
 */
function makeUserPreset(name, params) {
  return {
    id: `user-${slug(name)}-${shortId()}`,
    name: String(name || "Untitled").slice(0, 48),
    user: true,
    params: sanitizeParams(params),
  };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "preset";
}

function shortId() {
  return Math.floor(Math.random() * 0xfffff).toString(36);
}

module.exports = { BUILTIN_PRESETS, presetToParams, findPreset, makeUserPreset };
