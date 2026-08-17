"use strict";

/**
 * Builds two browser-runnable pages.
 *
 *   npm run playground
 *
 * playground.html    - the rendering engine with a purpose-built UI, for judging
 *                      the render and trying settings.
 * panel-preview.html - index.html's own markup driven by the real panel.js,
 *                      against stub host modules. This one exists to test the
 *                      *panel* rather than the engine: layout, scrolling, which
 *                      controls appear in which mode. Photoshop calls are stubs,
 *                      so Apply does nothing, but everything up to the moment a
 *                      button is pressed is the genuine article.
 *
 * This is possible only because src/engine, src/state, src/presets, src/ui and
 * src/util have no dependency on the `photoshop` module - the same property that
 * makes them testable in Node. Everything under src/photoshop is excluded; the
 * playground reads an image from a file input instead of from a layer, and shows
 * the result in an <img> instead of writing it back.
 *
 * The point is to be able to judge the render, and to test the panel's controls
 * and presets, without a Photoshop install in the loop at all.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/**
 * Follow the relative requires out from a set of entry points.
 *
 * This used to be two hand-written lists, and they went stale exactly as you
 * would expect: src/engine/jitter.js was added, nobody remembered to register
 * it, and the preview page threw "Module not found" on load - so every layout
 * assertion ran against a panel that had never built. Crawling the requires
 * means the bundle cannot disagree with the source about what the source needs.
 *
 * Bare requires ("photoshop", "uxp") are left alone; those are the host modules
 * the stubs below stand in for.
 */
function collect(entries, exclude = []) {
  const seen = new Set(exclude);
  const order = [];

  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const dir = path.posix.dirname(rel);
    const src = read(rel);
    // Deliberately a regex and not a parser: every require in this codebase is
    // a top-level string literal, and a parser would be more to keep working.
    for (const m of src.matchAll(/require\(\s*"(\.[^"]+)"\s*\)/g)) {
      visit(path.posix.normalize(path.posix.join(dir, m[1])));
    }
    // Post-order, so a module is defined after everything it depends on. The
    // shim is lazy so the order is cosmetic, but a readable bundle is worth it.
    order.push(rel);
  };

  entries.forEach(visit);
  return order;
}

/** Everything the engine-only playground needs. */
const MODULES = collect([
  "src/engine/pipeline.js",
  "src/engine/dither.js",
  "src/state/params.js",
  "src/presets/presets.js",
  "src/ui/controls.js",
  "src/util/png.js",
]);

/** Minimal CommonJS loader: enough to resolve the relative requires we use. */
const SHIM = `
(function () {
  var registry = {};
  var cache = {};

  function normalise(p) {
    var parts = p.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === "" || s === ".") continue;
      if (s === "..") out.pop();
      else out.push(s);
    }
    return out.join("/");
  }

  function resolve(from, request) {
    if (request.charAt(0) !== ".") return request;
    var dir = from.split("/").slice(0, -1).join("/");
    return normalise(dir + "/" + request);
  }

  window.__define = function (id, fn) {
    registry[id] = fn;
  };

  window.__require = function (from, request) {
    var id = resolve(from, request);
    if (cache[id]) return cache[id].exports;
    var mod = registry[id];
    if (!mod) throw new Error("Module not found: " + id + " (from " + from + ")");
    var m = { exports: {} };
    cache[id] = m;
    mod(m, m.exports, function (r) {
      return window.__require(id, r);
    });
    return m.exports;
  };
})();
`;

function wrapModule(rel) {
  const code = read(rel);
  return (
    `window.__define(${JSON.stringify(rel)}, function (module, exports, require) {\n` +
    code +
    `\n});\n`
  );
}

/**
 * What the real panel needs on top of that - the Photoshop layer, mostly.
 *
 * Both panel entrypoints are listed. The crawler follows requires, so it can
 * only start from a root someone names, and the detached preview panel is a
 * second root rather than something the docked panel requires: they meet at the
 * frame bus, which is the whole design. Leaving it out builds a page that
 * cannot construct the second panel at all.
 */
const PANEL_MODULES = collect(["src/ui/panel.js", "src/ui/previewpanel.js"], MODULES);

/**
 * Stand-ins for the two modules only Photoshop provides. Deliberately minimal:
 * enough for the panel to start, report "no document", and build every control.
 */
const HOST_STUBS = `
window.__define("photoshop", function (module) {
  var doc = null;
  module.exports = {
    app: {
      get activeDocument() { return doc; },
      foregroundColor: { rgb: { red: 236, green: 62, blue: 50 } },
      version: "preview"
    },
    core: { executeAsModal: function (fn) { return Promise.resolve(fn({ reportProgress: function () {} })); } },
    action: {
      batchPlay: function () { return Promise.resolve([{}]); },
      addNotificationListener: function () {}
    },
    imaging: {
      getPixels: function () { return Promise.reject(new Error("no host")); },
      putPixels: function () { return Promise.resolve(); },
      putLayerMask: function () { return Promise.resolve(); },
      createImageDataFromBuffer: function (b, o) { return { width: o.width, height: o.height, dispose: function () {} }; }
    }
  };
});
window.__define("uxp", function (module) {
  var store = {};
  module.exports = {
    storage: {
      formats: { binary: "binary", utf8: "utf8" },
      localFileSystem: {
        getDataFolder: function () {
          return Promise.resolve({
            getEntry: function (n) {
              return store[n] === undefined
                ? Promise.reject(new Error("missing"))
                : Promise.resolve({ read: function () { return Promise.resolve(store[n]); } });
            },
            createFile: function (n) {
              return Promise.resolve({ write: function (t) { store[n] = t; return Promise.resolve(); } });
            }
          });
        },
        getFileForOpening: function () { return Promise.resolve(null); },
        getFileForSaving: function () { return Promise.resolve(null); }
      }
    }
  };
});
`;

const PLAYGROUND_UI = `
(function () {
  var require = function (r) { return window.__require("src/playground.js", r); };

  var C = require("./ui/controls.js");
  var P = require("./state/params.js");
  var PRESETS = require("./presets/presets.js");
  var PIPE = require("./engine/pipeline.js");
  var PNG = require("./util/png.js");
  var DITHER = require("./engine/dither.js");

  var ALGO_LABELS = {};
  var ALGO_FAMILY = {};
  DITHER.ALGORITHMS.forEach(function (a) {
    ALGO_LABELS[a.id] = a.label;
    ALGO_FAMILY[a.id] = a.family;
  });

  var engine = new PIPE.HalftoneEngine();
  var params = P.defaultParams();
  var controls = {};
  var sectionOpen = {};
  var lastMs = 0;
  var raf = null;
  var timer = null;
  var sourceURL = null;
  var renderedURL = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- */

  function buildSections() {
    var host = $("sections");
    host.textContent = "";
    controls = {};
    P.SECTIONS.forEach(function (sec) {
      if (sec.id === "batch" || sec.id === "output") return; // Photoshop-only
      if (!P.sectionVisible(sec, params)) return;
      var open = sectionOpen[sec.id] !== false;
      var s = C.createSection(sec.id, sec.label, open);
      s.onToggle = function (isOpen) { sectionOpen[sec.id] = isOpen; };
      P.PARAM_DEFS.forEach(function (def) {
        if (def.section !== sec.id) return;
        if (!P.isVisible(def, params)) return;
        s.body.appendChild(buildControl(def));
      });
      host.appendChild(s.el);
    });
  }

  function affectsLayout(key) {
    return key === "mode" || key === "scaleMode" || key === "tonalMapping" ||
           key === "sharpen" || key === "screenMode";
  }

  function buildControl(def) {
    var commit = function (value) { setParam(def.key, value); };
    var ctl;
    switch (def.type) {
      case "slider": ctl = C.createSlider(def, params[def.key], commit); break;
      case "choice": ctl = C.createChoice(def, params[def.key], commit); break;
      case "chips":
        ctl = C.createChipChoice(def, params[def.key], commit, {
          labels: ALGO_LABELS,
          groups: def.key === "ditherAlgorithm" ? DITHER.ALGORITHM_FAMILIES : null,
          groupOf: def.key === "ditherAlgorithm" ? function (id) { return ALGO_FAMILY[id]; } : null
        });
        break;
      case "toggle": ctl = C.createToggle(def, params[def.key], commit); break;
      case "color":
        ctl = C.createColorField(def, params[def.key], commit, function () { return null; });
        break;
      case "palette":
        ctl = C.createPalette({
          value: params.palette,
          locked: params.lockedSwatches,
          onChange: function (hexes, locked) {
            params.palette = hexes;
            params.lockedSwatches = locked || [];
            params.paletteLocked = true;
            params.colorCount = Math.min(8, Math.max(2, hexes.length));
            if (controls.colorCount) controls.colorCount.set(params.colorCount);
            if (controls.paletteLocked) controls.paletteLocked.set(true);
            schedule();
          },
          onExtract: extractPalette,
          getForeground: function () { return null; }
        });
        break;
      default: ctl = { el: C.el("div"), set: function () {} };
    }
    controls[def.key] = ctl;
    return ctl.el;
  }

  function setParam(key, value) {
    if (params[key] === value) return;
    params[key] = value;
    if (key === "colorCount" && params.paletteLocked) syncPaletteToCount();
    if (key === "paletteLocked" && !value) syncPaletteFromImage();
    if (affectsLayout(key)) { buildSections(); syncControls(); }
    schedule();
  }

  function syncControls() {
    P.PARAM_DEFS.forEach(function (def) {
      var c = controls[def.key];
      if (c && c.set) c.set(params[def.key], params.lockedSwatches);
    });
  }

  function mergeLocked(extracted) {
    var locks = params.lockedSwatches || [];
    if (!locks.length) return extracted;
    var out = extracted.slice();
    locks.forEach(function (i) {
      if (i < out.length && params.palette[i]) out[i] = params.palette[i];
    });
    return out;
  }

  function extractPalette() {
    if (!engine.hasSource()) { notice("Load an image first."); return; }
    params.palette = mergeLocked(engine.extractPaletteHex(params));
    params.paletteLocked = true;
    if (controls.palette) controls.palette.set(params.palette, params.lockedSwatches);
    if (controls.paletteLocked) controls.paletteLocked.set(true);
    schedule();
  }

  function syncPaletteToCount() {
    if (!engine.hasSource()) return;
    params.palette = mergeLocked(engine.extractPaletteHex(params));
    if (controls.palette) controls.palette.set(params.palette, params.lockedSwatches);
  }

  function syncPaletteFromImage() {
    if (!engine.hasSource()) return;
    params.palette = mergeLocked(engine.extractPaletteHex(params));
    if (controls.palette) controls.palette.set(params.palette, params.lockedSwatches);
  }

  /* ---------------------------------------------------------------- */

  function schedule() {
    if (!engine.hasSource()) return;
    if (lastMs > 45) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; draw(); }, 90);
      return;
    }
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = null; draw(); });
  }

  function previewSize() {
    var wrap = $("preview-wrap");
    var avail = Math.max(200, Math.min(900, wrap.clientWidth - 2));
    var scale = Math.min(1, avail / engine.source.width);
    return {
      width: Math.max(1, Math.round(engine.source.width * scale)),
      height: Math.max(1, Math.round(engine.source.height * scale))
    };
  }

  function draw() {
    if (!engine.hasSource()) return;
    var t0 = Date.now();
    try {
      var size = previewSize();
      var out = engine.render(params, {
        width: size.width, height: size.height, maxDitherGrid: 900
      });
      renderedURL = PNG.toDataURL(out.data, out.width, out.height);
      $("preview").src = renderedURL;
      $("preview").className = "preview visible";
      $("preview-empty").className = "preview-empty hidden";
      lastMs = Date.now() - t0;
      var unit = params.mode === "dither" ? "px" : "cells";
      var screens = out.angles ? (" · " + out.angles.length + " screens @ " + out.angles.join("/") + "°") : "";
      $("preview-badge").textContent =
        (engine.stats.cells || 0) + " " + unit + screens + " · " + lastMs + "ms" +
        (out.exact ? "" : " · approx");
      notice("");
    } catch (e) {
      lastMs = Date.now() - t0;
      notice("Render failed: " + e.message);
      if (window.console) console.error(e);
    }
  }

  function notice(text) {
    var n = $("notice");
    n.textContent = text || "";
    n.className = text ? "notice show error" : "notice";
  }

  /* ---------------------------------------------------------------- */

  function loadImage(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement("canvas");
      // Cap the source the same way the plugin caps its read from Photoshop.
      var cap = 2600;
      var s = Math.min(1, cap / Math.max(img.width, img.height));
      cv.width = Math.round(img.width * s);
      cv.height = Math.round(img.height * s);
      var ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      var data = ctx.getImageData(0, 0, cv.width, cv.height);
      engine.setSource({
        data: new Uint8ClampedArray(data.data),
        width: cv.width,
        height: cv.height
      });
      sourceURL = cv.toDataURL("image/png");
      if (!params.paletteLocked) syncPaletteFromImage();
      $("file-name").textContent = file.name + "  " + cv.width + "x" + cv.height;
      draw();
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { notice("Could not decode that image."); };
    img.src = url;
  }

  function renderPresets() {
    var host = $("preset-list");
    host.textContent = "";
    PRESETS.BUILTIN_PRESETS.forEach(function (preset) {
      var chip = C.el("button", "preset-chip", preset.name);
      chip.addEventListener("click", function () {
        params = PRESETS.presetToParams(preset);
        if (!params.paletteLocked) syncPaletteFromImage();
        buildSections();
        syncControls();
        schedule();
      });
      host.appendChild(chip);
    });
  }

  /* ---------------------------------------------------------------- */

  function init() {
    buildSections();
    renderPresets();

    $("file").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) loadImage(e.target.files[0]);
    });

    var wrap = $("preview-wrap");
    ["dragenter", "dragover"].forEach(function (t) {
      wrap.addEventListener(t, function (e) {
        e.preventDefault();
        wrap.className = "preview-wrap dragging";
      });
    });
    ["dragleave", "drop"].forEach(function (t) {
      wrap.addEventListener(t, function (e) {
        e.preventDefault();
        wrap.className = "preview-wrap";
      });
    });
    wrap.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadImage(f);
    });

    $("btn-reset").addEventListener("click", function () {
      params = P.defaultParams();
      buildSections();
      syncControls();
      schedule();
    });

    $("btn-save").addEventListener("click", function () {
      if (!renderedURL) return;
      var full = engine.render(params);
      var a = document.createElement("a");
      a.href = PNG.toDataURL(full.data, full.width, full.height);
      a.download = "halftone.png";
      a.click();
    });

    var cmp = $("btn-compare");
    cmp.addEventListener("pointerdown", function () {
      if (sourceURL) $("preview").src = sourceURL;
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (t) {
      cmp.addEventListener(t, function () {
        if (renderedURL) $("preview").src = renderedURL;
      });
    });

    window.addEventListener("resize", function () { schedule(); });

    // A built-in test image, so the page does something the moment it opens.
    makeSampleImage();
  }

  function makeSampleImage() {
    var w = 900, h = 620;
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    var g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#fdf6e3");
    g.addColorStop(0.5, "#e8804f");
    g.addColorStop(1, "#141021");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    var glow = ctx.createRadialGradient(w * 0.38, h * 0.42, 10, w * 0.38, h * 0.42, h * 0.45);
    glow.addColorStop(0, "rgba(255,214,102,0.95)");
    glow.addColorStop(1, "rgba(255,214,102,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    var bar = ctx.createLinearGradient(0, 0, w, 0);
    bar.addColorStop(0, "#000");
    bar.addColorStop(1, "#fff");
    ctx.fillStyle = bar;
    ctx.fillRect(0, h - 70, w, 70);
    var data = ctx.getImageData(0, 0, w, h);
    engine.setSource({ data: new Uint8ClampedArray(data.data), width: w, height: h });
    sourceURL = cv.toDataURL("image/png");
    $("file-name").textContent = "built-in sample  " + w + "x" + h;
    draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;

const EXTRA_CSS = `
body { padding: 0; }
.pg { display: flex; gap: 12px; padding: 12px; align-items: flex-start; }
.pg-left { flex: 1 1 auto; min-width: 0; position: sticky; top: 12px; }
.pg-right { flex: 0 0 340px; max-height: calc(100vh - 24px); overflow-y: auto; }
.preview-wrap { min-height: 300px; }
.preview-wrap.dragging { border-color: var(--accent); }
.pg-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.pg-title { font-size: 13px; font-weight: 600; }
.pg-sub { color: var(--text-dim); font-size: 10px; }
input[type=file] { color: var(--text-dim); font-size: 10px; font-family: inherit; }
@media (max-width: 900px) {
  .pg { flex-direction: column; }
  .pg-right { flex: 1 1 auto; width: 100%; max-height: none; }
  .pg-left { position: static; width: 100%; }
}
`;

function build() {
  const modules = MODULES.map(wrapModule).join("\n");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Halftone Studio — playground</title>
<style>
${read("src/ui/styles.css")}
${EXTRA_CSS}
</style>
</head>
<body>
<div class="pg">
  <div class="pg-left">
    <div class="pg-head">
      <div class="pg-title">Halftone Studio</div>
      <div class="pg-sub">engine playground — no Photoshop required</div>
    </div>
    <div class="pg-head">
      <input type="file" id="file" accept="image/*" />
      <span class="pg-sub" id="file-name"></span>
    </div>
    <div id="preview-wrap" class="preview-wrap">
      <div id="preview-empty" class="preview-empty">
        Drop an image here, or use the file picker above
      </div>
      <img id="preview" class="preview" />
      <div id="preview-badge" class="preview-badge"></div>
    </div>
    <div class="toolbar" style="margin-top:8px">
      <button id="btn-compare" class="btn">Hold to Compare</button>
      <button id="btn-save" class="btn btn-primary">Save full-size PNG</button>
      <button id="btn-reset" class="btn">Reset</button>
    </div>
    <div id="notice" class="notice"></div>
    <div class="preset-bar" style="margin-top:8px">
      <div id="preset-list" class="preset-list"></div>
    </div>
  </div>
  <div class="pg-right">
    <div id="sections" class="sections"></div>
  </div>
</div>

<script>
${SHIM}
</script>
<script>
${modules}
</script>
<script>
${PLAYGROUND_UI}
</script>
</body>
</html>
`;

  const out = path.join(ROOT, "playground.html");
  fs.writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`playground.html      ${kb} KB  (${MODULES.length} modules inlined)`);

  buildPanelPreview();
}

/**
 * index.html's own body, driven by the real panel.js.
 *
 * The entry point is inlined rather than loaded, because main.js lives at the
 * plugin root specifically so UXP resolves its require from there - and that
 * distinction is meaningless here.
 */
function buildPanelPreview() {
  const all = MODULES.concat(PANEL_MODULES);
  const modules = all.map(wrapModule).join("\n");

  const indexHtml = read("index.html");
  const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(indexHtml);
  let body = bodyMatch ? bodyMatch[1] : "";
  body = body.replace(/<script[\s\S]*?<\/script>/g, "");

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Halftone Studio — panel preview</title>
<style>
${read("src/ui/styles.css")}
</style>
</head>
<body>
${body}
<script>
${SHIM}
</script>
<script>
${HOST_STUBS}
</script>
<script>
${modules}
</script>
<script>
(function () {
  var Panel = window.__require("main.js", "./src/ui/panel.js").Panel;
  var panel = new Panel(document);
  window.halftonePanel = panel;
  panel.init().catch(function (e) {
    var n = document.getElementById("notice");
    if (n) { n.textContent = String(e && e.message || e); n.className = "notice show error"; }
    if (window.console) console.error(e);
  });
})();
</script>
</body>
</html>
`;

  const out = path.join(ROOT, "panel-preview.html");
  fs.writeFileSync(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`panel-preview.html   ${kb} KB  (${all.length} modules inlined)`);
}

build();
