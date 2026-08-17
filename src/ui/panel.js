"use strict";

/**
 * Panel controller: owns the parameter state, drives the engine for previews,
 * and calls into the Photoshop layer for Apply / Update.
 *
 * Preview strategy
 * ----------------
 * The engine measures halftone cells once from a downscaled analysis image and
 * caches them, so previewing is a pure rasterisation at panel size - a few
 * milliseconds regardless of whether the document is 1080px or 6000px. Previews
 * are therefore rendered synchronously on a requestAnimationFrame tick while a
 * slider is being dragged, and only fall back to a 90ms debounce if a frame
 * actually overruns. Apply and Update rasterise at full document resolution
 * from the very same cells, which is what guarantees the preview is honest.
 */

const C = require("./controls.js");
const {
  PARAM_DEFS,
  SECTIONS,
  DEF_BY_KEY,
  defaultParams,
  sanitizeParams,
  isVisible,
  sectionVisible,
} = require("../state/params.js");
const { ALGORITHMS, ALGORITHM_FAMILIES } = require("../engine/dither.js");
const { BUILTIN_PRESETS, presetToParams, makeUserPreset } = require("../presets/presets.js");
const { HalftoneEngine } = require("../engine/pipeline.js");
const { toDataURL } = require("../util/png.js");
const { downscaleBox: downscale } = require("../engine/resample.js");
const HOST = require("../photoshop/host.js");
const RENDER = require("../photoshop/render.js");
const META = require("../photoshop/metadata.js");
const IM = require("../photoshop/imaging.js");
const BATCH = require("../photoshop/batch.js");
const SWATCH = require("../photoshop/swatches.js");
const FILES = require("../photoshop/files.js");

const PREVIEW_MAX = 460;
/** Cap on the dither grid used for previews; above this the preview approximates. */
const PREVIEW_DITHER_GRID = 700;
const SLOW_FRAME_MS = 45;
const DEBOUNCE_MS = 90;

class Panel {
  constructor(root) {
    this.root = root || document;
    this.engine = new HalftoneEngine();
    this.params = defaultParams();
    this.controls = {};
    this.userPresets = [];
    this.activePresetId = null;
    this.sourceInfo = null;
    this.lastFrameMs = 0;
    this._timer = null;
    this._raf = null;
    this._busy = false;
    this._selectionTimer = null;
    this.sectionOpen = {};
    this._sourceURL = null;
    this._renderedSrc = null;
    this._cancelBatch = false;
  }

  /* ---------------------------------------------------------------- */

  async init() {
    this.$ = (id) => this.root.getElementById(id);
    this.buildSections();
    this.bindButtons();
    this.renderPresetChips();

    const missing = HOST.missingCapabilities();
    if (missing.length) {
      this.notice(
        `This Photoshop build is missing: ${missing.join(", ")}. ` +
          `The imaging API needs Photoshop 23.3 or newer.`,
        "error"
      );
      this.status("Unsupported host", "error");
      return;
    }

    // Restore whatever the user was last working with.
    try {
      const session = await META.loadSession();
      if (session && session.params) {
        this.params = sanitizeParams(session.params);
        this.rebuild();
      }
      this.userPresets = await META.loadUserPresets();
      this.renderPresetChips();
    } catch (e) {
      /* first run */
    }

    this.watchSelection();
    this.refreshContext();
  }

  /* ------------------------------------------------------- UI build */

  /**
   * Build every section from the schema, showing only what applies to the
   * current mode and state. Called again whenever a parameter changes something
   * another parameter's visibility depends on (the mode, mainly), so the panel
   * never shows a control that does nothing.
   */
  buildSections() {
    const host = this.$("sections");
    host.textContent = "";
    this.controls = {};
    this.sections = {};

    for (const sec of SECTIONS) {
      if (!sectionVisible(sec, this.params)) continue;
      const open = this.sectionOpen[sec.id] !== false;
      const s = C.createSection(sec.id, sec.label, open);
      this.sections[sec.id] = s;
      s.onToggle = (isOpen) => {
        this.sectionOpen[sec.id] = isOpen;
      };
      for (const def of PARAM_DEFS) {
        if (def.section !== sec.id) continue;
        if (!isVisible(def, this.params)) continue;
        s.body.appendChild(this.buildControl(def));
      }
      if (sec.id === "colors") {
        s.body.appendChild(
          C.el(
            "div",
            "hint",
            "Click a swatch to type a hex value, alt-click to take Photoshop's foreground colour." +
              (this.params.mode === "halftone"
                ? " The paper colour is never used as a dot colour."
                : "")
          )
        );
      }
      host.appendChild(s.el);
    }
    this.refreshSummaries();
  }

  /**
   * Update the readout on every section head.
   *
   * The rule is "say what is not the default": a choice always shows its value,
   * a toggle shows its name only when it is on, and a slider appears only once
   * it has been moved. A panel of defaults therefore stays quiet, and anything
   * you have touched is visible without opening the section it lives in.
   */
  refreshSummaries() {
    if (!this.sections) return;
    for (const sec of SECTIONS) {
      const s = this.sections[sec.id];
      if (!s) continue;
      s.setSummary(this.summaryFor(sec.id));
    }
    const modeBadge = this.$("brand-mode");
    if (modeBadge) modeBadge.textContent = this.params.mode === "dither" ? "Dither" : "Halftone";
  }

  summaryFor(sectionId) {
    const keys = SECTION_SUMMARY[sectionId];
    if (!keys) return "";
    const parts = [];
    for (const key of keys) {
      const def = DEF_BY_KEY[key];
      if (!def || !isVisible(def, this.params)) continue;
      const v = this.params[key];
      if (def.type === "choice" || def.type === "chips") {
        parts.push(C.optionLabel(def, v, key === "ditherAlgorithm" ? ALGORITHM_LABELS : null));
      } else if (def.type === "toggle") {
        // Only when it deviates, and phrased so an off-by-default-on toggle
        // still reads correctly rather than silently vanishing.
        if (v !== def.def) parts.push((v ? "" : "no ") + def.label.toLowerCase());
      } else if (def.type === "slider") {
        if (Math.abs(v - def.def) > (def.step || 1) / 1000) {
          parts.push(shortLabel(def) + " " + v.toFixed(def.decimals || 0) + (def.unit || ""));
        }
      } else if (def.type === "palette") {
        parts.push(`${(v || []).length} colours`);
      }
      if (parts.length >= 3) break;
    }
    return parts.join(" · ");
  }

  /** Does changing `key` alter which controls should be on screen? */
  affectsLayout(key) {
    return (
      key === "mode" ||
      key === "scaleMode" ||
      key === "tonalMapping" ||
      key === "sharpen"
    );
  }

  buildControl(def) {
    const commit = (value, committed) => {
      this.setParam(def.key, value, committed);
    };

    let ctl;
    switch (def.type) {
      case "slider":
        ctl = C.createSlider(def, this.params[def.key], commit);
        break;
      case "choice":
        ctl = C.createChoice(def, this.params[def.key], commit);
        break;
      case "chips":
        // Only the dither algorithm list is grouped. Handing this grouping to
        // every chips control blanked the Shape row entirely: none of its
        // options belong to a dither family, so no group claimed them.
        ctl = C.createChipChoice(
          def,
          this.params[def.key],
          commit,
          def.key === "ditherAlgorithm"
            ? {
                labels: ALGORITHM_LABELS,
                groups: ALGORITHM_FAMILIES,
                groupOf: (id) => ALGORITHM_FAMILY_OF[id],
              }
            : {}
        );
        break;
      case "toggle":
        ctl = C.createToggle(def, this.params[def.key], commit);
        break;
      case "color":
        ctl = C.createColorField(def, this.params[def.key], commit, () => IM.foregroundRGB());
        break;
      case "palette":
        ctl = C.createPalette({
          value: this.params[def.key],
          locked: this.params.lockedSwatches,
          onChange: (hexes, lockedIdx) => {
            this.params.palette = hexes;
            this.params.lockedSwatches = lockedIdx || [];
            this.params.paletteLocked = true;
            if (this.controls.paletteLocked) this.controls.paletteLocked.set(true);
            this.params.colorCount = Math.min(8, Math.max(2, hexes.length));
            if (this.controls.colorCount) this.controls.colorCount.set(this.params.colorCount);
            this.onParamsChanged(true);
          },
          onExtract: () => this.extractPalette(),
          onImport: () => this.importPalette(),
          onExport: () => this.exportPalette(),
          getForeground: () => IM.foregroundRGB(),
        });
        break;
      default:
        ctl = { el: C.el("div"), set: () => {} };
    }
    this.controls[def.key] = ctl;
    return ctl.el;
  }

  bindButtons() {
    this.$("btn-load").addEventListener("click", () => this.loadLayer());
    this.$("btn-apply").addEventListener("click", () => this.apply());
    this.$("btn-update").addEventListener("click", () => this.update());
    this.$("btn-reset").addEventListener("click", () => this.resetAll());
    this.$("btn-batch").addEventListener("click", () => this.batchApply());
    this.$("btn-svg").addEventListener("click", () => this.exportSVG());
    this.bindCompare();
    this.$("btn-save-preset").addEventListener("click", () => this.savePreset());
    this.$("btn-load-preset").addEventListener("click", () => this.promptLoadPreset());
  }

  /* --------------------------------------------------- state changes */

  setParam(key, value, committed) {
    if (this.params[key] === value) {
      if (committed) this.onParamsChanged(true);
      return;
    }
    this.params[key] = value;
    this.activePresetId = null;

    // Changing the colour count only means something if the palette follows it.
    if (key === "colorCount" && this.params.paletteLocked) this.syncPaletteToCount();
    if (key === "paletteLocked" && !value) this.syncPaletteFromImage();
    if (this.affectsLayout(key)) {
      this.buildSections();
      this.syncControls();
    }

    this.onParamsChanged(committed);
  }

  onParamsChanged(committed) {
    this.renderPresetChips();
    this.refreshSummaries();
    this.schedulePreview();
    if (committed) this.persistSession();
  }

  syncPaletteToCount() {
    const count = this.params.colorCount;
    if (this.engine.hasSource()) {
      try {
        this.params.palette = this.mergeLocked(this.engine.extractPaletteHex(this.params));
      } catch (e) {
        this.params.palette = padHexes(this.params.palette, count);
      }
    } else {
      this.params.palette = padHexes(this.params.palette, count);
    }
    if (this.controls.palette) this.controls.palette.set(this.params.palette, this.params.lockedSwatches);
  }

  syncPaletteFromImage() {
    if (!this.engine.hasSource()) return;
    try {
      this.params.palette = this.mergeLocked(this.engine.extractPaletteHex(this.params));
      if (this.controls.palette) this.controls.palette.set(this.params.palette, this.params.lockedSwatches);
    } catch (e) {
      /* keep the current palette */
    }
  }

  /**
   * Re-extract, keeping any swatch the user pinned.
   *
   * The locked entries are put back at their own indices afterwards, so pinning
   * a brand colour and letting the engine choose the rest works as expected.
   */
  mergeLocked(extracted) {
    const locks = this.params.lockedSwatches || [];
    if (!locks.length) return extracted;
    const out = extracted.slice();
    for (const i of locks) {
      if (i < out.length && this.params.palette[i]) out[i] = this.params.palette[i];
    }
    return out;
  }

  extractPalette() {
    if (!this.engine.hasSource()) {
      this.notice("Load a layer first, then the palette can be read from its pixels.", "warn");
      return;
    }
    const fresh = this.engine.extractPaletteHex(this.params);
    this.params.palette = this.mergeLocked(fresh);
    this.params.paletteLocked = true;
    if (this.controls.palette) this.controls.palette.set(this.params.palette, this.params.lockedSwatches);
    if (this.controls.paletteLocked) this.controls.paletteLocked.set(true);
    this.onParamsChanged(true);
    const kept = (this.params.lockedSwatches || []).length;
    this.notice(
      `Extracted ${this.params.palette.length} colours` + (kept ? `, keeping ${kept} locked.` : ".")
    );
  }

  async importPalette() {
    await this.guard("Importing swatches…", async () => {
      const res = await SWATCH.importPalette();
      if (!res) return;
      const hexes = res.hexes.slice(0, 8);
      this.params.palette = hexes;
      this.params.colorCount = Math.max(2, Math.min(8, hexes.length));
      this.params.paletteLocked = true;
      this.params.lockedSwatches = [];
      this.rebuild();
      this.schedulePreview();
      this.notice(
        `Imported ${res.hexes.length} swatches from ${res.name}` +
          (res.hexes.length > 8 ? `, using the first 8.` : ".")
      );
    });
  }

  async exportPalette() {
    await this.guard("Exporting swatches…", async () => {
      const name = await SWATCH.exportPalette(this.params.palette, "ase");
      if (name) this.notice(`Palette written to ${name}.`);
    });
  }

  syncControls() {
    for (const def of PARAM_DEFS) {
      const c = this.controls[def.key];
      if (c && c.set) c.set(this.params[def.key]);
    }
  }

  /** Rebuild the whole panel from `this.params` (after a preset or a recall). */
  rebuild() {
    this.buildSections();
    this.syncControls();
    this.renderPresetChips();
  }

  resetAll() {
    this.params = defaultParams();
    this.activePresetId = null;
    this.rebuild();
    this.schedulePreview();
    this.persistSession();
    this.notice("All parameters reset to defaults.");
  }

  /* ------------------------------------------------------- previewing */

  schedulePreview() {
    if (!this.engine.hasSource()) return;
    if (this.lastFrameMs > SLOW_FRAME_MS) {
      // The last frame overran; debounce instead of trying to keep up.
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.drawPreview();
      }, DEBOUNCE_MS);
      return;
    }
    if (this._raf) return;
    const schedule =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._raf = schedule(() => {
      this._raf = null;
      this.drawPreview();
    });
  }

  previewSize() {
    const src = this.engine.source;
    const wrap = this.$("preview-wrap");
    const avail = Math.max(160, Math.min(PREVIEW_MAX, (wrap && wrap.clientWidth) || PREVIEW_MAX));
    const scale = Math.min(1, avail / src.width);
    return {
      width: Math.max(1, Math.round(src.width * scale)),
      height: Math.max(1, Math.round(src.height * scale)),
    };
  }

  drawPreview() {
    if (!this.engine.hasSource()) return;
    const t0 = Date.now();
    try {
      const size = this.previewSize();
      const out = this.engine.render(
        this.params,
        Object.assign({ maxDitherGrid: PREVIEW_DITHER_GRID }, size)
      );
      this.$("preview").src = toDataURL(out.data, out.width, out.height);
      this.$("preview").className = "preview visible";
      this.$("preview-empty").className = "preview-empty hidden";
      this.lastFrameMs = Date.now() - t0;
      const unit = this.params.mode === "dither" ? "px" : "cells";
      const screens = out.angles ? ` · ${out.angles.length} screens @ ${out.angles.join("/")}°` : "";
      this._lastBadge =
        `${this.engine.stats.cells || 0} ${unit}${screens} · ${this.lastFrameMs}ms` +
        (out.exact ? "" : " · approx");
      this.badge(this._lastBadge);
    } catch (e) {
      this.lastFrameMs = Date.now() - t0;
      this.notice(`Preview failed: ${e.message}`, "error");
    }
  }

  /* --------------------------------------------------- Photoshop ops */

  async loadLayer() {
    await this.guard("Loading layer…", async () => {
      const src = await RENDER.readSource();
      this.engine.setSource(src.image);
      this.engine.sourceLayerId = src.layerId;
      this.engine.docPPI = src.docPPI || 72;
      this.sourceInfo = src;
      if (!this.params.paletteLocked) this.syncPaletteFromImage();
      this.drawPreview();

      // If this layer is an existing render, bring its settings back.
      const recalled = await RENDER.recallParams();
      if (recalled) {
        this.params = sanitizeParams(recalled.params);
        this.rebuild();
        this.drawPreview();
        this.notice(
          `Loaded "${src.layerName}" and restored the settings of ${recalled.renderId} (from ${recalled.source}).`
        );
      } else {
        this.notice(
          `Loaded "${src.layerName}" at ${src.image.width}x${src.image.height} for previewing.`
        );
      }
      this.refreshContext();
    });
  }

  async apply() {
    if (!this.engine.hasSource()) {
      await this.loadLayer();
      if (!this.engine.hasSource()) return;
    }
    await this.guard("Applying…", async () => {
      const res = await RENDER.applyNew(this.engine, this.params, {
        onProgress: (t) => this.progress(t),
      });
      this.reportPersistence(res);
      this.refreshContext();
    });
  }

  async update() {
    await this.guard("Updating…", async () => {
      const res = await RENDER.updateExisting(this.engine, this.params, {
        onProgress: (t) => this.progress(t),
      });
      this.reportPersistence(res);
      this.drawPreview();
      this.refreshContext();
    });
  }

  reportPersistence(res) {
    const where = res.persistence.xmp
      ? "with the layer"
      : res.persistence.sidecar
        ? "in the plugin's data folder (this Photoshop install only)"
        : "nowhere - persistence failed";
    const verb = res.updated ? "Updated" : "Created";
    const fellBack = this.params.output === "separated" && res.outputMode !== "separated";
    this.notice(
      `${verb} ${res.renderId} at ${res.width}x${res.height} (${res.outputMode}). ` +
        `Settings saved ${where}.` +
        (res.note ? ` ${res.note}` : ""),
      fellBack || !(res.persistence.xmp || res.persistence.sidecar) ? "warn" : ""
    );
  }

  /* ----------------------------------------------------------- batch */

  async batchApply() {
    const preview = BATCH.previewBatch(this.params.batchScope);
    if (!preview.count) {
      this.notice(preview.message, "warn");
      return;
    }
    this._cancelBatch = false;
    await this.guard(`Batching ${preview.count} layers…`, async () => {
      const res = await BATCH.runBatch(this.engine, this.params, {
        scope: this.params.batchScope,
        sharedPalette: this.params.batchSharedPalette,
        onItem: (i, total, name) => this.status(`Batch ${i + 1}/${total}: ${name}`, "busy"),
        onProgress: (t) => this.progress(t),
        shouldCancel: () => this._cancelBatch,
      });

      // The engine now holds the last batched layer, not what the panel was
      // previewing, so drop the stale preview rather than showing a lie.
      this.engine.sourceLayerId = null;

      const parts = [`Batched ${res.done} of ${res.total} layers.`];
      if (res.palette) parts.push(`Shared palette: ${res.palette.join(" ")}.`);
      if (res.cancelled) parts.push("Cancelled before the end.");
      if (res.failures.length) {
        parts.push(
          `${res.failures.length} failed: ` +
            res.failures.map((f) => `${f.name} (${f.error})`).join("; ")
        );
      }
      this.notice(parts.join(" "), res.failures.length || res.cancelled ? "warn" : "");
    });
  }

  /* ------------------------------------------------------ SVG export */

  /**
   * Write the current halftone out as vector art.
   *
   * The size used is the *document* size of the loaded layer, not the analysis
   * image the preview draws from: the analysis read is capped at 2600px, but the
   * SVG carries no pixels, so exporting at the layer's real dimensions costs
   * nothing and gives the printer a file at the right physical scale.
   */
  async exportSVG() {
    if (!this.engine.hasSource()) {
      this.notice("Load a layer first — there is nothing to export yet.", "warn");
      return;
    }
    if (this.params.mode === "dither") {
      this.notice(
        "SVG export covers halftone mode only. A dither is one shape per pixel, " +
          "so even a small image becomes hundreds of thousands of rectangles that " +
          "no vector application will open. Switch to Halftone mode to export.",
        "warn"
      );
      return;
    }

    await this.guard("Building SVG…", async () => {
      const b = this.sourceInfo && this.sourceInfo.bounds;
      const size = b
        ? { width: Math.round(b.right - b.left), height: Math.round(b.bottom - b.top) }
        : { width: this.engine.source.width, height: this.engine.source.height };

      const out = this.engine.renderSVG(this.params, size);
      const base = (this.sourceInfo && this.sourceInfo.layerName) || "halftone";
      const name = await FILES.saveText(FILES.safeName(base + " halftone", "svg"), out.svg, "svg");
      if (!name) {
        this.notice("SVG export cancelled.");
        return;
      }
      const kb = Math.round(out.svg.length / 1024);
      this.notice(
        `Wrote ${name}: ${out.shapes} shapes at ${size.width}x${size.height}, ${kb} KB.` +
          (out.busy
            ? " That is a lot of objects — expect illustration apps to be slow opening it; " +
              "a larger Radius or a coarser grid will thin it out."
            : ""),
        out.busy ? "warn" : ""
      );
    });
  }

  /* --------------------------------------------------------- compare */

  /**
   * Hold the Compare button to swap the preview for the untouched source.
   * Cheaper and less error-prone than a toggle: you cannot leave it stuck on.
   */
  bindCompare() {
    const btn = this.$("btn-compare");
    if (!btn) return;
    const show = () => {
      if (!this.engine.hasSource()) return;
      const img = this.$("preview");
      this._renderedSrc = img.src;
      img.src = this.sourceDataURL();
      this.badge("original");
    };
    const hide = () => {
      if (!this._renderedSrc) return;
      // Restore rather than re-render: nothing can have changed while the
      // button was held, and a re-render would race a pending preview tick.
      this.$("preview").src = this._renderedSrc;
      this._renderedSrc = null;
      this.badge(this._lastBadge);
    };
    btn.addEventListener("pointerdown", show);
    btn.addEventListener("pointerup", hide);
    btn.addEventListener("pointercancel", hide);
    btn.addEventListener("pointerleave", hide);
  }

  /** The source, downscaled to preview size and cached. */
  sourceDataURL() {
    const size = this.previewSize();
    const key = `${this.engine.sourceId}|${size.width}x${size.height}`;
    if (this._sourceURL && this._sourceURL.key === key) return this._sourceURL.url;
    const small = downscale(this.engine.source, size.width, size.height);
    const url = toDataURL(small.data, small.width, small.height);
    this._sourceURL = { key, url };
    return url;
  }

  /* ------------------------------------------------------- selection */

  watchSelection() {
    try {
      HOST.action().addNotificationListener(
        [{ event: "select" }, { event: "delete" }, { event: "make" }],
        () => {
          if (this._selectionTimer) clearTimeout(this._selectionTimer);
          this._selectionTimer = setTimeout(() => this.refreshContext(), 120);
        }
      );
    } catch (e) {
      // Without the listener the panel simply does not auto-refresh; the user
      // can still press Load Layer. Not worth failing over.
    }
  }

  refreshContext() {
    let ctx;
    try {
      ctx = RENDER.currentContext();
    } catch (e) {
      this.status(e.message, "error");
      return;
    }

    const update = this.$("btn-update");
    if (ctx.mode === "existing") {
      update.removeAttribute("disabled");
      this.status(`Halftone group ${ctx.renderId || ""} selected — Update re-renders it.`, "ready");
    } else if (ctx.mode === "new") {
      update.setAttribute("disabled", "true");
      this.status(`"${ctx.targetLayer.name}" selected — Apply creates a new halftone.`, "ready");
    } else {
      update.setAttribute("disabled", "true");
      this.status(ctx.message, "");
    }
  }

  /* --------------------------------------------------------- presets */

  allPresets() {
    return BUILTIN_PRESETS.concat(this.userPresets);
  }

  renderPresetChips() {
    const host = this.$("preset-list");
    if (!host) return;
    host.textContent = "";
    for (const preset of this.allPresets()) {
      const chip = C.el(
        "button",
        "preset-chip" +
          (preset.user ? " user" : "") +
          (preset.id === this.activePresetId ? " active" : ""),
        preset.name
      );
      chip.addEventListener("click", (e) => {
        if (e.altKey && preset.user) {
          this.deletePreset(preset);
          return;
        }
        this.applyPreset(preset);
      });
      if (preset.user) chip.title = `${preset.name} — alt-click to delete`;
      host.appendChild(chip);
    }
  }

  applyPreset(preset) {
    this.params = presetToParams(preset);
    this.activePresetId = preset.id;
    if (!this.params.paletteLocked) this.syncPaletteFromImage();
    this.rebuild();
    this.schedulePreview();
    this.persistSession();
    this.notice(`Preset "${preset.name}" loaded.`);
  }

  async deletePreset(preset) {
    this.userPresets = this.userPresets.filter((p) => p.id !== preset.id);
    if (this.activePresetId === preset.id) this.activePresetId = null;
    const saved = await META.saveUserPresets(this.userPresets);
    this.renderPresetChips();
    this.notice(
      saved ? `Preset "${preset.name}" deleted.` : `Preset "${preset.name}" removed for this session only.`,
      saved ? "" : "warn"
    );
  }

  async savePreset() {
    const name = await this.promptText("Preset name", "My Halftone");
    if (!name) return;
    const preset = makeUserPreset(name, this.params);
    this.userPresets = this.userPresets.filter((p) => p.name !== preset.name).concat([preset]);
    const saved = await META.saveUserPresets(this.userPresets);
    this.activePresetId = preset.id;
    this.renderPresetChips();
    this.notice(
      saved
        ? `Preset "${preset.name}" saved.`
        : `Preset "${preset.name}" is active but could not be written to disk.`,
      saved ? "" : "warn"
    );
  }

  async promptLoadPreset() {
    // The chips are the picker; this button just makes that discoverable and
    // handles the "I have too many presets to scan" case.
    const names = this.allPresets().map((p) => p.name);
    const name = await this.promptText(`Load preset (${names.join(", ")})`, names[0] || "");
    if (!name) return;
    const found = this.allPresets().find(
      (p) => p.name.toLowerCase() === String(name).trim().toLowerCase()
    );
    if (!found) {
      this.notice(`No preset named "${name}".`, "warn");
      return;
    }
    this.applyPreset(found);
  }

  /**
   * A small modal text prompt. `window.prompt` does not exist in UXP, so the
   * panel builds its own inline field.
   */
  promptText(label, initial) {
    return new Promise((resolve) => {
      const notice = this.$("notice");
      notice.textContent = "";
      notice.className = "notice show";
      const row = C.el("div", "ctl");
      row.appendChild(C.el("div", "ctl-label", label));
      const input = C.el("input", "ctl-value");
      input.type = "text";
      input.style.textAlign = "left";
      input.style.width = "120px";
      input.style.minWidth = "80px";
      input.style.flexGrow = "1";
      input.style.flexShrink = "1";
      input.value = initial || "";
      const okBtn = C.el("button", "seg-item", "OK");
      okBtn.style.width = "38px";
      okBtn.style.minWidth = "38px";
      okBtn.style.flexGrow = "0";
      okBtn.style.flexShrink = "0";
      const cancelBtn = C.el("button", "seg-item", "Cancel");
      cancelBtn.style.width = "50px";
      cancelBtn.style.minWidth = "50px";
      cancelBtn.style.flexGrow = "0";
      cancelBtn.style.flexShrink = "0";
      row.appendChild(input);
      row.appendChild(okBtn);
      row.appendChild(cancelBtn);
      notice.appendChild(row);
      input.focus();
      if (input.select) input.select();

      const done = (value) => {
        notice.textContent = "";
        notice.className = "notice";
        resolve(value);
      };
      okBtn.addEventListener("click", () => done(input.value.trim() || null));
      cancelBtn.addEventListener("click", () => done(null));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
        else if (e.key === "Escape") done(null);
      });
    });
  }

  /* ----------------------------------------------------------- misc */

  async persistSession() {
    try {
      await META.saveSession(this.params);
    } catch (e) {
      /* best effort */
    }
  }

  /**
   * Run an async Photoshop operation with busy state, progress and a single
   * place where errors turn into a readable message.
   */
  async guard(label, fn) {
    if (this._busy) return;
    this._busy = true;
    this.setButtonsEnabled(false);
    this.status(label, "busy");
    this.progress(0, true);
    try {
      await fn();
      this.status("Ready", "ready");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this.notice(msg, "error");
      this.status(msg, "error");
    } finally {
      this._busy = false;
      this.setButtonsEnabled(true);
      this.progress(0, false);
      this.refreshContext();
    }
  }

  setButtonsEnabled(enabled) {
    for (const id of [
      "btn-load",
      "btn-apply",
      "btn-update",
      "btn-reset",
      "btn-batch",
      "btn-svg",
      "btn-save-preset",
      "btn-load-preset",
    ]) {
      const b = this.$(id);
      if (!b) continue;
      if (enabled) b.removeAttribute("disabled");
      else b.setAttribute("disabled", "true");
    }
  }

  /** The overlay in the preview's corner; hidden when there is nothing to say. */
  badge(text) {
    const b = this.$("preview-badge");
    b.textContent = text || "";
    b.className = "preview-badge" + (text ? " show" : "");
  }

  status(text, kind) {
    this.$("status-text").textContent = text;
    this.$("status-dot").className = "status-dot" + (kind ? " " + kind : "");
  }

  progress(t, active) {
    const wrap = this.$("progress");
    const bar = this.$("progress-bar");
    if (active !== undefined) wrap.className = "progress" + (active ? " active" : "");
    bar.style.width = Math.round(Math.max(0, Math.min(1, t)) * 100) + "%";
  }

  notice(text, kind) {
    const n = this.$("notice");
    n.textContent = text;
    n.className = "notice show" + (kind ? " " + kind : "");
  }
}

/**
 * Which parameters each section head reports, in order. Kept short on purpose:
 * a summary that lists everything is a second copy of the section, not a
 * summary, and a 300px panel has room for about three items.
 */
const SECTION_SUMMARY = {
  // Not `mode`: the badge in the header already says which engine is running.
  mode: ["lumaMode"],
  scale: ["scaleMode", "density", "dpi", "ditherResolution"],
  halftone: ["shape", "screenType", "radius", "angle"],
  press: ["jitterPosition", "jitterSize", "misregistration"],
  dither: ["ditherAlgorithm", "ditherStrength"],
  preprocess: ["blur", "sharpen", "noiseReduction"],
  colors: ["colorCount", "quantMethod", "spread"],
  tonal: ["tonalMapping"],
  grade: ["contrast", "gamma", "exposure", "gradeBias"],
  adjust: ["invert", "hue", "saturation", "brightness"],
  output: ["output", "useSelection"],
  batch: ["batchScope", "batchSharedPalette"],
};

/** "Sharpen Radius" -> "sharpen": enough to tell two sliders apart, no more. */
function shortLabel(def) {
  return String(def.label).split(" ")[0].toLowerCase();
}

const ALGORITHM_LABELS = {};
const ALGORITHM_FAMILY_OF = {};
for (const a of ALGORITHMS) {
  ALGORITHM_LABELS[a.id] = a.label;
  ALGORITHM_FAMILY_OF[a.id] = a.family;
}

function padHexes(hexes, count) {
  const out = (hexes || []).slice(0, count);
  while (out.length < count) out.push(out.length ? out[out.length - 1] : "#808080");
  return out;
}

module.exports = { Panel };
