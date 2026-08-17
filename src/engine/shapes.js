"use strict";

/**
 * Dot shapes, described as signed distance functions in pixel units.
 *
 * Rasterisation converts the SDF into a coverage value, which gives clean
 * analytic antialiasing at a fraction of the cost of supersampling:
 *
 *     coverage = clamp(0.5 - sdf, 0, 1)
 *
 * (sdf is a signed distance in pixels, so the 1px transition band straddles the
 * true edge.) For dots smaller than half a pixel the SDF is abandoned in favour
 * of splatting the exact analytic area, which is what makes the highlight end of
 * a gradient fade out smoothly instead of popping.
 *
 * Adding a shape only means adding an entry here; the renderer is generic.
 *
 * INTERIOR SPANS
 * A shape may also declare `span(dy, r, cell)`: the half-width of the strictly
 * interior part of the row at vertical offset `dy` - the run of pixels for which
 * the SDF is guaranteed to be <= -0.5, i.e. fully covered. The rasteriser fills
 * that run directly and only evaluates the SDF on the two edge fragments either
 * side, which for a large dot is most of its pixels skipped. It is optional:
 * a shape whose interior is not a cheap closed form (the rotated ellipse, the
 * non-convex cross) simply omits it and gets the generic per-pixel path. Any
 * `span` must be a strict *under*-estimate, never an over-estimate, or it would
 * paint pixels that should have been antialiased.

/**
 * @typedef {object} Shape
 * @property {string} id
 * @property {string} label
 * @property {(dx:number, dy:number, r:number, cell:number)=>number} sdf
 * @property {(r:number, cell:number)=>number} area   exact area in px^2
 * @property {(r:number, cell:number)=>number} extent half bounding box size
 * @property {((dy:number, r:number, cell:number)=>number)} [span]
 *           half-width of the fully covered run at row offset dy, 0 if none
 */

const SQRT2 = Math.SQRT2;

/**
 * How thick the engraved line gets, as a fraction of the cell, before the
 * crossing bar appears. Too low and everything is cross-hatched; too high and
 * the shadows block up before the crossing has anything to do.
 */
const ENGRAVE_CROSS_START = 0.2;

/** Ellipse semi-axes as multiples of the radius; a*b = 1 keeps the area equal. */
const ELLIPSE_RATIO = 1.3;
const ELLIPSE_A = Math.sqrt(ELLIPSE_RATIO);
const ELLIPSE_B = 1 / Math.sqrt(ELLIPSE_RATIO);

/** @type {Object<string, Shape>} */
const SHAPES = {
  circle: {
    id: "circle",
    label: "Circle",
    sdf: (dx, dy, r) => Math.sqrt(dx * dx + dy * dy) - r,
    area: (r) => Math.PI * r * r,
    extent: (r) => r,
    // hypot(dx,dy) - r <= -0.5  <=>  dx^2 <= (r-0.5)^2 - dy^2
    span: (dy, r) => {
      const ri = r - 0.5;
      const k = ri * ri - dy * dy;
      return k > 0 ? Math.sqrt(k) : 0;
    },
  },

  square: {
    id: "square",
    label: "Square",
    // Square of half-side r, area matched to a circle of radius r so switching
    // shape does not change the apparent ink density.
    sdf: (dx, dy, r) => {
      const s = r * 0.8862269254527580; // sqrt(pi)/2 -> equal area
      const ax = Math.abs(dx) - s;
      const ay = Math.abs(dy) - s;
      const outside = Math.hypot(Math.max(ax, 0), Math.max(ay, 0));
      return outside + Math.min(Math.max(ax, ay), 0);
    },
    area: (r) => Math.PI * r * r,
    extent: (r) => r * 0.8862269254527580 + 1,
    span: (dy, r) => {
      const s = r * 0.8862269254527580 - 0.5;
      return s > 0 && Math.abs(dy) <= s ? s : 0;
    },
  },

  diamond: {
    id: "diamond",
    label: "Diamond",
    sdf: (dx, dy, r) => {
      const s = r * 1.2533141373155003; // sqrt(pi/2) -> equal area
      return (Math.abs(dx) + Math.abs(dy) - s) / SQRT2;
    },
    area: (r) => Math.PI * r * r,
    extent: (r) => r * 1.2533141373155003 + 1,
    // (|dx| + |dy| - s) / sqrt(2) <= -0.5  <=>  |dx| <= s - sqrt(2)/2 - |dy|
    span: (dy, r) => {
      const w = r * 1.2533141373155003 - SQRT2 * 0.5 - Math.abs(dy);
      return w > 0 ? w : 0;
    },
  },

  ellipse: {
    id: "ellipse",
    label: "Ellipse",
    // Elongated along the 45 degree diagonal, area matched to a circle.
    //
    // The ratio is 1.3:1, not 2:1. Elliptical dots exist to soften the tone jump
    // at 50%, where circles all touch their neighbours at once: an ellipse
    // touches along its long axis first and its short axis later, spreading the
    // join over a range of tones. Push the ratio too far and the long axes chain
    // into unbroken diagonal lines through the shadows instead - which is what
    // 2:1 did here.
    sdf: (dx, dy, r) => {
      const c = Math.SQRT1_2;
      const px = Math.abs(dx * c + dy * c);
      const py = Math.abs(-dx * c + dy * c);
      const a = r * ELLIPSE_A;
      const b = r * ELLIPSE_B;
      // Quilez's ellipse distance approximation: exact at the boundary and
      // well behaved for the 1px antialiasing band, without an iterative solve.
      const k1 = Math.hypot(px / a, py / b);
      if (k1 < 1e-6) return -Math.min(a, b);
      const k2 = Math.hypot(px / (a * a), py / (b * b));
      return (k1 * (k1 - 1)) / k2;
    },
    area: (r) => Math.PI * r * r,
    extent: (r) => r * ELLIPSE_A + 1,
  },

  cross: {
    id: "cross",
    label: "Cross",
    sdf: (dx, dy, r) => {
      const arm = r * 1.35;
      const t = r * 0.42;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const a = boxSdf(ax, ay, arm, t);
      const b = boxSdf(ax, ay, t, arm);
      return Math.min(a, b);
    },
    area: (r) => {
      const arm = r * 1.35;
      const t = r * 0.42;
      return 2 * (2 * arm) * (2 * t) - (2 * t) * (2 * t);
    },
    extent: (r) => r * 1.35 + 1,
  },

  /*
   * The banknote engraving mark.
   *
   * Line engraving carries tone two ways at once: a continuous line whose
   * *thickness* follows the tone, and, once that line is thick enough to be
   * closing up, a second line crossing it. That crossover is what stops the
   * shadows becoming a solid black bar and is the reason engraved portraits
   * read as modelled rather than flat.
   *
   * Both bars span the whole cell, so neighbouring cells join into unbroken
   * lines rather than a row of separate dashes - which is the difference
   * between an engraving and a line screen.
   */
  engrave: {
    id: "engrave",
    label: "Engrave",
    sdf: (dx, dy, r, cell) => {
      const halfW = cell * 0.5 + 0.5;
      // Equal area to a circle of radius r, as every other shape here.
      const halfH = (r * r * Math.PI) / (4 * halfW);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const main = boxSdf(ax, ay, halfW, halfH);
      // The crossing bar starts only once the main line is thick enough that a
      // darker tone could not be told from the one before it.
      const cross = halfH - cell * ENGRAVE_CROSS_START;
      if (cross <= 0) return main;
      return Math.min(main, boxSdf(ax, ay, cross, halfW));
    },
    area: (r) => Math.PI * r * r,
    extent: (r, cell) => {
      const halfW = cell * 0.5 + 0.5;
      const halfH = (r * r * Math.PI) / (4 * halfW);
      return Math.max(halfW, halfH) + 1;
    },
  },

  line: {
    id: "line",
    label: "Line",
    // A horizontal bar spanning the cell; the "radius" drives its thickness.
    sdf: (dx, dy, r, cell) => {
      const halfW = cell * 0.5 + 0.5;
      const halfH = (r * r * Math.PI) / (4 * halfW); // equal area to a circle
      return boxSdf(Math.abs(dx), Math.abs(dy), halfW, halfH);
    },
    area: (r) => Math.PI * r * r,
    extent: (r, cell) => {
      const halfW = cell * 0.5 + 0.5;
      const halfH = (r * r * Math.PI) / (4 * halfW);
      return Math.max(halfW, halfH) + 1;
    },
    span: (dy, r, cell) => {
      const halfW = cell * 0.5 + 0.5;
      const halfH = (r * r * Math.PI) / (4 * halfW);
      return Math.abs(dy) <= halfH - 0.5 && halfW > 0.5 ? halfW - 0.5 : 0;
    },
  },
};

function boxSdf(ax, ay, hx, hy) {
  const px = ax - hx;
  const py = ay - hy;
  return Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0);
}

const SHAPE_IDS = Object.keys(SHAPES);

function getShape(id) {
  return SHAPES[id] || SHAPES.circle;
}

module.exports = { SHAPES, SHAPE_IDS, getShape, boxSdf };
