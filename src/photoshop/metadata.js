"use strict";

/**
 * Persisting a render's parameters so it can be re-edited later.
 *
 * WHAT UXP ACTUALLY OFFERS
 * ------------------------
 * Photoshop has no public API for registering a plugin as a real Smart Filter,
 * and UXP exposes no "custom data" bag on a layer. So there is no single
 * blessed place to put this. Rather than pick one and hope, the plugin writes
 * the same record to three places and reads them back in order of reliability:
 *
 *   1. Layer XMP  - `metadata`/`layerXMP` through batchPlay. This travels with
 *      the layer inside the .psd, survives duplication and reopening, and is
 *      the only one of the three that is genuinely attached to the layer. It is
 *      an Action Manager property rather than a documented UXP surface, so
 *      every write is verified by reading it straight back; if the readback
 *      does not match, the plugin quietly downgrades to (2) and says so.
 *
 *   2. A sidecar JSON file in the plugin's own data folder, keyed by render id.
 *      Always written, so it works even when (1) is unavailable. It does not
 *      travel with the .psd to another machine.
 *
 *   3. The render id in the group's layer name (`Halftone ▸ HT-xxxxxx`). This
 *      is the locator that ties a selected layer back to records (1) and (2),
 *      and it is the one thing a user can see and must not rename.
 *
 * Renaming the group breaks (3) but not (1): a render whose XMP survived can
 * still be recovered from the layer itself.
 */

const { batchPlay, uxp } = require("./host.js");
const { encodeString, decodeString } = require("../util/base64.js");
const { sanitizeParams, SCHEMA_VERSION } = require("../state/params.js");

const NS = "http://yassinetns.dev/ns/halftone/1.0/";
const NS_PREFIX = "hts";
const SIDECAR_FILE = "halftone-renders.json";
const PRESETS_FILE = "halftone-presets.json";
const SESSION_FILE = "halftone-session.json";

/** Layer name marker. U+25B8 keeps it visually distinct in the layers panel. */
const GROUP_PREFIX = "Halftone ▸ ";
const RENDER_LAYER_NAME = "Halftone Render";
const SOURCE_LAYER_NAME = "Halftone Source";

/** @returns {string} e.g. "HT-4f2a9c" */
function newRenderId() {
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `HT-${r()}${r()}`;
}

function groupName(renderId) {
  return GROUP_PREFIX + renderId;
}

/** @returns {string|null} the render id encoded in a layer name */
function renderIdFromName(name) {
  const m = /HT-[0-9a-f]{8}/i.exec(String(name || ""));
  return m ? m[0] : null;
}

function isHalftoneGroupName(name) {
  return String(name || "").indexOf(GROUP_PREFIX) === 0;
}

/* ------------------------------------------------------------------ *
 * 1. Layer XMP
 * ------------------------------------------------------------------ */

function buildXMP(record) {
  const payload = encodeString(JSON.stringify(record));
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:${NS_PREFIX}="${NS}" ` +
    `${NS_PREFIX}:renderId="${record.renderId}" ${NS_PREFIX}:version="${record.version}" ` +
    `${NS_PREFIX}:payload="${payload}"/>` +
    "</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
  );
}

function parseXMP(xmp) {
  if (!xmp || typeof xmp !== "string") return null;
  const m = new RegExp(`${NS_PREFIX}:payload="([^"]*)"`).exec(xmp);
  if (!m) return null;
  try {
    return JSON.parse(decodeString(m[1]));
  } catch (e) {
    return null;
  }
}

/**
 * @param {number} layerId
 * @returns {Promise<object|null>}
 */
async function readLayerXMP(layerId) {
  try {
    const res = await batchPlay(
      [{ _obj: "get", _target: [{ _property: "metadata" }, { _ref: "layer", _id: layerId }] }],
      {}
    );
    const meta = res && res[0] && res[0].metadata;
    return parseXMP(meta && meta.layerXMP);
  } catch (e) {
    return null;
  }
}

/**
 * @returns {Promise<boolean>} true only if the write was verified by readback
 */
async function writeLayerXMP(layerId, record) {
  try {
    await batchPlay(
      [
        {
          _obj: "set",
          _target: [{ _property: "metadata" }, { _ref: "layer", _id: layerId }],
          to: { _obj: "metadata", layerXMP: buildXMP(record) },
        },
      ],
      {}
    );
  } catch (e) {
    return false;
  }
  const back = await readLayerXMP(layerId);
  return !!(back && back.renderId === record.renderId);
}

/* ------------------------------------------------------------------ *
 * 2. Sidecar file
 * ------------------------------------------------------------------ */

async function dataFolder() {
  const u = uxp();
  if (!u || !u.storage || !u.storage.localFileSystem) return null;
  try {
    return await u.storage.localFileSystem.getDataFolder();
  } catch (e) {
    return null;
  }
}

async function readJSONFile(name, fallback) {
  const folder = await dataFolder();
  if (!folder) return fallback;
  try {
    const entry = await folder.getEntry(name);
    const text = await entry.read();
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

async function writeJSONFile(name, value) {
  const folder = await dataFolder();
  if (!folder) return false;
  try {
    const file = await folder.createFile(name, { overwrite: true });
    await file.write(JSON.stringify(value, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

async function readSidecar(renderId) {
  const all = await readJSONFile(SIDECAR_FILE, {});
  return all && all[renderId] ? all[renderId] : null;
}

async function writeSidecar(record) {
  const all = await readJSONFile(SIDECAR_FILE, {});
  all[record.renderId] = record;
  // Keep the store from growing without bound.
  const keys = Object.keys(all);
  if (keys.length > 400) {
    keys
      .sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0))
      .slice(0, keys.length - 400)
      .forEach((k) => delete all[k]);
  }
  return writeJSONFile(SIDECAR_FILE, all);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @param {string} renderId
 * @param {object} params
 * @param {object} [extra] e.g. {sourceLayerId, docName}
 */
function makeRecord(renderId, params, extra) {
  return Object.assign(
    {
      renderId,
      version: SCHEMA_VERSION,
      updatedAt: Date.now(),
      params: sanitizeParams(params),
    },
    extra || {}
  );
}

/**
 * Persist a record. Never throws: persistence failing must not lose the user's
 * render, so the result reports which channels actually took.
 *
 * @returns {Promise<{xmp: boolean, sidecar: boolean}>}
 */
async function saveRecord(layerIds, record) {
  const ids = Array.isArray(layerIds) ? layerIds : [layerIds];
  let xmp = false;
  for (const id of ids) {
    if (id === undefined || id === null) continue;
    // eslint-disable-next-line no-await-in-loop
    const okOne = await writeLayerXMP(id, record);
    xmp = xmp || okOne;
  }
  const sidecar = await writeSidecar(record);
  return { xmp, sidecar };
}

/**
 * Recover a record, most reliable source first.
 * @param {{renderId: string|null, layerIds: number[]}} locator
 * @returns {Promise<{record: object, source: string}|null>}
 */
async function loadRecord(locator) {
  for (const id of locator.layerIds || []) {
    // eslint-disable-next-line no-await-in-loop
    const fromXMP = await readLayerXMP(id);
    if (fromXMP && fromXMP.params) return { record: fromXMP, source: "layer XMP" };
  }
  if (locator.renderId) {
    const fromFile = await readSidecar(locator.renderId);
    if (fromFile && fromFile.params) return { record: fromFile, source: "plugin data folder" };
  }
  return null;
}

/* ---- user presets + last session, same storage, simpler shape ---- */

async function loadUserPresets() {
  const list = await readJSONFile(PRESETS_FILE, []);
  return Array.isArray(list) ? list : [];
}

async function saveUserPresets(list) {
  return writeJSONFile(PRESETS_FILE, list);
}

async function loadSession() {
  return readJSONFile(SESSION_FILE, null);
}

/**
 * @param {object} params render parameters
 * @param {object} [ui] window state (preview height and the like), stored
 *        alongside but deliberately not part of the parameter schema
 */
async function saveSession(params, ui) {
  return writeJSONFile(SESSION_FILE, {
    version: SCHEMA_VERSION,
    params: sanitizeParams(params),
    ui: ui || undefined,
  });
}

module.exports = {
  NS,
  GROUP_PREFIX,
  RENDER_LAYER_NAME,
  SOURCE_LAYER_NAME,
  newRenderId,
  groupName,
  renderIdFromName,
  isHalftoneGroupName,
  makeRecord,
  saveRecord,
  loadRecord,
  readLayerXMP,
  writeLayerXMP,
  buildXMP,
  parseXMP,
  loadUserPresets,
  saveUserPresets,
  loadSession,
  saveSession,
};
