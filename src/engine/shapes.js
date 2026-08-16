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
 */

/**
 * @typedef {object} Shape
 * @property {string} id
 * @property {string} label
 * @property {(dx:number, dy:number, r:number, cell:number)=>number} sdf
 * @property {(r:number, cell:number)=>number} area   exact area in px^2
 * @property {(r:number, cell:number)=>number} extent half bounding box size
 */

const SQRT2 = Math.SQRT2;

/** @type {Object<string, Shape>} */
const SHAPES = {
  circle: {
    id: "circle",
    label: "Circle",
    sdf: (dx, dy, r) => Math.sqrt(dx * dx + dy * dy) - r,
    area: (r) => Math.PI * r * r,
    extent: (r) => r,
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
