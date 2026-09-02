"use strict";

const byId = (id) => document.getElementById(id);
const LOCAL_GUI_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const IS_LOCAL_GUI = LOCAL_GUI_HOSTS.has(window.location.hostname);

function normalizeBackend(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) return "";
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    return "";
  }
}

let savedBackend = "";
try { savedBackend = localStorage.getItem("freerig710-backend") || ""; } catch (_) { /* optional */ }
const DEFAULT_LOCAL_BACKEND = normalizeBackend(window.FT710_CONFIG?.localDefaultBackend || "http://ft710.local");
let API_BASE = IS_LOCAL_GUI ? (normalizeBackend(savedBackend) || DEFAULT_LOCAL_BACKEND) : "";

function apiUrl(path) {
  const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

function websocketUrl(path) {
  const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  const base = API_BASE || window.location.origin;
  const url = new URL(normalizedPath, `${base.replace(/\/$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function backendDisplayName() {
  return API_BASE || window.location.origin;
}

function stationSettings() {
  return window.FreeRig710Settings?.get?.() || {
    call: "",
    grid: "",
    backend: "",
    winlinkCall: "",
    winlinkGrid: "",
    winlinkPassword: "",
    effectiveWinlinkCall: "",
    effectiveWinlinkGrid: "",
  };
}

function normalizeStationCall(value) {
  return window.FreeRig710Settings?.normalizeCall?.(value)
    || String(value || "").trim().toUpperCase().replace(/[^A-Z0-9/]/g, "").slice(0, 16);
}

function normalizeGridSquare(value) {
  return window.FreeRig710Settings?.normalizeGrid?.(value)
    || String(value || "").trim().toUpperCase().replace(/[^A-R0-9]/g, "").slice(0, 8);
}

function saveStationSettings(values) {
  if (window.FreeRig710Settings?.set) return window.FreeRig710Settings.set(values);
  try {
    if (Object.prototype.hasOwnProperty.call(values, "call")) localStorage.setItem("freerig710-settings-call", normalizeStationCall(values.call));
    if (Object.prototype.hasOwnProperty.call(values, "grid")) localStorage.setItem("freerig710-settings-grid", normalizeGridSquare(values.grid));
    if (Object.prototype.hasOwnProperty.call(values, "backend")) localStorage.setItem("freerig710-backend", normalizeBackend(values.backend));
    if (Object.prototype.hasOwnProperty.call(values, "winlinkCall")) localStorage.setItem("freerig710-settings-winlink-call", normalizeStationCall(values.winlinkCall));
    if (Object.prototype.hasOwnProperty.call(values, "winlinkGrid")) localStorage.setItem("freerig710-settings-winlink-grid", normalizeGridSquare(values.winlinkGrid));
    if (Object.prototype.hasOwnProperty.call(values, "winlinkPassword")) localStorage.setItem("freerig710-settings-winlink-password", String(values.winlinkPassword || ""));
  } catch (_) { /* optional */ }
  return stationSettings();
}
const MODES = [
  "LSB", "USB", "CW-U", "FM", "AM", "RTTY-L", "CW-L", "DATA-L",
  "RTTY-U", "DATA-FM", "FM-N", "DATA-U", "AM-N", "PSK", "DATA-FM-N"
];
const WIDTH_SSB_HZ = [
  null, 300, 400, 600, 850, 1100, 1200, 1500, 1650, 1800, 1950, 2100,
  2250, 2400, 2450, 2500, 2600, 2700, 2800, 2900, 3000, 3200, 3500, 4000,
];
const WIDTH_CW_DATA_HZ = [
  null, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 800,
  1200, 1400, 1700, 2000, 2400, 3000, 3200, 3500, 4000,
];
const PENDING_TTL_MS = 10_000;

const FT710_AUDIO_WORKLET_SOURCE = "\"use strict\";\n\nclass FT710CaptureProcessor extends AudioWorkletProcessor {\n  constructor(options) {\n    super();\n    const requestedMs = Number(options?.processorOptions?.frameMs ?? 20);\n    const frameMs = Math.max(10, Math.min(60, requestedMs));\n    this.frameSamples = Math.max(128, Math.round(sampleRate * frameMs / 1000));\n    this.frame = new Int16Array(this.frameSamples);\n    this.offset = 0;\n    this.enabled = false;\n    this.port.onmessage = (event) => {\n      if (event.data?.type !== \"capture\") return;\n      this.enabled = Boolean(event.data.enabled);\n      this.frame = new Int16Array(this.frameSamples);\n      this.offset = 0;\n    };\n  }\n\n  process(inputs) {\n    if (!this.enabled) return true;\n    const input = inputs[0];\n    if (!input || input.length === 0 || !input[0]) return true;\n    const channel = input[0];\n\n    for (let index = 0; index < channel.length; index += 1) {\n      const sample = Math.max(-1, Math.min(1, channel[index]));\n      this.frame[this.offset] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);\n      this.offset += 1;\n      if (this.offset >= this.frame.length) {\n        const completed = this.frame;\n        this.port.postMessage(completed.buffer, [completed.buffer]);\n        this.frame = new Int16Array(this.frameSamples);\n        this.offset = 0;\n      }\n    }\n    return true;\n  }\n}\n\nclass FT710PlaybackProcessor extends AudioWorkletProcessor {\n  constructor(options) {\n    super();\n    const opts = options?.processorOptions || {};\n    const targetMs = Math.max(100, Math.min(350, Number(opts.targetBufferMs ?? 300)));\n    const startMs = Math.max(80, Math.min(targetMs, Number(opts.startBufferMs ?? 280)));\n    const maximumMs = Math.max(targetMs + 100, Math.min(1500, Number(opts.maximumBufferMs ?? 1000)));\n\n    this.capacity = Math.max(4096, Math.round(sampleRate * 2.0));\n    this.ring = new Float32Array(this.capacity);\n    this.totalWritten = 0;\n    this.readPosition = 0;\n    this.started = false;\n    this.lastSample = 0;\n    this.targetSamples = sampleRate * targetMs / 1000;\n    this.startSamples = sampleRate * startMs / 1000;\n    this.maximumSamples = sampleRate * maximumMs / 1000;\n    this.minimumSamples = sampleRate * 0.045;\n    this.underruns = 0;\n    this.overruns = 0;\n    this.reportCounter = 0;\n    this.playbackRate = 1;\n\n    this.port.onmessage = (event) => {\n      if (!(event.data instanceof ArrayBuffer)) return;\n      const samples = new Int16Array(event.data);\n      if (samples.length === 0) return;\n\n      for (let index = 0; index < samples.length; index += 1) {\n        this.ring[this.totalWritten % this.capacity] = samples[index] / 32768;\n        this.totalWritten += 1;\n      }\n\n      let buffered = this.totalWritten - this.readPosition;\n      if (buffered > this.maximumSamples || buffered > this.capacity - 256) {\n        // A stalled tab/network must not leave seconds of stale receive audio.\n        // Jump back to the target delay and restart with a clean short buffer.\n        this.readPosition = Math.max(0, this.totalWritten - this.targetSamples);\n        this.started = true;\n        this.overruns += 1;\n      }\n    };\n  }\n\n  sampleAt(position) {\n    if (position < 0 || position >= this.totalWritten) return 0;\n    return this.ring[Math.floor(position) % this.capacity];\n  }\n\n  fillSilence(channel) {\n    channel.fill(0);\n    for (let index = 1; index < channel.length; index += 1) channel[index] = 0;\n  }\n\n  process(_inputs, outputs) {\n    const output = outputs[0];\n    if (!output || output.length === 0) return true;\n    const channel = output[0];\n    let buffered = this.totalWritten - this.readPosition;\n\n    if (!this.started) {\n      if (buffered < this.startSamples) {\n        channel.fill(0);\n        for (let outputIndex = 1; outputIndex < output.length; outputIndex += 1) {\n          output[outputIndex].fill(0);\n        }\n        this.report(output[0].length);\n        return true;\n      }\n      this.started = true;\n      this.lastSample = 0;\n    }\n\n    // Correct clock drift gently. High buffer -> consume a little faster;\n    // low buffer -> consume a little slower. The correction is inaudible but\n    // prevents periodic drop-outs between the radio USB clock and Mac clock.\n    buffered = this.totalWritten - this.readPosition;\n    const normalizedError = (buffered - this.targetSamples) / Math.max(1, this.targetSamples);\n    const correction = Math.max(-0.012, Math.min(0.012, normalizedError * 0.018));\n    this.playbackRate = 1 + correction;\n\n    let produced = 0;\n    for (; produced < channel.length; produced += 1) {\n      if (this.readPosition + 1 >= this.totalWritten) break;\n      const base = Math.floor(this.readPosition);\n      const fraction = this.readPosition - base;\n      const first = this.sampleAt(base);\n      const second = this.sampleAt(base + 1);\n      const value = first + (second - first) * fraction;\n      channel[produced] = value;\n      this.lastSample = value;\n      this.readPosition += this.playbackRate;\n    }\n\n    if (produced < channel.length) {\n      // Smoothly fade the last render quantum rather than producing a click.\n      const remaining = channel.length - produced;\n      for (let index = 0; index < remaining; index += 1) {\n        channel[produced + index] = this.lastSample * (1 - (index + 1) / remaining);\n      }\n      this.readPosition = this.totalWritten;\n      this.started = false;\n      this.underruns += 1;\n    } else if ((this.totalWritten - this.readPosition) < this.minimumSamples) {\n      // Slow down before a true underrun; do not force a rebuffer yet.\n      this.playbackRate = Math.min(this.playbackRate, 0.988);\n    }\n\n    for (let outputIndex = 1; outputIndex < output.length; outputIndex += 1) {\n      output[outputIndex].set(channel);\n    }\n    this.report(channel.length);\n    return true;\n  }\n\n  report(renderedSamples) {\n    this.reportCounter += renderedSamples;\n    if (this.reportCounter < sampleRate) return;\n    this.reportCounter -= sampleRate;\n    const bufferedMs = Math.max(0, (this.totalWritten - this.readPosition) * 1000 / sampleRate);\n    this.port.postMessage({\n      type: \"rx-stats\",\n      bufferedMs: Math.round(bufferedMs),\n      underruns: this.underruns,\n      overruns: this.overruns,\n      playbackRate: Number(this.playbackRate.toFixed(5)),\n    });\n  }\n}\n\nregisterProcessor(\"ft710-capture\", FT710CaptureProcessor);\nregisterProcessor(\"ft710-playback\", FT710PlaybackProcessor);\n";


let lastState = null;
let toastTimer = null;
const pendingValues = new Map();
const automaticTimers = new Map();
const automaticLatest = new Map();
const automaticInFlight = new Map();
let jogDragging = false;
let latestJogPosition = 0;
let jogSending = false;
const stationBusy = { radio: false };
let clickTuneSending = false;
let clickTuneHover = null;
let rfSqlModeSwitching = false;
let vfoSplitSwitching = false;
let qrzState = {
  configured: false,
  log_configured: false,
  station_callsign: null,
  api_key_set: false,
  qrz_enabled: true,
  gridtracker_enabled: false,
  gridtracker_host: "",
  gridtracker_port: 2237,
};
let qrzLogging = false;

const CLICK_TUNING_DEFAULTS = Object.freeze({
  nativeWidth: 800,
  nativeHeight: 480,
  waterfallLeft: 72,
  waterfallRight: 742,
  waterfallTop: 160,
  waterfallBottom: 452,
  roundingHz: 10,
});

function clickTuningConfig() {
  const configured = window.FT710_CONFIG?.clickTuning || {};
  const value = { ...CLICK_TUNING_DEFAULTS, ...configured };
  value.nativeWidth = Math.max(1, Number(value.nativeWidth) || 800);
  value.nativeHeight = Math.max(1, Number(value.nativeHeight) || 480);
  value.waterfallLeft = Math.max(0, Number(value.waterfallLeft) || 0);
  value.waterfallRight = Math.min(value.nativeWidth, Number(value.waterfallRight) || value.nativeWidth);
  value.waterfallTop = Math.max(0, Number(value.waterfallTop) || 0);
  value.waterfallBottom = Math.min(value.nativeHeight, Number(value.waterfallBottom) || value.nativeHeight);
  value.roundingHz = Math.max(1, Math.round(Number(value.roundingHz) || 10));
  return value;
}

function parseScopeSpanHz(value) {
  if (value == null) return null;
  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(kHz|MHz|Hz)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  if (unit === "mhz") return Math.round(amount * 1_000_000);
  if (unit === "khz") return Math.round(amount * 1_000);
  return Math.round(amount);
}

function normalizeScopeMode(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[_\/:-]+/g, " ")
    .replace(/\s+/g, " ");

  // Real FT-710 firmware has been observed reading back SS06 mode code 5
  // after WATERFALL CENTER EXPAND was selected. The Yaesu CAT manual marks
  // code 5 as reserved, but treating it as CENTER EXPAND matches the radio's
  // actual display and prevents polling from disabling click tuning.
  if (normalized === "5" || normalized === "UNKNOWN 5") {
    return "WATERFALL CENTER EXPAND";
  }
  return normalized;
}

function publicScopeMode(value) {
  const normalized = normalizeScopeMode(value);
  return normalized || value;
}

function currentScopeMode() {
  const stateValue = effectiveValue("scope_mode", lastState?.scope_mode);
  const selectValue = byId("scope-mode")?.value;
  return normalizeScopeMode(stateValue || selectValue);
}

function scopeSupportsClickTuning() {
  const mode = currentScopeMode();

  // The FT-710 CAT codes that represent CENTER modes are:
  //   0 = 3DSS CENTER
  //   3 = WATERFALL CENTER EXPAND
  //   4 = WATERFALL CENTER NORMAL
  // Accept both the descriptive names and raw/UNKNOWN CAT representations,
  // because the state can briefly expose either form while the UI updates.
  if (new Set(["0", "3", "4", "5", "UNKNOWN 0", "UNKNOWN 3", "UNKNOWN 4", "UNKNOWN 5"]).has(mode)) {
    return true;
  }

  return /(?:^| )CENTER(?: |$)/.test(mode);
}

function clickTuningBounds() {
  const cfg = clickTuningConfig();
  // The calibrated clickable area is fixed for every scope presentation,
  // including WATERFALL CENTER EXPAND. EXPAND does not alter these bounds.
  return {
    ...cfg,
    activeTop: cfg.waterfallTop,
    activeBottom: cfg.waterfallBottom,
  };
}

function currentClickTuneFrequencyHz(nativeX) {
  const cfg = clickTuningConfig();
  const spanHz = parseScopeSpanHz(effectiveValue("scope_span", lastState?.scope_span));
  const currentHz = Number(effectiveValue("frequency_hz", lastState?.frequency_hz));
  if (!Number.isFinite(spanHz) || spanHz <= 0 || !Number.isFinite(currentHz)) return null;
  const width = cfg.waterfallRight - cfg.waterfallLeft;
  if (width <= 0) return null;
  const normalized = Math.max(0, Math.min(1, (nativeX - cfg.waterfallLeft) / width));
  const rawHz = currentHz + (normalized - 0.5) * spanHz;
  return Math.round(rawHz / cfg.roundingHz) * cfg.roundingHz;
}

function clickTunePositionInsideWaterfall(position) {
  if (!position) return false;
  const bounds = clickTuningBounds();
  return position.nativeX >= bounds.waterfallLeft
    && position.nativeX <= bounds.waterfallRight
    && position.nativeY >= bounds.activeTop
    && position.nativeY <= bounds.activeBottom;
}

function clearClickTuneHover() {
  clickTuneHover = null;
  byId("video-frame")?.classList.remove("click-tuning-hover");
}

function refreshClickTuneOverlay() {
  const frame = byId("video-frame");
  const crosshair = byId("click-tune-crosshair");
  const preview = byId("click-tune-preview");
  if (!frame || !crosshair || !preview) return;

  const available = scopeSupportsClickTuning();
  frame.classList.toggle("click-tuning-available", available);

  if (!available || !clickTuneHover || !clickTunePositionInsideWaterfall(clickTuneHover)) {
    frame.classList.remove("click-tuning-hover");
    return;
  }

  const targetHz = currentClickTuneFrequencyHz(clickTuneHover.nativeX);
  if (!Number.isFinite(targetHz)) {
    frame.classList.remove("click-tuning-hover");
    return;
  }

  crosshair.style.left = `${clickTuneHover.cssX}px`;
  preview.style.left = `${clickTuneHover.cssX}px`;
  preview.style.top = `${Math.max(28, clickTuneHover.cssY)}px`;
  preview.textContent = formatFrequency(targetHz);
  frame.classList.add("click-tuning-hover");
}

function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  // Localhost -> ft710.local is cross-origin. GET/HEAD requests deliberately
  // carry no non-safelisted headers, so the 600 ms state poll does not create
  // an OPTIONS preflight every time. JSON POST bodies use text/plain, which is
  // CORS-safelisted; the ESP32 still parses the body as JSON.
  if (options.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain;charset=UTF-8");
  }
  const response = await fetch(apiUrl(path), {
    ...options,
    method,
    headers,
    cache: method === "GET" ? "no-store" : options.cache,
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* empty body */ }
  if (!response.ok) throw new Error(payload?.detail || `HTTP ${response.status}`);
  return payload;
}

async function post(path, payload, options = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload), ...options });
}

window.FreeRig710API = Object.freeze({ api, post, apiUrl, websocketUrl });

function valuesMatch(actual, expected) {
  if (typeof expected === "number") return Number(actual) === Number(expected);
  return actual === expected;
}

function setPending(key, value) {
  pendingValues.set(key, { value, expiresAt: Date.now() + PENDING_TTL_MS });
  if (lastState) renderState(lastState);
}

function clearPending(key, expectedValue = undefined) {
  if (expectedValue === undefined) {
    pendingValues.delete(key);
    return;
  }
  const pending = pendingValues.get(key);
  if (pending && valuesMatch(pending.value, expectedValue)) pendingValues.delete(key);
}

function effectiveValue(key, actual) {
  const pending = pendingValues.get(key);
  if (!pending) return actual;
  if (valuesMatch(actual, pending.value)) {
    pendingValues.delete(key);
    return actual;
  }
  if (Date.now() >= pending.expiresAt) {
    pendingValues.delete(key);
    return actual;
  }
  return pending.value;
}

async function submitSetting({ key, value, path, payload, successMessage = null, button = null }) {
  if (key) setPending(key, value);
  if (button) button.disabled = true;
  try {
    const result = await post(path, payload);
    if (result?.state) updateState(result.state);
    if (successMessage) showToast(successMessage);
    return result;
  } catch (error) {
    if (key) clearPending(key, value);
    if (lastState) renderState(lastState);
    showToast(error.message, true);
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}


function qrzBandFromFrequency(frequencyHz) {
  const hz = Number(frequencyHz);
  if (!Number.isFinite(hz)) return "--";
  const bands = [
    [135700, 137800, "2190m"], [472000, 479000, "630m"],
    [1800000, 2000000, "160m"], [3500000, 4000000, "80m"],
    [5060000, 5450000, "60m"], [7000000, 7300000, "40m"],
    [10100000, 10150000, "30m"], [14000000, 14350000, "20m"],
    [18068000, 18168000, "17m"], [21000000, 21450000, "15m"],
    [24890000, 24990000, "12m"], [28000000, 29700000, "10m"],
    [50000000, 54000000, "6m"], [70000000, 71000000, "4m"],
  ];
  return bands.find(([lower, upper]) => hz >= lower && hz <= upper)?.[2] || "OUT OF BAND";
}

function qrzRadioContext(state = lastState) {
  if (!state) return { txFrequency: null, rxFrequency: null, radioMode: null, txPower: null };
  const activeVfo = ["A", "B"].includes(state.active_vfo) ? state.active_vfo : "A";
  const rxVfo = ["A", "B"].includes(state.rx_vfo) ? state.rx_vfo : activeVfo;
  const txVfo = ["A", "B"].includes(state.tx_vfo) ? state.tx_vfo : activeVfo;
  const frequencies = { A: state.vfo_a_hz, B: state.vfo_b_hz };
  const modes = { A: state.vfo_a_mode, B: state.vfo_b_mode };
  const txValue = frequencies[txVfo] ?? state.frequency_hz;
  const rxValue = frequencies[rxVfo] ?? state.frequency_hz;
  return {
    txFrequency: txValue == null ? null : Number(txValue),
    rxFrequency: rxValue == null ? null : Number(rxValue),
    radioMode: modes[txVfo] || state.mode || null,
    txPower: state.tx_power_w == null ? null : Number(state.tx_power_w),
  };
}

function qrzUtcText() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function logDestinationLabel(state = qrzState) {
  const destinations = [];
  if (state?.qrz_enabled) destinations.push("QRZ");
  if (state?.gridtracker_enabled) destinations.push("GridTracker");
  return destinations.length ? destinations.join(" + ") : "no destination";
}

function isLogConfigured(state = qrzState) {
  if (Object.prototype.hasOwnProperty.call(state || {}, "log_configured")) return Boolean(state.log_configured);
  return Boolean(state?.configured);
}

function logQsoResultText(qso = {}, fallbackCall = "") {
  const modeText = qso.submode || qso.mode || "--";
  const qrzLogId = qso.destinations?.qrz?.logid || qso.logid || "";
  const logIdText = qrzLogId ? ` · QRZ ${qrzLogId}` : "";
  const rxText = Number(qso.rx_frequency_hz) !== Number(qso.frequency_hz)
    ? ` · RX ${formatFrequency(qso.rx_frequency_hz)} Hz`
    : "";
  const powerText = Number(qso.tx_power_w) > 0 ? ` · ${qso.tx_power_w} W` : "";
  const destinations = qso.destinations
    ? Object.entries(qso.destinations).filter(([, value]) => value?.enabled && value?.sent).map(([key]) => key === "qrz" ? "QRZ" : "GridTracker")
    : [];
  const destinationText = destinations.length ? ` · ${destinations.join(" + ")}` : "";
  return `${qso.call || fallbackCall} logged on ${qso.band || "--"} · ${modeText} · TX ${formatFrequency(qso.frequency_hz)} Hz${rxText}${powerText}${logIdText}${destinationText}`;
}

function setQrzLogStatus(text, state = "") {
  const element = byId("qrz-log-status");
  if (!element) return;
  element.textContent = text;
  element.className = `qrz-status${state ? ` ${state}` : ""}`;
}

function updateQrzLogButton() {
  const button = byId("qrz-log-submit");
  if (!button) return;
  const context = qrzRadioContext();
  const call = byId("qrz-call")?.value.trim();
  const radioReady = lastState?.radio_power === "ON"
    && Number.isFinite(context.txFrequency)
    && Boolean(context.radioMode);
  button.classList.toggle("busy", qrzLogging);
  button.textContent = qrzLogging ? "LOGGING…" : "LOG QSO";
  button.disabled = qrzLogging || !isLogConfigured(qrzState) || !radioReady || !call;
}

function renderQrzPreview(state = lastState) {
  if (!byId("qrz-tx-frequency")) return;
  const context = qrzRadioContext(state);
  byId("qrz-station-call").textContent = qrzState.station_callsign || stationSettings().call || "Not configured";
  byId("qrz-tx-frequency").textContent = Number.isFinite(context.txFrequency)
    ? `${formatFrequency(context.txFrequency)} Hz`
    : "--.---.---";
  byId("qrz-rx-frequency").textContent = Number.isFinite(context.rxFrequency)
    ? `${formatFrequency(context.rxFrequency)} Hz`
    : "--.---.---";
  byId("qrz-band").textContent = qrzBandFromFrequency(context.txFrequency);
  byId("qrz-radio-mode").textContent = context.radioMode || "--";
  byId("qrz-tx-power").textContent = context.txPower == null ? "--" : `${context.txPower} W`;
  byId("qrz-utc").textContent = `${qrzUtcText()} UTC`;
  updateQrzLogButton();
}

function applyQrzStatus(status, options = {}) {
  qrzState = status || qrzState;
  const stationCall = normalizeStationCall(qrzState.station_callsign || "");
  if (stationCall && !stationSettings().call) saveStationSettings({ call: stationCall });
  const configState = byId("qrz-config-state");
  const resultElement = byId("qrz-log-result");
  if (configState) {
    configState.textContent = isLogConfigured(qrzState)
      ? `Saved on ESP32 · ${logDestinationLabel(qrzState)} · edit in Settings`
      : `Not configured · ${logDestinationLabel(qrzState)} · edit in Settings`;
  }
  if (isLogConfigured(qrzState)) {
    setQrzLogStatus("READY", "ready");
    if (resultElement && !options.keepResult) {
      resultElement.textContent = options.resultMessage || "Ready. QSO time is captured when you press LOG QSO.";
    }
  } else {
    setQrzLogStatus("NOT CONFIGURED", "error");
    if (resultElement && !options.keepResult) {
      resultElement.textContent = "Open Settings to enable QRZ and/or GridTracker.";
    }
  }
  renderQrzPreview();
}

async function initQrzLog() {
  const form = byId("qrz-log-form");
  if (!form) return;
  const callInput = byId("qrz-call");
  const configState = byId("qrz-config-state");
  const resultElement = byId("qrz-log-result");

  const sanitizeCall = (input) => {
    const start = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9/]/g, "");
    if (start != null) input.setSelectionRange(start, start);
  };

  callInput.addEventListener("input", () => {
    sanitizeCall(callInput);
    updateQrzLogButton();
  });
  byId("qrz-log-mode").addEventListener("change", () => renderQrzPreview());

  try {
    const response = await api("/api/v1/log/status");
    applyQrzStatus(response.qrz || response);
  } catch (error) {
    setQrzLogStatus("ERROR", "error");
    configState.textContent = error.message;
    resultElement.textContent = error.message;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (qrzLogging) return;
    const call = callInput.value.trim().toUpperCase();
    if (!call) return;

    qrzLogging = true;
    setQrzLogStatus("LOGGING", "working");
    resultElement.textContent = `Logging ${call} to ${logDestinationLabel(qrzState)}…`;
    updateQrzLogButton();
    try {
      const response = await post("/api/v1/log/qso", {
        call,
        mode: byId("qrz-log-mode").value,
        timestamp_utc: new Date().toISOString(),
      });
      const jobId = Number(response?.job?.job_id || 0);
      if (!jobId) throw new Error("Log worker did not return a job id");

      let job = response.job;
      const deadline = Date.now() + 15_000;
      while (job && (job.state === "queued" || job.state === "running")) {
        if (Date.now() >= deadline) throw new Error("Log request timed out");
        resultElement.textContent = job.state === "queued"
          ? `Queued ${call} for log…`
          : `Logging ${call}…`;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const status = await api("/api/v1/log/qso/status");
        if (Number(status?.job?.job_id) !== jobId) continue;
        job = status.job;
      }
      if (!job || job.state !== "ok") {
        throw new Error(job?.detail || "Log rejected QSO");
      }
      const qso = job.qso || {};
      if (qso.adif) console.info("Log ADIF sent:", qso.adif);
      setQrzLogStatus("LOGGED", "ready");
      resultElement.textContent = logQsoResultText(qso, call);
      callInput.value = "";
      showToast(`${qso.call || call} logged`);
    } catch (error) {
      setQrzLogStatus("ERROR", "error");
      resultElement.textContent = error.message;
      showToast(error.message, true);
    } finally {
      qrzLogging = false;
      updateQrzLogButton();
    }
  });

  window.setInterval(() => renderQrzPreview(), 1000);
}

function initStationSettings() {
  const button = byId("settings-button");
  const dialog = byId("settings-dialog");
  const form = byId("settings-form");
  const closeButton = byId("settings-close");
  const cancelButton = byId("settings-cancel");
  const callInput = byId("settings-call");
  const gridInput = byId("settings-grid");
  const winlinkCallSameInput = byId("settings-winlink-call-same");
  const winlinkGridSameInput = byId("settings-winlink-grid-same");
  const winlinkCallInput = byId("settings-winlink-call");
  const winlinkGridInput = byId("settings-winlink-grid");
  const winlinkPasswordInput = byId("settings-winlink-password");
  const logQrzEnableInput = byId("settings-log-qrz-enable");
  const logGridTrackerEnableInput = byId("settings-log-gridtracker-enable");
  const gridTrackerHostInput = byId("settings-gridtracker-host");
  const gridTrackerPortInput = byId("settings-gridtracker-port");
  const apiKeyInput = byId("settings-qrz-api-key");
  const backendInput = byId("settings-backend");
  const adiFileInput = byId("settings-adi-file");
  const adiProgress = byId("settings-adi-progress");
  const logbookStatus = byId("settings-logbook-status");
  const qrzSyncButton = byId("settings-qrz-sync");
  const logSettingsStatus = byId("settings-log-status");
  const wireguardConfigInput = byId("settings-wireguard-config");
  const wireguardEnableInput = byId("settings-wireguard-enable");
  const wireguardStatus = byId("settings-wireguard-status");
  const saveButton = byId("settings-save");
  const status = byId("settings-status");
  if (!button || !dialog || !form || !callInput || !gridInput || !winlinkCallSameInput || !winlinkGridSameInput || !winlinkCallInput || !winlinkGridInput || !winlinkPasswordInput || !logQrzEnableInput || !logGridTrackerEnableInput || !gridTrackerHostInput || !gridTrackerPortInput || !apiKeyInput || !backendInput || !saveButton || !status) return;

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("error", isError);
  };

  const setWireGuardStatus = (message, isError = false) => {
    if (!wireguardStatus) return;
    wireguardStatus.textContent = message;
    wireguardStatus.classList.toggle("error", isError);
  };

  const setLogSettingsStatus = (message, isError = false) => {
    if (!logSettingsStatus) return;
    logSettingsStatus.textContent = message;
    logSettingsStatus.classList.toggle("error", isError);
  };

  const describeWireGuard = (wg) => {
    if (!wg) return "WireGuard status unavailable.";
    if (wg.starting) return "WireGuard starting…";
    if (wg.active) {
      const peer = wg.peer_up ? "peer up" : "handshaking";
      return `WireGuard active${wg.interface_ip ? ` · ${wg.interface_ip}` : ""} · ${peer}`;
    }
    if (wg.configured && wg.enable_on_boot) return `WireGuard enabled on boot${wg.last_error_text ? ` · ${wg.last_error_text}` : ""}`;
    if (wg.configured) return "WireGuard config saved · disabled on boot";
    return "WireGuard not configured.";
  };

  const applyWireGuardStatus = (wg) => {
    if (wireguardConfigInput && typeof wg?.config_text === "string") wireguardConfigInput.value = wg.config_text;
    if (wireguardEnableInput) wireguardEnableInput.checked = Boolean(wg?.enable_on_boot);
    const isError = Boolean(wg?.last_error && wg.last_error !== "ESP_OK" && wg.configured && wg.enable_on_boot);
    setWireGuardStatus(describeWireGuard(wg), isError);
    if (wg?.starting) window.setTimeout(loadWireGuardSettings, 2500);
  };

  const loadWireGuardSettings = async () => {
    if (!wireguardConfigInput || !wireguardEnableInput) return;
    setWireGuardStatus("Loading WireGuard settings…");
    try {
      const response = await api("/api/v1/wireguard/status");
      applyWireGuardStatus(response.wireguard || response);
    } catch (error) {
      setWireGuardStatus(`WireGuard status unavailable: ${error.message}`, true);
    }
  };

  const renderLogbookSettingsStatus = async () => {
    const lb = window.FreeRig710FT8Logbook;
    if (!logbookStatus) return null;
    if (!lb) {
      logbookStatus.textContent = "Logbook module unavailable";
      return null;
    }
    try {
      const counts = await lb.loadIndexCaches();
      logbookStatus.textContent = `${counts.calls} worked calls · ${counts.dxcc} DXCC · ${counts.countries || 0} countries`;
      return counts;
    } catch (error) {
      logbookStatus.textContent = `Logbook error: ${error?.message || error}`;
      return null;
    }
  };

  const adifValueLength = (value) => {
    const textValue = String(value ?? "");
    try {
      return new TextEncoder().encode(textValue).length;
    } catch (_) {
      return textValue.length;
    }
  };

  const adifRecordText = (record) => {
    const raw = String(record?.raw || "").trim();
    if (raw) return /<\s*EOR\s*>/i.test(raw) ? raw : `${raw}<EOR>`;
    const fields = record?.fields || {};
    let out = "";
    for (const [name, value] of Object.entries(fields)) {
      const key = String(name || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
      const textValue = String(value ?? "");
      if (!key || !textValue || key === "EOR" || key === "EOH") continue;
      out += `<${key}:${adifValueLength(textValue)}>${textValue}`;
    }
    return out ? `${out}<EOR>` : "";
  };

  const createGridTrackerAdifQueue = () => {
    const chunks = [];
    const maxChunk = 5600;
    let current = "";
    let recordCount = 0;
    const push = (textValue) => {
      const adif = String(textValue || "");
      if (!adif) return;
      if (current && current.length + adif.length > maxChunk) {
        chunks.push(current);
        current = "";
      }
      if (adif.length > maxChunk) chunks.push(adif);
      else current += adif;
      recordCount += 1;
    };
    return {
      addRecords(records) {
        for (const record of records || []) push(adifRecordText(record));
      },
      finish() {
        if (current) {
          chunks.push(current);
          current = "";
        }
        return { chunks, recordCount };
      },
    };
  };

  const broadcastGridTrackerChunks = async (queued, label) => {
    const chunks = queued?.chunks || [];
    const recordCount = Number(queued?.recordCount || 0);
    if (!chunks.length) return { sentRecords: 0, sentChunks: 0, skipped: false };
    let state = qrzState;
    try {
      const response = await api("/api/v1/log/status");
      state = response.qrz || response.log || response;
    } catch (error) {
      return { sentRecords: 0, sentChunks: 0, skipped: false, error: error?.message || String(error) };
    }
    if (!state?.gridtracker_enabled || !state?.gridtracker_configured) {
      return { sentRecords: 0, sentChunks: 0, skipped: true };
    }
    let lastDetail = "";
    for (let i = 0; i < chunks.length; i += 1) {
      if (logbookStatus) logbookStatus.textContent = `${label} · GridTracker UDP ${i + 1}/${chunks.length}`;
      try {
        const response = await post("/api/v1/log/gridtracker/adif", { adif: chunks[i] });
        lastDetail = response?.detail || lastDetail;
      } catch (error) {
        return { sentRecords: 0, sentChunks: i, skipped: false, error: error?.message || String(error) };
      }
    }
    return { sentRecords: recordCount, sentChunks: chunks.length, skipped: false, detail: lastDetail };
  };

  const gridTrackerBroadcastSuffix = (result) => {
    if (!result || result.skipped) return "";
    if (result.error) return ` · GridTracker failed: ${result.error}`;
    if (result.sentChunks) return ` · GridTracker ${result.sentRecords} ADIF QSO sent`;
    return "";
  };

  const importAdiFromSettings = async (file) => {
    const lb = window.FreeRig710FT8Logbook;
    if (!file || !lb || !logbookStatus) return;
    const gtQueue = createGridTrackerAdifQueue();
    logbookStatus.dataset.importing = "1";
    logbookStatus.textContent = `Importing ${file.name}…`;
    if (adiProgress) adiProgress.value = 0;
    try {
      const result = await lb.importAdiFile(file, { onProgress: (p) => {
        if (adiProgress) adiProgress.value = p.total ? Math.min(100, Math.round(p.bytes * 100 / p.total)) : 0;
        logbookStatus.textContent = `Parsed ${p.parsed} · new ${p.imported} · duplicates ${p.duplicates} · errors ${p.errors}`;
      }, onRecords: (records) => gtQueue.addRecords(records) });
      if (adiProgress) adiProgress.value = 100;
      const gtResult = await broadcastGridTrackerChunks(gtQueue.finish(), "ADI import");
      window.dispatchEvent(new CustomEvent("freerig-ft8-logbook-updated"));
      const counts = await renderLogbookSettingsStatus();
      logbookStatus.textContent = `Done · ${result.imported} new · ${result.duplicates} duplicates · ${result.errors} errors · ${counts?.calls || 0} worked calls${gridTrackerBroadcastSuffix(gtResult)}`;
    } catch (error) {
      logbookStatus.textContent = `Import failed: ${error?.message || error}`;
    } finally {
      delete logbookStatus.dataset.importing;
      if (adiFileInput) adiFileInput.value = "";
    }
  };

  const waitQrzFetchJob = async (jobId, deadlineMs = 20_000) => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const response = await api("/api/v1/qrz/fetch/status");
      const job = response?.job;
      if (Number(job?.job_id) !== Number(jobId)) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        continue;
      }
      if (["ok", "error", "cancelled"].includes(job.state)) return job;
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    throw new Error("QRZ FETCH timeout");
  };

  let settingsQrzSyncRunning = false;
  const runSettingsQrzSync = async () => {
    const lb = window.FreeRig710FT8Logbook;
    if (settingsQrzSyncRunning || !lb || !logbookStatus || !qrzSyncButton) return;
    settingsQrzSyncRunning = true;
    qrzSyncButton.disabled = true;
    let totalParsed = 0;
    let totalFetched = 0;
    let totalErrors = 0;
    let pages = 0;
    const stagedRecords = [];
    const gtQueue = createGridTrackerAdifQueue();
    try {
      const qrz = await api("/api/v1/qrz/status");
      if (!qrz?.qrz?.configured) throw new Error("Configure station callsign and QRZ Logbook API key first");
      await window.FreeRig710FT8CTY?.ready;
      let after = "0";
      logbookStatus.textContent = "QRZ Sync · authoritative full reconciliation from LOGID 0";
      for (;;) {
        let job = null;
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const accepted = await post("/api/v1/qrz/fetch", { after_logid: after, max: 250 });
            job = await waitQrzFetchJob(Number(accepted?.job?.job_id || 0));
            if (job?.state !== "ok") throw new Error(job?.detail || "QRZ FETCH rejected");
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 1000 * (2 ** attempt)));
          }
        }
        if (lastError) throw lastError;
        const pageResponse = await fetch(apiUrl("/api/v1/qrz/fetch/page"), { cache: "no-store" });
        if (!pageResponse.ok) throw new Error(`QRZ page HTTP ${pageResponse.status}`);
        const adif = await pageResponse.text();
        const parsed = adif.trim() ? lb.parseAdi(adif) : { records: [], stats: { records: 0, errors: 0, ignored: 0 } };
        const pageParsed = Number(parsed?.stats?.records || 0);
        const pageErrors = Number(parsed?.stats?.errors || 0);
        if (Number(job?.count || 0) > 0 && pageParsed === 0) throw new Error(`QRZ returned ${job?.count || 0} QSO but the ADIF parser produced 0 records`);
        const pageRecords = parsed?.records || [];
        stagedRecords.push(...pageRecords);
        gtQueue.addRecords(pageRecords);
        pages += 1;
        totalFetched += Number(job?.count || 0);
        totalParsed += pageParsed;
        totalErrors += pageErrors;
        after = String(job?.next_after_logid || after);
        logbookStatus.textContent = `QRZ page ${pages} · ${job?.count || 0} fetched / ${pageParsed} parsed · ${totalParsed} staged`;
        if (!job?.has_more || Number(job?.count || 0) === 0) break;
      }
      logbookStatus.textContent = `QRZ Sync · replacing local log with ${totalParsed} QRZ QSO…`;
      const replaced = await lb.replaceAllRecords(stagedRecords, { source: "qrz" });
      await lb.setSyncState("qrz", { nextAfterLogId: after, lastPageCount: pages ? Number(stagedRecords.length) : 0, lastSyncAt: new Date().toISOString(), complete: true, authoritative: true, qsoCount: Number(replaced?.stored || 0) });
      const counts = await renderLogbookSettingsStatus();
      const gtResult = await broadcastGridTrackerChunks(gtQueue.finish(), "QRZ Sync");
      window.dispatchEvent(new CustomEvent("freerig-ft8-logbook-updated"));
      logbookStatus.textContent = `QRZ complete · ${pages} page${pages === 1 ? "" : "s"} · ${totalFetched} fetched · ${replaced?.stored || 0} QRZ QSO stored · ${counts?.calls || 0} worked calls · ${counts?.dxcc || 0} DXCC · ${counts?.countries || 0} countries${totalErrors ? ` · ${totalErrors} ADIF warnings` : ""}${gridTrackerBroadcastSuffix(gtResult)}`;
    } catch (error) {
      logbookStatus.textContent = `QRZ sync failed: ${error?.message || error} · local log unchanged`;
    } finally {
      settingsQrzSyncRunning = false;
      qrzSyncButton.disabled = false;
    }
  };

  const applyWinlinkSameState = () => {
    const mainCall = normalizeStationCall(callInput.value || qrzState.station_callsign || "");
    const mainGrid = normalizeGridSquare(gridInput.value || "");
    const sameCall = winlinkCallSameInput.checked;
    const sameGrid = winlinkGridSameInput.checked;
    if (sameCall) winlinkCallInput.value = mainCall;
    if (sameGrid) winlinkGridInput.value = mainGrid;
    winlinkCallInput.disabled = sameCall;
    winlinkGridInput.disabled = sameGrid;
    winlinkCallInput.placeholder = mainCall ? `Same as CALL (${mainCall})` : "Same as CALL";
    winlinkGridInput.placeholder = mainGrid ? `Same as GRID (${mainGrid})` : "Same as GRID";
  };

  const syncFields = () => {
    const settings = stationSettings();
    const mainCall = settings.call || normalizeStationCall(qrzState.station_callsign || "");
    const mainGrid = settings.grid || "";
    const winlinkCallOverride = normalizeStationCall(settings.winlinkCall || "");
    const winlinkGridOverride = normalizeGridSquare(settings.winlinkGrid || "");
    callInput.value = mainCall;
    gridInput.value = mainGrid;
    winlinkCallSameInput.checked = !winlinkCallOverride;
    winlinkGridSameInput.checked = !winlinkGridOverride;
    winlinkCallInput.value = winlinkCallOverride || mainCall;
    winlinkGridInput.value = winlinkGridOverride || mainGrid;
    applyWinlinkSameState();
    winlinkPasswordInput.value = "";
    winlinkPasswordInput.placeholder = settings.winlinkPassword ? "Saved locally; leave blank to keep it" : "Winlink Secure Login password";
    backendInput.value = IS_LOCAL_GUI ? (settings.backend || API_BASE || DEFAULT_LOCAL_BACKEND) : window.location.origin;
    backendInput.disabled = !IS_LOCAL_GUI;
    logQrzEnableInput.checked = qrzState.api_key_set ? qrzState.qrz_enabled !== false : false;
    logGridTrackerEnableInput.checked = Boolean(qrzState.gridtracker_enabled);
    gridTrackerHostInput.value = qrzState.gridtracker_host || "";
    gridTrackerPortInput.value = String(Number(qrzState.gridtracker_port) || 2237);
    apiKeyInput.value = "";
    apiKeyInput.placeholder = qrzState.api_key_set ? "Saved on ESP32; leave blank to keep it" : "Paste QRZ Logbook API key";
    setLogSettingsStatus(isLogConfigured(qrzState) ? `Log destinations: ${logDestinationLabel(qrzState)}` : "Enable QRZ and/or GridTracker to log QSOs.");
    setStatus("Settings are shared by Radio, FT8, JS8 and Winlink.");
    if (wireguardConfigInput) wireguardConfigInput.value = "";
    if (wireguardEnableInput) wireguardEnableInput.checked = false;
    setWireGuardStatus("WireGuard settings are stored on the ESP32.");
  };

  const openDialog = () => {
    syncFields();
    dialog.hidden = false;
    loadWireGuardSettings();
    void renderLogbookSettingsStatus();
    window.setTimeout(() => callInput.focus(), 0);
  };

  const closeDialog = () => {
    dialog.hidden = true;
  };

  button.addEventListener("click", openDialog);
  closeButton?.addEventListener("click", closeDialog);
  cancelButton?.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  window.addEventListener("keydown", (event) => {
    if (!dialog.hidden && event.key === "Escape") closeDialog();
  });
  callInput.addEventListener("input", () => {
    callInput.value = normalizeStationCall(callInput.value);
    applyWinlinkSameState();
  });
  gridInput.addEventListener("input", () => {
    gridInput.value = normalizeGridSquare(gridInput.value);
    applyWinlinkSameState();
  });
  winlinkCallSameInput.addEventListener("change", () => {
    applyWinlinkSameState();
    if (!winlinkCallSameInput.checked) winlinkCallInput.focus();
  });
  winlinkGridSameInput.addEventListener("change", () => {
    applyWinlinkSameState();
    if (!winlinkGridSameInput.checked) winlinkGridInput.focus();
  });
  winlinkCallInput.addEventListener("input", () => {
    winlinkCallInput.value = normalizeStationCall(winlinkCallInput.value);
  });
  winlinkGridInput.addEventListener("input", () => {
    winlinkGridInput.value = normalizeGridSquare(winlinkGridInput.value);
  });
  apiKeyInput.addEventListener("input", () => {
    if (apiKeyInput.value.trim()) logQrzEnableInput.checked = true;
  });
  adiFileInput?.addEventListener("change", () => void importAdiFromSettings(adiFileInput.files?.[0]));
  qrzSyncButton?.addEventListener("click", () => void runSettingsQrzSync());
  window.addEventListener("freerig710-settings-changed", () => {
    const settings = stationSettings();
    const backend = IS_LOCAL_GUI ? (settings.backend || API_BASE || DEFAULT_LOCAL_BACKEND) : window.location.origin;
    const backendStatus = byId("status-backend");
    if (backendStatus) backendStatus.textContent = backend;
    renderQrzPreview();
  });
  window.addEventListener("freerig-ft8-logbook-updated", () => {
    if (logbookStatus?.dataset.importing || settingsQrzSyncRunning) return;
    void renderLogbookSettingsStatus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const call = normalizeStationCall(callInput.value);
    const grid = normalizeGridSquare(gridInput.value);
    const sameWinlinkCall = winlinkCallSameInput.checked;
    const sameWinlinkGrid = winlinkGridSameInput.checked;
    const winlinkCall = sameWinlinkCall ? call : normalizeStationCall(winlinkCallInput.value);
    const winlinkGrid = sameWinlinkGrid ? grid : normalizeGridSquare(winlinkGridInput.value);
    const winlinkPassword = winlinkPasswordInput.value;
    const backend = IS_LOCAL_GUI ? normalizeBackend(backendInput.value || DEFAULT_LOCAL_BACKEND) : "";
    const qrzKey = apiKeyInput.value.trim();
    const qrzEnabled = logQrzEnableInput.checked;
    const gridTrackerEnabled = logGridTrackerEnableInput.checked;
    const gridTrackerHost = gridTrackerHostInput.value.trim();
    const gridTrackerPort = Number(gridTrackerPortInput.value || 2237);
    const gridOk = !grid || /^[A-R]{2}\d{2}(?:[A-X]{2}(?:\d{2})?)?$/.test(grid);
    const winlinkGridOk = !winlinkGrid || /^[A-R]{2}\d{2}(?:[A-X]{2}(?:\d{2})?)?$/.test(winlinkGrid);

    if (!call) {
      setStatus("Call is required.", true);
      return;
    }
    if (!sameWinlinkCall && !winlinkCall) {
      setStatus("Winlink Callsign is required or enable Same as CALL.", true);
      return;
    }
    if (!gridOk) {
      setStatus("Grid must be a valid Maidenhead locator, for example JO65 or JO65MO.", true);
      return;
    }
    if (!winlinkGridOk) {
      setStatus("Winlink locator must be a valid Maidenhead locator, for example JO65 or JO65MO.", true);
      return;
    }
    if (IS_LOCAL_GUI && !backend) {
      setStatus("ESP32 backend URL is invalid.", true);
      return;
    }
    if (qrzEnabled && !qrzKey && !qrzState.api_key_set) {
      setStatus("QRZ Logbook API key is required when QRZ logging is enabled.", true);
      return;
    }
    if (gridTrackerEnabled && !gridTrackerHost) {
      setStatus("GridTracker IP is required when GridTracker logging is enabled.", true);
      return;
    }
    if (!Number.isInteger(gridTrackerPort) || gridTrackerPort < 1 || gridTrackerPort > 65535) {
      setStatus("GridTracker UDP port must be 1..65535.", true);
      return;
    }

    const previousBackend = API_BASE;
    const backendChanged = IS_LOCAL_GUI && backend && backend !== previousBackend;
    saveButton.disabled = true;
    setStatus("Saving settings…");
    const settingsPayload = {
      call,
      grid,
      backend: IS_LOCAL_GUI ? backend : stationSettings().backend,
      winlinkCall: sameWinlinkCall ? "" : winlinkCall,
      winlinkGrid: sameWinlinkGrid ? "" : winlinkGrid,
    };
    if (winlinkPassword) settingsPayload.winlinkPassword = winlinkPassword;
    saveStationSettings(settingsPayload);
    if (backendChanged) API_BASE = backend;

    let qrzError = "";
    let wireguardError = "";
    try {
      const payload = {
        station_callsign: call,
        qrz_enabled: qrzEnabled,
        gridtracker_enabled: gridTrackerEnabled,
        gridtracker_host: gridTrackerHost,
        gridtracker_port: gridTrackerPort,
      };
      if (qrzKey) payload.api_key = qrzKey;
      const response = await post("/api/v1/log/config", payload);
      apiKeyInput.value = "";
      const savedLogState = response.qrz || response;
      const readyMessage = isLogConfigured(savedLogState)
        ? "Log configuration saved. Ready to log QSOs."
        : "Log configuration saved. No log destination is enabled.";
      applyQrzStatus(savedLogState, { resultMessage: readyMessage });
      setLogSettingsStatus(isLogConfigured(savedLogState) ? `Log destinations: ${logDestinationLabel(savedLogState)}` : "No log destination is enabled.");
    } catch (error) {
      qrzError = error.message;
      setLogSettingsStatus(error.message, true);
    } finally {
      saveButton.disabled = false;
    }

    if (wireguardConfigInput && wireguardEnableInput) {
      try {
        const response = await post("/api/v1/wireguard/config", {
          config_text: wireguardConfigInput.value,
          enable_on_boot: wireguardEnableInput.checked,
        });
        applyWireGuardStatus(response.wireguard || response);
      } catch (error) {
        wireguardError = error.message;
        setWireGuardStatus(error.message, true);
      }
    }

    const backendStatus = byId("status-backend");
    if (backendStatus) backendStatus.textContent = backendDisplayName();
    const remoteErrors = [];
    if (qrzError) remoteErrors.push(`Log: ${qrzError}`);
    if (wireguardError) remoteErrors.push(`WireGuard: ${wireguardError}`);
    if (remoteErrors.length) {
      setStatus(`Settings saved locally. ${remoteErrors.join(" · ")}`, true);
      showToast("Settings saved locally; ESP32 config failed", true);
    } else {
      setStatus(backendChanged ? "Settings saved. Reloading for the new backend…" : "Settings saved.");
      showToast("Settings saved");
      if (!backendChanged) window.setTimeout(closeDialog, 350);
    }
    if (backendChanged) window.setTimeout(() => window.location.reload(), 450);
  });

  syncFields();
}

function formatFrequency(hz) {
  if (!Number.isFinite(Number(hz))) return "--.---.---";
  return String(Math.round(Number(hz))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function formatSignedHz(value) {
  if (value == null || value === "") return "--";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  const rounded = Math.round(numeric);
  return `${rounded > 0 ? "+" : ""}${rounded} Hz`;
}

function formatWidthCode(value, mode) {
  if (value == null || value === "") return "--";
  const code = Number(value);
  if (!Number.isFinite(code)) return "--";
  const normalizedCode = Math.max(0, Math.min(23, Math.round(code)));
  const normalizedMode = String(mode ?? "").trim().toUpperCase();

  if (normalizedCode === 0) return "Default";

  let bandwidthHz = null;
  if (normalizedMode === "LSB" || normalizedMode === "USB") {
    bandwidthHz = WIDTH_SSB_HZ[normalizedCode] ?? null;
  } else if (["CW-U", "CW-L", "RTTY-L", "RTTY-U", "DATA-L", "DATA-U", "PSK"].includes(normalizedMode)) {
    bandwidthHz = WIDTH_CW_DATA_HZ[normalizedCode] ?? null;
  } else if (normalizedMode === "AM-N" && normalizedCode === 1) {
    bandwidthHz = 6000;
  } else if (["AM", "FM-N", "DATA-FM-N"].includes(normalizedMode) && normalizedCode === 2) {
    bandwidthHz = 9000;
  } else if (["FM", "DATA-FM"].includes(normalizedMode) && normalizedCode === 3) {
    bandwidthHz = 16000;
  }

  return bandwidthHz == null ? "--" : `${bandwidthHz} Hz`;
}

function setInputValue(id, value, formatter = (x) => x) {
  const element = byId(id);
  if (value == null || document.activeElement === element) return;
  element.value = formatter(value);
}

function setSelectValue(id, value) {
  const element = byId(id);
  if (value == null || value === "" || document.activeElement === element) return;
  const option = [...element.options].find((item) => item.value === String(value));
  if (option) element.value = String(value);
}

function setConnected(connected, error = null, radioPower = null) {
  byId("connection-dot").classList.toggle("online", connected);
  if (connected && radioPower === "OFF") {
    byId("connection-text").textContent = "Radio powered off";
  } else if (connected && radioPower === "STARTING") {
    byId("connection-text").textContent = "Radio starting…";
  } else {
    byId("connection-text").textContent = connected ? "CAT connected" : (error || "ESP32 unavailable");
  }
}

function renderStationControls() {
  const power = lastState?.radio_power || null;
  const radioButton = byId("radio-power-button");
  const radioOn = power === "ON";
  const radioOff = power === "OFF";

  if (radioButton) {
    radioButton.classList.toggle("power-on-action", radioOff);
    radioButton.classList.toggle("power-off-action", radioOn);
    radioButton.textContent = stationBusy.radio
      ? (radioOn ? "STOPPING…" : "STARTING…")
      : (radioOn ? "OFF" : (radioOff ? "ON" : (power === "STARTING" ? "STARTING…" : "POWER…")));
    radioButton.disabled = stationBusy.radio || (!radioOn && !radioOff);
  }

  const powerStatus = byId("status-radio-power");
  if (powerStatus) powerStatus.textContent = power || "--";
}

function initStationControls() {
  const radioButton = byId("radio-power-button");
  if (!radioButton) return;

  radioButton.addEventListener("click", async () => {
    const power = lastState?.radio_power;
    if (power !== "ON" && power !== "OFF") return;
    stationBusy.radio = true;
    renderStationControls();
    try {
      const result = await post("/api/v1/radio/power", { enabled: power === "OFF" });
      if (result?.state) updateState(result.state);
      showToast(power === "OFF" ? "Radio power-on command sent" : "Radio powered off");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      stationBusy.radio = false;
      renderStationControls();
    }
  });

  renderStationControls();
}
function renderRfSqlControl(state) {
  const mode = effectiveValue("rf_sql_vr", state.rf_sql_vr);
  setSelectValue("rf-sql-vr", mode);

  const range = byId("rf-sql-level");
  const label = byId("rf-sql-level-label");
  const output = byId("rf-sql-level-value");
  const statusWrap = byId("squelch-status-wrap");
  const isRfGain = mode === "RF";
  const isSquelch = mode === "SQL" || mode === "SQL_FM";

  range.disabled = rfSqlModeSwitching || (!isRfGain && !isSquelch);
  range.min = "0";
  range.max = isRfGain ? "255" : "100";
  label.textContent = isRfGain
    ? "RF gain"
    : (mode === "SQL_FM" ? "Squelch (FM only)" : "Squelch");
  statusWrap.hidden = !isSquelch;

  const value = isRfGain
    ? effectiveValue("rf_gain", state.rf_gain)
    : (isSquelch ? effectiveValue("squelch_level", state.squelch_level) : null);

  if (rfSqlModeSwitching) {
    output.textContent = "sync…";
  } else {
    if (value != null && document.activeElement !== range) range.value = value;
    output.textContent = value ?? "--";
  }
  byId("squelch-status").textContent = state.squelch_open == null
    ? "--"
    : (state.squelch_open ? "OPEN" : "CLOSED");
}

function renderFilterControls(state) {
  const radioOn = state.radio_power === "ON";
  const mode = effectiveValue("mode", state.mode);

  const widthCode = effectiveValue("width_code", state.width_code);
  const width = byId("filter-width");
  if (widthCode != null && document.activeElement !== width) width.value = widthCode;
  width.disabled = !radioOn || widthCode == null;
  byId("filter-width-value").textContent = formatWidthCode(widthCode, mode);

  const shiftHz = effectiveValue("if_shift_hz", state.if_shift_hz);
  const shift = byId("filter-shift");
  if (shiftHz != null && document.activeElement !== shift) shift.value = shiftHz;
  shift.disabled = !radioOn || shiftHz == null;
  byId("filter-shift-value").textContent = formatSignedHz(shiftHz);

  const manualNotch = effectiveValue("manual_notch", state.manual_notch);
  const manualNotchToggle = byId("manual-notch-enabled");
  if (manualNotch != null && document.activeElement !== manualNotchToggle) {
    manualNotchToggle.checked = Boolean(manualNotch);
  }
  manualNotchToggle.disabled = !radioOn || manualNotch == null;

  const manualNotchHz = effectiveValue("manual_notch_hz", state.manual_notch_hz);
  const manualNotchFrequency = byId("manual-notch-frequency");
  if (manualNotchHz != null && document.activeElement !== manualNotchFrequency) {
    manualNotchFrequency.value = manualNotchHz;
  }
  manualNotchFrequency.disabled = !radioOn || manualNotchHz == null;
  byId("manual-notch-frequency-value").textContent = manualNotchHz == null
    ? "--"
    : `${manualNotchHz} Hz`;

  const contour = effectiveValue("contour", state.contour);
  const contourToggle = byId("contour-enabled");
  if (contour != null && document.activeElement !== contourToggle) {
    contourToggle.checked = Boolean(contour);
  }
  contourToggle.disabled = !radioOn || contour == null;

  const contourHz = effectiveValue("contour_hz", state.contour_hz);
  const contourFrequency = byId("contour-frequency");
  if (contourHz != null && document.activeElement !== contourFrequency) {
    contourFrequency.value = contourHz;
  }
  contourFrequency.disabled = !radioOn || contourHz == null;
  byId("contour-frequency-value").textContent = contourHz == null
    ? "--"
    : `${contourHz} Hz`;
}

function splitModeFromState(state, activeVfo = null) {
  const active = activeVfo || effectiveValue("active_vfo", state?.active_vfo);
  const enabled = effectiveValue("split_enabled", state?.split_enabled);
  if (!active || enabled == null) return "";
  if (!enabled) return "OFF";
  return active === "A" ? "A_TO_B" : "B_TO_A";
}

function renderVfoRouting(state, activeVfo) {
  const splitEnabled = effectiveValue("split_enabled", state.split_enabled);
  const rxVfo = effectiveValue("rx_vfo", state.rx_vfo) || activeVfo;
  const fallbackTx = splitEnabled && activeVfo
    ? (activeVfo === "A" ? "B" : "A")
    : activeVfo;
  const txVfo = effectiveValue("tx_vfo", state.tx_vfo) || fallbackTx;
  const splitMode = splitModeFromState(state, activeVfo);
  const select = byId("vfo-split-mode");
  const status = byId("vfo-split-status");

  if (!vfoSplitSwitching) setSelectValue("vfo-split-mode", splitMode);
  select.disabled = vfoSplitSwitching || splitEnabled == null || !activeVfo;

  if (vfoSplitSwitching) {
    status.textContent = "Synchronizing RX/TX routing…";
  } else if (splitEnabled == null || !rxVfo || !txVfo) {
    status.textContent = "Waiting for radio state…";
  } else if (splitEnabled) {
    status.textContent = `SPLIT ON · RX VFO ${rxVfo} · TX VFO ${txVfo}`;
  } else {
    status.textContent = `SPLIT OFF · RX/TX VFO ${rxVfo}`;
  }

  for (const vfo of ["A", "B"]) {
    const roles = [];
    if (vfo === rxVfo) roles.push("RX");
    if (vfo === txVfo) roles.push("TX");
    byId(`vfo-${vfo.toLowerCase()}-role`).textContent = roles.length ? `· ${roles.join(" / ")}` : "";
    const button = byId(`select-vfo-${vfo.toLowerCase()}`);
    button.textContent = splitEnabled ? `RX on ${vfo}` : `Use ${vfo}`;
    if (vfoSplitSwitching) button.disabled = true;
  }
}

async function applyVfoSplitMode(mode, { button = null, successMessage = null } = {}) {
  if (vfoSplitSwitching) return null;
  const select = byId("vfo-split-mode");
  vfoSplitSwitching = true;
  if (select) {
    select.value = mode;
    select.disabled = true;
  }
  if (button) button.disabled = true;
  if (lastState) renderState(lastState);

  try {
    const result = await post("/api/v1/radio/vfo/split", { mode });
    if (result?.state) updateState(result.state);
    if (successMessage) showToast(successMessage);
    return result;
  } catch (error) {
    showToast(error.message, true);
    throw error;
  } finally {
    vfoSplitSwitching = false;
    if (select) {
      select.disabled = false;
      select.blur();
    }
    for (const vfo of ["A", "B"]) {
      byId(`select-vfo-${vfo.toLowerCase()}`).disabled = false;
    }
    if (button) button.disabled = false;
    if (lastState) renderState(lastState);
  }
}

function renderState(state) {
  setConnected(Boolean(state.connected), state.last_error, state.radio_power);
  updateMemoryControls();

  const activeVfo = effectiveValue("active_vfo", state.active_vfo);
  byId("active-vfo-badge").textContent = `VFO ${activeVfo || "--"}`;
  byId("status-active-vfo").textContent = activeVfo || "--";
  document.querySelector('[data-vfo="A"]').classList.toggle("active", activeVfo === "A");
  document.querySelector('[data-vfo="B"]').classList.toggle("active", activeVfo === "B");
  renderVfoRouting(state, activeVfo);

  const frequencyHz = effectiveValue("frequency_hz", state.frequency_hz);
  byId("frequency-readout").textContent = formatFrequency(frequencyHz);
  setInputValue("frequency-mhz", frequencyHz, (hz) => (Number(hz) / 1_000_000).toFixed(6));

  const vfoAHz = effectiveValue("vfo_a_hz", state.vfo_a_hz);
  const vfoBHz = effectiveValue("vfo_b_hz", state.vfo_b_hz);
  setInputValue("vfo-a-mhz", vfoAHz, (hz) => (Number(hz) / 1_000_000).toFixed(6));
  setInputValue("vfo-b-mhz", vfoBHz, (hz) => (Number(hz) / 1_000_000).toFixed(6));
  byId("vfo-a-mode").textContent = state.vfo_a_mode || "--";
  byId("vfo-b-mode").textContent = state.vfo_b_mode || "--";

  setSelectValue("mode", effectiveValue("mode", state.mode));
  setSelectValue("preamp", effectiveValue("preamp", state.preamp));
  if (state.attenuator_db != null) setSelectValue("attenuator", effectiveValue("attenuator_db", state.attenuator_db));
  setSelectValue("agc", effectiveValue("agc", state.agc));
  setSelectValue("meter-display", effectiveValue("meter_display", state.meter_display));
  setSelectValue("scope-mode", publicScopeMode(effectiveValue("scope_mode", state.scope_mode)));
  setSelectValue("scope-speed", effectiveValue("scope_speed", state.scope_speed));
  setSelectValue("scope-span", effectiveValue("scope_span", state.scope_span));

  renderRfSqlControl(state);
  renderFilterControls(state);

  const txPower = effectiveValue("tx_power_w", state.tx_power_w);
  if (txPower != null && document.activeElement !== byId("tx-power")) byId("tx-power").value = txPower;
  byId("tx-power-value").textContent = txPower == null ? "--" : `${txPower} W`;

  const dnrLevel = effectiveValue("dnr_level", state.dnr_level);
  if (dnrLevel != null && document.activeElement !== byId("dnr-level")) byId("dnr-level").value = dnrLevel;
  byId("dnr-level-value").textContent = dnrLevel ?? "--";
  if (state.dnr != null && document.activeElement !== byId("dnr-enabled")) byId("dnr-enabled").checked = Boolean(effectiveValue("dnr", state.dnr));

  const nbLevel = effectiveValue("noise_blanker_level", state.noise_blanker_level);
  if (nbLevel != null && document.activeElement !== byId("nb-level")) byId("nb-level").value = nbLevel;
  byId("nb-level-value").textContent = nbLevel ?? "--";
  if (state.noise_blanker != null && document.activeElement !== byId("nb-enabled")) byId("nb-enabled").checked = Boolean(effectiveValue("noise_blanker", state.noise_blanker));
  if (state.auto_notch != null && document.activeElement !== byId("auto-notch")) byId("auto-notch").checked = Boolean(effectiveValue("auto_notch", state.auto_notch));

  byId("tx-state").textContent = state.tx_state || "--";
  byId("tuner-state").textContent = state.tuner_busy ? "TUNING" : (state.tuner || "--");
  byId("hi-swr").textContent = state.hi_swr == null ? "--" : (state.hi_swr ? "YES" : "NO");
  byId("cat2-device").textContent = state.cat_device || state.cat2_device || "--";
  byId("radio-id").textContent = state.radio_id || "--";

  if (!jogDragging) {
    const speed = Number(state.jog_speed_hz_s || 0);
    byId("jog-speed").textContent = formatJogSpeed(speed);
  }
  renderStationControls();
  renderQrzPreview(state);
  refreshClickTuneOverlay();
}

function updateState(state) {
  lastState = state;
  renderState(state);
  window.FT710_CW?.updateRadioState(state);
  window.dispatchEvent(new CustomEvent("ft710-radio-state", { detail: state }));
}

function connectEvents() {
  let pollBusy = false;
  let stopped = false;
  const poll = async () => {
    if (pollBusy || stopped) return;
    pollBusy = true;
    try {
      const state = await api("/api/v1/state");
      updateState(state);
    } catch (error) {
      setConnected(false, error.message || "Reconnecting to ESP32…", lastState?.radio_power);
      renderStationControls();
    } finally {
      pollBusy = false;
    }
  };
  void poll();
  const timer = window.setInterval(poll, 600);
  window.addEventListener("pagehide", () => {
    stopped = true;
    window.clearInterval(timer);
  });
}
function initClickTuning() {
  const frame = byId("video-frame");
  const image = byId("radio-video");
  if (!frame || !image || !byId("click-tune-crosshair") || !byId("click-tune-preview")) return;

  const eventPosition = (event) => {
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const cfg = clickTuningConfig();
    return {
      nativeX: (event.clientX - rect.left) * cfg.nativeWidth / rect.width,
      nativeY: (event.clientY - rect.top) * cfg.nativeHeight / rect.height,
      cssX: event.clientX - rect.left,
      cssY: event.clientY - rect.top,
    };
  };

  frame.addEventListener("pointermove", (event) => {
    if (!scopeSupportsClickTuning()) return clearClickTuneHover();
    const position = eventPosition(event);
    if (!clickTunePositionInsideWaterfall(position)) return clearClickTuneHover();
    clickTuneHover = position;
    refreshClickTuneOverlay();
  });

  frame.addEventListener("pointerleave", clearClickTuneHover);

  frame.addEventListener("click", async (event) => {
    if (clickTuneSending || !scopeSupportsClickTuning()) return;
    const position = eventPosition(event);
    if (!clickTunePositionInsideWaterfall(position)) return;
    clickTuneHover = position;
    const targetHz = currentClickTuneFrequencyHz(position.nativeX);
    if (!Number.isFinite(targetHz)) {
      showToast("Frequency or scope span is not available yet", true);
      return;
    }

    clickTuneSending = true;
    try {
      // submitSetting installs a pending frequency immediately. renderState()
      // then recalculates the label under the stationary yellow cursor using
      // the new centre frequency, without waiting for the next CAT poll.
      await submitSetting({
        key: "frequency_hz",
        value: targetHz,
        path: "/api/v1/radio/frequency",
        payload: { frequency_hz: targetHz, vfo: "ACTIVE" },
      });
      refreshClickTuneOverlay();
      showToast(`Tuned to ${formatFrequency(targetHz)} Hz`);
    } finally {
      clickTuneSending = false;
    }
  });

  window.addEventListener("resize", refreshClickTuneOverlay);
  refreshClickTuneOverlay();
}

function initVideo() {
  const image = byId("radio-video");
  const message = byId("video-power-message");
  if (!image || !message) return;

  let retryTimer = null;
  let firstFrameTimer = null;
  let hiddenStopTimer = null;
  let radioPower = lastState?.radio_power || null;
  let connectionGeneration = 0;
  let streamLive = false;
  let hiddenSinceMs = 0;

  // Keep the MJPEG connection alive across short tab switches, but release it
  // after a longer hidden interval so the ESP32 is not encoding JPEG forever
  // for a page that is not being viewed.
  const VIDEO_HIDDEN_GRACE_MS = 20000;
  const VIDEO_FIRST_FRAME_TIMEOUT_MS = 1800;
  const VIDEO_ERROR_RETRY_MS = 400;
  const VIDEO_STALL_RETRY_MS = 250;
  const VIDEO_STARTUP_GRACE_MS = 8000;
  let startupOverlayUntilMs = 0;

  const setMessage = (text = "", variant = "") => {
    message.classList.toggle("is-starting", variant === "starting");
    if (!text) {
      message.hidden = true;
      message.textContent = "";
      return;
    }
    message.textContent = text;
    message.hidden = false;
  };

  const refreshVisualState = (override = null) => {
    if (override) {
      setMessage(override);
    } else if (radioPower === "OFF") {
      setMessage("Radio powered off");
    } else if (radioPower === "STARTING") {
      setMessage("Radio is starting...", "starting");
    } else if (!streamLive && Date.now() < startupOverlayUntilMs) {
      setMessage("Radio is starting...", "starting");
    } else if (streamLive) {
      setMessage();
    } else {
      // A black frame while the first MJPEG image is arriving is less noisy
      // than showing transport/settings status that the operator cannot edit.
      setMessage();
    }
  };

  const stop = () => {
    connectionGeneration += 1;
    clearTimeout(retryTimer);
    clearTimeout(firstFrameTimer);
    clearTimeout(hiddenStopTimer);
    retryTimer = null;
    firstFrameTimer = null;
    hiddenStopTimer = null;
    streamLive = false;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    refreshVisualState();
  };

  const load = () => {
    if (document.hidden || radioPower === "OFF" || radioPower === "STARTING") {
      refreshVisualState();
      return;
    }

    const generation = ++connectionGeneration;
    clearTimeout(retryTimer);
    clearTimeout(firstFrameTimer);
    streamLive = false;
    refreshVisualState();

    image.onload = () => {
      if (generation !== connectionGeneration) return;
      clearTimeout(firstFrameTimer);
      firstFrameTimer = null;
      streamLive = true;
      refreshVisualState();
    };

    image.onerror = () => {
      if (generation !== connectionGeneration || document.hidden ||
          radioPower === "OFF" || radioPower === "STARTING") return;
      clearTimeout(firstFrameTimer);
      firstFrameTimer = null;
      streamLive = false;
      if (Date.now() < startupOverlayUntilMs) refreshVisualState();
      else refreshVisualState("Video unavailable");
      retryTimer = setTimeout(load, VIDEO_ERROR_RETRY_MS);
    };

    image.src = apiUrl(`/video.mjpeg?ts=${Date.now()}`);

    // A stalled multipart request does not always fire <img>.onerror. Tear it
    // down quickly and make a fresh request if the first decoded frame never
    // arrives.
    firstFrameTimer = setTimeout(() => {
      if (generation !== connectionGeneration || streamLive || document.hidden ||
          radioPower === "OFF" || radioPower === "STARTING") return;
      connectionGeneration += 1;
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      if (Date.now() < startupOverlayUntilMs) refreshVisualState();
      else refreshVisualState("Reconnecting radio display…");
      retryTimer = setTimeout(load, VIDEO_STALL_RETRY_MS);
    }, VIDEO_FIRST_FRAME_TIMEOUT_MS);
  };

  document.addEventListener("visibilitychange", () => {
    clearTimeout(hiddenStopTimer);
    hiddenStopTimer = null;

    if (document.hidden) {
      hiddenSinceMs = Date.now();
      if (image.getAttribute("src")) {
        hiddenStopTimer = setTimeout(() => {
          hiddenStopTimer = null;
          if (document.hidden) stop();
        }, VIDEO_HIDDEN_GRACE_MS);
      }
      return;
    }

    const hiddenForMs = hiddenSinceMs ? Math.max(0, Date.now() - hiddenSinceMs) : 0;
    hiddenSinceMs = 0;
    if (radioPower === "OFF" || radioPower === "STARTING") {
      refreshVisualState();
      return;
    }

    if (!image.getAttribute("src") || !streamLive) {
      stop();
      retryTimer = setTimeout(load, 50);
      return;
    }

    refreshVisualState();
    if (hiddenForMs > VIDEO_HIDDEN_GRACE_MS) {
      stop();
      retryTimer = setTimeout(load, 50);
    }
  });

  window.addEventListener("ft710-radio-state", (event) => {
    const nextPower = event.detail?.radio_power || null;
    const previousPower = radioPower;
    radioPower = nextPower;

    if (nextPower === "OFF" || nextPower === "STARTING") {
      if (nextPower === "STARTING") startupOverlayUntilMs = Date.now() + VIDEO_STARTUP_GRACE_MS;
      stop();
      return;
    }

    if (nextPower === "ON" && previousPower !== "ON" && !document.hidden) {
      startupOverlayUntilMs = Date.now() + VIDEO_STARTUP_GRACE_MS;
      stop();
      retryTimer = setTimeout(load, 500);
    } else {
      refreshVisualState();
    }
  });

  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", (event) => {
    if (document.hidden || radioPower === "OFF" || radioPower === "STARTING") return;
    if (event.persisted || !image.getAttribute("src")) {
      stop();
      retryTimer = setTimeout(load, 50);
    }
  });

  refreshVisualState();
  load();
}

function mhzToHz(id) {
  const mhz = Number(byId(id).value);
  if (!Number.isFinite(mhz)) throw new Error("Invalid frequency");
  return Math.round(mhz * 1_000_000);
}

function bindRangeLabel(inputId, outputId, suffix = "") {
  byId(inputId).addEventListener("input", (event) => {
    byId(outputId).textContent = `${event.target.value}${suffix}`;
  });
}

function queueAutomaticSetting({ queueKey, key, value, path, payload, delay = 0, onError = null }) {
  const id = queueKey || key || path;
  if (key) setPending(key, value);
  const setting = { queueKey: id, key, value, path, payload, onError };
  const inFlight = automaticInFlight.get(id);
  if (inFlight && valuesMatch(inFlight.value, value) && JSON.stringify(inFlight.payload) === JSON.stringify(payload)) {
    return;
  }
  automaticLatest.set(id, setting);

  const previousTimer = automaticTimers.get(id);
  if (previousTimer) clearTimeout(previousTimer);

  if (delay > 0) {
    automaticTimers.set(id, setTimeout(() => {
      automaticTimers.delete(id);
      void flushAutomaticSetting(id);
    }, delay));
  } else {
    automaticTimers.delete(id);
    void flushAutomaticSetting(id);
  }
}

async function flushAutomaticSetting(queueKey) {
  if (automaticInFlight.has(queueKey)) return;
  const setting = automaticLatest.get(queueKey);
  if (!setting) return;

  automaticLatest.delete(queueKey);
  automaticInFlight.set(queueKey, setting);
  try {
    await submitSetting(setting);
  } catch (error) {
    if (setting.onError) setting.onError(error);
  } finally {
    automaticInFlight.delete(queueKey);
    if (automaticLatest.has(queueKey)) void flushAutomaticSetting(queueKey);
  }
}

function flushScheduledSetting(queueKey) {
  const timer = automaticTimers.get(queueKey);
  if (timer) clearTimeout(timer);
  automaticTimers.delete(queueKey);
  void flushAutomaticSetting(queueKey);
}

function readFrequencyHz(inputId) {
  const input = byId(inputId);
  if (!input.value || !input.validity.valid) return null;
  const mhz = Number(input.value);
  if (!Number.isFinite(mhz)) return null;
  return Math.round(mhz * 1_000_000);
}

function bindAutomaticFrequency(inputId, vfo, stateKey) {
  const input = byId(inputId);
  const queueKey = `frequency-${vfo.toLowerCase()}`;

  const schedule = (delay) => {
    const frequencyHz = readFrequencyHz(inputId);
    if (frequencyHz == null) return;
    queueAutomaticSetting({
      queueKey,
      key: stateKey,
      value: frequencyHz,
      path: "/api/v1/radio/frequency",
      payload: { frequency_hz: frequencyHz, vfo },
      delay,
    });
  };

  input.addEventListener("input", () => schedule(650));
  input.addEventListener("change", () => schedule(0));
  input.addEventListener("blur", () => schedule(0));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    schedule(0);
    flushScheduledSetting(queueKey);
    input.blur();
  });
}

function bindAutomaticSelect(id, buildSetting) {
  byId(id).addEventListener("change", (event) => {
    const value = event.currentTarget.value;
    if (!value) return;
    queueAutomaticSetting({ ...buildSetting(value), delay: 0 });
  });
}

function bindAutomaticRange(inputId, outputId, suffixOrFormatter, buildSetting) {
  const input = byId(inputId);
  const queueKey = `range-${inputId}`;
  const formatter = typeof suffixOrFormatter === "function"
    ? suffixOrFormatter
    : (value) => `${value}${suffixOrFormatter}`;

  const schedule = (delay) => {
    const value = Number(input.value);
    byId(outputId).textContent = formatter(value);
    queueAutomaticSetting({ queueKey, ...buildSetting(value), delay });
  };

  input.addEventListener("input", () => schedule(250));
  input.addEventListener("change", () => {
    schedule(0);
    flushScheduledSetting(queueKey);
  });
}

function bindAutomaticCheckbox(id, buildSetting) {
  byId(id).addEventListener("change", (event) => {
    const enabled = event.currentTarget.checked;
    queueAutomaticSetting({
      queueKey: `checkbox-${id}`,
      ...buildSetting(enabled),
      delay: 0,
      onError: () => { if (lastState) renderState(lastState); },
    });
  });
}

function formatJogSpeed(speed) {
  if (!Number.isFinite(speed) || Math.abs(speed) < 0.5) return "Stopped";
  const direction = speed < 0 ? "Lower" : "Higher";
  const magnitude = Math.abs(speed);
  if (magnitude >= 1_000_000) return `${direction} ${(magnitude / 1_000_000).toFixed(2)} MHz/s`;
  if (magnitude >= 1_000) return `${direction} ${(magnitude / 1_000).toFixed(1)} kHz/s`;
  return `${direction} ${magnitude.toFixed(0)} Hz/s`;
}

function estimatedJogSpeed(position) {
  const dead = 0.06;
  const magnitude = Math.abs(position);
  if (magnitude <= dead) return 0;
  const normalized = (magnitude - dead) / (1 - dead);
  const speed = 10 * Math.pow(100000 / 10, normalized);
  return Math.sign(position) * speed;
}

async function flushJogQueue() {
  if (jogSending) return;
  jogSending = true;
  try {
    let sentPosition = null;
    while (sentPosition !== latestJogPosition) {
      sentPosition = latestJogPosition;
      try {
        const result = await post("/api/v1/radio/jog", { position: sentPosition });
        if (result?.state) updateState(result.state);
      } catch (error) {
        showToast(error.message, true);
        latestJogPosition = 0;
        byId("frequency-jog").value = 0;
        jogDragging = false;
        break;
      }
    }
  } finally {
    jogSending = false;
  }
}

function queueJog(position) {
  latestJogPosition = Math.max(-1, Math.min(1, Number(position)));
  byId("jog-speed").textContent = formatJogSpeed(estimatedJogSpeed(latestJogPosition));
  void flushJogQueue();
}

function stopJog(useKeepalive = false) {
  jogDragging = false;
  byId("frequency-jog").value = 0;
  latestJogPosition = 0;
  byId("jog-speed").textContent = "Stopped";
  if (useKeepalive) {
    fetch(apiUrl("/api/v1/radio/jog"), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ position: 0 }),
      keepalive: true,
    }).catch(() => {});
  } else {
    void flushJogQueue();
  }
}

function bindControls() {
  const mode = byId("mode");
  for (const name of MODES) mode.add(new Option(name, name));

  byId("frequency-form").addEventListener("submit", (event) => event.preventDefault());
  bindAutomaticFrequency("frequency-mhz", "ACTIVE", "frequency_hz");
  bindAutomaticFrequency("vfo-a-mhz", "A", "vfo_a_hz");
  bindAutomaticFrequency("vfo-b-mhz", "B", "vfo_b_hz");

  for (const vfo of ["A", "B"]) {
    byId(`select-vfo-${vfo.toLowerCase()}`).addEventListener("click", async (event) => {
      const splitEnabled = Boolean(lastState?.split_enabled);
      if (splitEnabled) {
        const mode = vfo === "A" ? "A_TO_B" : "B_TO_A";
        const other = vfo === "A" ? "B" : "A";
        await applyVfoSplitMode(mode, {
          button: event.currentTarget,
          successMessage: `Split enabled: RX VFO ${vfo}, TX VFO ${other}`,
        }).catch(() => {});
        return;
      }

      await submitSetting({
        key: "active_vfo", value: vfo,
        path: "/api/v1/radio/vfo/select", payload: { vfo },
        successMessage: `VFO ${vfo} selected`, button: event.currentTarget,
      }).catch(() => {});
    });
  }

  byId("vfo-split-mode").addEventListener("change", async (event) => {
    const mode = event.currentTarget.value;
    if (!mode) return;
    const messages = {
      OFF: "Split disabled",
      A_TO_B: "Split enabled: RX VFO A, TX VFO B",
      B_TO_A: "Split enabled: RX VFO B, TX VFO A",
    };
    await applyVfoSplitMode(mode, { successMessage: messages[mode] }).catch(() => {});
  });

  for (const [id, action, message] of [
    ["copy-a-b", "copy_a_to_b", "VFO A copied to VFO B"],
    ["swap-vfos", "swap", "VFO A and VFO B swapped"],
    ["copy-b-a", "copy_b_to_a", "VFO B copied to VFO A"],
  ]) {
    byId(id).addEventListener("click", async (event) => {
      await submitSetting({ path: "/api/v1/radio/vfo/operation", payload: { action }, successMessage: message, button: event.currentTarget }).catch(() => {});
    });
  }

  bindAutomaticSelect("mode", (value) => ({
    queueKey: "select-mode", key: "mode", value,
    path: "/api/v1/radio/mode", payload: { mode: value, vfo: "ACTIVE" },
  }));
  bindAutomaticSelect("preamp", (value) => ({
    queueKey: "select-preamp", key: "preamp", value,
    path: "/api/v1/radio/preamp", payload: { value },
  }));
  bindAutomaticSelect("attenuator", (value) => {
    const db = Number(value);
    return {
      queueKey: "select-attenuator", key: "attenuator_db", value: db,
      path: "/api/v1/radio/attenuator", payload: { db },
    };
  });
  bindAutomaticSelect("agc", (value) => ({
    queueKey: "select-agc", key: "agc", value,
    path: "/api/v1/radio/agc", payload: { value },
  }));

  byId("rf-sql-vr").addEventListener("change", async (event) => {
    const select = event.currentTarget;
    const value = select.value;
    if (!value || rfSqlModeSwitching) return;

    rfSqlModeSwitching = true;
    select.disabled = true;
    try {
      await submitSetting({
        key: "rf_sql_vr",
        value,
        path: "/api/v1/radio/rf-sql-vr",
        payload: { value },
      });
    } catch (_) {
      // submitSetting already restores pending state and reports the error.
    } finally {
      rfSqlModeSwitching = false;
      select.disabled = false;
      if (lastState) renderState(lastState);
    }
  });
  bindAutomaticRange("rf-sql-level", "rf-sql-level-value", "", (value) => {
    const mode = byId("rf-sql-vr").value;
    if (mode === "RF") {
      return {
        queueKey: "range-rf-gain", key: "rf_gain", value,
        path: "/api/v1/radio/rf-gain", payload: { value },
      };
    }
    return {
      queueKey: "range-squelch", key: "squelch_level", value,
      path: "/api/v1/radio/squelch", payload: { value },
    };
  });
  bindAutomaticRange(
    "filter-width",
    "filter-width-value",
    (code) => formatWidthCode(code, effectiveValue("mode", lastState?.mode)),
    (widthCode) => ({
      key: "width_code", value: widthCode,
      path: "/api/v1/radio/filter", payload: { width_code: widthCode },
    }),
  );
  bindAutomaticRange("filter-shift", "filter-shift-value", formatSignedHz, (shiftHz) => ({
    key: "if_shift_hz", value: shiftHz,
    path: "/api/v1/radio/filter", payload: { shift_hz: shiftHz },
  }));
  bindAutomaticRange(
    "manual-notch-frequency",
    "manual-notch-frequency-value",
    (frequencyHz) => `${frequencyHz} Hz`,
    (frequencyHz) => ({
      key: "manual_notch_hz", value: frequencyHz,
      path: "/api/v1/radio/filter", payload: { manual_notch_hz: frequencyHz },
    }),
  );
  bindAutomaticRange(
    "contour-frequency",
    "contour-frequency-value",
    (frequencyHz) => `${frequencyHz} Hz`,
    (frequencyHz) => ({
      key: "contour_hz", value: frequencyHz,
      path: "/api/v1/radio/filter", payload: { contour_hz: frequencyHz },
    }),
  );
  bindAutomaticCheckbox("manual-notch-enabled", (enabled) => ({
    key: "manual_notch", value: enabled,
    path: "/api/v1/radio/filter", payload: { manual_notch_enabled: enabled },
  }));
  bindAutomaticCheckbox("contour-enabled", (enabled) => ({
    key: "contour", value: enabled,
    path: "/api/v1/radio/filter", payload: { contour_enabled: enabled },
  }));

  bindAutomaticRange("tx-power", "tx-power-value", " W", (watts) => ({
    key: "tx_power_w", value: watts, path: "/api/v1/radio/tx-power", payload: { watts },
  }));
  bindAutomaticRange("dnr-level", "dnr-level-value", "", (level) => ({
    key: "dnr_level", value: level, path: "/api/v1/radio/dnr", payload: { level },
  }));
  bindAutomaticRange("nb-level", "nb-level-value", "", (level) => ({
    key: "noise_blanker_level", value: level,
    path: "/api/v1/radio/noise-blanker", payload: { level },
  }));

  bindAutomaticCheckbox("dnr-enabled", (enabled) => ({
    key: "dnr", value: enabled, path: "/api/v1/radio/dnr", payload: { enabled },
  }));
  bindAutomaticCheckbox("nb-enabled", (enabled) => ({
    key: "noise_blanker", value: enabled,
    path: "/api/v1/radio/noise-blanker", payload: { enabled },
  }));
  bindAutomaticCheckbox("auto-notch", (enabled) => ({
    key: "auto_notch", value: enabled,
    path: "/api/v1/radio/auto-notch", payload: { enabled },
  }));

  bindAutomaticSelect("meter-display", (value) => ({
    queueKey: "select-meter", key: "meter_display", value,
    path: "/api/v1/radio/meter-display", payload: { value },
  }));
  bindAutomaticSelect("scope-mode", (value) => ({
    queueKey: "select-scope-mode", key: "scope_mode", value,
    path: "/api/v1/radio/scope", payload: { mode: value },
  }));
  bindAutomaticSelect("scope-speed", (value) => ({
    queueKey: "select-scope-speed", key: "scope_speed", value,
    path: "/api/v1/radio/scope", payload: { speed: value },
  }));
  bindAutomaticSelect("scope-span", (value) => ({
    queueKey: "select-scope-span", key: "scope_span", value,
    path: "/api/v1/radio/scope", payload: { span: value },
  }));

  for (const [id, action, value, message] of [
    ["tuner-enable", "enable", "ON", "Tuner enabled"],
    ["tuner-disable", "disable", "OFF", "Tuner disabled"],
  ]) {
    byId(id).addEventListener("click", async (event) => {
      await submitSetting({ key: "tuner", value, path: "/api/v1/radio/tuner", payload: { action }, successMessage: message, button: event.currentTarget }).catch(() => {});
    });
  }
  byId("tuner-tune").addEventListener("click", async (event) => {
    if (!confirm("Start the tuner? The radio may transmit at low power.")) return;
    await submitSetting({ key: "tuner", value: "TUNING", path: "/api/v1/radio/tuner", payload: { action: "tune" }, successMessage: "Tuning started", button: event.currentTarget }).catch(() => {});
  });

  const jog = byId("frequency-jog");
  jog.addEventListener("pointerdown", () => { jogDragging = true; });
  jog.addEventListener("input", (event) => {
    jogDragging = true;
    queueJog(Number(event.target.value) / 100);
  });
  jog.addEventListener("pointerup", () => stopJog());
  jog.addEventListener("pointercancel", () => stopJog());
  jog.addEventListener("change", () => stopJog());
  window.addEventListener("blur", () => stopJog(true));
  window.addEventListener("pagehide", () => stopJog(true));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopJog(true);
  });

  byId("cat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    try {
      const result = await post("/api/v1/cat", {
        command: byId("cat-command").value,
        expect_reply: byId("cat-expect-reply").checked,
      });
      byId("cat-response").textContent = result.response ?? "OK";
      showToast("CAT command sent");
    } catch (error) {
      byId("cat-response").textContent = error.message;
      showToast(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

let memoryRecords = [];
let memoryOperationBusy = false;

function setMemoryStatus(text, state = "") {
  const element = byId("memory-status");
  if (!element) return;
  element.textContent = text;
  element.className = `memory-status${state ? ` ${state}` : ""}`;
}

function updateMemoryControls() {
  const radioOn = lastState?.radio_power === "ON";
  for (const id of ["memory-save", "memory-sync"]) {
    const element = byId(id);
    if (element) element.disabled = memoryOperationBusy || !radioOn;
  }
}

function memoryFrequencyText(hz) {
  return Number.isFinite(Number(hz)) ? formatFrequency(Number(hz)) : "--.---.---";
}

function createMemoryButton(label, action, slot, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.memoryAction = action;
  button.dataset.memorySlot = String(slot);
  if (className) button.className = className;
  return button;
}

function renderMemories() {
  const list = byId("memory-list");
  if (!list) return;
  list.replaceChildren();
  if (!memoryRecords.length) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No cached memories. Press Sync radio to import existing channels.";
    list.append(empty);
    setMemoryStatus("EMPTY");
    return;
  }

  for (const memory of memoryRecords) {
    const item = document.createElement("article");
    item.className = "memory-item";

    const heading = document.createElement("div");
    heading.className = "memory-item-heading";

    const identity = document.createElement("div");
    identity.className = "memory-identity";
    const slot = document.createElement("span");
    slot.className = "memory-slot-badge";
    slot.textContent = String(memory.slot).padStart(3, "0");
    const title = document.createElement("strong");
    title.textContent = memory.tag || `MEMORY ${String(memory.slot).padStart(3, "0")}`;
    identity.append(slot, title);

    const category = document.createElement("span");
    category.className = "memory-category";
    category.textContent = memory.category || memory.mode || "MEM";
    heading.append(identity, category);

    const details = document.createElement("div");
    details.className = "memory-details";
    const frequency = document.createElement("span");
    frequency.className = "memory-frequency";
    frequency.textContent = memoryFrequencyText(memory.frequency_hz);
    const mode = document.createElement("span");
    mode.textContent = memory.mode || "--";
    details.append(frequency, mode);

    if (memory.note) {
      const note = document.createElement("p");
      note.className = "memory-note";
      note.textContent = memory.note;
      item.append(heading, details, note);
    } else {
      item.append(heading, details);
    }

    const actions = document.createElement("div");
    actions.className = "memory-actions";
    actions.append(
      createMemoryButton("Recall", "recall", memory.slot),
      createMemoryButton("VFO A", "vfo-a", memory.slot),
      createMemoryButton("VFO B", "vfo-b", memory.slot),
      createMemoryButton("Edit", "edit", memory.slot),
    );
    item.append(actions);
    list.append(item);
  }
  setMemoryStatus(`${memoryRecords.length} SAVED`, "live");
}

async function loadMemories() {
  const result = await api("/api/v1/memories");
  memoryRecords = Array.isArray(result.memories) ? result.memories : [];
  renderMemories();
}

function openMemoryEditor(memory) {
  const form = byId("memory-edit-form");
  form.hidden = false;
  form.dataset.slot = String(memory.slot);
  byId("memory-edit-slot").textContent = String(memory.slot).padStart(3, "0");
  byId("memory-edit-name").value = memory.tag || "";
  byId("memory-edit-frequency").value = (Number(memory.frequency_hz) / 1_000_000).toFixed(6);
  byId("memory-edit-mode").value = memory.mode || "USB";
  byId("memory-edit-category").value = memory.category || "";
  byId("memory-edit-note").value = memory.note || "";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeMemoryEditor() {
  const form = byId("memory-edit-form");
  form.hidden = true;
  delete form.dataset.slot;
}

async function runMemoryAction(button, action, slot) {
  button.disabled = true;
  try {
    if (action === "recall" || action === "vfo-a" || action === "vfo-b") {
      const radioAction = action === "recall" ? "memory" : action.replace("-", "_");
      await post(`/api/v1/memories/${slot}/recall`, { action: radioAction });
      showToast(action === "recall"
        ? `Memory ${String(slot).padStart(3, "0")} recalled`
        : `Memory ${String(slot).padStart(3, "0")} loaded into ${action.toUpperCase().replace("-", " ")}`);
      window.setTimeout(() => api("/api/v1/state").then(updateState).catch(() => {}), 350);
      return;
    }
    if (action === "edit") {
      const memory = memoryRecords.find((item) => Number(item.slot) === slot);
      if (memory) openMemoryEditor(memory);
      return;
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function initMemories() {
  const slotSelect = byId("memory-slot");
  for (let slot = 1; slot <= 99; slot += 1) {
    const rendered = String(slot).padStart(3, "0");
    slotSelect.add(new Option(rendered, String(slot)));
  }
  const editMode = byId("memory-edit-mode");
  for (const mode of MODES) editMode.add(new Option(mode, mode));

  byId("memory-save-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (memoryOperationBusy) return;
    const selectedSlot = byId("memory-slot").value;
    memoryOperationBusy = true;
    updateMemoryControls();
    setMemoryStatus("SAVING", "working");
    try {
      const result = await post("/api/v1/memories", {
        slot: selectedSlot ? Number(selectedSlot) : null,
        name: byId("memory-name").value,
        category: byId("memory-category").value,
        note: byId("memory-note").value,
        overwrite: byId("memory-overwrite").checked,
      });
      const savedSlot = String(result.memory.slot).padStart(3, "0");
      showToast(`Memory ${savedSlot} saved in the FT-710`);
      byId("memory-overwrite").checked = false;
      await loadMemories();
    } catch (error) {
      setMemoryStatus("ERROR", "error");
      showToast(error.message, true);
    } finally {
      memoryOperationBusy = false;
      updateMemoryControls();
    }
  });

  byId("memory-sync").addEventListener("click", async () => {
    if (memoryOperationBusy) return;
    memoryOperationBusy = true;
    updateMemoryControls();
    setMemoryStatus("SYNCING 001–099", "working");
    try {
      const result = await post("/api/v1/memories/sync", {});
      memoryRecords = result.memories || [];
      renderMemories();
      const errors = result.summary?.errors?.length || 0;
      showToast(`Memory sync complete: ${result.summary?.present || 0} stored${errors ? ` · ${errors} warnings` : ""}`);
    } catch (error) {
      setMemoryStatus("ERROR", "error");
      showToast(error.message, true);
    } finally {
      memoryOperationBusy = false;
      updateMemoryControls();
    }
  });

  byId("memory-list").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-memory-action]");
    if (!button) return;
    const slot = Number(button.dataset.memorySlot);
    void runMemoryAction(button, button.dataset.memoryAction, slot);
  });

  byId("memory-edit-cancel").addEventListener("click", closeMemoryEditor);
  byId("memory-edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const slot = Number(form.dataset.slot);
    if (!Number.isInteger(slot)) return;
    const button = byId("memory-edit-save");
    button.disabled = true;
    setMemoryStatus("UPDATING", "working");
    try {
      const result = await api(`/api/v1/memories/${slot}`, {
        method: "PUT",
        body: JSON.stringify({
          frequency_hz: Math.round(Number(byId("memory-edit-frequency").value) * 1_000_000),
          mode: byId("memory-edit-mode").value,
          name: byId("memory-edit-name").value,
          category: byId("memory-edit-category").value,
          note: byId("memory-edit-note").value,
        }),
      });
      showToast(`Memory ${String(slot).padStart(3, "0")} updated`);
      closeMemoryEditor();
      await loadMemories();
      if (result?.state) updateState(result.state);
    } catch (error) {
      setMemoryStatus("ERROR", "error");
      showToast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  updateMemoryControls();
  loadMemories().catch((error) => {
    setMemoryStatus("ERROR", "error");
    showToast(`Memories: ${error.message}`, true);
  });
}



const COLLAPSED_PANELS_STORAGE_KEY = "ft710-collapsed-panels-v1";
const PANEL_ORDER_STORAGE_KEY = "ft710-panel-order-v1";

function readCollapsedPanelState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_PANELS_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeCollapsedPanelState(state) {
  try { localStorage.setItem(COLLAPSED_PANELS_STORAGE_KEY, JSON.stringify(state)); }
  catch (_) { /* Local storage is optional. */ }
}

function readPanelOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_ORDER_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch (_) {
    return [];
  }
}

function writePanelOrder(order) {
  try { localStorage.setItem(PANEL_ORDER_STORAGE_KEY, JSON.stringify(order)); }
  catch (_) { /* Local storage is optional. */ }
}

function panelStorageKey(panel, index = 0) {
  const explicit = panel.dataset.panelId?.trim();
  if (explicit) return explicit;
  const title = panel.querySelector("h2")?.textContent?.trim().toLowerCase() || `panel-${index}`;
  return title.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `panel-${index}`;
}

function ensurePanelHeading(panel) {
  let header = panel.firstElementChild;
  if (!header) return null;

  if (!header.classList.contains("panel-heading-row")) {
    const heading = Array.from(panel.children).find((element) => element.tagName === "H2");
    if (!heading) return null;
    header = document.createElement("div");
    header.className = "panel-heading-row";
    panel.insertBefore(header, heading);
    header.append(heading);
  }
  return header;
}

function currentPanelOrder(container) {
  return Array.from(container.querySelectorAll(":scope > .panel-card"))
    .map((panel, index) => panelStorageKey(panel, index));
}

function savePanelOrder(container) {
  writePanelOrder(currentPanelOrder(container));
}

function applySavedPanelOrder(container) {
  const panels = Array.from(container.querySelectorAll(":scope > .panel-card"));
  const byKey = new Map(panels.map((panel, index) => [panelStorageKey(panel, index), panel]));
  const savedOrder = readPanelOrder();

  savedOrder.forEach((key) => {
    const panel = byKey.get(key);
    if (!panel) return;
    container.append(panel);
    byKey.delete(key);
  });

  panels.forEach((panel) => {
    const key = panelStorageKey(panel);
    if (byKey.has(key)) container.append(panel);
  });
}

function movePanelByOffset(container, panel, offset) {
  const panels = Array.from(container.querySelectorAll(":scope > .panel-card"));
  const currentIndex = panels.indexOf(panel);
  const targetIndex = Math.max(0, Math.min(panels.length - 1, currentIndex + offset));
  if (currentIndex < 0 || targetIndex === currentIndex) return false;

  const target = panels[targetIndex];
  if (targetIndex < currentIndex) container.insertBefore(panel, target);
  else container.insertBefore(panel, target.nextSibling);
  savePanelOrder(container);
  return true;
}

function initPanelOrdering() {
  const container = document.querySelector(".control-column .grid");
  if (!container) return;

  applySavedPanelOrder(container);
  let drag = null;

  const finishDrag = (event) => {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
    const wasActive = drag.active;
    drag.panel.classList.remove("is-reordering");
    document.body.classList.remove("panel-reorder-active");
    try { drag.handle.releasePointerCapture?.(drag.pointerId); } catch (_) { /* optional */ }
    drag = null;
    if (wasActive) {
      savePanelOrder(container);
      showToast("Panel layout saved");
    }
  };

  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < 6) return;

    if (!drag.active) {
      drag.active = true;
      drag.panel.classList.add("is-reordering");
      document.body.classList.add("panel-reorder-active");
    }

    event.preventDefault();
    const edge = 70;
    if (event.clientY < edge) window.scrollBy(0, -14);
    else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 14);

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".panel-card");
    if (!target || target === drag.panel || target.parentElement !== container) return;

    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const sameRow = event.clientY >= rect.top && event.clientY <= rect.bottom;
    const insertBefore = event.clientY < centerY || (sameRow && Math.abs(event.clientY - centerY) < rect.height * 0.28 && event.clientX < centerX);
    container.insertBefore(drag.panel, insertBefore ? target : target.nextSibling);
  }, { passive: false });

  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);
  window.addEventListener("blur", finishDrag);

  Array.from(container.querySelectorAll(":scope > .panel-card")).forEach((panel, index) => {
    panel.dataset.panelKey = panelStorageKey(panel, index);
    const header = ensurePanelHeading(panel);
    if (!header) return;

    let handle = header.querySelector(".panel-drag-handle");
    if (!handle) {
      handle = document.createElement("button");
      handle.type = "button";
      handle.className = "panel-drag-handle";
      handle.title = "Drag to reorder panel";
      handle.setAttribute("aria-label", `Reorder ${panel.querySelector("h2")?.textContent?.trim() || "panel"}`);
      handle.innerHTML = '<span class="sr-only">Drag to reorder panel</span>';
      header.append(handle);
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      drag = {
        panel,
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
      try { handle.setPointerCapture?.(event.pointerId); } catch (_) { /* optional */ }
    });

    handle.addEventListener("keydown", (event) => {
      let offset = 0;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") offset = -1;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") offset = 1;
      if (!offset) return;
      event.preventDefault();
      if (movePanelByOffset(container, panel, offset)) {
        handle.focus();
        showToast("Panel layout saved");
      }
    });
  });
}

function initCollapsiblePanels() {
  const savedState = readCollapsedPanelState();
  const panels = document.querySelectorAll(".control-column .panel-card");

  panels.forEach((panel, index) => {
    if (panel.dataset.collapsibleReady === "true") return;
    panel.dataset.collapsibleReady = "true";

    const header = ensurePanelHeading(panel);
    if (!header) return;
    header.classList.add("panel-collapse-heading");

    const key = panelStorageKey(panel, index);
    const body = document.createElement("div");
    body.className = "panel-collapse-body";
    body.id = `panel-body-${key}`;
    while (header.nextSibling) body.append(header.nextSibling);
    panel.append(body);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "panel-collapse-toggle";
    toggle.setAttribute("aria-controls", body.id);
    toggle.innerHTML = '<span class="sr-only">Collapse panel</span>';
    header.append(toggle);

    const setCollapsed = (collapsed, persist = true) => {
      panel.classList.toggle("is-collapsed", collapsed);
      body.hidden = collapsed;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.querySelector(".sr-only").textContent = collapsed ? "Expand panel" : "Collapse panel";
      if (persist) {
        savedState[key] = collapsed;
        writeCollapsedPanelState(savedState);
      }
    };

    setCollapsed(savedState[key] === true, false);
    toggle.addEventListener("click", () => setCollapsed(!panel.classList.contains("is-collapsed")));
  });
}


function initLocalUiPreferences() {
  const controls = [
    { id: "qrz-log-mode", key: "ft710-qrz-log-mode-v1", kind: "value" },
    { id: "cat-expect-reply", key: "ft710-cat-expect-reply-v1", kind: "checked" },
    { id: "memory-category", key: "ft710-memory-category-v1", kind: "value" },
  ];
  for (const item of controls) {
    const element = byId(item.id);
    if (!element) continue;
    try {
      const saved = localStorage.getItem(item.key);
      if (saved != null) {
        if (item.kind === "checked") element.checked = saved === "1";
        else if ([...element.options || []].some((option) => option.value === saved)) element.value = saved;
        else if (!(element instanceof HTMLSelectElement)) element.value = saved;
      }
    } catch (_) { /* Local storage is optional. */ }
    element.addEventListener("change", () => {
      try {
        localStorage.setItem(item.key, item.kind === "checked" ? (element.checked ? "1" : "0") : element.value);
      } catch (_) { /* Local storage is optional. */ }
    });
  }
}

function initBackendConfig() {
  const status = byId("status-backend");
  const help = byId("backend-help");
  if (status) status.textContent = backendDisplayName();
  if (help) {
    help.textContent = IS_LOCAL_GUI
      ? "Managed in Settings. Local mode defaults to ft710.local via mDNS/Bonjour."
      : "Managed in Settings. Reverse-proxy mode uses the current HTTPS origin.";
  }

  const form = byId("backend-config-form");
  const input = byId("backend-host");
  const save = byId("backend-save");
  if (!form || !input || !save || !help || !status) return;

  status.textContent = backendDisplayName();
  if (!IS_LOCAL_GUI) {
    input.value = window.location.origin;
    input.disabled = true;
    save.disabled = true;
    help.textContent = "Reverse-proxy mode: API, video and audio use this HTTPS origin.";
    return;
  }

  input.value = API_BASE || DEFAULT_LOCAL_BACKEND;
  help.textContent = "Local mode: default ft710.local via mDNS/Bonjour. Enter an IP/hostname here only as fallback.";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = normalizeBackend(input.value);
    if (!value) {
      showToast("Invalid ESP32 backend URL", true);
      return;
    }
    try { localStorage.setItem("freerig710-backend", value); } catch (_) { /* optional */ }
    API_BASE = value;
    status.textContent = backendDisplayName();
    showToast(`ESP32 backend: ${value}`);
    window.setTimeout(() => window.location.reload(), 250);
  });
}

function initRadioAudioLevels() {
  const controls = [
    {
      input: byId("radio-speaker-volume"),
      value: byId("radio-speaker-volume-value"),
      label: "Radio speaker",
      key: "ft710-radio-speaker-volume-v1",
      min: 0,
      max: 255,
      fallback: 128,
      readCommand: "AG0;",
      readPattern: /^AG0(\d{3});$/,
      setCommand: (value) => `AG0${String(value).padStart(3, "0")};`,
      display: (value) => `${value}/255`,
      pending: null,
      sequence: 0,
    },
    {
      input: byId("radio-aess-volume"),
      value: byId("radio-aess-volume-value"),
      label: "AESS",
      key: "ft710-radio-aess-volume-v1",
      min: 0,
      max: 100,
      fallback: 50,
      readCommand: "AS1;",
      readPattern: /^AS1(\d{3});$/,
      setCommand: (value) => `AS1${String(value).padStart(3, "0")};`,
      display: (value) => `${value}%`,
      pending: null,
      sequence: 0,
    },
  ].filter((control) => control.input && control.value);

  if (!controls.length) return;

  const clamp = (control, value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return control.fallback;
    return Math.max(control.min, Math.min(control.max, Math.round(numeric)));
  };

  const setValue = (control, value) => {
    const next = clamp(control, value);
    control.input.value = String(next);
    control.value.textContent = control.display(next);
    try { localStorage.setItem(control.key, String(next)); } catch (_) { /* optional */ }
    return next;
  };

  const loadSavedValue = (control) => {
    let stored = "";
    try { stored = localStorage.getItem(control.key) || ""; } catch (_) { /* optional */ }
    setValue(control, stored === "" ? control.fallback : stored);
  };

  const readControl = async (control) => {
    try {
      const result = await post("/api/v1/cat", { command: control.readCommand, expect_reply: true });
      const match = String(result?.response || "").match(control.readPattern);
      if (match) setValue(control, Number(match[1]));
    } catch (_) {
      /* Radio may be off or CAT may still be connecting; keep the local value. */
    }
  };

  const sendControl = async (control, { quiet = true } = {}) => {
    const sequence = ++control.sequence;
    const value = setValue(control, control.input.value);
    try {
      await post("/api/v1/cat", { command: control.setCommand(value), expect_reply: false });
      if (!quiet) showToast(`${control.label}: ${control.display(value)}`);
    } catch (error) {
      if (sequence === control.sequence) showToast(`${control.label}: ${error.message}`, true);
    }
  };

  for (const control of controls) {
    loadSavedValue(control);
    control.input.addEventListener("input", () => {
      setValue(control, control.input.value);
      clearTimeout(control.pending);
      control.pending = setTimeout(() => {
        control.pending = null;
        void sendControl(control, { quiet: true });
      }, 180);
    });
    control.input.addEventListener("change", () => {
      clearTimeout(control.pending);
      control.pending = null;
      void sendControl(control, { quiet: false });
    });
  }

  setTimeout(() => {
    for (const control of controls) void readControl(control);
  }, 700);
}

function initAudio() {
  const toggle = byId("audio-toggle");
  const status = byId("audio-status");
  const detail = byId("audio-detail");
  const pttButton = byId("ptt-button");
  const rxVolume = byId("rx-volume");
  const rxVolumeValue = byId("rx-volume-value");
  const txMicGain = byId("tx-mic-gain");
  const txMicGainValue = byId("tx-mic-gain-value");
  const recordAudioButton = byId("record-audio-button");
  const playAudioButton = byId("play-audio-button");
  const playAudioFile = byId("play-audio-file");
  const audioFileStatus = byId("audio-file-status");

  let socket = null;
  let context = null;
  let microphoneStream = null;
  let microphoneSource = null;
  let microphoneGainNode = null;
  let microphoneLimiter = null;
  let captureNode = null;
  let silentGainNode = null;
  let playbackNode = null;
  let speakerGainNode = null;
  let speakerLimiter = null;
  let audioReady = false;
  let receivePcmSampleRate = 48000;
  let transmitPcmSampleRate = 48000;
  let recordingActive = false;
  let recordingChunks = [];
  let recordingBytes = 0;
  let recordingSampleRate = 48000;
  let recordingStartedAt = 0;
  let recordingUiTimer = null;
  let filePlaybackActive = false;
  let filePlaybackAbort = false;
  let filePlaybackSequence = 0;
  let starting = false;
  let stopping = false;
  let pttActive = false;
  let pttPending = false;
  let pttConfirmedAt = 0;
  let pttKeepalive = null;
  let failureInProgress = false;
  let connectTimeout = null;
  let digitalStagedTx = false;
  let ft8TuneAvailable = false;
  let digitalAlcTuneActive = false;
  const audioControlWaiters = [];
  const txPacketMs = 20;
  const maxWebSocketBacklogBytes = 128 * 1024;
  const audioOwnerId = `main-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const audioOwnerChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("freerig710-audio-owner-v1") : null;
  const clampNumber = (value, low, high) => Math.max(low, Math.min(high, value));

  const readSavedGain = (key, fallback, maximum) => {
    try {
      const value = Number(localStorage.getItem(key));
      return Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : fallback;
    } catch (_) {
      return fallback;
    }
  };

  rxVolume.value = String(readSavedGain("ft710-rx-volume-v2", 600, 1200));
  txMicGain.value = String(readSavedGain("ft710-tx-mic-gain-v2", 100, 200));
  rxVolumeValue.textContent = `${rxVolume.value}%`;
  txMicGainValue.textContent = `${txMicGain.value}%`;

  const setAudioStatus = (text, cssClass = "") => {
    status.textContent = text;
    status.className = `audio-status ${cssClass}`.trim();
  };

  const setControlsEnabled = (enabled) => {
    pttButton.disabled = !enabled || pttPending || filePlaybackActive;
    rxVolume.disabled = !enabled;
    txMicGain.disabled = !enabled || filePlaybackActive;
    recordAudioButton.disabled = !enabled || filePlaybackActive;
    playAudioButton.disabled = !enabled || recordingActive;
    window.FT710_CW?.setAudioReady(enabled);
    window.FT710_SSTV?.setAudioReady(enabled);
    window.FT710_FT8?.setAudioReady(enabled);
  };

  const updateCaptureState = () => {
    captureNode?.port.postMessage({ type: "capture", enabled: pttActive && !filePlaybackActive });
  };

  const formatAudioDuration = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const wavHeader = (pcmBytes, sampleRate) => {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const text = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + pcmBytes, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, pcmBytes, true);
    return header;
  };

  const recordingFilename = () => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `FreeRig710-RX-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.wav`;
  };

  const startRecording = () => {
    if (!audioReady || recordingActive || filePlaybackActive) return;
    recordingActive = true;
    recordingChunks = [];
    recordingBytes = 0;
    recordingSampleRate = receivePcmSampleRate || 48000;
    recordingStartedAt = performance.now();
    recordAudioButton.textContent = "Stop Recording";
    recordAudioButton.classList.add("recording");
    setControlsEnabled(audioReady);
    const render = () => {
      if (!recordingActive) return;
      const seconds = (performance.now() - recordingStartedAt) / 1000;
      audioFileStatus.textContent = `Recording RX · ${formatAudioDuration(seconds)} · WAV ${recordingSampleRate} Hz mono`;
    };
    render();
    clearInterval(recordingUiTimer);
    recordingUiTimer = window.setInterval(render, 250);
    showToast("RX recording started");
  };

  const finishRecording = () => {
    if (!recordingActive) return null;
    recordingActive = false;
    clearInterval(recordingUiTimer);
    recordingUiTimer = null;
    recordAudioButton.textContent = "Record Audio";
    recordAudioButton.classList.remove("recording");
    setControlsEnabled(audioReady);
    const chunks = recordingChunks;
    const bytes = recordingBytes;
    const sampleRate = recordingSampleRate || 48000;
    recordingChunks = [];
    recordingBytes = 0;
    if (!bytes) {
      audioFileStatus.textContent = "Recording stopped · no RX audio received";
      showToast("Recording contains no RX audio", true);
      return null;
    }
    const blob = new Blob([wavHeader(bytes, sampleRate), ...chunks], { type: "audio/wav" });
    audioFileStatus.textContent = `Recording ready · ${(bytes / 2 / sampleRate).toFixed(1)} s · ${(blob.size / 1024 / 1024).toFixed(1)} MiB`;
    return { blob, filename: recordingFilename() };
  };

  const saveRecording = async (recording) => {
    if (!recording) return;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: recording.filename,
          types: [{ description: "WAV audio", accept: { "audio/wav": [".wav"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(recording.blob);
        await writable.close();
        audioFileStatus.textContent = `Saved ${recording.filename}`;
        showToast("RX recording saved");
        return;
      } catch (error) {
        if (error?.name === "AbortError") {
          audioFileStatus.textContent = "Recording save cancelled";
          return;
        }
        // Fall through to the download fallback on browsers without a usable
        // File System Access implementation.
      }
    }
    const url = URL.createObjectURL(recording.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = recording.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    audioFileStatus.textContent = `Saved ${recording.filename}`;
    showToast("RX recording saved");
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));

  const waitForPttState = async (enabled, timeoutMs = 4500) => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("Audio connection is not ready");
      if (!pttPending && pttActive === Boolean(enabled)) return;
      if (enabled && !pttPending && !pttActive && performance.now() - startedAt > 150) throw new Error("PTT was not armed");
      await sleep(20);
    }
    throw new Error(enabled ? "Timed out waiting for PTT ON" : "Timed out waiting for PTT OFF");
  };

  const decodeAudioFile = async (file) => {
    if (!context) throw new Error("Enable audio first");
    const encoded = await file.arrayBuffer();
    const decoded = await context.decodeAudioData(encoded.slice(0));
    if (!decoded.length || !decoded.numberOfChannels) throw new Error("Audio file is empty");

    const sourceLength = decoded.length;
    const channels = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) channels.push(decoded.getChannelData(channel));
    const sourceRate = decoded.sampleRate || transmitPcmSampleRate || 48000;
    const targetRate = transmitPcmSampleRate || 48000;
    const outputLength = Math.max(1, Math.round(sourceLength * targetRate / sourceRate));
    const output = new Int16Array(outputLength);

    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * sourceRate / targetRate;
      const firstIndex = Math.min(sourceLength - 1, Math.floor(sourcePosition));
      const secondIndex = Math.min(sourceLength - 1, firstIndex + 1);
      const fraction = sourcePosition - firstIndex;
      let first = 0;
      let second = 0;
      for (const channel of channels) {
        first += channel[firstIndex];
        second += channel[secondIndex];
      }
      first /= channels.length;
      second /= channels.length;
      const sample = Math.max(-1, Math.min(1, first + (second - first) * fraction));
      output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    }
    return { pcm: output, sampleRate: targetRate, duration: output.length / targetRate };
  };

  const stopFilePlayback = () => {
    if (!filePlaybackActive) return;
    filePlaybackAbort = true;
    playAudioButton.textContent = "Stopping…";
    if (pttActive && !pttPending) requestPtt(false);
  };

  const transmitAudioFile = async (file) => {
    if (!audioReady || filePlaybackActive || recordingActive) return;
    const sequence = ++filePlaybackSequence;
    filePlaybackActive = true;
    filePlaybackAbort = false;
    playAudioButton.textContent = "Stop Audio";
    playAudioButton.classList.add("playing");
    updateCaptureState();
    setControlsEnabled(audioReady);
    audioFileStatus.textContent = `Loading ${file.name}…`;

    try {
      const decoded = await decodeAudioFile(file);
      if (filePlaybackAbort || sequence !== filePlaybackSequence) return;
      audioFileStatus.textContent = `TX file ready · ${formatAudioDuration(decoded.duration)} · ${decoded.sampleRate} Hz mono`;

      if (!requestPtt(true) && !pttActive) throw new Error("Unable to request PTT");
      await waitForPttState(true);
      if (filePlaybackAbort || sequence !== filePlaybackSequence) return;

      const frameSamples = Math.max(1, Math.round(decoded.sampleRate * txPacketMs / 1000));
      const startedAt = performance.now();
      let lastUiUpdate = 0;
      for (let offset = 0; offset < decoded.pcm.length; offset += frameSamples) {
        if (filePlaybackAbort || sequence !== filePlaybackSequence) break;
        if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN || !pttActive) {
          throw new Error("TX stopped before audio file completed");
        }
        const targetAt = startedAt + offset * 1000 / decoded.sampleRate;
        const waitMs = targetAt - performance.now();
        if (waitMs > 1) await sleep(waitMs);
        while (socket.bufferedAmount > maxWebSocketBacklogBytes) {
          if (filePlaybackAbort || !pttActive) break;
          await sleep(5);
        }
        if (filePlaybackAbort || !pttActive) break;
        const end = Math.min(decoded.pcm.length, offset + frameSamples);
        socket.send(decoded.pcm.subarray(offset, end));
        const elapsed = offset / decoded.sampleRate;
        if (performance.now() - lastUiUpdate > 250) {
          audioFileStatus.textContent = `Transmitting ${file.name} · ${formatAudioDuration(elapsed)} / ${formatAudioDuration(decoded.duration)}`;
          lastUiUpdate = performance.now();
        }
      }

      if (!filePlaybackAbort) {
        const finishAt = startedAt + decoded.duration * 1000 + 120;
        await sleep(Math.max(0, finishAt - performance.now()));
        audioFileStatus.textContent = `Transmission complete · ${file.name}`;
      } else {
        audioFileStatus.textContent = `Transmission stopped · ${file.name}`;
      }
    } catch (error) {
      if (!filePlaybackAbort) {
        audioFileStatus.textContent = `TX file error · ${error?.message || String(error)}`;
        showToast(error?.message || "Audio file transmission failed", true);
      }
    } finally {
      const pendingDeadline = performance.now() + 800;
      while (pttPending && performance.now() < pendingDeadline) await sleep(20);
      if (pttPending) {
        // WebSocket frames are ordered: queue an explicit OFF even if the ON
        // acknowledgement is late, then clear the local state immediately.
        releasePtt();
      } else if (pttActive) {
        requestPtt(false);
        try { await waitForPttState(false, 3000); } catch (_) { releasePtt(); }
      }
      filePlaybackActive = false;
      filePlaybackAbort = false;
      playAudioButton.textContent = "Play Audio";
      playAudioButton.classList.remove("playing");
      playAudioFile.value = "";
      updateCaptureState();
      setControlsEnabled(audioReady);
    }
  };

  const sendControl = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const sendBinary = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(payload);
    return true;
  };

  const resolveAudioControlWaiters = (message) => {
    for (let index = audioControlWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = audioControlWaiters[index];
      if (message.type !== waiter.type || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      audioControlWaiters.splice(index, 1);
      waiter.resolve(message);
    }
  };

  const rejectAudioControlWaiters = (reason) => {
    while (audioControlWaiters.length) {
      const waiter = audioControlWaiters.pop();
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason || "Audio connection closed"));
    }
  };

  const waitForAudioControl = (type, predicate = () => true, timeoutMs = 3000) => (
    new Promise((resolve, reject) => {
      const waiter = {
        type,
        predicate,
        resolve,
        reject,
        timer: window.setTimeout(() => {
          const index = audioControlWaiters.indexOf(waiter);
          if (index >= 0) audioControlWaiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, Math.max(1, timeoutMs)),
      };
      audioControlWaiters.push(waiter);
    })
  );

  const nextDigitalWaveformId = () => {
    const id = ((Date.now() & 0xfffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    return id || 1;
  };

  const stageDigitalPcm = async (pcm, options = {}) => {
    if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("Enable audio first");
    if (filePlaybackActive || pttActive || pttPending) throw new Error("Stop the current audio TX before staged digital TX");
    if (!digitalStagedTx) throw new Error("ESP32 firmware does not advertise staged digital TX");
    if (!(pcm instanceof Int16Array) || pcm.length === 0) throw new Error("No PCM audio to stage");
    const sampleRate = transmitPcmSampleRate || 48000;
    const id = nextDigitalWaveformId();
    const label = String(options.label || "SSTV").slice(0, 48);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const beginWait = waitForAudioControl("digital_waveform_begin", (message) => Number(message.id) === id || message.ok === false, 5000);
    sendControl({ type: "digital_waveform_begin", id, bytes: bytes.byteLength, sample_rate: sampleRate, label });
    const begin = await beginWait;
    if (begin.ok === false) throw new Error(begin.error || "Staged digital upload rejected");
    if (options.shouldAbort?.()) {
      sendControl({ type: "digital_waveform_clear" });
      throw new Error("Staged digital upload stopped");
    }

    const uploadTimeoutMs = Math.max(20000, Math.min(90000, 10000 + Math.ceil(bytes.byteLength / 160000) * 1000));
    const readyWait = waitForAudioControl("digital_waveform_ready", (message) => Number(message.id) === id, uploadTimeoutMs);
    const errorWait = waitForAudioControl("digital_waveform_error", () => true, uploadTimeoutMs).then(
      (message) => Promise.reject(new Error(message.error || "Staged digital upload failed")),
      () => new Promise(() => {})
    );
    const consumeUploadWaits = () => {
      readyWait.catch(() => {});
      errorWait.catch(() => {});
    };
    const chunkBytes = 16000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      if (options.shouldAbort?.()) {
        consumeUploadWaits();
        sendControl({ type: "digital_waveform_clear" });
        throw new Error("Staged digital upload stopped");
      }
      if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) {
        consumeUploadWaits();
        throw new Error("Audio connection closed during waveform upload");
      }
      while (socket.bufferedAmount > 65536) {
        if (options.shouldAbort?.()) {
          consumeUploadWaits();
          sendControl({ type: "digital_waveform_clear" });
          throw new Error("Staged digital upload stopped");
        }
        if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) {
          consumeUploadWaits();
          throw new Error("Audio connection closed during waveform upload");
        }
        await sleep(2);
      }
      const end = Math.min(offset + chunkBytes, bytes.byteLength);
      sendBinary(bytes.subarray(offset, end));
      options.onProgress?.({ id, sentBytes: end, totalBytes: bytes.byteLength });
    }
    const ready = await Promise.race([readyWait, errorWait]);
    if (Number(ready?.bytes) !== bytes.byteLength) throw new Error("ESP32 staged waveform ACK mismatch");
    return { id, bytes: bytes.byteLength, sampleRate };
  };

  const playStagedDigitalPcm = async (staged, sampleCount, options = {}) => {
    if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("Enable audio first");
    const sampleRate = transmitPcmSampleRate || 48000;
    const pttDelayMs = Math.max(0, Math.round(Number(options.pttDelayMs) || 350));
    const tailMs = Math.max(0, Math.round(Number(options.tailMs) || 300));
    const durationMs = Math.ceil(sampleCount * 1000 / sampleRate);
    const leaseMs = durationMs + pttDelayMs + tailMs + 4000;
    const playWait = waitForAudioControl("digital_tx_play", (message) => Number(message.id) === Number(staged.id), 3000);
    sendControl({
      type: "digital_tx_play",
      id: staged.id,
      label: String(options.label || "SSTV").slice(0, 48),
      ptt_delay_ms: pttDelayMs,
      tail_ms: tailMs,
      lease_ms: leaseMs,
    });
    const play = await playWait;
    if (play.ok === false) throw new Error(play.error || "Staged digital TX rejected");
    const completeWait = waitForAudioControl("digital_tx_complete", (message) => Number(message.id) === Number(staged.id), leaseMs + 5000);
    const complete = await completeWait;
    if (complete.ok === false) throw new Error(complete.reason || "Staged digital TX failed");
    return complete;
  };

  const stopStagedDigitalTx = () => sendControl({ type: "digital_tx_stop" });

  const readFt8TuneStatus = async () => {
    const payload = await api("/api/v1/ft8/status");
    return payload?.ft8?.tune || {};
  };

  const assertDigitalAlcTuneLive = (options = {}) => {
    if (options.shouldAbort?.()) throw new Error("ALC tune stopped");
    if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Audio connection closed during ALC tune");
    }
  };

  const waitForDigitalAlcTuneActive = async (options = {}, timeoutMs = 4200) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      assertDigitalAlcTuneLive(options);
      const tune = await readFt8TuneStatus();
      if (tune?.active) return tune;
      if (tune && !tune.running && tune.last_reason) throw new Error(tune.last_reason);
      await sleep(120);
    }
    throw new Error("ESP32 did not enter bounded ALC tune state");
  };

  const collectDigitalAlcReadings = async (count, lastReadCount, options = {}, timeoutMs = 1300) => {
    const values = [];
    let seen = Number(lastReadCount) || 0;
    let lastTune = null;
    const deadline = performance.now() + timeoutMs;
    while (values.length < count && performance.now() < deadline) {
      assertDigitalAlcTuneLive(options);
      const tune = await readFt8TuneStatus();
      lastTune = tune;
      if (!tune.running) throw new Error(tune.last_reason || "ESP32 ended ALC tune");
      const reads = Number(tune.meter_reads) || 0;
      if (reads > seen) {
        values.push(Number(tune.alc_raw) || 0);
        seen = reads;
      }
      if (values.length < count) await sleep(90);
    }
    if (!values.length) throw new Error("No ALC meter readings from CAT RM4");
    return { values, readCount: seen, tune: lastTune };
  };

  const stopDigitalAlcTune = async () => {
    try { await api("/api/v1/ft8/tune/stop", { method: "POST" }); } catch (_) { /* already stopped */ }
  };

  const calibrateDigitalAlc = async (options = {}) => {
    if (!audioReady || !socket || socket.readyState !== WebSocket.OPEN) throw new Error("Enable audio first");
    if (filePlaybackActive || pttActive || pttPending) throw new Error("Stop the current audio TX before ALC tune");
    if (!ft8TuneAvailable) throw new Error("ESP32 firmware does not advertise bounded ALC tune");
    if (digitalAlcTuneActive) throw new Error("ALC tune is already running");

    const report = (text, details = {}) => options.onStatus?.(text, details);
    let keepaliveTimer = null;
    digitalAlcTuneActive = true;
    try {
      sendControl({ type: "digital_waveform_clear" });
      report("Calibrating SSTV ALC · 5 W 1500 Hz tone");
      await post("/api/v1/ft8/tune/start", {
        dbfs: -40,
        frequency_hz: 1500,
        metering: true,
      });
      keepaliveTimer = window.setInterval(() => {
        if (digitalAlcTuneActive && audioReady && socket?.readyState === WebSocket.OPEN) {
          sendControl({ type: "ft8_tune_keepalive" });
        }
      }, 400);
      sendControl({ type: "ft8_tune_keepalive" });

      const tune = await waitForDigitalAlcTuneActive(options);
      let sample = await collectDigitalAlcReadings(3, Number(tune.meter_reads) || 0, options, 1800);
      let readCount = sample.readCount;
      const sorted = [...sample.values].sort((a, b) => a - b);
      const baseline = sorted[Math.floor(sorted.length / 2)];
      const baselineHigh = Math.max(...sample.values);
      if (baselineHigh >= 12) {
        throw new Error(`ALC already ${baselineHigh} at -40 dBFS; reduce FT-710 USB DATA input level`);
      }
      const threshold = Math.max(3, baseline + 2);
      report(`Calibrating SSTV ALC · baseline ${baseline}, threshold ${threshold}`, { baseline, threshold });

      let onsetLevel = null;
      let onsetAlc = 0;
      let lastPo = Number(sample.tune?.po_raw) || 0;
      const levels = [-38, -35, -32, -29, -26, -23, -20, -17, -14, -12];
      for (const level of levels) {
        assertDigitalAlcTuneLive(options);
        await post("/api/v1/ft8/tune/level", { dbfs: level });
        report(`Calibrating SSTV ALC · tone ${level.toFixed(0)} dBFS`, { levelDbfs: level });
        await sleep(260);
        sample = await collectDigitalAlcReadings(2, readCount, options, 1100);
        readCount = sample.readCount;
        lastPo = Number(sample.tune?.po_raw) || lastPo;
        const high = Math.max(...sample.values);
        const hits = sample.values.filter((value) => value >= threshold).length;
        report(`Calibrating SSTV ALC · ALC ${sample.values.join("/")}`, {
          levelDbfs: level,
          alcValues: sample.values,
          threshold,
        });
        if (hits >= 2 || high >= baseline + 5) {
          onsetLevel = level;
          onsetAlc = high;
          break;
        }
      }

      const limited = onsetLevel == null;
      const operatingLevel = limited ? -18 : clampNumber(onsetLevel - 6, -40, -18);
      report(
        limited
          ? `No ALC onset by -12 dBFS · using ${operatingLevel.toFixed(1)} dBFS`
          : `ALC onset ${onsetLevel.toFixed(1)} dBFS · using ${operatingLevel.toFixed(1)} dBFS`,
        { levelDbfs: operatingLevel, onsetLevelDbfs: onsetLevel, onsetAlc, baseline, threshold, limited }
      );
      return {
        levelDbfs: operatingLevel,
        onsetLevelDbfs: onsetLevel,
        onsetAlc,
        baselineAlc: baseline,
        thresholdAlc: threshold,
        poRaw: lastPo,
        limited,
      };
    } finally {
      clearInterval(keepaliveTimer);
      await stopDigitalAlcTune();
      const deadline = performance.now() + 3500;
      while (performance.now() < deadline) {
        let tune = null;
        try { tune = await readFt8TuneStatus(); } catch (_) { break; }
        if (!tune?.running) break;
        await sleep(100);
      }
      digitalAlcTuneActive = false;
    }
  };

  window.FT710_AUDIO_BRIDGE = {
    isReady: () => Boolean(audioReady && socket && socket.readyState === WebSocket.OPEN),
    supportsStagedDigitalTx: () => Boolean(digitalStagedTx),
    supportsDigitalAlcTune: () => Boolean(ft8TuneAvailable),
    calibrateDigitalAlc,
    stopDigitalAlcTune,
    stageDigitalPcm,
    playStagedDigitalPcm,
    stopStagedDigitalTx,
  };

  window.FT710_FT8?.setControlSender(sendControl);

  const stopPttKeepalive = () => {
    clearInterval(pttKeepalive);
    pttKeepalive = null;
  };

  const stopConnectTimeout = () => {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  };

  const renderPtt = () => {
    pttButton.classList.toggle("transmitting", pttActive);
    pttButton.setAttribute("aria-pressed", pttActive ? "true" : "false");
    pttButton.textContent = pttActive
      ? "PTT ON · CLICK TO RETURN TO RX"
      : "PTT OFF · CLICK TO TRANSMIT";
  };

  const applyPttState = (enabled) => {
    pttActive = Boolean(enabled && audioReady);
    pttPending = false;
    if (pttActive) pttConfirmedAt = performance.now();
    updateCaptureState();
    stopPttKeepalive();
    if (pttActive) {
      pttKeepalive = setInterval(() => {
        if (!sendControl({ type: "ptt_keepalive" })) applyPttState(false);
      }, 500);
    }
    window.FT710_CW?.setVoicePtt(pttActive);
    setControlsEnabled(audioReady);
    renderPtt();
  };

  const requestPtt = (enabled) => {
    if (!audioReady || pttPending) return false;
    const requested = Boolean(enabled);
    if (requested === pttActive) return true;
    pttPending = true;
    setControlsEnabled(audioReady);
    pttButton.textContent = requested ? "PTT…" : "RX…";
    if (!sendControl({ type: "ptt", enabled: requested })) {
      pttPending = false;
      setControlsEnabled(audioReady);
      renderPtt();
      return false;
    }
    return true;
  };

  const releasePtt = () => {
    const mustNotifyRadio = pttActive || pttPending;
    stopPttKeepalive();
    pttActive = false;
    pttPending = false;
    captureNode?.port.postMessage({ type: "capture", enabled: false });
    window.FT710_CW?.setVoicePtt(false);
    if (mustNotifyRadio) sendControl({ type: "ptt", enabled: false });
    setControlsEnabled(audioReady);
    renderPtt();
  };

  const disconnectNodes = () => {
    for (const node of [
      microphoneSource, microphoneGainNode, microphoneLimiter, captureNode,
      silentGainNode, playbackNode, speakerGainNode, speakerLimiter,
    ]) {
      try { node?.disconnect(); } catch (_) { /* already disconnected */ }
    }
  };

  const cleanupGraph = async () => {
    filePlaybackAbort = true;
    filePlaybackSequence += 1;
    filePlaybackActive = false;
    playAudioButton.textContent = "Play Audio";
    playAudioButton.classList.remove("playing");
    playAudioFile.value = "";
    if (recordingActive) {
      recordingActive = false;
      clearInterval(recordingUiTimer);
      recordingUiTimer = null;
      recordingChunks = [];
      recordingBytes = 0;
      recordAudioButton.textContent = "Record Audio";
      recordAudioButton.classList.remove("recording");
      audioFileStatus.textContent = "Recording stopped because audio was disabled";
    }
    releasePtt();
    audioReady = false;
    digitalStagedTx = false;
    ft8TuneAvailable = false;
    digitalAlcTuneActive = false;
    rejectAudioControlWaiters("Audio disabled");
    setControlsEnabled(false);

    if (microphoneStream) {
      for (const track of microphoneStream.getTracks()) track.stop();
    }
    microphoneStream = null;
    disconnectNodes();
    microphoneSource = null;
    microphoneGainNode = null;
    microphoneLimiter = null;
    captureNode = null;
    silentGainNode = null;
    playbackNode = null;
    speakerGainNode = null;
    speakerLimiter = null;

    if (context) {
      try { await context.close(); } catch (_) { /* already closed */ }
    }
    context = null;
    pttActive = false;
    renderPtt();
  };

  const disableAudio = async (quiet = false) => {
    if (stopping) return;
    stopping = true;
    try {
      releasePtt();
      stopConnectTimeout();
      const oldSocket = socket;
      socket = null;
      digitalStagedTx = false;
      ft8TuneAvailable = false;
      digitalAlcTuneActive = false;
      rejectAudioControlWaiters("Audio disabled");
      if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close(1000, "Audio disabled by user");
      await cleanupGraph();
      toggle.textContent = "Enable audio";
      setAudioStatus("OFF");
      detail.textContent = "FT-710 USB Audio · 48 kHz RX/TX";
      if (!quiet) showToast("Audio disabled");
    } finally {
      starting = false;
      stopping = false;
      toggle.disabled = false;
    }
  };

  if (audioOwnerChannel) {
    audioOwnerChannel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== "claim" || message.owner === audioOwnerId) return;
      if (audioReady || starting) void disableAudio(true);
    };
  }

  const failAudio = async (message) => {
    if (failureInProgress) return;
    failureInProgress = true;
    try {
      stopConnectTimeout();
      const oldSocket = socket;
      socket = null;
      digitalStagedTx = false;
      ft8TuneAvailable = false;
      digitalAlcTuneActive = false;
      rejectAudioControlWaiters(message);
      if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
      await cleanupGraph();
      toggle.textContent = "Enable audio";
      toggle.disabled = false;
      setAudioStatus("ERROR", "error");
      detail.textContent = message;
      showToast(message, true);
      starting = false;
      stopping = false;
    } finally {
      window.setTimeout(() => { failureInProgress = false; }, 250);
    }
  };

  const configureMicrophoneLimiter = (node) => {
    node.threshold.value = -3;
    node.knee.value = 0;
    node.ratio.value = 20;
    node.attack.value = 0.002;
    node.release.value = 0.08;
  };

  const configureSpeakerLimiter = (node) => {
    // Quiet receive audio is left untouched. Only peaks created by a high
    // user-selected boost are clamped.
    node.threshold.value = -1;
    node.knee.value = 0;
    node.ratio.value = 20;
    node.attack.value = 0.001;
    node.release.value = 0.05;
  };

  const createAudioGraph = async () => {
    if (!window.AudioContext && !window.webkitAudioContext) {
      throw new Error("This browser does not support the Web Audio API");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Browser microphone access is unavailable; open the site over HTTPS");
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    try {
      context = new AudioContextClass({ latencyHint: "interactive", sampleRate: 48000 });
    } catch (_) {
      context = new AudioContextClass({ latencyHint: "interactive" });
    }

    const workletBlob = new Blob([FT710_AUDIO_WORKLET_SOURCE], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(workletBlob);
    try {
      await context.audioWorklet.addModule(workletUrl);
    } catch (error) {
      throw new Error(`Unable to initialize browser audio processor: ${error?.message || String(error)}`);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    await context.resume();

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    microphoneSource = context.createMediaStreamSource(microphoneStream);
    microphoneGainNode = context.createGain();
    microphoneGainNode.gain.value = Number(txMicGain.value) / 100;
    microphoneLimiter = context.createDynamicsCompressor();
    configureMicrophoneLimiter(microphoneLimiter);
    captureNode = new AudioWorkletNode(context, "ft710-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { frameMs: txPacketMs },
    });
    silentGainNode = context.createGain();
    silentGainNode.gain.value = 0;
    microphoneSource
      .connect(microphoneGainNode)
      .connect(microphoneLimiter)
      .connect(captureNode)
      .connect(silentGainNode)
      .connect(context.destination);

    playbackNode = new AudioWorkletNode(context, "ft710-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      processorOptions: {
        targetBufferMs: 300,
        startBufferMs: 280,
        maximumBufferMs: 1000,
      },
    });
    speakerGainNode = context.createGain();
    speakerGainNode.gain.value = Number(rxVolume.value) / 100;
    speakerLimiter = context.createDynamicsCompressor();
    configureSpeakerLimiter(speakerLimiter);
    playbackNode.connect(speakerGainNode).connect(speakerLimiter).connect(context.destination);
    playbackNode.port.onmessage = (event) => {
      const stats = event.data;
      if (!stats || stats.type !== "rx-stats" || !audioReady) return;
      detail.textContent = `Secure WSS audio · RX buffer ${stats.bufferedMs} ms · underruns ${stats.underruns} · TX ${txPacketMs} ms`;
    };

    captureNode.port.onmessage = (event) => {
      if (!audioReady || !pttActive || filePlaybackActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      if (socket.bufferedAmount > maxWebSocketBacklogBytes) return;
      socket.send(event.data);
    };
  };

  const enableAudio = async () => {
    if (starting || audioReady) return;
    audioOwnerChannel?.postMessage({ type: "claim", owner: audioOwnerId, source: "main radio" });
    starting = true;
    toggle.disabled = true;
    setAudioStatus("CONNECTING", "connecting");
    detail.textContent = "Requesting browser microphone permission…";

    try {
      await createAudioGraph();
      const url = websocketUrl(`/api/v1/audio/ws`);
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      stopConnectTimeout();
      connectTimeout = window.setTimeout(() => {
        if (!audioReady && starting) void failAudio("Audio WebSocket initialization timed out");
      }, 6000);

      socket.onopen = () => {
        detail.textContent = "WebSocket connected · starting FT-710 RX/TX audio…";
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message;
          try { message = JSON.parse(event.data); }
          catch (_) { return; }
          resolveAudioControlWaiters(message);
          if (message.type === "ready") {
            stopConnectTimeout();
            audioReady = true;
            starting = false;
            toggle.disabled = false;
            toggle.textContent = "Disable audio";
            const serverRate = Number(message.sample_rate);
            receivePcmSampleRate = Number.isFinite(serverRate) && serverRate > 0 ? serverRate : 48000;
            const txServerRate = Number(message.tx_sample_rate);
            transmitPcmSampleRate = Number.isFinite(txServerRate) && txServerRate > 0 ? txServerRate : 48000;
            digitalStagedTx = Boolean(message.digital_staged_tx);
            ft8TuneAvailable = Boolean(message.ft8_tune);
            setControlsEnabled(true);
            setAudioStatus("LIVE", "live");
            applyPttState(false);
            audioFileStatus.textContent = "RX recorder idle · TX file player idle";
            detail.textContent = `FreeRig710 WebSocket audio · RX ${receivePcmSampleRate} Hz · TX ${transmitPcmSampleRate} Hz · latching PTT · watchdog ${message.ptt_watchdog_ms || 1500} ms`;
            showToast("Audio enabled");
          } else if (message.type === "ptt") {
            applyPttState(Boolean(message.enabled));
            if (message.error) showToast(message.error, true);
          } else if (message.type === "error") {
            void failAudio(message.message || "Audio connection failed");
          } else if (message.type === "warning") {
            showToast(message.message || "Audio warning", true);
          } else if (message.type === "timing_probe") {
            window.FT710_FT8?.handleControl(message);
          }
          return;
        }
        if (event.data instanceof ArrayBuffer && playbackNode) {
          if (recordingActive) {
            const chunk = event.data.slice(0);
            recordingChunks.push(chunk);
            recordingBytes += chunk.byteLength;
          }
          // The WebSocket payload is radio PCM at the ESP32-declared rate, not
          // necessarily the browser AudioContext rate. DSP must use this clock.
          const receiveSampleRate = receivePcmSampleRate;
          window.FT710_CW?.feedAudio(event.data, receiveSampleRate);
          window.FT710_SSTV?.feedAudio(event.data, receiveSampleRate);
          window.FT710_FT8?.feedAudio(event.data, receiveSampleRate);
          playbackNode.port.postMessage(event.data, [event.data]);
        }
      };

      socket.onerror = () => {
        if (!stopping) void failAudio("Audio WebSocket failed");
      };

      socket.onclose = (event) => {
        if (stopping) return;
        digitalStagedTx = false;
        ft8TuneAvailable = false;
        digitalAlcTuneActive = false;
        rejectAudioControlWaiters("Audio connection closed");
        socket = null;
        if (lastState?.radio_power === "OFF" || lastState?.radio_power === "STARTING") {
          void disableAudio(true);
          return;
        }
        if (audioReady || starting) {
          const suffix = event.reason ? `: ${event.reason}` : "";
          void failAudio(`Audio connection closed${suffix}`);
        }
      };
    } catch (error) {
      await failAudio(error.message || String(error));
    }
  };

  toggle.addEventListener("click", () => {
    if (audioReady || starting) void disableAudio();
    else void enableAudio();
  });

  recordAudioButton.addEventListener("click", () => {
    if (!audioReady) {
      showToast("Enable audio first", true);
      return;
    }
    if (!recordingActive) {
      startRecording();
      return;
    }
    const recording = finishRecording();
    void saveRecording(recording);
  });

  playAudioButton.addEventListener("click", () => {
    if (!audioReady) {
      showToast("Enable audio first", true);
      return;
    }
    if (filePlaybackActive) {
      stopFilePlayback();
      return;
    }
    playAudioFile.click();
  });

  playAudioFile.addEventListener("change", () => {
    const file = playAudioFile.files?.[0];
    if (!file) return;
    void transmitAudioFile(file);
  });

  rxVolume.addEventListener("input", () => {
    rxVolumeValue.textContent = `${rxVolume.value}%`;
    try { localStorage.setItem("ft710-rx-volume-v2", rxVolume.value); } catch (_) { /* optional */ }
    if (speakerGainNode && context) {
      speakerGainNode.gain.setTargetAtTime(Number(rxVolume.value) / 100, context.currentTime, 0.01);
    }
  });

  txMicGain.addEventListener("input", () => {
    txMicGainValue.textContent = `${txMicGain.value}%`;
    try { localStorage.setItem("ft710-tx-mic-gain-v2", txMicGain.value); } catch (_) { /* optional */ }
    if (microphoneGainNode && context) {
      microphoneGainNode.gain.setTargetAtTime(Number(txMicGain.value) / 100, context.currentTime, 0.01);
    }
  });

  pttButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (!audioReady || filePlaybackActive) return;
    requestPtt(!pttActive);
  });

  window.addEventListener("ft710-radio-state", (event) => {
    const state = event.detail;
    if (!audioReady || pttPending || !pttActive) return;
    // The CAT state is authoritative. Ignore a possibly stale poll that was
    // already in flight at the instant the PTT ACK arrived.
    if (performance.now() - pttConfirmedAt < 1000) return;
    if (state?.ptt_active === false) {
      applyPttState(false);
      showToast("PTT released by radio/watchdog", true);
    }
  });

  window.addEventListener("pagehide", () => {
    stopConnectTimeout();
    releasePtt();
    rejectAudioControlWaiters("Page closed");
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "Page closed");
    audioOwnerChannel?.close();
  });

  setControlsEnabled(false);
  setAudioStatus("OFF");
  renderPtt();
}

initPanelOrdering();
initCollapsiblePanels();
initLocalUiPreferences();
initStationSettings();
initBackendConfig();
initStationControls();
bindControls();
connectEvents();
initClickTuning();
initVideo();
initMemories();
void initQrzLog();
window.FT710_CW?.init();
window.FT710_SSTV?.init();
window.FT710_FT8?.init();
initRadioAudioLevels();
initAudio();
