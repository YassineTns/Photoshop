"use strict";

/**
 * Minimal, dependency-free PNG encoder.
 *
 * Two consumers:
 *  - the panel, which needs a data: URL to show the preview (UXP's canvas
 *    support varies by host version, an <img> never does);
 *  - the Node test harness, which writes visual artefacts to disk.
 *
 * THIS IS ON THE HOT PATH
 * Every preview tick encodes a PNG, base64s it and hands the host a data: URL to
 * decode. All three stages are linear in the compressed size, so the encoder's
 * output size is not a cosmetic concern - it is most of what the panel spends
 * its time on. An earlier version emitted *stored* (uncompressed) deflate
 * blocks, which is the simplest valid thing: a 340x340 preview came out as a
 * 462KB payload and a 603KB data URL, rebuilt on every drag.
 *
 * Two things fixed that, and they compound:
 *
 *  1. REAL COMPRESSION, from src/util/deflate.js.
 *  2. SCANLINE FILTERING, below. A PNG filter subtracts a neighbouring pixel
 *     before compression. On a halftone - large flat areas of paper with fine
 *     ink structure - that turns most of the image into runs of zeros, which is
 *     exactly what LZ77 is good at. Filtering alone roughly halves the
 *     compressed size again on this content.
 *
 * Base64 matters too and is easy to get wrong: building the string with `+=` one
 * quantum at a time was costing more than the compression does. It is chunked
 * through String.fromCharCode instead.
 */

const { zlibDeflate } = require("./deflate.js");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Re-exported from deflate.js, where the fast form lives. */
const { adler32 } = require("./deflate.js");

/* ------------------------------------------------------------------ *
 * Scanline filtering
 * ------------------------------------------------------------------ */

const FILTER_CANDIDATES = [0, 2];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Filter one scanline five ways and keep the cheapest.
 *
 * The selection heuristic is the one the PNG specification suggests: sum the
 * filtered bytes as signed values and take the smallest total, on the grounds
 * that bytes near zero are what compresses. It is not optimal - only trying the
 * actual compressor would be - but it costs five passes over a row rather than
 * five compressions of the image.
 *
 * @param {Uint8Array|Uint8ClampedArray} row current scanline, `stride` bytes
 * @param {Uint8Array|null} prior previous scanline, or null for the first
 * @param {number} stride
 * @param {Uint8Array} out destination, 1 + stride bytes (filter type first)
 * @param {Uint8Array} scratch stride bytes, reused between rows
 */
function filterRow(row, prior, stride, out, scratch, bpp) {
  const BPP = bpp || 4;
  let bestType = 0;
  let bestScore = Infinity;

  // Only None and Up are tried. Sub, Average and Paeth were measured on real
  // preview frames: they cost two to three times the filtering time and made
  // the *total* (filter + compress + base64) worse, because Up already turns a
  // halftone's flat areas into runs of zeros and the rest is fine dot structure
  // that no filter linearises.
  for (const type of FILTER_CANDIDATES) {
    // The first row has no row above it, so Up degenerates into None.
    if (!prior && type !== 0) continue;

    let score = 0;
    for (let x = 0; x < stride; x++) {
      const left = x >= BPP ? row[x - BPP] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= BPP ? prior[x - BPP] : 0;
      let v;
      switch (type) {
        case 1:
          v = (row[x] - left) & 0xff;
          break;
        case 2:
          v = (row[x] - up) & 0xff;
          break;
        case 3:
          v = (row[x] - ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          v = (row[x] - paeth(left, up, upLeft)) & 0xff;
          break;
        default:
          v = row[x];
      }
      scratch[x] = v;
      // Signed magnitude: 0xFF is -1, which is as cheap to code as +1.
      score += v < 128 ? v : 256 - v;
      if (score >= bestScore) break;
    }

    if (score < bestScore) {
      bestScore = score;
      bestType = type;
      out[0] = type;
      out.set(scratch.subarray(0, stride), 1);
    }
  }

  // If the winner was found early and then a later type broke out of its loop,
  // `out` still holds the winner - `out` is only written when a type completes
  // with a better score, and the early break can only happen on a worse one.
  return bestType;
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba length = width*height*4
 * @param {number} width
 * @param {number} height
 * @param {(raw: Uint8Array) => Uint8Array} [deflate] optional replacement
 *        compressor. Node tooling can pass zlib.deflateSync; the panel uses the
 *        built-in one, which is the point of this file being dependency-free.
 * @returns {Uint8Array} PNG bytes
 */
function encodePNG(rgba, width, height, deflate) {
  // A preview is always opaque - the renderer fills the paper colour across the
  // whole frame - so the alpha channel is a quarter of the bytes carrying no
  // information. Dropping it to colour type 2 takes a quarter off the filtering,
  // the compression, the base64 and the host's own decode. The scan that decides
  // costs one pass over the pixels, which is nothing against what it saves.
  const opaque = isOpaque(rgba, width * height);
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp;

  const buf = scratchFor(stride, height);
  const raw = buf.raw;

  // Two row buffers when dropping alpha, because filtering reads the previous
  // row and it must not be the one being rebuilt.
  let cur = buf.rgb;
  let prev = buf.rgbPrev;
  let prior = null;

  for (let y = 0; y < height; y++) {
    let row;
    if (opaque) {
      for (let x = 0, i = y * width * 4, o = 0; x < width; x++, i += 4, o += 3) {
        cur[o] = rgba[i];
        cur[o + 1] = rgba[i + 1];
        cur[o + 2] = rgba[i + 2];
      }
      row = cur;
    } else {
      row = rgba.subarray(y * stride, y * stride + stride);
    }
    filterRow(row, prior, stride, buf.rowOut, buf.scratch, bpp);
    raw.set(buf.rowOut, y * (stride + 1));
    // The filter is defined against the *unfiltered* previous row.
    prior = row;
    if (opaque) {
      const t = cur;
      cur = prev;
      prev = t;
    }
  }

  const z = deflate ? deflate(raw) : zlibDeflate(raw);

  const chunks = [];
  chunks.push(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // colour type: RGB or RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(makeChunk("IHDR", ihdr));
  chunks.push(makeChunk("IDAT", z));
  chunks.push(makeChunk("IEND", new Uint8Array(0)));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** @returns {boolean} whether every pixel is fully opaque. */
function isOpaque(rgba, pixels) {
  for (let i = 3, n = pixels * 4; i < n; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}

/**
 * Reusable working buffers, keyed by shape.
 *
 * The encoder runs on every preview frame and used to allocate about a megabyte
 * each time - the filtered image, a scratch row and a row buffer - all of it
 * garbage a frame later. Keeping one set alive and handing it back removes that
 * churn entirely. It is safe because the buffers never outlive the call: the
 * compressor consumes `raw` before encodePNG returns, and what is returned is a
 * fresh array.
 */
let SCRATCH = null;

function scratchFor(stride, height) {
  const rawLen = (stride + 1) * height;
  if (!SCRATCH || SCRATCH.stride !== stride || SCRATCH.raw.length !== rawLen) {
    SCRATCH = {
      stride,
      raw: new Uint8Array(rawLen),
      scratch: new Uint8Array(stride),
      rowOut: new Uint8Array(stride + 1),
      rgb: new Uint8Array(stride),
      rgbPrev: new Uint8Array(stride),
    };
  }
  return SCRATCH;
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  writeU32(out, 8 + data.length, crc);
  return out;
}

function writeU32(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

/* ------------------------------------------------------------------ *
 * Base64
 * ------------------------------------------------------------------ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_CODES = (() => {
  const t = new Uint8Array(64);
  for (let i = 0; i < 64; i++) t[i] = B64.charCodeAt(i);
  return t;
})();
/** Characters per String.fromCharCode call. Large enough to matter, small
 *  enough that no engine's argument limit is anywhere near. */
const B64_CHUNK = 8192;

/**
 * Base64 without relying on btoa (not guaranteed across UXP versions).
 *
 * Built through a byte buffer and chunked String.fromCharCode rather than
 * appending four characters at a time: on a few hundred kilobytes the naive
 * form was costing more than compressing the image does.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  const len = bytes.length;
  const outLen = 4 * Math.ceil(len / 3);
  const chars = new Uint8Array(outLen);
  let o = 0;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chars[o++] = B64_CODES[(n >>> 18) & 63];
    chars[o++] = B64_CODES[(n >>> 12) & 63];
    chars[o++] = B64_CODES[(n >>> 6) & 63];
    chars[o++] = B64_CODES[n & 63];
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    chars[o++] = B64_CODES[(n >>> 18) & 63];
    chars[o++] = B64_CODES[(n >>> 12) & 63];
    chars[o++] = 61; // '='
    chars[o++] = 61;
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chars[o++] = B64_CODES[(n >>> 18) & 63];
    chars[o++] = B64_CODES[(n >>> 12) & 63];
    chars[o++] = B64_CODES[(n >>> 6) & 63];
    chars[o++] = 61;
  }

  let out = "";
  for (let p = 0; p < o; p += B64_CHUNK) {
    out += String.fromCharCode.apply(null, chars.subarray(p, Math.min(p + B64_CHUNK, o)));
  }
  return out;
}

/** @returns {string} a data: URL suitable for <img src=...> */
function toDataURL(rgba, width, height) {
  return "data:image/png;base64," + toBase64(encodePNG(rgba, width, height));
}

module.exports = { encodePNG, toDataURL, toBase64, crc32, adler32, filterRow };
