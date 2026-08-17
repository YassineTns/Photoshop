"use strict";

/**
 * Generates the panel icons declared in manifest.json.
 *
 *   npm run icons
 *
 * The mark is a halftone ramp - the plugin drawing its own icon. Coverage uses
 * the same "0.5 minus signed distance" rule as the renderer, written out here
 * because icons need straight alpha (no paper behind them) rather than the
 * opaque compositing the render path does.
 */

const fs = require("fs");
const path = require("path");
const { encodePNG } = require("../src/util/png.js");

const OUT_DIR = path.join(__dirname, "..", "icons");

/** Accent that reads on both the dark and light Photoshop themes. */
const INK = [236, 62, 50];
const INK_DARK = [40, 40, 44];

/**
 * @param {number} size
 * @param {number} cols dots per row
 */
function drawIcon(size, cols) {
  const data = new Uint8ClampedArray(size * size * 4);
  const cell = size / cols;
  const pad = cell * 0.5;

  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = pad + col * cell;
      const cy = pad + row * cell;
      // Tone ramps along the diagonal, so the icon reads as a gradient.
      const t = 1 - (col + row) / (2 * (cols - 1));
      const r = Math.sqrt(t) * cell * 0.46;
      if (r < 0.15) continue;
      const colour = t > 0.55 ? INK : INK_DARK;
      splat(data, size, cx, cy, r, colour);
    }
  }
  return data;
}

/** Antialiased disc with straight alpha. */
function splat(data, size, cx, cy, r, colour) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(size, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(size, Math.ceil(cy + r + 1));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) - r;
      if (d >= 0.5) continue;
      const a = d <= -0.5 ? 1 : 0.5 - d;
      const i = (y * size + x) * 4;
      const prev = data[i + 3] / 255;
      const out = a + prev * (1 - a);
      if (out <= 0) continue;
      // Composite in straight alpha so edges do not pick up a dark fringe.
      data[i] = (colour[0] * a + data[i] * prev * (1 - a)) / out;
      data[i + 1] = (colour[1] * a + data[i + 1] * prev * (1 - a)) / out;
      data[i + 2] = (colour[2] * a + data[i + 2] * prev * (1 - a)) / out;
      data[i + 3] = out * 255;
    }
  }
}

function write(name, size, cols) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = encodePNG(drawIcon(size, cols), size, size);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}

// Sizes declared in manifest.json, plus the @2x variants UXP looks for.
write("icon-23.png", 23, 4);
write("icon-23@2x.png", 46, 4);
write("icon-48.png", 48, 5);
write("icon-48@2x.png", 96, 5);
