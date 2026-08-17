"use strict";

/**
 * Entry point.
 *
 * This file lives at the plugin root, next to index.html, and NOT in src/ with
 * everything else. That is deliberate: UXP evaluates a script loaded through
 * `<script src=...>` with the *document* as its parent module, so a relative
 * require inside it resolves against the plugin root rather than against the
 * script's own folder. With main.js in src/, `require("./ui/panel.js")` was
 * looked up as `./ui/panel.js` from the root and the panel failed to start with
 * "Module not found". Keeping the entry point at the root makes that resolution
 * correct instead of merely working by accident. Nested requires between modules
 * under src/ resolve normally, so nothing else needs to change.
 *
 * Kept thin on purpose otherwise: it wires the panel up and makes sure a failure
 * during start-up shows the user something readable instead of an empty panel.
 */

function showFatal(message) {
  const notice = document.getElementById("notice");
  const statusText = document.getElementById("status-text");
  const statusDot = document.getElementById("status-dot");
  if (statusText) statusText.textContent = "Failed to start";
  if (statusDot) statusDot.className = "status-dot error";
  if (notice) {
    notice.textContent = message;
    notice.className = "notice show error";
  }
  // Also log it: the UXP Developer Tool console is where a developer will look.
  console.error("[Halftone Studio]", message);
}

function boot() {
  try {
    const { Panel } = require("./src/ui/panel.js");
    const panel = new Panel(document);
    // Expose it for debugging from the UXP Developer Tool console.
    window.halftonePanel = panel;
    panel.init().catch((e) => showFatal(e && e.message ? e.message : String(e)));
  } catch (e) {
    showFatal(e && e.message ? e.message : String(e));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
