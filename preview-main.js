"use strict";

/**
 * Entry point for the detached preview panel.
 *
 * At the plugin root for the same reason main.js is: UXP evaluates a script
 * loaded through `<script src=...>` with the *document* as its parent module, so
 * a relative require inside it resolves against the plugin root. See the note in
 * main.js.
 */

function showFatal(message) {
  const empty = document.getElementById("detached-empty");
  if (empty) {
    empty.className = "detached-empty";
    empty.textContent = "Preview panel failed to start: " + message;
  }
  console.error("[Halftone Preview]", message);
}

function boot() {
  try {
    const { PreviewPanel } = require("./src/ui/previewpanel.js");
    const panel = new PreviewPanel(document);
    window.halftonePreviewPanel = panel;
    panel.init();
  } catch (e) {
    showFatal(e && e.message ? e.message : String(e));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
