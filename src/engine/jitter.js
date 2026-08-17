"use strict";

/**
 * Controlled imperfection.
 *
 * A mathematically perfect screen looks like a computer made it. Real printing
 * has slop: the paper shifts, the plate is not quite square, ink spreads
 * unevenly, and each colour lands a hair off the last. That misregistration is
 * most of what makes a risograph or a screen print read as *printed* rather than
 * rendered, and it is the one thing a perfect renderer cannot fake by accident.
 *
 * Two rules make this usable rather than just noisy:
 *
 *  1. IT IS DETERMINISTIC. Every offset comes from a hash of the cell's own
 *     coordinates and a seed, never from a random number generator. Re-rendering
 *     the same document gives the identical picture, the preview matches the
 *     full-resolution output, and an Update six months later reproduces what the
 *     user approved. A live RNG would break all three.
 *
 *  2. IT IS IN CELL UNITS. Offsets scale with the grid, so the imperfection
 *     looks the same on a 1000px preview and a 6000px render instead of
 *     vanishing on one and swamping the other.
 */

/**
 * Integer hash (a variant of Wang/xxhash mixing) -> [0, 1).
 *
 * Cheap, well distributed, and crucially *positional*: the same cell always
 * gets the same value, which is what makes the whole effect reproducible.
 */
function hash01(x, y, seed, salt) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2246822519 + (salt | 0) * 3266489917;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Signed variant, in [-1, 1). */
function hashSigned(x, y, seed, salt) {
  return hash01(x, y, seed, salt) * 2 - 1;
}

/**
 * @typedef {object} JitterParams
 * @property {number} jitterPosition 0..100, percent of a cell
 * @property {number} jitterSize     0..100, percent of the radius
 * @property {number} jitterAngle    0..180, degrees of per-dot rotation
 * @property {number} seed
 */

/** True when every jitter control is off, so the renderer can skip the work. */
function isIdentity(p) {
  return !(p.jitterPosition > 0) && !(p.jitterSize > 0) && !(p.jitterAngle > 0);
}

/**
 * Per-dot offset, size multiplier and rotation.
 *
 * @param {number} col
 * @param {number} row
 * @param {JitterParams} p
 * @param {number} cell cell size in output pixels
 * @param {number[]} out [dx, dy, sizeMul, rotationRadians]
 */
function dotJitter(col, row, p, cell, out) {
  const res = out || [0, 0, 1, 0];
  const seed = p.seed | 0;

  if (p.jitterPosition > 0) {
    const amp = (p.jitterPosition / 100) * cell * 0.5;
    res[0] = hashSigned(col, row, seed, 1) * amp;
    res[1] = hashSigned(col, row, seed, 2) * amp;
  } else {
    res[0] = 0;
    res[1] = 0;
  }

  if (p.jitterSize > 0) {
    // Bounded below at 0.05 so a dot never inverts or disappears entirely.
    res[2] = Math.max(0.05, 1 + hashSigned(col, row, seed, 3) * (p.jitterSize / 100));
  } else {
    res[2] = 1;
  }

  res[3] = p.jitterAngle > 0
    ? hashSigned(col, row, seed, 4) * (p.jitterAngle * Math.PI) / 180
    : 0;

  return res;
}

/**
 * Whole-screen offset for one ink: misregistration.
 *
 * Each plate lands slightly off the others. The offset is per ink and constant
 * across the sheet, which is what distinguishes it from per-dot jitter: the
 * whole colour shifts together, exactly as a misaligned plate does.
 *
 * @param {number} inkIndex
 * @param {number} amount 0..100, percent of a cell
 * @param {number} cell
 * @param {number} seed
 * @param {number[]} [out] [dx, dy]
 */
function inkOffset(inkIndex, amount, cell, seed, out) {
  const res = out || [0, 0];
  if (!(amount > 0)) {
    res[0] = 0;
    res[1] = 0;
    return res;
  }
  const amp = (amount / 100) * cell;
  // A random direction at a random distance, rather than independent x and y,
  // so the offsets look like a plate that slipped rather than axis-aligned drift.
  const angle = hash01(inkIndex, 0, seed, 11) * Math.PI * 2;
  const dist = (0.35 + 0.65 * hash01(inkIndex, 0, seed, 12)) * amp;
  res[0] = Math.cos(angle) * dist;
  res[1] = Math.sin(angle) * dist;
  return res;
}

module.exports = { hash01, hashSigned, dotJitter, inkOffset, isIdentity };
