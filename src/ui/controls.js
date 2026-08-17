"use strict";

/**
 * Control widgets, built by hand from divs and pointer events.
 *
 * UXP ships its own Spectrum web components, but their availability and API
 * differ between host versions. Everything here uses only elements and events
 * that UXP has supported since v6 (div, button, input[type=text], pointer
 * events), which makes the panel's behaviour identical wherever it runs.
 *
 * Shared conventions:
 *   - drag a slider to scrub, hold Shift for fine control
 *   - double click a slider, or press its reset arrow, to restore the default
 *   - the numeric field next to each slider is editable
 */

const { normaliseCurve, evalCurve, isIdentityCurve } = require("../engine/grade.js");

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function formatValue(def, v) {
  const d = def.decimals === undefined ? 0 : def.decimals;
  return v.toFixed(d) + (def.unit || "");
}

function parseValue(def, text) {
  const n = parseFloat(String(text).replace(/[^0-9eE+\-.]/g, ""));
  return Number.isFinite(n) ? clamp(n, def.min, def.max) : null;
}

/**
 * A label + slider + numeric field + reset row.
 *
 * @param {object} def ParamDef
 * @param {number} value
 * @param {(v:number, committed:boolean)=>void} onChange
 *        `committed` is false while dragging and true on release, so callers
 *        can render cheaply during the drag and do expensive work once.
 * @returns {{el: HTMLElement, set: (v:number)=>void}}
 */
function createSlider(def, value, onChange) {
  const row = el("div", "ctl");
  const label = el("div", "ctl-label", def.label);
  if (def.hint) label.title = def.hint;

  const slider = el("div", "slider");
  const track = el("div", "slider-track");
  const fill = el("div", "slider-fill");
  const thumb = el("div", "slider-thumb");
  track.appendChild(fill);
  track.appendChild(thumb);
  slider.appendChild(track);

  const input = el("input", "ctl-value");
  input.type = "text";

  const reset = el("button", "ctl-reset", "↺");
  reset.title = `Reset to ${formatValue(def, def.def)}`;

  row.appendChild(label);
  row.appendChild(slider);
  row.appendChild(input);
  row.appendChild(reset);

  let current = value;
  let dragging = false;

  function paint() {
    const t = (current - def.min) / (def.max - def.min);
    const pct = clamp(t, 0, 1) * 100;
    fill.style.width = pct + "%";
    thumb.style.left = pct + "%";
    if (document.activeElement !== input) input.value = formatValue(def, current);
    const modified = Math.abs(current - def.def) > (def.step || 1) / 1000;
    row.className = "ctl" + (modified ? " modified" : "");
    label.className = "ctl-label" + (modified ? " modified" : "");
  }

  function set(v, committed, silent) {
    const stepped = def.step ? Math.round(v / def.step) * def.step : v;
    const next = clamp(roundFloat(stepped), def.min, def.max);
    const changed = next !== current;
    current = next;
    paint();
    if (!silent && (changed || committed)) onChange(current, !!committed);
  }

  function valueFromEvent(e) {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return current;
    const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    return def.min + t * (def.max - def.min);
  }

  let fineAnchor = null;
  slider.addEventListener("pointerdown", (e) => {
    dragging = true;
    slider.className = "slider dragging";
    try {
      slider.setPointerCapture(e.pointerId);
    } catch (err) {
      /* capture is an optimisation, not a requirement */
    }
    fineAnchor = e.shiftKey ? { x: e.clientX, v: current } : null;
    if (!fineAnchor) set(valueFromEvent(e), false);
    e.preventDefault();
  });

  slider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (e.shiftKey) {
      // Shift engages fine scrubbing relative to where Shift was pressed.
      if (!fineAnchor) fineAnchor = { x: e.clientX, v: current };
      const rect = track.getBoundingClientRect();
      const perPx = rect.width ? (def.max - def.min) / rect.width : 0;
      set(fineAnchor.v + (e.clientX - fineAnchor.x) * perPx * 0.2, false);
    } else {
      fineAnchor = null;
      set(valueFromEvent(e), false);
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    fineAnchor = null;
    slider.className = "slider";
    try {
      slider.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    onChange(current, true);
  };
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);

  slider.addEventListener("dblclick", () => set(def.def, true));
  reset.addEventListener("click", () => set(def.def, true));

  input.addEventListener("change", () => {
    const v = parseValue(def, input.value);
    if (v === null) paint();
    else set(v, true);
  });
  input.addEventListener("blur", () => paint());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = parseValue(def, input.value);
      if (v !== null) set(v, true);
      input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const mult = e.shiftKey ? 10 : 1;
      set(current + dir * (def.step || 1) * mult, true);
      e.preventDefault();
    }
  });

  paint();
  return { el: row, set: (v) => set(v, false, true) };
}

function roundFloat(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * A segmented button group. Used instead of <select>, which UXP renders
 * inconsistently.
 */
function createChoice(def, value, onChange, labels) {
  const row = el("div", "ctl");
  const label = el("div", "ctl-label", def.label);
  if (def.hint) label.title = def.hint;
  const seg = el("div", "seg");
  const buttons = {};
  const nameOf = (opt) => optionLabel(def, opt, labels);

  for (const opt of def.options) {
    const b = el("button", "seg-item", nameOf(opt));
    b.title = nameOf(opt);
    b.addEventListener("click", () => {
      set(opt);
      onChange(opt, true);
    });
    buttons[opt] = b;
    seg.appendChild(b);
  }

  function set(v) {
    for (const opt of def.options) {
      buttons[opt].className = "seg-item" + (opt === v ? " active" : "");
    }
  }

  row.appendChild(label);
  row.appendChild(seg);
  set(value);
  return { el: row, set };
}

function titleCase(s) {
  return String(s)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * The display name for one option of a choice.
 *
 * Title-casing the id is right for `circle` and `perInk`, and wrong for every
 * acronym and compound we have: it produces "Dpi", "Am", "Kmeans", "Luma709".
 * A def may therefore carry an `optionLabels` map, which wins.
 */
function optionLabel(def, opt, labels) {
  if (labels && labels[opt]) return labels[opt];
  if (def && def.optionLabels && def.optionLabels[opt]) return def.optionLabels[opt];
  return titleCase(opt);
}

/**
 * A wrapping list of chips, for choices with too many options to fit a
 * segmented bar (the dither algorithm list has two dozen).
 *
 * @param {object} def
 * @param {string} value
 * @param {(v:string, committed:boolean)=>void} onChange
 * @param {{labels?: object, groups?: {id:string,label:string}[],
 *          groupOf?: (id:string)=>string}} [meta]
 */
function createChipChoice(def, value, onChange, meta = {}) {
  const wrap = el("div");
  const label = el("div", "ctl-label", def.label);
  label.style.marginBottom = "3px";
  if (def.hint) label.title = def.hint;
  wrap.appendChild(label);

  const buttons = {};
  const groups = meta.groups && meta.groupOf ? meta.groups : null;

  const addChip = (opt, host) => {
    const text = optionLabel(def, opt, meta.labels);
    const b = el("button", "algo-chip", text);
    b.title = text;
    b.addEventListener("click", () => {
      set(opt);
      onChange(opt, true);
    });
    buttons[opt] = b;
    host.appendChild(b);
  };

  let grouped = 0;
  if (groups) {
    for (const g of groups) {
      const members = def.options.filter((o) => meta.groupOf(o) === g.id);
      if (!members.length) continue;
      wrap.appendChild(el("div", "chip-group-label", g.label));
      const row = el("div", "chip-row");
      for (const opt of members) addChip(opt, row);
      wrap.appendChild(row);
      grouped += members.length;
    }
  }
  // Ungrouped, or grouping that claimed nothing: a control that renders no
  // options at all is never the right answer, so fall back to a flat row.
  if (!groups || grouped < def.options.length) {
    const claimed = Object.keys(buttons);
    const rest = def.options.filter((o) => claimed.indexOf(o) < 0);
    if (rest.length) {
      const row = el("div", "chip-row");
      for (const opt of rest) addChip(opt, row);
      wrap.appendChild(row);
    }
  }

  function set(v) {
    for (const opt of def.options) {
      if (buttons[opt]) buttons[opt].className = "algo-chip" + (opt === v ? " active" : "");
    }
  }

  set(value);
  return { el: wrap, set };
}

/** An on/off switch. */
function createToggle(def, value, onChange) {
  const row = el("div", "ctl");
  const label = el("div", "ctl-label", def.label);
  if (def.hint) label.title = def.hint;
  const toggle = el("button", "toggle");
  toggle.appendChild(el("div", "toggle-knob"));

  function set(v) {
    toggle.className = "toggle" + (v ? " on" : "");
    toggle.dataset.value = v ? "1" : "0";
  }

  toggle.addEventListener("click", () => {
    const next = toggle.dataset.value !== "1";
    set(next);
    onChange(next, true);
  });

  row.appendChild(label);
  row.appendChild(toggle);
  const spacer = el("div");
  spacer.style.flexGrow = "1";
  spacer.style.flexShrink = "1";
  row.appendChild(spacer);
  set(value);
  return { el: row, set };
}

/**
 * Palette editor: click a swatch to type a hex value, alt/right click to pull
 * Photoshop's current foreground colour.
 *
 * @param {object} opts
 * @param {string[]} opts.value
 * @param {(hexes: string[]) => void} opts.onChange
 * @param {() => void} opts.onExtract
 * @param {() => (number[]|null)} opts.getForeground
 */
function createPalette(opts) {
  const wrap = el("div");
  const strip = el("div", "palette");
  const actions = el("div", "palette-actions");

  const mkBtn = (label, title, fn) => {
    const b = el("button", "btn btn-small", label);
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };

  actions.appendChild(mkBtn("Extract", "Re-read the palette from the layer", () => opts.onExtract()));
  actions.appendChild(
    mkBtn("＋FG", "Append Photoshop's foreground colour", () => {
      const rgb = opts.getForeground();
      if (!rgb) return;
      set(current.concat([toHex(rgb)]), locked);
      opts.onChange(current.slice(), locked.slice());
    })
  );
  actions.appendChild(mkBtn("Import", "Load an .ase or .act swatch file", () => opts.onImport && opts.onImport()));
  actions.appendChild(mkBtn("Export", "Save the palette as .ase", () => opts.onExport && opts.onExport()));

  let current = (opts.value || []).slice();
  let locked = (opts.locked || []).slice();

  function toHex(rgb) {
    return (
      "#" + ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]).toString(16).padStart(6, "0").toUpperCase()
    );
  }

  function beginEdit(index, swatchWrap, swatch) {
    const input = el("input", "swatch-input");
    input.type = "text";
    input.value = current[index];
    swatch.style.display = "none";
    swatchWrap.appendChild(input);
    input.focus();
    if (input.select) input.select();

    const finish = (commit) => {
      if (!input.parentNode) return;
      const raw = input.value;
      swatchWrap.removeChild(input);
      swatch.style.display = "";
      if (commit) {
        const norm = normalizeHex(raw);
        if (norm) {
          current[index] = norm;
          set(current, locked);
          opts.onChange(current.slice(), locked.slice());
          return;
        }
      }
      set(current, locked);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
  }

  function toggleLock(i) {
    const at = locked.indexOf(i);
    if (at >= 0) locked.splice(at, 1);
    else locked.push(i);
    set(current, locked);
    opts.onChange(current.slice(), locked.slice());
  }

  function set(hexes, lockedIdx) {
    current = (hexes || []).slice();
    if (lockedIdx) locked = lockedIdx.slice();
    locked = locked.filter((i) => i < current.length);
    strip.textContent = "";
    current.forEach((hex, i) => {
      const swatchWrap = el("div", "swatch-wrap");
      const swatch = el("div", "swatch");
      swatch.style.background = hex;
      swatch.title =
        `${hex} — click to edit, alt-click for the foreground colour, ` +
        `shift-click to ${locked.indexOf(i) >= 0 ? "unlock" : "lock"} against re-extraction`;
      swatch.addEventListener("click", (e) => {
        if (e.shiftKey) {
          toggleLock(i);
          return;
        }
        if (e.altKey) {
          const rgb = opts.getForeground();
          if (rgb) {
            current[i] = toHex(rgb);
            set(current, locked);
            opts.onChange(current.slice(), locked.slice());
          }
          return;
        }
        beginEdit(i, swatchWrap, swatch);
      });
      swatchWrap.appendChild(swatch);
      if (locked.indexOf(i) >= 0) {
        const badge = el("div", "swatch-lock");
        badge.title = "Locked: survives re-extraction";
        swatchWrap.appendChild(badge);
      }
      strip.appendChild(swatchWrap);
    });
  }

  wrap.appendChild(strip);
  wrap.appendChild(actions);
  set(current, locked);
  return { el: wrap, set, setLocked: (l) => set(current, l) };
}

function normalizeHex(c) {
  let h = String(c).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

/** A hex field that also accepts the literal "auto". */
function createColorField(def, value, onChange, getForeground) {
  const row = el("div", "ctl");
  const label = el("div", "ctl-label", def.label);
  if (def.hint) label.title = def.hint;

  const swatch = el("div", "swatch");
  const input = el("input", "ctl-value");
  input.type = "text";
  input.style.textAlign = "left";
  input.style.width = "70px";
  input.style.minWidth = "70px";

  const autoBtn = el("button", "seg-item", "Auto");
  autoBtn.style.width = "38px";
  autoBtn.style.minWidth = "38px";
  autoBtn.style.flexGrow = "0";
  autoBtn.style.flexShrink = "0";
  autoBtn.style.border = "1px solid var(--border-strong)";
  autoBtn.style.borderRadius = "2px";
  autoBtn.addEventListener("click", () => {
    set("auto");
    onChange("auto", true);
  });

  swatch.addEventListener("click", () => {
    const rgb = getForeground && getForeground();
    if (!rgb) return;
    const hex =
      "#" + ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]).toString(16).padStart(6, "0").toUpperCase();
    set(hex);
    onChange(hex, true);
  });
  swatch.title = "Use Photoshop's foreground colour";

  function set(v) {
    input.value = v;
    swatch.style.background = v === "auto" ? "transparent" : v;
    autoBtn.className = "seg-item" + (v === "auto" ? " active" : "");
  }

  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (raw.toLowerCase() === "auto") {
      set("auto");
      onChange("auto", true);
      return;
    }
    const norm = normalizeHex(raw);
    if (norm) {
      set(norm);
      onChange(norm, true);
    } else {
      set(value);
    }
  });

  row.appendChild(label);
  row.appendChild(swatch);
  row.appendChild(input);
  row.appendChild(autoBtn);
  set(value);
  return { el: row, set };
}

/* ------------------------------------------------------------------ *
 * Tone curve
 * ------------------------------------------------------------------ */

/**
 * The editor's height in pixels.
 *
 * Stated here and in the stylesheet, because the curve is drawn by positioning
 * elements and that needs a number, while the box needs a height before any of
 * them exist to measure. The two must agree; the layout test would catch them
 * drifting, since the curve would leave its box.
 */
const CURVE_H = 132;
/** How many segments the curve is drawn with. Enough to read as a line. */
const CURVE_SAMPLES = 64;
/** How close a click has to be, in fractions of the box, to grab a point. */
const CURVE_GRAB = 0.055;

/**
 * A tone curve editor.
 *
 * Built from positioned divs rather than a canvas: UXP's canvas support varies
 * by host version, and this needs to work everywhere the rest of the panel does.
 * The curve is drawn as a run of short segments and the control points are real
 * elements, which also means they can carry their own pointer handlers instead
 * of the editor doing hit-testing on every move.
 *
 * A histogram of the loaded layer sits behind it, because a curve without one is
 * guesswork - you cannot place a point on the shadows if you cannot see where
 * the shadows are.
 *
 * @param {object} def ParamDef
 * @param {number[][]} value control points
 * @param {(v:number[][], committed:boolean)=>void} onChange
 * @param {{getHistogram?: () => number[]|null}} [opts]
 */
function createCurve(def, value, onChange, opts = {}) {
  const wrap = el("div", "curve");

  const head = el("div", "curve-head");
  const label = el("div", "ctl-label", def.label);
  if (def.hint) label.title = def.hint;
  const readout = el("div", "curve-readout", "");
  const reset = el("button", "ctl-reset", "↺");
  reset.title = "Straighten the curve";
  head.appendChild(label);
  head.appendChild(readout);
  head.appendChild(reset);
  wrap.appendChild(head);

  const box = el("div", "curve-box");
  const hist = el("div", "curve-hist");
  const grid = el("div", "curve-grid");
  const diag = el("div", "curve-diag");
  const line = el("div", "curve-line");
  const dots = el("div", "curve-dots");
  box.appendChild(hist);
  box.appendChild(grid);
  box.appendChild(diag);
  box.appendChild(line);
  box.appendChild(dots);
  wrap.appendChild(box);
  wrap.appendChild(el("div", "hint", "Click to add a point · drag to shape · alt-click a point to remove"));

  // Quarter grid, and a dotted diagonal so "no change" is visible as a shape.
  for (let i = 1; i < 4; i++) {
    const h = el("div", "curve-gridline h");
    h.style.top = pct(i / 4);
    grid.appendChild(h);
    const v = el("div", "curve-gridline v");
    v.style.left = pct(i / 4);
    grid.appendChild(v);
  }
  for (let i = 0; i < 22; i++) {
    const d = el("div", "curve-diagdot");
    const t = i / 21;
    d.style.left = pct(t);
    d.style.top = yPx(t);
    diag.appendChild(d);
  }

  let points = normaliseCurve(value);

  function pct(t) {
    return (t * 100).toFixed(3) + "%";
  }

  /** Curve value -> pixel offset from the top of the box. */
  function yPx(v) {
    return Math.round((1 - v) * (CURVE_H - 3)) + "px";
  }

  /*
   * Repaint by moving what already exists.
   *
   * This used to rebuild every segment and every control point on each
   * pointermove - seventy-odd elements per frame, including the very dot being
   * dragged, which was therefore destroyed and recreated under the pointer.
   * The segments are a fixed count so they are built once; the dots are only
   * rebuilt when their number actually changes.
   */
  const segs = [];
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const seg = el("div", "curve-seg");
    seg.style.left = pct(i / (CURVE_SAMPLES - 1));
    segs.push(seg);
    line.appendChild(seg);
  }
  let dotNodes = [];

  function rebuildDots() {
    dots.textContent = "";
    dotNodes = points.map((p, i) => {
      const dot = el("div", "curve-dot");
      dot.addEventListener("pointerdown", (e) => beginDrag(e, i));
      dots.appendChild(dot);
      return dot;
    });
  }

  function paint() {
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      segs[i].style.top = yPx(evalCurve(points, i / (CURVE_SAMPLES - 1)));
    }
    if (dotNodes.length !== points.length) rebuildDots();
    for (let i = 0; i < points.length; i++) {
      dotNodes[i].style.left = pct(points[i][0]);
      dotNodes[i].style.top = yPx(points[i][1]);
    }

    const changed = !isIdentityCurve(points);
    wrap.className = "curve" + (changed ? " modified" : "");
    readout.textContent = changed ? `${points.length} points` : "linear";
  }

  function setHistogram(bins) {
    hist.textContent = "";
    if (!bins || !bins.length) return;
    let peak = 0;
    for (const b of bins) if (b > peak) peak = b;
    if (peak <= 0) return;
    const w = 100 / bins.length;
    bins.forEach((b, i) => {
      const bar = el("div", "curve-bar");
      bar.style.left = (i * w).toFixed(3) + "%";
      bar.style.width = (w + 0.2).toFixed(3) + "%";
      // Square root, so a single dominant bin does not flatten everything else
      // into invisibility - this is a shape to read, not a measurement.
      bar.style.height = Math.round(Math.sqrt(b / peak) * (CURVE_H - 4)) + "px";
      hist.appendChild(bar);
    });
  }

  /** Pointer position as a 0..1 point in the box. */
  function at(e) {
    const r = box.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [
      clampUnit((e.clientX - r.left) / r.width),
      clampUnit(1 - (e.clientY - r.top) / r.height),
    ];
  }

  let dragIndex = -1;

  function beginDrag(e, index) {
    if (e.altKey) {
      // Removing needs two points left over, or there is no curve.
      if (points.length > 2) {
        points.splice(index, 1);
        paint();
        onChange(copy(points), true);
      }
      if (e.preventDefault) e.preventDefault();
      return;
    }
    dragIndex = index;
    try {
      box.setPointerCapture(e.pointerId);
    } catch (err) {
      /* capture is an optimisation, not a requirement */
    }
    if (e.preventDefault) e.preventDefault();
  }

  box.addEventListener("pointerdown", (e) => {
    if (dragIndex >= 0) return; // a point handled it first
    const p = at(e);
    if (!p) return;
    // Near an existing point, grab it rather than stacking a new one on top.
    let near = -1;
    let best = CURVE_GRAB;
    points.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) {
        best = d;
        near = i;
      }
    });
    if (near >= 0) {
      beginDrag(e, near);
      return;
    }
    points.push(p);
    points = normaliseCurve(points);
    dragIndex = points.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
    paint();
    try {
      box.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    if (e.preventDefault) e.preventDefault();
  });

  box.addEventListener("pointermove", (e) => {
    if (dragIndex < 0) return;
    const p = at(e);
    if (!p) return;
    const moved = points[dragIndex];
    // Keep the point between its neighbours: crossing one would reorder the
    // list under the drag and the point would jump out from under the pointer.
    const lo = dragIndex > 0 ? points[dragIndex - 1][0] + 0.01 : 0;
    const hi = dragIndex < points.length - 1 ? points[dragIndex + 1][0] - 0.01 : 1;
    moved[0] = clampUnit(Math.min(Math.max(p[0], lo), hi));
    moved[1] = p[1];
    paint();
    onChange(copy(points), false);
  });

  const endDrag = (e) => {
    if (dragIndex < 0) return;
    dragIndex = -1;
    try {
      box.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    points = normaliseCurve(points);
    paint();
    onChange(copy(points), true);
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  reset.addEventListener("click", () => {
    points = normaliseCurve(def.def);
    paint();
    onChange(copy(points), true);
  });

  function set(v) {
    points = normaliseCurve(v);
    paint();
  }

  set(value);
  if (opts.getHistogram) setHistogram(opts.getHistogram());
  return { el: wrap, set, setHistogram };
}

function copy(pts) {
  return pts.map((p) => [p[0], p[1]]);
}

function clampUnit(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A collapsible section.
 *
 * The head carries a summary of the section's key values on the right, so a
 * collapsed section still says what it is set to. With a dozen sections and only
 * a couple of them open at a time, that is the difference between a panel you
 * can scan and one where every setting has to be hunted for.
 */
function createSection(id, label, open) {
  const section = el("div", "section" + (open ? " open" : ""));
  const head = el("div", "section-head");
  // A text glyph rather than a CSS triangle or a pseudo-element: UXP renders
  // neither, and a border-triangle came out as a solid square.
  const caret = el("div", "section-caret", open ? "\u25BC" : "\u25B6");
  const title = el("div", "section-title", label);
  const summary = el("div", "section-summary", "");
  head.appendChild(caret);
  head.appendChild(title);
  head.appendChild(summary);
  const body = el("div", "section-body");
  const api = {
    el: section,
    body,
    onToggle: null,
    setSummary: (text) => {
      summary.textContent = text || "";
    },
  };
  head.addEventListener("click", () => {
    const isOpen = section.className.indexOf("open") >= 0;
    section.className = "section" + (isOpen ? "" : " open");
    caret.textContent = isOpen ? "\u25B6" : "\u25BC";
    // Collapse state is owned by the caller so it survives a rebuild.
    if (api.onToggle) api.onToggle(!isOpen);
  });
  section.appendChild(head);
  section.appendChild(body);
  return api;
}

module.exports = {
  el,
  createSlider,
  createChoice,
  createChipChoice,
  createToggle,
  createPalette,
  createColorField,
  createCurve,
  createSection,
  normalizeHex,
  titleCase,
  optionLabel,
};
