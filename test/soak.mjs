/**
 * Interaction soak test.
 *
 *   npm run test:soak
 *
 * The layout test proves the panel is laid out correctly when it is built. This
 * drives the *real* panel through a full session afterwards - zoom, pan, 1:1,
 * compare, full-preview, mode switches, every preset, a curve drag, reset - and
 * fails on any JavaScript error or any geometry that has gone wrong: a preview
 * whose source is no longer an image, an element positioned at NaN, anything
 * that has escaped the panel, a viewport centre that is not a finite number.
 *
 * It exists because three faults reached the user through a suite that was
 * entirely green: none of them were in a unit, all of them were in what happens
 * when the pieces are used together. Playwright is optional, as elsewhere; the
 * test skips rather than fails when it is absent.
 */

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright not installed - skipping soak test");
  process.exit(0);
}

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: false, args:["--headless=new","--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 380, height: 820 }, colorScheme: "dark" });
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + String(e).split("\n")[0]));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160)); });
await p.goto("file:///home/user/Photoshop/panel-preview.html");
await p.waitForTimeout(600);

await p.evaluate(() => {
  const panel = window.halftonePanel;
  const W = 2400, H = 1600;
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const cx = x / W - 0.5, cy = y / H - 0.5;
    const v = Math.max(0, Math.min(1, 0.5 + 0.85 * Math.cos(Math.sqrt(cx*cx+cy*cy) * 9) * (1 - y / H)));
    d[i] = 255 * v; d[i+1] = 255 * (v * 0.85 + 0.05); d[i+2] = 255 * (v * 0.7 + 0.1); d[i+3] = 255;
  }
  panel.engine.setSource({ data: d, width: W, height: H });
  panel.sourceInfo = { bounds: { left: 0, top: 0, right: 2400, bottom: 1600 }, layerName: "Art" };
  panel.updateZoomBar();
  panel.drawPreview();
});
await p.waitForTimeout(300);

// Invariants checked after every step.
const probe = () => p.evaluate(() => {
  const out = [];
  const panel = window.halftonePanel;
  const img = document.getElementById("preview");
  if (!img) out.push("preview element gone");
  else if (img.className.indexOf("visible") >= 0 && img.src.indexOf("data:image/png") !== 0) {
    out.push("preview src is not an image: " + String(img.src).slice(0, 40));
  }
  // Anything positioned at NaN is a geometry bug that renders as "gone".
  document.querySelectorAll("[style]").forEach(e => {
    const s = e.getAttribute("style") || "";
    if (/NaN|Infinity|undefined/.test(s)) out.push("bad style on ." + e.className + ": " + s.slice(0, 60));
  });
  const app = document.getElementById("app");
  const host = app.getBoundingClientRect();
  // Nothing may end up outside the panel.
  ["#preview-wrap", ".zoombar", ".actions", "#scroll"].forEach(sel => {
    const e = document.querySelector(sel);
    if (!e) return;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && (r.right > host.right + 2 || r.left < host.left - 2)) {
      out.push(sel + " escapes the panel horizontally");
    }
  });
  if (panel && panel.view && (!isFinite(panel.view.cx) || !isFinite(panel.view.cy))) {
    out.push("view centre is not finite: " + JSON.stringify(panel.view));
  }
  return out;
});

const steps = [];
async function step(name, fn) {
  const before = errors.length;
  try { await fn(); } catch (e) { errors.push(`step "${name}" threw: ${e.message}`); }
  await p.waitForTimeout(220);
  const bad = await probe();
  const newErrors = errors.slice(before);
  steps.push([name, [...newErrors, ...bad]]);
}

const click = (id) => p.evaluate(i => { const e = document.getElementById(i); if (e) e.click(); }, id);

/*
 * Zoom, checked by what it produces rather than by what it does not throw.
 *
 * The earlier version of this test clicked the zoom buttons and asserted that
 * no error was logged, which every broken version of the zoom would also have
 * passed. What the user gets out of the zoom is a different picture; that is
 * what is measured here.
 */
{
  const shot = () => p.evaluate(() => {
    const panel = window.halftonePanel;
    const plan = panel.renderPlan(panel.previewBox());
    return {
      src: String((document.getElementById("preview") || {}).src || ""),
      w: plan.width, h: plan.height,
      view: plan.view ? `${plan.view.x},${plan.view.y},${plan.view.width},${plan.view.height}` : null,
      label: (document.getElementById("zoom-level") || {}).textContent,
    };
  });

  const seen = [await shot()];
  for (let i = 0; i < 3; i++) { await click("btn-zoom-in"); await p.waitForTimeout(420); seen.push(await shot()); }

  const issues = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1], b = seen[i];
    if (a.src === b.src) issues.push(`step ${i}: the preview image did not change`);
    const ratio = b.w / a.w;
    if (Math.abs(ratio - 1.6) > 0.03) issues.push(`step ${i}: zoomed ${ratio.toFixed(3)}x, expected 1.6x`);
    if (a.label === b.label) issues.push(`step ${i}: the zoom label did not change (${a.label})`);
  }
  if (seen[seen.length - 1].view === null) issues.push("zoomed all the way in and there is still nothing to pan");
  steps.push(["zoom actually zooms", issues]);

  // Panning must move the window, not merely avoid throwing.
  const beforePan = await shot();
  await p.evaluate(() => {
    const w = document.getElementById("preview-wrap");
    const r = w.getBoundingClientRect();
    const ev = (t, x, y) => w.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
    ev("pointerdown", r.left + r.width / 2, r.top + r.height / 2);
    ev("pointermove", r.left + r.width / 2 - 60, r.top + r.height / 2 - 40);
    ev("pointerup", r.left + r.width / 2 - 60, r.top + r.height / 2 - 40);
  });
  await p.waitForTimeout(420);
  const afterPan = await shot();
  steps.push(["panning moves the window", afterPan.view === beforePan.view
    ? [`the window stayed at ${beforePan.view}`] : []]);

  // A zoom step draws a reduced frame first for speed. What you are left
  // looking at must always be the full one, or the speed was bought with
  // quality the user did not agree to.
  await click("btn-zoom-in");
  await p.waitForTimeout(60);
  const during = await p.evaluate(() => window.halftonePanel._lastBadge || "");
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => window.halftonePanel._lastBadge || "");
  steps.push(["a zoom step settles at full quality", [
    ...(/draft/.test(during) ? [] : ["the first frame after a zoom was not a draft, so the step paid full price"]),
    ...(/draft/.test(after) ? ["the panel was left showing a draft frame"] : []),
  ]]);
  await click("btn-zoom-out");
  await p.waitForTimeout(600);

  // Fit must undo all of it.
  await click("btn-zoom-fit");
  await p.waitForTimeout(420);
  const back = await shot();
  steps.push(["fit returns to the whole document", back.view === null ? [] : [`still windowed at ${back.view}`]]);
  steps.push(["fit restores the first frame", back.src === seen[0].src ? [] : ["the fitted frame differs from the one we started with"]]);
}

await step("zoom in x3", async () => { for (let i=0;i<3;i++) await click("btn-zoom-in"); });
await step("pan by dragging", () => p.evaluate(() => {
  const w = document.getElementById("preview-wrap");
  const r = w.getBoundingClientRect();
  const ev = (t, x, y) => w.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
  ev("pointerdown", r.left + r.width/2, r.top + r.height/2);
  ev("pointermove", r.left + r.width/2 - 40, r.top + r.height/2 - 25);
  ev("pointerup", r.left + r.width/2 - 40, r.top + r.height/2 - 25);
}));
await step("1:1", () => click("btn-zoom-1"));
await step("zoom out x6", async () => { for (let i=0;i<6;i++) await click("btn-zoom-out"); });
await step("fit", () => click("btn-zoom-fit"));
await step("compare on", () => click("btn-compare"));
await step("drag the seam", () => p.evaluate(() => {
  const h = document.getElementById("split-handle");
  const r = document.getElementById("preview-wrap").getBoundingClientRect();
  const ev = (t, x) => h.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: r.top + 20, pointerId: 2, bubbles: true }));
  ev("pointerdown", r.left + r.width/2); ev("pointermove", r.left + r.width*0.25); ev("pointerup", r.left + r.width*0.25);
}));
await step("compare off", () => click("btn-compare"));
await step("full on", () => click("btn-theatre"));
await step("zoom while full", () => click("btn-zoom-1"));
await step("full off", () => click("btn-theatre"));
await step("switch to dither", () => p.evaluate(() => {
  const s = [...document.querySelectorAll(".seg-item")].find(x => x.textContent.trim() === "DITHER");
  if (s) s.click();
}));
await step("back to halftone", () => p.evaluate(() => {
  const s = [...document.querySelectorAll(".seg-item")].find(x => x.textContent.trim() === "HALFTONE");
  if (s) s.click();
}));
await step("apply each preset", () => p.evaluate(() => {
  document.querySelectorAll(".preset-chip").forEach(c => c.click());
}));
await step("drag the curve", () => p.evaluate(() => {
  const box = document.querySelector(".curve-box");
  if (!box) throw new Error("no curve editor on screen");
  const r = box.getBoundingClientRect();
  const ev = (t, x, y) => box.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, pointerId: 3, bubbles: true }));
  ev("pointerdown", r.left + r.width*0.3, r.top + r.height*0.7);
  for (let i = 0; i < 12; i++) ev("pointermove", r.left + r.width*(0.3+i*0.02), r.top + r.height*(0.7-i*0.03));
  ev("pointerup", r.left + r.width*0.5, r.top + r.height*0.4);
}));
await step("reset all", () => click("btn-reset"));

await b.close();
let failed = 0;
for (const [name, issues] of steps) {
  if (issues.length) { failed++; console.log(`FAIL  ${name}`); issues.slice(0,3).forEach(i => console.log("        " + i)); }
  else console.log(`ok    ${name}`);
}
if (failed) {
  console.log(`\n\x1b[31m${failed} steps with problems\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log(`\n\x1b[32mAll ${steps.length} interaction steps clean.\x1b[0m`);
}
