"use strict";

/**
 * The detached preview panel.
 *
 * A second entrypoint whose entire job is to show the frame the controls panel
 * is producing, as large as its own window allows. Float it, drag it to a second
 * monitor, size it to taste - the docked panel keeps the sliders, this keeps the
 * picture.
 *
 * It deliberately owns no state and drives no rendering. Everything arrives
 * through the frame bus already rendered, which means it cannot disagree with
 * the docked preview and cannot cost anything on a slider drag beyond setting
 * one `src`.
 *
 * The size it displays at is its own: the docked panel renders at its own width,
 * so on a wide float this image is being scaled up by the layer engine rather
 * than re-rendered. `requestSize` tells the controls panel how big this window
 * is so it can render for the larger of the two instead - which is what makes
 * the detached view genuinely sharper rather than merely bigger.
 */

const BUS = require("./framebus.js");

/** Never ask the controls panel for more than this on the long edge. */
const MAX_REQUEST = 1600;

class PreviewPanel {
  constructor(root) {
    this.root = root || document;
    this._unsubscribe = null;
    this._resizeTimer = null;
  }

  init() {
    this.$ = (id) => this.root.getElementById(id);
    BUS.setAttached(true);

    this._unsubscribe = BUS.subscribe((frame) => this.show(frame));
    if (!BUS.latest()) this.waiting();

    // Ask for a render matched to this window whenever it changes size, so a
    // large float shows a large render rather than a magnified small one.
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("resize", () => this.onResize());
    }
    this.onResize();
  }

  dispose() {
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
    BUS.setAttached(false);
  }

  onResize() {
    // Debounced: a drag-resize fires continuously, and each request makes the
    // controls panel re-rasterise.
    if (this._resizeTimer) clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => {
      this._resizeTimer = null;
      const wrap = this.$("detached-wrap");
      if (!wrap) return;
      const w = Math.min(MAX_REQUEST, Math.max(120, wrap.clientWidth || 0));
      const h = Math.min(MAX_REQUEST, Math.max(120, wrap.clientHeight || 0));
      BUS.requestSize({ width: w, height: h });
    }, 120);
  }

  waiting() {
    const empty = this.$("detached-empty");
    const img = this.$("detached-img");
    if (img) img.className = "detached-img";
    if (empty) {
      empty.className = "detached-empty";
      empty.textContent =
        "Waiting for Halftone Studio. Open that panel, select a layer and press Load Layer.";
    }
  }

  /** @param {{url:string,width:number,height:number,badge:string}|null} frame */
  show(frame) {
    if (!frame || !frame.url) {
      this.waiting();
      return;
    }
    const img = this.$("detached-img");
    const empty = this.$("detached-empty");
    const badge = this.$("detached-badge");
    if (img) {
      img.src = frame.url;
      img.className = "detached-img visible";
    }
    if (empty) empty.className = "detached-empty hidden";
    if (badge) {
      badge.textContent = frame.badge || "";
      badge.className = "preview-badge" + (frame.badge ? " show" : "");
    }
  }
}

module.exports = { PreviewPanel };
