"use strict";

/**
 * Orchestration: turning engine output into a non-destructive layer structure.
 *
 * THE STRUCTURE
 * -------------
 *   [Group] Halftone ▸ HT-4f2a9c        <- parameters stored here
 *      ├── Halftone Render               <- generated pixels (visible)
 *      └── Halftone Source               <- the original, as a Smart Object,
 *                                           hidden and never written to
 *
 * WHY NOT A REAL SMART FILTER
 * ---------------------------
 * Photoshop does not let a plugin register its own Smart Filter: the filter
 * list is closed to UXP, and there is no API to install a re-editable filter
 * entry on a Smart Object. So a genuine "double click the filter to reopen the
 * dialog" experience is not achievable, and this plugin does not pretend
 * otherwise. What it does instead:
 *
 *   - the original pixels are never modified; they are sealed inside a Smart
 *     Object that stays in the document,
 *   - the render lives on its own layer, so masks, opacity and blend modes the
 *     user adds to it survive an Update,
 *   - the parameters ride along with the layer (see metadata.js), so selecting
 *     an old render restores every slider and Update re-renders from the
 *     untouched source.
 *
 * That is re-editable in every practical sense; it just is not a Smart Filter.
 *
 * OUTPUT MODES
 * ------------
 *   flat      - one pixel layer holding the composite.
 *   separated - one solid-colour fill layer per palette colour, each carrying a
 *               mask with that colour's coverage. The masks are mutually
 *               exclusive and sum to full coverage, so the stack reproduces the
 *               flat render exactly while staying editable: double-click a fill
 *               layer to change that ink everywhere at once, and the layers
 *               resample cleanly because only the mask is raster.
 *               This needs imaging.putLayerMask; where that is missing the
 *               plugin falls back to flat and says so rather than building half
 *               a layer stack.
 */

const { app, modal } = require("./host.js");
const doc = require("./document.js");
const L = require("./layers.js");
const IM = require("./imaging.js");
const META = require("./metadata.js");

/* ------------------------------------------------------------------ *
 * Context discovery
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} HalftoneContext
 * @property {"existing"|"new"|"none"} mode
 * @property {object} [group]        DOM group layer
 * @property {object} [sourceLayer]  DOM smart object layer
 * @property {object} [renderLayer]  DOM pixel layer
 * @property {object} [targetLayer]  DOM layer to convert (mode "new")
 * @property {string} [renderId]
 * @property {string} [message]
 */

/**
 * Work out what the current selection means.
 * @returns {HalftoneContext}
 */
function currentContext() {
  const d = app().activeDocument;
  if (!d) return { mode: "none", message: "Open a document to get started." };

  const sel = d.activeLayers || [];
  if (!sel.length) return { mode: "none", message: "Select a layer to halftone." };

  for (const layer of sel) {
    const group = META.isHalftoneGroupName(layer.name)
      ? layer
      : doc.ancestors(layer).find((a) => META.isHalftoneGroupName(a.name));
    if (group) {
      return {
        mode: "existing",
        group,
        sourceLayer: L.childByName(group, META.SOURCE_LAYER_NAME),
        renderLayer: L.childByName(group, META.RENDER_LAYER_NAME),
        renderId: META.renderIdFromName(group.name),
      };
    }
  }

  const target = sel[0];
  if (String(target.kind) === "group") {
    return {
      mode: "none",
      message: "Groups can't be halftoned directly. Select a pixel or Smart Object layer.",
    };
  }
  return { mode: "new", targetLayer: target };
}

/**
 * Bounds of a layer, clipped to the canvas. Falls back to the whole canvas.
 * @returns {{left:number, top:number, right:number, bottom:number}}
 */
function layerBounds(domLayer, d) {
  const canvas = IM.canvasBounds(d);
  try {
    const b = domLayer.bounds;
    if (!b) return canvas;
    const left = Math.max(canvas.left, Math.floor(num(b.left)));
    const top = Math.max(canvas.top, Math.floor(num(b.top)));
    const right = Math.min(canvas.right, Math.ceil(num(b.right)));
    const bottom = Math.min(canvas.bottom, Math.ceil(num(b.bottom)));
    if (right - left < 1 || bottom - top < 1) return canvas;
    return { left, top, right, bottom };
  } catch (e) {
    return canvas;
  }
}

function num(v) {
  if (typeof v === "number") return v;
  if (v && typeof v._value === "number") return v._value;
  return Number(v) || 0;
}

/* ------------------------------------------------------------------ *
 * Reading the source
 * ------------------------------------------------------------------ */

/**
 * Read the pixels the engine should work from.
 *
 * @param {object} [opts] {maxLongest}
 * @returns {Promise<{image: object, bounds: object, layerName: string}|null>}
 */
async function readSource(opts = {}) {
  const ctx = currentContext();
  if (ctx.mode === "none") throw new Error(ctx.message);

  const d = app().activeDocument;
  const layer = ctx.mode === "existing" ? ctx.sourceLayer : ctx.targetLayer;
  if (!layer) {
    throw new Error(
      `This halftone group has no "${META.SOURCE_LAYER_NAME}" layer, so there is nothing to re-render.`
    );
  }

  const bounds = layerBounds(layer, d);
  let image = null;
  await modal(async () => {
    // A hidden Smart Object still reads fine, but a few host builds return an
    // empty buffer for it, so make it visible for the duration of the read.
    const wasVisible = layer.visible;
    if (!wasVisible) await L.setVisible(layer.id, true);
    try {
      image = await IM.readLayerPixels({
        documentID: d.id,
        layerID: layer.id,
        bounds,
        maxLongest: opts.maxLongest,
      });
    } finally {
      if (!wasVisible) await L.setVisible(layer.id, false);
    }
  }, "Halftone: read source");

  return {
    image,
    bounds,
    layerName: layer.name,
    layerId: layer.id,
    docPPI: Number(d.resolution) || 72,
    context: ctx,
  };
}

/* ------------------------------------------------------------------ *
 * Apply / Update
 * ------------------------------------------------------------------ */

/**
 * Write the render into the group, in whichever output mode was asked for.
 *
 * Returns the mode actually used, which may differ from the requested one when
 * the host cannot write masks.
 *
 * @returns {Promise<{mode: string, layerIds: number[], note: string}>}
 */
async function writeRender(engine, params, ctx, opts) {
  const { doc: d, bounds, width, height, group, anchorLayerId, report } = opts;
  const wantSeparated = params.output === "separated";

  if (wantSeparated && !IM.canWriteMasks()) {
    const res = await writeFlat(engine, params, opts);
    return {
      mode: "flat",
      layerIds: res.layerIds,
      note:
        "Colour separation needs imaging.putLayerMask, which this Photoshop build does not expose. " +
        "Rendered as a single flat layer instead.",
    };
  }

  if (!wantSeparated) {
    const res = await writeFlat(engine, params, opts);
    return { mode: "flat", layerIds: res.layerIds, note: "" };
  }

  // --- separated -----------------------------------------------------
  report(0.25);
  const sep = engine.renderSeparated(params, { width, height });
  report(0.55);

  const layerIds = [];
  // Build bottom-up so the paper ends up underneath every ink.
  const order = [];
  for (let i = 0; i < sep.palette.length; i++) {
    if (i !== sep.paperIndex) order.push(i);
  }
  order.unshift(sep.paperIndex);

  let anchor = anchorLayerId;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const rgb = hexToRgbTriplet(sep.palette[i]);
    const isPaper = i === sep.paperIndex;
    const name = isPaper ? "Paper " + sep.palette[i] : `Ink ${k} ${sep.palette[i]}`;

    // eslint-disable-next-line no-await-in-loop
    await L.selectLayers([anchor]);
    // eslint-disable-next-line no-await-in-loop
    const layer = await L.createSolidFillLayer(name, rgb);
    // eslint-disable-next-line no-await-in-loop
    await L.addLayerMask(layer.id, "revealAll");
    // eslint-disable-next-line no-await-in-loop
    await IM.writeLayerMask({
      documentID: d.id,
      layerID: layer.id,
      data: sep.masks[i],
      width,
      height,
      targetBounds: bounds,
    });
    layerIds.push(layer.id);
    anchor = layer.id;
    report(0.55 + 0.4 * ((k + 1) / order.length));
  }

  void group;
  void ctx;
  return {
    mode: "separated",
    layerIds,
    note: `${order.length} fill layers, one per palette colour.`,
  };
}

/** Render the composite into a single pixel layer. */
async function writeFlat(engine, params, opts) {
  const { doc: d, bounds, width, height, anchorLayerId, report, existingLayerId } = opts;

  const out = await engine.renderAsync(params, {
    width,
    height,
    onProgress: (t) => report(0.2 + t * 0.65),
  });
  if (!out) throw new Error("Render was cancelled.");

  let layerId = existingLayerId;
  if (!layerId) {
    await L.selectLayers([anchorLayerId]);
    const layer = await L.createPixelLayer(META.RENDER_LAYER_NAME);
    layerId = layer.id;
  }

  report(0.9);
  await IM.writeLayerPixels({
    documentID: d.id,
    layerID: layerId,
    data: out.data,
    width,
    height,
    targetBounds: bounds,
  });
  return { layerIds: [layerId] };
}

function hexToRgbTriplet(hex) {
  const n = parseInt(String(hex).replace(/^#/, ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build the halftone structure for one layer.
 *
 * Assumes it is already inside a modal scope, which is what lets the batch
 * runner wrap an arbitrary number of these in a single undo step.
 *
 * @param {import("../engine/pipeline.js").HalftoneEngine} engine
 * @param {object} params
 * @param {object} targetLayer DOM layer to convert
 * @param {object} d the document
 * @param {(t:number)=>void} report
 * @returns {Promise<object>}
 */
async function buildRenderFor(engine, params, targetLayer, d, report) {
  const renderId = META.newRenderId();
  const bounds = layerBounds(targetLayer, d);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;

  // The panel may have been previewing a different layer (the user can change
  // the selection between Load and Apply, and a batch walks many layers), so
  // re-read rather than silently rendering the wrong pixels.
  if (engine.sourceLayerId !== targetLayer.id) {
    const image = await IM.readLayerPixels({
      documentID: d.id,
      layerID: targetLayer.id,
      bounds,
    });
    engine.setSource(image);
    engine.sourceLayerId = targetLayer.id;
  }
  report(0.05);

  // 1. Seal the original inside a Smart Object. Nothing destructive happens to
  //    it from here on.
  await L.selectLayers([targetLayer.id]);
  const so = await L.convertToSmartObject();
  await L.renameLayer(so.id, META.SOURCE_LAYER_NAME);

  // 2. Wrap it in a group that carries the render id.
  const group = await L.groupLayers(META.groupName(renderId), [so]);

  // 3. Everything below the render is the untouched original.
  await L.setVisible(so.id, false);

  // 4. Write the render.
  report(0.1);
  const written = await writeRender(engine, params, null, {
    doc: d,
    bounds,
    width,
    height,
    group,
    anchorLayerId: so.id,
    report,
  });

  // 5. Remember how we got here.
  const record = META.makeRecord(renderId, params, {
    docName: d.name,
    bounds,
    outputMode: written.mode,
    sourceLayerName: META.SOURCE_LAYER_NAME,
  });
  const persistence = await META.saveRecord([group.id].concat(written.layerIds), record);

  return {
    renderId,
    persistence,
    width,
    height,
    outputMode: written.mode,
    note: written.note,
    groupId: group.id,
  };
}

/**
 * Build a brand new halftone render from the selected layer.
 *
 * @param {import("../engine/pipeline.js").HalftoneEngine} engine already holding the source
 * @param {object} params
 * @param {{onProgress?: (t:number)=>void}} [hooks]
 * @returns {Promise<{renderId: string, persistence: object, width: number, height: number}>}
 */
async function applyNew(engine, params, hooks = {}) {
  const ctx = currentContext();
  if (ctx.mode === "existing") return updateExisting(engine, params, hooks);
  if (ctx.mode === "none") throw new Error(ctx.message);
  if (!engine.hasSource()) throw new Error("No source pixels loaded yet.");

  const d = app().activeDocument;
  let result = null;

  await modal(async (executionContext) => {
    const report = makeReporter(executionContext, hooks.onProgress);
    result = await buildRenderFor(engine, params, ctx.targetLayer, d, report);
    await L.selectLayers([result.groupId]);
    report(1);
  }, "Apply Halftone");

  return result;
}

/**
 * Re-render an existing halftone group from its untouched source.
 */
async function updateExisting(engine, params, hooks = {}) {
  const ctx = currentContext();
  if (ctx.mode !== "existing") throw new Error("Select an existing halftone group to update.");
  if (!ctx.sourceLayer) {
    throw new Error(`This group has no "${META.SOURCE_LAYER_NAME}" layer to re-render from.`);
  }

  const d = app().activeDocument;
  const bounds = layerBounds(ctx.sourceLayer, d);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const renderId = ctx.renderId || META.newRenderId();
  let persistence = { xmp: false, sidecar: false };
  let written = { mode: params.output, layerIds: [], note: "" };

  await modal(async (executionContext) => {
    const report = makeReporter(executionContext, hooks.onProgress);

    // Always re-read: the user may have edited the Smart Object's contents.
    const wasVisible = ctx.sourceLayer.visible;
    if (!wasVisible) await L.setVisible(ctx.sourceLayer.id, true);
    let image;
    try {
      image = await IM.readLayerPixels({
        documentID: d.id,
        layerID: ctx.sourceLayer.id,
        bounds,
      });
    } finally {
      if (!wasVisible) await L.setVisible(ctx.sourceLayer.id, false);
    }
    engine.setSource(image);
    engine.sourceLayerId = ctx.sourceLayer.id;
    report(0.15);

    // Everything in the group except the source is previous output.
    const stale = (ctx.group.layers || []).filter((l) => l.name !== META.SOURCE_LAYER_NAME);
    const canReuse =
      params.output !== "separated" &&
      stale.length === 1 &&
      stale[0].name === META.RENDER_LAYER_NAME;

    if (!canReuse) {
      // A separated render has a variable number of layers, and switching output
      // mode changes their kind, so the previous output is rebuilt rather than
      // patched. Reuse is kept for the common flat -> flat case precisely
      // because that is where preserving the user's mask and blend mode matters.
      for (const l of stale) {
        // eslint-disable-next-line no-await-in-loop
        await L.deleteLayer(l.id);
      }
    }

    written = await writeRender(engine, params, ctx, {
      doc: d,
      bounds,
      width,
      height,
      group: ctx.group,
      anchorLayerId: ctx.sourceLayer.id,
      existingLayerId: canReuse ? stale[0].id : null,
      report,
    });

    if (ctx.group && META.renderIdFromName(ctx.group.name) !== renderId) {
      await L.renameLayer(ctx.group.id, META.groupName(renderId));
    }
    const record = META.makeRecord(renderId, params, {
      docName: d.name,
      bounds,
      outputMode: written.mode,
    });
    persistence = await META.saveRecord([ctx.group.id].concat(written.layerIds), record);
    report(1);
  }, "Update Halftone");

  return {
    renderId,
    persistence,
    width,
    height,
    updated: true,
    outputMode: written.mode,
    note: written.note,
  };
}

/**
 * Restore the parameters stored with the currently selected halftone render.
 * @returns {Promise<{params: object, source: string, renderId: string}|null>}
 */
async function recallParams() {
  const ctx = currentContext();
  if (ctx.mode !== "existing") return null;
  const layerIds = [];
  if (ctx.group) layerIds.push(ctx.group.id);
  // A separated render has no "Halftone Render" layer, so scan every child.
  for (const l of (ctx.group && ctx.group.layers) || []) {
    if (l.name !== META.SOURCE_LAYER_NAME) layerIds.push(l.id);
  }
  const found = await META.loadRecord({ renderId: ctx.renderId, layerIds });
  if (!found) return null;
  return { params: found.record.params, source: found.source, renderId: ctx.renderId };
}

/**
 * Bridge engine progress to Photoshop's own progress bar when the host offers
 * it, and to the panel either way.
 */
function makeReporter(executionContext, onProgress) {
  const canReport =
    executionContext && typeof executionContext.reportProgress === "function";
  return (t) => {
    const clamped = Math.max(0, Math.min(1, t));
    if (canReport) {
      try {
        executionContext.reportProgress({ value: clamped });
      } catch (e) {
        /* progress is cosmetic */
      }
    }
    if (onProgress) onProgress(clamped);
  };
}

module.exports = {
  currentContext,
  readSource,
  buildRenderFor,
  applyNew,
  updateExisting,
  recallParams,
  layerBounds,
};
