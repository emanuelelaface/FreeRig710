"use strict";

import { getSubmode, js8Init, synthesize, upsampleTo48 } from "./vendor/js8/js8.mjs";

const LOCAL_GUI_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const IS_LOCAL_GUI = LOCAL_GUI_HOSTS.has(window.location.hostname);
let savedBackend = "";
try {
  savedBackend = window.FreeRig710Settings?.get?.().backend || localStorage.getItem("freerig710-backend") || "";
} catch {
  savedBackend = "";
}
const EXPLICIT_BACKEND = normalizeBackend(window.FREERIG710_BACKEND || "");
const DEFAULT_LOCAL_BACKEND = normalizeBackend(window.FT710_CONFIG?.localDefaultBackend || "http://ft710.local");
const API_BASE = EXPLICIT_BACKEND || (IS_LOCAL_GUI ? normalizeBackend(savedBackend) || DEFAULT_LOCAL_BACKEND : "");
const AUDIO_OWNER_CHANNEL = "freerig710-audio-owner-v1";
const OWNER_ID = `js8-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const RX_RATE = 12000;
const RX_BUFFER_SECONDS = 60;
const DF_LOW = 200;
const DF_HIGH = 3000;
const TX_AUDIO_CENTER_HZ = 1500;
const SUBMODE_BITS = new Map([
  [0, 1],
  [1, 2],
  [2, 4],
  [4, 8],
  [8, 16],
]);
const RX_SUBMODES = [0, 1, 2, 4, 8];
const WATERFALL_ROWS = 116;
const WATERFALL_FFT_SIZE = 1024;

const JS8_BANDS = [
  { label: "160m", hz: 1842000 },
  { label: "80m", hz: 3578000 },
  { label: "40m", hz: 7078000 },
  { label: "30m", hz: 10130000 },
  { label: "20m", hz: 14078000 },
  { label: "17m", hz: 18104000 },
  { label: "15m", hz: 21078000 },
  { label: "12m", hz: 24922000 },
  { label: "10m", hz: 28078000 },
  { label: "6m", hz: 50318000 },
];

const elements = {};
const state = {
  apiBase: API_BASE,
  codec: null,
  codecReady: false,
  decoder: null,
  radio: null,
  decoding: false,
  audioReady: false,
  audioReadyMessage: false,
  audioStarting: false,
  configuring: false,
  rxEnabled: false,
  socket: null,
  rxRate: 48000,
  txRate: 48000,
  audioChannel: null,
  waiters: [],
  pttKeepalive: null,
  station: {
    call: "",
    grid: "",
  },
  txAudioHz: 1500,
  autoFreq: true,
  autoRfGain: true,
  rfGainSlopeDbPerStep: null,
  rfGainPending: null,
  rfGainSettleUntil: 0,
  rfGainDragging: false,
  rfGainControlBusy: false,
  rfGainManualPending: null,
  rfGainManualPendingUntil: 0,
  rfGainSendTimer: null,
  rfGainRequestSeq: 0,
  autoGainBusy: false,
  submode: 0,
  dialHz: NaN,
  activeBand: "",
  txBusy: false,
  txAbort: false,
  txQueue: [],
  configPending: false,
  txVfoApplyGeneration: 0,
  txVfoApplyPromise: null,
  txSlotIndex: -1,
  waterfallDragging: false,
  rxBuffer: new Float32Array(RX_RATE * RX_BUFFER_SECONDS),
  rxWritePos: 0,
  rxPhase: 0,
  rxAccum: 0,
  rxAccumCount: 0,
  rxRemainder: 0,
  levelHistory: [],
  lastSlots: new Map(),
  decodes: [],
  heard: new Map(),
  rxThreads: [],
  qrzReports: new Map(),
  chat: [],
  logLines: [],
  decodeCount: 0,
  lastLevelDb: null,
  qrzState: { configured: false, station_callsign: null },
  qrzLogging: false,
  digitalStagedTx: false,
  wfCanvas: null,
  wfCtx: null,
  wfImage: null,
  wfWindow: null,
  wfReal: null,
  wfImag: null,
  wfSpectrumDb: [],
  wfFloorDb: null,
  wfCeilDb: null,
  wfTemp: [],
  wfWriteAccumulator: [],
  lastDecodeMs: 0,
};

function normalizeBackend(value) {
  let raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function apiUrl(path) {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${state.apiBase}${clean}`;
}

function websocketUrl(path) {
  const url = new URL(apiUrl(path), state.apiBase || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function post(path, body = {}) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

window.FreeRig710API = { api, apiUrl, post };

function $(id) {
  return document.getElementById(id);
}

function cacheElements() {
  [
    "js8-radio-state",
    "js8-audio-state",
    "js8-codec-state",
    "js8-rx-state",
    "js8-clock-state",
    "js8-waterfall",
    "js8-waterfall-hitbox",
    "js8-tx-cursor",
    "js8-tx-cursor-label",
    "js8-tx-df-label",
    "js8-utc",
    "js8-submode-readout",
    "js8-next",
    "js8-decode-state",
    "js8-audio-level",
    "js8-timing-progress",
    "js8-band-buttons",
    "js8-band-select",
    "js8-rx-dial",
    "js8-tx-vfo-b",
    "js8-tx-rf",
    "js8-tx-audio",
    "js8-submode",
    "js8-enabled",
    "js8-auto-freq",
    "js8-auto-rf",
    "js8-rf-gain",
    "js8-rf-target",
    "js8-rf-gain-slider",
    "js8-rf-gain-slider-label",
    "js8-radio-config-state",
    "js8-heard-body",
    "js8-decode-count",
    "js8-clear-decodes",
    "js8-chat-log",
    "js8-my-call",
    "js8-my-grid",
    "js8-to-call",
    "js8-message",
    "js8-command-buttons",
    "js8-send",
    "js8-cq",
    "js8-heartbeat",
    "js8-halt",
    "js8-tx-state",
    "js8-last-tx",
    "js8-frame-count",
    "js8-qrz-status",
    "js8-qrz-station-call",
    "js8-qrz-tx-frequency",
    "js8-qrz-rx-frequency",
    "js8-qrz-band",
    "js8-qrz-mode",
    "js8-qrz-power",
    "js8-qrz-utc",
    "js8-qrz-form",
    "js8-qrz-call",
    "js8-qrz-grid",
    "js8-qrz-rst-sent",
    "js8-qrz-rst-rcvd",
    "js8-qrz-notes",
    "js8-qrz-submit",
    "js8-qrz-result",
    "js8-log",
  ].forEach((id) => {
    elements[id] = $(id);
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeCall(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9/@-]/g, "")
    .slice(0, 16);
}

function sanitizeGrid(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-R0-9]/g, "")
    .slice(0, 8);
}

function sharedStationSettings() {
  return window.FreeRig710Settings?.get?.() || { call: "", grid: "", backend: "" };
}

function applySharedStationSettings() {
  const settings = sharedStationSettings();
  let call = sanitizeCall(settings.call || "");
  let grid = sanitizeGrid(settings.grid || "");
  if (!call) {
    try { call = sanitizeCall(localStorage.getItem("freerig710-js8-my-call") || ""); } catch (_) {}
  }
  if (!grid) {
    try { grid = sanitizeGrid(localStorage.getItem("freerig710-js8-my-grid") || ""); } catch (_) {}
  }
  state.station.call = call;
  state.station.grid = grid;
  if (elements["js8-my-call"]) {
    elements["js8-my-call"].value = call;
    elements["js8-my-call"].readOnly = true;
  }
  if (elements["js8-my-grid"]) {
    elements["js8-my-grid"].value = grid;
    elements["js8-my-grid"].readOnly = true;
  }
  renderQrzPreview();
}

function formatHz(hz) {
  if (!Number.isFinite(hz)) return "--";
  if (Math.abs(hz) >= 1000000) return `${(hz / 1000000).toFixed(6)} MHz`;
  return `${Math.round(hz)} Hz`;
}

function formatKHz(hz) {
  return Number.isFinite(hz) ? (hz / 1000).toFixed(3) : "--";
}

function formatUtc(date = new Date()) {
  return date.toISOString().slice(11, 19);
}

function formatFrequencyDigits(hz) {
  if (!Number.isFinite(Number(hz))) return "--.---.---";
  return String(Math.round(Number(hz))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function bandFromFrequency(frequencyHz) {
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

function qrzUtcText() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updatePill(el, text, status) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-ok", "is-warn", "is-bad", "is-idle");
  if (status) el.classList.add(status);
}

function log(line, level = "info") {
  const stamp = formatUtc();
  state.logLines.unshift({ stamp, line, level });
  state.logLines = state.logLines.slice(0, 180);
  if (!elements["js8-log"]) return;
  elements["js8-log"].innerHTML = state.logLines
    .map((entry) => `<div class="js8-log-line is-${entry.level}"><span>${entry.stamp}</span>${escapeHtml(entry.line)}</div>`)
    .join("");
}

function setTxAudioHz(hz, options = {}) {
  state.txAudioHz = clamp(Number(hz) || 1500, DF_LOW, DF_HIGH);
  if (elements["js8-tx-audio"]) elements["js8-tx-audio"].value = String(Math.round(state.txAudioHz));
  localStorage.setItem("freerig710-js8-tx-audio-hz", String(Math.round(state.txAudioHz)));
  updateFrequencyReadout();
  if (options.applyRadio !== false && state.rxEnabled) {
    void applyTxVfoB().catch((error) => log(`TX VFO update failed: ${error.message}`, "warn"));
  }
  return state.txAudioHz;
}

function setManualTxAudioHz(hz, options = {}) {
  const df = setTxAudioHz(hz, options);
  setAutoFreqEnabled(false, options.reason || `Manual TX audio frequency selected: ${Math.round(df)} Hz`);
  return df;
}

function setAutoFreqEnabled(enabled, reason = "") {
  const next = Boolean(enabled);
  const changed = state.autoFreq !== next;
  state.autoFreq = next;
  if (elements["js8-auto-freq"]) elements["js8-auto-freq"].checked = next;
  try { localStorage.setItem("freerig710-js8-auto-freq", next ? "1" : "0"); } catch (_) {}
  if (reason && changed) log(reason);
}

function txRfHz(df = state.txAudioHz) {
  return Math.round(state.dialHz + df);
}

function txVfoBDialHz(df = state.txAudioHz) {
  return Math.round(txRfHz(df) - TX_AUDIO_CENTER_HZ);
}

function updateFrequencyReadout() {
  if (elements["js8-rx-dial"]) elements["js8-rx-dial"].textContent = formatKHz(state.dialHz);
  if (elements["js8-tx-vfo-b"]) elements["js8-tx-vfo-b"].textContent = formatKHz(txVfoBDialHz());
  if (elements["js8-tx-rf"]) elements["js8-tx-rf"].textContent = formatKHz(txRfHz());
  if (elements["js8-tx-df-label"]) elements["js8-tx-df-label"].textContent = `TX DF ${Math.round(state.txAudioHz)} Hz`;
  const left = ((state.txAudioHz - DF_LOW) / (DF_HIGH - DF_LOW)) * 100;
  if (elements["js8-tx-cursor"]) elements["js8-tx-cursor"].style.left = `${clamp(left, 0, 100)}%`;
  if (elements["js8-tx-cursor-label"]) {
    elements["js8-tx-cursor-label"].textContent = String(Math.round(state.txAudioHz));
    elements["js8-tx-cursor-label"].style.left = left > 88 ? "auto" : "5px";
    elements["js8-tx-cursor-label"].style.right = left > 88 ? "5px" : "auto";
  }
  renderQrzPreview();
}

function txAudioHzFromWaterfallEvent(event) {
  const hitbox = elements["js8-waterfall-hitbox"];
  if (!hitbox) return NaN;
  const rect = hitbox.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  return clamp(Math.round((DF_LOW + ratio * (DF_HIGH - DF_LOW)) / 10) * 10, DF_LOW, DF_HIGH);
}

function populateBandControls() {
  const bandButtons = elements["js8-band-buttons"];
  const bandSelect = elements["js8-band-select"];
  if (bandButtons) {
    bandButtons.innerHTML = JS8_BANDS.map(
      (band) =>
        `<button type="button" class="js8-chip${band.label === state.activeBand ? " is-active" : ""}" data-band="${band.label}">${band.label}</button>`
    ).join("");
    bandButtons.addEventListener("click", (event) => {
      const button = event.target.closest("[data-band]");
      if (!button) return;
      void selectBand(button.dataset.band, false);
    });
  }
  if (bandSelect) {
    bandSelect.innerHTML = `<option value="">Select band...</option>` + JS8_BANDS.map(
      (band) => `<option value="${band.label}">${band.label} - ${(band.hz / 1000000).toFixed(6)} MHz</option>`
    ).join("");
    bandSelect.value = state.activeBand;
    bandSelect.addEventListener("change", () => void selectBand(bandSelect.value, false));
  }
}

async function selectBand(label, silent = false) {
  const band = JS8_BANDS.find((item) => item.label === label);
  if (!band) {
    state.activeBand = "";
    state.dialHz = NaN;
    state.levelHistory.length = 0;
    state.rfGainPending = null;
    state.rfGainSettleUntil = 0;
    if (elements["js8-band-select"]) elements["js8-band-select"].value = "";
    document.querySelectorAll(".js8-chip[data-band]").forEach((button) => button.classList.remove("is-active"));
    updateFrequencyReadout();
    return;
  }
  state.activeBand = band.label;
  state.dialHz = band.hz;
  loadRfGainModel(band.label);
  state.levelHistory.length = 0;
  state.rfGainPending = null;
  state.rfGainSettleUntil = 0;
  if (elements["js8-band-select"]) elements["js8-band-select"].value = band.label;
  document.querySelectorAll(".js8-chip[data-band]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.band === band.label);
  });
  updateFrequencyReadout();
  if (!silent) log(`Selected JS8 ${band.label} dial ${formatHz(band.hz)}`);
  if (!silent) await configureRadioForJs8();
}

function submodeInfo(id = state.submode) {
  const info = getSubmode(Number(id) || 0);
  return info || getSubmode(0);
}

function updateSubmodeReadout() {
  const info = submodeInfo();
  if (elements["js8-submode-readout"]) elements["js8-submode-readout"].textContent = `${info.name} ${info.slotSeconds}s`;
}

function loadSettings() {
  localStorage.removeItem("freerig710-js8-band");
  const savedAudio = Number(localStorage.getItem("freerig710-js8-tx-audio-hz"));
  if (Number.isFinite(savedAudio)) state.txAudioHz = clamp(savedAudio, DF_LOW, DF_HIGH);
  const savedSubmode = Number(localStorage.getItem("freerig710-js8-submode"));
  if (SUBMODE_BITS.has(savedSubmode)) state.submode = savedSubmode;
  const savedAuto = localStorage.getItem("freerig710-js8-auto-freq");
  if (savedAuto !== null) state.autoFreq = savedAuto === "1";
  const savedRfTarget = Number(localStorage.getItem("freerig710-js8-rf-target-v1"));
  if (Number.isFinite(savedRfTarget) && savedRfTarget >= -70 && savedRfTarget <= -30 && elements["js8-rf-target"]) {
    elements["js8-rf-target"].value = String(savedRfTarget);
  }
  const savedAutoRf = localStorage.getItem("freerig710-js8-auto-rf-v1");
  if (savedAutoRf !== null) state.autoRfGain = savedAutoRf === "1";
  applySharedStationSettings();
}

function applySettingsToUi() {
  if (elements["js8-tx-audio"]) elements["js8-tx-audio"].value = String(Math.round(state.txAudioHz));
  if (elements["js8-submode"]) elements["js8-submode"].value = String(state.submode);
  if (elements["js8-auto-freq"]) elements["js8-auto-freq"].checked = state.autoFreq;
  if (elements["js8-auto-rf"]) elements["js8-auto-rf"].checked = state.autoRfGain;
  if (elements["js8-rf-gain-slider"]) elements["js8-rf-gain-slider"].disabled = state.autoRfGain;
  applySharedStationSettings();
  updateSubmodeReadout();
  updateFrequencyReadout();
}

function rfTargetDbfs() {
  return clamp(Number(elements["js8-rf-target"]?.value) || -50, -70, -30);
}

function loadRfGainModel(band) {
  let slope = NaN;
  try { slope = Number(localStorage.getItem(`freerig710-js8-rf-slope-v1-${band}`)); } catch (_) {}
  state.rfGainSlopeDbPerStep = Number.isFinite(slope) && slope >= 0.02 && slope <= 2.0 ? slope : null;
}

function saveRfGainModel() {
  if (!state.activeBand || !Number.isFinite(state.rfGainSlopeDbPerStep)) return;
  try { localStorage.setItem(`freerig710-js8-rf-slope-v1-${state.activeBand}`, String(state.rfGainSlopeDbPerStep)); } catch (_) {}
}

function setRfGainOptimistic(value) {
  const gain = clamp(Math.round(Number(value) || 0), 0, 255);
  state.rfGainManualPending = gain;
  state.rfGainManualPendingUntil = Date.now() + 3000;
  if (elements["js8-rf-gain-slider"]) elements["js8-rf-gain-slider"].value = String(gain);
  if (elements["js8-rf-gain-slider-label"]) elements["js8-rf-gain-slider-label"].textContent = String(gain);
}

function updateRfGainUiFromRadio(status = state.radio) {
  const power = status?.radio_power || "--";
  const actual = Number(status?.rf_gain);
  if (Number.isFinite(actual)) {
    const gain = clamp(Math.round(actual), 0, 255);
    const readout = elements["js8-rf-gain"];
    if (readout) {
      readout.textContent = `${gain} / 255`;
      readout.title = Number.isFinite(state.rfGainSlopeDbPerStep)
        ? `Auto RF Gain model: ${state.rfGainSlopeDbPerStep.toFixed(3)} dB/step`
        : "Auto RF Gain model: learning";
    }
    if (state.rfGainManualPending != null && gain === state.rfGainManualPending) {
      state.rfGainManualPending = null;
      state.rfGainManualPendingUntil = 0;
    }
    const preserveManual = state.rfGainDragging || state.rfGainControlBusy ||
      (state.rfGainManualPending != null && Date.now() < state.rfGainManualPendingUntil);
    if (!preserveManual) {
      state.rfGainManualPending = null;
      state.rfGainManualPendingUntil = 0;
      if (elements["js8-rf-gain-slider"]) elements["js8-rf-gain-slider"].value = String(gain);
      if (elements["js8-rf-gain-slider-label"]) elements["js8-rf-gain-slider-label"].textContent = String(gain);
    }
  } else {
    if (elements["js8-rf-gain"]) {
      elements["js8-rf-gain"].textContent = "-- / 255";
      elements["js8-rf-gain"].title = "Auto RF Gain unavailable";
    }
    if (!state.rfGainDragging && elements["js8-rf-gain-slider-label"]) {
      elements["js8-rf-gain-slider-label"].textContent = "--";
    }
  }
  if (elements["js8-rf-gain-slider"]) {
    elements["js8-rf-gain-slider"].disabled = state.autoRfGain || state.rfGainControlBusy || power !== "ON";
  }
}

async function setManualRfGain(value) {
  if (state.autoRfGain) return;
  const gain = clamp(Math.round(Number(value) || 0), 0, 255);
  const requestSeq = ++state.rfGainRequestSeq;
  setRfGainOptimistic(gain);
  state.rfGainControlBusy = true;
  updateRfGainUiFromRadio();
  try {
    const result = await post("/api/v1/radio/rf-gain", { value: gain });
    if (requestSeq !== state.rfGainRequestSeq) return;
    const confirmed = Number(result?.state?.rf_gain);
    if (Number.isFinite(confirmed) && Math.round(confirmed) === gain) {
      state.rfGainManualPending = null;
      state.rfGainManualPendingUntil = 0;
    }
    state.levelHistory.length = 0;
    state.rfGainPending = null;
    state.rfGainSettleUntil = Date.now() + 700;
  } catch (error) {
    if (requestSeq === state.rfGainRequestSeq) {
      state.rfGainManualPending = null;
      state.rfGainManualPendingUntil = 0;
      log(`RF gain change failed: ${error.message}`, "bad");
    }
  } finally {
    if (requestSeq === state.rfGainRequestSeq) state.rfGainControlBusy = false;
    updateRfGainUiFromRadio();
  }
}

async function autoAdjustRfGain() {
  if (!state.autoRfGain || state.autoGainBusy || !state.activeBand || !state.rxEnabled || !state.audioReady || state.radio?.radio_power !== "ON") return;
  if (state.txBusy || state.radio?.ptt_active || state.radio?.tx_state === "TX") return;
  const instantaneous = Number(state.lastLevelDb);
  const current = Number(state.radio?.rf_gain);
  const target = rfTargetDbfs();
  if (!Number.isFinite(instantaneous) || instantaneous < -95 || !Number.isFinite(current)) return;

  const now = Date.now();
  if (now < state.rfGainSettleUntil) return;
  state.levelHistory.push(instantaneous);
  if (state.levelHistory.length > 12) state.levelHistory.shift();
  if (state.levelHistory.length < 5) return;
  const sorted = [...state.levelHistory].sort((a, b) => a - b);
  const level = sorted[Math.floor((sorted.length - 1) * 0.25)];

  if (state.rfGainPending) {
    const pending = state.rfGainPending;
    if (current === pending.fromGain && now - pending.appliedAt < 2600) return;
    const dg = current - pending.fromGain;
    const dl = level - pending.fromLevel;
    if (Math.abs(dg) >= 2) {
      const observed = dl / dg;
      if (Number.isFinite(observed) && observed > 0.02 && observed < 2.0) {
        state.rfGainSlopeDbPerStep = Number.isFinite(state.rfGainSlopeDbPerStep)
          ? state.rfGainSlopeDbPerStep * 0.65 + observed * 0.35
          : observed;
        saveRfGainModel();
      } else if (!Number.isFinite(state.rfGainSlopeDbPerStep)) {
        state.rfGainSlopeDbPerStep = 0.25;
      }
    }
    state.rfGainPending = null;
  }

  const error = target - level;
  if (Math.abs(error) <= 1.5) {
    const slopeText = Number.isFinite(state.rfGainSlopeDbPerStep) ? `${state.rfGainSlopeDbPerStep.toFixed(3)} dB/step` : "learning";
    if (elements["js8-rf-gain"]) {
      elements["js8-rf-gain"].textContent = `${Math.round(current)} / 255`;
      elements["js8-rf-gain"].title = `Auto RF Gain · ${level.toFixed(1)} dBFS · ${slopeText}`;
    }
    return;
  }

  let next = current;
  let kind = "correction";
  if (!Number.isFinite(state.rfGainSlopeDbPerStep)) {
    kind = "probe";
    const probe = Math.abs(error) > 12 ? 16 : (Math.abs(error) > 6 ? 10 : 5);
    next = clamp(current + (error > 0 ? probe : -probe), 0, 255);
  } else {
    let delta = Math.round(error / state.rfGainSlopeDbPerStep);
    const ae = Math.abs(error);
    const maxDelta = ae > 20 ? 90 : (ae > 10 ? 60 : (ae > 5 ? 35 : (ae > 2.5 ? 14 : 6)));
    delta = clamp(delta, -maxDelta, maxDelta);
    if (delta === 0) delta = error > 0 ? 1 : -1;
    next = clamp(current + delta, 0, 255);
  }
  if (next === current) return;

  state.autoGainBusy = true;
  try {
    await post("/api/v1/radio/rf-gain", { value: next });
    state.rfGainPending = { fromGain: current, fromLevel: level, toGain: next, appliedAt: Date.now(), kind };
    state.levelHistory.length = 0;
    state.rfGainSettleUntil = Date.now() + 900;
    const model = Number.isFinite(state.rfGainSlopeDbPerStep) ? `${state.rfGainSlopeDbPerStep.toFixed(3)} dB/step` : "measuring dB/step";
    if (elements["js8-rf-gain"]) {
      elements["js8-rf-gain"].textContent = `${Math.round(next)} / 255`;
      elements["js8-rf-gain"].title = `Auto RF Gain · ${Math.round(current)} -> ${Math.round(next)} · ${level.toFixed(1)} dBFS · ${model}`;
    }
  } catch (_) {
    state.rfGainPending = null;
  } finally {
    state.autoGainBusy = false;
  }
}

function setQrzStatus(text, status = "") {
  const element = elements["js8-qrz-status"];
  if (!element) return;
  element.textContent = text;
  element.className = `js8-qrz-status js8-page-pill${status ? ` ${status}` : ""}`;
}

function qrzContext() {
  const txFrequency = txRfHz();
  const rxFrequency = Number.isFinite(state.dialHz) ? Math.round(state.dialHz) : NaN;
  const txPower = Number(state.radio?.tx_power_w);
  return {
    txFrequency: Number.isFinite(txFrequency) ? txFrequency : NaN,
    rxFrequency,
    band: bandFromFrequency(txFrequency),
    txPower: Number.isFinite(txPower) ? txPower : null,
  };
}

function normalizeJs8Report(value) {
  const text = String(value || "").trim().replace(/^0-/, "-");
  const match = /^([+-]?)(\d{1,2})$/.exec(text);
  if (!match) return "";
  const n = clamp(Number(`${match[1] || "+"}${match[2]}`), -50, 50);
  return formatSnrReport(n);
}

function gridFromJs8Body(body) {
  const match = /\b([A-R]{2}[0-9]{2}(?:[A-X]{2})?)\b/i.exec(String(body || ""));
  return match ? sanitizeGrid(match[1]) : "";
}

function reportForMyCall(entry) {
  const myCall = sanitizeCall(state.station.call);
  if (!myCall || entry.to !== myCall) return "";
  const match = /\b(?:HEARTBEAT\s+)?SNR\s+([+-]?\d{1,2}|0-\d{1,2})\b/i.exec(entry.body || "");
  return match ? normalizeJs8Report(match[1]) : "";
}

function rememberQrzReport(entry) {
  const call = entry.from || "";
  if (!call) return;
  const previous = state.qrzReports.get(call) || {};
  const next = {
    grid: previous.grid || "",
    rstSent: previous.rstSent || "",
    rstRcvd: previous.rstRcvd || "",
    ms: entry.ms,
  };
  const grid = gridFromJs8Body(entry.body);
  if (grid) next.grid = grid;
  if (entry.snr !== null) next.rstSent = formatSnrReport(entry.snr);
  const rcvd = reportForMyCall(entry);
  if (rcvd) next.rstRcvd = rcvd;
  state.qrzReports.set(call, next);
  const selected = sanitizeCall(elements["js8-qrz-call"]?.value || "");
  if (selected === call) applyQrzDefaultsForCall(call, false);
}

function applyQrzDefaultsForCall(call, overwrite = false) {
  const clean = sanitizeCall(call);
  const defaults = state.qrzReports.get(clean);
  if (!defaults) return;
  const grid = elements["js8-qrz-grid"];
  const sent = elements["js8-qrz-rst-sent"];
  const rcvd = elements["js8-qrz-rst-rcvd"];
  if (grid && defaults.grid && (overwrite || !grid.value.trim())) grid.value = defaults.grid;
  if (sent && defaults.rstSent && (overwrite || !sent.value.trim() || sent.value.trim() === "0")) sent.value = defaults.rstSent;
  if (rcvd && defaults.rstRcvd && (overwrite || !rcvd.value.trim() || rcvd.value.trim() === "0")) rcvd.value = defaults.rstRcvd;
}

function renderQrzPreview() {
  if (!elements["js8-qrz-tx-frequency"]) return;
  const context = qrzContext();
  elements["js8-qrz-station-call"].textContent = state.qrzState?.station_callsign || state.station.call || "Not configured";
  elements["js8-qrz-tx-frequency"].textContent = Number.isFinite(context.txFrequency)
    ? `${formatFrequencyDigits(context.txFrequency)} Hz`
    : "--.---.---";
  elements["js8-qrz-rx-frequency"].textContent = Number.isFinite(context.rxFrequency)
    ? `${formatFrequencyDigits(context.rxFrequency)} Hz`
    : "--.---.---";
  elements["js8-qrz-band"].textContent = context.band;
  elements["js8-qrz-mode"].textContent = "JS8";
  elements["js8-qrz-power"].textContent = context.txPower == null ? "--" : `${context.txPower} W`;
  elements["js8-qrz-utc"].textContent = `${qrzUtcText()} UTC`;
  updateQrzLogButton();
}

function updateQrzLogButton() {
  const button = elements["js8-qrz-submit"];
  if (!button) return;
  const call = sanitizeCall(elements["js8-qrz-call"]?.value || "");
  const context = qrzContext();
  const radioReady = state.radio?.radio_power === "ON"
    && Boolean(state.activeBand)
    && Number.isFinite(context.txFrequency)
    && Number.isFinite(context.rxFrequency)
    && context.band !== "--"
    && context.band !== "OUT OF BAND";
  button.classList.toggle("busy", state.qrzLogging);
  button.textContent = state.qrzLogging ? "Logging..." : "Log QSO to QRZ";
  button.disabled = state.qrzLogging || !state.qrzState?.configured || !radioReady || !call;
}

function applyQrzStatus(status) {
  state.qrzState = status || state.qrzState;
  if (state.qrzState?.configured) {
    setQrzStatus("READY", "is-ok");
    if (elements["js8-qrz-result"] && /checking/i.test(elements["js8-qrz-result"].textContent || "")) {
      elements["js8-qrz-result"].textContent = "Ready. QSO time is captured when you press Log QSO to QRZ.";
    }
  } else {
    setQrzStatus("NOT CONFIGURED", "is-bad");
    if (elements["js8-qrz-result"] && /checking/i.test(elements["js8-qrz-result"].textContent || "")) {
      elements["js8-qrz-result"].textContent = "Configure QRZ Logbook in the main Settings panel, then return here.";
    }
  }
  renderQrzPreview();
}

async function loadStationIdentity() {
  try {
    const response = await api("/api/v1/qrz/status");
    const status = response?.qrz || response;
    applyQrzStatus(status);
    const call = sanitizeCall(status?.station_callsign || status?.callsign || "");
    const grid = sanitizeGrid(status?.grid || status?.grid_square || "");
    if (window.FreeRig710Settings?.seed) window.FreeRig710Settings.seed({ call, grid });
    applySharedStationSettings();
  } catch (error) {
    setQrzStatus("ERROR", "is-bad");
    if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = error.message;
    log(`QRZ identity not available: ${error.message}`, "warn");
  }
}

function fillQrzFromCall(call, df = NaN) {
  const clean = sanitizeCall(call);
  if (!clean || clean.startsWith("@")) return;
  const previous = sanitizeCall(elements["js8-qrz-call"]?.value || "");
  if (elements["js8-to-call"]) elements["js8-to-call"].value = clean;
  if (elements["js8-qrz-call"]) elements["js8-qrz-call"].value = clean;
  applyQrzDefaultsForCall(clean, previous !== clean);
  if (Number.isFinite(df) && df >= DF_LOW && df <= DF_HIGH) {
    setManualTxAudioHz(df, { reason: `Auto TX audio frequency disabled; replying on ${Math.round(df)} Hz` });
  }
  updateQrzLogButton();
}

async function submitQrzLog(event) {
  if (event) event.preventDefault();
  if (state.qrzLogging) return;
  const call = sanitizeCall(elements["js8-qrz-call"]?.value || "");
  if (!call) {
    if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = "Enter the other station callsign first.";
    updateQrzLogButton();
    return;
  }
  const context = qrzContext();
  if (!state.activeBand || !Number.isFinite(context.txFrequency) || !Number.isFinite(context.rxFrequency)) {
    if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = "Select a JS8 band before logging to QRZ.";
    updateQrzLogButton();
    return;
  }
  if (context.band === "--" || context.band === "OUT OF BAND") {
    if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = "Current JS8 TX frequency cannot be mapped to an amateur band.";
    updateQrzLogButton();
    return;
  }

  state.qrzLogging = true;
  setQrzStatus("LOGGING", "is-warn");
  if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = `Sending ${call} to QRZ...`;
  updateQrzLogButton();
  try {
    const txPower = Number(context.txPower);
    const payload = {
      call,
      mode: "MFSK",
      submode: "JS8",
      timestamp_utc: new Date().toISOString(),
      frequency_hz: Math.round(context.txFrequency),
      rx_frequency_hz: Math.round(context.rxFrequency),
      band: context.band,
      grid: sanitizeGrid(elements["js8-qrz-grid"]?.value || ""),
      my_grid: sanitizeGrid(state.station.grid),
      rst_sent: String(elements["js8-qrz-rst-sent"]?.value || "").trim(),
      rst_rcvd: String(elements["js8-qrz-rst-rcvd"]?.value || "").trim(),
      comment: String(elements["js8-qrz-notes"]?.value || "").trim(),
      my_rig: "Yaesu FT-710",
    };
    if (Number.isFinite(txPower) && txPower > 0) payload.tx_power_w = Math.round(txPower);
    const response = await post("/api/v1/qrz/log", payload);
    const jobId = Number(response?.job?.job_id || 0);
    if (!jobId) throw new Error("QRZ worker did not return a job id");

    let job = response.job;
    const deadline = Date.now() + 15000;
    while (job && (job.state === "queued" || job.state === "running")) {
      if (Date.now() >= deadline) throw new Error("QRZ log request timed out");
      if (elements["js8-qrz-result"]) {
        elements["js8-qrz-result"].textContent = job.state === "queued"
          ? `Queued ${call} for QRZ...`
          : `Sending ${call} to QRZ...`;
      }
      await sleep(300);
      const status = await api("/api/v1/qrz/log/status");
      if (Number(status?.job?.job_id) !== jobId) continue;
      job = status.job;
    }
    if (!job || job.state !== "ok") throw new Error(job?.detail || "QRZ rejected QSO");
    const qso = job.qso || {};
    const modeText = qso.submode || qso.mode || "JS8";
    const logIdText = qso.logid ? ` · Log ID ${qso.logid}` : "";
    const qsoRxFrequency = Number(qso.rx_frequency_hz);
    const qsoTxFrequency = Number(qso.frequency_hz || context.txFrequency);
    const rxText = Number.isFinite(qsoRxFrequency) && qsoRxFrequency !== qsoTxFrequency
      ? ` · RX ${formatFrequencyDigits(qso.rx_frequency_hz)} Hz`
      : "";
    const powerText = Number(qso.tx_power_w) > 0 ? ` · ${qso.tx_power_w} W` : "";
    if (qso.adif) console.info("QRZ ADIF sent:", qso.adif);
    setQrzStatus("LOGGED", "is-ok");
    if (elements["js8-qrz-result"]) {
      elements["js8-qrz-result"].textContent =
        `${qso.call || call} logged on ${qso.band || context.band} · ${modeText} · TX ${formatFrequencyDigits(qsoTxFrequency)} Hz${rxText}${powerText}${logIdText}`;
    }
    if (elements["js8-qrz-call"]) elements["js8-qrz-call"].value = "";
    log(`QRZ logged JS8 QSO with ${qso.call || call}`);
  } catch (error) {
    setQrzStatus("ERROR", "is-bad");
    if (elements["js8-qrz-result"]) elements["js8-qrz-result"].textContent = error.message;
    log(`QRZ log failed: ${error.message}`, "bad");
  } finally {
    state.qrzLogging = false;
    updateQrzLogButton();
  }
}

async function loadCodec() {
  try {
    updatePill(elements["js8-codec-state"], "Codec loading", "is-warn");
    state.codec = await js8Init();
    recreateDecoder();
    state.codecReady = true;
    updatePill(elements["js8-codec-state"], "Codec ready", "is-ok");
    updateTxUi();
    log("JS8 WASM codec ready");
  } catch (error) {
    updatePill(elements["js8-codec-state"], "Codec failed", "is-bad");
    updateTxUi();
    log(`JS8 codec failed: ${error.message}`, "bad");
  }
}

function recreateDecoder() {
  if (!state.codecReady && !state.codec) return;
  try {
    if (state.decoder && typeof state.decoder.free === "function") state.decoder.free();
  } catch {
    // Ignore stale WASM decoder handles.
  }
  state.decoder = state.codec.newDecoder(state.submode);
}

function initAudioOwnerChannel() {
  if (!("BroadcastChannel" in window)) return;
  state.audioChannel = new BroadcastChannel(AUDIO_OWNER_CHANNEL);
  state.audioChannel.onmessage = (event) => {
    if (!event.data || event.data.owner === OWNER_ID) return;
    if (event.data.type === "claim") {
      log("Audio channel claimed by another FreeRig710 tool", "warn");
      closeAudio(false);
    }
  };
}

function claimAudioChannel() {
  if (state.audioChannel) state.audioChannel.postMessage({ type: "claim", owner: OWNER_ID, tool: "JS8" });
}

async function ensureAudio() {
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.audioReadyMessage) return;
  if (state.audioStarting) {
    const started = Date.now();
    while (state.audioStarting && Date.now() - started < 8500) await sleep(25);
    if (state.socket && state.socket.readyState === WebSocket.OPEN && state.audioReadyMessage) return;
    throw new Error("audio websocket timeout");
  }
  state.audioStarting = true;
  claimAudioChannel();
  updatePill(elements["js8-audio-state"], "Audio connecting", "is-warn");
  try {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketUrl("/api/v1/audio/ws"));
      state.socket = socket;
      socket.binaryType = "arraybuffer";
      const timeout = setTimeout(() => reject(new Error("audio websocket timeout")), 8000);
      socket.onopen = () => {
        log("FreeRig audio WebSocket connected for JS8");
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("audio websocket error"));
      };
      socket.onclose = () => {
        state.audioReady = false;
        state.audioReadyMessage = false;
        state.digitalStagedTx = false;
        state.socket = null;
        clearKeepalive();
        updatePill(elements["js8-audio-state"], "Audio closed", "is-idle");
      };
      socket.onmessage = (event) => {
        const message = handleAudioMessage(event.data);
        if (message && message.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
      };
    });
  } catch (error) {
    state.audioReady = false;
    state.audioReadyMessage = false;
    state.digitalStagedTx = false;
    updatePill(elements["js8-audio-state"], "Audio failed", "is-bad");
    log(`Audio start failed: ${error.message}`, "bad");
    throw error;
  } finally {
    state.audioStarting = false;
  }
}

function closeAudio(updateStatus = true) {
  if (state.socket) {
    try {
      state.socket.close();
    } catch {
      // best effort
    }
  }
  state.socket = null;
  state.audioReady = false;
  state.audioReadyMessage = false;
  state.digitalStagedTx = false;
  clearKeepalive();
  if (updateStatus) updatePill(elements["js8-audio-state"], "Audio closed", "is-idle");
}

function handleAudioMessage(data) {
  if (data instanceof ArrayBuffer) {
    handlePcm(data);
    return null;
  }
  if (typeof data !== "string") return null;
  let message = null;
  try {
    message = JSON.parse(data);
  } catch {
    log(`Audio message: ${data}`, "warn");
    return null;
  }
  if (message.type === "ready") {
    state.rxRate = Number(message.sample_rate || message.rx_rate || message.rxRate || state.rxRate || 48000);
    state.txRate = Number(message.tx_sample_rate || message.tx_rate || message.txRate || state.txRate || 48000);
    state.digitalStagedTx = Boolean(message.digital_staged_tx);
    state.audioReady = true;
    state.audioReadyMessage = true;
    updatePill(elements["js8-audio-state"], `Audio ${state.rxRate} Hz`, "is-ok");
  } else if (message.type === "digital_waveform_error" || (message.type === "digital_waveform_begin" && message.ok === false) || (message.type === "digital_tx_play" && message.ok === false) || message.type === "tx_abort") {
    log(`Audio ${message.type}: ${message.error || message.reason || JSON.stringify(message)}`, "bad");
  } else if (message.type === "error" || message.type === "warning") {
    log(`Audio ${message.type}: ${message.message || JSON.stringify(message)}`, message.type === "error" ? "bad" : "warn");
  }
  resolveWaiters(message);
  return message;
}

function sendAudioControl(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error("audio websocket is not open");
  state.socket.send(JSON.stringify(message));
}

function waitForAudio(type, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const waiter = {
      type,
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        state.waiters = state.waiters.filter((entry) => entry !== waiter);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs),
    };
    state.waiters.push(waiter);
  });
}

function resolveWaiters(message) {
  state.waiters = state.waiters.filter((waiter) => {
    if (message.type !== waiter.type || !waiter.predicate(message)) return true;
    clearTimeout(waiter.timer);
    waiter.resolve(message);
    return false;
  });
}

async function setPtt(enabled) {
  await ensureAudio();
  if (enabled) {
    sendAudioControl({ type: "tx_source", source: "MICROPHONE" });
    await waitForAudio("tx_source", (message) => message.source === "MICROPHONE" || message.active === "MICROPHONE", 3000).catch(() => null);
    sendAudioControl({ type: "ptt", enabled: true });
    await waitForAudio("ptt", (message) => message.enabled === true, 3000).catch(() => null);
    clearKeepalive();
    state.pttKeepalive = setInterval(() => {
      try {
        sendAudioControl({ type: "ptt_keepalive" });
      } catch {
        clearKeepalive();
      }
    }, 500);
    sendAudioControl({ type: "ptt_keepalive" });
    return;
  }
  clearKeepalive();
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    sendAudioControl({ type: "ptt", enabled: false });
    await waitForAudio("ptt", (message) => message.enabled === false, 1500).catch(() => null);
    sendAudioControl({ type: "tx_source", source: "NONE" });
  }
}

function clearKeepalive() {
  if (state.pttKeepalive) clearInterval(state.pttKeepalive);
  state.pttKeepalive = null;
}

function nextDigitalWaveformId() {
  const id = ((Date.now() & 0xfffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  return id || 1;
}

function float32ToPcm16Buffer(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = clamp(Math.round(samples[i] * 32767), -32768, 32767);
  }
  return pcm.buffer;
}

async function stageDigitalAudio(samples48, label = "JS8") {
  await ensureAudio();
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error("audio websocket closed");
  if (!state.digitalStagedTx) throw new Error("ESP32 firmware does not advertise staged digital TX; flash the updated firmware and refresh JS8");
  const id = nextDigitalWaveformId();
  const pcm = float32ToPcm16Buffer(samples48);
  const bytes = new Uint8Array(pcm);
  const beginWait = waitForAudio("digital_waveform_begin", (message) => message.id === id || message.ok === false, 5000);
  sendAudioControl({ type: "digital_waveform_begin", id, bytes: bytes.byteLength, sample_rate: 48000, label });
  const begin = await beginWait;
  if (begin.ok === false) throw new Error(begin.error || "staged digital upload rejected");
  const readyWait = waitForAudio("digital_waveform_ready", (message) => message.id === id, 15000);
  const errorWait = waitForAudio("digital_waveform_error", () => true, 15000).then(
    (message) => Promise.reject(new Error(message.error || "staged digital upload failed")),
    () => new Promise(() => {})
  );
  const chunkBytes = 16000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    if (state.txAbort) throw new Error("transmission halted");
    while (state.socket && state.socket.bufferedAmount > 65536) await sleep(2);
    state.socket.send(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength)));
  }
  await Promise.race([readyWait, errorWait]);
  return { id, bytes: bytes.byteLength };
}

async function playStagedDigitalAudio(staged, samples48, label, pttDelayMs, tailMs) {
  const durationMs = Math.ceil((samples48.length / 48000) * 1000);
  const leaseMs = durationMs + pttDelayMs + tailMs + 4000;
  const timeoutMs = leaseMs + 5000;
  const completeWait = waitForAudio("digital_tx_complete", (message) => message.id === staged.id, timeoutMs);
  const playWait = waitForAudio("digital_tx_play", (message) => message.id === staged.id, 3000);
  sendAudioControl({
    type: "digital_tx_play",
    id: staged.id,
    label,
    ptt_delay_ms: pttDelayMs,
    tail_ms: tailMs,
    lease_ms: leaseMs,
  });
  const play = await playWait;
  if (play.ok === false) throw new Error(play.error || "staged digital TX rejected");
  const complete = await completeWait;
  if (complete.ok === false) throw new Error(complete.reason || "staged digital TX failed");
  return complete;
}

function handlePcm(buffer) {
  const samples = new Int16Array(buffer);
  if (!samples.length) return;
  let peak = 0;
  const down = [];
  const ratio = (state.rxRate || 48000) / RX_RATE;
  if (Number.isInteger(ratio) && ratio >= 1) {
    let accum = state.rxAccum;
    let count = state.rxAccumCount;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] / 32768;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
      accum += value;
      count += 1;
      if (count >= ratio) {
        down.push(accum / count);
        accum = 0;
        count = 0;
      }
    }
    state.rxAccum = accum;
    state.rxAccumCount = count;
  } else {
    let phase = state.rxPhase;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] / 32768;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
      phase += 1;
      if (phase >= ratio) {
        phase -= ratio;
        down.push(value);
      }
    }
    state.rxPhase = phase;
  }
  if (peak > 0) state.lastLevelDb = 20 * Math.log10(peak);
  if (elements["js8-audio-level"]) {
    elements["js8-audio-level"].textContent = state.lastLevelDb === null ? "-- dBFS" : `${Math.round(state.lastLevelDb)} dBFS`;
  }
  if (down.length) {
    appendRxSamples(down);
    pushWaterfallSamples(down);
  }
}

function appendRxSamples(samples) {
  for (const sample of samples) {
    state.rxBuffer[state.rxWritePos] = sample;
    state.rxWritePos = (state.rxWritePos + 1) % state.rxBuffer.length;
  }
}

function copyLatestSamples(count) {
  const n = clamp(count, 0, state.rxBuffer.length);
  const out = new Float32Array(n);
  let start = state.rxWritePos - n;
  if (start < 0) start += state.rxBuffer.length;
  const first = Math.min(n, state.rxBuffer.length - start);
  out.set(state.rxBuffer.subarray(start, start + first), 0);
  if (first < n) out.set(state.rxBuffer.subarray(0, n - first), first);
  return out;
}

function tick() {
  const now = new Date();
  if (elements["js8-utc"]) elements["js8-utc"].textContent = `${formatUtc(now)} UTC`;
  if (elements["js8-qrz-utc"]) elements["js8-qrz-utc"].textContent = `${qrzUtcText()} UTC`;
  if (elements["js8-clock-state"]) updatePill(elements["js8-clock-state"], "UTC live", "is-ok");
  const info = submodeInfo();
  const slotMs = info.slotSeconds * 1000;
  const slotIndex = Math.floor(Date.now() / slotMs);
  const elapsed = Date.now() % slotMs;
  const next = Math.ceil((slotMs - elapsed) / 1000);
  if (elements["js8-next"]) elements["js8-next"].textContent = `${next}s`;
  if (elements["js8-timing-progress"]) elements["js8-timing-progress"].style.width = `${(elapsed / slotMs) * 100}%`;
  if (state.rxEnabled && !state.txBusy) {
    const endedModes = [];
    for (const mode of RX_SUBMODES) {
      const modeInfo = submodeInfo(mode);
      const modeSlot = Math.floor(Date.now() / (modeInfo.slotSeconds * 1000));
      if (state.lastSlots.get(mode) === undefined) state.lastSlots.set(mode, modeSlot);
      if (modeSlot !== state.lastSlots.get(mode)) {
        state.lastSlots.set(mode, modeSlot);
        endedModes.push(mode);
      }
    }
    if (endedModes.length) void decodeEndedSlots(endedModes);
  }
  void autoAdjustRfGain();
}

async function decodeEndedSlots(modes) {
  if (!state.codecReady || state.decoding) return;
  state.decoding = true;
  if (elements["js8-decode-state"]) elements["js8-decode-state"].textContent = "Decoding";
  try {
    for (const mode of modes) {
      const info = submodeInfo(mode);
      const samples = copyLatestSamples(Math.ceil(info.slotSeconds * RX_RATE));
      await runDecoderForMode(mode, samples);
    }
  } catch (error) {
    log(`Decode failed: ${error.message}`, "bad");
  } finally {
    state.decoding = false;
    state.lastDecodeMs = Date.now();
    if (elements["js8-decode-state"]) elements["js8-decode-state"].textContent = "Listening";
  }
}

async function runDecoderForMode(mode, samples) {
  let decoder = null;
  try {
    decoder = state.codec.newDecoder(0);
    decoder.push(samples);
    const modeBit = SUBMODE_BITS.get(mode) || 1;
    decoder.runModes(modeBit, ...decoderWindowsForMode(modeBit, samples.length));
    for (;;) {
      const decode = decoder.pop();
      if (!decode) break;
      handleDecode(decode, mode);
    }
  } finally {
    if (decoder && typeof decoder.free === "function") decoder.free();
  }
  await sleep(0);
}

function decoderWindowsForMode(modeBit, size) {
  const windows = {
    1: [0, 0],
    2: [0, 0],
    4: [0, 0],
    8: [0, 0],
    16: [0, 0],
  };
  windows[modeBit] = [0, size];
  return [
    windows[1][0],
    windows[1][1],
    windows[2][0],
    windows[2][1],
    windows[4][0],
    windows[4][1],
    windows[8][0],
    windows[8][1],
    windows[16][0],
    windows[16][1],
  ];
}

function handleDecode(raw, mode) {
  if (raw?.event && raw.event !== "decoded") return;
  const text = String(raw.text || raw.message || "").trim();
  if (!text) return;
  const info = submodeInfo(mode);
  const df = Math.round(Number(raw.freq || raw.df || raw.offset || 0));
  const snr = Number.isFinite(Number(raw.snr)) ? Math.round(Number(raw.snr)) : null;
  const key = `${mode}:${df}:${text}`;
  if (state.decodes.some((decode) => decode.key === key && Date.now() - decode.ms < 60000)) return;
  const parsed = parseDecodeText(text);
  const entry = {
    key,
    ms: Date.now(),
    utc: formatUtc(),
    mode: info.name,
    submode: mode,
    df,
    snr,
    text,
    from: parsed.from,
    to: parsed.to,
    body: parsed.body,
  };
  applyThreadContext(entry);
  state.decodeCount += 1;
  state.decodes.unshift(entry);
  state.decodes = state.decodes.slice(0, 250);
  addChat(entry);
  updateHeard(entry);
  rememberQrzReport(entry);
  renderHeard();
  renderChat();
  if (elements["js8-decode-count"]) elements["js8-decode-count"].textContent = String(state.decodeCount);
}

function parseDecodeText(text) {
  const trimmed = text.trim();
  const colon = /^([@A-Z0-9/-]{2,16})\s*:\s*(.*)$/i.exec(trimmed);
  if (colon) {
    const body = colon[2].trim();
    const first = /^([@A-Z0-9/-]{2,16})\s+(.*)$/i.exec(body);
    const directOnly = !first && isLikelyCall(body);
    return {
      from: sanitizeCall(colon[1]),
      to: first ? sanitizeCall(first[1]) : (directOnly ? sanitizeCall(body) : ""),
      body: first ? first[2].trim() : (directOnly ? "" : body),
    };
  }
  const direct = /^([@A-Z0-9/-]{2,16})\s+(.*)$/i.exec(trimmed);
  if (direct && isLikelyCall(direct[1])) {
    return { from: "", to: sanitizeCall(direct[1]), body: direct[2].trim() };
  }
  return { from: "", to: "", body: trimmed };
}

function isLikelyCall(value) {
  const call = sanitizeCall(value);
  if (!call || call.startsWith("@")) return true;
  if (/^[A-R]{2}[0-9]{2}$/i.test(call)) return false;
  if (/^(JS8|FT8|FT4|VARA|ARDOP|WINLINK|DATA|USB|LSB)$/i.test(call)) return false;
  return /^(?:[A-Z]{1,2}[0-9][A-Z0-9]{1,4}|[0-9][A-Z][A-Z0-9]{1,4})(?:\/[A-Z0-9]{1,4})?(?:-\d{1,2})?$/.test(call);
}

function findThreadForDf(df, now = Date.now()) {
  const numeric = Number(df);
  if (!Number.isFinite(numeric)) return null;
  const maxAgeMs = 20 * 60 * 1000;
  let best = null;
  for (const thread of state.rxThreads) {
    if (now - thread.ms > maxAgeMs) continue;
    const distance = Math.abs(thread.df - numeric);
    if (distance > 35) continue;
    if (!best || distance < best.distance || (distance === best.distance && thread.ms > best.thread.ms)) {
      best = { thread, distance };
    }
  }
  return best?.thread || null;
}

function rememberThread(entry) {
  if (!entry.from) return;
  const df = Number(entry.df);
  if (!Number.isFinite(df)) return;
  const existing = findThreadForDf(df, entry.ms);
  const thread = {
    from: entry.from,
    to: entry.to || "",
    df,
    ms: entry.ms,
  };
  if (existing) {
    existing.from = thread.from;
    existing.to = thread.to;
    existing.df = thread.df;
    existing.ms = thread.ms;
    return;
  }
  state.rxThreads.push(thread);
  state.rxThreads = state.rxThreads
    .filter((item) => entry.ms - item.ms <= 20 * 60 * 1000)
    .slice(-60);
}

function applyThreadContext(entry) {
  if (entry.from) {
    rememberThread(entry);
    return;
  }
  const thread = findThreadForDf(entry.df, entry.ms);
  if (!thread) return;
  entry.threadFrom = thread.from;
  entry.threadTo = thread.to;
}

function updateHeard(entry) {
  const callsign = entry.from || "";
  if (!callsign) return;
  const previous = state.heard.get(callsign) || {};
  const heartbeat = entry.to === "@HB"
    && /^HEARTBEAT(?:\s|$)/i.test(entry.body || "")
    && !/\bSNR\b/i.test(entry.body || "");
  state.heard.set(callsign, {
    call: callsign,
    utc: entry.utc,
    ms: entry.ms,
    snr: entry.snr,
    df: entry.df,
    mode: entry.mode,
    text: entry.text,
    heartbeat,
    count: (previous.count || 0) + 1,
  });
}

function addChat(entry) {
  state.chat.unshift({
    direction: "RX",
    utc: entry.utc,
    call: entry.from || "",
    likelyCall: entry.threadFrom || "",
    target: entry.to || "",
    likelyTarget: entry.threadTo || "",
    unknownSource: !entry.from,
    text: entry.text,
    snr: entry.snr,
    df: entry.df,
    mode: entry.mode,
  });
  state.chat = state.chat.slice(0, 250);
}

function addTxChat(target, text, frames, df) {
  state.chat.unshift({
    direction: "TX",
    utc: formatUtc(),
    call: target,
    target,
    unknownSource: false,
    text,
    snr: null,
    df,
    mode: submodeInfo().name,
    frames,
  });
  state.chat = state.chat.slice(0, 250);
  renderChat();
}

function renderHeard() {
  const body = elements["js8-heard-body"];
  if (!body) return;
  const rows = [...state.heard.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 80)
    .map(
      (entry) => `
        <tr data-call="${escapeHtml(entry.call)}" data-df="${entry.df}" data-snr="${entry.snr === null ? "" : entry.snr}" data-heartbeat="${entry.heartbeat ? "1" : "0"}">
          <td>${escapeHtml(entry.utc)}</td>
          <td class="js8-call-cell${entry.heartbeat ? " is-heartbeat" : ""}" title="${entry.heartbeat ? "Click to reply with HEARTBEAT SNR" : "Click to select this callsign"}">${escapeHtml(entry.call)}</td>
          <td>${entry.snr === null ? "--" : entry.snr}</td>
          <td>${entry.df || "--"}</td>
          <td>${escapeHtml(entry.mode)}</td>
          <td>${entry.count}</td>
          <td title="${escapeHtml(entry.text)}">${escapeHtml(entry.text)}</td>
        </tr>`
    )
    .join("");
  body.innerHTML =
    rows ||
    `<tr><td colspan="7" class="js8-empty-row">No JS8 decodes yet.</td></tr>`;
}

function renderChat() {
  const chat = elements["js8-chat-log"];
  if (!chat) return;
  chat.innerHTML = state.chat
    .map((entry) => {
      const isRx = entry.direction === "RX";
      const sourceText = isRx
        ? (entry.call
            ? (entry.target ? `${entry.call} -> ${entry.target}` : entry.call)
            : (entry.likelyCall
                ? `Likely ${entry.likelyCall}${entry.likelyTarget ? ` -> ${entry.likelyTarget}` : ""}?`
                : (entry.target ? `Unknown source -> ${entry.target}` : "Unknown source")))
        : entry.call;
      const meta = [
        entry.utc,
        entry.direction,
        sourceText,
        entry.df ? `${entry.df} Hz` : "",
        entry.snr !== null ? `${entry.snr} dB` : "",
        entry.frames ? `${entry.frames} frame${entry.frames === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const classes = [`js8-chat-entry`, `is-${entry.direction.toLowerCase()}`];
      if (isRx && entry.unknownSource) classes.push("is-unknown");
      if (isRx && entry.likelyCall) classes.push("is-inferred");
      const selectableCall = isRx ? (entry.call || entry.likelyCall || "") : "";
      const dataCall = selectableCall ? ` data-call="${escapeHtml(selectableCall)}"` : "";
      const dataDf = isRx && Number.isFinite(Number(entry.df)) ? ` data-df="${Math.round(Number(entry.df))}"` : "";
      const title = isRx && entry.unknownSource
        ? ` title="${entry.likelyCall ? "Source inferred from recent traffic on this DF" : "Decoded text did not include a sender callsign; click to reply on this audio frequency"}"`
        : "";
      return `<article class="${classes.join(" ")}"${dataCall}${dataDf}${title}><div>${escapeHtml(meta)}</div><p>${escapeHtml(entry.text)}</p></article>`;
    })
    .join("");
  renderQsoCounter();
}

function renderQsoCounter() {
  if (!elements["js8-frame-count"]) return;
  const messages = state.chat.length;
  const queuedFrames = state.txQueue.length;
  elements["js8-frame-count"].textContent = `${messages} message${messages === 1 ? "" : "s"} · ${queuedFrames} queued`;
}

function clearDecodes() {
  state.decodes = [];
  state.heard.clear();
  state.chat = [];
  state.decodeCount = 0;
  if (elements["js8-decode-count"]) elements["js8-decode-count"].textContent = "0 decodes";
  renderHeard();
  renderChat();
  log("JS8 decode history cleared");
}

function buildWaterfall() {
  const canvas = elements["js8-waterfall"];
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  state.wfCanvas = canvas;
  state.wfCtx = canvas.getContext("2d");
  state.wfImage = state.wfCtx.createImageData(canvas.width, 1);
  state.wfWindow = null;
  state.wfReal = null;
  state.wfImag = null;
  state.wfSpectrumDb = [];
  state.wfFloorDb = null;
  state.wfCeilDb = null;
  state.wfWriteAccumulator = [];
  drawWaterfallAxes();
}

function drawWaterfallAxes() {
  if (!state.wfCtx || !state.wfCanvas) return;
  const ctx = state.wfCtx;
  ctx.fillStyle = "#071016";
  ctx.fillRect(0, 0, state.wfCanvas.width, state.wfCanvas.height);
}

function pushWaterfallSamples(samples) {
  if (!state.wfCtx || !state.wfCanvas) return;
  state.wfWriteAccumulator.push(...samples);
  const needed = WATERFALL_FFT_SIZE;
  while (state.wfWriteAccumulator.length >= needed) {
    const chunk = state.wfWriteAccumulator.splice(0, needed);
    drawWaterfallLine(chunk);
  }
}

function ensureWaterfallFft() {
  if (state.wfWindow?.length === WATERFALL_FFT_SIZE) return;
  const n = WATERFALL_FFT_SIZE;
  state.wfWindow = new Float32Array(n);
  state.wfReal = new Float32Array(n);
  state.wfImag = new Float32Array(n);
  state.wfSpectrumDb = new Float32Array(n / 2);
  for (let i = 0; i < n; i += 1) {
    state.wfWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
}

function fftInPlace(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const u = i + j;
        const v = u + len / 2;
        const vr = real[v] * wr - imag[v] * wi;
        const vi = real[v] * wi + imag[v] * wr;
        real[v] = real[u] - vr;
        imag[v] = imag[u] - vi;
        real[u] += vr;
        imag[u] += vi;
        const nwr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nwr;
      }
    }
  }
}

function sampledPercentile(values, ratio) {
  if (!values.length) return -120;
  const step = Math.max(1, Math.floor(values.length / 700));
  const sample = [];
  for (let i = 0; i < values.length; i += step) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample[clamp(Math.round((sample.length - 1) * ratio), 0, sample.length - 1)];
}

function waterfallColor(value) {
  const t = clamp(value, 0, 1);
  if (t < 0.28) {
    const q = t / 0.28;
    return [Math.round(5 + q * 10), Math.round(14 + q * 25), Math.round(30 + q * 74)];
  }
  if (t < 0.58) {
    const q = (t - 0.28) / 0.3;
    return [Math.round(15 + q * 28), Math.round(39 + q * 105), Math.round(104 + q * 118)];
  }
  if (t < 0.84) {
    const q = (t - 0.58) / 0.26;
    return [Math.round(43 + q * 197), Math.round(144 + q * 78), Math.round(222 - q * 160)];
  }
  const q = (t - 0.84) / 0.16;
  return [Math.round(240 + q * 15), Math.round(222 + q * 31), Math.round(62 + q * 70)];
}

function drawWaterfallLine(samples) {
  const ctx = state.wfCtx;
  const canvas = state.wfCanvas;
  const width = canvas.width;
  const height = canvas.height;
  ensureWaterfallFft();
  let mean = 0;
  for (let i = 0; i < WATERFALL_FFT_SIZE; i += 1) mean += samples[i] || 0;
  mean /= WATERFALL_FFT_SIZE;
  for (let i = 0; i < WATERFALL_FFT_SIZE; i += 1) {
    state.wfReal[i] = ((samples[i] || 0) - mean) * state.wfWindow[i];
    state.wfImag[i] = 0;
  }
  fftInPlace(state.wfReal, state.wfImag);
  for (let i = 0; i < state.wfSpectrumDb.length; i += 1) {
    const mag = Math.hypot(state.wfReal[i], state.wfImag[i]) / (WATERFALL_FFT_SIZE / 2);
    state.wfSpectrumDb[i] = 20 * Math.log10(mag + 1e-12);
  }

  const image = ctx.getImageData(0, 0, width, height - 1);
  ctx.putImageData(image, 0, 1);
  const row = ctx.createImageData(width, 1);
  const rowDb = new Float32Array(width);
  for (let x = 0; x < width; x += 1) {
    const freq = DF_LOW + (x / Math.max(1, width - 1)) * (DF_HIGH - DF_LOW);
    const bin = (freq / RX_RATE) * WATERFALL_FFT_SIZE;
    const lower = clamp(Math.floor(bin), 0, state.wfSpectrumDb.length - 2);
    const frac = bin - lower;
    rowDb[x] = state.wfSpectrumDb[lower] * (1 - frac) + state.wfSpectrumDb[lower + 1] * frac;
  }
  const targetFloor = sampledPercentile(rowDb, 0.48) - 2;
  let targetCeil = sampledPercentile(rowDb, 0.985) + 5;
  if (targetCeil - targetFloor < 18) targetCeil = targetFloor + 18;
  state.wfFloorDb = state.wfFloorDb === null ? targetFloor : state.wfFloorDb * 0.86 + targetFloor * 0.14;
  state.wfCeilDb = state.wfCeilDb === null ? targetCeil : state.wfCeilDb * 0.8 + targetCeil * 0.2;
  const range = Math.max(12, state.wfCeilDb - state.wfFloorDb);
  for (let x = 0; x < width; x += 1) {
    const hot = clamp((rowDb[x] - state.wfFloorDb) / range, 0, 1);
    const [r, g, b] = waterfallColor(hot);
    const idx = x * 4;
    row.data[idx] = r;
    row.data[idx + 1] = g;
    row.data[idx + 2] = b;
    row.data[idx + 3] = 255;
  }
  ctx.putImageData(row, 0, 0);
}

function pickAutoFreq() {
  const occupied = [...state.decodes]
    .filter((decode) => Date.now() - decode.ms < 180000 && decode.df >= DF_LOW && decode.df <= DF_HIGH)
    .map((decode) => decode.df);
  const candidates = [1500, 1000, 2000, 750, 2300, 1250, 1750, 2500, 500, 2750];
  let best = state.txAudioHz;
  let bestScore = -1;
  for (const candidate of candidates) {
    const distance = occupied.length ? Math.min(...occupied.map((freq) => Math.abs(freq - candidate))) : 9999;
    if (distance > bestScore) {
      bestScore = distance;
      best = candidate;
    }
  }
  return best;
}

function buildPackedMessage(target, text, bypassSelection = false) {
  applySharedStationSettings();
  const myCall = sanitizeCall(state.station.call);
  const myGrid = sanitizeGrid(state.station.grid);
  if (!myCall) throw new Error("Set My Call in the main Settings panel before transmitting JS8");
  state.station.call = myCall;
  state.station.grid = myGrid;
  if (elements["js8-my-call"]) elements["js8-my-call"].value = myCall;
  if (elements["js8-my-grid"]) elements["js8-my-grid"].value = myGrid;

  const cleanTarget = sanitizeCall(target);
  const cleanText = String(text || "").replace(/\s+/g, " ").trim().toUpperCase();
  if (!cleanText) throw new Error("Message is empty");

  if (bypassSelection) {
    return state.codec.pack(myCall, myGrid, "", cleanText, state.submode);
  }
  if (cleanTarget && !cleanText.startsWith(`${cleanTarget} `) && cleanText !== cleanTarget) {
    return state.codec.pack(myCall, myGrid, cleanTarget, `${cleanTarget} ${cleanText}`, state.submode);
  }
  return state.codec.pack(myCall, myGrid, cleanTarget, cleanText, state.submode);
}

async function queueTransmission(text, options = {}) {
  if (!state.codecReady) throw new Error("JS8 codec is not ready");
  if (!state.activeBand || !Number.isFinite(state.dialHz)) throw new Error("Select a JS8 band before transmitting");
  await ensureAudio();
  const target = sanitizeCall(options.target || elements["js8-to-call"]?.value || "@ALLCALL") || "@ALLCALL";
  const frames = buildPackedMessage(target, text, Boolean(options.bypassSelection));
  if (!frames || !frames.length) throw new Error("JS8 encoder returned no frames");
  const df = state.autoFreq ? pickAutoFreq() : state.txAudioHz;
  setTxAudioHz(df);
  frames.forEach((frame) => {
    state.txQueue.push({
      frame,
      target,
      label: options.label || target,
      text,
      df,
      submode: state.submode,
    });
  });
  addTxChat(target, text, frames.length, df);
  updateTxUi();
  void drainTxQueue();
}

async function drainTxQueue() {
  if (state.txBusy || !state.txQueue.length) return;
  const batch = state.txQueue.splice(0, state.txQueue.length);
  updateTxUi();
  try {
    const tx12 = [];
    for (const item of batch) {
      const tones = state.codec.encode(item.frame.type, item.frame.frame, item.submode);
      const audio = synthesize(tones, { submode: item.submode, baseHz: TX_AUDIO_CENTER_HZ, amp: 0.45 });
      tx12.push(audio);
    }
    const combined12 = concatFloat32(tx12);
    const tx48 = upsampleTo48(combined12);
    if (state.configuring) log("Waiting for JS8 radio split configuration before TX", "warn");
    while (state.configuring) await sleep(100);
    const splitReady = await applyTxVfoB(batch[0].df);
    if (!splitReady) throw new Error("TX VFO B was not updated");
    await transmitAudio(tx48, `${batch[0].label} @${Math.round(batch[0].df)} Hz (${batch.length} frame${batch.length === 1 ? "" : "s"})`);
  } catch (error) {
    log(`JS8 transmit failed: ${error.message}`, "bad");
  } finally {
    updateTxUi();
    if (state.txQueue.length) void drainTxQueue();
  }
}

function concatFloat32(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function transmitAudio(samples48, label) {
  state.txBusy = true;
  state.txAbort = false;
  const resumeRx = Boolean(state.rxEnabled || elements["js8-enabled"]?.checked);
  state.rxEnabled = false;
  updateRxUi();
  updatePill(elements["js8-tx-state"], "TX staging", "is-warn");
  if (elements["js8-last-tx"]) elements["js8-last-tx"].textContent = label;
  const info = submodeInfo();
  let staged = null;
  let completed = false;
  try {
    await ensureAudio();
    const txAudio = samples48;
    staged = await stageDigitalAudio(txAudio, label);
    if (state.txAbort) throw new Error("transmission halted");
    const targetStartMs = nextSlotStartMs(info.slotSeconds, 700);
    const delay = targetStartMs - Date.now();
    if (delay > 0) {
      log(`JS8 TX staged for next ${info.name} slot in ${(delay / 1000).toFixed(1)}s`);
    }
    const pttLeadMs = clamp((info.prerollMs || 300) + 180, 300, 900);
    if (delay > pttLeadMs) await sleep(delay - pttLeadMs);
    if (state.txAbort) throw new Error("transmission halted");
    updatePill(elements["js8-tx-state"], "TX on air", "is-bad");
    await playStagedDigitalAudio(staged, txAudio, label, pttLeadMs, 220);
    completed = true;
    log(`JS8 TX complete: ${label}`);
  } finally {
    if (!completed && staged) {
      try { sendAudioControl({ type: "digital_tx_stop" }); } catch {}
    }
    state.txBusy = false;
    state.txAbort = false;
    state.rxEnabled = resumeRx;
    updateRxUi();
    updatePill(elements["js8-tx-state"], "TX idle", "is-idle");
  }
}

function nextSlotDelay(slotSeconds) {
  const slotMs = slotSeconds * 1000;
  const now = Date.now();
  const remainder = now % slotMs;
  let delay = slotMs - remainder;
  if (delay < 350) delay += slotMs;
  return delay;
}

function nextSlotStartMs(slotSeconds, minLeadMs = 350) {
  const slotMs = slotSeconds * 1000;
  const now = Date.now();
  return Math.ceil((now + minLeadMs) / slotMs) * slotMs;
}

function sendPcmChunk(samples) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error("audio websocket closed");
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = clamp(Math.round(samples[i] * 32767), -32768, 32767);
  }
  state.socket.send(pcm.buffer);
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const length = Math.max(1, Math.round(samples.length * (toRate / fromRate)));
  const out = new Float32Array(length);
  const ratio = (samples.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = src - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}

function haltTransmit() {
  if (!state.txBusy && !state.txQueue.length) return;
  state.txAbort = true;
  state.txQueue = [];
  try { sendAudioControl({ type: "digital_tx_stop" }); } catch {}
  updateTxUi();
  log("JS8 transmit halted", "warn");
}

function updateTxUi() {
  const queuedFrames = state.txQueue.length;
  renderQsoCounter();
  const disabled = state.txBusy || !state.codecReady;
  ["js8-send", "js8-cq", "js8-heartbeat"].forEach((id) => {
    if (elements[id]) elements[id].disabled = disabled;
  });
  if (elements["js8-halt"]) elements["js8-halt"].disabled = !(state.txBusy || queuedFrames);
}

function updateRxUi() {
  if (elements["js8-enabled"]) elements["js8-enabled"].checked = state.rxEnabled;
  updatePill(elements["js8-rx-state"], state.rxEnabled ? "Monitor on" : "Monitor off", state.rxEnabled ? "is-ok" : "is-idle");
}

async function configureRadioForJs8() {
  const band = JS8_BANDS.find((item) => item.label === state.activeBand);
  if (!band) return;
  if (state.configuring) {
    state.configPending = true;
    updatePill(elements["js8-radio-config-state"], "Config pending", "is-warn");
    return;
  }
  state.configuring = true;
  state.configPending = false;
  updatePill(elements["js8-radio-config-state"], "Configuring", "is-warn");
  try {
    const radioState = await api("/api/v1/state");
    state.radio = radioState || state.radio;
    updateRfGainUiFromRadio();
    renderQrzPreview();
    if (radioState?.radio_power !== "ON") throw new Error("Radio must be ON before selecting a JS8 band");
    await post("/api/v1/radio/vfo/split", { mode: "OFF" });
    await post("/api/v1/radio/vfo/select", { vfo: "A" });
    await post("/api/v1/radio/mode", { mode: "DATA-U", vfo: "A" });
    await post("/api/v1/radio/mode", { mode: "DATA-U", vfo: "B" });
    await post("/api/v1/radio/frequency", { frequency_hz: band.hz, vfo: "A" });
    await post("/api/v1/radio/frequency", { frequency_hz: txVfoBDialHz(), vfo: "B" });
    await post("/api/v1/radio/vfo/select", { vfo: "A" });
    await post("/api/v1/radio/vfo/split", { mode: "A_TO_B" });
    await post("/api/v1/radio/rf-sql-vr", { value: "RF" }).catch(() => null);
    if (!state.autoRfGain) {
      const manual = elements["js8-rf-gain-slider"]?.value || state.radio?.rf_gain || 180;
      await setManualRfGain(manual).catch((error) => log(`Manual RF gain apply failed: ${error.message}`, "warn"));
    }
    await post("/api/v1/radio/dnr", { enabled: false }).catch(() => null);
    await post("/api/v1/radio/noise-blanker", { enabled: false }).catch(() => null);
    await post("/api/v1/radio/auto-notch", { enabled: false }).catch(() => null);
    await post("/api/v1/radio/filter", {
      width_code: 19,
      shift_hz: 0,
      manual_notch_enabled: false,
      contour_enabled: false,
    }).catch(() => null);
    await ensureAudio();
    state.rxEnabled = true;
    updateRxUi();
    updatePill(elements["js8-radio-config-state"], "Radio ready", "is-ok");
    log(`Radio set for JS8 ${band.label}: VFO A RX ${formatHz(band.hz)}, VFO B TX ${formatHz(txVfoBDialHz())}, split A→B`);
  } catch (error) {
    updatePill(elements["js8-radio-config-state"], "Radio failed", "is-bad");
    log(`Radio configuration failed: ${error.message}`, "bad");
  } finally {
    state.configuring = false;
    if (state.configPending) {
      state.configPending = false;
      void configureRadioForJs8();
    }
  }
}

async function applyTxVfoB(df = state.txAudioHz) {
  if (state.configuring || !Number.isFinite(txVfoBDialHz(df))) return false;
  const generation = ++state.txVfoApplyGeneration;
  const targetHz = txVfoBDialHz(df);
  const targetDf = Math.round(df);
  const previous = state.txVfoApplyPromise || Promise.resolve(true);
  const task = previous.catch(() => false).then(async () => {
    if (generation !== state.txVfoApplyGeneration) return false;
    await post("/api/v1/radio/frequency", { frequency_hz: targetHz, vfo: "B" });
    if (generation !== state.txVfoApplyGeneration) return false;
    await post("/api/v1/radio/vfo/split", { mode: "A_TO_B" });
    if (generation !== state.txVfoApplyGeneration) return false;
    updatePill(elements["js8-radio-config-state"], `TX DF ${targetDf} Hz → VFO B ${formatHz(targetHz)}`, "is-ok");
    return true;
  });
  state.txVfoApplyPromise = task;
  return task;
}

async function pollRadioState() {
  try {
    const status = await api("/api/v1/state");
    state.radio = status;
    const mode = status?.mode || status?.operating_mode || "--";
    const freq = status?.vfo_a_hz || status?.frequency_hz || status?.active_vfo_hz || status?.vfo_a;
    updatePill(elements["js8-radio-state"], freq ? `${formatKHz(Number(freq))} kHz ${mode}` : `${mode}`, "is-ok");
    updateRfGainUiFromRadio(status);
    renderQrzPreview();
  } catch {
    state.radio = null;
    updatePill(elements["js8-radio-state"], "Radio offline", "is-warn");
    updateRfGainUiFromRadio(null);
    renderQrzPreview();
  }
}

function sendMessage() {
  const text = elements["js8-message"]?.value || "";
  const target = elements["js8-to-call"]?.value || "@ALLCALL";
  queueTransmission(text, { target }).catch((error) => log(error.message, "bad"));
  if (elements["js8-message"]) elements["js8-message"].value = "";
}

function sendCq() {
  const grid = sanitizeGrid(state.station.grid);
  const text = grid ? `CQ CQ CQ ${grid.slice(0, 4)}` : "CQ CQ CQ";
  queueTransmission(text, { target: "@ALLCALL", label: "CQ", bypassSelection: true }).catch((error) => log(error.message, "bad"));
}

function sendHeartbeat() {
  const grid = sanitizeGrid(state.station.grid);
  const text = grid ? `@HB HEARTBEAT ${grid.slice(0, 4)}` : "@HB HEARTBEAT";
  queueTransmission(text, { target: "@HB", label: "Heartbeat", bypassSelection: true }).catch((error) => log(error.message, "bad"));
}

function formatSnrReport(snr) {
  const value = clamp(Math.round(Number(snr)), -50, 50);
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${String(Math.abs(value)).padStart(2, "0")}`;
}

function replyHeartbeat(call, snr, df = NaN) {
  const clean = sanitizeCall(call);
  if (!clean || clean.startsWith("@")) return;
  if (!Number.isFinite(Number(snr))) {
    log(`Cannot reply to ${clean}: no SNR in the decoded heartbeat`, "warn");
    fillQrzFromCall(clean, df);
    return;
  }
  fillQrzFromCall(clean, df);
  const report = formatSnrReport(snr);
  const text = `HEARTBEAT SNR ${report}`;
  queueTransmission(text, { target: clean, label: `HB reply ${clean}` })
    .then(() => log(`Queued heartbeat reply to ${clean}: SNR ${report}`))
    .catch((error) => log(error.message, "bad"));
}

function bindEvents() {
  if (elements["js8-tx-audio"]) {
    elements["js8-tx-audio"].addEventListener("change", () => {
      const df = setManualTxAudioHz(elements["js8-tx-audio"].value);
      log(`TX audio frequency set manually to ${Math.round(df)} Hz`);
    });
  }
  if (elements["js8-submode"]) {
    elements["js8-submode"].addEventListener("change", () => {
      state.submode = Number(elements["js8-submode"].value) || 0;
      localStorage.setItem("freerig710-js8-submode", String(state.submode));
      updateSubmodeReadout();
      recreateDecoder();
      log(`JS8 submode set to ${submodeInfo().name}`);
    });
  }
  if (elements["js8-auto-freq"]) {
    elements["js8-auto-freq"].addEventListener("change", () => {
      const enabled = elements["js8-auto-freq"].checked;
      setAutoFreqEnabled(enabled, `Auto TX audio frequency ${enabled ? "enabled" : "disabled"}`);
    });
  }
  if (elements["js8-rf-target"]) {
    elements["js8-rf-target"].addEventListener("change", () => {
      const value = rfTargetDbfs();
      elements["js8-rf-target"].value = String(value);
      try { localStorage.setItem("freerig710-js8-rf-target-v1", String(value)); } catch (_) {}
      state.levelHistory.length = 0;
      state.rfGainPending = null;
      state.rfGainSettleUntil = Date.now() + 700;
      log(`Auto RF Gain target set to ${value} dBFS`);
    });
  }
  if (elements["js8-auto-rf"]) {
    elements["js8-auto-rf"].addEventListener("change", () => {
      state.autoRfGain = elements["js8-auto-rf"].checked;
      try { localStorage.setItem("freerig710-js8-auto-rf-v1", state.autoRfGain ? "1" : "0"); } catch (_) {}
      state.levelHistory.length = 0;
      state.rfGainPending = null;
      state.rfGainSettleUntil = Date.now() + 700;
      updateRfGainUiFromRadio();
      log(`Auto RF Gain ${state.autoRfGain ? "enabled" : "disabled"}`);
      if (!state.autoRfGain && state.radio?.radio_power === "ON" && elements["js8-rf-gain-slider"]) {
        void setManualRfGain(elements["js8-rf-gain-slider"].value);
      }
    });
  }
  if (elements["js8-rf-gain-slider"]) {
    const slider = elements["js8-rf-gain-slider"];
    const sendManual = () => {
      state.rfGainDragging = false;
      if (state.rfGainSendTimer) clearTimeout(state.rfGainSendTimer);
      state.rfGainSendTimer = null;
      void setManualRfGain(slider.value);
    };
    slider.addEventListener("input", () => {
      state.rfGainDragging = true;
      setRfGainOptimistic(slider.value);
      if (state.rfGainSendTimer) clearTimeout(state.rfGainSendTimer);
      state.rfGainSendTimer = setTimeout(sendManual, 250);
    });
    slider.addEventListener("change", sendManual);
    slider.addEventListener("pointerup", () => { state.rfGainDragging = false; });
    slider.addEventListener("blur", () => { state.rfGainDragging = false; });
  }
  if (elements["js8-enabled"]) {
    elements["js8-enabled"].addEventListener("change", async () => {
      state.rxEnabled = elements["js8-enabled"].checked;
      if (state.rxEnabled) {
        try {
          await ensureAudio();
        } catch {
          state.rxEnabled = false;
        }
      }
      updateRxUi();
    });
  }
  if (elements["js8-send"]) elements["js8-send"].addEventListener("click", sendMessage);
  if (elements["js8-cq"]) elements["js8-cq"].addEventListener("click", sendCq);
  if (elements["js8-heartbeat"]) elements["js8-heartbeat"].addEventListener("click", sendHeartbeat);
  if (elements["js8-halt"]) elements["js8-halt"].addEventListener("click", haltTransmit);
  if (elements["js8-message"]) {
    elements["js8-message"].addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
  }
  if (elements["js8-clear-decodes"]) elements["js8-clear-decodes"].addEventListener("click", clearDecodes);
  if (elements["js8-command-buttons"]) {
    elements["js8-command-buttons"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-command]");
      if (!button || !elements["js8-message"]) return;
      const command = button.dataset.command;
      elements["js8-message"].value = command === "73" ? "73" : command;
      elements["js8-message"].focus();
    });
  }
  if (elements["js8-heard-body"]) {
    elements["js8-heard-body"].addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-call]");
      if (!row) return;
      const call = row.dataset.call;
      const df = Number(row.dataset.df);
      if (event.target.closest(".js8-call-cell") && row.dataset.heartbeat === "1") {
        const snr = row.dataset.snr === "" ? NaN : Number(row.dataset.snr);
        replyHeartbeat(call, snr, df);
        return;
      }
      fillQrzFromCall(call, df);
    });
  }
  if (elements["js8-chat-log"]) {
    elements["js8-chat-log"].addEventListener("click", (event) => {
      const entry = event.target.closest(".js8-chat-entry[data-df]");
      if (!entry) return;
      const df = Number(entry.dataset.df);
      if (entry.dataset.call) {
        fillQrzFromCall(entry.dataset.call, df);
      } else if (Number.isFinite(df) && df >= DF_LOW && df <= DF_HIGH) {
        setManualTxAudioHz(df, { reason: `Auto TX audio frequency disabled; replying on ${Math.round(df)} Hz` });
      }
    });
  }
  if (elements["js8-waterfall-hitbox"]) {
    elements["js8-waterfall-hitbox"].addEventListener("pointerdown", (event) => {
      state.waterfallDragging = true;
      try { elements["js8-waterfall-hitbox"].setPointerCapture?.(event.pointerId); } catch (_) {}
      setManualTxAudioHz(txAudioHzFromWaterfallEvent(event), {
        applyRadio: false,
        reason: "Auto TX audio frequency disabled; manual waterfall TX selection active",
      });
      event.preventDefault();
    });
    elements["js8-waterfall-hitbox"].addEventListener("pointermove", (event) => {
      if (!state.waterfallDragging) return;
      setManualTxAudioHz(txAudioHzFromWaterfallEvent(event), { applyRadio: false });
      event.preventDefault();
    });
    const finishWaterfallDrag = (event) => {
      if (!state.waterfallDragging) return;
      state.waterfallDragging = false;
      const df = setManualTxAudioHz(txAudioHzFromWaterfallEvent(event));
      log(`TX audio frequency set from waterfall to ${Math.round(df)} Hz`);
      try { elements["js8-waterfall-hitbox"].releasePointerCapture?.(event.pointerId); } catch (_) {}
      event.preventDefault();
    };
    elements["js8-waterfall-hitbox"].addEventListener("pointerup", finishWaterfallDrag);
    elements["js8-waterfall-hitbox"].addEventListener("pointercancel", finishWaterfallDrag);
    elements["js8-waterfall-hitbox"].addEventListener("lostpointercapture", () => {
      state.waterfallDragging = false;
    });
  }
  window.addEventListener("freerig710-settings-changed", () => applySharedStationSettings());
  if (elements["js8-qrz-call"]) {
    elements["js8-qrz-call"].addEventListener("input", () => {
      const input = elements["js8-qrz-call"];
      const start = input.selectionStart;
      input.value = sanitizeCall(input.value).replace(/[@-]/g, "");
      if (start != null) input.setSelectionRange(Math.min(start, input.value.length), Math.min(start, input.value.length));
      updateQrzLogButton();
    });
  }
  if (elements["js8-qrz-grid"]) {
    elements["js8-qrz-grid"].addEventListener("input", () => {
      const input = elements["js8-qrz-grid"];
      const start = input.selectionStart;
      input.value = sanitizeGrid(input.value);
      if (start != null) input.setSelectionRange(Math.min(start, input.value.length), Math.min(start, input.value.length));
    });
  }
  if (elements["js8-qrz-form"]) elements["js8-qrz-form"].addEventListener("submit", submitQrzLog);
  window.addEventListener("resize", buildWaterfall);
  window.addEventListener("beforeunload", () => closeAudio(false));
}

async function init() {
  cacheElements();
  loadSettings();
  populateBandControls();
  applySettingsToUi();
  initAudioOwnerChannel();
  bindEvents();
  buildWaterfall();
  renderHeard();
  renderChat();
  updateRxUi();
  updateTxUi();
  updatePill(elements["js8-codec-state"], "Codec loading", "is-warn");
  updatePill(elements["js8-audio-state"], "Audio idle", "is-idle");
  updatePill(elements["js8-radio-state"], "Radio checking", "is-warn");
  await Promise.allSettled([loadStationIdentity(), loadCodec(), pollRadioState()]);
  setInterval(tick, 250);
  setInterval(pollRadioState, 2500);
  log("JS8 console ready");
}

init().catch((error) => log(`JS8 startup failed: ${error.message}`, "bad"));
