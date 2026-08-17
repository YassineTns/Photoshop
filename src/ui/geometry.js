"use strict";

/**
 * Measuring elements, in a host that cannot always be asked.
 *
 * This module exists because of a Photoshop 2026 log. Two lines from it:
 *
 *   [Halftone Studio] self-check: the preview area has no width (0px) |
 *   the preview area has no height (0px) | the controls area has no height (0px)
 *
 *   Incompatible value for user parameter. Default value auto being used for
 *   width instead of -30150
 *
 * The first says `clientWidth` / `clientHeight` return 0 for this panel's own
 * elements. The second is UXP rejecting `width: -30150px`, a style the panel
 * wrote itself out of `getBoundingClientRect().width` - so the rectangle came
 * back as nonsense, not as zero.
 *
 * Both APIs are real and both are used elsewhere in the panel; neither can be
 * trusted here without checking. The layout is fine - the panel looks right on
 * screen - it is only the measurement that is unavailable, which is a much
 * narrower problem and one that can be handled honestly:
 *
 *   - ask every API in turn and take the first answer that is *plausible*,
 *   - never write a style or scale a render from an implausible one,
 *   - say which answer was used, so a size that turns out wrong is traceable
 *     to the API that produced it instead of being a mystery.
 *
 * "Plausible" is deliberately loose. The point is not to validate a layout, it
 * is to reject 0, NaN, -30150 and 1e9 - values that can only be a host that
 * does not know, and that produce a broken preview if used.
 */

/** Nothing on a panel is this big, and nothing useful is smaller than a pixel. */
const MIN_SANE = 1;
const MAX_SANE = 20000;

/** @returns {boolean} whether a length can be taken at face value. */
function sane(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= MIN_SANE && v <= MAX_SANE;
}

/** A coordinate may legitimately be zero or negative; it just may not be wild. */
function saneCoord(v) {
  return typeof v === "number" && Number.isFinite(v) && v > -MAX_SANE && v < MAX_SANE;
}

/**
 * A validated bounding rectangle, or null.
 *
 * Callers that position one element against another need left/top as well as
 * width/height, and all four have to come from the same call to be consistent -
 * so this is all-or-nothing rather than a best-effort mixture.
 *
 * @returns {{left:number, top:number, width:number, height:number}|null}
 */
function rectOf(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  let r;
  try {
    r = el.getBoundingClientRect();
  } catch (e) {
    return null;
  }
  if (!r) return null;
  if (!sane(r.width) || !sane(r.height)) return null;
  if (!saneCoord(r.left) || !saneCoord(r.top)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * How big an element is, by whichever route this host actually answers.
 *
 * @returns {{width:number|null, height:number|null, source:string}}
 *   `source` names the API each dimension came from, for the self-check report.
 */
function sizeOf(el) {
  if (!el) return { width: null, height: null, source: "none" };

  const r = rectOf(el);
  if (r) return { width: r.width, height: r.height, source: "rect" };

  // The rectangle was refused. The two dimensions are taken independently from
  // here on: a host that knows one and not the other is more useful than one
  // that is discarded for being incomplete.
  let width = null;
  let height = null;
  let source = "none";
  const take = (w, h, name) => {
    if (width === null && sane(w)) {
      width = w;
      source = source === "none" ? name : source + "+" + name;
    }
    if (height === null && sane(h)) {
      height = h;
      if (source.indexOf(name) < 0) source = source === "none" ? name : source + "+" + name;
    }
  };
  take(el.clientWidth, el.clientHeight, "client");
  take(el.offsetWidth, el.offsetHeight, "offset");
  return { width, height, source };
}

/**
 * The panel viewport, for when no element can be measured at all.
 *
 * `#app` is pinned to all four edges of the panel, so its size is the panel's
 * size - but if it cannot be measured either, the window is the last thing
 * left to ask before falling back to a guess.
 *
 * @returns {{width:number|null, height:number|null, source:string}}
 */
function viewportSize(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w) return { width: null, height: null, source: "none" };
  const width = sane(w.innerWidth) ? w.innerWidth : null;
  const height = sane(w.innerHeight) ? w.innerHeight : null;
  return { width, height, source: width || height ? "window" : "none" };
}

/**
 * Everything this host will say about an element, unfiltered.
 *
 * Written to the console at start-up. Three faults in this plugin have been
 * diagnosed from a Photoshop log rather than from a reproduction, and each time
 * the log was missing the one number that would have settled it in a minute.
 * This is that number, for every API, printed whether or not anything is wrong.
 */
function describe(el, name) {
  if (!el) return `${name}: absent`;
  let rect = "n/a";
  if (typeof el.getBoundingClientRect === "function") {
    try {
      const r = el.getBoundingClientRect();
      rect = r ? `${fmt(r.width)}x${fmt(r.height)}@${fmt(r.left)},${fmt(r.top)}` : "null";
    } catch (e) {
      rect = "threw";
    }
  }
  return (
    `${name}: rect=${rect} client=${fmt(el.clientWidth)}x${fmt(el.clientHeight)} ` +
    `offset=${fmt(el.offsetWidth)}x${fmt(el.offsetHeight)}`
  );
}

function fmt(v) {
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return String(v);
  return String(Math.round(v * 10) / 10);
}

module.exports = { sane, saneCoord, rectOf, sizeOf, viewportSize, describe, MAX_SANE };
