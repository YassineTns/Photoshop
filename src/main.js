"use strict";

/**
 * Entry point. Kept thin on purpose: it wires the panel up and makes sure a
 * failure during start-up shows the user something readable instead of leaving
 * an empty panel.
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
    const { Panel } = require("./ui/panel.js");
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
