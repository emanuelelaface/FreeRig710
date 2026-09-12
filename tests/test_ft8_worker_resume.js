"use strict";

const assert = require("assert");
const path = require("path");

const elements = new Map();
global.document = {
  getElementById(name) {
    if (!elements.has(name)) elements.set(name, { textContent: "", classList: { add() {}, remove() {}, toggle() {} } });
    return elements.get(name);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  activeElement: null,
};
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  requestAnimationFrame() { return 0; },
};

const workers = [];
global.Worker = class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message) {
    if (message.type === "ping") {
      setTimeout(() => this.onmessage?.({ data: { type: "pong", requestId: message.requestId } }), 0);
    }
  }
  terminate() { this.terminated = true; }
};

require(path.join(__dirname, "..", "frontend", "ft8.js"));
const controller = window.FT710_FT8;

(async () => {
  controller.ensureWorker();
  assert.equal(workers.length, 1);
  assert.match(workers[0].url, /ft8-worker\.js\?v=1\.0-resume2$/);
  assert.equal(await controller.probeWorker(300), true);

  const staleWorker = controller.worker;
  controller.decodeBusy = true;
  controller.decodeBusySlotIndex = 123;
  controller.decodeBusySinceMs = Date.now() - 21_000;
  assert.equal(await controller.recoverFromSuspension("test resume"), false);
  assert.equal(staleWorker.terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(controller.decodeBusy, false);
  assert.equal(controller.decodeBusySlotIndex, null);
  assert.equal(await controller.probeWorker(300), true);
  console.log("FT8 Worker suspension recovery: OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
