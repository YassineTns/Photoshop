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

  return { image, bounds, layerName: layer.name, layerId: layer.id, context: ctx };
}

/* ------------------------------------------------------------------ *
 * Apply / Update
 * ------------------------------------------------------------------ */

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
  const renderId = META.newRenderId();
  const bounds = layerBounds(ctx.targetLayer, d);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;

  let persistence = { xmp: false, sidecar: false };

  await modal(async (executionContext) => {
    const report = makeReporter(executionContext, hooks.onProgress);

    // 0. The panel may have been previewing a different layer (the user can
    //    change the selection between Load and Apply). Re-read rather than
    //    silently rendering the wrong pixels.
    if (engine.sourceLayerId !== ctx.targetLayer.id) {
      const image = await IM.readLayerPixels({
        documentID: d.id,
        layerID: ctx.targetLayer.id,
        bounds,
      });
      engine.setSource(image);
      engine.sourceLayerId = ctx.targetLayer.id;
    }
    report(0.05);

    // 1. Seal the original inside a Smart Object. Nothing destructive happens
    //    to it from here on.
    await L.selectLayers([ctx.targetLayer.id]);
    const so = await L.convertToSmartObject();
    await L.renameLayer(so.id, META.SOURCE_LAYER_NAME);

    // 2. Wrap it in a group that carries the render id.
    const group = await L.groupLayers(META.groupName(renderId), [so]);

    // 3. Add the render layer above the source, inside the group.
    await L.selectLayers([so.id]);
    const renderLayer = await L.createPixelLayer(META.RENDER_LAYER_NAME);
    await L.setVisible(so.id, false);

    // 4. Rasterise. The cells are already measured from the preview, so this is
    //    a pure rasterisation pass even on a very large document.
    report(0.1);
    const out = await engine.renderAsync(params, {
      width,
      height,
      onProgress: (t) => report(0.1 + t * 0.75),
    });
    if (!out) throw new Error("Render was cancelled.");

    report(0.9);
    await IM.writeLayerPixels({
      documentID: d.id,
      layerID: renderLayer.id,
      data: out.data,
      width,
      height,
      targetBounds: bounds,
    });

    // 5. Remember how we got here.
    const record = META.makeRecord(renderId, params, {
      docName: d.name,
      bounds,
      sourceLayerName: META.SOURCE_LAYER_NAME,
    });
    persistence = await META.saveRecord([group.id, renderLayer.id], record);

    await L.selectLayers([group.id]);
    report(1);
  }, "Apply Halftone");

  return { renderId, persistence, width, height };
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
  if (!ctx.renderLayer) {
    throw new Error(`This group has no "${META.RENDER_LAYER_NAME}" layer to write into.`);
  }

  const d = app().activeDocument;
  const bounds = layerBounds(ctx.sourceLayer, d);
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const renderId = ctx.renderId || META.newRenderId();
  let persistence = { xmp: false, sidecar: false };

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

    const out = await engine.renderAsync(params, {
      width,
      height,
      onProgress: (t) => report(0.15 + t * 0.7),
    });
    if (!out) throw new Error("Render was cancelled.");

    report(0.9);
    // Writing into the existing layer (rather than replacing it) preserves any
    // mask, opacity or blend mode the user has set on the render.
    await IM.writeLayerPixels({
      documentID: d.id,
      layerID: ctx.renderLayer.id,
      data: out.data,
      width,
      height,
      targetBounds: bounds,
    });

    if (ctx.group && META.renderIdFromName(ctx.group.name) !== renderId) {
      await L.renameLayer(ctx.group.id, META.groupName(renderId));
    }
    const record = META.makeRecord(renderId, params, { docName: d.name, bounds });
    persistence = await META.saveRecord([ctx.group.id, ctx.renderLayer.id], record);
    report(1);
  }, "Update Halftone");

  return { renderId, persistence, width, height, updated: true };
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
  if (ctx.renderLayer) layerIds.push(ctx.renderLayer.id);
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
  applyNew,
  updateExisting,
  recallParams,
  layerBounds,
};
