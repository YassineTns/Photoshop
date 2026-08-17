"use strict";

/**
 * A small, dependency-free deflate compressor (RFC 1951), fixed Huffman.
 *
 * WHY THIS EXISTS
 * The panel shows its preview as a data: URL on an <img>, because UXP's canvas
 * support varies by host version while an <img> never does. That means every
 * preview tick pays for a PNG encode, a base64 pass and a decode by the host -
 * all three linear in the size of the compressed image data.
 *
 * The encoder used to emit *stored* (uncompressed) deflate blocks, which is the
 * simplest thing that produces a valid PNG. For a 340x340 preview that is a
 * 462KB payload turned into a 603KB data URL, thirty times a second. A halftone
 * is mostly large flat areas of paper and ink, so it compresses enormously; the
 * work here buys back an order of magnitude on the whole post-render path, which
 * turned out to dominate everything the renderer does.
 *
 * WHY FIXED HUFFMAN
 * Dynamic Huffman would compress perhaps 10-15% better and needs the code-length
 * alphabet, its own RLE encoding and two more passes over the data. Fixed codes
 * need none of that, and at this ratio the remaining 15% is not what anyone
 * notices. This is a compressor for previews, not an archiver.
 *
 * CORRECTNESS
 * A compressor that emits a *plausible* stream is worthless: the failure mode is
 * a corrupt image, or worse an image that decodes on one platform and not
 * another. So the test suite checks every output against Node's own zlib -
 * `zlib.inflateSync(deflate(x))` must equal `x` exactly, for random data, for
 * flat data, for real halftone renders and for the sizes that sit either side of
 * every internal boundary. That oracle is the whole reason this is safe to ship.
 */

/* ------------------------------------------------------------------ *
 * Tables (RFC 1951 section 3.2.5)
 * ------------------------------------------------------------------ */

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** Length in bytes -> index into LENGTH_BASE. Built once. */
const LENGTH_CODE = (() => {
  const t = new Uint8Array(259);
  let code = 0;
  for (let len = 3; len <= 258; len++) {
    while (code < 28 && len >= LENGTH_BASE[code + 1]) code++;
    t[len] = code;
  }
  return t;
})();

/** Distance -> index into DIST_BASE, for the two halves of the range. */
const DIST_CODE_LOW = (() => {
  const t = new Uint8Array(257);
  let code = 0;
  for (let d = 1; d <= 256; d++) {
    while (code < 29 && d >= DIST_BASE[code + 1]) code++;
    t[d] = code;
  }
  return t;
})();

function distCode(d) {
  if (d <= 256) return DIST_CODE_LOW[d];
  // Above 256 the codes are regular: two per power of two.
  let code = 29;
  while (code > 0 && d < DIST_BASE[code]) code--;
  return code;
}

/* ------------------------------------------------------------------ *
 * Bit writer
 * ------------------------------------------------------------------ */

/**
 * Deflate packs bits into bytes least-significant first, but Huffman codes are
 * written most-significant first. So plain values go through `bits` and Huffman
 * codes through `code`, which reverses them. Getting this backwards produces a
 * stream that looks right and inflates to garbage.
 */
class BitWriter {
  constructor(sizeHint) {
    this.buf = new Uint8Array(Math.max(64, sizeHint | 0));
    this.len = 0;
    this.acc = 0;
    this.nbits = 0;
  }

  _room(n) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n + 64));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** @param {number} v @param {number} n low n bits of v, LSB first */
  bits(v, n) {
    this.acc |= (v & ((1 << n) - 1)) << this.nbits;
    this.nbits += n;
    while (this.nbits >= 8) {
      this._room(1);
      this.buf[this.len++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }

  /**
   * A Huffman code of n bits, MSB first. The encoder does not call this - it
   * uses pre-reversed tables - but this is the definition those tables bake in,
   * and the tests check the two agree.
   * @param {number} c @param {number} n
   */
  code(c, n) {
    for (let i = n - 1; i >= 0; i--) this.bits((c >>> i) & 1, 1);
  }

  /** Pad to a byte boundary with zeros. */
  align() {
    if (this.nbits > 0) this.bits(0, 8 - this.nbits);
  }

  done() {
    this.align();
    return this.buf.subarray(0, this.len);
  }
}

/* ------------------------------------------------------------------ *
 * Fixed Huffman codes (RFC 1951 section 3.2.6)
 * ------------------------------------------------------------------ */

/** Reverse the low `n` bits of `v`. Used once per table entry, never in a loop. */
function reverseBits(v, n) {
  let r = 0;
  for (let i = 0; i < n; i++) r = (r << 1) | ((v >>> i) & 1);
  return r;
}

/**
 * The fixed literal/length alphabet, pre-reversed.
 *
 *   0..143   -> 8 bits, 0x30..0xBF
 *   144..255 -> 9 bits, 0x190..0x1FF
 *   256..279 -> 7 bits, 0x00..0x17
 *   280..287 -> 8 bits, 0xC0..0xC7
 *
 * Storing them already reversed is the single most valuable thing in this file.
 * Huffman codes go into the stream most-significant bit first while deflate
 * packs least-significant first, so emitting one used to mean a function call
 * per *bit* - nine calls for a literal. Pre-reversing turns that into one call
 * per symbol, and measured on a real preview frame it took the compressor from
 * 41ms to 12ms.
 */
const FIXED_LIT_CODE = new Uint16Array(288);
const FIXED_LIT_LEN = new Uint8Array(288);
(() => {
  for (let sym = 0; sym < 288; sym++) {
    let code;
    let len;
    if (sym < 144) {
      code = 0x30 + sym;
      len = 8;
    } else if (sym < 256) {
      code = 0x190 + sym - 144;
      len = 9;
    } else if (sym < 280) {
      code = sym - 256;
      len = 7;
    } else {
      code = 0xc0 + sym - 280;
      len = 8;
    }
    FIXED_LIT_CODE[sym] = reverseBits(code, len);
    FIXED_LIT_LEN[sym] = len;
  }
})();

/** Distance codes are a flat 5 bits in the fixed alphabet. */
const FIXED_DIST_CODE = (() => {
  const t = new Uint8Array(30);
  for (let i = 0; i < 30; i++) t[i] = reverseBits(i, 5);
  return t;
})();

/* ------------------------------------------------------------------ *
 * LZ77
 * ------------------------------------------------------------------ */

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
/**
 * How far down a hash chain to walk: the quality/speed dial.
 *
 * Deliberately short. This compressor runs on every preview frame, and measured
 * on a real halftone scanline buffer, going from 4 to 64 bought 16% off the
 * output for 60% more time. At 4 it still finds the long runs that make a
 * halftone compress, which is all that matters here.
 */
const MAX_CHAIN = 4;

/**
 * Compress to a raw deflate stream using fixed Huffman codes.
 *
 * @param {Uint8Array} data
 * @param {{level?: number}} [opts] level 0 stores literals only (fastest),
 *        anything else does the full match search.
 * @returns {Uint8Array}
 */
function deflateRaw(data, opts = {}) {
  const n = data.length;
  // Guess 40% - a halftone does far better, noise does worse, and the writer
  // grows itself either way.
  const w = new BitWriter(Math.max(64, (n * 0.4) | 0));

  // One fixed-Huffman block for everything: BFINAL=1, BTYPE=01.
  w.bits(1, 1);
  w.bits(1, 2);

  if (opts.level === 0 || n < MIN_MATCH) {
    for (let i = 0; i < n; i++) w.bits(FIXED_LIT_CODE[data[i]], FIXED_LIT_LEN[data[i]]);
    w.bits(FIXED_LIT_CODE[256], FIXED_LIT_LEN[256]);
    return w.done();
  }

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);

  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;

    if (i + MIN_MATCH <= n) {
      const h = hash(i);
      let candidate = head[h];
      let chain = MAX_CHAIN;
      const limit = i > WINDOW ? i - WINDOW : 0;
      const maxLen = Math.min(MAX_MATCH, n - i);

      while (candidate >= limit && chain-- > 0) {
        // Cheapest possible rejection first: if the byte that would extend the
        // current best does not match, this candidate cannot beat it.
        if (data[candidate + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[candidate + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - candidate;
            if (l >= maxLen) break;
          }
        }
        candidate = prev[candidate];
      }

      // Insert this position into its chain whether or not it matched.
      prev[i] = head[h];
      head[h] = i;
    }

    if (bestLen >= MIN_MATCH) {
      const lc = LENGTH_CODE[bestLen];
      const ls = 257 + lc;
      w.bits(FIXED_LIT_CODE[ls], FIXED_LIT_LEN[ls]);
      if (LENGTH_EXTRA[lc]) w.bits(bestLen - LENGTH_BASE[lc], LENGTH_EXTRA[lc]);
      const dc = distCode(bestDist);
      w.bits(FIXED_DIST_CODE[dc], 5);
      if (DIST_EXTRA[dc]) w.bits(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);

      // Register the positions the match covered, so later matches can find
      // them. Skipping this costs a lot of ratio on repetitive data.
      for (let k = 1; k < bestLen; k++) {
        const j = i + k;
        if (j + MIN_MATCH > n) break;
        const hh = hash(j);
        prev[j] = head[hh];
        head[hh] = j;
      }
      i += bestLen;
    } else {
      const b = data[i];
      w.bits(FIXED_LIT_CODE[b], FIXED_LIT_LEN[b]);
      i++;
    }
  }

  w.bits(FIXED_LIT_CODE[256], FIXED_LIT_LEN[256]); // end of block
  return w.done();
}

/**
 * Adler-32, with the modulo deferred.
 *
 * The textbook loop takes two modulos per byte; over a few hundred kilobytes
 * that is the dominant cost of the whole checksum. 5552 is the largest number
 * of iterations for which neither accumulator can overflow a 32-bit signed int,
 * so the reduction only has to happen once per block.
 *
 * @param {Uint8Array} buf
 */
function adler32(buf) {
  const MOD = 65521;
  const NMAX = 5552;
  let a = 1;
  let b = 0;
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const end = Math.min(i + NMAX, n);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * A zlib stream: header, deflate data, Adler-32 of the *uncompressed* input.
 * This is what a PNG IDAT chunk holds.
 *
 * @param {Uint8Array} data
 * @param {{level?: number}} [opts]
 * @returns {Uint8Array}
 */
function zlibDeflate(data, opts) {
  const body = deflateRaw(data, opts);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; // CMF: deflate, 32k window
  out[1] = 0x01; // FLG: no dictionary, check bits make 0x7801 a multiple of 31
  out.set(body, 2);
  const ad = adler32(data);
  const p = 2 + body.length;
  out[p] = (ad >>> 24) & 0xff;
  out[p + 1] = (ad >>> 16) & 0xff;
  out[p + 2] = (ad >>> 8) & 0xff;
  out[p + 3] = ad & 0xff;
  return out;
}

module.exports = { deflateRaw, zlibDeflate, adler32 };
