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
const { toDataURL, encodePNG } = require("../util/png.js");
const { isIdentityCurve } = require("../engine/grade.js");
const { downscaleBox: downscale } = require("../engine/resample.js");
const GEO = require("./geometry.js");
const HOST = require("../photoshop/host.js");
const RENDER = require("../photoshop/render.js");
const META = require("../photoshop/metadata.js");
const IM = require("../photoshop/imaging.js");
const BATCH = require("../photoshop/batch.js");
const SWATCH = require("../photoshop/swatches.js");
const FILES = require("../photoshop/files.js");

const PREVIEW_MAX = 460;
/**
 * How much of the panel's height the pinned preview may take.
 *
 * The preview no longer scrolls away, which is the point - but that also means
 * a tall portrait image would otherwise fill the panel and leave no room for the
 * controls it is supposed to be showing you the effect of. So it is capped as a
 * fraction of the panel, with a floor low enough to survive a short panel and a
 * ceiling so it does not sprawl on a tall one.
 */
const PREVIEW_HEIGHT_FRACTION = 0.42;
const PREVIEW_HEIGHT_MIN = 110;
const PREVIEW_HEIGHT_MAX = 380;
/** Cap on the dither grid used for previews; above this the preview approximates. */
const PREVIEW_DITHER_GRID = 700;
const SLOW_FRAME_MS = 45;
const DEBOUNCE_MS = 90;
/**
 * Resolution multiplier used *during* a drag, and only once frames are actually
 * overrunning. Encoding a preview costs roughly the square of its size, so 0.6
 * is about a third of the work; on release the panel always redraws at full
 * size, so the reduction is never what you are left looking at.
 */
const DRAFT_SCALE = 0.6;
/** How long after the last draft frame to redraw at full size regardless. */
const DRAFT_UPGRADE_MS = 260;
/** Zoom multiplier per step, and the ceiling. 8x is well past useful. */
const ZOOM_STEP = 1.6;
const ZOOM_MAX = 8;
/**
 * The preview box to assume when the host will not report any size at all.
 *
 * Photoshop 2026 returns `clientWidth === 0` for this panel's elements and a
 * `getBoundingClientRect()` that has come back with a width of -30150, so this
 * is not a theoretical branch - it is what the plugin ran on. A guess is
 * survivable, because the frame is scaled to the box by CSS either way and the
 * zoom *ratio* between two guessed boxes is still correct. What it costs is the
 * absolute scale: 1:1 is no longer one document pixel per screen pixel, and the
 * percentage in the zoom bar is relative to the guess. So the panel says so
 * rather than quietly showing a figure it cannot stand behind.
 */
const ASSUMED_BOX_WIDTH = 360;
const ASSUMED_PANEL_HEIGHT = 720;

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
    this._cancel = false;
    this._upgrade = null;
    /**
     * Window state, as opposed to render parameters. It is persisted with the
     * session but deliberately kept out of params.js and out of presets: how
     * tall you like the preview box is a property of your panel, not of the
     * halftone, and a preset that resized your panel would be obnoxious.
     */
    this.ui = { previewHeight: null };
    /**
     * The preview viewport.
     *
     * `zoom` is output pixels per *document* pixel, so 1 means one preview pixel
     * per pixel the render will actually produce - which is the only scale at
     * which dot quality can be judged. null means fit-to-box. `cx`/`cy` are the
     * point of the document held at the centre of the box, in 0..1.
     */
    this.view = { zoom: null, cx: 0.5, cy: 0.5 };
    this._comparing = false;
    this._splitAt = 0.5;
    this.theatre = false;
  }

  /* ---------------------------------------------------------------- */

  async init() {
    this.$ = (id) => this.root.getElementById(id);
    this.missingElements = [];
    /**
     * Bind a handler, tolerating a missing element.
     *
     * Every binding used to dereference its element directly, so one id that
     * did not exist threw out of init() and took the entire panel down - a
     * blank panel with "Failed to start", for a button. That is the wrong
     * failure: a missing control should cost that control. What is missing is
     * collected and reported once, so the next time something is wrong it says
     * *what* instead of dying.
     */
    this.on = (id, event, handler) => {
      const node = this.$(id);
      if (!node || typeof node.addEventListener !== "function") {
        if (this.missingElements.indexOf(id) < 0) this.missingElements.push(id);
        return null;
      }
      node.addEventListener(event, handler);
      return node;
    };
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
      if (session && session.ui) this.ui = sanitizeUI(session.ui);
      this.userPresets = await META.loadUserPresets();
      this.renderPresetChips();
    } catch (e) {
      /* first run */
    }

    this.buildOutputMode();
    this.showCancel(false);
    this.bindPreviewGrip();
    this.bindZoom();
    this.applyPreviewHeight();
    this.watchSelection();
    this.refreshContext();
    this.selfCheck();
  }

  /**
   * Say what is wrong, rather than leaving the user to say "everything is
   * broken".
   *
   * Three rounds of this plugin have shipped a fault that only appeared inside
   * Photoshop - flex layout, a panel entrypoint that could not load, a
   * stylesheet feature UXP does not implement - and in each case what came back
   * was that it did not work, with nothing to act on. None of that is the
   * user's job. So the panel checks what it can about itself at start-up and
   * puts anything it finds on screen, where it can be read out.
   *
   * Everything here is cheap and cannot itself fail: missing markup, a preview
   * box with no size, and the host capabilities the render depends on.
   */
  selfCheck() {
    const problems = [];

    if (this.missingElements && this.missingElements.length) {
      problems.push(`markup is missing: ${this.missingElements.join(", ")}`);
    }

    /*
     * The geometry report is written every start, not only when something looks
     * wrong, and it prints what each API returned rather than a verdict.
     *
     * The previous version printed a verdict - "the preview area has no width
     * (0px)" - and that was enough to know something was wrong but not enough
     * to know what to do, because it named one API out of three. The log that
     * finally settled it did so by accident: an unrelated UXP warning about a
     * rejected `width: -30150px` was the only evidence that
     * getBoundingClientRect was answering as well as answering wrongly. Nothing
     * should have to be diagnosed by accident twice.
     */
    let geometry = "";
    try {
      geometry = [
        GEO.describe(this.$("app"), "#app"),
        GEO.describe(this.$("preview-wrap"), "#preview-wrap"),
        GEO.describe(this.$("scroll"), "#scroll"),
        `window=${typeof window === "undefined" ? "absent" : `${window.innerWidth}x${window.innerHeight}`}`,
      ].join(" | ");
      console.log("[Halftone Studio] geometry:", geometry);
    } catch (e) {
      /* diagnostics may never be the thing that breaks the panel */
    }

    /*
     * What matters is not whether an individual API works but whether anything
     * does, because the panel can route around one and not around none.
     */
    const box = this.previewBox();
    if (!box.exact) {
      problems.push(
        `this Photoshop build reports no size for the panel, so the preview is ` +
          `assuming ${box.width}x${box.height}. Zooming and panning work; the ` +
          `percentage and 1:1 are relative to that assumption, not to your screen`
      );
    }

    const built = this.sections ? Object.keys(this.sections).length : 0;
    if (built < 4) problems.push(`only ${built} sections were built`);

    if (!IM.canWriteMasks()) {
      problems.push("this build has no imaging.putLayerMask, so separated output falls back to flat");
    }

    if (problems.length) {
      this.notice(
        "Halftone Studio started with problems — please send this text:\n• " +
          problems.join("\n• "),
        "warn"
      );
      try {
        console.warn("[Halftone Studio] self-check:", problems.join(" | "));
      } catch (e) {
        /* the notice is the important half */
      }
    }
    return problems;
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
      } else if (def.type === "curve") {
        if (!isIdentityCurve(v)) parts.push(`curve ${v.length}pt`);
      }
      if (parts.length >= 3) break;
    }
    return parts.join(" · ");
  }

  /**
   * The output mode, mirrored into the action card.
   *
   * It is the same parameter as the one in the Output section - two controls,
   * one value - because where a setting *lives* and where it is *decided* are
   * not always the same place. This one governs what Apply builds, so it
   * belongs beside Apply; leaving it only in a collapsed section three down
   * from the button meant a user asked for a feature that had shipped weeks
   * earlier.
   */
  buildOutputMode() {
    const host = this.$("output-mode");
    if (!host) return;
    host.textContent = "";
    const def = Object.assign({}, DEF_BY_KEY.output, { label: "On Apply" });
    this.outputMirror = C.createChoice(def, this.params.output, (v) => {
      this.setParam("output", v, true);
    });
    host.appendChild(this.outputMirror.el);
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
      case "curve":
        ctl = C.createCurve(def, this.params[def.key], commit, {
          getHistogram: () => this.previewHistogram(),
        });
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
    this.on("btn-load", "click", () => this.loadLayer());
    this.on("btn-apply", "click", () => this.apply());
    this.on("btn-update", "click", () => this.update());
    this.on("btn-reset", "click", () => this.resetAll());
    this.on("btn-batch", "click", () => this.batchApply());
    this.on("btn-svg", "click", () => this.exportSVG());
    this.on("btn-plates", "click", () => this.exportPlates());
    this.on("btn-cancel", "click", () => this.requestCancel());
    this.bindCompare();
    this.on("btn-save-preset", "click", () => this.savePreset());
    this.on("btn-load-preset", "click", () => this.promptLoadPreset());
  }

  /* --------------------------------------------------- state changes */

  setParam(key, value, committed) {
    if (this.params[key] === value) {
      if (committed) this.onParamsChanged(true);
      return;
    }
    this.params[key] = value;
    this.activePresetId = null;

    // One value, two controls: keep the mirror in the action card in step
    // whichever of the two was used.
    if (key === "output" && this.outputMirror) this.outputMirror.set(value);

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
    // Uncommitted means a control is still being dragged, which is the only
    // time a lower-resolution frame is worth having.
    this.schedulePreview(!committed);
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
    if (this.outputMirror) this.outputMirror.set(this.params.output);
  }

  /** Push a fresh histogram into the curve editor, if one is on screen. */
  refreshHistogram() {
    const c = this.controls.toneCurve;
    if (c && c.setHistogram) c.setHistogram(this.previewHistogram());
  }

  /** Rebuild the whole panel from `this.params` (after a preset or a recall). */
  rebuild() {
    this.buildSections();
    this.syncControls();
    this.refreshHistogram();
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

  /**
   * @param {boolean} [interactive] true while a control is still being dragged
   */
  schedulePreview(interactive) {
    if (!this.engine.hasSource()) return;
    const draft = !!interactive && this.lastFrameMs > SLOW_FRAME_MS;
    // A draft frame is only ever an intermediate state. Releasing the control
    // commits and redraws at full size, but a drag that ends without one - a
    // lost pointer, a cancelled gesture - would otherwise leave the coarse
    // frame on screen for good. So every draft arms a short upgrade.
    if (this._upgrade) {
      clearTimeout(this._upgrade);
      this._upgrade = null;
    }

    if (this.lastFrameMs > SLOW_FRAME_MS) {
      // The last frame overran; debounce instead of trying to keep up.
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        this._timer = null;
        this.drawPreview({ draft });
      }, DEBOUNCE_MS);
      return;
    }
    if (this._raf) return;
    const schedule =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    this._raf = schedule(() => {
      this._raf = null;
      this.drawPreview({ draft });
    });
  }

  /**
   * How big the panel is, and how confident we are about it.
   *
   * `#app` is pinned to all four edges of the panel, so measuring it measures
   * the panel. When it cannot be measured - which is the case in Photoshop
   * 2026, where every geometry API for these elements returns 0 or nonsense -
   * the window is asked, and failing that a size is assumed.
   *
   * @returns {{width:number, height:number, measured:boolean, source:string}}
   */
  panelSize() {
    const app = this.$("app");
    const s = GEO.sizeOf(app);
    let width = s.width;
    let height = s.height;
    let source = s.source;

    if (width === null || height === null) {
      const v = GEO.viewportSize(typeof window !== "undefined" ? window : null);
      if (width === null && v.width !== null) {
        width = v.width;
        source = source === "none" ? "window" : source + "+window";
      }
      if (height === null && v.height !== null) {
        height = v.height;
        if (source.indexOf("window") < 0) source = source === "none" ? "window" : source + "+window";
      }
    }

    const measured = width !== null && height !== null;
    return {
      // `#app` has 11px of padding on each side, which the preview does not get
      // to use. Subtracting it matters only when the reading is real.
      width: width === null ? ASSUMED_BOX_WIDTH : Math.max(120, Math.round(width) - 22),
      height: height === null ? ASSUMED_PANEL_HEIGHT : Math.round(height),
      measured,
      source: measured ? source : source === "none" ? "assumed" : source + "+assumed",
    };
  }

  /** How tall the preview box is: the whole panel when full, else the cap. */
  previewBoxHeight() {
    /*
     * Floored in every branch, on purpose. A zero or near-zero reading would
     * divide through the fit calculation and render a 1px preview - which reads
     * as "the preview is broken" rather than as a measurement that was refused.
     * The floor turns the worst case into a small preview.
     */
    let h;
    const panel = this.panelSize();
    if (this.theatre) {
      const wrapH = GEO.sizeOf(this.$("preview-wrap")).height;
      // In full-preview mode the box *is* the panel, less the zoom bar and the
      // padding above and below it.
      h = wrapH === null ? panel.height - 70 : wrapH;
    } else if (this.ui.previewHeight) {
      h = this.ui.previewHeight;
    } else {
      h = Math.min(PREVIEW_HEIGHT_MAX, Math.round(panel.height * PREVIEW_HEIGHT_FRACTION));
    }
    return Number.isFinite(h) && h > PREVIEW_HEIGHT_MIN ? h : PREVIEW_HEIGHT_MIN;
  }

  /* ------------------------------------------------------- viewport */

  /** The source's tone distribution, for the curve editor's backdrop. */
  previewHistogram() {
    if (!this.engine.hasSource()) return null;
    try {
      return this.engine.histogram(this.params);
    } catch (e) {
      return null;
    }
  }

  /** The document's own pixel dimensions, which is what 1:1 is relative to. */
  documentSize() {
    const b = this.sourceInfo && this.sourceInfo.bounds;
    if (b) {
      return {
        width: Math.max(1, Math.round(b.right - b.left)),
        height: Math.max(1, Math.round(b.bottom - b.top)),
      };
    }
    const src = this.engine.source;
    return { width: src.width, height: src.height };
  }

  /** The zoom that makes the whole document fit the preview box. */
  fitZoom(box) {
    const doc = this.documentSize();
    return Math.min(box.width / doc.width, box.height / doc.height);
  }

  /**
   * Turn the viewport state into engine arguments.
   *
   * The virtual render is always the whole document at the current zoom; what
   * changes is how much of it we ask for. That is what makes zooming show the
   * same picture rather than a re-derived one: the grid is built for the virtual
   * size either way, so a dot does not move when you zoom into it.
   *
   * @returns {{width:number, height:number, view:object|null}}
   */
  renderPlan(box) {
    const doc = this.documentSize();
    const fit = this.fitZoom(box);
    let zoom = this.view.zoom === null ? fit : this.view.zoom;
    // A view that has gone non-finite - a zero-sized box, a bad document
    // rectangle - would render a 1px frame and look like a dead preview. Fall
    // back to fit rather than showing nothing.
    if (!Number.isFinite(zoom) || zoom <= 0) zoom = Number.isFinite(fit) && fit > 0 ? fit : 1;
    if (!Number.isFinite(this.view.cx)) this.view.cx = 0.5;
    if (!Number.isFinite(this.view.cy)) this.view.cy = 0.5;

    const vw = Math.max(1, Math.round(doc.width * zoom));
    const vh = Math.max(1, Math.round(doc.height * zoom));

    // Smaller than the box in a dimension: nothing to pan there, so render the
    // whole thing rather than a window with dead space in it.
    if (vw <= box.width && vh <= box.height) {
      return { width: vw, height: vh, view: null };
    }

    const outW = Math.min(box.width, vw);
    const outH = Math.min(box.height, vh);
    const x = clampInt(Math.round(this.view.cx * vw - outW / 2), 0, Math.max(0, vw - outW));
    const y = clampInt(Math.round(this.view.cy * vh - outH / 2), 0, Math.max(0, vh - outH));
    return { width: vw, height: vh, view: { x, y, width: outW, height: outH } };
  }

  /* ------------------------------------------------------------ zoom */

  bindZoom() {
    const wrap = this.$("preview-wrap");
    this.on("btn-zoom-in", "click", () => this.zoomBy(ZOOM_STEP));
    this.on("btn-zoom-out", "click", () => this.zoomBy(1 / ZOOM_STEP));
    this.on("btn-zoom-fit", "click", () => this.setZoom(null));
    this.on("btn-zoom-1", "click", () => this.setZoom(1));
    this.on("btn-theatre", "click", () => this.toggleTheatre());
    if (!wrap) return;

    /*
     * The wheel is the natural gesture, and costs nothing where it is not
     * delivered: the buttons do the same job.
     *
     * It insists on a real, non-zero deltaY. `(e.deltaY || 0) > 0` was wrong in
     * a way that matters: a host that reports no deltaY would have taken every
     * wheel event as "zoom in", so scrolling the panel with the pointer over the
     * preview would have zoomed it, repeatedly, while preventDefault stopped the
     * scroll. Nothing is done unless the direction is actually known.
     */
    wrap.addEventListener("wheel", (e) => {
      if (!this.engine.hasSource()) return;
      const dy = Number(e.deltaY);
      if (!Number.isFinite(dy) || dy === 0) return;
      this.zoomBy(dy > 0 ? 1 / ZOOM_STEP : ZOOM_STEP, this.pointerInView(e));
      if (e.preventDefault) e.preventDefault();
    });

    let panning = false;
    let start = null;
    wrap.addEventListener("pointerdown", (e) => {
      if (!this.canPan()) return;
      // The compare seam lives inside the preview, so its own drag would also
      // start a pan and the image would slide out from under the handle.
      if (this._comparing) return;
      panning = true;
      const box = this.previewBox();
      start = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy, box };
      wrap.className = "preview-wrap panning";
      try {
        wrap.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is an optimisation, not a requirement */
      }
      if (e.preventDefault) e.preventDefault();
    });

    wrap.addEventListener("pointermove", (e) => {
      if (!panning) return;
      const plan = this.renderPlan(start.box);
      // Dragging moves the image with the pointer, so the centre moves against
      // it - hence the negative sign. In fractions of the virtual render.
      this.view.cx = clamp01(start.cx - (e.clientX - start.x) / plan.width);
      this.view.cy = clamp01(start.cy - (e.clientY - start.y) / plan.height);
      this.drawPreview({ draft: true });
    });

    const endPan = (e) => {
      if (!panning) return;
      panning = false;
      this.updateZoomBar();
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      this.drawPreview();
    };
    wrap.addEventListener("pointerup", endPan);
    wrap.addEventListener("pointercancel", endPan);

    /*
     * Deliberately no double-click-to-zoom on the preview. It is a gesture
     * people make by accident, and its result - the whole picture replaced by a
     * small crop at 100% - looks exactly like the panel breaking. The two
     * buttons say what they do and cannot be triggered by a stray double tap.
     */
  }

  /**
   * Where the pointer is inside the preview box, in 0..1, or null.
   *
   * Null when the box cannot be located, which is not a failure: the caller
   * then zooms about the centre instead of about the cursor. Anchoring to a
   * rectangle the host reported as starting at -30150 would send the view
   * somewhere the user did not point at, which is worse than not anchoring.
   */
  pointerInView(e) {
    const r = GEO.rectOf(this.$("preview-wrap"));
    if (!r) return null;
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  canPan() {
    if (!this.engine.hasSource()) return false;
    const plan = this.renderPlan(this.previewBox());
    return !!plan.view;
  }

  /**
   * The box the preview is drawn into, in panel pixels.
   *
   * The width is the preview element's own if the host will give it, otherwise
   * the panel's, otherwise a guess. `exact` travels with it so callers can tell
   * the difference between a scale that means something and one that does not.
   *
   * @returns {{width:number, height:number, exact:boolean, source:string}}
   */
  previewBox() {
    const wrapW = GEO.sizeOf(this.$("preview-wrap")).width;
    const panel = this.panelSize();
    const raw = wrapW === null ? panel.width : wrapW;
    return {
      width: Math.max(120, Math.min(PREVIEW_MAX, Math.round(raw))),
      height: this.previewBoxHeight(),
      exact: wrapW !== null || panel.measured,
      source: wrapW !== null ? "wrap" : panel.source,
    };
  }

  /**
   * @param {number} factor
   * @param {{x:number,y:number}} [anchor] point in the box to keep still
   */
  zoomBy(factor, anchor) {
    if (!this.engine.hasSource()) return;
    const box = this.previewBox();
    const from = this.view.zoom === null ? this.fitZoom(box) : this.view.zoom;
    const to = clampNum(from * factor, this.fitZoom(box) * 0.5, ZOOM_MAX);

    if (anchor) {
      // Keep the point under the cursor where it is: convert it to a document
      // fraction at the old zoom, then re-centre so it lands in the same place.
      const before = this.renderPlan(box);
      const px = (before.view ? before.view.x : 0) + anchor.x * (before.view ? before.view.width : before.width);
      const py = (before.view ? before.view.y : 0) + anchor.y * (before.view ? before.view.height : before.height);
      const fx = px / before.width;
      const fy = py / before.height;
      this.view.zoom = to;
      const after = this.renderPlan(box);
      if (after.view) {
        this.view.cx = clamp01(fx + (0.5 - anchor.x) * (after.view.width / after.width));
        this.view.cy = clamp01(fy + (0.5 - anchor.y) * (after.view.height / after.height));
      }
    } else {
      this.view.zoom = to;
    }
    this.afterZoom();
  }

  setZoom(zoom) {
    if (!this.engine.hasSource() && zoom !== null) return;
    if (zoom !== null && !Number.isFinite(zoom)) zoom = null;
    this.view.zoom = zoom;
    if (zoom === null) {
      this.view.cx = 0.5;
      this.view.cy = 0.5;
    }
    this.afterZoom();
  }

  afterZoom() {
    this.updateZoomBar();
    this.drawPreview();
  }

  updateZoomBar() {
    const label = this.$("zoom-level");
    const wrap = this.$("preview-wrap");
    if (label) {
      const box = this.previewBox();
      // A tilde rather than a footnote. The zoom *ratio* is right either way -
      // one step is always 1.6x the last - so the honest caveat is only that
      // the number is not relative to your screen, and a tilde says exactly
      // that in the width available.
      const approx = box.exact ? "" : "~";
      if (!this.engine.hasSource()) label.textContent = "—";
      else if (this.view.zoom === null) label.textContent = `Fit · ${approx}${Math.round(this.fitZoom(box) * 100)}%`;
      else label.textContent = `${approx}${Math.round(this.view.zoom * 100)}%`;
    }
    const fitBtn = this.$("btn-zoom-fit");
    const oneBtn = this.$("btn-zoom-1");
    if (fitBtn) fitBtn.className = "zoom-btn zoom-word" + (this.view.zoom === null ? " active" : "");
    if (oneBtn) {
      oneBtn.className = "zoom-btn zoom-word" + (this.view.zoom === 1 ? " active" : "");
    }
    if (wrap && wrap.className.indexOf("panning") < 0) {
      wrap.className = "preview-wrap" + (this.canPan() ? " pannable" : "");
    }
  }

  /**
   * Redraw at full size once the drag goes quiet, in case no commit ever comes.
   */
  armFullRedraw() {
    if (this._upgrade) clearTimeout(this._upgrade);
    this._upgrade = setTimeout(() => {
      this._upgrade = null;
      this.drawPreview();
    }, DRAFT_UPGRADE_MS);
  }

  /**
   * The box a frame has to land in.
   *
   * In full-preview mode that is the whole panel, which is how you get a large
   * view: float the panel, size it, and give all of it to the picture.
   */
  outputBox() {
    return this.previewBox();
  }

  /**
   * The source shown at fit, for the compare view. Deliberately not the
   * viewport: Compare answers "what did this look like before", and answering
   * it at a different zoom than the render would make it useless.
   */
  previewSize() {
    const src = this.engine.source;
    const box = this.outputBox();
    const scale = Math.min(1, box.width / src.width, box.height / src.height);
    return {
      width: Math.max(1, Math.round(src.width * scale)),
      height: Math.max(1, Math.round(src.height * scale)),
    };
  }

  drawPreview(opts = {}) {
    if (!this.engine.hasSource()) return;
    // drawPreview is now also driven by the frame bus, so it can be reached
    // from another panel's callback. Confirm this document is still standing
    // rather than throwing out of someone else's stack.
    const img = this.$("preview");
    if (!img) return;
    const t0 = Date.now();
    try {
      const box = this.outputBox();
      const draftBox = opts.draft
        ? {
            width: Math.max(32, Math.round(box.width * DRAFT_SCALE)),
            height: Math.max(32, Math.round(box.height * DRAFT_SCALE)),
          }
        : box;
      if (opts.draft) this.armFullRedraw();

      const plan = this.renderPlan(draftBox);
      const out = this.engine.render(this.params, {
        maxDitherGrid: PREVIEW_DITHER_GRID,
        width: plan.width,
        height: plan.height,
        view: plan.view,
      });
      const url = toDataURL(out.data, out.width, out.height);
      img.src = url;
      img.className = "preview visible";
      this.$("preview-empty").className = "preview-empty hidden";
      this.lastFrameMs = Date.now() - t0;
      const unit = this.params.mode === "dither" ? "px" : "cells";
      const screens = out.angles ? ` · ${out.angles.length} screens @ ${out.angles.join("/")}°` : "";
      const zoomTag = this.view.zoom === null ? "" : ` · ${Math.round(this.view.zoom * 100)}%`;
      this._lastBadge =
        `${this.engine.stats.cells || 0} ${unit}${screens} · ${this.lastFrameMs}ms` +
        zoomTag +
        (out.exact ? "" : " · approx") +
        // Say so rather than quietly showing a coarser picture than the render.
        (opts.draft ? " · draft" : "");
      this.badge(this._lastBadge);
      // Hand the same frame to the detached panel, if one is open. One object
      // and one callback: the data URL was built for the docked <img> anyway.
      if (this._comparing) this.layoutSplit();
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
      // A new layer means a new document rectangle, so any zoom into the old
      // one is meaningless.
      this.view = { zoom: null, cx: 0.5, cy: 0.5 };
      if (!this.params.paletteLocked) this.syncPaletteFromImage();
      this.updateZoomBar();
      this.refreshHistogram();
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
    // The only cancellable operation: runBatch tests the flag between layers,
    // which is the one point at which stopping leaves nothing half-built.
    await this.guard(
      `Batching ${preview.count} layers…`,
      async () => {
        const res = await BATCH.runBatch(this.engine, this.params, {
          scope: this.params.batchScope,
          sharedPalette: this.params.batchSharedPalette,
          onItem: (i, total, name) => this.status(`Batch ${i + 1}/${total}: ${name}`, "busy"),
          onProgress: (t) => this.progress(t),
          shouldCancel: () => this._cancel,
        });

        // The engine now holds the last batched layer, not what the panel was
        // previewing, so drop the stale preview rather than showing a lie.
        this.engine.sourceLayerId = null;

        const parts = [`Batched ${res.done} of ${res.total} layers.`];
        if (res.palette) parts.push(`Shared palette: ${res.palette.join(" ")}.`);
        if (res.cancelled) {
          parts.push(`Stopped early; the ${res.total - res.done} remaining layers are untouched.`);
        }
        if (res.failures.length) {
          parts.push(
            `${res.failures.length} failed: ` +
              res.failures.map((f) => `${f.name} (${f.error})`).join("; ")
          );
        }
        this.notice(parts.join(" "), res.failures.length || res.cancelled ? "warn" : "");
      },
      { cancellable: true }
    );
  }

  /* ---------------------------------------------------- preview size */

  /**
   * Drag the bar under the preview to resize it; double-click to go back to
   * the automatic size.
   *
   * Worth saying plainly, because it is the first thing anyone tries: in a
   * 340px-wide panel a landscape image is limited by the panel's *width*, so
   * making the box taller gains nothing. It helps for portrait artwork, and it
   * is genuinely useful in the other direction - dragging it small buys back
   * space for the controls. To see a halftone properly large, open the
   * "Halftone Preview" panel and float it.
   */
  bindPreviewGrip() {
    const grip = this.$("preview-grip");
    if (!grip) return;
    let dragging = false;
    let startY = 0;
    let startH = 0;

    grip.addEventListener("pointerdown", (e) => {
      if (!this.engine.hasSource()) return;
      dragging = true;
      startY = e.clientY;
      startH = this.previewBoxHeight();
      grip.className = "preview-grip dragging";
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is an optimisation, not a requirement */
      }
      e.preventDefault();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      // Never more than 70% of the panel: past that there is nothing left to
      // scroll and the pinned preview has eaten the thing it exists to serve.
      const max = Math.max(PREVIEW_HEIGHT_MIN, Math.round(this.panelSize().height * 0.7));
      this.ui.previewHeight = clampInt(startH + (e.clientY - startY), PREVIEW_HEIGHT_MIN, max);
      this.applyPreviewHeight();
      this.drawPreview();
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      grip.className = "preview-grip";
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      this.persistSession();
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);

    grip.addEventListener("dblclick", () => {
      this.ui.previewHeight = null;
      this.applyPreviewHeight();
      this.drawPreview();
      this.persistSession();
    });
  }

  /**
   * Pin the box to the height the user dragged it to - and only then.
   *
   * Left to itself the box shrink-wraps the frame, so a landscape image sits in
   * a landscape box with no dead space. Forcing a height unconditionally put
   * black bands above and below every render, which is a worse default than the
   * one it was trying to stabilise.
   */
  applyPreviewHeight() {
    const wrap = this.$("preview-wrap");
    if (!wrap) return;
    // In full-preview mode the box is sized by the layout, not by the grip.
    wrap.style.height = !this.theatre && this.ui.previewHeight ? this.ui.previewHeight + "px" : "";
  }

  /* ------------------------------------------------- full preview */

  /**
   * Give the whole panel to the picture.
   *
   * This is the honest replacement for a second, detached panel. That was
   * declared as its own entrypoint with its own HTML file, which is not how UXP
   * loads panels - a plugin has one document - so it opened empty. Rather than
   * guess at an API this environment cannot verify against Adobe's
   * documentation, the same need is met with something that cannot fail: hide
   * the chrome and the controls, float the panel, size it to taste. The zoom bar
   * stays, because a large view without 1:1 is only a bigger thumbnail.
   */
  toggleTheatre() {
    this.theatre = !this.theatre;
    const app = this.$("app");
    if (app) app.className = this.theatre ? "theatre" : "";
    const btn = this.$("btn-theatre");
    if (btn) btn.className = "zoom-btn zoom-word" + (this.theatre ? " active" : "");
    this.applyPreviewHeight();
    this.updateZoomBar();
    // The box changed shape, so a fitted view has a different fit.
    this.drawPreview();
    if (this._comparing) this.layoutSplit();
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

  /* ---------------------------------------------------- plate export */

  /**
   * One image file per ink, for a printer.
   *
   * This is what a screen printer or a risograph shop asks for: not the
   * composite, but each ink on its own, black-on-white, at the document's real
   * size, so it can be burned to a screen or sent to a drum. The separated
   * output already computes exactly these coverage masks - this writes them out
   * instead of turning them into fill layers.
   *
   * Black on white rather than the ink's own colour, because that is what an
   * imagesetter expects: the plate says *where* the ink goes, and the press
   * decides what colour it is. The paper plate is skipped for the same reason -
   * paper is not an ink.
   */
  async exportPlates() {
    if (!this.engine.hasSource()) {
      this.notice("Load a layer first — there are no plates to write yet.", "warn");
      return;
    }
    if (this.params.mode === "dither") {
      this.notice(
        "Plate export covers halftone mode only. A dither picks one colour per " +
          "pixel, so its separations are not printable screens.",
        "warn"
      );
      return;
    }

    await this.guard("Building plates…", async () => {
      const doc = this.documentSize();
      const sep = this.engine.renderSeparated(this.params, doc);
      const base = (this.sourceInfo && this.sourceInfo.layerName) || "halftone";

      const files = [];
      for (let i = 0; i < sep.masks.length; i++) {
        if (i === sep.paperIndex) continue; // paper is not an ink
        const hex = sep.palette[i];
        const rgba = maskToPlate(sep.masks[i], doc.width, doc.height);
        files.push({
          name: FILES.safeName(`${base} plate ${files.length + 1} ${hex.replace("#", "")}`, "png"),
          bytes: encodePNG(rgba, doc.width, doc.height),
          hex,
        });
      }

      if (!files.length) {
        this.notice("This palette has no ink beyond the paper, so there is nothing to plate.", "warn");
        return;
      }

      const res = await FILES.saveFilesToFolder(files);
      if (!res) {
        this.notice("Plate export cancelled.");
        return;
      }
      this.notice(
        `Wrote ${res.written.length} plates to ${res.folder} at ${doc.width}x${doc.height}: ` +
          files.map((f) => f.hex).join(" ") +
          ". Each is that ink alone, black on white."
      );
    });
  }

  /* --------------------------------------------------------- compare */

  /**
   * Compare: the untouched source over the render, split by a draggable handle.
   *
   * A hold-to-swap button could only ever show you one of the two, which is not
   * comparing - you are left doing it from memory. Here both halves are the same
   * frame at the same zoom with a seam through the middle, so a difference in
   * dot size or colour shows up right at the edge where the eye is good at it.
   */
  bindCompare() {
    this.on("btn-compare", "click", () => this.toggleCompare());

    const handle = this.$("split-handle");
    if (!handle) return;
    let dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      dragging = true;
      this.$("split").className = "split show dragging";
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is an optimisation, not a requirement */
      }
      if (e.preventDefault) e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const wrap = this.$("preview-wrap");
      const r = wrap.getBoundingClientRect();
      if (!r.width) return;
      this._splitAt = clamp01((e.clientX - r.left) / r.width);
      this.layoutSplit();
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      this.$("split").className = "split show";
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  toggleCompare() {
    if (!this.engine.hasSource()) {
      this.notice("Load a layer first — there is nothing to compare against.", "warn");
      return;
    }
    this._comparing = !this._comparing;
    const btn = this.$("btn-compare");
    if (btn) btn.className = "btn btn-small" + (this._comparing ? " btn-primary" : "");
    if (this._comparing && this._splitAt === undefined) this._splitAt = 0.5;
    this.layoutSplit();
  }

  /**
   * Position the overlay.
   *
   * The source is drawn at exactly the geometry the render occupies inside the
   * box - same size, same offset - so the seam lines up with the picture instead
   * of with the box. Letterboxing makes those two different.
   */
  layoutSplit() {
    const split = this.$("split");
    if (!split) return;
    if (!this._comparing || !this.engine.hasSource()) {
      split.className = "split";
      return;
    }

    const img = this.$("preview");
    const wrap = this.$("preview-wrap");
    const clip = this.$("split-clip");
    const shot = this.$("split-img");
    const handle = this.$("split-handle");

    split.className = "split show";
    shot.src = this.sourceDataURL();

    /*
     * Where the rendered frame actually sits inside the box.
     *
     * Validated, because this is the code that wrote `width: -30150px` into the
     * document on Photoshop 2026 - the old guard was `frame.width` being
     * truthy, and -30150 is truthy. When the host will not say where the frame
     * is, the overlay is left to the stylesheet, which centres it on the same
     * rules as the render underneath it. That is not pixel-exact, but it is the
     * same picture in the same place; a negative width is neither.
     */
    const box = GEO.rectOf(wrap);
    const frame = GEO.rectOf(img);
    if (box && frame) {
      shot.style.left = Math.round(frame.left - box.left) + "px";
      shot.style.top = Math.round(frame.top - box.top) + "px";
      shot.style.width = Math.round(frame.width) + "px";
      shot.style.height = Math.round(frame.height) + "px";
    } else {
      shot.style.left = "";
      shot.style.top = "";
      shot.style.width = "";
      shot.style.height = "";
    }
    const pct = Math.round(this._splitAt * 100);
    clip.style.width = pct + "%";
    handle.style.left = pct + "%";
  }

  /**
   * The source shown through the same viewport as the render.
   *
   * Comparing a zoomed halftone against a fit-to-box original would be
   * meaningless, so the source is cropped and scaled to match the current plan
   * exactly. Cached, because it only changes when the layer or the view does.
   */
  sourceDataURL() {
    const box = this.outputBox();
    const plan = this.renderPlan(box);
    const key = `${this.engine.sourceId}|${plan.width}x${plan.height}|${
      plan.view ? `${plan.view.x},${plan.view.y},${plan.view.width},${plan.view.height}` : "full"
    }`;
    if (this._sourceURL && this._sourceURL.key === key) return this._sourceURL.url;

    const small = downscale(this.engine.source, plan.width, plan.height);
    let frame = small;
    if (plan.view) {
      const v = plan.view;
      const out = new Uint8ClampedArray(v.width * v.height * 4);
      for (let y = 0; y < v.height; y++) {
        const sy = y + v.y;
        if (sy < 0 || sy >= small.height) continue;
        const so = (sy * small.width + v.x) * 4;
        out.set(small.data.subarray(so, so + v.width * 4), y * v.width * 4);
      }
      frame = { data: out, width: v.width, height: v.height };
    }
    const url = toDataURL(frame.data, frame.width, frame.height);
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
      await META.saveSession(this.params, this.ui);
    } catch (e) {
      /* best effort */
    }
  }

  /**
   * Run an async Photoshop operation with busy state, progress and a single
   * place where errors turn into a readable message.
   */
  async guard(label, fn, opts = {}) {
    if (this._busy) return;
    this._busy = true;
    this._cancel = false;
    this.setButtonsEnabled(false);
    this.showCancel(!!opts.cancellable);
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
      this.showCancel(false);
      this.setButtonsEnabled(true);
      this.progress(0, false);
      this.refreshContext();
    }
  }

  /**
   * Ask the running operation to stop.
   *
   * The flag is only ever read between layers, never mid-layer: a batch that
   * stopped halfway through building a group would leave a Smart Object with no
   * render over it. So the button says "stop after this layer" and means it -
   * the layer in flight is finished properly, and every layer already done stays
   * done. Nothing is rolled back, because nothing is half-built.
   */
  requestCancel() {
    if (!this._busy) return;
    this._cancel = true;
    this.status("Stopping after the current layer…", "busy");
    this.showCancel(false);
  }

  /** The cancel button only exists while there is something to cancel. */
  showCancel(visible) {
    const b = this.$("btn-cancel");
    if (!b) return;
    b.className = "btn btn-small btn-cancel" + (visible ? " show" : "");
    if (visible) b.removeAttribute("disabled");
    else b.setAttribute("disabled", "true");
    const row = b.parentNode;
    if (row) row.className = "toolbar toolbar-tail" + (visible ? "" : " toolbar-hidden");
  }

  setButtonsEnabled(enabled) {
    for (const id of [
      "btn-load",
      "btn-apply",
      "btn-update",
      "btn-reset",
      "btn-batch",
      "btn-svg",
      "btn-plates",
      // btn-cancel is deliberately absent: it is the one control that must stay
      // usable while an operation is running.
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
  grade: ["toneCurve", "contrast", "gamma", "exposure", "gradeBias"],
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

/** Clamp to an integer inside [lo, hi]. */
/**
 * A coverage mask as a printable plate: black where the ink lands, white where
 * it does not, fully opaque. Inverted from the mask's own sense because a mask
 * is "how much shows through" while a plate is "how much ink".
 */
function maskToPlate(mask, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const v = 255 - mask[i];
    out[p] = v;
    out[p + 1] = v;
    out[p + 2] = v;
    out[p + 3] = 255;
  }
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Window state read back from disk is as untrusted as anything else on disk:
 * a stale or hand-edited value must not be able to wedge the preview at 4000px.
 */
function sanitizeUI(raw) {
  const out = { previewHeight: null };
  if (raw && raw.previewHeight) {
    out.previewHeight = clampInt(raw.previewHeight, PREVIEW_HEIGHT_MIN, 2000);
  }
  return out;
}

function padHexes(hexes, count) {
  const out = (hexes || []).slice(0, count);
  while (out.length < count) out.push(out.length ? out[out.length - 1] : "#808080");
  return out;
}

module.exports = { Panel };
