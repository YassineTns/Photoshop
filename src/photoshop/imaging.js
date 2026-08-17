"use strict";

/**
 * Pixel I/O.
 *
 * Two calls do the real work: imaging.getPixels to read a layer, and
 * imaging.putPixels to write one. Both are wrapped here so that the rest of the
 * plugin only ever sees a plain `{data: Uint8ClampedArray (RGBA), width, height}`
 * regardless of how many components the host handed back.
 *
 * Both must be called inside core.executeAsModal.
 */

const { imaging, app } = require("./host.js");

/** Cap on the longest edge we ever read. See readLayerPixels(). */
const READ_MAX_LONGEST = 2600;

/**
 * Read a layer's pixels as RGBA.
 *
 * The read is deliberately capped: the engine measures tone on a downscaled
 * analysis image anyway and never samples the source during rasterisation, so
 * pulling 24 million pixels across the bridge for a 6000x4000 document would
 * cost seconds and hundreds of megabytes for no visible benefit. `targetSize`
 * asks Photoshop to do the scaling; if a host build ignores it we simply get
 * the full resolution buffer and the engine downscales it itself, so the code
 * path is safe either way.
 *
 * @param {object} opts
 * @param {number} opts.documentID
 * @param {number} opts.layerID
 * @param {{left:number, top:number, right:number, bottom:number}} opts.bounds
 * @param {number} [opts.maxLongest]
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
async function readLayerPixels(opts) {
  const im = imaging();
  const bounds = opts.bounds;
  const srcW = bounds.right - bounds.left;
  const srcH = bounds.bottom - bounds.top;
  const cap = opts.maxLongest || READ_MAX_LONGEST;
  const longest = Math.max(srcW, srcH);

  const request = {
    documentID: opts.documentID,
    layerID: opts.layerID,
    sourceBounds: bounds,
    componentSize: 8,
    applyAlpha: false,
    colorSpace: "RGB",
  };
  if (longest > cap) {
    const s = cap / longest;
    request.targetSize = {
      width: Math.max(1, Math.round(srcW * s)),
      height: Math.max(1, Math.round(srcH * s)),
    };
  }

  let result;
  try {
    result = await im.getPixels(request);
  } catch (e) {
    // Some host builds reject an explicit targetSize on certain layer kinds.
    // Retry at full resolution before giving up; the engine can cope.
    if (!request.targetSize) throw e;
    delete request.targetSize;
    result = await im.getPixels(request);
  }

  const imageData = result.imageData;
  try {
    const width = imageData.width;
    const height = imageData.height;
    const components = imageData.components || 4;
    const raw = await imageData.getData({ chunky: true });
    return {
      data: toRGBA(raw, width, height, components),
      width,
      height,
    };
  } finally {
    if (imageData && typeof imageData.dispose === "function") imageData.dispose();
  }
}

/**
 * Normalise whatever component layout the host returned into straight RGBA.
 * @param {Uint8Array|Uint8ClampedArray} raw
 */
function toRGBA(raw, width, height, components) {
  const n = width * height;
  if (components === 4) {
    // Already RGBA; copy into a clamped array so downstream maths is safe.
    return raw instanceof Uint8ClampedArray ? raw : new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  }
  const out = new Uint8ClampedArray(n * 4);
  if (components === 3) {
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
      out[q] = raw[p];
      out[q + 1] = raw[p + 1];
      out[q + 2] = raw[p + 2];
      out[q + 3] = 255;
    }
  } else if (components === 1) {
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      const v = raw[i];
      out[q] = v;
      out[q + 1] = v;
      out[q + 2] = v;
      out[q + 3] = 255;
    }
  } else {
    throw new Error(`Unsupported component count from getPixels: ${components}`);
  }
  return out;
}

/**
 * Write an RGBA buffer into an existing layer.
 *
 * @param {object} opts
 * @param {number} opts.documentID
 * @param {number} opts.layerID
 * @param {Uint8ClampedArray} opts.data RGBA, width*height*4
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {{left:number, top:number, right:number, bottom:number}} opts.targetBounds
 */
async function writeLayerPixels(opts) {
  const im = imaging();
  // createImageDataFromBuffer wants a plain typed array view over the bytes.
  const bytes =
    opts.data instanceof Uint8Array
      ? opts.data
      : new Uint8Array(opts.data.buffer, opts.data.byteOffset, opts.data.length);

  const imageData = await im.createImageDataFromBuffer(bytes, {
    width: opts.width,
    height: opts.height,
    components: 4,
    componentSize: 8,
    chunky: true,
    colorProfile: "sRGB IEC61966-2.1",
    colorSpace: "RGB",
  });

  try {
    await im.putPixels({
      documentID: opts.documentID,
      layerID: opts.layerID,
      imageData,
      replace: true,
      targetBounds: opts.targetBounds,
    });
  } finally {
    if (imageData && typeof imageData.dispose === "function") imageData.dispose();
  }
}

/**
 * Write a single-channel buffer into a layer's mask.
 *
 * The imaging API exposes putLayerMask separately from putPixels. Its presence
 * is probed rather than assumed, because the colour-separated output depends on
 * it entirely and the caller needs to be able to fall back cleanly (and say so)
 * rather than half-build a broken layer stack.
 *
 * @param {object} opts
 * @param {number} opts.documentID
 * @param {number} opts.layerID
 * @param {Uint8ClampedArray} opts.data one byte per pixel
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {{left:number, top:number, right:number, bottom:number}} opts.targetBounds
 */
async function writeLayerMask(opts) {
  const im = imaging();
  if (!canWriteMasks()) {
    throw new Error("This Photoshop build has no imaging.putLayerMask, so masks cannot be written.");
  }
  const bytes =
    opts.data instanceof Uint8Array
      ? opts.data
      : new Uint8Array(opts.data.buffer, opts.data.byteOffset, opts.data.length);

  const imageData = await im.createImageDataFromBuffer(bytes, {
    width: opts.width,
    height: opts.height,
    components: 1,
    componentSize: 8,
    chunky: true,
    colorProfile: "Gray Gamma 2.2",
    colorSpace: "Grayscale",
  });

  try {
    await im.putLayerMask({
      documentID: opts.documentID,
      layerID: opts.layerID,
      imageData,
      replace: true,
      targetBounds: opts.targetBounds,
    });
  } finally {
    if (imageData && typeof imageData.dispose === "function") imageData.dispose();
  }
}

/** @returns {boolean} whether the colour-separated output is possible here. */
function canWriteMasks() {
  try {
    const im = imaging();
    return typeof im.putLayerMask === "function" && typeof im.createImageDataFromBuffer === "function";
  } catch (e) {
    return false;
  }
}

/** Whole-canvas bounds for the active document. */
function canvasBounds(doc) {
  return { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
}

/**
 * Photoshop's current foreground colour, used by the palette swatches.
 * @returns {number[]|null} rgb 0..255
 */
function foregroundRGB() {
  try {
    const c = app().foregroundColor;
    if (c && c.rgb) return [Math.round(c.rgb.red), Math.round(c.rgb.green), Math.round(c.rgb.blue)];
  } catch (e) {
    /* ignore */
  }
  return null;
}

module.exports = {
  readLayerPixels,
  writeLayerPixels,
  writeLayerMask,
  canWriteMasks,
  canvasBounds,
  foregroundRGB,
  toRGBA,
  READ_MAX_LONGEST,
};
