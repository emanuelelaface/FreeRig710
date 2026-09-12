"use strict";

const assert = require("assert");
const path = require("path");

class FakeBody {
  constructor() {
    this.dataset = {};
    this.listeners = new Map();
    this.captured = new Set();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  contains() { return true; }
  setPointerCapture(pointerId) { this.captured.add(pointerId); }
  releasePointerCapture(pointerId) { this.captured.delete(pointerId); }
  fire(type, event) { this.listeners.get(type)?.(event); }
}

const bandBody = new FakeBody();
const rxBody = new FakeBody();
global.document = {
  getElementById(name) {
    if (name === "ft8-decodes-body") return bandBody;
    if (name === "ft8-rx-decodes-body") return rxBody;
    return null;
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  activeElement: null,
};
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.window = {};
global.Worker = class {};

require(path.join(__dirname, "..", "frontend", "ft8.js"));
const controller = window.FT710_FT8;
const row = { key: "slot|1500|CQ TEST1 AA00" };
const renderedRow = { dataset: { ft8RowKey: row.key } };
const target = { closest() { return renderedRow; } };
const selected = [];
controller.decodeRows = [row];
controller.selectDecodeFromActivity = async (candidate) => { selected.push(candidate.key); return true; };
controller.setupActivityPointerSelection();

// The original renderedRow may be removed/recreated here. Pointer capture on
// the stable tbody still delivers pointerup and selection resolves by row key.
bandBody.fire("pointerdown", { isPrimary: true, button: 0, pointerId: 7, clientX: 20, clientY: 30, target });
assert.equal(bandBody.captured.has(7), true);
bandBody.fire("pointerup", { pointerId: 7, clientX: 21, clientY: 31 });
assert.deepEqual(selected, [row.key]);
assert.equal(bandBody.captured.has(7), false);

// The browser's follow-up click must not activate the same decode twice.
bandBody.fire("click", { target });
assert.deepEqual(selected, [row.key]);

// A drag/scroll gesture is not a station selection.
bandBody.fire("pointerdown", { isPrimary: true, button: 0, pointerId: 8, clientX: 20, clientY: 30, target });
bandBody.fire("pointerup", { pointerId: 8, clientX: 45, clientY: 30 });
assert.deepEqual(selected, [row.key]);

console.log("FT8 physical trackpad pointer selection: OK");
