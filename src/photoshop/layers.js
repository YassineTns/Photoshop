"use strict";

/**
 * Layer operations.
 *
 * Every operation prefers the documented UXP DOM API and falls back to a
 * batchPlay descriptor only where the DOM has no equivalent (Smart Object
 * conversion) or where the DOM method is not present in the running version.
 * Each fallback is annotated so it is obvious what is guaranteed and what is
 * best effort.
 *
 * All of these must be called from inside core.executeAsModal.
 */

const { app, batchPlay } = require("./host.js");
const { toLayerInfo } = require("./document.js");

/**
 * Select exactly these layers.
 * @param {number[]} ids
 */
async function selectLayers(ids) {
  if (!ids || !ids.length) return;
  await batchPlay(
    [
      {
        _obj: "select",
        _target: ids.map((id) => ({ _ref: "layer", _id: id })),
        makeVisible: false,
      },
    ],
    {}
  );
}

/**
 * Convert the currently selected layer(s) into a single Smart Object.
 *
 * There is no DOM equivalent for this; `newPlacedLayer` is the descriptor
 * Photoshop itself records for Layer > Smart Objects > Convert to Smart Object.
 * The original pixels are preserved inside the Smart Object, which is what
 * makes the whole workflow non-destructive.
 *
 * @returns {Promise<object>} the resulting Smart Object layer (DOM)
 */
async function convertToSmartObject() {
  await batchPlay([{ _obj: "newPlacedLayer" }], {});
  return app().activeDocument.activeLayers[0];
}

/** @returns {boolean} */
function isSmartObject(domLayer) {
  return String(domLayer && domLayer.kind) === "smartObject";
}

/**
 * Create a group containing the given layers.
 * @param {string} name
 * @param {object[]} domLayers
 * @returns {Promise<object>} the group layer (DOM)
 */
async function groupLayers(name, domLayers) {
  const doc = app().activeDocument;
  if (typeof doc.createLayerGroup === "function") {
    try {
      return await doc.createLayerGroup({ name, fromLayers: domLayers });
    } catch (e) {
      // fall through to the descriptor
    }
  }
  // Fallback: "Group from Layers" on the current selection.
  await selectLayers(domLayers.map((l) => l.id));
  await batchPlay(
    [
      {
        _obj: "make",
        _target: [{ _ref: "layerSection" }],
        from: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
      },
    ],
    {}
  );
  const group = app().activeDocument.activeLayers[0];
  if (group && name) await renameLayer(group.id, name);
  return app().activeDocument.activeLayers[0];
}

/**
 * Create an empty pixel layer directly above the currently selected layer.
 * @param {string} name
 * @returns {Promise<object>} the new layer (DOM)
 */
async function createPixelLayer(name) {
  const doc = app().activeDocument;
  if (typeof doc.createLayer === "function") {
    try {
      const l = await doc.createLayer({ name });
      if (l) return l;
    } catch (e) {
      // fall through
    }
  }
  await batchPlay(
    [{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name: name } }],
    {}
  );
  return app().activeDocument.activeLayers[0];
}

async function renameLayer(id, name) {
  await batchPlay(
    [{ _obj: "set", _target: [{ _ref: "layer", _id: id }], to: { _obj: "layer", name: name } }],
    {}
  );
}

async function setVisible(id, visible) {
  await batchPlay(
    [
      {
        _obj: visible ? "show" : "hide",
        null: [{ _ref: "layer", _id: id }],
      },
    ],
    {}
  );
}

async function deleteLayer(id) {
  await batchPlay([{ _obj: "delete", _target: [{ _ref: "layer", _id: id }] }], {});
}

/**
 * Create a solid-colour fill layer above the current selection.
 *
 * `contentLayer` + `solidColorLayer` is the descriptor Photoshop records for
 * Layer > New Fill Layer > Solid Color. Note the RGB descriptor spells green as
 * `grain`; that is a genuine historical quirk of the Action Manager, not a typo.
 *
 * Fill layers are what make the separated output worth having: they stay
 * editable (double-click to change the ink), they resample cleanly, and each one
 * carries its own mask.
 *
 * @param {string} name
 * @param {number[]} rgb 0..255
 * @returns {Promise<object>} the new layer (DOM)
 */
async function createSolidFillLayer(name, rgb) {
  await batchPlay(
    [
      {
        _obj: "make",
        _target: [{ _ref: "contentLayer" }],
        using: {
          _obj: "contentLayer",
          name: name,
          type: {
            _obj: "solidColorLayer",
            color: {
              _obj: "RGBColor",
              red: rgb[0],
              grain: rgb[1],
              blue: rgb[2],
            },
          },
        },
      },
    ],
    {}
  );
  const layer = app().activeDocument.activeLayers[0];
  if (layer && name && layer.name !== name) await renameLayer(layer.id, name);
  return app().activeDocument.activeLayers[0];
}

/**
 * Add a layer mask to the given layer.
 * @param {number} layerId
 * @param {"revealAll"|"hideAll"} kind
 */
async function addLayerMask(layerId, kind = "revealAll") {
  await selectLayers([layerId]);
  await batchPlay(
    [
      {
        _obj: "make",
        new: { _class: "channel" },
        at: { _ref: "channel", _enum: "channel", _value: "mask" },
        using: { _enum: "userMaskEnabled", _value: kind },
      },
    ],
    {}
  );
}

/** Find a direct child of a group by name. @returns {object|null} DOM layer */
function childByName(group, name) {
  if (!group || !group.layers) return null;
  for (const l of group.layers) if (l.name === name) return l;
  return null;
}

/** Find a direct child of a group whose name starts with `prefix`. */
function childByPrefix(group, prefix) {
  if (!group || !group.layers) return null;
  for (const l of group.layers) if (String(l.name).indexOf(prefix) === 0) return l;
  return null;
}

module.exports = {
  selectLayers,
  convertToSmartObject,
  isSmartObject,
  groupLayers,
  createPixelLayer,
  createSolidFillLayer,
  addLayerMask,
  renameLayer,
  setVisible,
  deleteLayer,
  childByName,
  childByPrefix,
  toLayerInfo,
};
