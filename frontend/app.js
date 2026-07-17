"use strict";

const API_BASE = (window.FT710_CONFIG?.apiBase || "/ft710-api").replace(/\/$/, "");
const byId = (id) => document.getElementById(id);
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
let ft8State = { running: false, url: "/ft8/", last_error: null };
const stationBusy = { radio: false, ft8: false };
let ft8StatusTimer = null;
let clickTuneSending = false;
let clickTuneHover = null;
let rfSqlModeSwitching = false;
let vfoSplitSwitching = false;

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
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* empty body */ }
  if (!response.ok) throw new Error(payload?.detail || `HTTP ${response.status}`);
  return payload;
}

async function post(path, payload, options = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload), ...options });
}

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
    byId("connection-text").textContent = connected ? "CAT-2 connected" : (error || "Radio unavailable");
  }
}

function renderStationControls() {
  const power = lastState?.radio_power || null;
  const radioButton = byId("radio-power-button");
  const ft8Button = byId("ft8-power-button");
  const ft8Link = byId("ft8-open-button");
  const radioOn = power === "ON";
  const radioOff = power === "OFF";

  radioButton.classList.toggle("power-on-action", radioOff);
  radioButton.classList.toggle("power-off-action", radioOn);
  radioButton.textContent = stationBusy.radio
    ? (radioOn ? "STOPPING…" : "STARTING…")
    : (radioOn ? "OFF" : (radioOff ? "ON" : (power === "STARTING" ? "STARTING…" : "POWER…")));
  radioButton.disabled = stationBusy.radio || stationBusy.ft8 || (!radioOn && !radioOff);

  ft8Button.textContent = stationBusy.ft8
    ? (ft8State.running ? "FT8 STOPPING…" : "FT8 STARTING…")
    : (ft8State.running ? "FT8 OFF" : "FT8 ON");
  ft8Button.classList.toggle("ft8-running", Boolean(ft8State.running));
  ft8Button.disabled = stationBusy.radio || stationBusy.ft8 || !radioOn;

  const linkEnabled = radioOn && ft8State.running && !stationBusy.ft8;
  ft8Link.href = ft8State.url || "/ft8/";
  ft8Link.classList.toggle("disabled", !linkEnabled);
  ft8Link.classList.toggle("ready", linkEnabled);
  ft8Link.setAttribute("aria-disabled", String(!linkEnabled));
  ft8Link.tabIndex = linkEnabled ? 0 : -1;

  const powerStatus = byId("status-radio-power");
  if (powerStatus) powerStatus.textContent = power || "--";
  const ft8Status = byId("status-ft8");
  if (ft8Status) ft8Status.textContent = ft8State.running ? "RUNNING" : "OFF";
}

function applyFt8State(value) {
  if (!value) return;
  ft8State = { ...ft8State, ...value, running: Boolean(value.running) };
  window.FT710_CW?.setFt8Running(ft8State.running);
  renderStationControls();
}

async function refreshFt8Status() {
  try {
    const result = await api("/api/v1/ft8/status");
    applyFt8State(result.ft8);
  } catch (error) {
    ft8State.last_error = error.message;
    renderStationControls();
  }
}

function initStationControls() {
  const radioButton = byId("radio-power-button");
  const ft8Button = byId("ft8-power-button");
  const ft8Link = byId("ft8-open-button");

  ft8Link.addEventListener("click", (event) => {
    if (ft8Link.getAttribute("aria-disabled") === "true") event.preventDefault();
  });

  radioButton.addEventListener("click", async () => {
    const power = lastState?.radio_power;
    if (power !== "ON" && power !== "OFF") return;
    stationBusy.radio = true;
    renderStationControls();
    try {
      const result = await post("/api/v1/radio/power", { enabled: power === "OFF" });
      if (result?.state) updateState(result.state);
      if (result?.ft8) applyFt8State(result.ft8);
      if (power === "OFF" && !result?.confirmed) {
        showToast("Power-on command sent; waiting for the radio to finish starting");
      } else {
        showToast(power === "OFF" ? "Radio powered on" : "Radio powered off");
      }
    } catch (error) {
      showToast(error.message, true);
    } finally {
      stationBusy.radio = false;
      renderStationControls();
      void refreshFt8Status();
    }
  });

  ft8Button.addEventListener("click", async () => {
    if (lastState?.radio_power !== "ON") return;
    stationBusy.ft8 = true;
    renderStationControls();
    const enable = !ft8State.running;
    try {
      const result = await post("/api/v1/ft8", { enabled: enable });
      applyFt8State(result.ft8);
      showToast(enable ? "FT8 / WSJT-X started" : "FT8 / WSJT-X stopped");
    } catch (error) {
      showToast(error.message, true);
      await refreshFt8Status();
    } finally {
      stationBusy.ft8 = false;
      renderStationControls();
    }
  });

  renderStationControls();
  void refreshFt8Status();
  ft8StatusTimer = window.setInterval(refreshFt8Status, 2000);
  window.addEventListener("pagehide", () => {
    if (ft8StatusTimer) window.clearInterval(ft8StatusTimer);
  });
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
  byId("cat2-device").textContent = state.cat2_device || "--";
  byId("radio-id").textContent = state.radio_id || "--";

  if (!jogDragging) {
    const speed = Number(state.jog_speed_hz_s || 0);
    byId("jog-speed").textContent = formatJogSpeed(speed);
  }
  renderStationControls();
  refreshClickTuneOverlay();
}

function updateState(state) {
  lastState = state;
  renderState(state);
  window.FT710_CW?.updateRadioState(state);
}

function connectEvents() {
  const source = new EventSource(`${API_BASE}/api/v1/events`);
  source.addEventListener("state", (event) => {
    try { updateState(JSON.parse(event.data)); }
    catch (error) { console.error("Invalid state event", error); }
  });
  source.onerror = () => setConnected(false, "Reconnecting to API…", lastState?.radio_power);
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
  const status = byId("video-status");
  const toggle = byId("video-toggle");
  const fpsInput = byId("video-fps");
  const qualityInput = byId("video-quality");
  let manuallyPaused = false;
  let retryTimer = null;
  let settingsTimer = null;
  let connectionGeneration = 0;
  let streamLive = false;
  let settingsSaving = false;
  let queuedSettings = null;
  let inFlightSettings = null;
  let currentSettings = {
    fps: Number(fpsInput.value),
    jpeg_quality: Number(qualityInput.value),
  };

  const settingsSummary = () => `${currentSettings.fps} FPS · Q${currentSettings.jpeg_quality}`;
  const sameVideoSettings = (left, right) => Boolean(
    left && right &&
    Number(left.fps) === Number(right.fps) &&
    Number(left.jpeg_quality) === Number(right.jpeg_quality)
  );

  const refreshStatus = (override = null) => {
    if (override) {
      status.textContent = override;
    } else if (manuallyPaused) {
      status.textContent = `PAUSED · ${settingsSummary()}`;
    } else if (document.hidden) {
      status.textContent = `PAUSED · HIDDEN · ${settingsSummary()}`;
    } else if (streamLive) {
      status.textContent = `LIVE · ${settingsSummary()}`;
    } else {
      status.textContent = `CONNECTING · ${settingsSummary()}`;
    }
  };

  const applyVideoSettings = (settings) => {
    if (!settings) return;
    const fps = Number(settings.fps);
    const jpegQuality = Number(settings.jpeg_quality);
    if (Number.isFinite(fps)) {
      currentSettings.fps = fps;
      if (document.activeElement !== fpsInput) fpsInput.value = String(fps);
    }
    if (Number.isFinite(jpegQuality)) {
      currentSettings.jpeg_quality = jpegQuality;
      if (document.activeElement !== qualityInput) qualityInput.value = String(jpegQuality);
    }
    refreshStatus();
  };

  const readVideoSettings = () => {
    if (!fpsInput.validity.valid || !qualityInput.validity.valid) return null;
    const fps = Number(fpsInput.value);
    const jpegQuality = Number(qualityInput.value);
    if (!Number.isInteger(fps) || fps < 1 || fps > 30) return null;
    if (!Number.isInteger(jpegQuality) || jpegQuality < 20 || jpegQuality > 95) return null;
    return { fps, jpeg_quality: jpegQuality };
  };

  const flushVideoSettings = async () => {
    if (settingsSaving || !queuedSettings) return;
    const requested = queuedSettings;
    queuedSettings = null;
    settingsSaving = true;
    inFlightSettings = requested;
    fpsInput.disabled = true;
    qualityInput.disabled = true;
    refreshStatus(`APPLYING · ${requested.fps} FPS · Q${requested.jpeg_quality}`);
    try {
      const result = await post("/api/v1/video/settings", requested);
      applyVideoSettings(result.settings);
    } catch (error) {
      showToast(error.message, true);
      try {
        const result = await api("/api/v1/video/settings");
        applyVideoSettings(result.settings);
      } catch (_) {
        refreshStatus("VIDEO SETTINGS UNAVAILABLE");
      }
    } finally {
      settingsSaving = false;
      inFlightSettings = null;
      fpsInput.disabled = false;
      qualityInput.disabled = false;
      if (queuedSettings) void flushVideoSettings();
      else refreshStatus();
    }
  };

  const queueVideoSettings = (delay = 400) => {
    const values = readVideoSettings();
    if (!values) return;
    if (sameVideoSettings(values, currentSettings) && !settingsSaving) return;
    if (sameVideoSettings(values, inFlightSettings)) return;
    queuedSettings = values;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      void flushVideoSettings();
    }, delay);
  };

  const commitVideoSettings = () => {
    queueVideoSettings(0);
    clearTimeout(settingsTimer);
    settingsTimer = null;
    void flushVideoSettings();
  };

  for (const input of [fpsInput, qualityInput]) {
    input.addEventListener("input", () => queueVideoSettings(450));
    input.addEventListener("change", commitVideoSettings);
    input.addEventListener("blur", commitVideoSettings);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commitVideoSettings();
      input.blur();
    });
  }

  const stop = () => {
    connectionGeneration += 1;
    clearTimeout(retryTimer);
    retryTimer = null;
    streamLive = false;
    image.removeAttribute("src");
    refreshStatus();
  };

  const load = () => {
    if (manuallyPaused || document.hidden) return;
    const generation = ++connectionGeneration;
    clearTimeout(retryTimer);
    streamLive = false;
    refreshStatus();
    image.src = `${API_BASE}/video.mjpeg?ts=${Date.now()}`;

    image.onload = () => {
      if (generation !== connectionGeneration) return;
      streamLive = true;
      refreshStatus();
    };
    image.onerror = () => {
      if (generation !== connectionGeneration || manuallyPaused || document.hidden) return;
      streamLive = false;
      refreshStatus("VIDEO UNAVAILABLE");
      retryTimer = setTimeout(load, 2000);
    };
  };

  toggle.addEventListener("click", () => {
    manuallyPaused = !manuallyPaused;
    toggle.textContent = manuallyPaused ? "Resume" : "Pause";
    if (manuallyPaused) stop();
    else load();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (!manuallyPaused) load();
  });

  window.addEventListener("pagehide", stop);

  api("/api/v1/video/settings")
    .then((result) => applyVideoSettings(result.settings))
    .catch((error) => showToast(`Video settings: ${error.message}`, true));
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
    fetch(`${API_BASE}/api/v1/radio/jog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      showToast("CAT-2 command sent");
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

function initAudio() {
  const toggle = byId("audio-toggle");
  const status = byId("audio-status");
  const detail = byId("audio-detail");
  const pttButton = byId("ptt-button");
  const rxVolume = byId("rx-volume");
  const rxVolumeValue = byId("rx-volume-value");
  const txMicGain = byId("tx-mic-gain");
  const txMicGainValue = byId("tx-mic-gain-value");

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
  let starting = false;
  let stopping = false;
  let pttActive = false;
  let pttKeepalive = null;
  let failureInProgress = false;
  const txPacketMs = 20;
  const maxWebSocketBacklogBytes = 128 * 1024;

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
    pttButton.disabled = !enabled;
    rxVolume.disabled = !enabled;
    txMicGain.disabled = !enabled;
    window.FT710_CW?.setAudioReady(enabled);
    window.FT710_SSTV?.setAudioReady(enabled);
  };

  const sendControl = (payload) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  const stopPttKeepalive = () => {
    clearInterval(pttKeepalive);
    pttKeepalive = null;
  };

  const renderPtt = () => {
    pttButton.classList.toggle("transmitting", pttActive);
    pttButton.setAttribute("aria-pressed", pttActive ? "true" : "false");
    pttButton.textContent = pttActive
      ? "PTT ON · CLICK TO RETURN TO RX"
      : "PTT OFF · CLICK TO TRANSMIT";
  };

  const setPtt = (enabled, send = true) => {
    const next = Boolean(enabled && audioReady);
    if (pttActive === next) return;
    pttActive = next;
    captureNode?.port.postMessage({ type: "capture", enabled: pttActive });
    stopPttKeepalive();
    if (send) sendControl({ type: "ptt", enabled: pttActive });
    if (pttActive) {
      pttKeepalive = setInterval(() => sendControl({ type: "ptt_keepalive" }), 500);
    }
    window.FT710_CW?.setVoicePtt(pttActive);
    renderPtt();
  };

  const releasePtt = () => setPtt(false, true);

  const disconnectNodes = () => {
    for (const node of [
      microphoneSource, microphoneGainNode, microphoneLimiter, captureNode,
      silentGainNode, playbackNode, speakerGainNode, speakerLimiter,
    ]) {
      try { node?.disconnect(); } catch (_) { /* already disconnected */ }
    }
  };

  const cleanupGraph = async () => {
    releasePtt();
    audioReady = false;
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
      const oldSocket = socket;
      socket = null;
      if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) oldSocket.close(1000, "Audio disabled by user");
      await cleanupGraph();
      toggle.textContent = "Enable audio";
      setAudioStatus("OFF");
      detail.textContent = "Source: ft710_in_44100 · Sink: ft710_out_44100";
      if (!quiet) showToast("Audio disabled");
    } finally {
      starting = false;
      stopping = false;
      toggle.disabled = false;
    }
  };

  const failAudio = async (message) => {
    if (failureInProgress) return;
    failureInProgress = true;
    try {
      const oldSocket = socket;
      socket = null;
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
      context = new AudioContextClass({ latencyHint: "interactive", sampleRate: 44100 });
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
        sampleRate: { ideal: 44100 },
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
      if (!audioReady || !pttActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      if (socket.bufferedAmount > maxWebSocketBacklogBytes) return;
      socket.send(event.data);
    };
  };

  const enableAudio = async () => {
    if (starting || audioReady) return;
    starting = true;
    toggle.disabled = true;
    setAudioStatus("CONNECTING", "connecting");
    detail.textContent = "Requesting browser microphone permission…";

    try {
      await createAudioGraph();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}${API_BASE}/api/v1/audio/ws?sample_rate=${context.sampleRate}`;
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        detail.textContent = "Opening FT-710 audio source and sink…";
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message;
          try { message = JSON.parse(event.data); }
          catch (_) { return; }
          if (message.type === "ready") {
            audioReady = true;
            starting = false;
            toggle.disabled = false;
            toggle.textContent = "Disable audio";
            setControlsEnabled(true);
            setAudioStatus("LIVE", "live");
            renderPtt();
            detail.textContent = `Secure WSS audio · ${message.sample_rate} Hz · TX ${message.tx_packet_ms ?? txPacketMs} ms · Pulse buffer ${message.latency_ms ?? 100} ms`;
            showToast("Audio enabled");
          } else if (message.type === "error") {
            void failAudio(message.message || "Audio connection failed");
          } else if (message.type === "warning") {
            showToast(message.message || "Audio warning", true);
          }
          return;
        }
        if (event.data instanceof ArrayBuffer && playbackNode) {
          const receiveSampleRate = context?.sampleRate || 44100;
          window.FT710_CW?.feedAudio(event.data, receiveSampleRate);
          window.FT710_SSTV?.feedAudio(event.data, receiveSampleRate);
          playbackNode.port.postMessage(event.data, [event.data]);
        }
      };

      socket.onerror = () => {
        if (!stopping) void failAudio("Secure audio WebSocket failed");
      };

      socket.onclose = (event) => {
        if (stopping) return;
        socket = null;
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
    if (!audioReady) return;
    setPtt(!pttActive, true);
  });

  window.addEventListener("pagehide", () => {
    releasePtt();
    if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "Page closed");
  });

  setControlsEnabled(false);
  setAudioStatus("OFF");
  renderPtt();
}

initPanelOrdering();
initCollapsiblePanels();
initStationControls();
bindControls();
connectEvents();
initClickTuning();
initVideo();
initMemories();
window.FT710_CW?.init();
window.FT710_SSTV?.init();
initAudio();
api("/api/v1/state").then(updateState).catch((error) => setConnected(false, error.message));
