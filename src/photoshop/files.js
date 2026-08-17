"use strict";

/**
 * Saving generated text (currently SVG) to disk.
 *
 * UXP has no `download` and no direct filesystem path access: a plugin can only
 * write where the user has pointed a file picker, which is what
 * `localFileSystem.getFileForSaving` provides. That is the whole reason this is
 * a Photoshop-layer module rather than something the engine does itself - the
 * engine produces a string, and this decides where it lands.
 */

const { uxp } = require("./host.js");

function fs() {
  const u = uxp();
  if (!u || !u.storage || !u.storage.localFileSystem) {
    throw new Error("File access is unavailable; check the plugin's localFileSystem permission.");
  }
  return u.storage.localFileSystem;
}

/**
 * Ask the user where to put a text file and write it there.
 *
 * @param {string} defaultName suggested file name, extension included
 * @param {string} text
 * @param {string} ext used to filter the save dialog
 * @returns {Promise<string|null>} the file name, or null if the user cancelled
 */
async function saveText(defaultName, text, ext) {
  const file = await fs().getFileForSaving(defaultName, ext ? { types: [ext] } : undefined);
  if (!file) return null;
  // utf8 is the default format for a string write, but naming it means a host
  // build that defaults to binary does not silently mangle the file.
  await file.write(text, { format: uxp().storage.formats.utf8 });
  return file.name;
}

/**
 * A file name that is safe on every platform and still recognisable.
 * @param {string} base
 * @param {string} ext without the dot
 */
function safeName(base, ext) {
  const cleaned = String(base || "halftone")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${cleaned || "halftone"}.${ext}`;
}

module.exports = { saveText, safeName };
