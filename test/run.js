"use strict";

/**
 * Engine validation suite.
 *
 *   node test/run.js            run assertions
 *   node test/run.js --visual   also write PNG artefacts to test/out/
 *   node test/run.js --heavy    include the 6000x4000 case (slow, ~1GB peak)
 *
 * The engine is deliberately free of any UXP dependency so all of this runs in
 * plain Node.
 */

const fs = require("fs");
const path = require("path");

const { HalftoneEngine } = require("../src/engine/pipeline.js");
const { computeGrid, scaleGrid, sampleCells, cellCentre } = require("../src/engine/halftone.js");
const { buildToneLUT, biasCurve, inkToRadius, sampleLUT } = require("../src/engine/grade.js");
const { gaussianBlurRGBA } = require("../src/engine/blur.js");
const { quantize, extractSamples } = require("../src/engine/quantization.js");
const { applySpread, padPalette, nearestIndex, paletteToLab } = require("../src/engine/palette.js");
const { SHAPES, SHAPE_IDS } = require("../src/engine/shapes.js");
const D = require("../src/engine/dither.js");
const { zoneBands, makeZoneRange } = require("../src/engine/tonemap.js");
const { unsharpMask, reduceNoise } = require("../src/engine/preprocess.js");
const SEP = require("../src/engine/separation.js");
const SWATCH = require("../src/photoshop/swatches.js");
const { hexToRgb, rgbToHex, luma709, adjustColor, rgbToOklab } = require("../src/engine/color.js");
const { defaultParams, sanitizeParams, PARAM_DEFS } = require("../src/state/params.js");
const { BUILTIN_PRESETS, presetToParams } = require("../src/presets/presets.js");
const { encodePNG } = require("../src/util/png.js");
const F = require("./fixtures.js");

const VISUAL = process.argv.includes("--visual");
const HEAVY = process.argv.includes("--heavy");
const OUT_DIR = path.join(__dirname, "out");

let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
  } else {
    failed++;
    failures.push(`${currentGroup} > ${msg}${detail ? `\n        ${detail}` : ""}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${msg}${detail ? `\n        ${detail}` : ""}`);
  }
}

function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg, `expected ${b} +/- ${tol}, got ${a}`);
}

function save(name, img) {
  if (!VISUAL) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name), encodePNG(img.data, img.width, img.height));
}

/** Average colour of a rendered buffer. */
function meanRGB(img) {
  let r = 0, g = 0, b = 0;
  const n = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
  }
  return [r / n, g / n, b / n];
}

/** Fraction of pixels that are not the background colour (counts AA edges as full). */
function inkCoverage(img, bg) {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (
      Math.abs(img.data[i] - bg[0]) > 6 ||
      Math.abs(img.data[i + 1] - bg[1]) > 6 ||
      Math.abs(img.data[i + 2] - bg[2]) > 6
    ) {
      n++;
    }
  }
  return n / (img.width * img.height);
}

/**
 * Ink *density*: the integral of partial coverage, so an antialiased edge pixel
 * counts for the fraction it actually covers. Unlike inkCoverage this is
 * resolution independent (a small dot has proportionally far more edge pixels),
 * which is what makes it the right metric for comparing across output sizes.
 */
function inkDensity(img, bg) {
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    sum +=
      (Math.abs(img.data[i] - bg[0]) +
        Math.abs(img.data[i + 1] - bg[1]) +
        Math.abs(img.data[i + 2] - bg[2])) /
      765;
  }
  return sum / (img.width * img.height);
}

function hasNaN(img) {
  for (let i = 0; i < img.data.length; i++) if (!Number.isFinite(img.data[i])) return true;
  return false;
}

/** Radii the engine would produce, per cell, for the given params. */
function cellRadii(engine, params) {
  const cells = engine._ensureCells(params);
  const rp = engine._rasterParams(params);
  const g = cells.grid;
  const maxRadius = (g.cell * 0.5 * params.radius) / 100;
  const out = [];
  for (let row = 0; row < g.rows; row++) {
    const line = [];
    for (let col = 0; col < g.cols; col++) {
      const ci = row * g.cols + col;
      const cnt = cells.count[ci];
      if (!cnt) {
        line.push(null);
        continue;
      }
      const L = cells.lum[ci] / cnt;
      const graded = sampleLUT(rp.toneLUT, L);
      let ink = params.invert ? graded : 1 - graded;
      ink = biasCurve(ink, params.gradeBias);
      line.push(inkToRadius(ink, maxRadius, params.radiusCurve));
    }
    out.push(line);
  }
  return out;
}

/** Render an 8-bit mask as a greyscale RGBA image, for visual inspection. */
function maskToRGBA(mask, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = mask[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function mkEngine(img) {
  const e = new HalftoneEngine();
  e.setSource(img);
  return e;
}

/* ================================================================== *
 * 1. Pure helpers
 * ================================================================== */

group("Colour + grade primitives");
{
  ok(rgbToHex(255, 0, 0) === "#FF0000", "rgbToHex round trip");
  const rt = hexToRgb("#EC3E32");
  ok(rt && rt[0] === 236 && rt[1] === 62 && rt[2] === 50, "hexToRgb parses 6 digit hex");
  ok(hexToRgb("#abc")[0] === 170, "hexToRgb expands 3 digit hex");
  ok(hexToRgb("nope") === null, "hexToRgb rejects garbage");

  near(luma709(0, 0, 0), 0, 1e-6, "luma of black is 0");
  near(luma709(255, 255, 255), 1, 1e-6, "luma of white is 1");

  // Bias must be monotonic and pin the endpoints.
  let monotonic = true;
  for (const bias of [-0.9, -0.4, 0, 0.4, 0.9]) {
    near(biasCurve(0, bias), 0, 1e-9, `biasCurve(0, ${bias}) === 0`);
    near(biasCurve(1, bias), 1, 1e-9, `biasCurve(1, ${bias}) === 1`);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = biasCurve(i / 100, bias);
      if (v < prev - 1e-9) monotonic = false;
      prev = v;
    }
  }
  ok(monotonic, "biasCurve is monotonic for every bias");
  ok(biasCurve(0.5, 0.5) > 0.5, "positive bias fattens midtones");
  ok(biasCurve(0.5, -0.5) < 0.5, "negative bias thins midtones");

  // Radius mapping: area proportional to ink.
  near(inkToRadius(0, 10, 0), 0, 1e-9, "zero ink -> zero radius");
  near(inkToRadius(1, 10, 0), 10, 1e-9, "full ink -> max radius");
  near(inkToRadius(0.25, 10, 0), 5, 1e-9, "quarter ink -> half radius (area law)");

  // Tone LUT
  const lut = buildToneLUT({ contrast: 1, gamma: 1, blackPoint: 0, whitePoint: 255, exposure: 0 });
  near(sampleLUT(lut, 0), 0, 1e-6, "identity LUT maps 0 -> 0");
  near(sampleLUT(lut, 1), 1, 1e-6, "identity LUT maps 1 -> 1");
  near(sampleLUT(lut, 0.5), 0.5, 0.01, "identity LUT maps 0.5 -> 0.5");

  const hi = buildToneLUT({ contrast: 2, gamma: 1, blackPoint: 0, whitePoint: 255, exposure: 0 });
  ok(sampleLUT(hi, 0.75) > sampleLUT(lut, 0.75), "contrast lifts the upper mids");
  ok(sampleLUT(hi, 0.25) < sampleLUT(lut, 0.25), "contrast drops the lower mids");

  // Hue rotation must not change HSL lightness (this is what lets the engine
  // skip re-measuring geometry when only Hue moves).
  const before = adjustColor(200, 60, 40, {});
  const after = adjustColor(200, 60, 40, { hue: 120, saturation: 1, brightness: 0 });
  const lBefore = (Math.max(...before) + Math.min(...before)) / 2;
  const lAfter = (Math.max(...after) + Math.min(...after)) / 2;
  near(lAfter, lBefore, 1.5, "hue rotation preserves HSL lightness");
}

group("Blur");
{
  const img = F.gradient(256, 64);
  const b = gaussianBlurRGBA(img, 4);
  ok(b.width === 256 && b.height === 64, "blur preserves dimensions");
  ok(!hasNaN(b), "blur produces no NaN");
  // A linear ramp is its own blur away from the edges.
  const mid = (y, x) => b.data[(y * 256 + x) * 4];
  near(mid(32, 128), img.data[(32 * 256 + 128) * 4], 2, "blur preserves a linear ramp in the interior");

  const flat = F.solid(64, 64, 120, 130, 140);
  const fb = gaussianBlurRGBA(flat, 8);
  near(fb.data[0], 120, 1, "blur of a flat field is flat (R)");
  near(fb.data[1], 130, 1, "blur of a flat field is flat (G)");

  // Radius larger than the image must not blow up.
  const tiny = F.solid(3, 3, 200, 200, 200);
  const tb = gaussianBlurRGBA(tiny, 40);
  ok(!hasNaN(tb) && tb.data[0] > 190, "blur radius larger than the image is clamped safely");

  const zero = gaussianBlurRGBA(img, 0);
  ok(zero.data[100] === img.data[100], "sigma 0 is a passthrough");
}

group("Quantisation + palette");
{
  const img = F.flats(200, 200);
  const samples = extractSamples(img, 8000);
  ok(samples.length % 3 === 0 && samples.length > 0, "extractSamples returns RGB triplets");

  // Median cut represents each box by its mean, and its box boundaries do not
  // line up with the clusters, so it is expected to be coarser than the other
  // two. That difference is exactly why k-means is the default.
  // Error is measured in OKLab, the space the renderer actually matches colours
  // in. (Measuring it in RGB would report a large "error" for a pair the
  // renderer considers close, and vice versa.) An OKLab dE below ~0.02 is
  // imperceptible; 0.13 is a visible but recognisable shift.
  const tolerance = { kmeans: 0.02, mediancut: 0.15, popularity: 0.02 };
  for (const method of ["kmeans", "mediancut", "popularity"]) {
    const pal = quantize(samples, 5, method);
    ok(pal.length === 5, `${method} returns the requested colour count (${pal.length})`);
    const lab = paletteToLab(pal);
    let worst = 0;
    for (const c of [[230, 30, 40], [250, 200, 40], [30, 120, 220], [20, 20, 24], [245, 240, 225]]) {
      const i = nearestIndex(lab, c[0], c[1], c[2]);
      const a = rgbToOklab(c[0], c[1], c[2]);
      const b = rgbToOklab(pal[i][0], pal[i][1], pal[i][2]);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    ok(
      worst < tolerance[method],
      `${method} matches every flat within dE ${tolerance[method]} (worst ${worst.toFixed(4)})`
    );
  }

  const sorted = quantize(samples, 5, "kmeans");
  let asc = true;
  for (let i = 1; i < sorted.length; i++) {
    if (luma709(...sorted[i]) < luma709(...sorted[i - 1]) - 1e-6) asc = false;
  }
  ok(asc, "palette is sorted dark -> light");

  // Determinism: k-means is seeded by median cut, so repeated runs match.
  const a = quantize(samples, 4, "kmeans");
  const b = quantize(samples, 4, "kmeans");
  ok(JSON.stringify(a) === JSON.stringify(b), "k-means is deterministic (median cut seeded)");

  // A flat image can only yield one colour; padding must still hit the count.
  const flatPal = quantize(extractSamples(F.solid(64, 64, 10, 10, 10)), 6, "kmeans");
  ok(padPalette(flatPal, 6).length === 6, "padPalette guarantees the requested count");

  // Spread should increase the luminance span.
  const base = [[60, 60, 60], [120, 120, 120], [180, 180, 180]];
  const spreadPal = applySpread(base, 1);
  const spanBefore = luma709(...base[2]) - luma709(...base[0]);
  const spanAfter = luma709(...spreadPal[2]) - luma709(...spreadPal[0]);
  ok(spanAfter > spanBefore, `spread widens the palette (${spanBefore.toFixed(3)} -> ${spanAfter.toFixed(3)})`);
  ok(JSON.stringify(applySpread(base, 0)) === JSON.stringify(base), "spread 0 is the identity");
}

group("Parameters + presets");
{
  const d = defaultParams();
  ok(PARAM_DEFS.every((p) => d[p.key] !== undefined), "defaults cover every param definition");

  const s = sanitizeParams({ density: 1e9, radius: -50, shape: "hexagon", palette: ["#fff", "zzz"] });
  ok(s.density <= 400 && s.radius === 0, "sanitize clamps out-of-range numbers");
  ok(s.shape === "circle", "sanitize rejects unknown enum values");
  ok(s.palette.length === 1 && s.palette[0] === "#FFFFFF", "sanitize filters invalid hex and normalises");
  ok(sanitizeParams(null).density === d.density, "sanitize survives null");
  ok(sanitizeParams({ whitePoint: 10, blackPoint: 200 }).whitePoint > 200, "sanitize repairs inverted levels");

  for (const preset of BUILTIN_PRESETS) {
    const p = presetToParams(preset);
    ok(p.shape && p.density > 0 && Array.isArray(p.palette), `preset "${preset.name}" produces valid params`);
  }
  ok(BUILTIN_PRESETS.length >= 6, "at least six built-in presets");
}

/* ================================================================== *
 * 2. Render behaviour
 * ================================================================== */

group("Black image");
{
  const params = sanitizeParams({
    density: 40,
    radius: 100,
    colorCount: 2,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  });
  const e = mkEngine(F.black(400, 400));
  const out = e.render(params);
  save("01-black.png", out);

  const cov = inkCoverage(out, [255, 255, 255]);
  ok(cov > 0.7, `a black image is almost fully inked (coverage ${(cov * 100).toFixed(1)}%)`);
  const radii = cellRadii(e, params).flat().filter((r) => r !== null);
  const maxR = e._ensureCells(params).grid.cell * 0.5;
  ok(radii.every((r) => Math.abs(r - maxR) < 1e-6), "every cell is at maximum radius");
  ok(!hasNaN(out), "no NaN in output");
}

group("White image");
{
  const params = sanitizeParams({
    density: 40,
    radius: 100,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  });
  const e = mkEngine(F.white(400, 400));
  const out = e.render(params);
  save("02-white.png", out);

  const cov = inkCoverage(out, [255, 255, 255]);
  ok(cov < 0.001, `a white image lays down no ink (coverage ${(cov * 100).toFixed(4)}%)`);
  const radii = cellRadii(e, params).flat().filter((r) => r !== null);
  ok(radii.every((r) => r < 1e-6), "every radius is zero");
}

group("Black -> white gradient (the important one)");
{
  const params = sanitizeParams({
    density: 60,
    radius: 100,
    angle: 0,
    blur: 0,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  });
  const e = mkEngine(F.gradient(900, 300));
  const out = e.render(params);
  save("03-gradient.png", out);

  const rows = cellRadii(e, params);
  const mid = rows[Math.floor(rows.length / 2)].filter((r) => r !== null);
  ok(mid.length > 20, `gradient produced ${mid.length} cells across`);

  // Monotonic decrease, dark (left, big dots) -> light (right, small dots).
  let worstViolation = 0;
  for (let i = 1; i < mid.length; i++) {
    worstViolation = Math.max(worstViolation, mid[i] - mid[i - 1]);
  }
  const cell = e._ensureCells(params).grid.cell;
  ok(
    worstViolation <= cell * 0.02,
    `radii decrease monotonically across the ramp (worst increase ${worstViolation.toFixed(4)}px)`
  );

  // Smoothness is a property of the *ink*, not the radius: the engine makes dot
  // area proportional to tone, so on a linear ramp r^2 must advance in equal
  // steps. (Testing the radius itself would be wrong - sqrt legitimately has a
  // steep derivative near zero.) Edge cells are trimmed because the grid is
  // centred and the outermost cells cover only part of the image.
  const inner = mid.slice(1, -1);
  const steps = [];
  for (let i = 1; i < inner.length; i++) {
    steps.push(Math.abs(inner[i] * inner[i] - inner[i - 1] * inner[i - 1]));
  }
  const meanStep = steps.reduce((a, b) => a + b, 0) / steps.length;
  const maxStep = Math.max(...steps);
  ok(
    maxStep < meanStep * 1.35,
    `dot area advances in near-equal steps (max ${maxStep.toFixed(3)} vs mean ${meanStep.toFixed(3)} px^2)`
  );
  const minStep = Math.min(...steps);
  ok(minStep > meanStep * 0.65, `no flat spot in the ramp (min step ${minStep.toFixed(3)} px^2)`);

  // Endpoints
  ok(mid[0] > cell * 0.45, "the black end reaches full radius");
  ok(mid[mid.length - 1] < cell * 0.06, "the white end fades to nothing");

  // The sub-pixel splat path must actually engage on the highlight end.
  const tiny = mid.filter((r) => r > 0 && r < 0.5);
  ok(tiny.length > 0, `${tiny.length} cells exercise the sub-pixel area splat`);

  // Ink coverage should fall off across the render, band by band.
  const bands = 6;
  const cov = [];
  for (let b = 0; b < bands; b++) {
    const x0 = Math.floor((b * out.width) / bands);
    const x1 = Math.floor(((b + 1) * out.width) / bands);
    let n = 0;
    let t = 0;
    for (let y = 0; y < out.height; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * out.width + x) * 4;
        t++;
        if (out.data[i] < 200) n++;
      }
    }
    cov.push(n / t);
  }
  let decreasing = true;
  for (let i = 1; i < cov.length; i++) if (cov[i] > cov[i - 1] + 0.005) decreasing = false;
  ok(decreasing, `ink coverage decreases across the ramp [${cov.map((c) => (c * 100).toFixed(1)).join(", ")}]`);

  // Regression: the paper colour must not be selectable as a dot colour. When
  // it was, every cell lighter than the mid point drew a white dot on white
  // paper and the ramp died half way across.
  const bands10 = [];
  for (let b = 0; b < 10; b++) {
    const x0 = Math.floor((b * out.width) / 10);
    const x1 = Math.floor(((b + 1) * out.width) / 10);
    let sum = 0;
    let n = 0;
    for (let y = 0; y < out.height; y++) {
      for (let x = x0; x < x1; x++) {
        sum += 255 - out.data[(y * out.width + x) * 4];
        n++;
      }
    }
    bands10.push(sum / n / 255);
  }
  ok(
    bands10.every((v) => v > 0.01),
    `every tenth of the ramp carries ink [${bands10.map((v) => v.toFixed(3)).join(", ")}]`
  );
  ok(out.ink.length === 1 && out.ink[0] === "#000000", `two-colour palette leaves exactly one ink (${out.ink.join(",")})`);
  let strictlyDown = true;
  for (let i = 1; i < bands10.length; i++) if (bands10[i] >= bands10[i - 1]) strictlyDown = false;
  ok(strictlyDown, "ink falls strictly, band by band, over the whole ramp");
}

group("Flat colours");
{
  const params = sanitizeParams({
    density: 50,
    radius: 110,
    colorCount: 5,
    paletteLocked: false,
    quantMethod: "kmeans",
    spread: 0,
    background: "auto",
  });
  const e = mkEngine(F.flats(500, 300));
  const out = e.render(params);
  save("04-flats.png", out);

  ok(out.palette.length === 5, `palette has 5 entries (${out.palette.join(" ")})`);
  const pal = out.palette.map(hexToRgb);
  for (const c of [[230, 30, 40], [30, 120, 220]]) {
    const lab = paletteToLab(pal);
    const i = nearestIndex(lab, c[0], c[1], c[2]);
    const d = Math.hypot(pal[i][0] - c[0], pal[i][1] - c[1], pal[i][2] - c[2]);
    ok(d < 45, `source colour ${rgbToHex(...c)} survives quantisation (dE ${d.toFixed(1)})`);
  }
  ok(!hasNaN(out), "no NaN in output");
}

group("Photograph");
{
  const params = presetToParams(BUILTIN_PRESETS.find((p) => p.id === "comic"));
  const e = mkEngine(F.photo(800, 600));
  const out = e.render(params);
  save("05-photo-comic.png", out);
  ok(!hasNaN(out), "no NaN in output");
  const cov = inkCoverage(out, out.background);
  ok(cov > 0.05 && cov < 0.95, `sensible ink coverage (${(cov * 100).toFixed(1)}%)`);

  for (const preset of BUILTIN_PRESETS) {
    const p = presetToParams(preset);
    const r = e.render(p);
    ok(!hasNaN(r) && r.width === 800, `preset "${preset.name}" renders`);
    save(`06-preset-${preset.id}.png`, r);
  }
}

group("Shapes");
{
  const e = mkEngine(F.gradient(600, 200));
  for (const id of SHAPE_IDS) {
    const params = sanitizeParams({
      density: 40,
      radius: 100,
      shape: id,
      palette: ["#101010", "#F0EDE4"],
      paletteLocked: true,
      spread: 0,
      background: "#F0EDE4",
    });
    const out = e.render(params);
    save(`07-shape-${id}.png`, out);
    ok(!hasNaN(out), `shape "${id}" renders without NaN`);
    const cov = inkCoverage(out, [240, 237, 228]);
    ok(cov > 0.05 && cov < 0.9, `shape "${id}" lays down a sensible amount of ink (${(cov * 100).toFixed(1)}%)`);
  }

  // Equal-area calibration: swapping shape should not change total ink much.
  const base = sanitizeParams({
    density: 40,
    radius: 90,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  });
  const covs = {};
  for (const id of ["circle", "square", "diamond"]) {
    const out = e.render(Object.assign({}, base, { shape: id }));
    covs[id] = inkCoverage(out, [255, 255, 255]);
  }
  const vals = Object.values(covs);
  const spread = (Math.max(...vals) - Math.min(...vals)) / Math.max(...vals);
  ok(spread < 0.12, `circle/square/diamond carry comparable ink (${(spread * 100).toFixed(1)}% spread)`);
}

group("Invert, angle, transparency");
{
  const img = F.gradient(600, 200);
  const e = mkEngine(img);
  const base = {
    density: 40,
    radius: 100,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "auto",
  };
  const normal = e.render(sanitizeParams(base));
  const inverted = e.render(sanitizeParams(Object.assign({}, base, { invert: true })));
  save("08-invert.png", inverted);

  ok(
    normal.background[0] === 255 && inverted.background[0] === 0,
    "invert flips the auto background to the dark end"
  );
  const nMean = meanRGB(normal)[0];
  const iMean = meanRGB(inverted)[0];
  ok(Math.abs(nMean - (255 - iMean)) < 60, `invert roughly mirrors the tonal balance (${nMean.toFixed(0)} vs ${iMean.toFixed(0)})`);

  for (const angle of [0, 15, 45, 90]) {
    const out = e.render(sanitizeParams(Object.assign({}, base, { angle })));
    ok(!hasNaN(out), `angle ${angle} renders cleanly`);
    save(`09-angle-${angle}.png`, out);
  }

  // Transparent regions must not be inked.
  const ae = mkEngine(F.withAlpha(400, 200));
  const aout = ae.render(sanitizeParams(Object.assign({}, base, { background: "#FFFFFF" })));
  save("10-alpha.png", aout);
  let rightInk = 0;
  for (let y = 0; y < aout.height; y++) {
    for (let x = Math.floor(aout.width * 0.6); x < aout.width; x++) {
      const i = (y * aout.width + x) * 4;
      if (aout.data[i] < 240) rightInk++;
    }
  }
  ok(rightInk === 0, `fully transparent regions stay empty (${rightInk} inked pixels)`);
}

group("Resolution independence (preview == full render)");
{
  const img = F.photo(1200, 900);
  const e = mkEngine(img);
  const params = presetToParams(BUILTIN_PRESETS.find((p) => p.id === "comic"));

  const small = e.render(params, { width: 300, height: 225 });
  const full = e.render(params, { width: 1200, height: 900 });
  save("11-preview-small.png", small);
  save("11-preview-full.png", full);

  const cs = e._ensureCells(params);
  ok(cs.grid.cols > 1 && cs.grid.rows > 1, "grid has cells");

  // Same cells -> same layout. Compare the mean colour and ink coverage.
  const ms = meanRGB(small);
  const mf = meanRGB(full);
  for (let c = 0; c < 3; c++) near(ms[c], mf[c], 12, `preview and full render agree on channel ${c} mean`);

  const covS = inkDensity(small, small.background);
  const covF = inkDensity(full, full.background);
  ok(
    Math.abs(covS - covF) < 0.02,
    `ink density matches across resolutions (${covS.toFixed(4)} vs ${covF.toFixed(4)}, 4x scale)`
  );

  // Dot centres must land at the same relative position.
  const gs = scaleGrid(cs.grid, 300, 225);
  const gf = scaleGrid(cs.grid, 1200, 900);
  const ps = cellCentre(gs, 3, 3);
  const pf = cellCentre(gf, 3, 3);
  near(ps[0] * 4, pf[0], 1.5, "cell centres scale exactly (x)");
  near(ps[1] * 4, pf[1], 1.5, "cell centres scale exactly (y)");
}

group("Cache invalidation");
{
  const e = mkEngine(F.photo(600, 400));
  const p = defaultParams();
  e.render(p);
  const cellsA = e._ensureCells(p);

  // Hue must not invalidate the geometry - that is the whole point of the
  // stage split.
  const hueChanged = Object.assign({}, p, { hue: 90 });
  e.render(hueChanged);
  ok(e._ensureCells(hueChanged) === cellsA, "changing Hue reuses the measured cells");

  const contrastChanged = Object.assign({}, p, { contrast: 2 });
  ok(e._ensureCells(contrastChanged) === cellsA, "changing Contrast reuses the measured cells");

  const radiusChanged = Object.assign({}, p, { radius: 50 });
  ok(e._ensureCells(radiusChanged) === cellsA, "changing Radius reuses the measured cells");

  const densityChanged = Object.assign({}, p, { density: 200 });
  ok(e._ensureCells(densityChanged) !== cellsA, "changing Density re-measures the cells");

  const blurChanged = Object.assign({}, p, { blur: 5 });
  ok(e._ensureCells(blurChanged) !== cellsA, "changing Blur re-measures the cells");

  // Hue actually changes the picture even though geometry is cached.
  const a = e.render(p);
  const b = e.render(hueChanged);
  ok(JSON.stringify(a.palette) !== JSON.stringify(b.palette), "Hue still changes the rendered palette");
}

group("Determinism");
{
  const e1 = mkEngine(F.photo(400, 300));
  const e2 = mkEngine(F.photo(400, 300));
  const p = presetToParams(BUILTIN_PRESETS[4]); // RGB Pop, extracted palette
  const a = e1.render(p);
  const b = e2.render(p);
  let identical = a.data.length === b.data.length;
  if (identical) {
    for (let i = 0; i < a.data.length; i++) {
      if (a.data[i] !== b.data[i]) {
        identical = false;
        break;
      }
    }
  }
  ok(identical, "two engines produce byte-identical output for the same input");
}

/* ================================================================== *
 * 2b. Dither mode
 * ================================================================== */

group("Dither: matrices");
{
  const b4 = D.bayerMatrix(2);
  ok(b4.size === 4, "bayerMatrix(2) is 4x4");
  const vals = Array.from(b4.data).map((v) => Math.floor(v * 16)).sort((a, b) => a - b);
  ok(vals.join(",") === "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15", "Bayer 4x4 is a permutation of 0..15");
  ok(Math.floor(b4.data[0] * 16) === 0 && Math.floor(b4.data[1] * 16) === 8, "Bayer 4x4 matches the canonical first row");
  ok(b4.data[0] > 0 && b4.data[0] < 1 / 16, "thresholds are centred in their bin, not at its edge");

  const b8 = D.bayerMatrix(3);
  ok(b8.size === 8 && new Set(Array.from(b8.data)).size === 64, "Bayer 8x8 has 64 distinct thresholds");

  const cl = D.clusteredMatrix(8, false);
  const centre = cl.data[4 * 8 + 4];
  const corner = cl.data[0];
  ok(centre < corner, `clustered dots grow from the centre outward (${centre.toFixed(2)} < ${corner.toFixed(2)})`);

  const t0 = Date.now();
  const bn = D.blueNoiseMatrix(64);
  const bnMs = Date.now() - t0;
  ok(bn.size === 64, "blue noise is 64x64");
  ok(bnMs < 1500, `blue noise builds once, quickly (${bnMs}ms)`);
  ok(D.blueNoiseMatrix(64) === bn, "blue noise is cached after the first build");
  let bnMin = 1, bnMax = 0, bnSum = 0;
  for (const v of bn.data) {
    bnMin = Math.min(bnMin, v);
    bnMax = Math.max(bnMax, v);
    bnSum += v;
  }
  ok(bnMin > 0 && bnMin < 0.001 && bnMax > 0.99, `blue noise spans the full range (${bnMin.toFixed(5)} .. ${bnMax.toFixed(3)})`);
  near(bnSum / bn.data.length, 0.5, 0.01, "blue noise has a flat histogram");
  // Blue noise must have far less low-frequency energy than white noise. Compare
  // the mean absolute difference between neighbours: blue noise decorrelates.
  const neighbourVariation = (m) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size - 1; x++) {
        sum += Math.abs(m.data[y * m.size + x] - m.data[y * m.size + x + 1]);
        n++;
      }
    }
    return sum / n;
  };
  ok(
    neighbourVariation(bn) > neighbourVariation(D.bayerMatrix(4)) * 0.8,
    "blue noise neighbours are strongly decorrelated"
  );

  ok(D.ALGORITHM_IDS.length >= 20, `${D.ALGORITHM_IDS.length} dither algorithms registered`);
  for (const a of D.ALGORITHMS) {
    if (a.family === "diffusion") {
      const k = D.DIFFUSION_KERNELS[a.kernel];
      ok(!!k && k.length > 0, `${a.id} has a diffusion kernel`);
      const bad = k.filter((e) => e[1] < 0 || (e[1] === 0 && e[0] <= 0));
      ok(bad.length === 0, `${a.id} only pushes error onto unvisited pixels`);
    }
  }
}

group("Dither: tone reproduction");
{
  // The whole point of dithering: the local average must track the source.
  const img = F.gradient(512, 96);
  const pal = [[0, 0, 0], [255, 255, 255]];
  const labPal = paletteToLab(pal);
  const BANDS = 8;

  const expected = [];
  for (let b = 0; b < BANDS; b++) {
    let sum = 0;
    let n = 0;
    for (let x = (b * 512) / BANDS; x < ((b + 1) * 512) / BANDS; x++) {
      sum += 1 - (x * 255) / 511 / 255;
      n++;
    }
    expected.push(sum / n);
  }

  // The tolerance is derived, not guessed. An ordered matrix with L distinct
  // thresholds can only represent tone in steps of 1/L, so its best possible
  // worst-case error is 1/(2L) once the thresholds are centred; asserting that
  // bound checks each matrix achieves the best it structurally can, instead of
  // hiding a real regression behind a loose constant.
  //
  // Two documented exceptions:
  //   threshold  - no matrix at all, so it cannot reproduce tone by design
  //   atkinson   - discards 25% of its error on purpose; that is what produces
  //                the blown-out early-Macintosh look
  const toleranceFor = (algo) => {
    if (algo === "threshold") return 1;
    if (algo === "atkinson") return 0.13;
    const a = D.getAlgorithm(algo);
    if (a.family === "diffusion") return 0.03;
    const levels = new Set(Array.from(a.matrix().data)).size;
    return 1 / (2 * levels) + 0.012;
  };

  for (const algo of D.ALGORITHM_IDS) {
    const idx = D.ditherToIndices(img, {
      labPal,
      palette: pal,
      algorithm: algo,
      strength: 1,
      serpentine: true,
    });
    let worst = 0;
    for (let b = 0; b < BANDS; b++) {
      let ink = 0;
      let n = 0;
      for (let y = 0; y < 96; y++) {
        for (let x = Math.floor((b * 512) / BANDS); x < Math.floor(((b + 1) * 512) / BANDS); x++) {
          if (idx[y * 512 + x] === 0) ink++;
          n++;
        }
      }
      worst = Math.max(worst, Math.abs(ink / n - expected[b]));
    }
    const tol = toleranceFor(algo);
    ok(
      worst <= tol,
      `${algo} reproduces the ramp within the ${tol.toFixed(3)} its matrix allows (worst ${worst.toFixed(3)})`
    );
  }
}

group("Dither: through the pipeline");
{
  const e = mkEngine(F.photo(800, 600));
  const base = {
    mode: "dither",
    ditherResolution: 300,
    colorCount: 4,
    paletteLocked: false,
    spread: 0.2,
  };

  for (const algo of ["floydsteinberg", "bayer8", "bluenoise", "atkinson", "cluster45"]) {
    const p = sanitizeParams(Object.assign({}, base, { ditherAlgorithm: algo }));
    const out = e.render(p, { width: 800, height: 600 });
    save(`21-dither-${algo}.png`, out);
    ok(!hasNaN(out), `${algo} renders without NaN`);
    // Every output pixel must be exactly a palette colour - that is what makes
    // the separated output's masks lossless.
    const allowed = new Set(out.palette);
    let offPalette = 0;
    for (let i = 0; i < out.data.length; i += 4 * 997) {
      const hex = rgbToHex(out.data[i], out.data[i + 1], out.data[i + 2]);
      if (!allowed.has(hex)) offPalette++;
    }
    ok(offPalette === 0, `${algo} emits only palette colours (${offPalette} strays)`);
  }

  // Resolution independence: the dither grid is fixed, so scaling the output
  // must not change the pattern, only its size.
  const p = sanitizeParams(Object.assign({}, base, { ditherAlgorithm: "bayer8" }));
  const small = e.render(p, { width: 400, height: 300 });
  const big = e.render(p, { width: 1600, height: 1200 });
  const ms = meanRGB(small);
  const mb = meanRGB(big);
  for (let c = 0; c < 3; c++) near(ms[c], mb[c], 6, `dither mean is scale invariant on channel ${c}`);

  // Amount 0 must remove the pattern entirely.
  const flat = e.render(sanitizeParams(Object.assign({}, base, { ditherStrength: 0, ditherAlgorithm: "bayer8" })), {
    width: 400,
    height: 300,
  });
  const dithered = e.render(sanitizeParams(Object.assign({}, base, { ditherStrength: 1, ditherAlgorithm: "bayer8" })), {
    width: 400,
    height: 300,
  });
  const edginess = (img) => {
    let sum = 0;
    for (let i = 4; i < img.data.length; i += 4) sum += Math.abs(img.data[i] - img.data[i - 4]);
    return sum / (img.data.length / 4);
  };
  ok(edginess(flat) < edginess(dithered) * 0.6, `Amount 0 posterises instead of dithering (${edginess(flat).toFixed(1)} vs ${edginess(dithered).toFixed(1)})`);
  save("21-dither-amount0.png", flat);

  // The preview cap must flag itself rather than lying.
  const capped = e.render(sanitizeParams(Object.assign({}, base, { ditherResolution: 2000 })), {
    width: 400,
    height: 300,
    maxDitherGrid: 500,
  });
  ok(capped.exact === false, "a capped preview reports itself as approximate");
  const uncapped = e.render(sanitizeParams(Object.assign({}, base, { ditherResolution: 300 })), {
    width: 400,
    height: 300,
    maxDitherGrid: 500,
  });
  ok(uncapped.exact === true, "a preview within the cap reports itself as exact");
}

group("Tonal zones");
{
  const z = zoneBands(6, 0.33, 0.66);
  ok(!!z, "six colours can be split into three zones");
  ok(z.bands.length === 3, "three bands");
  ok(z.bands[0][0] === 0 && z.bands[2][1] === 6, "bands span the whole palette");
  ok(z.bands[0][1] > z.bands[1][0], "adjacent bands overlap so error can cross the boundary");
  ok(zoneBands(2, 0.33, 0.66) === null, "a two-colour palette is not split");

  const range = makeZoneRange(6, { tonalMapping: true, shadowSplit: 0.33, highlightSplit: 0.66 });
  const dark = range(0.1);
  const light = range(0.9);
  ok(dark[0] === 0, "shadows start at the darkest colour");
  ok(light[1] === 6, "highlights end at the lightest colour");
  ok(dark[1] <= light[0] + 2, "shadow and highlight bands are disjoint apart from the overlap");
  ok(makeZoneRange(6, { tonalMapping: false }) === null, "mapping off returns no restriction");

  // End to end: with zones on, dark areas must not borrow the lightest colour.
  const e = mkEngine(F.gradient(600, 200));
  const p = sanitizeParams({
    mode: "dither",
    ditherAlgorithm: "floydsteinberg",
    ditherResolution: 200,
    colorCount: 6,
    palette: ["#000000", "#333333", "#666666", "#999999", "#CCCCCC", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    tonalMapping: true,
    shadowSplit: 0.33,
    highlightSplit: 0.66,
  });
  const out = e.render(p, { width: 600, height: 200 });
  save("22-tonal-zones.png", out);
  ok(!hasNaN(out), "tonal zones render without NaN");

  // The darkest tenth of the ramp must stay dark.
  let brightest = 0;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 40; x++) brightest = Math.max(brightest, out.data[(y * 600 + x) * 4]);
  }
  ok(brightest <= 160, `shadows are confined to the shadow band (brightest ${brightest})`);
}

group("Pre-processing");
{
  const flat = F.solid(64, 64, 128, 128, 128);
  ok(unsharpMask(flat, 100, 2).data[0] === 128, "unsharp mask leaves a flat field alone");
  ok(unsharpMask(flat, 0, 2) === flat, "zero amount is a passthrough");
  ok(reduceNoise(flat, 0) === flat, "zero noise reduction is a passthrough");

  // A step edge must get steeper, not blurrier.
  const edge = F.makeImage(64, 16, (x, y, p) => {
    const v = x < 32 ? 90 : 165;
    p[0] = p[1] = p[2] = v;
  });
  const sharpened = unsharpMask(edge, 120, 2);
  const contrastAt = (img) => img.data[(8 * 64 + 34) * 4] - img.data[(8 * 64 + 29) * 4];
  ok(
    contrastAt(sharpened) > contrastAt(edge),
    `unsharp mask increases edge contrast (${contrastAt(edge)} -> ${contrastAt(sharpened)})`
  );

  // Noise reduction must flatten noise while preserving the edge.
  const noisy = F.makeImage(96, 96, (x, y, p) => {
    const base = x < 48 ? 80 : 180;
    const n = ((x * 7 + y * 13) % 11) - 5;
    p[0] = p[1] = p[2] = base + n * 2;
  });
  const cleaned = reduceNoise(noisy, 90);
  const variation = (img, x0, x1) => {
    let sum = 0;
    let n = 0;
    for (let y = 1; y < 95; y++) {
      for (let x = x0; x < x1 - 1; x++) {
        sum += Math.abs(img.data[(y * 96 + x) * 4] - img.data[(y * 96 + x + 1) * 4]);
        n++;
      }
    }
    return sum / n;
  };
  ok(
    variation(cleaned, 2, 44) < variation(noisy, 2, 44) * 0.8,
    `noise reduction flattens flat areas (${variation(noisy, 2, 44).toFixed(2)} -> ${variation(cleaned, 2, 44).toFixed(2)})`
  );
  const edgeStep = (img) => img.data[(48 * 96 + 50) * 4] - img.data[(48 * 96 + 45) * 4];
  ok(
    edgeStep(cleaned) > edgeStep(noisy) * 0.7,
    `noise reduction preserves the edge (${edgeStep(noisy)} -> ${edgeStep(cleaned)})`
  );
}

group("Colour separation");
{
  for (const mode of ["halftone", "dither"]) {
    const e = mkEngine(F.photo(400, 300));
    const p = sanitizeParams({
      mode,
      output: "separated",
      density: 50,
      ditherResolution: 200,
      ditherAlgorithm: "floydsteinberg",
      colorCount: 4,
      paletteLocked: false,
      spread: 0.2,
    });
    const sep = e.renderSeparated(p, { width: 400, height: 300 });
    ok(sep.masks.length === sep.palette.length, `${mode}: one mask per palette colour (${sep.masks.length})`);
    ok(sep.masks.every((m) => m.length === 400 * 300), `${mode}: masks are full size`);

    // The defining property: masks are mutually exclusive and sum to full
    // coverage, so the stack reproduces the composite whatever the layer order.
    let worstSum = 0;
    for (let i = 0; i < 400 * 300; i += 37) {
      let sum = 0;
      for (const m of sep.masks) sum += m[i];
      worstSum = Math.max(worstSum, Math.abs(sum - 255));
    }
    ok(worstSum <= 3, `${mode}: masks sum to full coverage (worst deviation ${worstSum})`);

    // And they must actually reconstruct the flat render.
    const flatOut = e.render(p, { width: 400, height: 300 });
    const pal = sep.palette.map(hexToRgb);
    let worstErr = 0;
    for (let i = 0; i < 400 * 300; i += 53) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < sep.masks.length; k++) {
        const a = sep.masks[k][i] / 255;
        r += pal[k][0] * a;
        g += pal[k][1] * a;
        b += pal[k][2] * a;
      }
      worstErr = Math.max(
        worstErr,
        Math.abs(r - flatOut.data[i * 4]),
        Math.abs(g - flatOut.data[i * 4 + 1]),
        Math.abs(b - flatOut.data[i * 4 + 2])
      );
    }
    ok(worstErr <= 4, `${mode}: compositing the masks reproduces the flat render (worst channel error ${worstErr.toFixed(1)})`);

    if (mode === "halftone") {
      save("23-separation-paper.png", {
        data: maskToRGBA(sep.masks[sep.paperIndex], 400, 300),
        width: 400,
        height: 300,
      });
      const inkIdx = sep.masks.findIndex((m, i) => i !== sep.paperIndex);
      save("23-separation-ink.png", {
        data: maskToRGBA(sep.masks[inkIdx], 400, 300),
        width: 400,
        height: 300,
      });
    }
  }
}

group("Ink separation");
{
  ok(SEP.screenAngles(4, 0, 1).join(",") === "45,15,75,0", "four inks get the classic screen angles");
  ok(
    SEP.screenAngles(4, 0, 0).every((a) => a === 45),
    "spread 0 collapses every screen onto one angle"
  );
  const rotated = SEP.screenAngles(4, 10, 1);
  ok(rotated[0] === 55 && rotated[1] === 25, `the base angle rotates the whole set (${rotated.join(",")})`);
  const many = SEP.screenAngles(9, 0, 1);
  ok(new Set(many).size === 9, "nine inks still get nine distinct angles");

  // Adjacent screens must stay far enough apart to avoid beating.
  const sorted = SEP.screenAngles(4, 0, 1).slice().sort((a, b) => a - b);
  let minGap = 180;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  ok(minGap >= 15, `screens are at least 15 degrees apart (min gap ${minGap})`);

  const paper = [255, 255, 255];
  const cmyk = [[26, 23, 27], [0, 158, 224], [230, 0, 126], [255, 237, 0]];
  const basis = SEP.buildInkBasis(cmyk, paper);
  const cov = new Float64Array(4);

  SEP.unmix(basis, paper, cov);
  ok(Math.max(...cov) < 0.02, `paper needs no ink (max ${Math.max(...cov).toFixed(3)})`);

  // Each pure ink must resolve to itself and (near enough) nothing else.
  for (let k = 0; k < 4; k++) {
    SEP.unmix(basis, cmyk[k], cov);
    const others = Array.from(cov).filter((_, i) => i !== k);
    ok(cov[k] > 0.9, `ink ${k} resolves to itself (${cov[k].toFixed(2)})`);
    ok(Math.max(...others) < 0.1, `ink ${k} does not drag in the others (max ${Math.max(...others).toFixed(2)})`);
  }

  // A secondary must come out as its two constituents.
  SEP.unmix(basis, [40, 60, 160], cov); // blue = cyan + magenta
  ok(cov[1] > 0.3 && cov[2] > 0.15, `blue separates into cyan + magenta (${Array.from(cov).map((v) => v.toFixed(2)).join(" ")})`);
  ok(cov[3] < 0.1, "blue pulls in no yellow");

  // Coverage must never go negative or run away, whatever it is handed.
  for (const c of [[0, 0, 0], [255, 255, 255], [255, 0, 0], [12, 200, 33], [128, 128, 128]]) {
    SEP.unmix(basis, c, cov);
    ok(
      Array.from(cov).every((v) => v >= 0 && v <= 1 && Number.isFinite(v)),
      `coverage stays in [0,1] for ${rgbToHex(c[0], c[1], c[2])}`
    );
  }

  // Darker inks take the least visible angles.
  const order = SEP.inkOrder(cmyk);
  ok(order[0] === 0, "the darkest ink is screened first (45 degrees)");

  // --- convergence -------------------------------------------------
  //
  // The solver once diverged silently: its step size used the trace of the
  // Gram matrix as a stand-in for the largest eigenvalue, which bounds it and
  // therefore looks safe. With four well-spread CMYK inks it was; with three
  // dark risograph inks all pointing the same way the iteration oscillated
  // between zero and full coverage and settled on nothing, emptying the render.
  // Nothing about the CMYK case could have revealed that, so the guard is a
  // general one: over many palettes, the answer must never be worse than doing
  // nothing.
  const residual = (bas, target, cov) => {
    const t = SEP.toDensity(target);
    let e = 0;
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let k = 0; k < bas.count; k++) acc += cov[k] * bas.d[k * 3 + j];
      const diff = acc - (t[j] - bas.paperD[j]);
      e += diff * diff;
    }
    return Math.sqrt(e);
  };

  const palettes = [
    { name: "CMYK", inks: cmyk, paper: [255, 255, 255] },
    // The case that broke: three dark, strongly correlated inks.
    { name: "riso", inks: [[14, 26, 107], [255, 90, 95], [61, 61, 61]], paper: [244, 241, 230] },
    { name: "duotone", inks: [[20, 20, 24], [200, 40, 60]], paper: [245, 240, 228] },
    { name: "near-identical", inks: [[40, 40, 40], [45, 42, 44], [38, 41, 39]], paper: [255, 255, 255] },
    { name: "pale", inks: [[210, 200, 190], [200, 210, 200]], paper: [255, 255, 255] },
    { name: "dark paper", inks: [[240, 240, 240], [220, 90, 90]], paper: [20, 20, 24] },
  ];
  const targets = [
    [255, 255, 255], [0, 0, 0], [128, 128, 128], [235, 205, 180],
    [70, 60, 55], [200, 150, 120], [30, 120, 220], [250, 200, 40],
  ];

  let worstExcess = -Infinity;
  let anyOutOfRange = false;
  let anyNaN = false;
  for (const pal of palettes) {
    const bas = SEP.buildInkBasis(pal.inks, pal.paper);
    const cov = new Float64Array(pal.inks.length);
    const zero = new Float64Array(pal.inks.length);
    let palWorst = -Infinity;
    for (const t of targets) {
      SEP.unmix(bas, t, cov);
      for (let k = 0; k < cov.length; k++) {
        if (!Number.isFinite(cov[k])) anyNaN = true;
        if (cov[k] < -1e-9 || cov[k] > 1 + 1e-9) anyOutOfRange = true;
      }
      // The solution must beat, or match, doing nothing at all.
      const excess = residual(bas, t, cov) - residual(bas, t, zero);
      palWorst = Math.max(palWorst, excess);
    }
    worstExcess = Math.max(worstExcess, palWorst);
    ok(
      palWorst <= 1e-6,
      `${pal.name}: the separation never fits worse than no ink at all ` +
        `(worst excess ${palWorst.toFixed(4)})`
    );
    ok(bas.L > 0, `${pal.name}: the basis reports a usable step (L = ${bas.L.toFixed(2)})`);
  }
  ok(!anyNaN, "coverage is finite for every palette and target");
  ok(!anyOutOfRange, "coverage stays within [0,1] for every palette and target");

  // A pure ink must be *reproduced*. Note the distinction: asking that each ink
  // resolve to itself is only meaningful when the inks are distinguishable. Given
  // three near-identical greys, any of them reproduces the target and which one
  // the solver picks is arbitrary - so the property to assert is the fit, not the
  // identity.
  for (const pal of palettes) {
    const bas = SEP.buildInkBasis(pal.inks, pal.paper);
    const cov = new Float64Array(pal.inks.length);
    let worstFit = 0;
    for (let k = 0; k < pal.inks.length; k++) {
      SEP.unmix(bas, pal.inks[k], cov);
      worstFit = Math.max(worstFit, residual(bas, pal.inks[k], cov));
    }
    ok(worstFit < 0.35, `${pal.name}: every pure ink is reproduced (worst residual ${worstFit.toFixed(3)})`);
  }

  // Where the inks *are* distinguishable, the solver must pick the right one
  // rather than an equivalent-looking mixture.
  for (const pal of palettes.filter((p) => p.name !== "near-identical")) {
    const bas = SEP.buildInkBasis(pal.inks, pal.paper);
    const cov = new Float64Array(pal.inks.length);
    let worst = 1;
    for (let k = 0; k < pal.inks.length; k++) {
      SEP.unmix(bas, pal.inks[k], cov);
      worst = Math.min(worst, cov[k]);
    }
    ok(worst > 0.7, `${pal.name}: distinguishable inks resolve to themselves (weakest ${worst.toFixed(2)})`);
  }

  // Determinism: the solver reuses scratch buffers between calls, so a stale
  // one would show up as an order-dependent answer.
  const basA = SEP.buildInkBasis(cmyk, [255, 255, 255]);
  const basB = SEP.buildInkBasis([[14, 26, 107], [255, 90, 95], [61, 61, 61]], [244, 241, 230]);
  const c4 = new Float64Array(4);
  const c3 = new Float64Array(3);
  SEP.unmix(basA, [128, 128, 128], c4);
  const first = Array.from(c4).join(",");
  SEP.unmix(basB, [70, 60, 55], c3);
  SEP.unmix(basA, [128, 128, 128], c4);
  ok(Array.from(c4).join(",") === first, "the solver is order independent across palette sizes");
}

group("Per-ink screens");
{
  const e = mkEngine(F.photo(700, 500));
  const base = {
    mode: "halftone",
    screenMode: "perInk",
    density: 60,
    radius: 115,
    colorCount: 4,
    palette: ["#1A1A1A", "#009EE0", "#E6007E", "#FFED00"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  };
  const p = sanitizeParams(base);
  const out = e.render(p, { width: 700, height: 500 });
  save("32-perink.png", out);

  ok(!hasNaN(out), "per-ink render has no NaN");
  // Four inks and a white paper that is not itself a palette entry, so nothing
  // is excluded from the ink set: four screens.
  ok(out.angles && out.angles.length === 4, `one screen per ink (${out.angles})`);
  ok(new Set(out.angles).size === out.angles.length, "each screen has its own angle");

  // Overprinting must be able to reach darker than any single ink: that is what
  // multiply compositing buys, and an opaque renderer cannot do it.
  let darkest = 255;
  for (let i = 0; i < out.data.length; i += 4) {
    darkest = Math.min(darkest, out.data[i] + out.data[i + 1] + out.data[i + 2]);
  }
  ok(darkest < 3 * 40, `overprinting reaches deep shadow (min channel sum ${darkest})`);

  // Collapsing the spread stacks every screen on the same grid. That genuinely
  // changes the result - overlapping ink absorbs less than interleaved ink
  // covering more paper, which is precisely why real presses offset their
  // screens - so the test is that it stays in the same tonal ballpark and that
  // the pattern actually differs, not that the pixels match.
  const collapsed = e.render(sanitizeParams(Object.assign({}, base, { screenSpread: 0 })), {
    width: 700,
    height: 500,
  });
  const m1 = meanRGB(out);
  const m2 = meanRGB(collapsed);
  for (let c = 0; c < 3; c++) {
    ok(
      Math.abs(m2[c] - m1[c]) < 45,
      `collapsing the screens stays in the same tonal range on channel ${c} ` +
        `(${m1[c].toFixed(0)} vs ${m2[c].toFixed(0)})`
    );
  }
  ok(
    m2[0] > m1[0],
    `overlapping screens cover less paper, so they read lighter (${m1[0].toFixed(0)} -> ${m2[0].toFixed(0)})`
  );
  save("32-perink-collapsed.png", collapsed);

  // Resolution independence holds here too.
  const small = e.render(p, { width: 350, height: 250 });
  const big = e.render(p, { width: 1400, height: 1000 });
  const ms = meanRGB(small);
  const mb = meanRGB(big);
  for (let c = 0; c < 3; c++) near(ms[c], mb[c], 14, `per-ink render is scale invariant on channel ${c}`);

  // Separated output: masks overlap on purpose, and declare that they do.
  const sep = e.renderSeparated(p, { width: 350, height: 250 });
  ok(sep.blend === "multiply", "per-ink separation asks for Multiply fill layers");
  ok(sep.exclusive === false, "per-ink masks are explicitly not mutually exclusive");
  ok(sep.masks.length === out.angles.length + 1, `one mask per ink plus the paper (${sep.masks.length})`);
  ok(
    Array.from(sep.masks[sep.paperIndex]).every((v) => v === 255),
    "the paper mask is fully opaque underneath"
  );
  let overlapping = 0;
  for (let i = 0; i < 350 * 250; i++) {
    let inked = 0;
    for (let k = 1; k < sep.masks.length; k++) if (sep.masks[k][i] > 128) inked++;
    if (inked > 1) overlapping++;
  }
  ok(overlapping > 0, `inks genuinely overprint (${overlapping} pixels carry more than one ink)`);
}

group("Dot gain and dot shapes");
{
  const e = mkEngine(F.solid(400, 300, 128, 128, 128));
  const base = {
    density: 40,
    radius: 100,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
  };
  const ink = (gain) => {
    const out = e.render(sanitizeParams(Object.assign({}, base, { dotGain: gain })), {
      width: 400,
      height: 300,
    });
    return inkDensity(out, [255, 255, 255]);
  };
  const g0 = ink(0);
  const g10 = ink(10);
  const g25 = ink(25);
  ok(g10 > g0 && g25 > g10, `dot gain monotonically fattens the dots (${g0.toFixed(3)} < ${g10.toFixed(3)} < ${g25.toFixed(3)})`);
  ok(g0 > 0.3 && g0 < 0.7, "the ungained mid grey lands near half coverage");

  // Gain must not fabricate ink where there is none.
  const white = mkEngine(F.white(200, 150));
  const w = white.render(
    sanitizeParams(Object.assign({}, base, { dotGain: 40 })),
    { width: 200, height: 150 }
  );
  ok(inkDensity(w, [255, 255, 255]) < 0.001, "dot gain adds nothing to an empty highlight");

  // The ellipse must carry the same ink as a circle of the same radius.
  const shapes = {};
  for (const sh of ["circle", "ellipse", "square", "diamond"]) {
    const out = e.render(sanitizeParams(Object.assign({}, base, { shape: sh })), {
      width: 400,
      height: 300,
    });
    shapes[sh] = inkDensity(out, [255, 255, 255]);
    save(`33-shape-${sh}.png`, out);
  }
  const vals = Object.values(shapes);
  const spreadPct = (Math.max(...vals) - Math.min(...vals)) / Math.max(...vals);
  ok(spreadPct < 0.1, `ellipse is area-matched to the other shapes (${(spreadPct * 100).toFixed(1)}% spread)`);
}

group("Edge-aware sampling");
{
  // A hard vertical edge: without refinement the straddling column of cells
  // reports a mid grey; with it, each cell commits to one side.
  const img = F.makeImage(480, 160, (x, y, p) => {
    const v = x < 240 ? 0 : 255;
    p[0] = p[1] = p[2] = v;
  });
  const e = mkEngine(img);
  const base = {
    density: 30,
    radius: 100,
    palette: ["#000000", "#FFFFFF"],
    paletteLocked: true,
    spread: 0,
    background: "#FFFFFF",
    blur: 0,
  };

  const midness = (params) => {
    const radii = cellRadii(e, sanitizeParams(params)).flat().filter((r) => r !== null);
    const cell = e._ensureCells(sanitizeParams(params)).grid.cell;
    const maxR = cell * 0.5;
    // Count cells sitting awkwardly between "no dot" and "full dot".
    return radii.filter((r) => r > maxR * 0.2 && r < maxR * 0.8).length;
  };

  const plain = midness(Object.assign({}, base, { edgeAware: false }));
  const aware = midness(Object.assign({}, base, { edgeAware: true }));
  ok(aware <= plain, `edge-aware sampling reduces half-sized straddling dots (${plain} -> ${aware})`);

  // It must leave a flat field completely alone.
  const flatE = mkEngine(F.solid(300, 200, 100, 100, 100));
  const a = flatE.render(sanitizeParams(Object.assign({}, base, { edgeAware: false })), { width: 300, height: 200 });
  const b = flatE.render(sanitizeParams(Object.assign({}, base, { edgeAware: true })), { width: 300, height: 200 });
  let maxDiff = 0;
  for (let i = 0; i < a.data.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i]));
  ok(maxDiff <= 2, `edge-aware sampling is a no-op on a flat field (max diff ${maxDiff})`);

  // And a gradient must stay monotonic.
  const gradE = mkEngine(F.gradient(600, 200));
  const gp = sanitizeParams(Object.assign({}, base, { edgeAware: true, density: 40 }));
  const rows = cellRadii(gradE, gp);
  const mid = rows[Math.floor(rows.length / 2)].filter((r) => r !== null);
  let ok2 = true;
  for (let i = 1; i < mid.length; i++) if (mid[i] > mid[i - 1] + 0.05) ok2 = false;
  ok(ok2, "edge-aware sampling keeps a gradient monotonic");
}

group("Swatch files");
{
  const pal = ["#161616", "#F5EBD8", "#EC3E32", "#009EE0"];

  const act = SWATCH.encodeACT(pal);
  ok(act.length === 772, `.act is 768 bytes plus the count trailer (${act.length})`);
  ok(SWATCH.decodeACT(act).join(",") === pal.join(","), ".act round trips exactly");
  ok((act[768] << 8) + act[769] === 4, "the .act trailer records the real colour count");

  const ase = SWATCH.encodeASE(pal, "Test");
  ok(String.fromCharCode(ase[0], ase[1], ase[2], ase[3]) === "ASEF", ".ase carries the ASEF signature");
  ok(SWATCH.decodeASE(ase).join(",") === pal.join(","), ".ase round trips exactly");

  let threw = null;
  try {
    SWATCH.decodeASE(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  } catch (err) {
    threw = err;
  }
  ok(!!threw && /ASEF/.test(threw.message), "a bad .ase is rejected with a useful message");

  let threw2 = null;
  try {
    SWATCH.decodeACT(Uint8Array.from([1, 2, 3]));
  } catch (err) {
    threw2 = err;
  }
  ok(!!threw2, "a truncated .act is rejected");

  // A single-colour palette and the 256 colour maximum must both survive.
  ok(SWATCH.decodeACT(SWATCH.encodeACT(["#FFFFFF"])).length === 1, "a one colour .act round trips");
  const big = [];
  for (let i = 0; i < 300; i++) big.push(rgbToHex(i % 256, (i * 3) % 256, (i * 7) % 256));
  ok(SWATCH.decodeACT(SWATCH.encodeACT(big)).length === 256, ".act clamps to its 256 colour limit");
  ok(SWATCH.decodeASE(SWATCH.encodeASE(big)).length === 300, ".ase has no such limit");
}

group("DPI scale mode");
{
  const { resolveResolution } = require("../src/state/params.js");
  const p = sanitizeParams({ mode: "halftone", scaleMode: "dpi", dpi: 150 });
  // A 3000px document at 300 ppi is 10 inches; at 150 dpi that is 1500 cells.
  ok(resolveResolution(p, 3000, 300) === 400, `DPI is clamped to the parameter range (${resolveResolution(p, 3000, 300)})`);
  const lowDpi = sanitizeParams({ mode: "halftone", scaleMode: "dpi", dpi: 20 });
  ok(resolveResolution(lowDpi, 3000, 300) === 200, `20 dpi on a 10 inch document gives 200 cells (${resolveResolution(lowDpi, 3000, 300)})`);
  const rel = sanitizeParams({ mode: "halftone", scaleMode: "relative", density: 123 });
  ok(resolveResolution(rel, 3000, 300) === 123, "relative mode ignores DPI");
  const dith = sanitizeParams({ mode: "dither", scaleMode: "dpi", dpi: 100 });
  ok(resolveResolution(dith, 2000, 200) === 1000, `dither DPI resolves against ditherResolution (${resolveResolution(dith, 2000, 200)})`);
  ok(resolveResolution(rel, 3000, 0) === 123, "a missing document resolution does not break relative mode");
}

group("Rasteriser fast paths");
{
  // Two optimisations in the rasteriser trade clarity for speed, and both are
  // only acceptable if they change nothing at all about the output. That is
  // what this group asserts - not that they are fast, but that they are the
  // same. Without it, either could silently degrade the render.
  const { drawDot, fillBackground } = require("../src/engine/halftone.js");
  const { SHAPES } = require("../src/engine/shapes.js");

  // --- fillBackground: written as a seed run doubled with copyWithin -------
  let fillBad = null;
  // Sizes chosen to break a doubling loop if it were wrong: empty, a single
  // pixel, exact powers of two, and awkward remainders either side of them.
  for (const n of [0, 4, 8, 12, 100, 252, 256, 260, 1024, 1028, 4001 * 4]) {
    const b = new Uint8ClampedArray(n);
    fillBackground(b, [245, 238, 216]);
    for (let i = 0; i < n && !fillBad; i += 4) {
      if (b[i] !== 245 || b[i + 1] !== 238 || b[i + 2] !== 216 || b[i + 3] !== 255) {
        fillBad = `${n} bytes, wrong at ${i}`;
      }
    }
  }
  ok(fillBad === null, `the background fill is exact at every buffer size (${fillBad || "11 sizes"})`);

  // --- interior spans -----------------------------------------------------
  // A shape may declare the run of pixels in a row that is fully covered, so
  // the rasteriser can store them directly instead of evaluating the distance
  // field. Every shape that declares one must produce byte-identical output to
  // the generic path it is skipping - including when the dot hangs off the
  // edge of the buffer, sits on a half-pixel, or is smaller than the band.
  const W = 64;
  const H = 64;
  const RADII = [0.4, 0.5, 0.7, 1, 1.5, 2, 3.3, 5, 8, 13.7, 20, 31];
  const CELLS = [4, 10, 26.7, 64];
  const CENTRES = [
    [32, 32],
    [32.5, 32.5],
    [32.37, 31.62],
    [0.2, 0.7],
    [63.9, 63.1],
    [-5, 32],
    [70, 32],
  ];

  let withSpan = 0;
  for (const id of Object.keys(SHAPES)) {
    const shape = SHAPES[id];
    if (!shape.span) continue;
    withSpan++;
    // The same shape with the fast path removed: the reference implementation.
    const generic = Object.assign({}, shape);
    delete generic.span;

    let mismatch = null;
    let cases = 0;
    for (const r of RADII) {
      for (const cell of CELLS) {
        for (const c of CENTRES) {
          const a = new Uint8ClampedArray(W * H * 4).fill(200);
          const b = new Uint8ClampedArray(W * H * 4).fill(200);
          drawDot(a, W, H, c[0], c[1], r, cell, shape, [10, 20, 30], 0);
          drawDot(b, W, H, c[0], c[1], r, cell, generic, [10, 20, 30], 0);
          cases++;
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
              mismatch = `r=${r} cell=${cell} at (${c[0]},${c[1]}), byte ${i}: ${a[i]} vs ${b[i]}`;
              break;
            }
          }
          if (mismatch) break;
        }
        if (mismatch) break;
      }
      if (mismatch) break;
    }
    ok(mismatch === null, `"${id}" spans match the generic path over ${cases} dots (${mismatch || "identical"})`);

    // A span that over-estimates would paint pixels that should have been
    // antialiased, which the equality check above would catch - but only for
    // the centres it happens to try. Assert the invariant directly instead:
    // every pixel a span claims really is at least fully covered.
    let over = null;
    for (const r of [1, 3.3, 8, 20]) {
      for (const cell of [10, 26.7]) {
        for (let dy = -r - 2; dy <= r + 2 && !over; dy += 0.37) {
          const sp = shape.span(dy, r, cell);
          if (sp <= 0) continue;
          for (const dx of [-sp, -sp * 0.5, 0, sp * 0.5, sp]) {
            const d = shape.sdf(dx, dy, r, cell);
            if (d > -0.5 + 1e-9) {
              over = `${id} r=${r} cell=${cell} dy=${dy.toFixed(2)} dx=${dx.toFixed(2)} sdf=${d.toFixed(4)}`;
              break;
            }
          }
        }
      }
    }
    ok(over === null, `"${id}" never claims a pixel it has not fully covered (${over || "under-estimates throughout"})`);
  }
  ok(withSpan >= 4, `several shapes carry an interior span (${withSpan})`);

  // Rotation must fall back to the generic path: a span is a horizontal run,
  // and rotating the sampling frame is exactly what stops the interior being
  // horizontal. Assert the rotated result still matches the generic renderer.
  let rotBad = null;
  for (const id of Object.keys(SHAPES)) {
    const shape = SHAPES[id];
    if (!shape.span) continue;
    const generic = Object.assign({}, shape);
    delete generic.span;
    for (const rot of [0.3, Math.PI / 4, 1.9]) {
      const a = new Uint8ClampedArray(W * H * 4).fill(200);
      const b = new Uint8ClampedArray(W * H * 4).fill(200);
      drawDot(a, W, H, 32.3, 31.8, 9, 26.7, shape, [10, 20, 30], rot);
      drawDot(b, W, H, 32.3, 31.8, 9, 26.7, generic, [10, 20, 30], rot);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          rotBad = `${id} at ${rot.toFixed(2)}rad`;
          break;
        }
      }
    }
  }
  ok(rotBad === null, `a rotated dot bypasses the span path (${rotBad || "identical"})`);
}

group("Stochastic (FM) screening");
{
  // FM keeps the dot size fixed and varies how many dots are placed, so its
  // tone response comes from dot *count*, not dot area. The properties worth
  // pinning are that tone still tracks the source and that the result is not a
  // grid: an FM screen that lands on a regular lattice is just a bad AM screen.
  const grey = (v) => F.solid(320, 320, v, v, v);
  const p = sanitizeParams({
    mode: "halftone",
    screenType: "fm",
    density: 60,
    radius: 100,
    palette: ["#FFFFFF", "#000000"],
    paletteLocked: true,
    colorCount: 2,
  });

  const densities = [0.15, 0.35, 0.6, 0.85].map((v) => {
    const e = new HalftoneEngine();
    e.setSource(grey(Math.round((1 - v) * 255)));
    return inkDensity(e.render(p, { width: 320, height: 320 }), [255, 255, 255]);
  });
  let rising = true;
  for (let i = 1; i < densities.length; i++) {
    if (densities[i] <= densities[i - 1] + 0.02) rising = false;
  }
  ok(rising, `FM ink rises with tone (${densities.map((d) => d.toFixed(2)).join(" < ")})`);

  const white = new HalftoneEngine();
  white.setSource(F.white(320, 320));
  ok(
    inkDensity(white.render(p, { width: 320, height: 320 }), [255, 255, 255]) < 0.005,
    "FM leaves paper white empty"
  );

  const black = new HalftoneEngine();
  black.setSource(F.black(320, 320));
  ok(
    inkDensity(black.render(p, { width: 320, height: 320 }), [255, 255, 255]) > 0.6,
    "FM fills solid black"
  );

  // Determinism: the threshold field is a hash, not an RNG, so two engines must
  // agree byte for byte. If they did not, the preview would not match the render.
  const a = new HalftoneEngine();
  const b = new HalftoneEngine();
  a.setSource(grey(128));
  b.setSource(grey(128));
  const ra = a.render(p, { width: 200, height: 200 });
  const rb = b.render(p, { width: 200, height: 200 });
  let identical = true;
  for (let i = 0; i < ra.data.length; i++) {
    if (ra.data[i] !== rb.data[i]) {
      identical = false;
      break;
    }
  }
  ok(identical, "FM is deterministic across engine instances");

  // And it must not look like AM: at a mid tone the two differ substantially.
  const am = new HalftoneEngine();
  am.setSource(grey(128));
  const amOut = am.render(sanitizeParams(Object.assign({}, p, { screenType: "am" })), {
    width: 200,
    height: 200,
  });
  let diff = 0;
  for (let i = 0; i < amOut.data.length; i += 4) {
    if (Math.abs(amOut.data[i] - ra.data[i]) > 32) diff++;
  }
  ok(diff / (200 * 200) > 0.05, `FM and AM produce different screens (${((diff / 40000) * 100).toFixed(1)}% of pixels)`);
}

group("Press imperfection");
{
  const J = require("../src/engine/jitter.js");

  const off0 = { jitterPosition: 0, jitterSize: 0, jitterAngle: 0, seed: 1 };
  ok(J.isIdentity(off0), "no jitter is recognised as identity");
  ok(
    !J.isIdentity(Object.assign({}, off0, { jitterPosition: 5 })) &&
      !J.isIdentity(Object.assign({}, off0, { jitterSize: 5 })) &&
      !J.isIdentity(Object.assign({}, off0, { jitterAngle: 5 })),
    "any one non-zero amount is not identity"
  );

  // Deterministic: same cell, same seed, same offset. This is the whole reason
  // it is a hash and not Math.random - preview, render and re-render must agree.
  const jit = { jitterPosition: 20, jitterSize: 30, jitterAngle: 45, seed: 7 };
  const o1 = [0, 0, 1, 0];
  const o2 = [0, 0, 1, 0];
  J.dotJitter(12, 9, jit, 8, o1);
  J.dotJitter(12, 9, jit, 8, o2);
  ok(o1.every((v, i) => v === o2[i]), "the same cell always jitters the same way");

  const o3 = [0, 0, 1, 0];
  J.dotJitter(13, 9, jit, 8, o3);
  ok(o1[0] !== o3[0] || o1[1] !== o3[1], "neighbouring cells jitter differently");

  const o4 = [0, 0, 1, 0];
  J.dotJitter(12, 9, Object.assign({}, jit, { seed: 8 }), 8, o4);
  ok(o1[0] !== o4[0] || o1[1] !== o4[1], "the seed changes the pattern");

  // Bounded: offsets stay within the requested fraction of a cell, so a jittered
  // dot cannot wander into the cell after next and tear the screen apart.
  let maxOff = 0;
  let minScale = Infinity;
  let maxScale = 0;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const o = [0, 0, 1, 0];
      J.dotJitter(x, y, { jitterPosition: 50, jitterSize: 40, jitterAngle: 90, seed: 3 }, 10, o);
      maxOff = Math.max(maxOff, Math.abs(o[0]), Math.abs(o[1]));
      minScale = Math.min(minScale, o[2]);
      maxScale = Math.max(maxScale, o[2]);
    }
  }
  // The budget is the stated one: position is a percentage of half a cell, size
  // a percentage of the radius. 50% of a 10px cell is 2.5px, 40% is +/-0.4x.
  ok(maxOff <= 2.5 + 1e-6, `position jitter stays within its stated budget (${maxOff.toFixed(2)}px of 2.5)`);
  ok(
    minScale >= 0.6 - 1e-6 && maxScale <= 1.4 + 1e-6,
    `size jitter stays inside +/-40% and never inverts (${minScale.toFixed(2)}..${maxScale.toFixed(2)})`
  );

  // Misregistration shifts whole screens against each other; with one ink there
  // is nothing to misregister, so it must be a no-op there.
  const src = F.photo(300, 300);
  const base = sanitizeParams({
    mode: "halftone",
    screenMode: "perInk",
    density: 50,
    palette: ["#FFFFFF", "#00AEEF", "#EC008C", "#FFF200"],
    paletteLocked: true,
    colorCount: 4,
  });
  const e1 = new HalftoneEngine();
  e1.setSource(src);
  const clean = e1.render(base, { width: 300, height: 300 });
  const e2 = new HalftoneEngine();
  e2.setSource(src);
  const off = e2.render(sanitizeParams(Object.assign({}, base, { misregistration: 60 })), {
    width: 300,
    height: 300,
  });
  let moved = 0;
  for (let i = 0; i < clean.data.length; i += 4) {
    if (Math.abs(clean.data[i] - off.data[i]) > 20) moved++;
  }
  ok(moved > 0, `misregistration displaces the ink screens (${((moved / 90000) * 100).toFixed(1)}% of pixels)`);

  // Jitter must not destroy tone: a roughened press still prints the same amount
  // of ink, give or take. This is the check that would catch dots being dropped.
  const e3 = new HalftoneEngine();
  e3.setSource(src);
  const rough = e3.render(
    sanitizeParams(Object.assign({}, base, { jitterPosition: 25, jitterSize: 20, jitterAngle: 30 })),
    { width: 300, height: 300 }
  );
  const dClean = inkDensity(clean, [255, 255, 255]);
  const dRough = inkDensity(rough, [255, 255, 255]);
  ok(
    Math.abs(dClean - dRough) < dClean * 0.2,
    `jitter preserves overall ink density (${dClean.toFixed(3)} vs ${dRough.toFixed(3)})`
  );
}

group("SVG export");
{
  const src = F.gradient(400, 200);
  const e = new HalftoneEngine();
  e.setSource(src);
  const p = sanitizeParams({
    mode: "halftone",
    density: 40,
    palette: ["#FFFFFF", "#000000"],
    paletteLocked: true,
    colorCount: 2,
  });

  const out = e.renderSVG(p, { width: 800, height: 400 });
  ok(out.shapes > 100, `a gradient produces shapes (${out.shapes})`);
  ok(out.svg.indexOf("<?xml") === 0, "the file starts with an XML declaration");
  ok(/<svg[^>]+width="800"[^>]+height="400"/.test(out.svg), "the requested output size is honoured");
  ok(out.svg.trim().endsWith("</svg>"), "the document is closed");

  // Well-formedness, checked by counting tags rather than by pulling in a parser.
  const opens = (out.svg.match(/<g[ >]/g) || []).length;
  const closes = (out.svg.match(/<\/g>/g) || []).length;
  ok(opens === closes, `every group is closed (${opens} open, ${closes} close)`);
  ok(out.svg.indexOf("NaN") < 0 && out.svg.indexOf("undefined") < 0, "no NaN or undefined leaked into the geometry");

  // Vector output is resolution independent by construction: asking for twice
  // the size must give the same shapes, not twice as many.
  const big = e.renderSVG(p, { width: 1600, height: 800 });
  ok(big.shapes === out.shapes, `output size does not change the shape count (${big.shapes})`);

  // Every shape the rasteriser can draw must also be expressible as vector.
  for (const shape of SHAPE_IDS) {
    const s = e.renderSVG(sanitizeParams(Object.assign({}, p, { shape })), { width: 400, height: 200 });
    ok(s.shapes > 0 && s.svg.indexOf("NaN") < 0, `shape "${shape}" exports as vector (${s.shapes} shapes)`);
  }

  // Per-ink screens export as one multiply group per ink, mirroring the raster
  // compositing, so the file reproduces the render rather than approximating it.
  const perInk = e.renderSVG(
    sanitizeParams(
      Object.assign({}, p, {
        screenMode: "perInk",
        palette: ["#FFFFFF", "#00AEEF", "#EC008C", "#FFF200", "#000000"],
        colorCount: 5,
      })
    ),
    { width: 400, height: 200 }
  );
  const multiply = (perInk.svg.match(/mix-blend-mode: multiply/g) || []).length;
  ok(multiply >= 3, `per-ink export writes one multiply group per ink (${multiply})`);

  // Dither is refused rather than exported: one shape per pixel is a file no
  // application will open, and saying so beats writing it.
  let refused = null;
  try {
    e.renderSVG(sanitizeParams({ mode: "dither" }), { width: 400, height: 200 });
  } catch (err) {
    refused = err;
  }
  ok(refused !== null && /dither/i.test(refused.message), "dither mode is refused with an explanation");
}

/* ================================================================== *
 * 3. Performance
 * ================================================================== */

group("Performance");
{
  const sizes = [
    [1080, 1080],
    [1920, 1080],
    [3000, 3000],
  ];
  if (HEAVY) sizes.push([6000, 4000]);

  const modes = [
    { label: "halftone", params: presetToParams(BUILTIN_PRESETS.find((p) => p.id === "comic")) },
    { label: "dither  ", params: presetToParams(BUILTIN_PRESETS.find((p) => p.id === "mac-classic")) },
  ];

  for (const { label, params } of modes) {
    for (const [w, h] of sizes) {
      const img = F.photo(w, h);
      const e = mkEngine(img);
      const previewOpts = {
        width: 640,
        height: Math.round((640 * h) / w),
        maxDitherGrid: 700,
      };

      const t0 = Date.now();
      const preview = e.render(params, previewOpts);
      const tPreview = Date.now() - t0;

      const t1 = Date.now();
      const full = e.render(params);
      const tFull = Date.now() - t1;

      // Interactive re-render: Hue never invalidates the expensive stage in
      // either mode, so this is the honest measure of slider latency.
      const t2 = Date.now();
      e.render(Object.assign({}, params, { hue: 45 }), previewOpts);
      const tInteractive = Date.now() - t2;

      console.log(
        `    ${label} ${w}x${h}: first preview ${tPreview}ms, slider re-render ${tInteractive}ms, ` +
          `full render ${tFull}ms (analysis ${e.stats.analysisSize})`
      );
      ok(
        tInteractive < 120,
        `${label.trim()} ${w}x${h} slider re-render stays interactive (${tInteractive}ms < 120ms)`
      );
      ok(!hasNaN(full), `${label.trim()} ${w}x${h} full render is clean`);
      if (w === 3000 && label === "halftone") save("12-3000-full.png", preview);
      if (w === 3000 && label !== "halftone") save("12-3000-dither.png", preview);
    }
  }
  if (!HEAVY) console.log("    (run with --heavy to include 6000x4000)");
}

group("Async chunked render");
{
  (async () => {
    const e = mkEngine(F.photo(1200, 800));
    const params = presetToParams(BUILTIN_PRESETS[0]);
    let lastProgress = 0;
    let monotonic = true;
    const out = await e.renderAsync(params, {
      onProgress: (t) => {
        if (t < lastProgress - 1e-9) monotonic = false;
        lastProgress = t;
      },
    });
    ok(out !== null && out.width === 1200, "renderAsync produces a full buffer");
    ok(monotonic && lastProgress > 0.99, `progress is monotonic and completes (${lastProgress.toFixed(2)})`);

    const sync = e.render(params);
    let same = true;
    for (let i = 0; i < sync.data.length; i += 997) {
      if (sync.data[i] !== out.data[i]) {
        same = false;
        break;
      }
    }
    ok(same, "async and sync renders agree");

    // Cancellation
    const cancelled = await e.renderAsync(params, { shouldCancel: () => true });
    ok(cancelled === null, "renderAsync honours cancellation");

    report();
  })();
}

function report() {
  console.log(`\n${"-".repeat(60)}`);
  if (failed) {
    console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`);
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mAll ${passed} assertions passed.\x1b[0m`);
  }
  if (VISUAL) console.log(`Visual artefacts written to ${OUT_DIR}`);
}
