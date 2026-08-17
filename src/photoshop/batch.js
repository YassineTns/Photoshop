"use strict";

/**
 * Batch rendering: apply the same settings to many layers in one pass.
 *
 * Everything happens inside a single modal scope, so the whole batch is one undo
 * step rather than N of them, and one cancel abandons the lot cleanly.
 *
 * The subtlety worth knowing about is palette handling. With the palette
 * unlocked, every layer extracts its own - which is right for unrelated images
 * and wrong for a sequence, where each frame would land on a slightly different
 * set of colours and the result would crawl. `sharedPalette` extracts once from
 * the first layer and pins it for the rest, which is what makes a batch look
 * like one job instead of N jobs.
 */

const { app, modal } = require("./host.js");
const L = require("./layers.js");
const META = require("./metadata.js");
const IM = require("./imaging.js");
const RENDER = require("./render.js");

/**
 * @typedef {object} BatchTarget
 * @property {object} layer DOM layer
 * @property {string} name
 */

/**
 * Work out which layers a batch scope refers to.
 *
 * Layers that are already halftone output are skipped in every scope: running a
 * batch twice should be a no-op on what it already produced, not a halftone of
 * a halftone.
 *
 * @param {string} scope "selection" | "group" | "document"
 * @returns {{targets: BatchTarget[], message: string}}
 */
function collectTargets(scope) {
  const d = app().activeDocument;
  if (!d) return { targets: [], message: "Open a document first." };

  const eligible = (l) => {
    if (!l) return false;
    if (String(l.kind) === "group") return false;
    if (META.isHalftoneGroupName(l.name)) return false;
    if (l.name === META.SOURCE_LAYER_NAME || l.name === META.RENDER_LAYER_NAME) return false;
    // Adjustment and fill layers have no pixels of their own worth screening.
    const kind = String(l.kind);
    if (kind === "solidColor" || kind === "gradient" || kind === "pattern") return false;
    if (kind.indexOf("Adjustment") >= 0 || kind === "adjustment") return false;
    return true;
  };

  const insideHalftone = (l) => {
    let cur = l.parent;
    let guard = 32;
    while (cur && cur.name !== undefined && guard-- > 0) {
      if (META.isHalftoneGroupName(cur.name)) return true;
      cur = cur.parent;
    }
    return false;
  };

  let candidates = [];
  let message = "";

  if (scope === "selection") {
    candidates = (d.activeLayers || []).slice();
    if (!candidates.length) message = "Select one or more layers to batch.";
  } else if (scope === "group") {
    const sel = (d.activeLayers || [])[0];
    const group =
      sel && String(sel.kind) === "group"
        ? sel
        : sel && sel.parent && String(sel.parent.kind) === "group"
          ? sel.parent
          : null;
    if (!group) {
      message = "Select a group (or a layer inside one) to batch its contents.";
    } else {
      candidates = flatten(group.layers || []);
    }
  } else {
    candidates = flatten(d.layers || []);
  }

  const targets = candidates
    .filter((l) => eligible(l) && !insideHalftone(l))
    .map((l) => ({ layer: l, name: l.name }));

  if (!targets.length && !message) {
    message = "Nothing to batch: no eligible pixel layers found in this scope.";
  }
  return { targets, message };
}

function flatten(layers, out = []) {
  for (const l of layers) {
    if (l.layers && l.layers.length) {
      // Do not descend into halftone groups; their contents are our own output.
      if (!META.isHalftoneGroupName(l.name)) flatten(l.layers, out);
    } else {
      out.push(l);
    }
  }
  return out;
}

/**
 * Run a batch.
 *
 * @param {import("../engine/pipeline.js").HalftoneEngine} engine
 * @param {object} params
 * @param {object} opts
 * @param {string} opts.scope
 * @param {boolean} [opts.sharedPalette]
 * @param {(done:number, total:number, name:string)=>void} [opts.onItem]
 * @param {(t:number)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldCancel]
 * @returns {Promise<{done: number, total: number, failures: {name:string, error:string}[],
 *                    renderIds: string[], cancelled: boolean, palette: string[]|null}>}
 */
async function runBatch(engine, params, opts) {
  const { targets, message } = collectTargets(opts.scope);
  if (!targets.length) throw new Error(message);

  const d = app().activeDocument;
  const onItem = opts.onItem || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const shouldCancel = opts.shouldCancel || (() => false);

  const failures = [];
  const renderIds = [];
  let done = 0;
  let cancelled = false;
  let batchParams = params;
  let sharedPalette = null;

  await modal(async (executionContext) => {
    const total = targets.length;

    for (let i = 0; i < total; i++) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      const target = targets[i];
      onItem(i, total, target.name);

      // Scale each layer's own progress into the batch's overall progress.
      const base = i / total;
      const span = 1 / total;
      const report = (t) => {
        const v = base + t * span;
        onProgress(v);
        if (executionContext && typeof executionContext.reportProgress === "function") {
          try {
            executionContext.reportProgress({ value: v });
          } catch (e) {
            /* progress is cosmetic */
          }
        }
      };

      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await RENDER.buildRenderFor(engine, batchParams, target.layer, d, report);
        renderIds.push(res.renderId);
        done++;

        // After the first item, pin the palette so the whole batch shares one
        // set of colours instead of drifting layer to layer.
        if (opts.sharedPalette && !sharedPalette) {
          sharedPalette = engine.extractPaletteHex(batchParams);
          batchParams = Object.assign({}, batchParams, {
            palette: sharedPalette,
            paletteLocked: true,
          });
        }
      } catch (e) {
        // One bad layer must not abandon the rest of the batch.
        failures.push({ name: target.name, error: e && e.message ? e.message : String(e) });
      }
    }
    onProgress(1);
  }, `Halftone batch (${targets.length} layers)`);

  return {
    done,
    total: targets.length,
    failures,
    renderIds,
    cancelled,
    palette: sharedPalette,
  };
}

/** Count what a batch would touch, without touching it. */
function previewBatch(scope) {
  const { targets, message } = collectTargets(scope);
  return { count: targets.length, names: targets.map((t) => t.name), message };
}

module.exports = { collectTargets, runBatch, previewBatch };
