"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const preferenceKey = "freerig710-ft8-auto-arm-selection-v1";
const sources = new Map(["ft8-qso-machine.js", "ft8.js", "ft8-page.js"].map(name =>
  [name, fs.readFileSync(path.join(__dirname, "..", "frontend", name), "utf8")]));
const noop = () => {};
const settle = () => new Promise(resolve => setImmediate(resolve));

// Run the real controller, QSO machine and page TX/selection paths. Only DOM,
// timers, radio/audio and waveform I/O are simulated; no real radio is contacted.
async function fixture({ saved, storage = new Map(), storageUnavailable = false } = {}) {
  if (saved !== undefined) storage.set(preferenceKey, saved);
  const elements = new Map();
  function element(name) {
    if (!elements.has(name)) elements.set(name, {
      checked: ["ft8-auto-seq", "ft8-auto-arm-selection", "ft8-hold-tx"].includes(name),
      value: name === "ft8-cq-auto" ? "first" : "",
      textContent: "", disabled: false, dataset: {}, children: [],
      style: { setProperty: noop },
      classList: { add: noop, remove: noop, toggle: noop },
      listeners: new Map(),
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      fire(type, event = {}) { return this.listeners.get(type)?.({ currentTarget: this, target: this, ...event }); },
      contains() { return true; },
      setAttribute: noop,
      getBoundingClientRect() { return { left: 0, width: 100 }; },
    });
    return elements.get(name);
  }
  const requests = [];
  const context = vm.createContext({
    console, performance, Headers, AbortController,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    WebSocket: class { static OPEN = 1; },
    window: {
      location: { hostname: "test.invalid", origin: "http://test.invalid" },
      addEventListener: noop, setTimeout: () => 0, clearTimeout: noop,
    },
    document: {
      getElementById: element, querySelectorAll: () => [], querySelector: () => null,
      addEventListener: noop, activeElement: null, hidden: false,
    },
    localStorage: {
      getItem(key) { if (storageUnavailable) throw new Error("storage disabled"); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageUnavailable) throw new Error("storage disabled"); storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert(["/api/v1/state", "/api/v1/ft8/tx/stop"].includes(url), `Unexpected API request: ${url}`);
      return { ok: true, json: async () => ({ radio_power: "ON", ptt_active: false, tx_state: "RX" }) };
    },
  });
  const load = name => vm.runInContext(sources.get(name), context, { filename: name });
  load("ft8-qso-machine.js");
  load("ft8.js");
  const c = context.window.FT710_FT8;
  // Omit unrelated decoder/logbook startup and table rendering.
  c.init = () => c.initQsoMachine();
  c.preloadEncoder = noop;
  c.renderDecodeRows = noop;
  c.queueGridTrackerStatus = noop;
  c.myCall = "SA7CHI";
  c.myGrid = "JO65";
  c.getTimingEstimate = () => ({ valid: true });
  load("ft8-page.js");
  const page = context.window.FT710_FT8_PAGE;
  await page.pollState();
  page.activeBand = "20m";
  page.dialHz = 14074000;
  page.audioReady = true;
  page.socket = { readyState: 1 };
  page.lastAudioMessageAt = Date.now();
  page.txLevelTuned = true;
  page.txLevelDbfs = -20;
  page.ensureAudio = async () => {};
  page.applyTxVfoB = async () => true;
  page.setTxSource = async () => {};
  page.refreshTxDiagnostics = async () => ({ tx: { running: false }, tune: { running: false } });
  page.prepareAutoTxWaveform = async () => { page.txStageWaveform = { byteLength: 1213440 }; return true; };
  page.preparedWaveformMatches = () => true;
  page.ensureAutoTxWaveformStaged = async () => 1;
  page.verifyAutoTxWaveformStaged = async () => true;
  const calls = { select: 0, rearm: 0 };
  const select = c.selectDecode.bind(c);
  c.selectDecode = row => { calls.select += 1; return select(row); };
  const rearm = page.rearmAutoTxFromSelection.bind(page);
  page.rearmAutoTxFromSelection = () => { calls.rearm += 1; return rearm(); };
  function row(text, slotIndex = 100) {
    return { key: `${slotIndex}|1234|${text}`, text, parsed: c.parseMessage(text),
      df: 1234, snr: -8.4, dt: 0.2, slotIndex };
  }
  function reply(row) { return { ...c.gridTrackerDecodePayload(row, true), type: "reply" }; }
  async function selectRow(row, gridTracker = false) {
    c.decodeRows = [row];
    const accepted = gridTracker ? await c.handleGridTrackerCommand(reply(row)) : await c.selectDecodeFromActivity(row);
    await settle();
    return accepted;
  }
  return { c, page, calls, element, storage, requests, row, reply, selectRow };
}

async function main() {
  for (const saved of [undefined, "1", "0"]) {
    const f = await fixture({ saved });
    assert.equal(f.c.autoArmOnSelection, saved !== "0");
    assert.equal(f.element("ft8-auto-arm-selection").checked, saved !== "0");
  }
  {
    const f = await fixture();
    const option = f.element("ft8-auto-arm-selection");
    option.checked = false;
    option.fire("change");
    assert.equal(f.storage.get(preferenceKey), "0");
    assert.equal(f.c.autoArmOnSelection, false);
    assert.equal(f.c.autoSeq, true);
    assert.equal(f.c.qsoMachine.options.autoSeq, true);
    const restored = await fixture({ storage: f.storage });
    assert.equal(restored.c.autoArmOnSelection, false);
    f.element("ft8-auto-seq").checked = false;
    f.element("ft8-auto-seq").fire("change");
    option.checked = true;
    option.fire("change");
    assert.equal(f.storage.get(preferenceKey), "1");
    assert.equal(f.c.autoArmOnSelection, true);
    assert.equal(f.c.autoSeq, false);
    assert.equal(f.c.qsoMachine.options.autoSeq, false);
    assert.equal((await fixture({ storage: f.storage })).c.autoArmOnSelection, true);
    await f.selectRow(f.row("EA1ABC K3LL -08"));
    assert.equal(f.calls.rearm, 1);
    assert.equal(f.page.autoTxEnabled, true); // Auto Seq off does not suppress arming.
  }
  {
    const f = await fixture({ storageUnavailable: true });
    assert.equal(f.c.autoArmOnSelection, true);
    f.element("ft8-auto-arm-selection").checked = false;
    assert.doesNotThrow(() => f.element("ft8-auto-arm-selection").fire("change"));
    assert.equal(f.c.autoArmOnSelection, false);
  }

  // Every parseable message kind uses the same QSO preparation and optional
  // arming, whether selected locally or by an exactly matching WSJT-X Reply.
  const cases = [
    ["CQ K3LL FN20", "ANSWERING_CQ", "K3LL SA7CHI JO65"],
    ["QRZ K3LL FN20", "SELECTED", "K3LL SA7CHI JO65"],
    ...["-08", "R-08", "RRR", "RR73", "73", "FN20", "HELLO"].map(payload =>
      [`EA1ABC K3LL ${payload}`, "SELECTED", "K3LL SA7CHI JO65"]),
    ["SA7CHI K3LL -08", "SEND_R_REPORT", "K3LL SA7CHI R-08"],
    ["SA7CHI K3LL R-08", "SEND_RR73", "K3LL SA7CHI RR73"],
    ["SA7CHI K3LL RR73", "SEND_73", "K3LL SA7CHI 73"],
  ];
  for (const saved of ["1", "0"]) {
    for (const gridTracker of [false, true]) {
      for (const [index, [text, state, message]] of cases.entries()) {
        const f = await fixture({ saved });
        const row = f.row(text, 100 + index);
        const accepted = await f.selectRow(row, gridTracker);
        if (!gridTracker) assert.equal(accepted, true);
        assert.equal(f.calls.select, 1);
        assert.equal(f.calls.rearm, saved === "1" ? 1 : 0);
        assert.equal(f.c.qso.dxCall, "K3LL");
        assert.equal(f.c.qso.state, state);
        assert.equal(f.c.qso.df, 1234);
        assert.equal(f.page.getTxDf(), 1230); // Existing TX cursor rounds to 10 Hz.
        assert.equal(f.c.qso.rxSlotParity, row.slotIndex & 1);
        assert.equal(f.c.qso.txSlotParity, (row.slotIndex & 1) ^ 1);
        assert.equal(f.page.getTxSlotParity(), f.c.qso.txSlotParity);
        assert.equal(f.c.txReport, "-08");
        assert.equal(f.c.getTxPlan().message, message);
        assert.equal(f.page.txPlanMessage, message);
        assert.equal(f.page.autoTxEnabled, saved === "1");
        assert.equal(f.element("ft8-enable-tx").disabled, saved === "1");
      }
    }
  }

  // Both activity tables dispatch through the same configurable selection path.
  for (const saved of ["1", "0"]) {
    for (const bodyId of ["ft8-decodes-body", "ft8-rx-decodes-body"]) {
      const f = await fixture({ saved });
      const row = f.row("EA1ABC K3LL -08");
      f.c.decodeRows = [row];
      f.c.setupActivityPointerSelection();
      f.element(bodyId).fire("click", { target: { closest: () => ({ dataset: { ft8RowKey: row.key } }) } });
      await settle();
      assert.equal(f.c.qso.dxCall, "K3LL");
      assert.equal(f.calls.select, 1);
      assert.equal(f.calls.rearm, saved === "1" ? 1 : 0);
      assert.equal(f.page.autoTxEnabled, saved === "1");
    }
  }

  // Existing Reply matching fields remain required, with case/whitespace
  // normalization for message text. Test the uncached parser path as well.
  {
    const f = await fixture({ saved: "0" });
    const row = f.row("EA1ABC K3LL -08");
    delete row.parsed;
    f.c.decodeRows = [row];
    const reply = f.reply(row);
    const mismatches = { message: "CQ K3LL FN20", milliseconds_since_midnight: 1,
      snr: 0, delta_time_seconds: 0.3, delta_frequency_hz: 1235, mode: "+", low_confidence: true };
    for (const [field, value] of Object.entries(mismatches)) {
      await f.c.handleGridTrackerCommand({ ...reply, [field]: value });
      assert.equal(f.calls.select, 0, `${field} mismatch must not select`);
    }
    await f.c.handleGridTrackerCommand({ ...reply, message: "  ea1abc k3ll -08  " });
    assert.equal(f.calls.select, 1);
    assert.equal(f.c.qso.dxCall, "K3LL");
    assert.equal(f.calls.rearm, 0);
  }

  for (const saved of ["1", "0"]) {
    // CQ and manual Enable TX still use the real arming code with RF I/O mocked.
    const cq = await fixture({ saved });
    cq.element("ft8-call-cq").fire("click");
    await settle();
    assert.equal(cq.c.qso.state, "CALLING_CQ");
    assert.equal(cq.page.txPlanMessage, "CQ SA7CHI JO65");
    assert.equal(cq.calls.rearm, 1);
    assert.equal(cq.page.autoTxEnabled, true);

    const tx = await fixture({ saved });
    await tx.selectRow(tx.row("EA1ABC K3LL -08"));
    if (tx.page.autoTxEnabled) await tx.page.haltAutoTx("test stop");
    tx.element("ft8-enable-tx").fire("click");
    await settle();
    assert.equal(tx.page.autoTxEnabled, true);
    assert.equal(tx.page.autoTxLastMessage, "K3LL SA7CHI JO65");
    await tx.c.handleGridTrackerCommand({ type: "halt_tx" });
    assert.equal(tx.page.autoTxEnabled, false);
    assert(tx.requests.some(request => request.url === "/api/v1/ft8/tx/stop"));
    tx.element("ft8-enable-tx").fire("click");
    await settle();
    tx.element("ft8-halt-tx").fire("click");
    await settle();
    assert.equal(tx.page.autoTxEnabled, false);
    assert.equal(tx.c.qso.state, "ABORTED");

    for (const gridTracker of [false, true]) {
      const f = await fixture({ saved });
      const row = f.row("SA7CHI K3LL -08");
      await f.selectRow(row, gridTracker);
      const other = f.row("CQ EA1ABC IN52", 101);
      if (f.page.autoTxEnabled) {
        assert.equal(f.c.selectDecode(other), false); // Cannot bypass the STOP barrier.
        assert.equal(f.c.qso.dxCall, "K3LL");
      }
      if (f.page.autoTxEnabled) await f.page.haltAutoTx("test stop");
      const before = JSON.stringify(f.c.qsoMachine.snapshot());
      const rearmCount = f.calls.rearm;
      // A running backend TX cannot be replanned, including the same DX.
      f.page.autoTxSessionActive = true;
      f.page.refreshTxDiagnostics = async () => ({ tx: { running: true } });
      await f.selectRow(row, gridTracker);
      assert.equal(JSON.stringify(f.c.qsoMachine.snapshot()), before);
      assert.equal(f.calls.rearm, rearmCount);
      assert.equal(f.c.selectDecode(row), false); // The synchronous guard also remains.

      // Switching DX must STOP and wait for backend idle before replacement.
      let finishIdle;
      f.page.waitForFt8BackendIdle = () => new Promise(resolve => { finishIdle = resolve; });
      const pending = f.selectRow(other, gridTracker);
      await settle();
      assert.equal(typeof finishIdle, "function");
      assert.equal(JSON.stringify(f.c.qsoMachine.snapshot()), before);
      assert.equal(f.calls.rearm, rearmCount);
      finishIdle(false);
      await pending;
      assert.equal(JSON.stringify(f.c.qsoMachine.snapshot()), before);
      assert.equal(f.calls.rearm, rearmCount);

      f.page.autoTxSessionActive = true;
      f.page.waitForFt8BackendIdle = async () => true;
      f.page.refreshTxDiagnostics = async () => ({ tx: { running: false } });
      await f.selectRow(other, gridTracker);
      assert.equal(f.c.qso.dxCall, "EA1ABC");
      assert.equal(f.page.autoTxEnabled, saved === "1");
      assert.equal(f.calls.rearm, rearmCount + (saved === "1" ? 1 : 0));
    }
  }
  for (const saved of ["1", "0"]) {
    const f = await fixture({ saved });
    assert.equal(await f.selectRow(f.row("NOT A STATION")), false);
    assert.equal(await f.selectRow(f.row("CQ SA7CHI JO65")), false);
    assert.equal(f.calls.rearm, 0);
    assert.equal(f.page.autoTxEnabled, false);
    f.page.tuneRunning = true;
    f.page.refreshTxDiagnostics = async () => ({ tune: { running: true } });
    await f.selectRow(f.row("EA1ABC K3LL -08"), true);
    assert.equal(f.c.qso.state, "IDLE");
    assert.equal(f.calls.rearm, 0);
  }
  console.log("FT8 GridTracker/local selection, persisted auto-arm, explicit TX and safety guards: OK");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
