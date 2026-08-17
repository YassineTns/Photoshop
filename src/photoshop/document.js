"use strict";

/**
 * Document and selection queries. Read-only: nothing here mutates the document.
 */

const { app, batchPlay } = require("./host.js");

/**
 * @typedef {object} DocInfo
 * @property {number} id
 * @property {string} name
 * @property {number} width  pixels
 * @property {number} height pixels
 * @property {string} mode   e.g. "RGBColorMode"
 */

/** @returns {DocInfo|null} */
function activeDocument() {
  const a = app();
  const doc = a.activeDocument;
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    mode: String(doc.mode || ""),
    raw: doc,
  };
}

/**
 * @typedef {object} LayerInfo
 * @property {number} id
 * @property {string} name
 * @property {string} kind
 * @property {boolean} visible
 * @property {object} raw the DOM layer
 */

/** The layers the user currently has selected. @returns {LayerInfo[]} */
function selectedLayers() {
  const doc = app().activeDocument;
  if (!doc) return [];
  const sel = doc.activeLayers || [];
  return sel.map(toLayerInfo);
}

function toLayerInfo(l) {
  return {
    id: l.id,
    name: l.name,
    kind: String(l.kind || ""),
    visible: l.visible,
    raw: l,
  };
}

/** Flatten the whole layer tree into a list. @returns {LayerInfo[]} */
function allLayers() {
  const doc = app().activeDocument;
  if (!doc) return [];
  const out = [];
  const walk = (layers) => {
    for (const l of layers || []) {
      out.push(toLayerInfo(l));
      if (l.layers && l.layers.length) walk(l.layers);
    }
  };
  walk(doc.layers);
  return out;
}

/** @returns {LayerInfo|null} */
function findLayerById(id) {
  return allLayers().find((l) => l.id === id) || null;
}

/**
 * Walk up from a layer to its enclosing group chain.
 * @param {object} domLayer
 * @returns {object[]} outermost last
 */
function ancestors(domLayer) {
  const out = [];
  let cur = domLayer && domLayer.parent;
  // `parent` is the Document at the top of the chain; stop there. The depth
  // guard is paranoia against a malformed tree looping forever.
  let guard = 64;
  while (cur && cur.id !== undefined && cur.kind !== undefined && guard-- > 0) {
    out.push(cur);
    cur = cur.parent;
  }
  return out;
}

/**
 * The document's colour mode, read through batchPlay because the DOM property
 * is not consistently populated across versions.
 * @returns {Promise<string>}
 */
async function colorMode() {
  try {
    const res = await batchPlay(
      [
        {
          _obj: "get",
          _target: [{ _property: "mode" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
        },
      ],
      {}
    );
    const m = res && res[0] && res[0].mode;
    return m && m._value ? String(m._value) : "";
  } catch (e) {
    return "";
  }
}

module.exports = {
  activeDocument,
  selectedLayers,
  allLayers,
  findLayerById,
  ancestors,
  colorMode,
  toLayerInfo,
};
