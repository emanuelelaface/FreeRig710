"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const frontend = path.join(__dirname, "..", "frontend");
const html = fs.readFileSync(path.join(frontend, "rtty.html"), "utf8");
const source = fs.readFileSync(path.join(frontend, "rtty-page.js"), "utf8");
const modeKey = "freerig710-rtty-radio-mode-v3";
const modeOptions = [...html.match(/<select id="rtty-radio-mode">(.*?)<\/select>/s)[1]
  .matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)];
assert.deepEqual(modeOptions.map((option) => [option[1], option[3]]), [
  ["DATA-L", "DATA-L AFSK"], ["DATA-U", "DATA-U AFSK"],
]);
assert.ok(modeOptions[0][2], "DATA-L must be selected in the HTML");

function loadConsole(saved = new Map()) {
  const elements = {};
  for (const match of html.matchAll(/<(input|select|strong|span|div|button)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const [tag, kind, id] = match;
    let value = tag.match(/\bvalue="([^"]*)"/)?.[1] || "";
    if (kind === "select") {
      const options = html.slice(match.index + tag.length).split("</select>")[0];
      value = options.match(/<option value="([^"]*)" selected>/)?.[1]
        ?? options.match(/<option value="([^"]*)"/)?.[1] ?? "";
    }
    elements[id] = {
      value, checked: /\bchecked\b/.test(tag), style: {}, textContent: "", listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, listener) { this.listeners[event] = listener; },
      getBoundingClientRect() { return { left: 0, width: 1000 }; },
    };
  }
  const context = vm.createContext({
    window: { location: { hostname: "localhost", origin: "http://localhost" }, addEventListener() {}, setTimeout() {} },
    document: { getElementById: (id) => elements[id] || null },
    localStorage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
      removeItem: (key) => saved.delete(key),
    },
    URL, console, setTimeout() {}, clearTimeout() {},
  });
  // Expose private UI functions only inside this isolated test context.
  vm.runInContext(source.replace("  const exported = Object.freeze({", `
    window.testRtty = {
      state, cacheElements, loadModemSettings, initDecoder, updateToneUi,
      bindEvents,
    };
    const exported = Object.freeze({`), context);
  const ui = context.window.testRtty;
  ui.cacheElements();
  ui.loadModemSettings();
  ui.initDecoder();
  ui.updateToneUi();
  ui.bindEvents();
  return { elements, ui, saved };
}

function selectMode(page, mode) {
  page.elements["rtty-radio-mode"].value = mode;
  page.elements["rtty-radio-mode"].listeners.change();
}

const page = loadConsole();
assert.equal(page.elements["rtty-radio-mode"].value, "DATA-L");
assert.equal(page.elements["rtty-mark-space"].textContent, "2125/2295");
assert.equal(page.elements["rtty-baud"].value, "45.45");
assert.equal(page.elements["rtty-squelch"].value, "9");
assert.equal(page.elements["rtty-tx-level"].value, "-28");
const lowerMarkPosition = page.elements["rtty-mark-cursor"].style.left;
const lowerSpacePosition = page.elements["rtty-space-cursor"].style.left;

selectMode(page, "DATA-U");
assert.equal(page.elements["rtty-mark-space"].textContent, "2295/2125");
assert.equal(page.elements["rtty-mark-cursor"].style.left, lowerSpacePosition);
assert.equal(page.elements["rtty-space-cursor"].style.left, lowerMarkPosition);
assert.equal(page.ui.state.decoder.markHz, 2295);
assert.equal(page.ui.state.decoder.spaceHz, 2125);
assert.equal(page.ui.state.decoder.rxReverse, false);
assert.equal(page.elements["rtty-tx-reverse"].checked, false);
const restored = loadConsole(page.saved);
assert.equal(restored.elements["rtty-radio-mode"].value, "DATA-U");
assert.equal(restored.elements["rtty-mark-space"].textContent, "2295/2125");
selectMode(page, "DATA-L");
assert.equal(page.elements["rtty-mark-space"].textContent, "2125/2295");

// Preserve a custom pair through both mode changes, including the passband edge.
page.elements["rtty-mark"].value = "2830";
page.elements["rtty-mark"].listeners.change();
selectMode(page, "DATA-U");
assert.equal(page.elements["rtty-mark-space"].textContent, "3000/2830");
assert.equal(loadConsole(page.saved).elements["rtty-mark-space"].textContent, "3000/2830");
selectMode(page, "DATA-L");
assert.equal(page.elements["rtty-mark-space"].textContent, "2830/3000");

for (const mode of ["DATA-U", "RTTY-U", "RTTY-L"]) {
  const migrated = loadConsole(new Map([["freerig710-rtty-radio-mode-v2", mode]]));
  assert.equal(migrated.elements["rtty-radio-mode"].value, "DATA-L");
  assert.equal(migrated.elements["rtty-mark-space"].textContent, "2125/2295");
}
assert.equal(loadConsole(new Map([[modeKey, "RTTY-U"]])).elements["rtty-radio-mode"].value, "DATA-L");

for (const mode of ["DATA-L", "DATA-U"]) {
  const tuned = loadConsole();
  selectMode(tuned, mode);
  for (const clientX of [0, 1000]) {
    tuned.elements["rtty-waterfall-hitbox"].listeners.pointerdown({ clientX, preventDefault() {} });
    const { markHz, spaceHz, shiftHz } = tuned.ui.state.decoder;
    assert.ok(Math.min(markHz, spaceHz) >= 200 && Math.max(markHz, spaceHz) <= 3000);
    assert.equal(shiftHz, 170, "Waterfall tuning must keep the full shift at the edges");
    assert.equal(markHz < spaceHz, mode === "DATA-L");
  }

  const snapped = loadConsole();
  selectMode(snapped, mode);
  const spectrum = new Float32Array(512).fill(-100);
  for (const hz of [1500, 1670]) {
    const bin = hz * 1024 / 12000;
    spectrum[Math.floor(bin)] = -20;
    spectrum[Math.ceil(bin)] = -20;
  }
  snapped.ui.state.wfSpectrumDb = spectrum;
  snapped.elements["rtty-auto-mark"].listeners.click();
  const expectedMark = mode === "DATA-L" ? 1500 : 1670;
  assert.ok(Math.abs(snapped.ui.state.decoder.markHz - expectedMark) <= 15,
    `${mode} Auto Mark must select the correct side of the detected tone pair`);
  assert.equal(snapped.ui.state.decoder.shiftHz, 170);
}

console.log("RTTY mode menu, settings, polarity and waterfall controls: OK");
