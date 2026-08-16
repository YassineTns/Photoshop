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

  const params = presetToParams(BUILTIN_PRESETS.find((p) => p.id === "comic"));
  for (const [w, h] of sizes) {
    const img = F.photo(w, h);
    const e = mkEngine(img);

    const t0 = Date.now();
    const preview = e.render(params, { width: 640, height: Math.round((640 * h) / w) });
    const tPreview = Date.now() - t0;

    const t1 = Date.now();
    const full = e.render(params);
    const tFull = Date.now() - t1;

    // Interactive re-render with the cells already measured.
    const t2 = Date.now();
    e.render(Object.assign({}, params, { hue: 45 }), { width: 640, height: Math.round((640 * h) / w) });
    const tInteractive = Date.now() - t2;

    console.log(
      `    ${w}x${h}: first preview ${tPreview}ms, slider re-render ${tInteractive}ms, full render ${tFull}ms ` +
        `(analysis ${e.stats.analysisSize}, ${e.stats.cells} cells)`
    );
    ok(tInteractive < 120, `${w}x${h} slider re-render stays interactive (${tInteractive}ms < 120ms)`);
    ok(!hasNaN(full), `${w}x${h} full render is clean`);
    if (w === 3000) save("12-3000-full.png", preview);
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
