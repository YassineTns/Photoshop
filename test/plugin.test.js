"use strict";

/**
 * Integration tests for the Photoshop and UI layers, run against the mocks in
 * test/mocks.js.
 *
 *   node test/plugin.test.js
 */

const { install, uninstall, resetModules } = require("./mocks.js");
const F = require("./fixtures.js");

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
    failures.push(`${currentGroup} > ${msg}${detail ? ` (${detail})` : ""}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${msg}${detail ? `\n        ${detail}` : ""}`);
  }
}

function flush() {
  return new Promise((r) => setTimeout(r, 5));
}

/** Wait until `predicate` holds, or fail after `timeout` ms. */
async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

async function main() {
  /* ================================================================ */
  group("Metadata round trip");
  {
    resetModules();
    const { ps } = install({ width: 800, height: 600 });
    const META = require("../src/photoshop/metadata.js");
    const { defaultParams } = require("../src/state/params.js");

    const id = META.newRenderId();
    ok(/^HT-[0-9a-f]{8}$/.test(id), `render ids look like HT-xxxxxxxx (${id})`);
    ok(META.renderIdFromName(META.groupName(id)) === id, "render id survives the layer name round trip");
    ok(META.isHalftoneGroupName(META.groupName(id)), "group names are recognised");
    ok(!META.isHalftoneGroupName("Background"), "ordinary layer names are not mistaken for groups");

    const params = defaultParams();
    params.radius = 137;
    params.palette = ["#112233", "#AABBCC"];
    params.shape = "diamond";
    const record = META.makeRecord(id, params, { docName: "Test.psd" });

    const xmp = META.buildXMP(record);
    ok(xmp.indexOf("x:xmpmeta") > 0, "XMP packet is well formed");
    const back = META.parseXMP(xmp);
    ok(back && back.renderId === id, "XMP payload decodes");
    ok(back.params.radius === 137, "numeric params survive XMP encoding");
    ok(back.params.palette[1] === "#AABBCC", "palette survives XMP encoding");
    ok(back.params.shape === "diamond", "enum params survive XMP encoding");

    const persistence = await META.saveRecord([42], record);
    ok(persistence.xmp === true, "layer XMP write verifies by readback");
    ok(persistence.sidecar === true, "sidecar file is written as well");
    ok(ps.xmpStore.has(42), "the XMP actually reached the layer");

    const loaded = await META.loadRecord({ renderId: id, layerIds: [42] });
    ok(loaded && loaded.source === "layer XMP", "load prefers layer XMP");
    ok(loaded.record.params.radius === 137, "loaded params match what was saved");

    // If XMP is unavailable the sidecar must still carry the record.
    ps.xmpStore.clear();
    const fallback = await META.loadRecord({ renderId: id, layerIds: [42] });
    ok(
      fallback && fallback.source === "plugin data folder",
      "falls back to the sidecar when layer XMP is gone"
    );
    ok(fallback.record.params.shape === "diamond", "sidecar record is complete");

    // Non-ASCII must survive the UTF-8 base64 path.
    const uni = META.makeRecord("HT-00000001", params, { docName: "Été — 素材.psd" });
    const uniBack = META.parseXMP(META.buildXMP(uni));
    ok(uniBack.docName === "Été — 素材.psd", "non-ASCII metadata survives encoding");

    uninstall();
  }

  /* ================================================================ */
  group("Apply builds a non-destructive structure");
  {
    resetModules();
    const image = F.photo(600, 400);
    const { ps } = install({ width: 600, height: 400, image });
    const RENDER = require("../src/photoshop/render.js");
    const META = require("../src/photoshop/metadata.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { presetToParams, BUILTIN_PRESETS } = require("../src/presets/presets.js");

    const ctx0 = RENDER.currentContext();
    ok(ctx0.mode === "new", `a plain layer selection means "new" (${ctx0.mode})`);

    const src = await RENDER.readSource();
    ok(src.image.width === 600, `source read at ${src.image.width}x${src.image.height}`);
    ok(ps.disposed >= 1, "the ImageData handle was disposed after reading");

    const engine = new HalftoneEngine();
    engine.setSource(src.image);
    const params = presetToParams(BUILTIN_PRESETS.find((p) => p.id === "comic"));

    const res = await RENDER.applyNew(engine, params, {});
    ok(/^HT-/.test(res.renderId), `apply returned a render id (${res.renderId})`);

    // Structure
    const group = ps.doc.layers.find((l) => l.kind === "group");
    ok(!!group, "a group was created");
    ok(META.isHalftoneGroupName(group.name), `group is named for the render (${group.name})`);
    ok(group.layers.length === 2, `group holds exactly two layers (${group.layers.length})`);

    const source = group.layers.find((l) => l.name === META.SOURCE_LAYER_NAME);
    const render = group.layers.find((l) => l.name === META.RENDER_LAYER_NAME);
    ok(!!source, "the source layer is inside the group");
    ok(!!render, "the render layer is inside the group");
    ok(source.kind === "smartObject", "the original was converted to a Smart Object");
    ok(source.visible === false, "the source is hidden behind the render");
    ok(render.visible === true, "the render is visible");
    ok(group.layers.indexOf(render) < group.layers.indexOf(source), "the render sits above the source");

    // Order of operations: convert before grouping, group before creating the
    // render layer. Getting this wrong silently produces a flat structure.
    const seq = ps.calls.map((c) => c._obj + (c._target && c._target[0] ? ":" + (c._target[0]._ref || c._target[0]._property || "") : ""));
    const iSO = seq.indexOf("newPlacedLayer");
    const iGroup = seq.indexOf("make:layerSection");
    const iLayer = seq.indexOf("make:layer");
    ok(iSO >= 0 && iGroup > iSO, "Smart Object conversion happens before grouping");
    ok(iLayer > iGroup, "the render layer is created after the group exists");

    // Pixels
    ok(ps.putPixelsCalls.length === 1, `putPixels called once (${ps.putPixelsCalls.length})`);
    const put = ps.putPixelsCalls[0];
    ok(put.layerID === render.id, "pixels were written to the render layer, not the source");
    ok(put.replace === true, "putPixels replaces rather than blends");
    ok(
      put.targetBounds.right - put.targetBounds.left === 600 &&
        put.targetBounds.bottom - put.targetBounds.top === 400,
      `written at full document size (${JSON.stringify(put.targetBounds)})`
    );
    ok(put.imageData.byteLength === 600 * 400 * 4, "the buffer is a full RGBA frame");

    // Nothing was written to the source layer.
    ok(
      ps.putPixelsCalls.every((c) => c.layerID !== source.id),
      "the original pixels were never overwritten"
    );

    // Metadata
    ok(res.persistence.xmp && res.persistence.sidecar, "parameters were persisted");
    ok(ps.xmpStore.has(group.id), "the group carries the parameters");

    // Selecting the group is now an "existing" context, and recall works.
    ps.doc.activeLayers = [group];
    const ctx1 = RENDER.currentContext();
    ok(ctx1.mode === "existing", "selecting the group is recognised as an existing render");
    ok(ctx1.renderId === res.renderId, "the render id is recovered from the group name");
    ok(!!ctx1.sourceLayer && !!ctx1.renderLayer, "both member layers are located");

    const recalled = await RENDER.recallParams();
    ok(!!recalled, "parameters can be recalled");
    ok(recalled.params.shape === params.shape, "recalled shape matches");
    ok(recalled.params.density === params.density, "recalled density matches");
    ok(recalled.params.palette.join() === params.palette.join(), "recalled palette matches");

    // Selecting a child layer, not the group, must resolve to the same context.
    ps.doc.activeLayers = [render];
    ok(RENDER.currentContext().mode === "existing", "selecting a child layer finds the group");

    uninstall();
  }

  /* ================================================================ */
  group("Update re-renders in place");
  {
    resetModules();
    const image = F.photo(500, 500);
    const { ps } = install({ width: 500, height: 500, image });
    const RENDER = require("../src/photoshop/render.js");
    const META = require("../src/photoshop/metadata.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams } = require("../src/state/params.js");

    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);
    const params = defaultParams();
    const first = await RENDER.applyNew(engine, params, {});

    const group = ps.doc.layers.find((l) => l.kind === "group");
    const render = group.layers.find((l) => l.name === META.RENDER_LAYER_NAME);
    const source = group.layers.find((l) => l.name === META.SOURCE_LAYER_NAME);
    const layerCountBefore = countLayers(ps.doc.layers);
    ps.doc.activeLayers = [group];

    const changed = Object.assign({}, params, { radius: 60, hue: 90, shape: "square" });
    const second = await RENDER.updateExisting(engine, changed, {});

    ok(second.renderId === first.renderId, "update keeps the same render id");
    ok(second.updated === true, "update reports itself as an update");
    ok(countLayers(ps.doc.layers) === layerCountBefore, "update creates no new layers");
    ok(ps.putPixelsCalls.length === 2, "update wrote pixels once more");
    ok(
      ps.putPixelsCalls[1].layerID === render.id,
      "update wrote into the existing render layer, preserving its mask and blend mode"
    );
    ok(source.visible === false, "the source stays hidden after an update");
    ok(
      ps.getPixelsCalls.length >= 2 &&
        ps.getPixelsCalls[ps.getPixelsCalls.length - 1].layerID === source.id,
      "update re-reads from the Smart Object, so edits to it are picked up"
    );

    const recalled = await RENDER.recallParams();
    ok(recalled.params.radius === 60 && recalled.params.shape === "square", "update re-saves the new params");

    uninstall();
  }

  /* ================================================================ */
  group("Guard rails");
  {
    resetModules();
    const { ps } = install({ width: 400, height: 300 });
    const RENDER = require("../src/photoshop/render.js");
    const META = require("../src/photoshop/metadata.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams } = require("../src/state/params.js");

    ps.doc.activeLayers = [];
    ok(RENDER.currentContext().mode === "none", "no selection is reported, not crashed on");

    const engine = new HalftoneEngine();
    let threw = null;
    try {
      await RENDER.applyNew(engine, defaultParams(), {});
    } catch (e) {
      threw = e;
    }
    ok(!!threw, `applying with nothing selected fails cleanly (${threw && threw.message})`);
    ok(ps.putPixelsCalls.length === 0, "no pixels were written on the failed path");

    // A halftone group whose source layer has been deleted must report that
    // rather than silently doing nothing.
    ps.doc.activeLayers = [ps.doc.layers[0]];
    engine.setSource((await RENDER.readSource()).image);
    await RENDER.applyNew(engine, defaultParams(), {});
    const group = ps.doc.layers.find((l) => l.kind === "group");
    const source = group.layers.find((l) => l.name === META.SOURCE_LAYER_NAME);
    group.layers.splice(group.layers.indexOf(source), 1);
    ps.doc.activeLayers = [group];

    let updateErr = null;
    try {
      await RENDER.updateExisting(engine, defaultParams(), {});
    } catch (e) {
      updateErr = e;
    }
    ok(
      updateErr && /Halftone Source/.test(updateErr.message),
      `a missing source layer produces a useful message (${updateErr && updateErr.message})`
    );

    uninstall();
  }

  /* ================================================================ */
  group("Stale source guard");
  {
    resetModules();
    const image = F.photo(400, 400);
    const { ps } = install({ width: 400, height: 400, image });
    const RENDER = require("../src/photoshop/render.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams } = require("../src/state/params.js");

    // The user previews one layer, then selects a different one before Apply.
    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);
    engine.sourceLayerId = 99999;

    const readsBefore = ps.getPixelsCalls.length;
    const target = ps.doc.activeLayers[0];
    const res = await RENDER.applyNew(engine, defaultParams(), {});

    ok(
      ps.getPixelsCalls.length > readsBefore,
      `Apply re-reads when the engine holds a different layer (${readsBefore} -> ${ps.getPixelsCalls.length} reads)`
    );
    ok(
      ps.getPixelsCalls[ps.getPixelsCalls.length - 1].layerID === target.id,
      "the re-read targets the currently selected layer"
    );
    ok(engine.sourceLayerId === target.id, "the engine is re-stamped with the layer it rendered");
    ok(ps.putPixelsCalls.length === 1 && !!res.renderId, "the render still completed");

    uninstall();
  }

  /* ================================================================ */
  group("Large document reads are capped");
  {
    resetModules();
    const { ps } = install({ width: 6000, height: 4000 });
    const RENDER = require("../src/photoshop/render.js");
    const { READ_MAX_LONGEST } = require("../src/photoshop/imaging.js");

    const src = await RENDER.readSource();
    const req = ps.getPixelsCalls[0];
    ok(!!req.targetSize, "getPixels asked Photoshop to downscale");
    ok(
      Math.max(src.image.width, src.image.height) <= READ_MAX_LONGEST,
      `read capped at ${src.image.width}x${src.image.height} instead of 6000x4000`
    );
    ok(
      Math.abs(src.image.width / src.image.height - 1.5) < 0.01,
      "the aspect ratio is preserved by the capped read"
    );

    // ... but the render still comes out at full document resolution.
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams } = require("../src/state/params.js");
    const engine = new HalftoneEngine();
    engine.setSource(src.image);
    await RENDER.applyNew(engine, defaultParams(), {});
    const put = ps.putPixelsCalls[0];
    ok(
      put.targetBounds.right === 6000 && put.targetBounds.bottom === 4000,
      "the applied render is still full resolution"
    );

    uninstall();
  }

  /* ================================================================ */
  group("Panel wiring");
  {
    resetModules();
    const image = F.photo(800, 600);
    const { ps, document } = install({ width: 800, height: 600, image });
    const { Panel } = require("../src/ui/panel.js");
    const { PARAM_DEFS } = require("../src/state/params.js");
    const { BUILTIN_PRESETS } = require("../src/presets/presets.js");

    const panel = new Panel(document);
    await panel.init();

    ok(Object.keys(panel.controls).length === PARAM_DEFS.length, `every parameter got a control (${Object.keys(panel.controls).length}/${PARAM_DEFS.length})`);
    for (const def of PARAM_DEFS) {
      if (!panel.controls[def.key]) ok(false, `control missing for "${def.key}"`);
    }
    ok(!!panel.controls.radius && !!panel.controls.palette, "sliders and the palette editor exist");

    const chips = document.getElementById("preset-list").children;
    ok(chips.length === BUILTIN_PRESETS.length, `preset chips rendered (${chips.length})`);

    // Load the layer through the button, exactly as a user would.
    document.getElementById("btn-load").emit("click");
    ok(await waitFor(() => panel.engine.hasSource()), "Load Layer populated the engine");
    ok(
      await waitFor(() => document.getElementById("preview").src.indexOf("data:image/png;base64,") === 0),
      "a preview image was produced"
    );

    // Drag a slider.
    const before = panel.params.radius;
    panel.setParam("radius", 42, true);
    ok(panel.params.radius === 42 && before !== 42, "setting a parameter updates state");
    await flush();

    // Presets.
    panel.applyPreset(BUILTIN_PRESETS[2]);
    ok(panel.params.shape === BUILTIN_PRESETS[2].params.shape, "clicking a preset chip applies it");
    ok(panel.activePresetId === BUILTIN_PRESETS[2].id, "the active preset is tracked");
    panel.setParam("density", 123, true);
    ok(panel.activePresetId === null, "editing a parameter clears the active preset");

    // Palette extraction.
    panel.extractPalette();
    ok(panel.params.palette.length === panel.params.colorCount, `extraction respects the colour count (${panel.params.palette.length})`);
    ok(panel.params.paletteLocked === true, "extraction locks the palette");

    // Colour count drives the palette.
    panel.setParam("colorCount", 6, true);
    ok(panel.params.palette.length === 6, `changing the colour count re-extracts (${panel.params.palette.length} swatches)`);

    // Apply through the button.
    document.getElementById("btn-apply").emit("click");
    ok(await waitFor(() => ps.putPixelsCalls.length === 1), `Apply wrote the render (${ps.putPixelsCalls.length} writes)`);
    ok(!!ps.doc.layers.find((l) => l.kind === "group"), "Apply built the group");

    // Session persistence.
    const META = require("../src/photoshop/metadata.js");
    const session = await META.loadSession();
    ok(session && session.params.density === 123, "the session remembers the last parameters");

    // User presets.
    panel.userPresets = [];
    const saved = require("../src/presets/presets.js").makeUserPreset("My Look", panel.params);
    panel.userPresets.push(saved);
    await META.saveUserPresets(panel.userPresets);
    const reloaded = await META.loadUserPresets();
    ok(reloaded.length === 1 && reloaded[0].name === "My Look", "user presets round trip through storage");

    uninstall();
  }

  /* ================================================================ */
  group("Control behaviour");
  {
    resetModules();
    install({ width: 100, height: 100 });
    const C = require("../src/ui/controls.js");
    const { DEF_BY_KEY } = require("../src/state/params.js");

    const def = DEF_BY_KEY.radius; // 0..200, default 100
    const seen = [];
    // Start away from the mid point so a drag to the middle is a real change.
    const slider = C.createSlider(def, 40, (v, committed) => seen.push([v, committed]));

    const track = slider.el.find((e) => e.className === "slider");
    track.emit("pointerdown", { clientX: 100, pointerId: 1 });
    ok(seen.length === 1 && !seen[0][1], "dragging emits uncommitted changes");
    ok(seen[0][0] === 100, `mid-track maps to the middle of the range (${seen[0][0]} of ${def.min}..${def.max})`);
    track.emit("pointerup", { pointerId: 1 });
    ok(seen[seen.length - 1][1] === true, "releasing emits a committed change");

    track.emit("pointerdown", { clientX: 500, pointerId: 1 });
    ok(seen[seen.length - 1][0] === def.max, "dragging past the end clamps to the maximum");
    track.emit("pointerdown", { clientX: -50, pointerId: 1 });
    ok(seen[seen.length - 1][0] === def.min, "dragging before the start clamps to the minimum");

    seen.length = 0;
    track.emit("dblclick", {});
    ok(seen.length === 1 && seen[0][0] === def.def, "double click restores the default");

    // Numeric entry
    const input = slider.el.find((e) => e.className === "ctl-value");
    input.value = "77";
    input.emit("change", {});
    ok(seen[seen.length - 1][0] === 77, "typing a value applies it");
    input.value = "garbage";
    const countBefore = seen.length;
    input.emit("change", {});
    ok(seen.length === countBefore, "garbage input is ignored rather than producing NaN");

    // Toggle
    const tdef = DEF_BY_KEY.invert;
    let toggled = null;
    const toggle = C.createToggle(tdef, false, (v) => {
      toggled = v;
    });
    toggle.el.find((e) => (e.className || "").indexOf("toggle") === 0).emit("click", {});
    ok(toggled === true, "the toggle flips on click");

    // Choice
    const cdef = DEF_BY_KEY.shape;
    let chosen = null;
    const choice = C.createChoice(cdef, "circle", (v) => {
      chosen = v;
    });
    const items = choice.el.findAll((e) => (e.className || "").indexOf("seg-item") === 0);
    ok(items.length === cdef.options.length, `every shape has a button (${items.length})`);
    items[1].emit("click", {});
    ok(chosen === cdef.options[1], `choosing emits the option id (${chosen})`);

    ok(C.normalizeHex("#abc") === "#AABBCC", "3 digit hex expands");
    ok(C.normalizeHex("EC3E32") === "#EC3E32", "bare hex is accepted");
    ok(C.normalizeHex("nope") === null, "invalid hex is rejected");

    uninstall();
  }

  /* ================================================================ */
  console.log(`\n${"-".repeat(60)}`);
  if (failed) {
    console.log(`\x1b[31m${failed} failed\x1b[0m, ${passed} passed`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32mAll ${passed} assertions passed.\x1b[0m`);
  }
}

function countLayers(list) {
  let n = 0;
  for (const l of list) {
    n++;
    if (l.layers) n += countLayers(l.layers);
  }
  return n;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
