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

  for (const opt of def.options) {
    const b = el("button", "seg-item", (labels && labels[opt]) || titleCase(opt));
    b.title = (labels && labels[opt]) || titleCase(opt);
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
    const text = (meta.labels && meta.labels[opt]) || titleCase(opt);
    const b = el("button", "algo-chip", text);
    b.title = text;
    b.addEventListener("click", () => {
      set(opt);
      onChange(opt, true);
    });
    buttons[opt] = b;
    host.appendChild(b);
  };

  if (groups) {
    for (const g of groups) {
      const members = def.options.filter((o) => meta.groupOf(o) === g.id);
      if (!members.length) continue;
      wrap.appendChild(el("div", "chip-group-label", g.label));
      const row = el("div", "chip-row");
      for (const opt of members) addChip(opt, row);
      wrap.appendChild(row);
    }
  } else {
    const row = el("div", "chip-row");
    for (const opt of def.options) addChip(opt, row);
    wrap.appendChild(row);
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
  spacer.style.flex = "1 1 auto";
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

  const extractBtn = el("button", "btn btn-small", "Extract from Image");
  extractBtn.addEventListener("click", () => opts.onExtract());
  actions.appendChild(extractBtn);

  const fgBtn = el("button", "btn btn-small", "＋ FG");
  fgBtn.title = "Append Photoshop's foreground colour";
  fgBtn.addEventListener("click", () => {
    const rgb = opts.getForeground();
    if (!rgb) return;
    const hex = toHex(rgb);
    set(current.concat([hex]));
    opts.onChange(current.slice());
  });
  actions.appendChild(fgBtn);

  let current = (opts.value || []).slice();

  function toHex(rgb) {
    return (
      "#" +
      ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]).toString(16).padStart(6, "0").toUpperCase()
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
          set(current);
          opts.onChange(current.slice());
          return;
        }
      }
      set(current);
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
  }

  function set(hexes) {
    current = (hexes || []).slice();
    strip.textContent = "";
    current.forEach((hex, i) => {
      const swatchWrap = el("div", "swatch-wrap");
      const swatch = el("button", "swatch");
      swatch.style.background = hex;
      swatch.title = `${hex} — click to edit, alt-click to use the foreground colour`;
      swatch.addEventListener("click", (e) => {
        if (e.altKey) {
          const rgb = opts.getForeground();
          if (rgb) {
            current[i] = toHex(rgb);
            set(current);
            opts.onChange(current.slice());
          }
          return;
        }
        beginEdit(i, swatchWrap, swatch);
      });
      swatchWrap.appendChild(swatch);
      strip.appendChild(swatchWrap);
    });
  }

  wrap.appendChild(strip);
  wrap.appendChild(actions);
  set(current);
  return { el: wrap, set };
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

  const swatch = el("button", "swatch");
  const input = el("input", "ctl-value");
  input.type = "text";
  input.style.flex = "1 1 auto";
  input.style.textAlign = "left";

  const autoBtn = el("button", "seg-item", "Auto");
  autoBtn.style.flex = "0 0 34px";
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

/** A collapsible section. */
function createSection(id, label, open) {
  const section = el("div", "section" + (open ? " open" : ""));
  const head = el("div", "section-head");
  head.appendChild(el("div", "section-caret"));
  head.appendChild(el("div", null, label));
  const body = el("div", "section-body");
  const api = { el: section, body, onToggle: null };
  head.addEventListener("click", () => {
    const isOpen = section.className.indexOf("open") >= 0;
    section.className = "section" + (isOpen ? "" : " open");
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
  createSection,
  normalizeHex,
  titleCase,
};
