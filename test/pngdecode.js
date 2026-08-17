"use strict";

/**
 * An independent PNG decoder, for checking the encoder against.
 *
 * Deliberately written from the specification rather than shaped around what
 * src/util/png.js happens to emit, and it inflates with Node's own zlib rather
 * than anything of ours. That is the point: an encoder tested only by its own
 * decoder proves that the two agree, not that either is right. This one shares
 * no code with the encoder at all, so agreement between them is evidence.
 *
 * Supports what the encoder produces: 8-bit RGB (colour type 2) and 8-bit RGBA
 * (colour type 6), all five filter types. Anything else is an error rather than
 * a guess.
 */

const zlib = require("zlib");

/**
 * @param {Uint8Array} png
 * @returns {{data: Uint8ClampedArray, width: number, height: number,
 *            channels: number, filters: number[]}} RGBA out, whatever went in
 */
function decodePNG(png) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIG[i]) throw new Error("not a PNG (signature)");
  }

  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let ctype = 0;
  const idat = [];

  while (p + 8 <= png.length) {
    const len = readU32(png, p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    const data = png.subarray(p + 8, p + 8 + len);

    // Every chunk carries a CRC over its type and data; a wrong one means the
    // file is corrupt even if it happens to decode.
    const crcGot = readU32(png, p + 8 + len);
    const crcWant = crc32(png, p + 4, p + 8 + len);
    if (crcGot !== crcWant) throw new Error(`bad CRC on ${type} chunk`);

    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      depth = data[8];
      ctype = data[9];
      if (data[10] !== 0) throw new Error("unsupported compression method");
      if (data[11] !== 0) throw new Error("unsupported filter method");
      if (data[12] !== 0) throw new Error("interlacing is not supported");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;
  }

  if (depth !== 8) throw new Error(`expected 8 bits per channel, got ${depth}`);
  if (ctype !== 2 && ctype !== 6) throw new Error(`unsupported colour type ${ctype}`);
  const channels = ctype === 6 ? 4 : 3;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`inflated ${raw.length} bytes, expected ${(stride + 1) * height}`);
  }

  const lines = new Uint8Array(stride * height);
  const filters = [];

  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    filters.push(ft);
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      let v;
      switch (ft) {
        case 0:
          v = src[x];
          break;
        case 1:
          v = src[x] + a;
          break;
        case 2:
          v = src[x] + b;
          break;
        case 3:
          v = src[x] + ((a + b) >> 1);
          break;
        case 4:
          v = src[x] + paeth(a, b, c);
          break;
        default:
          throw new Error(`bad filter type ${ft} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
  }

  // Normalise to RGBA so callers can compare against what they encoded.
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, s = 0, d = 0; i < width * height; i++, s += channels, d += 4) {
    out[d] = lines[s];
    out[d + 1] = lines[s + 1];
    out[d + 2] = lines[s + 2];
    out[d + 3] = channels === 4 ? lines[s + 3] : 255;
  }

  return { data: out, width, height, channels, filters };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** A second, independent CRC-32 (bitwise, no table) so it shares nothing. */
function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { decodePNG };
