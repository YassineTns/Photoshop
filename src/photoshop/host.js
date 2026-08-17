"use strict";

/**
 * Single point of contact with the Photoshop host.
 *
 * Everything that touches the `photoshop` module goes through here so that:
 *  - the engine and the UI stay testable outside Photoshop;
 *  - optional APIs are feature detected once instead of being assumed.
 *
 * Nothing in this file invents an API. Where a capability is uncertain it is
 * probed at runtime and the caller is told what is actually available.
 */

let _ps = null;
let _uxp = null;

function ps() {
  if (_ps) return _ps;
  try {
    // eslint-disable-next-line global-require
    _ps = require("photoshop");
  } catch (e) {
    throw new Error("This plugin must run inside Photoshop (the 'photoshop' module is unavailable).");
  }
  return _ps;
}

function uxp() {
  if (_uxp) return _uxp;
  try {
    // eslint-disable-next-line global-require
    _uxp = require("uxp");
  } catch (e) {
    _uxp = null;
  }
  return _uxp;
}

function app() {
  return ps().app;
}

function action() {
  return ps().action;
}

function core() {
  return ps().core;
}

function imaging() {
  const m = ps().imaging;
  if (!m) {
    throw new Error(
      "The Photoshop imaging API is unavailable. It requires Photoshop 23.3 or newer; " +
        "this plugin needs it to read and write pixels."
    );
  }
  return m;
}

/**
 * Run `fn` inside a modal execution scope. All document mutation and all
 * pixel I/O has to happen inside one of these.
 *
 * @param {(ctx: object) => Promise<any>} fn
 * @param {string} commandName shown in Photoshop's history / progress UI
 */
async function modal(fn, commandName) {
  return core().executeAsModal(fn, { commandName: commandName || "Halftone Studio" });
}

/**
 * @param {object[]} descriptors
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
async function batchPlay(descriptors, options) {
  return action().batchPlay(descriptors, Object.assign({ synchronousExecution: false }, options));
}

/**
 * Probe the host once and report what is actually available. Used to fail with
 * an accurate message rather than a stack trace, and to pick the metadata
 * strategy.
 */
let _caps = null;
function capabilities() {
  if (_caps) return _caps;
  const c = {
    photoshop: false,
    imaging: false,
    getPixels: false,
    putPixels: false,
    createImageDataFromBuffer: false,
    localFileSystem: false,
    version: null,
  };
  try {
    const p = ps();
    c.photoshop = true;
    c.version = p.app && p.app.version ? String(p.app.version) : null;
    const im = p.imaging;
    if (im) {
      c.imaging = true;
      c.getPixels = typeof im.getPixels === "function";
      c.putPixels = typeof im.putPixels === "function";
      c.createImageDataFromBuffer = typeof im.createImageDataFromBuffer === "function";
    }
  } catch (e) {
    /* not in Photoshop */
  }
  try {
    const u = uxp();
    c.localFileSystem = !!(u && u.storage && u.storage.localFileSystem);
  } catch (e) {
    /* no file system permission */
  }
  _caps = c;
  return c;
}

/** Human readable summary of anything missing that the plugin needs. */
function missingCapabilities() {
  const c = capabilities();
  const missing = [];
  if (!c.photoshop) missing.push("Photoshop host API");
  if (!c.getPixels) missing.push("imaging.getPixels");
  if (!c.putPixels) missing.push("imaging.putPixels");
  if (!c.createImageDataFromBuffer) missing.push("imaging.createImageDataFromBuffer");
  return missing;
}

module.exports = {
  ps,
  uxp,
  app,
  action,
  core,
  imaging,
  modal,
  batchPlay,
  capabilities,
  missingCapabilities,
};
