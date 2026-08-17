"use strict";

/**
 * The channel between the controls panel and the detached preview panel.
 *
 * A UXP plugin has one JavaScript realm but one document per panel, so the two
 * panels cannot see each other's DOM and `window` is not shared. What they do
 * share is the module registry: `require("./framebus.js")` from either document
 * returns the same object. That single shared object is the entire transport -
 * no messaging API, no serialisation, no polling.
 *
 * The bus keeps the last frame as well as the subscriber list, so a preview
 * panel opened *after* a render still has something to show immediately instead
 * of sitting blank until the next slider move.
 *
 * If a host build turns out not to share modules between panel documents, the
 * detached panel simply never receives a frame; it says so on screen rather
 * than showing an empty box, and the docked panel is unaffected.
 */

/** @typedef {{url: string, width: number, height: number, badge: string}} Frame */

/** @type {Frame|null} */
let current = null;
/** @type {Array<(f: Frame|null) => void>} */
let listeners = [];
/** Set by the detached panel so the controls panel can say whether it is open. */
let attached = 0;
/** The size the detached panel would like frames rendered at, if it is open. */
let wanted = null;
/** @type {((s: {width:number,height:number}|null) => void)|null} */
let onWanted = null;

/**
 * Publish a rendered frame. Cheap enough to call on every preview tick: it is
 * one object assignment plus a callback per listener, and the data URL has
 * already been built for the docked preview anyway.
 * @param {Frame|null} frame
 */
function publish(frame) {
  current = frame;
  for (let i = 0; i < listeners.length; i++) {
    try {
      listeners[i](frame);
    } catch (e) {
      // One broken listener must not stop the others, and must never take the
      // render down with it.
    }
  }
}

/**
 * Listen for frames. Fires immediately with the current frame if there is one.
 * @param {(f: Frame|null) => void} fn
 * @returns {() => void} unsubscribe
 */
function subscribe(fn) {
  listeners.push(fn);
  if (current) {
    try {
      fn(current);
    } catch (e) {
      /* as above */
    }
  }
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

/** @returns {Frame|null} the most recent frame, if any. */
function latest() {
  return current;
}

/** The detached panel registers itself so the controls panel can report it. */
function setAttached(isOpen) {
  attached = isOpen ? attached + 1 : Math.max(0, attached - 1);
  if (!attached) requestSize(null);
}

/**
 * The detached panel says how big it is; the controls panel renders for the
 * larger of the two windows.
 *
 * Without this the detached view is only *bigger*, not sharper: it would be
 * showing a frame rasterised for a 360px panel, scaled up. With it, floating the
 * preview onto a second monitor actually buys resolution.
 *
 * @param {{width:number,height:number}|null} size
 */
function requestSize(size) {
  wanted = size;
  if (onWanted) {
    try {
      onWanted(size);
    } catch (e) {
      /* the controls panel will pick it up on the next tick regardless */
    }
  }
}

/** @returns {{width:number,height:number}|null} */
function requestedSize() {
  return attached ? wanted : null;
}

/** The controls panel listens so it can re-render at once on a resize. */
function onSizeRequest(fn) {
  onWanted = fn;
}

/** @returns {boolean} whether a detached preview panel is listening. */
function isAttached() {
  return attached > 0;
}

/** Test seam: drop every listener and the retained frame. */
function reset() {
  current = null;
  listeners = [];
  attached = 0;
  wanted = null;
  onWanted = null;
}

module.exports = {
  publish,
  subscribe,
  latest,
  setAttached,
  isAttached,
  requestSize,
  requestedSize,
  onSizeRequest,
  reset,
};
