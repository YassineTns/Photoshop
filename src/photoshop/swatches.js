"use strict";

/**
 * Palette import and export in the two formats Adobe apps actually exchange:
 *
 *   .act - Adobe Color Table. 768 raw bytes, 256 RGB triples, optionally
 *          followed by a 4 byte trailer giving the real colour count. Trivially
 *          simple and understood by Photoshop's own Indexed Color dialog.
 *
 *   .ase - Adobe Swatch Exchange. Big-endian, UTF-16BE names, float32 channels.
 *          This is the one that round-trips into Illustrator and InDesign.
 *
 * Both are written by hand: there is no dependency to pull in, and the formats
 * are small enough that hand-rolling them is less code than an adapter would be.
 */

const { uxp } = require("./host.js");
const { hexToRgb, rgbToHex } = require("../engine/color.js");

/* ------------------------------------------------------------------ *
 * ACT
 * ------------------------------------------------------------------ */

/**
 * @param {string[]} hexes
 * @returns {Uint8Array} 772 bytes (768 + count trailer)
 */
function encodeACT(hexes) {
  const out = new Uint8Array(772);
  const n = Math.min(256, hexes.length);
  for (let i = 0; i < n; i++) {
    const rgb = hexToRgb(hexes[i]) || [0, 0, 0];
    out[i * 3] = rgb[0];
    out[i * 3 + 1] = rgb[1];
    out[i * 3 + 2] = rgb[2];
  }
  // Trailer: colour count, then the transparent index (0xFFFF = none).
  out[768] = (n >> 8) & 255;
  out[769] = n & 255;
  out[770] = 0xff;
  out[771] = 0xff;
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string[]} hex colours
 */
function decodeACT(bytes) {
  if (!bytes || bytes.length < 768) throw new Error("Not a valid .act file (expected at least 768 bytes).");
  let count = 256;
  if (bytes.length >= 770) {
    const declared = (bytes[768] << 8) | bytes[769];
    if (declared > 0 && declared <= 256) count = declared;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(rgbToHex(bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * ASE
 * ------------------------------------------------------------------ */

function writeU16(arr, v) {
  arr.push((v >> 8) & 255, v & 255);
}

function writeU32(arr, v) {
  arr.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function writeF32(arr, v) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, false); // big endian
  const b = new Uint8Array(buf);
  arr.push(b[0], b[1], b[2], b[3]);
}

function writeUTF16BE(arr, str) {
  for (let i = 0; i < str.length; i++) writeU16(arr, str.charCodeAt(i));
  writeU16(arr, 0); // null terminator, which ASE counts in the length
}

/**
 * @param {string[]} hexes
 * @param {string} [groupName]
 * @returns {Uint8Array}
 */
function encodeASE(hexes, groupName) {
  const bytes = [];
  // Signature "ASEF", version 1.0
  bytes.push(0x41, 0x53, 0x45, 0x46);
  writeU16(bytes, 1);
  writeU16(bytes, 0);
  writeU32(bytes, hexes.length);

  for (let i = 0; i < hexes.length; i++) {
    const rgb = hexToRgb(hexes[i]) || [0, 0, 0];
    const name = `${groupName || "Halftone"} ${i + 1}`;

    const block = [];
    writeU16(block, name.length + 1); // in UTF-16 code units, including the null
    writeUTF16BE(block, name);
    block.push(0x52, 0x47, 0x42, 0x20); // "RGB "
    writeF32(block, rgb[0] / 255);
    writeF32(block, rgb[1] / 255);
    writeF32(block, rgb[2] / 255);
    writeU16(block, 0); // colour type: global

    writeU16(bytes, 0x0001); // block type: colour entry
    writeU32(bytes, block.length);
    for (const b of block) bytes.push(b);
  }
  return Uint8Array.from(bytes);
}

/**
 * @param {Uint8Array} bytes
 * @returns {string[]} hex colours
 */
function decodeASE(bytes) {
  if (!bytes || bytes.length < 12) throw new Error("Not a valid .ase file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x41 || bytes[1] !== 0x53 || bytes[2] !== 0x45 || bytes[3] !== 0x46
  ) {
    throw new Error("Not a valid .ase file (bad ASEF signature).");
  }

  const blocks = view.getUint32(8, false);
  const out = [];
  let p = 12;

  for (let i = 0; i < blocks && p + 6 <= bytes.length; i++) {
    const type = view.getUint16(p, false);
    const len = view.getUint32(p + 2, false);
    const body = p + 6;
    p = body + len;

    if (type !== 0x0001) continue; // group start / end blocks carry no colour

    let q = body;
    const nameLen = view.getUint16(q, false);
    q += 2 + nameLen * 2;
    if (q + 4 > bytes.length) break;
    const model = String.fromCharCode(bytes[q], bytes[q + 1], bytes[q + 2], bytes[q + 3]);
    q += 4;

    let rgb = null;
    if (model === "RGB ") {
      rgb = [
        view.getFloat32(q, false) * 255,
        view.getFloat32(q + 4, false) * 255,
        view.getFloat32(q + 8, false) * 255,
      ];
    } else if (model === "GRAY") {
      const g = view.getFloat32(q, false) * 255;
      rgb = [g, g, g];
    } else if (model === "CMYK") {
      const c = view.getFloat32(q, false);
      const m = view.getFloat32(q + 4, false);
      const y = view.getFloat32(q + 8, false);
      const k = view.getFloat32(q + 12, false);
      // Naive conversion. Exact CMYK needs a profile, which .ase does not carry.
      rgb = [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)];
    } else if (model === "LAB ") {
      // Rare in practice; skip rather than guess badly.
      continue;
    }
    if (rgb) out.push(rgbToHex(rgb[0], rgb[1], rgb[2]));
  }

  if (!out.length) throw new Error("No RGB, Gray or CMYK swatches found in that .ase file.");
  return out;
}

/* ------------------------------------------------------------------ *
 * File dialogs
 * ------------------------------------------------------------------ */

function fs() {
  const u = uxp();
  if (!u || !u.storage || !u.storage.localFileSystem) {
    throw new Error("File access is unavailable; check the plugin's localFileSystem permission.");
  }
  return u.storage.localFileSystem;
}

/**
 * Ask the user for a swatch file and return its colours.
 * @returns {Promise<{hexes: string[], name: string}|null>} null if cancelled
 */
async function importPalette() {
  const file = await fs().getFileForOpening({ types: ["ase", "act"] });
  if (!file) return null;
  const data = await file.read({ format: require("uxp").storage.formats.binary });
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const lower = String(file.name || "").toLowerCase();
  const hexes = lower.endsWith(".act") ? decodeACT(bytes) : decodeASE(bytes);
  return { hexes, name: file.name };
}

/**
 * Write the palette out.
 * @param {string[]} hexes
 * @param {string} format "ase" | "act"
 * @returns {Promise<string|null>} the file name, or null if cancelled
 */
async function exportPalette(hexes, format = "ase") {
  const ext = format === "act" ? "act" : "ase";
  const file = await fs().getFileForSaving(`halftone-palette.${ext}`, { types: [ext] });
  if (!file) return null;
  const bytes = ext === "act" ? encodeACT(hexes) : encodeASE(hexes);
  await file.write(bytes, { format: require("uxp").storage.formats.binary });
  return file.name;
}

module.exports = {
  encodeACT,
  decodeACT,
  encodeASE,
  decodeASE,
  importPalette,
  exportPalette,
};
