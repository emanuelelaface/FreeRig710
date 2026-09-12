"use strict";

const assert = require("assert");
const path = require("path");

const noop = () => {};
const elements = new Map();
function element(name) {
  if (elements.has(name)) return elements.get(name);
  const value = {
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    dataset: {},
    style: { setProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop },
    addEventListener: noop,
    dispatchEvent: noop,
    getBoundingClientRect() { return { left: 0, width: 100 }; },
  };
  elements.set(name, value);
  return value;
}

global.window = {
  location: { hostname: "test.invalid", origin: "http://test.invalid" },
  addEventListener: noop,
  FT710_CONFIG: {},
  FT710_FT8: {
    init: noop,
    setControlSender: noop,
    setTxSlotParity: noop,
    setAudioReady: noop,
    enableDecode: noop,
    preloadEncoder: noop,
    getTxPlan() { return {}; },
  },
};
global.document = {
  hidden: false,
  getElementById: element,
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener: noop,
};
global.localStorage = { getItem() { return null; }, setItem: noop, removeItem: noop };
global.fetch = async () => ({ ok: true, async json() { return { radio_power: "OFF" }; } });
global.setInterval = () => 0;
global.clearInterval = noop;
global.setTimeout = () => 0;
global.clearTimeout = noop;
global.BroadcastChannel = undefined;
global.WebSocket = class { static OPEN = 1; static CLOSING = 2; };

require(path.join(__dirname, "..", "frontend", "ft8-page.js"));
const page = window.FT710_FT8_PAGE;

let stopped = 0;
let disconnected = 0;
let closed = 0;
page.txClockCaptureEnabled = true;
page.txClockSourceNode = { stop() { stopped += 1; }, disconnect() { disconnected += 1; } };
page.txClockGainNode = { disconnect() { disconnected += 1; } };
page.txCaptureNode = { port: { onmessage: noop }, disconnect() { disconnected += 1; } };
page.txSilentGain = { disconnect() { disconnected += 1; } };
page.txAudioContext = { state: "running", close() { closed += 1; return Promise.resolve(); } };

assert.doesNotThrow(() => page.closeAudio("resume cleanup test"));
assert.equal(stopped, 1);
assert.equal(disconnected, 4);
assert.equal(closed, 1);
assert.equal(page.txClockCaptureEnabled, false);
assert.equal(page.txClockSourceNode, null);
assert.equal(page.txAudioContext, null);
console.log("FT8 resume TX-clock cleanup: OK");
