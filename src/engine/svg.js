"use strict";

/**
 * Vector export.
 *
 * A halftone is a list of shapes long before it is a grid of pixels, so it wants
 * to be vector: a screen exported as SVG scales to any output size with no
 * resampling at all, which is the form a printer actually wants. Rasterising it
 * first and hoping 300dpi was enough is the thing this avoids.
 *
 * Per-ink screens export as one group per ink with `mix-blend-mode: multiply`,
 * mirroring how the raster path composites them, so the file reproduces the
 * render rather than approximating it.
 *
 * The dither path is deliberately NOT exported: it is one shape per pixel, so a
 * modest grid is already hundreds of thousands of rectangles. The caller is told
 * that plainly instead of being handed a file no application will open.
 */

const { getShape } = require("./shapes.js");
const { cellCentre } = require("./halftone.js");
const { sampleLUT, biasCurve, inkToRadius } = require("./grade.js");
const { adjustColor, rgbToHex } = require("./color.js");
const { paletteToLab, nearestIndex } = require("./palette.js");
const { dotJitter, isIdentity: jitterIsIdentity } = require("./jitter.js");

/** Above this, a viewer will struggle; the caller gets a warning, not a refusal. */
const BUSY_SHAPE_COUNT = 200000;

function fmt(n) {
  // Two decimals is well below a printer's resolution and roughly halves the
  // file size against the default float formatting.
  return Math.abs(n) < 0.005 ? "0" : (Math.round(n * 100) / 100).toString();
}

/**
 * One dot as an SVG element.
 * @returns {string}
 */
function shapeMarkup(shapeId, cx, cy, r, cell, colour, rot) {
  const t = rot ? ` transform="rotate(${fmt((rot * 180) / Math.PI)} ${fmt(cx)} ${fmt(cy)})"` : "";
  const fill = ` fill="${colour}"`;

  switch (shapeId) {
    case "square": {
      const s = r * 0.8862269254527580;
      return `<rect x="${fmt(cx - s)}" y="${fmt(cy - s)}" width="${fmt(s * 2)}" height="${fmt(s * 2)}"${fill}${t}/>`;
    }
    case "diamond": {
      const s = r * 1.2533141373155003;
      const pts = `${fmt(cx)},${fmt(cy - s)} ${fmt(cx + s)},${fmt(cy)} ${fmt(cx)},${fmt(cy + s)} ${fmt(cx - s)},${fmt(cy)}`;
      return `<polygon points="${pts}"${fill}${t}/>`;
    }
    case "ellipse": {
      // Matches the raster path: 1.3:1, long axis on the 45 degree diagonal.
      const a = r * Math.sqrt(1.3);
      const b = r / Math.sqrt(1.3);
      const deg = 45 + ((rot || 0) * 180) / Math.PI;
      return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(a)}" ry="${fmt(b)}"${fill} transform="rotate(${fmt(deg)} ${fmt(cx)} ${fmt(cy)})"/>`;
    }
    case "cross": {
      const arm = r * 1.35;
      const th = r * 0.42;
      return (
        `<g${t}${fill}>` +
        `<rect x="${fmt(cx - arm)}" y="${fmt(cy - th)}" width="${fmt(arm * 2)}" height="${fmt(th * 2)}"/>` +
        `<rect x="${fmt(cx - th)}" y="${fmt(cy - arm)}" width="${fmt(th * 2)}" height="${fmt(arm * 2)}"/>` +
        `</g>`
      );
    }
    case "line": {
      const halfW = cell * 0.5;
      const halfH = (r * r * Math.PI) / (4 * halfW);
      return `<rect x="${fmt(cx - halfW)}" y="${fmt(cy - halfH)}" width="${fmt(halfW * 2)}" height="${fmt(halfH * 2)}"${fill}${t}/>`;
    }
    default:
      return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}"${fill}/>`;
  }
}

/**
 * Single-screen halftone -> SVG.
 *
 * @param {object} cells   CellData, already scaled to the output size
 * @param {object} p       raster params (same object the rasteriser takes)
 * @param {number} width
 * @param {number} height
 * @returns {{svg: string, shapes: number}}
 */
function halftoneSVG(cells, p, width, height) {
  const grid = cells.grid;
  const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
  const gain = (grid.cell * (p.dotGain || 0)) / 100;
  const labPal = paletteToLab(p.palette);
  const adj = p.colorAdjust || {};
  const adjOut = [0, 0, 0];
  const centre = [0, 0];
  const jit = p.jitter && !jitterIsIdentity(p.jitter) ? p.jitter : null;
  const jOut = [0, 0, 1, 0];
  const fm = p.screenType === "fm" ? p.fmThreshold : null;

  // Grouped by colour: far smaller output, and it gives the printer one object
  // per ink to select.
  const byColour = new Map();
  let shapes = 0;

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const ci = row * grid.cols + col;
      const cnt = cells.count[ci];
      if (cnt === 0) continue;

      const L = cells.lum[ci] / cnt;
      const graded = sampleLUT(p.toneLUT, L);
      let ink = p.invert ? graded : 1 - graded;
      ink = biasCurve(ink, p.gradeBias);

      let r;
      if (fm) {
        if (ink <= fm(col, row)) continue;
        r = maxRadius;
      } else {
        r = inkToRadius(ink, maxRadius, p.radiusCurve);
        if (r <= 0.008) continue;
      }
      r += gain;

      const q = ci * 3;
      adjustColor(cells.rgb[q] / cnt, cells.rgb[q + 1] / cnt, cells.rgb[q + 2] / cnt, adj, adjOut);
      const col3 = p.palette[nearestIndex(labPal, adjOut[0], adjOut[1], adjOut[2])];
      const hex = rgbToHex(col3[0], col3[1], col3[2]);

      cellCentre(grid, col, row, centre);
      let rot = 0;
      let cx = centre[0];
      let cy = centre[1];
      if (jit) {
        dotJitter(col, row, jit, grid.cell, jOut);
        cx += jOut[0];
        cy += jOut[1];
        r *= jOut[2];
        rot = jOut[3];
        if (r <= 0.008) continue;
      }

      if (!byColour.has(hex)) byColour.set(hex, []);
      byColour.get(hex).push(shapeMarkup(p.shape, cx, cy, r, grid.cell, hex, rot));
      shapes++;
    }
  }

  const bg = rgbToHex(p.background[0], p.background[1], p.background[2]);
  const groups = [];
  for (const [hex, list] of byColour) {
    groups.push(`<g id="ink-${hex.slice(1)}">\n${list.join("\n")}\n</g>`);
  }

  return { svg: wrap(width, height, bg, groups.join("\n")), shapes };
}

/**
 * Per-ink screens -> SVG, one multiply group per ink.
 * @returns {{svg: string, shapes: number}}
 */
function screensSVG(screens, p, width, height) {
  const gainOf = (cell) => (cell * (p.dotGain || 0)) / 100;
  const jit = p.jitter && !jitterIsIdentity(p.jitter) ? p.jitter : null;
  const jOut = [0, 0, 1, 0];
  const fm = p.screenType === "fm" ? p.fmThreshold : null;
  const centre = [0, 0];
  const groups = [];
  let shapes = 0;

  screens.forEach((screen, s) => {
    const grid = screen.grid;
    const maxRadius = (grid.cell * 0.5 * p.radius) / 100;
    const gain = gainOf(grid.cell);
    const hex = rgbToHex(screen.color[0], screen.color[1], screen.color[2]);
    const mx = screen.offsetX || 0;
    const my = screen.offsetY || 0;
    const list = [];

    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const ci = row * grid.cols + col;
        if (screen.count[ci] === 0) continue;
        let r;
        if (fm) {
          if (screen.cov[ci] <= fm(col, row + s * 97)) continue;
          r = maxRadius;
        } else {
          r = inkToRadius(screen.cov[ci], maxRadius, p.radiusCurve);
          if (r <= 0.008) continue;
        }
        r += gain;
        cellCentre(grid, col, row, centre);
        let cx = centre[0] + mx;
        let cy = centre[1] + my;
        let rot = 0;
        if (jit) {
          dotJitter(col, row + s * 31, jit, grid.cell, jOut);
          cx += jOut[0];
          cy += jOut[1];
          r *= jOut[2];
          rot = jOut[3];
          if (r <= 0.008) continue;
        }
        list.push(shapeMarkup(p.shape, cx, cy, r, grid.cell, hex, rot));
        shapes++;
      }
    }

    // Multiply, so overprinting in the file matches overprinting in the render.
    groups.push(
      `<g id="screen-${s}-${hex.slice(1)}" data-angle="${fmt(screen.angle)}" ` +
        `style="mix-blend-mode: multiply">\n${list.join("\n")}\n</g>`
    );
  });

  const bg = rgbToHex(p.background[0], p.background[1], p.background[2]);
  return { svg: wrap(width, height, bg, groups.join("\n"), true), shapes };
}

function wrap(width, height, bg, body, isolate) {
  const style = isolate ? ' style="isolation: isolate"' : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"${style}>\n` +
    `<rect width="${width}" height="${height}" fill="${bg}"/>\n` +
    body +
    `\n</svg>\n`
  );
}

module.exports = { halftoneSVG, screensSVG, shapeMarkup, BUSY_SHAPE_COUNT };
