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
  group("Separated output: fill layers + masks");
  {
    resetModules();
    const image = F.photo(500, 400);
    const { ps } = install({ width: 500, height: 400, image });
    const RENDER = require("../src/photoshop/render.js");
    const META = require("../src/photoshop/metadata.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { sanitizeParams: sane, defaultParams: defs } = require("../src/state/params.js");

    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);
    const params = sane(
      Object.assign(defs(), {
        output: "separated",
        colorCount: 4,
        paletteLocked: false,
        density: 50,
      })
    );

    const res = await RENDER.applyNew(engine, params, {});
    ok(res.outputMode === "separated", `apply used the separated output (${res.outputMode})`);

    const group = ps.doc.layers.find((l) => l.kind === "group");
    const fills = group.layers.filter((l) => l.kind === "solidColor");
    const source = group.layers.find((l) => l.name === META.SOURCE_LAYER_NAME);

    ok(fills.length >= 4, `one fill layer per palette colour (${fills.length})`);
    ok(fills.every((l) => l.hasMask), "every fill layer got a mask");
    ok(fills.every((l) => l.maskWritten), "every mask received pixels");
    ok(ps.putPixelsCalls.length === 0, "no flattened pixel layer was written");
    ok(
      ps.putLayerMaskCalls.length === fills.length,
      `one mask write per fill layer (${ps.putLayerMaskCalls.length})`
    );
    ok(
      ps.putLayerMaskCalls.every((c) => c.imageData.components === 1),
      "masks are written as single-channel data"
    );
    ok(
      ps.putLayerMaskCalls.every(
        (c) => c.targetBounds.right === 500 && c.targetBounds.bottom === 400
      ),
      "masks are written at full document size"
    );
    ok(!!source && source.kind === "smartObject", "the original is still a hidden Smart Object");
    ok(source.visible === false, "the source stays hidden");

    // The paper must sit underneath every ink.
    const paperIdx = group.layers.findIndex((l) => /^Paper /.test(l.name));
    const inkIdxs = group.layers
      .map((l, i) => (/^Ink /.test(l.name) ? i : -1))
      .filter((i) => i >= 0);
    ok(paperIdx >= 0, "there is a paper layer");
    ok(inkIdxs.every((i) => i < paperIdx), "every ink layer sits above the paper");

    // Fill colours must match the palette that was reported.
    const fillHexes = fills
      .map((l) => "#" + l.fillColor.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase())
      .sort();
    ok(new Set(fillHexes).size === fills.length, "each fill layer carries a distinct colour");

    // Params round-trip, including the output mode.
    ps.doc.activeLayers = [group];
    const recalled = await RENDER.recallParams();
    ok(!!recalled, "parameters recall from a separated render");
    ok(recalled.params.output === "separated", "the output mode round-trips");

    // Update must rebuild the stack rather than stacking a second set.
    const before = countLayers(ps.doc.layers);
    await RENDER.updateExisting(engine, params, {});
    ok(countLayers(ps.doc.layers) === before, `update rebuilds in place (${countLayers(ps.doc.layers)} layers)`);

    // Switching back to flat must clear the fill layers.
    const flatParams = Object.assign({}, params, { output: "flat" });
    await RENDER.updateExisting(engine, flatParams, {});
    const g2 = ps.doc.layers.find((l) => l.kind === "group");
    ok(
      g2.layers.filter((l) => l.kind === "solidColor").length === 0,
      "switching to flat removes the fill layers"
    );
    ok(
      !!g2.layers.find((l) => l.name === META.RENDER_LAYER_NAME),
      "switching to flat creates the pixel render layer"
    );
    ok(ps.putPixelsCalls.length === 1, "the flat render wrote pixels once");

    uninstall();
  }

  /* ================================================================ */
  group("Selection confines the render");
  {
    resetModules();
    // A selection covering the left half of a 400x300 document.
    const { ps } = install({
      width: 400,
      height: 300,
      image: F.photo(400, 300),
      selection: { left: 0, top: 0, right: 200, bottom: 300 },
    });
    const RENDER = require("../src/photoshop/render.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { sanitizeParams: sane, defaultParams: defs } = require("../src/state/params.js");

    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);
    const params = sane(Object.assign(defs(), { density: 40, useSelection: true }));

    await RENDER.applyNew(engine, params, {});
    ok(ps.getSelectionCalls.length > 0, "the selection was read");

    const write = ps.putPixelsCalls[ps.putPixelsCalls.length - 1];
    const data = write.imageData.data;
    const w = write.imageData.width;
    const h = write.imageData.height;
    ok(w === 400 && h === 300, `the render still covers the whole layer (${w}x${h})`);

    // Alpha, not colour, is what the selection controls: inside is opaque,
    // outside is fully transparent.
    let insideOpaque = 0;
    let outsideOpaque = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const a = data[(y * w + x) * 4 + 3];
        if (x < 200) {
          if (a > 250) insideOpaque++;
        } else if (a > 4) {
          outsideOpaque++;
        }
      }
    }
    ok(insideOpaque > 0, `the selected half is rendered (${insideOpaque} opaque samples)`);
    ok(outsideOpaque === 0, `nothing is drawn outside the selection (${outsideOpaque} strays)`);

    uninstall();
  }

  /* ================================================================ */
  group("Selection is optional, never required");
  {
    // Three ways there is no selection to apply, all of which must render the
    // whole layer rather than fail: the toggle is off, the document has no
    // selection, and the host has no getSelection at all.
    const cases = [
      { name: "the toggle is off", opts: { selection: { left: 0, top: 0, right: 100, bottom: 100 } }, useSelection: false },
      { name: "nothing is selected", opts: {}, useSelection: true },
      { name: "the host has no getSelection", opts: { noSelectionAPI: true }, useSelection: true },
    ];

    for (const c of cases) {
      resetModules();
      const { ps } = install(Object.assign({ width: 300, height: 200 }, c.opts));
      const RENDER = require("../src/photoshop/render.js");
      const { HalftoneEngine } = require("../src/engine/pipeline.js");
      const { sanitizeParams: sane, defaultParams: defs } = require("../src/state/params.js");

      const engine = new HalftoneEngine();
      // eslint-disable-next-line no-await-in-loop
      engine.setSource((await RENDER.readSource()).image);
      // eslint-disable-next-line no-await-in-loop
      const res = await RENDER.applyNew(
        engine,
        sane(Object.assign(defs(), { density: 30, useSelection: c.useSelection })),
        {}
      );
      ok(!!res.renderId, `${c.name}: apply still succeeds`);

      const write = ps.putPixelsCalls[ps.putPixelsCalls.length - 1];
      const data = write.imageData.data;
      let transparent = 0;
      for (let i = 3; i < data.length; i += 4 * 37) {
        if (data[i] < 250) transparent++;
      }
      ok(transparent === 0, `${c.name}: the whole layer is rendered (${transparent} transparent samples)`);
      uninstall();
    }
  }

  /* ================================================================ */
  group("Separated output falls back when masks are unavailable");
  {
    resetModules();
    const { ps } = install({ width: 300, height: 200, noMasks: true });
    const RENDER = require("../src/photoshop/render.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { sanitizeParams: sane, defaultParams: defs } = require("../src/state/params.js");

    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);
    const res = await RENDER.applyNew(
      engine,
      sane(Object.assign(defs(), { output: "separated" })),
      {}
    );

    ok(res.outputMode === "flat", "falls back to flat output rather than failing");
    ok(/putLayerMask/.test(res.note), `the reason is reported to the user ("${res.note.slice(0, 60)}...")`);
    ok(ps.putPixelsCalls.length === 1, "a usable flat render was still produced");
    const group = ps.doc.layers.find((l) => l.kind === "group");
    ok(
      group.layers.filter((l) => l.kind === "solidColor").length === 0,
      "no half-built fill layers were left behind"
    );

    uninstall();
  }

  /* ================================================================ */
  group("Dither mode end to end");
  {
    resetModules();
    const image = F.photo(600, 400);
    const { ps } = install({ width: 600, height: 400, image });
    const RENDER = require("../src/photoshop/render.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { presetToParams, BUILTIN_PRESETS } = require("../src/presets/presets.js");

    const engine = new HalftoneEngine();
    engine.setSource((await RENDER.readSource()).image);

    const preset = BUILTIN_PRESETS.find((p) => p.id === "mac-classic");
    const params = presetToParams(preset);
    ok(params.mode === "dither", "the Mac Classic preset is a dither preset");

    const res = await RENDER.applyNew(engine, params, {});
    ok(!!res.renderId, "dither mode applies");
    ok(ps.putPixelsCalls.length === 1, "one pixel write");
    ok(
      ps.putPixelsCalls[0].imageData.byteLength === 600 * 400 * 4,
      "the dither render is written at full document size"
    );

    const group = ps.doc.layers.find((l) => l.kind === "group");
    ps.doc.activeLayers = [group];
    const recalled = await RENDER.recallParams();
    ok(recalled.params.mode === "dither", "the render mode round-trips through metadata");
    ok(
      recalled.params.ditherAlgorithm === "atkinson",
      `the algorithm round-trips (${recalled.params.ditherAlgorithm})`
    );

    uninstall();
  }

  /* ================================================================ */
  group("Batch render");
  {
    resetModules();
    const image = F.photo(400, 300);
    const { ps } = install({ width: 400, height: 300, image });
    const BATCH = require("../src/photoshop/batch.js");
    const META = require("../src/photoshop/metadata.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { sanitizeParams: sane, defaultParams: defs } = require("../src/state/params.js");

    // Three more pixel layers alongside the Background.
    const mk = (name) => {
      const l = {
        id: ps.nextLayerId++,
        name,
        kind: "pixel",
        visible: true,
        parent: ps.doc,
        bounds: { left: 0, top: 0, right: 400, bottom: 300 },
      };
      ps.doc.layers.push(l);
      return l;
    };
    const a = mk("Shot A");
    const b = mk("Shot B");
    mk("Shot C");

    ok(BATCH.previewBatch("document").count === 4, "document scope finds every pixel layer");
    ps.doc.activeLayers = [a, b];
    ok(BATCH.previewBatch("selection").count === 2, "selection scope follows the selection");

    const engine = new HalftoneEngine();
    const params = sane(Object.assign(defs(), { density: 40, colorCount: 3, paletteLocked: false }));

    const seen = [];
    const res = await BATCH.runBatch(engine, params, {
      scope: "selection",
      sharedPalette: true,
      onItem: (i, total, name) => seen.push(name),
    });

    ok(res.done === 2, `both selected layers were rendered (${res.done}/${res.total})`);
    ok(res.failures.length === 0, "no failures");
    ok(seen.join(",") === "Shot A,Shot B", `progress reported each layer by name (${seen.join(",")})`);
    ok(ps.putPixelsCalls.length === 2, "one render written per layer");
    ok(res.renderIds.length === 2 && res.renderIds[0] !== res.renderIds[1], "each render got its own id");

    const groups = ps.doc.layers.filter((l) => l.kind === "group");
    ok(groups.length === 2, `two halftone groups were created (${groups.length})`);
    ok(
      groups.every((g) => g.layers.some((l) => l.name === META.SOURCE_LAYER_NAME)),
      "each group holds its own Smart Object source"
    );

    // Shared palette: the second render must use the first one's colours.
    ok(!!res.palette && res.palette.length === 3, `a shared palette was pinned (${res.palette})`);
    const recs = await Promise.all(
      res.renderIds.map((id) => META.loadRecord({ renderId: id, layerIds: [] }))
    );
    ok(
      recs[1].record.params.palette.join(",") === res.palette.join(","),
      "the second layer rendered with the pinned palette"
    );
    ok(recs[1].record.params.paletteLocked === true, "the pinned palette is locked for the rest of the batch");

    // Re-running must not halftone its own output.
    const after = BATCH.previewBatch("document");
    ok(
      after.names.every((n) => n !== META.RENDER_LAYER_NAME && n !== META.SOURCE_LAYER_NAME),
      `a second batch skips existing halftone output (${after.names.join(", ")})`
    );
    ok(after.count === 2, `only the two untouched layers remain eligible (${after.count})`);

    uninstall();
  }

  /* ================================================================ */
  group("Batch resilience");
  {
    resetModules();
    const { ps } = install({ width: 300, height: 200 });
    const BATCH = require("../src/photoshop/batch.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams: defs, sanitizeParams: sane } = require("../src/state/params.js");

    for (const n of ["One", "Two", "Three"]) {
      ps.doc.layers.push({
        id: ps.nextLayerId++,
        name: n,
        kind: "pixel",
        visible: true,
        parent: ps.doc,
        bounds: { left: 0, top: 0, right: 300, bottom: 200 },
      });
    }

    // Make the middle layer fail on read.
    const realGetPixels = ps.imaging.getPixels;
    let call = 0;
    ps.imaging.getPixels = async (req) => {
      call++;
      if (call === 2) throw new Error("simulated read failure");
      return realGetPixels(req);
    };

    const engine = new HalftoneEngine();
    const res = await BATCH.runBatch(engine, sane(defs()), { scope: "document" });
    ok(res.failures.length === 1, `one layer failed (${res.failures.length})`);
    ok(res.done === 3, `the other three still rendered (${res.done}/${res.total})`);
    ok(/simulated read failure/.test(res.failures[0].error), "the failure reason is carried back");
    ok(!!res.failures[0].name, `the failing layer is named (${res.failures[0].name})`);

    // Cancellation stops early and reports it.
    ps.imaging.getPixels = realGetPixels;
    resetModules();
    uninstall();
  }

  /* ================================================================ */
  group("Batch cancellation");
  {
    resetModules();
    const { ps } = install({ width: 200, height: 150 });
    const BATCH = require("../src/photoshop/batch.js");
    const { HalftoneEngine } = require("../src/engine/pipeline.js");
    const { defaultParams: defs, sanitizeParams: sane } = require("../src/state/params.js");

    for (const n of ["P", "Q", "R", "S"]) {
      ps.doc.layers.push({
        id: ps.nextLayerId++,
        name: n,
        kind: "pixel",
        visible: true,
        parent: ps.doc,
        bounds: { left: 0, top: 0, right: 200, bottom: 150 },
      });
    }

    let count = 0;
    const res = await BATCH.runBatch(new HalftoneEngine(), sane(defs()), {
      scope: "document",
      shouldCancel: () => count++ >= 2,
    });
    ok(res.cancelled === true, "cancellation is reported");
    ok(res.done < res.total, `it stopped early (${res.done}/${res.total})`);
    ok(
      ps.doc.layers.filter((l) => l.kind === "group").length === res.done,
      "only the completed layers left groups behind"
    );
    // Nothing may be left half-built: every group a cancelled batch created
    // must still hold both its source and its render.
    const groups = ps.doc.layers.filter((l) => l.kind === "group");
    ok(
      groups.every((g) => (g.layers || []).length === 2),
      `every group the cancelled batch built is complete (${groups.map((g) => (g.layers || []).length).join(",")})`
    );

    uninstall();
  }

  /* ================================================================ */
  group("The cancel button reaches the batch");
  {
    // runBatch has always supported cancellation, but nothing in the UI ever
    // set the flag - the feature was implemented and unreachable. This drives
    // the actual button.
    resetModules();
    const { ps, document } = install({ width: 200, height: 150, image: F.photo(200, 150) });
    const { Panel } = require("../src/ui/panel.js");

    for (const n of ["P", "Q", "R", "S", "T", "U"]) {
      ps.doc.layers.push({
        id: ps.nextLayerId++,
        name: n,
        kind: "pixel",
        visible: true,
        parent: ps.doc,
        bounds: { left: 0, top: 0, right: 200, bottom: 150 },
      });
    }

    const panel = new Panel(document);
    await panel.init();
    const cancelBtn = document.getElementById("btn-cancel");
    ok(cancelBtn.className.indexOf("show") < 0, "the cancel button is hidden when nothing is running");
    ok(cancelBtn.getAttribute("disabled") === "true", "and disabled, so it cannot be reached early");

    panel.params.batchScope = "document";
    document.getElementById("btn-batch").emit("click");

    // Press it as soon as the batch is under way.
    ok(await waitFor(() => cancelBtn.className.indexOf("show") >= 0), "it appears once the batch starts");
    ok(!cancelBtn.getAttribute("disabled"), "and is enabled while every other button is not");
    ok(
      document.getElementById("btn-apply").getAttribute("disabled") === "true",
      "the other buttons are disabled during the batch"
    );
    cancelBtn.emit("click");
    ok(panel._cancel === true, "clicking it raises the cancel flag");

    ok(await waitFor(() => !panel._busy), "the batch finishes");
    const built = ps.doc.layers.filter((l) => l.kind === "group").length;
    ok(built < 6, `it stopped before doing all six layers (${built} built)`);
    ok(built > 0, `and kept what it had already finished (${built})`);
    ok(
      /Stopped early/.test(document.getElementById("notice").textContent),
      `the panel says what happened ("${document.getElementById("notice").textContent.slice(0, 60)}")`
    );
    ok(cancelBtn.className.indexOf("show") < 0, "the button hides again afterwards");

    uninstall();
  }

  /* ================================================================ */
  group("Panel wiring");
  {
    resetModules();
    const image = F.photo(800, 600);
    const { ps, document } = install({ width: 800, height: 600, image });
    const { Panel } = require("../src/ui/panel.js");
    const { PARAM_DEFS, defaultParams: mkDefaults, sanitizeParams: sanitize } = require("../src/state/params.js");
    const { BUILTIN_PRESETS } = require("../src/presets/presets.js");
    const sanitizeAll = (over) => sanitize(Object.assign(mkDefaults(), over));

    const panel = new Panel(document);
    await panel.init();

    // Controls are built conditionally (per mode, and per showIf), so the
    // invariant is "every currently visible parameter has a control", plus
    // "every parameter becomes visible in some reachable state".
    const { isVisible } = require("../src/state/params.js");
    const missingNow = PARAM_DEFS.filter(
      (d) => isVisible(d, panel.params) && !panel.controls[d.key]
    ).map((d) => d.key);
    ok(missingNow.length === 0, `every visible parameter has a control (${missingNow.join(", ") || "none missing"})`);
    const extraNow = Object.keys(panel.controls).filter(
      (k) => !isVisible(require("../src/state/params.js").DEF_BY_KEY[k], panel.params)
    );
    ok(extraNow.length === 0, `no control is built for a hidden parameter (${extraNow.join(", ") || "none"})`);
    ok(!!panel.controls.radius && !!panel.controls.palette, "sliders and the palette editor exist");

    // Walk every reachable state and confirm nothing in the schema is orphaned.
    const everSeen = new Set(Object.keys(panel.controls));
    const savedParams = Object.assign({}, panel.params);
    for (const mode of ["halftone", "dither"]) {
      for (const scaleMode of ["relative", "dpi"]) {
        for (const tonal of [false, true]) {
          for (const screenMode of ["single", "perInk"]) {
            for (const waveAmount of [0, 40]) {
              panel.params = sanitizeAll({
                mode,
                scaleMode,
                screenMode,
                tonalMapping: tonal,
                sharpen: 50,
                waveAmount,
              });
              panel.buildSections();
              Object.keys(panel.controls).forEach((k) => everSeen.add(k));
            }
          }
        }
      }
    }
    // Internal params deliberately have no control; they are state carried on
    // the swatches themselves.
    const orphans = PARAM_DEFS.filter(
      (d) => d.type !== "internal" && !everSeen.has(d.key)
    ).map((d) => d.key);
    ok(orphans.length === 0, `every parameter is reachable in some state (${orphans.join(", ") || "none orphaned"})`);
    panel.params = savedParams;
    panel.buildSections();
    panel.syncControls();

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

    // Compare: a split overlay showing the untouched source beside the render,
    // rather than swapping one for the other.
    const compareBtn = document.getElementById("btn-compare");
    const rendered = document.getElementById("preview").src;
    const split = document.getElementById("split");
    ok(split.className.indexOf("show") < 0, "the compare overlay starts hidden");

    compareBtn.emit("click", {});
    ok(split.className.indexOf("show") >= 0, "clicking Compare shows the overlay");
    const shot = document.getElementById("split-img");
    ok(shot.src.indexOf("data:image/png;base64,") === 0, "it carries an image of the source");
    ok(shot.src !== rendered, "which is not the render");
    ok(
      document.getElementById("preview").src === rendered,
      "and the render is still underneath rather than replaced"
    );
    ok(
      document.getElementById("split-clip").style.width === "50%",
      `the seam starts in the middle (${document.getElementById("split-clip").style.width})`
    );

    // Drag the handle.
    const handle = document.getElementById("split-handle");
    handle.emit("pointerdown", { clientX: 100, pointerId: 1 });
    handle.emit("pointermove", { clientX: 150, pointerId: 1 });
    handle.emit("pointerup", { clientX: 150, pointerId: 1 });
    ok(panel._splitAt > 0 && panel._splitAt <= 1, `dragging moves the seam (${panel._splitAt.toFixed(2)})`);

    compareBtn.emit("click", {});
    ok(split.className.indexOf("show") < 0, "clicking again hides it");

    // SVG export, end to end: button -> engine -> file picker -> write.
    const notice = document.getElementById("notice");
    document.getElementById("btn-svg").emit("click");
    ok(await waitFor(() => ps.savedFiles.length === 1), "Export SVG asked for a save location");
    const svgFile = ps.savedFiles[0];
    ok(/\.svg$/.test(svgFile.name), `the suggested name ends in .svg (${svgFile.name})`);
    ok(
      typeof svgFile.contents === "string" && svgFile.contents.indexOf("<svg") > 0,
      "an SVG document was written to it"
    );
    ok(
      svgFile.contents.indexOf("</svg>") > 0 && svgFile.contents.indexOf("NaN") < 0,
      "the written document is closed and free of NaN geometry"
    );
    ok(await waitFor(() => /Wrote/.test(notice.textContent)), `the panel reports the write ("${notice.textContent.slice(0, 48)}")`);

    // In dither mode the button must refuse rather than build a file with one
    // rectangle per pixel.
    const beforeMode = panel.params.mode;
    panel.setParam("mode", "dither", true);
    await flush();
    document.getElementById("btn-svg").emit("click");
    ok(
      await waitFor(() => /halftone mode only/i.test(notice.textContent)),
      "Export SVG refuses dither mode with an explanation"
    );
    panel.setParam("mode", beforeMode, true);
    await flush();

    // Section heads carry a live readout of what is not at its default.
    panel.setParam("shape", "diamond", true);
    ok(
      panel.summaryFor("halftone").indexOf("Diamond") >= 0,
      `the section summary reports the shape ("${panel.summaryFor("halftone")}")`
    );
    for (const key of ["hue", "saturation", "brightness", "invert"]) {
      panel.setParam(key, require("../src/state/params.js").DEF_BY_KEY[key].def, true);
    }
    ok(
      panel.summaryFor("adjust") === "",
      `a section at its defaults summarises as nothing ("${panel.summaryFor("adjust")}")`
    );
    panel.setParam("hue", 90, true);
    ok(
      /hue 90/.test(panel.summaryFor("adjust")),
      `a moved slider appears in the summary ("${panel.summaryFor("adjust")}")`
    );
    panel.setParam("hue", 0, true);

    // Locked swatches survive re-extraction.
    panel.params.palette = ["#FF0000", "#00FF00", "#0000FF"];
    panel.params.lockedSwatches = [0];
    panel.params.colorCount = 3;
    panel.extractPalette();
    ok(panel.params.palette[0] === "#FF0000", "a locked swatch survives re-extraction");
    ok(panel.params.palette[1] !== "#00FF00", "unlocked swatches are replaced");

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
  group("Full preview mode");
  {
    // This replaced a second panel entrypoint that opened empty: UXP loads one
    // document per plugin, so an entrypoint with its own HTML file is not a
    // thing. What it does instead depends on nothing but display:none, which is
    // why it is testable at all.
    resetModules();
    const { document } = install({ width: 900, height: 600, image: F.photo(900, 600) });
    const { Panel } = require("../src/ui/panel.js");

    const panel = new Panel(document);
    await panel.init();
    document.getElementById("btn-load").emit("click");
    ok(await waitFor(() => panel.engine.hasSource()), "a layer is loaded");

    const app = document.getElementById("app");
    ok(panel.theatre === false, "it starts off");
    ok(app.className.indexOf("theatre") < 0, "and the panel carries no class for it");

    const before = panel.previewBox();
    document.getElementById("btn-theatre").emit("click", {});
    ok(panel.theatre === true, "the button turns it on");
    ok(app.className === "theatre", "which is what the stylesheet keys off");
    ok(
      document.getElementById("btn-theatre").className.indexOf("active") >= 0,
      "and the button shows it is on"
    );
    // The grip must stop dictating the height, or the picture cannot take the
    // space the mode exists to give it.
    panel.ui.previewHeight = 140;
    panel.applyPreviewHeight();
    ok(
      document.getElementById("preview-wrap").style.height === "",
      "a dragged height is not applied while full"
    );

    document.getElementById("btn-theatre").emit("click", {});
    ok(panel.theatre === false, "clicking again turns it off");
    ok(app.className === "", "the class is removed");
    ok(
      document.getElementById("preview-wrap").style.height === "140px",
      "and the dragged height comes back"
    );
    void before;

    uninstall();
  }

  /* ================================================================ */
  group("Preview resizing");
  {
    resetModules();
    const { document } = install({ width: 800, height: 600, image: F.photo(800, 600) });
    const { Panel } = require("../src/ui/panel.js");
    const META = require("../src/photoshop/metadata.js");

    const panel = new Panel(document);
    await panel.init();
    document.getElementById("btn-load").emit("click");
    ok(await waitFor(() => panel.engine.hasSource()), "a layer is loaded");

    const auto = panel.previewBoxHeight();
    ok(auto > 0, `the preview has an automatic height (${auto}px)`);

    // Drag the grip down.
    const grip = document.getElementById("preview-grip");
    grip.emit("pointerdown", { clientY: 100, pointerId: 1 });
    grip.emit("pointermove", { clientY: 220, pointerId: 1 });
    ok(panel.previewBoxHeight() > auto, `dragging down grows it (${panel.previewBoxHeight()}px)`);
    grip.emit("pointerup", { clientY: 220, pointerId: 1 });

    const grown = panel.ui.previewHeight;
    ok(grown !== null, "the dragged height is remembered");

    // Clamped: it may never take the whole panel, or the pinned preview has
    // eaten the controls it exists to serve.
    grip.emit("pointerdown", { clientY: 0, pointerId: 1 });
    grip.emit("pointermove", { clientY: 9000, pointerId: 1 });
    grip.emit("pointerup", { clientY: 9000, pointerId: 1 });
    const appH = document.getElementById("app").clientHeight || 720;
    ok(
      panel.ui.previewHeight <= Math.round(appH * 0.7) + 1,
      `it is capped at 70% of the panel (${panel.ui.previewHeight} of ${appH})`
    );

    // And never smaller than something you can actually see.
    grip.emit("pointerdown", { clientY: 500, pointerId: 1 });
    grip.emit("pointermove", { clientY: -9000, pointerId: 1 });
    grip.emit("pointerup", { clientY: -9000, pointerId: 1 });
    ok(panel.ui.previewHeight >= 110, `and floored (${panel.ui.previewHeight}px)`);

    // Double-click restores the automatic size.
    grip.emit("dblclick", {});
    ok(panel.ui.previewHeight === null, "double-click goes back to automatic");
    ok(panel.previewBoxHeight() === auto, "which is the height it started at");

    // It is window state, not a render parameter: it must survive a session but
    // never ride along in a preset or in a layer's stored parameters.
    panel.ui.previewHeight = 240;
    await panel.persistSession();
    const session = await META.loadSession();
    ok(session.ui && session.ui.previewHeight === 240, "the height is stored with the session");
    ok(session.params.previewHeight === undefined, "and is not smuggled into the render parameters");

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
