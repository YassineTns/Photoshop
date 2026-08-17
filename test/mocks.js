"use strict";

/**
 * Mocks for the Photoshop host and the DOM.
 *
 * These do NOT prove the real batchPlay descriptors are accepted by Photoshop -
 * only Photoshop can prove that. What they do prove is that the plugin's own
 * logic is sound: that the layer structure is built in the right order, that
 * pixels of the right size reach putPixels, that parameters round-trip through
 * the metadata layer, and that every control the schema declares is actually
 * created and wired. Those are the failures worth catching before installing.
 */

const Module = require("module");

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = "";
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this._text = "";
    this.parentNode = null;
    this.value = "";
    this.type = "";
    this.title = "";
    this.src = "";
    this.clientWidth = 360;
    this.clientHeight = 200;
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(v) {
    this.children.forEach((c) => {
      c.parentNode = null;
    });
    this.children = [];
    this._text = String(v);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    this._text = "";
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** Fire a listener as if the user had interacted. */
  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(Object.assign({ preventDefault() {} }, event));
  }

  setAttribute(k, v) {
    this.attributes[k] = v;
  }

  removeAttribute(k) {
    delete this.attributes[k];
  }

  getAttribute(k) {
    return this.attributes[k];
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 };
  }

  focus() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}

  /** Depth-first search helper for assertions. */
  find(predicate) {
    if (predicate(this)) return this;
    for (const c of this.children) {
      const hit = c.find(predicate);
      if (hit) return hit;
    }
    return null;
  }

  findAll(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const c of this.children) c.findAll(predicate, out);
    return out;
  }
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    activeElement: null,
    readyState: "complete",
    createElement: (tag) => new FakeElement(tag),
    getElementById(id) {
      if (!byId.has(id)) {
        const e = new FakeElement("div");
        e.id = id;
        byId.set(id, e);
      }
      return byId.get(id);
    },
    addEventListener() {},
    _byId: byId,
  };
  return doc;
}

/* ------------------------------------------------------------------ *
 * Photoshop
 * ------------------------------------------------------------------ */

class FakeLayer {
  constructor(doc, opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.kind = opts.kind || "pixel";
    this.visible = opts.visible !== false;
    this.layers = opts.kind === "group" ? [] : undefined;
    this.parent = opts.parent || doc;
    this.bounds = opts.bounds || {
      left: 0,
      top: 0,
      right: doc.width,
      bottom: doc.height,
    };
  }
}

class FakePhotoshop {
  /**
   * @param {{width:number, height:number, pixels?: Uint8ClampedArray}} opts
   */
  constructor(opts) {
    this.calls = [];
    this.putPixelsCalls = [];
    this.putLayerMaskCalls = [];
    this.getPixelsCalls = [];
    this.disposed = 0;
    this.nextLayerId = 100;
    this.xmpStore = new Map();
    this.notificationListeners = [];

    const doc = {
      id: 1,
      name: "Test.psd",
      width: opts.width,
      height: opts.height,
      mode: "RGBColorMode",
      layers: [],
      activeLayers: [],
    };
    this.doc = doc;
    this.sourcePixels = opts.pixels || null;

    const base = new FakeLayer(doc, { id: this.nextLayerId++, name: "Background" });
    doc.layers.push(base);
    doc.activeLayers = [base];

    this.app = {
      get activeDocument() {
        return doc;
      },
      foregroundColor: { rgb: { red: 236, green: 62, blue: 50 } },
      version: "25.0.0",
    };

    this.core = {
      executeAsModal: async (fn) => fn({ reportProgress: () => {} }),
    };

    this.action = {
      batchPlay: async (descs) => this.batchPlay(descs),
      addNotificationListener: (events, cb) => {
        this.notificationListeners.push({ events, cb });
      },
    };

    this.imaging = {
      getPixels: async (req) => this.getPixels(req),
      putPixels: async (req) => this.putPixels(req),
      createImageDataFromBuffer: (buffer, options) => this.createImageData(buffer, options),
    };
    // Selection reading is probed rather than assumed, so all three real cases
    // are reproducible here: no API at all (opts.noSelectionAPI), an API that
    // throws because nothing is selected (the default), and a live selection
    // (opts.selection, a document-space rectangle).
    this.selectionRect = opts.selection || null;
    this.getSelectionCalls = [];
    if (!opts.noSelectionAPI) {
      this.imaging.getSelection = async (req) => {
        this.getSelectionCalls.push(req);
        if (!this.selectionRect) throw new Error("No selection");
        const b = req.sourceBounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
        const width = b.right - b.left;
        const height = b.bottom - b.top;
        const data = new Uint8Array(width * height);
        const s = this.selectionRect;
        for (let y = 0; y < height; y++) {
          const dy = b.top + y;
          for (let x = 0; x < width; x++) {
            const dx = b.left + x;
            data[y * width + x] =
              dx >= s.left && dx < s.right && dy >= s.top && dy < s.bottom ? 255 : 0;
          }
        }
        return {
          imageData: {
            width,
            height,
            components: 1,
            componentSize: 8,
            getData: async () => data,
            dispose: () => {
              this.disposed++;
            },
          },
          sourceBounds: b,
        };
      };
    }
    // Mask support is optional in the real host, so it is optional here too:
    // opts.noMasks exercises the documented fallback to flat output.
    if (!opts.noMasks) {
      this.imaging.putLayerMask = async (req) => {
        this.putLayerMaskCalls.push(req);
        const layer = this.findLayer(req.layerID);
        if (layer) layer.maskWritten = true;
        return {};
      };
    }
  }

  /* ---- layer tree helpers ---- */

  findLayer(id, list = this.doc.layers) {
    for (const l of list) {
      if (l.id === id) return l;
      if (l.layers) {
        const hit = this.findLayer(id, l.layers);
        if (hit) return hit;
      }
    }
    return null;
  }

  removeFromParent(layer) {
    const list = layer.parent && layer.parent.layers ? layer.parent.layers : this.doc.layers;
    const i = list.indexOf(layer);
    if (i >= 0) list.splice(i, 1);
  }

  /* ---- batchPlay ---- */

  async batchPlay(descs) {
    const results = [];
    for (const d of descs) {
      this.calls.push(d);
      results.push(await this.handle(d));
    }
    return results;
  }

  async handle(d) {
    switch (d._obj) {
      case "select": {
        const ids = (d._target || []).map((t) => t._id);
        this.doc.activeLayers = ids.map((id) => this.findLayer(id)).filter(Boolean);
        return {};
      }
      case "newPlacedLayer": {
        // Convert the selected layer into a Smart Object in place.
        const target = this.doc.activeLayers[0];
        if (!target) throw new Error("newPlacedLayer with no selection");
        target.kind = "smartObject";
        return {};
      }
      case "make": {
        const ref = (d._target && d._target[0] && d._target[0]._ref) || "";
        if (d.new && d.new._class === "channel") {
          // Adding a layer mask to the current selection.
          const layer = this.doc.activeLayers[0];
          if (layer) layer.hasMask = true;
          return {};
        }
        if (ref === "contentLayer") {
          const anchor = this.doc.activeLayers[0];
          const parent = anchor ? anchor.parent : this.doc;
          const list = parent && parent.layers ? parent.layers : this.doc.layers;
          const using = d.using || {};
          const colour = using.type && using.type.color ? using.type.color : {};
          const layer = new FakeLayer(this.doc, {
            id: this.nextLayerId++,
            name: using.name || "Color Fill 1",
            kind: "solidColor",
            parent: parent === this.doc ? this.doc : parent,
          });
          layer.fillColor = [colour.red, colour.grain, colour.blue];
          list.splice(Math.max(0, list.indexOf(anchor)), 0, layer);
          this.doc.activeLayers = [layer];
          return {};
        }
        if (ref === "layerSection") {
          const members = this.doc.activeLayers.slice();
          const group = new FakeLayer(this.doc, {
            id: this.nextLayerId++,
            name: "Group 1",
            kind: "group",
          });
          const host = members[0] && members[0].parent && members[0].parent.layers
            ? members[0].parent.layers
            : this.doc.layers;
          const at = Math.max(0, host.indexOf(members[0]));
          for (const m of members) this.removeFromParent(m);
          host.splice(at, 0, group);
          for (const m of members) {
            m.parent = group;
            group.layers.push(m);
          }
          this.doc.activeLayers = [group];
          return {};
        }
        // Plain pixel layer, created directly above the current selection and
        // inside the same parent - which is how Photoshop behaves.
        const anchor = this.doc.activeLayers[0];
        const parent = anchor ? anchor.parent : this.doc;
        const list = parent && parent.layers ? parent.layers : this.doc.layers;
        const layer = new FakeLayer(this.doc, {
          id: this.nextLayerId++,
          name: (d.using && d.using.name) || "Layer 1",
          parent: parent === this.doc ? this.doc : parent,
        });
        list.splice(Math.max(0, list.indexOf(anchor)), 0, layer);
        this.doc.activeLayers = [layer];
        return {};
      }
      case "set": {
        const prop = d._target && d._target[0] && d._target[0]._property;
        if (prop === "metadata") {
          const id = d._target[1] && d._target[1]._id;
          this.xmpStore.set(id, d.to && d.to.layerXMP);
          return {};
        }
        const id = d._target && d._target[0] && d._target[0]._id;
        const layer = this.findLayer(id);
        if (layer && d.to && d.to.name !== undefined) layer.name = d.to.name;
        return {};
      }
      case "get": {
        const prop = d._target && d._target[0] && d._target[0]._property;
        if (prop === "metadata") {
          const id = d._target[1] && d._target[1]._id;
          return { metadata: { layerXMP: this.xmpStore.get(id) || "" } };
        }
        if (prop === "mode") return { mode: { _value: "RGBColorMode" } };
        return {};
      }
      case "show":
      case "hide": {
        const ref = d.null && d.null[0];
        const layer = ref && this.findLayer(ref._id);
        if (layer) layer.visible = d._obj === "show";
        return {};
      }
      case "delete": {
        const id = d._target && d._target[0] && d._target[0]._id;
        const layer = this.findLayer(id);
        if (layer) this.removeFromParent(layer);
        return {};
      }
      default:
        return {};
    }
  }

  /* ---- imaging ---- */

  async getPixels(req) {
    this.getPixelsCalls.push(req);
    const b = req.sourceBounds;
    let width = b.right - b.left;
    let height = b.bottom - b.top;
    if (req.targetSize) {
      width = req.targetSize.width;
      height = req.targetSize.height;
    }
    const self = this;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (self.sourcePixels) {
          // Nearest-neighbour resample of the supplied fixture.
          const sx = Math.min(self.sourceW - 1, Math.floor((x / width) * self.sourceW));
          const sy = Math.min(self.sourceH - 1, Math.floor((y / height) * self.sourceH));
          const j = (sy * self.sourceW + sx) * 4;
          data[i] = self.sourcePixels[j];
          data[i + 1] = self.sourcePixels[j + 1];
          data[i + 2] = self.sourcePixels[j + 2];
          data[i + 3] = self.sourcePixels[j + 3];
        } else {
          const v = Math.round((x / Math.max(1, width - 1)) * 255);
          data[i] = data[i + 1] = data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
    }
    return {
      imageData: {
        width,
        height,
        components: 4,
        componentSize: 8,
        getData: async () => data,
        dispose: () => {
          self.disposed++;
        },
      },
      sourceBounds: b,
    };
  }

  async putPixels(req) {
    this.putPixelsCalls.push(req);
    return {};
  }

  createImageData(buffer, options) {
    const self = this;
    return {
      width: options.width,
      height: options.height,
      components: options.components,
      byteLength: buffer.length,
      // The real ImageData does not expose its bytes back to the plugin, but a
      // test has to be able to see what was actually written - otherwise the
      // only thing assertable about a render is that it happened.
      data: buffer,
      dispose: () => {
        self.disposed++;
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

let originalLoad = null;

/**
 * Intercept require("photoshop") / require("uxp") and install DOM globals.
 * @param {{width:number, height:number, image?: object}} opts
 * @returns {{ps: FakePhotoshop, document: object, files: Map<string,string>}}
 */
function install(opts) {
  const ps = new FakePhotoshop(opts);
  if (opts.image) {
    ps.sourcePixels = opts.image.data;
    ps.sourceW = opts.image.width;
    ps.sourceH = opts.image.height;
  }

  const files = new Map();
  const fakeFolder = {
    async getEntry(name) {
      if (!files.has(name)) throw new Error("not found: " + name);
      return { read: async () => files.get(name) };
    },
    async createFile(name) {
      return {
        write: async (text) => {
          files.set(name, text);
        },
      };
    },
  };
  // Files chosen through a save/open dialog, kept so a test can read back what
  // the plugin actually wrote. `opts.cancelSave` reproduces the user pressing
  // Cancel, which every caller has to handle without throwing.
  const savedFiles = [];
  const uxpMock = {
    storage: {
      formats: { binary: "binary", utf8: "utf8" },
      localFileSystem: {
        getDataFolder: async () => fakeFolder,
        getFileForOpening: async () => null,
        getFileForSaving: async (name) => {
          if (opts.cancelSave) return null;
          const entry = {
            name,
            contents: null,
            write: async (data) => {
              entry.contents = data;
            },
          };
          savedFiles.push(entry);
          return entry;
        },
      },
    },
  };
  ps.savedFiles = savedFiles;

  if (!originalLoad) originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "photoshop") return ps;
    if (request === "uxp") return uxpMock;
    return originalLoad.call(this, request, parent, isMain);
  };

  const document = makeDocument();
  global.document = document;
  global.window = { halftonePanel: null };
  global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  return { ps, document, files };
}

function uninstall() {
  if (originalLoad) Module._load = originalLoad;
  delete global.document;
  delete global.window;
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
}

/** Drop cached plugin modules so each scenario starts clean. */
function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.indexOf("/src/") >= 0) delete require.cache[key];
  }
}

module.exports = { install, uninstall, resetModules, FakeElement, FakePhotoshop };
