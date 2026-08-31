"use strict";

(() => {
  const SAMPLE_RATE = 48000;
  const DF_LOW = 200;
  const DF_HIGH = 3000;
  const DEFAULT_MARK_HZ = 2125;
  const DEFAULT_SHIFT_HZ = 170;
  const RTTY_FILTER_WIDTH_CODE = 0;
  const RTTY_WATERFALL_SPAN_HZ = DF_HIGH - DF_LOW;
  const RTTY_TX_TONE_RAMP_MS = 2;
  const DEFAULT_BAUD = 45.45;
  const DEFAULT_TX_LEVEL_DBFS = -28;
  const DEFAULT_SQUELCH_DB = 9;
  const DEFAULT_RADIO_MODE = "DATA-U";
  const RADIO_MODE_STORAGE_KEY = "freerig710-rtty-radio-mode-v2";
  const MAX_STAGED_BYTES = 12 * 1024 * 1024;
  const AUDIO_OWNER_CHANNEL = "freerig710-audio-owner-v1";
  const OWNER_ID = `rtty-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const RX_WF_RATE = 12000;
  const WATERFALL_FFT_SIZE = 1024;
  const RECENT_AUDIO_SECONDS = 8;
  const AUTO_RX_ANALYSIS_SECONDS = 5;

  const LETTERS_SHIFT = 0x1f;
  const FIGURES_SHIFT = 0x1b;
  const LETTERS_TABLE = Object.freeze([
    "", "E", "\n", "A", " ", "S", "I", "U",
    "\r", "D", "R", "J", "N", "F", "C", "K",
    "T", "Z", "L", "W", "H", "Y", "P", "Q",
    "O", "B", "G", "", "M", "X", "V", "",
  ]);
  const FIGURES_TABLE = Object.freeze([
    "", "3", "\n", "-", " ", "'", "8", "7",
    "\r", "$", "4", "'", ",", "!", ":", "(",
    "5", "\"", ")", "2", "#", "6", "0", "1",
    "9", "?", "&", "", ".", "/", ";", "",
  ]);

  const RTTY_BANDS = Object.freeze([
    { label: "160m", hz: 1838000 },
    { label: "80m", hz: 3590000 },
    { label: "40m", hz: 7080000 },
    { label: "30m", hz: 10140000 },
    { label: "20m", hz: 14080000 },
    { label: "17m", hz: 18102000 },
    { label: "15m", hz: 21080000 },
    { label: "12m", hz: 24920000 },
    { label: "10m", hz: 28080000 },
    { label: "6m", hz: 50600000 },
  ]);

  const charToLetters = new Map();
  const charToFigures = new Map();
  for (let code = 0; code < 32; code += 1) {
    const letter = LETTERS_TABLE[code];
    const figure = FIGURES_TABLE[code];
    if (letter && !charToLetters.has(letter)) charToLetters.set(letter, code);
    if (figure && !charToFigures.has(figure)) charToFigures.set(figure, code);
  }
  charToLetters.set("\r", 0x08);
  charToLetters.set("\n", 0x02);
  charToFigures.set("\r", 0x08);
  charToFigures.set("\n", 0x02);

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const byId = (id) => (typeof document === "undefined" ? null : document.getElementById(id));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

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

  const LOCAL_GUI_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocalGui = typeof window !== "undefined" && LOCAL_GUI_HOSTS.has(window.location?.hostname || "");
  let savedBackend = "";
  try {
    savedBackend = window.FreeRig710Settings?.get?.().backend || localStorage.getItem("freerig710-backend") || "";
  } catch {
    savedBackend = "";
  }
  const explicitBackend = normalizeBackend(typeof window !== "undefined" ? window.FREERIG710_BACKEND || "" : "");
  const defaultBackend = normalizeBackend(typeof window !== "undefined" ? window.FT710_CONFIG?.localDefaultBackend || "http://ft710.local" : "");
  const API_BASE = explicitBackend || (isLocalGui ? normalizeBackend(savedBackend) || defaultBackend : "");

  function apiUrl(path) {
    const clean = String(path || "").startsWith("/") ? String(path || "") : `/${path || ""}`;
    return `${API_BASE}${clean}`;
  }

  function websocketUrl(path) {
    const url = new URL(apiUrl(path), API_BASE || window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "text/plain;charset=UTF-8");
    }
    const response = await fetch(apiUrl(path), {
      ...options,
      method,
      headers,
      cache: method === "GET" ? "no-store" : options.cache,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        detail = payload?.detail || payload?.error || "";
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new Error(detail || `${response.status} ${response.statusText}`);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") || "";
    return type.includes("application/json") ? response.json() : response.text();
  }

  function post(path, body = {}) {
    return api(path, { method: "POST", body: JSON.stringify(body) });
  }

  function formatUtc(date = new Date()) {
    return date.toISOString().slice(11, 19);
  }

  function formatFrequencyDigits(hz) {
    if (!Number.isFinite(Number(hz))) return "--.---.---";
    return String(Math.round(Number(hz))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function formatKHz(hz) {
    return Number.isFinite(Number(hz)) ? (Number(hz) / 1000).toFixed(3) : "--";
  }

  function formatMHzInput(hz) {
    return Number.isFinite(Number(hz)) ? (Number(hz) / 1000000).toFixed(6) : "";
  }

  function parseDialMHz(value) {
    const mhz = Number(String(value || "").replace(",", "."));
    const hz = Math.round(mhz * 1000000);
    return Number.isFinite(hz) && hz > 0 ? hz : NaN;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function sanitizeCall(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9/]/g, "")
      .slice(0, 16);
  }

  function sharedStationSettings() {
    return window.FreeRig710Settings?.get?.() || { call: "", grid: "", backend: "" };
  }

  function updatePill(el, text, status) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("is-ok", "is-warn", "is-bad", "is-idle");
    if (status) el.classList.add(status);
  }

  class BaudotCodec {
    constructor(options = {}) {
      this.unshiftOnSpace = options.unshiftOnSpace !== false;
      this.shift = "letters";
    }

    reset() {
      this.shift = "letters";
    }

    decodeCode(code) {
      const value = Number(code) & 0x1f;
      if (value === LETTERS_SHIFT) {
        this.shift = "letters";
        return "";
      }
      if (value === FIGURES_SHIFT) {
        this.shift = "figures";
        return "";
      }
      const table = this.shift === "figures" ? FIGURES_TABLE : LETTERS_TABLE;
      const char = table[value] || "";
      if (char === " " && this.unshiftOnSpace) this.shift = "letters";
      return char;
    }

    static decodeCodes(codes, options = {}) {
      const codec = new BaudotCodec(options);
      let out = "";
      for (const code of codes || []) out += codec.decodeCode(code);
      return out.replace(/\r/g, "");
    }

    static encodeText(text, options = {}) {
      const shiftPreference = options.initialShift === "figures" ? "figures" : "letters";
      let shift = shiftPreference;
      const codes = [];
      const normalized = String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .toUpperCase();

      for (const rawChar of normalized) {
        const char = rawChar === "\t" ? " " : rawChar;
        if (char === "\n") {
          codes.push(0x08, 0x02);
          continue;
        }
        if (char === " ") {
          codes.push(0x04);
          if (options.unshiftOnSpace !== false) shift = "letters";
          continue;
        }
        if (charToLetters.has(char)) {
          if (shift !== "letters") {
            codes.push(LETTERS_SHIFT);
            shift = "letters";
          }
          codes.push(charToLetters.get(char));
          continue;
        }
        if (charToFigures.has(char)) {
          if (shift !== "figures") {
            codes.push(FIGURES_SHIFT);
            shift = "figures";
          }
          codes.push(charToFigures.get(char));
        }
      }
      return codes;
    }
  }

  class RTTYEncoder {
    constructor(options = {}) {
      this.sampleRate = SAMPLE_RATE;
      this.baud = clamp(Number(options.baud) || DEFAULT_BAUD, 20, 300);
      this.markHz = clamp(Number(options.markHz) || DEFAULT_MARK_HZ, DF_LOW, DF_HIGH - 40);
      this.shiftHz = clamp(Math.abs(Number(options.shiftHz) || DEFAULT_SHIFT_HZ), 40, Math.max(40, DF_HIGH - this.markHz));
      this.txReverse = Boolean(options.txReverse);
      this.levelDbfs = clamp(Number(options.levelDbfs) || DEFAULT_TX_LEVEL_DBFS, -50, -1);
      this.amplitude = clamp(Math.round(32767 * Math.pow(10, this.levelDbfs / 20)), 1, 32767);
      this.phase = 0;
      this.currentFrequency = NaN;
      this.symbolUnits = 0;
      this.offset = 0;
      this.pcm = new Int16Array(0);
    }

    build(text, options = {}) {
      const codes = BaudotCodec.encodeText(text, options);
      const preMs = clamp(Number(options.preMs ?? 350), 0, 5000);
      const postMs = clamp(Number(options.postMs ?? 450), 0, 5000);
      const symbolSeconds = codes.length * 7.5 / this.baud;
      const totalSamples = Math.ceil(this.sampleRate * (preMs + postMs) / 1000 + this.sampleRate * symbolSeconds + this.sampleRate);
      this.pcm = new Int16Array(totalSamples);
      this.phase = 0;
      this.currentFrequency = NaN;
      this.symbolUnits = 0;
      this.offset = 0;
      this.appendIdle(preMs);
      for (const code of codes) this.appendCode(code);
      this.appendIdle(postMs);
      this.applyEdgeRamp();
      return this.pcm.slice(0, this.offset);
    }

    toneForBit(bit) {
      const logicalMark = bit ? 1 : 0;
      const physicalMark = this.txReverse ? 1 - logicalMark : logicalMark;
      return physicalMark ? this.markHz : this.markHz + this.shiftHz;
    }

    ensureRoom(count) {
      if (this.offset + count <= this.pcm.length) return;
      const next = new Int16Array(Math.max(this.pcm.length * 2, this.offset + count + this.sampleRate));
      next.set(this.pcm);
      this.pcm = next;
    }

    writeSample(frequency) {
      this.pcm[this.offset] = clamp(Math.round(Math.sin(this.phase) * this.amplitude), -32768, 32767);
      this.offset += 1;
      this.phase += 2 * Math.PI * frequency / this.sampleRate;
      if (this.phase >= 2 * Math.PI) this.phase %= 2 * Math.PI;
    }

    appendTone(frequency, count) {
      const samples = Math.max(0, Math.round(count));
      this.ensureRoom(samples);
      const previous = Number.isFinite(this.currentFrequency) ? this.currentFrequency : frequency;
      const bitSamples = Math.max(1, Math.round(this.sampleRate / this.baud));
      const rampSamples = previous === frequency
        ? 0
        : Math.min(
          samples,
          Math.round(this.sampleRate * RTTY_TX_TONE_RAMP_MS / 1000),
          Math.round(bitSamples * 0.18),
        );
      for (let i = 0; i < samples; i += 1) {
        if (i < rampSamples) {
          const t = (i + 1) / rampSamples;
          const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
          this.writeSample(previous + (frequency - previous) * eased);
        } else {
          this.writeSample(frequency);
        }
      }
      this.currentFrequency = frequency;
    }

    appendIdle(milliseconds) {
      const samples = Math.max(0, Math.round(this.sampleRate * milliseconds / 1000));
      this.appendTone(this.toneForBit(1), samples);
    }

    appendSymbol(bit, units = 1) {
      this.symbolUnits += units;
      const target = Math.round(this.symbolUnits * this.sampleRate / this.baud);
      const count = target - this.symbolSampleOffset;
      this.appendTone(this.toneForBit(bit), count);
      this.symbolSampleOffset = target;
    }

    appendCode(code) {
      this.symbolSampleOffset = 0;
      this.symbolUnits = 0;
      this.appendSymbol(0);
      for (let bit = 0; bit < 5; bit += 1) this.appendSymbol((code >> bit) & 1);
      this.appendSymbol(1, 1.5);
    }

    applyEdgeRamp() {
      const ramp = Math.min(this.offset, Math.round(this.sampleRate * 0.006));
      if (ramp <= 1) return;
      for (let i = 0; i < ramp; i += 1) {
        const fade = i / ramp;
        this.pcm[i] = Math.round(this.pcm[i] * fade);
        const tail = this.offset - 1 - i;
        this.pcm[tail] = Math.round(this.pcm[tail] * fade);
      }
    }
  }

  class ToneTracker {
    constructor(frequency, sampleRate, bandwidthHz) {
      this.configure(frequency, sampleRate, bandwidthHz);
    }

    configure(frequency, sampleRate, bandwidthHz) {
      this.frequency = frequency;
      this.sampleRate = sampleRate;
      const omega = 2 * Math.PI * frequency / sampleRate;
      this.stepCos = Math.cos(omega);
      this.stepSin = Math.sin(omega);
      this.cos = 1;
      this.sin = 0;
      this.i1 = 0;
      this.q1 = 0;
      this.i2 = 0;
      this.q2 = 0;
      this.alpha = 1 - Math.exp(-2 * Math.PI * bandwidthHz / sampleRate);
    }

    push(sample) {
      const mixI = sample * this.cos * 2;
      const mixQ = -sample * this.sin * 2;
      const a = this.alpha;
      this.i1 += a * (mixI - this.i1);
      this.q1 += a * (mixQ - this.q1);
      this.i2 += a * (this.i1 - this.i2);
      this.q2 += a * (this.q1 - this.q2);
      const nextCos = this.cos * this.stepCos - this.sin * this.stepSin;
      this.sin = this.sin * this.stepCos + this.cos * this.stepSin;
      this.cos = nextCos;
      return this.i2 * this.i2 + this.q2 * this.q2;
    }
  }

  class RTTYDecoder {
    constructor(callbacks = {}, options = {}) {
      this.callbacks = callbacks;
      this.codec = new BaudotCodec(options);
      this.enabled = false;
      this.sampleRate = SAMPLE_RATE;
      this.configure(options);
      this.reset(false);
    }

    configure(options = {}) {
      this.baud = clamp(Number(options.baud) || this.baud || DEFAULT_BAUD, 20, 300);
      this.markHz = clamp(Number(options.markHz) || this.markHz || DEFAULT_MARK_HZ, DF_LOW, DF_HIGH - 40);
      this.shiftHz = clamp(Math.abs(Number(options.shiftHz) || this.shiftHz || DEFAULT_SHIFT_HZ), 40, Math.max(40, DF_HIGH - this.markHz));
      this.rxReverse = options.rxReverse === undefined ? Boolean(this.rxReverse) : Boolean(options.rxReverse);
      this.squelchDb = clamp(Number(options.squelchDb) || this.squelchDb || DEFAULT_SQUELCH_DB, 3, 24);
      if (options.unshiftOnSpace !== undefined) this.codec.unshiftOnSpace = options.unshiftOnSpace !== false;
      this.rebuildTrackers();
    }

    rebuildTrackers() {
      this.bitSamples = this.sampleRate / this.baud;
      this.diffAlpha = 1 - Math.exp(-2 * Math.PI * this.baud * 2.2 / this.sampleRate);
      this.powerAlpha = 1 - Math.exp(-2 * Math.PI * 8 / this.sampleRate);
      const bandwidth = clamp(this.baud * 1.85, 70, 240);
      this.markTracker = new ToneTracker(this.markHz, this.sampleRate, bandwidth);
      this.spaceTracker = new ToneTracker(this.markHz + this.shiftHz, this.sampleRate, bandwidth);
      this.diffSmooth = 0;
      this.decisionSmooth = 0;
      this.powerSmooth = 0;
      this.audioPowerSmooth = 0;
      this.currentLogical = 1;
      this.previousLogical = 1;
      this.signalOpen = false;
      this.noiseFloorDb = null;
    }

    reset(clearText = true) {
      this.codec.reset();
      this.framing = null;
      this.sampleCursor = 0;
      this.markRun = 0;
      this.frames = 0;
      this.framingErrors = 0;
      this.lastConfidence = 0;
      this.lastLevelDb = null;
      this.lastToneDominance = 0;
      this.rebuildTrackers();
      if (clearText) this.callbacks.clear?.();
      this.emitStats();
    }

    setEnabled(enabled) {
      const next = Boolean(enabled);
      if (next === this.enabled) return;
      this.enabled = next;
      this.reset(false);
    }

    feed(buffer, sampleRate = SAMPLE_RATE) {
      if (!this.enabled || !(buffer instanceof ArrayBuffer)) return;
      const rate = Number(sampleRate) || SAMPLE_RATE;
      if (Math.abs(rate - this.sampleRate) > 1) {
        this.sampleRate = rate;
        this.reset(false);
      }
      const samples = new Int16Array(buffer);
      for (let i = 0; i < samples.length; i += 1) {
        this.processSample(samples[i] / 32768);
      }
    }

    processSample(sample) {
      const mark = this.markTracker.push(sample);
      const space = this.spaceTracker.push(sample);
      let diff = mark - space;
      if (this.rxReverse) diff = -diff;
      const total = mark + space;
      const normalizedDiff = total > 1e-12 ? diff / total : 0;
      this.diffSmooth += this.diffAlpha * (diff - this.diffSmooth);
      this.decisionSmooth += this.diffAlpha * (normalizedDiff - this.decisionSmooth);
      this.powerSmooth += this.powerAlpha * (total - this.powerSmooth);
      this.audioPowerSmooth += this.powerAlpha * (sample * sample - this.audioPowerSmooth);
      const levelDb = 10 * Math.log10(this.powerSmooth + 1e-12);
      const confidence = Math.abs(this.decisionSmooth);
      const toneDominance = this.audioPowerSmooth > 1e-10 ? this.powerSmooth / this.audioPowerSmooth : 0;
      const signalActive = this.updateSignalGate(levelDb, toneDominance, confidence);
      this.previousLogical = this.currentLogical;
      if (!signalActive && !this.framing) {
        this.currentLogical = 1;
      } else if (this.decisionSmooth > 0.09) {
        this.currentLogical = 1;
      } else if (this.decisionSmooth < -0.09) {
        this.currentLogical = 0;
      }
      const at = this.sampleCursor;

      if (this.framing) {
        this.addFrameSample(at, this.decisionSmooth, confidence, toneDominance, signalActive);
        if (at - this.framing.startAt >= this.bitSamples * 6.85) this.finishFrame();
      } else {
        const hadMark = this.markRun >= this.bitSamples * 0.35;
        if (signalActive && this.previousLogical === 1 && this.currentLogical === 0 && hadMark) this.beginFrame(at);
      }

      if (!this.framing) {
        if (signalActive && this.currentLogical === 1) this.markRun += 1;
        else this.markRun = 0;
      }
      this.lastLevelDb = levelDb;
      this.lastConfidence = confidence;
      this.lastToneDominance = toneDominance;
      this.sampleCursor += 1;
      if ((this.sampleCursor % Math.round(this.sampleRate / 8)) === 0) this.emitStats();
    }

    updateSignalGate(levelDb, toneDominance, confidence) {
      if (!Number.isFinite(levelDb)) return false;
      if (!Number.isFinite(this.noiseFloorDb)) this.noiseFloorDb = levelDb;
      const likelyNoise = !this.signalOpen && !this.framing && (toneDominance < 0.16 || confidence < 0.12);
      let alpha = 0.00008;
      if (levelDb < this.noiseFloorDb) alpha = 0.04;
      else if (likelyNoise) alpha = 0.012;
      this.noiseFloorDb += (levelDb - this.noiseFloorDb) * alpha;
      const aboveFloor = levelDb - this.noiseFloorDb;
      const squelchOpen = aboveFloor >= this.squelchDb && toneDominance >= 0.14 && confidence >= 0.12;
      const absoluteOpen = levelDb > -86 && toneDominance >= 0.50 && confidence >= 0.18;
      const carrierHold = this.signalOpen && levelDb > -86 && toneDominance >= 0.45;
      const holdOpen = carrierHold || (this.signalOpen && aboveFloor >= Math.max(2, this.squelchDb - 5) && toneDominance >= 0.10 && confidence >= 0.08);
      this.signalOpen = squelchOpen || absoluteOpen || holdOpen;
      return this.signalOpen;
    }

    beginFrame(at) {
      this.framing = {
        startAt: at - this.bitSamples * 0.05,
        sums: new Float64Array(7),
        counts: new Uint16Array(7),
        confidenceSum: 0,
        toneDominanceSum: 0,
        activeSamples: 0,
        totalSamples: 0,
      };
      this.markRun = 0;
    }

    addFrameSample(at, decision, confidence, toneDominance, signalActive) {
      const frame = this.framing;
      if (!frame) return;
      const elapsed = at - frame.startAt;
      const bitPosition = elapsed / this.bitSamples;
      const cell = Math.floor(bitPosition);
      const phase = bitPosition - cell;
      if (cell >= 0 && cell < frame.sums.length && phase >= 0.22 && phase <= 0.78) {
        frame.sums[cell] += decision;
        frame.counts[cell] += 1;
      }
      frame.confidenceSum += confidence;
      frame.toneDominanceSum += toneDominance;
      frame.totalSamples += 1;
      if (signalActive) frame.activeSamples += 1;
    }

    finishFrame() {
      const frame = this.framing;
      this.framing = null;
      if (!frame) return;
      const averages = [];
      const minCount = Math.max(12, Math.floor(this.bitSamples * 0.24));
      for (let i = 0; i < frame.sums.length; i += 1) {
        if (frame.counts[i] < minCount) {
          this.framingErrors += 1;
          this.emitStats();
          return;
        }
        averages.push(frame.sums[i] / frame.counts[i]);
      }
      const avgConfidence = frame.totalSamples > 0 ? frame.confidenceSum / frame.totalSamples : 0;
      const avgToneDominance = frame.totalSamples > 0 ? frame.toneDominanceSum / frame.totalSamples : 0;
      const activeRatio = frame.totalSamples > 0 ? frame.activeSamples / frame.totalSamples : 0;
      const startOk = averages[0] < -0.16;
      const stopOk = averages[6] > 0.16;
      const confident = avgConfidence >= 0.18 && avgToneDominance >= 0.12 && activeRatio >= 0.55;
      if (!startOk || !stopOk || !confident) {
        this.framingErrors += 1;
        this.emitStats();
        return;
      }
      let code = 0;
      for (let bit = 0; bit < 5; bit += 1) code |= (averages[bit + 1] > 0 ? 1 : 0) << bit;
      const char = this.codec.decodeCode(code);
      this.frames += 1;
      if (char) this.callbacks.char?.(char, { code, frames: this.frames });
      this.emitStats();
    }

    emitStats() {
      this.callbacks.stats?.({
        frames: this.frames,
        framingErrors: this.framingErrors,
        confidence: this.lastConfidence || 0,
        levelDb: this.lastLevelDb,
        noiseFloorDb: this.noiseFloorDb,
        toneDominance: this.lastToneDominance || 0,
        signalActive: Boolean(this.signalOpen),
        synchronized: Boolean(this.framing),
      });
    }
  }

  function synthesizeRtty(text, options = {}) {
    const encoder = new RTTYEncoder(options);
    return encoder.build(text, options);
  }

  function decodeRttyBufferForOptions(samples, sampleRate, options = {}) {
    let text = "";
    const decoder = new RTTYDecoder({
      char(char) {
        text += char === "\r" ? "" : char;
      },
    }, options);
    decoder.setEnabled(true);
    const buffer = samples instanceof Int16Array
      ? samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
      : samples;
    decoder.feed(buffer, sampleRate);
    return {
      text,
      frames: decoder.frames || 0,
      errors: decoder.framingErrors || 0,
    };
  }

  function decodedTextScore(text, frames = 0, errors = 0) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean || frames < 2) return -1000 + frames - errors * 2;
    const words = clean.split(" ").filter(Boolean);
    const known = (clean.match(/\b(CQ|DE|RY|TEST|599|TU|QRZ|QTH|NAME|K)\b/g) || []).length;
    const callLike = (clean.match(/\b[A-Z0-9]{1,3}[0-9][A-Z0-9/]{1,8}\b/g) || []).length;
    const vowelWords = words.filter((word) => /[AEIOUY]/.test(word) || /^[0-9]+$/.test(word)).length;
    const longRuns = (clean.match(/([A-Z0-9])\1{5,}/g) || []).length;
    const hardClusters = (clean.match(/[BCDFGHJKLMNPQRSTVWXZ]{7,}/g) || []).length;
    const spaceRatio = (clean.match(/ /g) || []).length / Math.max(1, clean.length);
    const wordRatio = words.length ? vowelWords / words.length : 0;
    return frames * 1.4
      - errors * 2.8
      + Math.min(clean.length, 120) * 0.18
      + known * 18
      + callLike * 7
      + words.length * 1.2
      + wordRatio * 10
      + Math.min(spaceRatio, 0.24) * 24
      - longRuns * 9
      - hardClusters * 7;
  }

  function uniqueNumbers(values, precision = 2) {
    const scale = Math.pow(10, precision);
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      const rounded = Math.round(number * scale) / scale;
      const key = String(rounded);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(rounded);
    }
    return result;
  }

  function autoSelectRttyCandidate(samples, sampleRate, baseOptions = {}, tonePairs = []) {
    if (!(samples instanceof Int16Array) || samples.length < Math.max(8000, sampleRate * 1.5)) return null;
    const current = {
      baud: Number(baseOptions.baud) || DEFAULT_BAUD,
      markHz: Number(baseOptions.markHz) || DEFAULT_MARK_HZ,
      shiftHz: Number(baseOptions.shiftHz) || DEFAULT_SHIFT_HZ,
      rxReverse: Boolean(baseOptions.rxReverse),
      unshiftOnSpace: baseOptions.unshiftOnSpace !== false,
      squelchDb: Math.min(Number(baseOptions.squelchDb) || DEFAULT_SQUELCH_DB, 8),
    };
    const bauds = uniqueNumbers([current.baud, 45.45, 45, 50, 75, 100], 2);
    const shifts = uniqueNumbers([current.shiftHz, 170, 200, 425, 850], 0)
      .filter((shift) => shift >= 40 && shift <= 1200);
    const reverses = current.rxReverse ? [true, false] : [false, true];
    const candidates = [];
    for (const shiftHz of shifts) {
      const pairMarks = tonePairs
        .filter((pair) => Math.abs(Number(pair.shiftHz) - shiftHz) < 2)
        .map((pair) => pair.markHz);
      const marks = uniqueNumbers([current.markHz, ...pairMarks], 0)
        .filter((markHz) => markHz >= DF_LOW && markHz + shiftHz <= DF_HIGH);
      for (const markHz of marks) {
        for (const baud of bauds) {
          for (const rxReverse of reverses) {
            const options = { ...current, baud, markHz, shiftHz, rxReverse };
            const decoded = decodeRttyBufferForOptions(samples, sampleRate, options);
            const score = decodedTextScore(decoded.text, decoded.frames, decoded.errors);
            candidates.push({ ...options, ...decoded, score });
          }
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  const elements = {};
  const state = {
    activeBand: "",
    dialHz: NaN,
    radio: null,
    socket: null,
    rxRate: SAMPLE_RATE,
    txRate: SAMPLE_RATE,
    audioReady: false,
    audioReadyMessage: false,
    audioStarting: false,
    digitalStagedTx: false,
    audioChannel: null,
    waiters: [],
    rxEnabled: false,
    configuring: false,
    txBusy: false,
    txAbort: false,
    rxText: "",
    rxLevelDb: null,
    logLines: [],
    decoder: null,
    wfCanvas: null,
    wfCtx: null,
    wfWindow: null,
    wfReal: null,
    wfImag: null,
    wfSpectrumDb: null,
    wfFloorDb: null,
    wfCeilDb: null,
    wfAfcDb: null,
    wfDisplayLow: NaN,
    wfDisplayHigh: NaN,
    wfWriteAccumulator: [],
    recentPcm: null,
    recentSampleRate: SAMPLE_RATE,
    recentWrite: 0,
    recentCount: 0,
    rxAccum: 0,
    rxAccumCount: 0,
    waterfallDragging: false,
  };

  function cacheElements() {
    [
      "rtty-radio-state", "rtty-audio-state", "rtty-rx-state", "rtty-tx-state",
      "rtty-clock-state", "rtty-waterfall", "rtty-waterfall-hitbox",
      "rtty-waterfall-range", "rtty-axis-top", "rtty-mark-cursor", "rtty-space-cursor", "rtty-tone-label", "rtty-auto-mark",
      "rtty-auto-rx", "rtty-utc",
      "rtty-rx-dial", "rtty-audio-level", "rtty-mark-space", "rtty-baud-readout",
      "rtty-band-buttons", "rtty-band-select", "rtty-dial-mhz", "rtty-tune-dial",
      "rtty-tune-preset", "rtty-enabled", "rtty-radio-mode", "rtty-mark",
      "rtty-shift", "rtty-baud", "rtty-rx-reverse", "rtty-tx-reverse",
      "rtty-unshift-space", "rtty-squelch", "rtty-tx-level", "rtty-radio-config-state",
      "rtty-clear-rx", "rtty-rx-text", "rtty-decoder-state", "rtty-framing",
      "rtty-signal", "rtty-my-call", "rtty-preset", "rtty-message",
      "rtty-send", "rtty-send-cq", "rtty-send-ry", "rtty-halt", "rtty-last-tx",
      "rtty-tx-detail", "rtty-tx-duration", "rtty-staged-bytes", "rtty-log",
      "toast",
    ].forEach((id) => {
      elements[id] = byId(id);
    });
  }

  function modemOptions() {
    const markHz = clamp(Number(elements["rtty-mark"]?.value) || DEFAULT_MARK_HZ, DF_LOW, DF_HIGH - 40);
    const maxShift = Math.max(40, DF_HIGH - markHz);
    const shiftHz = clamp(Math.abs(Number(elements["rtty-shift"]?.value) || DEFAULT_SHIFT_HZ), 40, maxShift);
    const baud = clamp(Number(elements["rtty-baud"]?.value) || DEFAULT_BAUD, 20, 300);
    const squelchDb = clamp(Number(elements["rtty-squelch"]?.value) || DEFAULT_SQUELCH_DB, 3, 24);
    const levelDbfs = clamp(Number(elements["rtty-tx-level"]?.value) || DEFAULT_TX_LEVEL_DBFS, -40, -12);
    return {
      markHz,
      shiftHz,
      baud,
      squelchDb,
      levelDbfs,
      rxReverse: Boolean(elements["rtty-rx-reverse"]?.checked),
      txReverse: Boolean(elements["rtty-tx-reverse"]?.checked),
      unshiftOnSpace: elements["rtty-unshift-space"]?.checked !== false,
    };
  }

  function selectedRadioMode() {
    const mode = String(elements["rtty-radio-mode"]?.value || DEFAULT_RADIO_MODE).toUpperCase();
    return mode === "RTTY-L" || mode === "DATA-U" || mode === "RTTY-U" ? mode : DEFAULT_RADIO_MODE;
  }

  function selectedRadioModeForValue(value) {
    const mode = String(value || "").toUpperCase();
    return mode === "RTTY-L" || mode === "DATA-U" || mode === "RTTY-U" ? mode : DEFAULT_RADIO_MODE;
  }

  function saveModemSettings() {
    if (typeof localStorage === "undefined") return;
    const options = modemOptions();
    try {
      localStorage.setItem("freerig710-rtty-mark-hz-v1", String(options.markHz));
      localStorage.setItem("freerig710-rtty-shift-hz-v1", String(options.shiftHz));
      localStorage.setItem("freerig710-rtty-baud-v1", String(options.baud));
      localStorage.setItem("freerig710-rtty-squelch-db-v1", String(options.squelchDb));
      localStorage.setItem("freerig710-rtty-rx-reverse-v1", options.rxReverse ? "1" : "0");
      localStorage.setItem("freerig710-rtty-tx-reverse-v1", options.txReverse ? "1" : "0");
      localStorage.setItem("freerig710-rtty-unshift-space-v1", options.unshiftOnSpace ? "1" : "0");
      localStorage.setItem("freerig710-rtty-tx-level-v1", String(options.levelDbfs));
      localStorage.setItem(RADIO_MODE_STORAGE_KEY, selectedRadioMode());
      localStorage.removeItem("freerig710-rtty-radio-mode-v1");
    } catch {
      // localStorage is optional.
    }
  }

  function loadModemSettings() {
    if (typeof localStorage === "undefined") return;
    try {
      const mark = Number(localStorage.getItem("freerig710-rtty-mark-hz-v1"));
      const shift = Number(localStorage.getItem("freerig710-rtty-shift-hz-v1"));
      const baud = Number(localStorage.getItem("freerig710-rtty-baud-v1"));
      const squelch = Number(localStorage.getItem("freerig710-rtty-squelch-db-v1"));
      const level = Number(localStorage.getItem("freerig710-rtty-tx-level-v1"));
      const radioMode = String(localStorage.getItem(RADIO_MODE_STORAGE_KEY) || "").toUpperCase();
      if (radioMode && elements["rtty-radio-mode"]) elements["rtty-radio-mode"].value = selectedRadioModeForValue(radioMode);
      if (Number.isFinite(mark) && elements["rtty-mark"]) elements["rtty-mark"].value = String(clamp(mark, DF_LOW, DF_HIGH - 40));
      if (Number.isFinite(shift) && elements["rtty-shift"]) elements["rtty-shift"].value = String(clamp(shift, 40, 1200));
      if (Number.isFinite(baud) && elements["rtty-baud"]) elements["rtty-baud"].value = String(baud);
      if (Number.isFinite(squelch) && elements["rtty-squelch"]) elements["rtty-squelch"].value = String(clamp(squelch, 3, 24));
      if (Number.isFinite(level) && elements["rtty-tx-level"]) elements["rtty-tx-level"].value = String(clamp(level, -40, -12));
      const rxReverse = localStorage.getItem("freerig710-rtty-rx-reverse-v1");
      const txReverse = localStorage.getItem("freerig710-rtty-tx-reverse-v1");
      const unshift = localStorage.getItem("freerig710-rtty-unshift-space-v1");
      if (rxReverse !== null && elements["rtty-rx-reverse"]) elements["rtty-rx-reverse"].checked = rxReverse === "1";
      if (txReverse !== null && elements["rtty-tx-reverse"]) elements["rtty-tx-reverse"].checked = txReverse === "1";
      if (unshift !== null && elements["rtty-unshift-space"]) elements["rtty-unshift-space"].checked = unshift === "1";
    } catch {
      // localStorage is optional.
    }
  }

  function applySharedStationSettings() {
    const call = sanitizeCall(sharedStationSettings().call || "");
    if (elements["rtty-my-call"]) elements["rtty-my-call"].value = call;
    const message = elements["rtty-message"];
    if (message && !message.value.trim() && call) message.placeholder = `CQ CQ CQ DE ${call} ${call} K`;
  }

  function updateToneUi() {
    const options = modemOptions();
    const range = waterfallRangeForOptions(options);
    const low = Math.round(range.low);
    const high = Math.round(range.high);
    const rangeChanged = state.wfDisplayLow !== low || state.wfDisplayHigh !== high;
    state.wfDisplayLow = low;
    state.wfDisplayHigh = high;
    if (elements["rtty-mark"]) elements["rtty-mark"].value = String(Math.round(options.markHz));
    if (elements["rtty-shift"]) elements["rtty-shift"].value = String(Math.round(options.shiftHz));
    if (elements["rtty-baud"]) elements["rtty-baud"].value = String(options.baud);
    if (elements["rtty-squelch"]) elements["rtty-squelch"].value = String(Math.round(options.squelchDb));
    if (elements["rtty-tx-level"]) elements["rtty-tx-level"].value = String(Math.round(options.levelDbfs));
    if (elements["rtty-tone-label"]) elements["rtty-tone-label"].textContent = `Mark ${Math.round(options.markHz)} Hz - Space ${Math.round(options.markHz + options.shiftHz)} Hz`;
    if (elements["rtty-mark-space"]) elements["rtty-mark-space"].textContent = `${Math.round(options.markHz)}/${Math.round(options.markHz + options.shiftHz)}`;
    if (elements["rtty-baud-readout"]) elements["rtty-baud-readout"].textContent = String(options.baud);
    renderWaterfallAxis(range);
    const markLeft = (options.markHz - range.low) * 100 / range.span;
    const spaceLeft = (options.markHz + options.shiftHz - range.low) * 100 / range.span;
    if (elements["rtty-mark-cursor"]) elements["rtty-mark-cursor"].style.left = `${clamp(markLeft, 0, 100)}%`;
    if (elements["rtty-space-cursor"]) elements["rtty-space-cursor"].style.left = `${clamp(spaceLeft, 0, 100)}%`;
    if (rangeChanged && state.wfCtx) buildWaterfall();
    if (state.decoder) state.decoder.configure(options);
  }

  function setRxUi() {
    if (elements["rtty-enabled"]) elements["rtty-enabled"].checked = state.rxEnabled;
    updatePill(elements["rtty-rx-state"], state.rxEnabled ? "RX ON" : "RX OFF", state.rxEnabled ? "is-ok" : "is-idle");
    if (elements["rtty-decoder-state"]) elements["rtty-decoder-state"].textContent = state.rxEnabled ? "listening" : "idle";
    state.decoder?.setEnabled(state.rxEnabled);
  }

  function log(line, level = "info") {
    state.logLines.unshift({ utc: formatUtc(), line, level });
    state.logLines = state.logLines.slice(0, 160);
    if (!elements["rtty-log"]) return;
    elements["rtty-log"].innerHTML = state.logLines
      .map((entry) => `<div class="rtty-log-line is-${entry.level}"><span>${entry.utc}</span>${escapeHtml(entry.line)}</div>`)
      .join("");
  }

  function showToast(message, isError = false) {
    const toast = elements.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle("error", Boolean(isError));
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function appendTerminalText(text) {
    state.rxText += text;
    if (state.rxText.length > 24000) state.rxText = state.rxText.slice(-22000);
    if (elements["rtty-rx-text"]) {
      elements["rtty-rx-text"].textContent = state.rxText;
      elements["rtty-rx-text"].scrollTop = elements["rtty-rx-text"].scrollHeight;
    }
  }

  function clearRxText() {
    state.rxText = "";
    if (elements["rtty-rx-text"]) elements["rtty-rx-text"].textContent = "";
    state.decoder?.reset(false);
    log("RTTY RX text cleared");
  }

  function onDecoderStats(stats) {
    if (elements["rtty-framing"]) elements["rtty-framing"].textContent = `${stats.framingErrors || 0} errors`;
    const conf = Math.round((stats.confidence || 0) * 100);
    const level = Number.isFinite(stats.levelDb) ? `${Math.round(stats.levelDb)} dB` : "--";
    const floor = Number.isFinite(stats.noiseFloorDb) ? ` floor ${Math.round(stats.noiseFloorDb)}` : "";
    const gate = stats.signalActive ? "open" : "closed";
    if (elements["rtty-signal"]) elements["rtty-signal"].textContent = `${gate} ${level} ${conf}%${floor}`;
  }

  function populateBandControls() {
    const buttons = elements["rtty-band-buttons"];
    const select = elements["rtty-band-select"];
    if (buttons) {
      buttons.innerHTML = RTTY_BANDS.map((band) =>
        `<button type="button" data-band="${band.label}" class="${band.label === state.activeBand ? "is-active" : ""}">${band.label.replace("m", "")}</button>`
      ).join("");
      buttons.addEventListener("click", (event) => {
        const button = event.target.closest("[data-band]");
        if (button) void selectBand(button.dataset.band);
      });
    }
    if (select) {
      select.innerHTML = `<option value="">Select band...</option>` + RTTY_BANDS.map(
        (band) => `<option value="${band.label}">${band.label} - ${(band.hz / 1000000).toFixed(6)} MHz</option>`
      ).join("");
      select.value = state.activeBand;
      select.addEventListener("change", () => void selectBand(select.value));
    }
  }

  async function selectBand(label) {
    const band = RTTY_BANDS.find((item) => item.label === label);
    if (!band) return;
    state.activeBand = band.label;
    if (elements["rtty-band-select"]) elements["rtty-band-select"].value = band.label;
    document.querySelectorAll(".rtty-band-button-row [data-band]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.band === band.label);
    });
    updateFrequencyUi();
    await configureRadioForRtty();
  }

  function updateFrequencyUi() {
    if (elements["rtty-rx-dial"]) elements["rtty-rx-dial"].textContent = formatKHz(state.dialHz);
    if (elements["rtty-dial-mhz"] && document.activeElement !== elements["rtty-dial-mhz"]) {
      elements["rtty-dial-mhz"].value = formatMHzInput(state.dialHz);
    }
  }

  function waterfallRangeForOptions(options = modemOptions()) {
    const span = Math.min(RTTY_WATERFALL_SPAN_HZ, DF_HIGH - DF_LOW);
    const center = Number(options.markHz) + Number(options.shiftHz) / 2;
    const low = clamp(Math.round((center - span / 2) / 5) * 5, DF_LOW, DF_HIGH - span);
    return { low, high: low + span, span };
  }

  function currentWaterfallRange() {
    const low = Number(state.wfDisplayLow);
    const high = Number(state.wfDisplayHigh);
    if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
      return { low, high, span: high - low };
    }
    return waterfallRangeForOptions();
  }

  function renderWaterfallAxis(range) {
    const title = elements["rtty-waterfall-range"];
    const axis = elements["rtty-axis-top"];
    const low = Math.round(range.low);
    const high = Math.round(range.high);
    if (title) title.textContent = `Waterfall ${range.span} Hz - ${low}-${high}`;
    if (elements["rtty-waterfall"]) {
      elements["rtty-waterfall"].setAttribute("aria-label", `RTTY waterfall from ${low} to ${high} Hz`);
    }
    if (!axis) return;
    const ticks = range.span >= 2000 ? 7 : 5;
    axis.innerHTML = Array.from({ length: ticks + 1 }, (_, index) => {
      const left = index * 100 / ticks;
      const hz = Math.round(range.low + range.span * index / ticks);
      return `<span style="--rtty-axis-left:${left}%">${hz}${index === ticks ? " Hz" : ""}</span>`;
    }).join("");
  }

  async function configureRadioForRtty(options = {}) {
    const band = RTTY_BANDS.find((item) => item.label === state.activeBand);
    if (!band || state.configuring) return;
    state.configuring = true;
    const mode = selectedRadioMode();
    const tuneHz = Number(options.tuneHz);
    const shouldTune = Number.isFinite(tuneHz) && tuneHz > 0;
    updatePill(elements["rtty-radio-config-state"], "Configuring", "is-warn");
    try {
      const radioState = await api("/api/v1/state");
      state.radio = radioState || state.radio;
      if (radioState?.radio_power !== "ON") throw new Error("Radio must be ON before selecting an RTTY band");
      await post("/api/v1/radio/vfo/split", { mode: "OFF" });
      await post("/api/v1/radio/vfo/select", { vfo: "A" });
      await post("/api/v1/radio/mode", { mode, vfo: "A" });
      await post("/api/v1/radio/mode", { mode, vfo: "B" }).catch(() => null);
      if (shouldTune) {
        await post("/api/v1/radio/frequency", { frequency_hz: Math.round(tuneHz), vfo: "A" });
        state.dialHz = Math.round(tuneHz);
        updateFrequencyUi();
      }
      await post("/api/v1/radio/vfo/select", { vfo: "A" });
      await post("/api/v1/radio/vfo/split", { mode: "OFF" });
      await post("/api/v1/radio/rf-sql-vr", { value: "RF" }).catch(() => null);
      await post("/api/v1/radio/dnr", { enabled: false }).catch(() => null);
      await post("/api/v1/radio/noise-blanker", { enabled: false }).catch(() => null);
      await post("/api/v1/radio/auto-notch", { enabled: false }).catch(() => null);
      await post("/api/v1/radio/filter", {
        width_code: RTTY_FILTER_WIDTH_CODE,
        shift_hz: 0,
        manual_notch_enabled: false,
        contour_enabled: false,
      }).catch(() => null);
      await ensureAudio();
      state.rxEnabled = true;
      setRxUi();
      updatePill(elements["rtty-radio-config-state"], shouldTune ? `${mode} ${formatKHz(tuneHz)} kHz` : `${mode} ${band.label} ready`, "is-ok");
      log(`Radio set for RTTY ${band.label}: ${mode} simplex${shouldTune ? `, VFO A ${formatFrequencyDigits(tuneHz)} Hz` : ", dial unchanged"}`);
    } catch (error) {
      updatePill(elements["rtty-radio-config-state"], "Radio failed", "is-bad");
      log(`Radio configuration failed: ${error.message}`, "bad");
      showToast(error.message, true);
    } finally {
      state.configuring = false;
    }
  }

  async function pollRadioState() {
    try {
      const status = await api("/api/v1/state");
      state.radio = status;
      const mode = status?.mode || status?.operating_mode || "--";
      const freq = Number(status?.vfo_a_hz || status?.frequency_hz || status?.active_vfo_hz);
      if (Number.isFinite(freq)) {
        state.dialHz = freq;
        updateFrequencyUi();
      }
      updatePill(elements["rtty-radio-state"], Number.isFinite(freq) ? `${formatKHz(freq)} kHz ${mode}` : mode, "is-ok");
    } catch {
      state.radio = null;
      updatePill(elements["rtty-radio-state"], "Radio offline", "is-warn");
    }
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
    state.audioChannel?.postMessage({ type: "claim", owner: OWNER_ID, tool: "RTTY" });
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
    updatePill(elements["rtty-audio-state"], "Audio connecting", "is-warn");
    try {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(websocketUrl("/api/v1/audio/ws"));
        state.socket = socket;
        socket.binaryType = "arraybuffer";
        const timeout = setTimeout(() => reject(new Error("audio websocket timeout")), 8000);
        socket.onopen = () => log("FreeRig audio WebSocket connected for RTTY");
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("audio websocket error"));
        };
        socket.onclose = () => {
          clearTimeout(timeout);
          state.audioReady = false;
          state.audioReadyMessage = false;
          state.digitalStagedTx = false;
          state.socket = null;
          rejectWaiters("audio websocket closed");
          updatePill(elements["rtty-audio-state"], "Audio closed", "is-idle");
        };
        socket.onmessage = (event) => {
          const message = handleAudioMessage(event.data);
          if (message?.type === "ready") {
            clearTimeout(timeout);
            resolve();
          }
        };
      });
    } catch (error) {
      state.audioReady = false;
      state.audioReadyMessage = false;
      state.digitalStagedTx = false;
      updatePill(elements["rtty-audio-state"], "Audio failed", "is-bad");
      log(`Audio start failed: ${error.message}`, "bad");
      throw error;
    } finally {
      state.audioStarting = false;
    }
  }

  function closeAudio(updateStatus = true) {
    if (state.socket) {
      try { state.socket.close(); } catch {}
    }
    state.socket = null;
    state.audioReady = false;
    state.audioReadyMessage = false;
    state.digitalStagedTx = false;
    rejectWaiters("audio websocket closed");
    if (updateStatus) updatePill(elements["rtty-audio-state"], "Audio closed", "is-idle");
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
      state.rxRate = Number(message.sample_rate || state.rxRate || SAMPLE_RATE);
      state.txRate = Number(message.tx_sample_rate || state.txRate || SAMPLE_RATE);
      state.digitalStagedTx = Boolean(message.digital_staged_tx);
      state.audioReady = true;
      state.audioReadyMessage = true;
      updatePill(elements["rtty-audio-state"], `Audio ${state.rxRate} Hz`, "is-ok");
    } else if (message.type === "digital_tx_state") {
      updatePill(elements["rtty-tx-state"], String(message.state || "TX"), "is-bad");
    } else if (message.type === "digital_waveform_error" || (message.type === "digital_tx_play" && message.ok === false) || message.type === "tx_abort") {
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

  function rejectWaiters(reason) {
    while (state.waiters.length) {
      const waiter = state.waiters.pop();
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
  }

  function handlePcm(buffer) {
    const samples = new Int16Array(buffer);
    if (!samples.length) return;
    rememberRecentPcm(samples);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const abs = Math.abs(samples[i] / 32768);
      if (abs > peak) peak = abs;
    }
    if (peak > 0) state.rxLevelDb = 20 * Math.log10(peak);
    if (elements["rtty-audio-level"]) {
      elements["rtty-audio-level"].textContent = state.rxLevelDb === null ? "-- dBFS" : `${Math.round(state.rxLevelDb)} dBFS`;
    }
    if (state.rxEnabled && !state.txBusy) state.decoder?.feed(buffer, state.rxRate);
    pushWaterfallFromPcm(samples);
  }

  function ensureRecentPcmBuffer(sampleRate = state.rxRate || SAMPLE_RATE) {
    const rate = Math.max(8000, Math.round(Number(sampleRate) || SAMPLE_RATE));
    const capacity = rate * RECENT_AUDIO_SECONDS;
    if (state.recentPcm && state.recentPcm.length === capacity && state.recentSampleRate === rate) return;
    state.recentPcm = new Int16Array(capacity);
    state.recentSampleRate = rate;
    state.recentWrite = 0;
    state.recentCount = 0;
  }

  function rememberRecentPcm(samples) {
    if (!(samples instanceof Int16Array) || !samples.length) return;
    ensureRecentPcmBuffer(state.rxRate || SAMPLE_RATE);
    const buffer = state.recentPcm;
    if (!buffer?.length) return;
    for (let i = 0; i < samples.length; i += 1) {
      buffer[state.recentWrite] = samples[i];
      state.recentWrite = (state.recentWrite + 1) % buffer.length;
      if (state.recentCount < buffer.length) state.recentCount += 1;
    }
  }

  function recentPcmSnapshot(maxSeconds = AUTO_RX_ANALYSIS_SECONDS) {
    const buffer = state.recentPcm;
    const rate = state.recentSampleRate || SAMPLE_RATE;
    const count = Math.min(state.recentCount, Math.max(1, Math.round(rate * maxSeconds)));
    if (!buffer || count < Math.max(8000, Math.round((state.recentSampleRate || SAMPLE_RATE) * 1.5))) return null;
    const out = new Int16Array(count);
    const start = (state.recentWrite - count + buffer.length) % buffer.length;
    const first = Math.min(count, buffer.length - start);
    out.set(buffer.subarray(start, start + first), 0);
    if (first < count) out.set(buffer.subarray(0, count - first), first);
    return out;
  }

  async function tuneRttyDial(frequencyHz) {
    const hz = Math.round(Number(frequencyHz));
    if (!Number.isFinite(hz) || hz <= 0) {
      showToast("Invalid RTTY dial frequency", true);
      return;
    }
    if (!state.activeBand) {
      showToast("Select an RTTY band before tuning", true);
      return;
    }
    await configureRadioForRtty({ tuneHz: hz });
  }

  function tuneRttyDialInput() {
    const hz = parseDialMHz(elements["rtty-dial-mhz"]?.value);
    void tuneRttyDial(hz);
  }

  function tuneRttyBandPreset() {
    const band = RTTY_BANDS.find((item) => item.label === state.activeBand);
    if (!band) {
      showToast("Select an RTTY band first", true);
      return;
    }
    if (elements["rtty-dial-mhz"]) elements["rtty-dial-mhz"].value = formatMHzInput(band.hz);
    void tuneRttyDial(band.hz);
  }

  function pushWaterfallFromPcm(samples) {
    if (!state.wfCtx || !state.wfCanvas) return;
    const ratio = (state.rxRate || SAMPLE_RATE) / RX_WF_RATE;
    if (Number.isInteger(ratio) && ratio >= 1) {
      let accum = state.rxAccum;
      let count = state.rxAccumCount;
      const down = [];
      for (let i = 0; i < samples.length; i += 1) {
        accum += samples[i] / 32768;
        count += 1;
        if (count >= ratio) {
          down.push(accum / count);
          accum = 0;
          count = 0;
        }
      }
      state.rxAccum = accum;
      state.rxAccumCount = count;
      if (down.length) pushWaterfallSamples(down);
      return;
    }
    pushWaterfallSamples(Array.from(samples, (sample) => sample / 32768));
  }

  function nextDigitalWaveformId() {
    const id = ((Date.now() & 0xfffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    return id || 1;
  }

  async function stageDigitalPcm(pcm, label = "RTTY") {
    await ensureAudio();
    if (!state.digitalStagedTx) throw new Error("ESP32 firmware does not advertise staged digital TX");
    if (!(pcm instanceof Int16Array) || pcm.length === 0) throw new Error("No RTTY PCM audio to stage");
    if (pcm.byteLength > MAX_STAGED_BYTES) throw new Error("RTTY message exceeds staged TX buffer");
    const id = nextDigitalWaveformId();
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const beginWait = waitForAudio("digital_waveform_begin", (message) => Number(message.id) === id || message.ok === false, 5000);
    sendAudioControl({ type: "digital_waveform_begin", id, bytes: bytes.byteLength, sample_rate: SAMPLE_RATE, label });
    const begin = await beginWait;
    if (begin.ok === false) throw new Error(begin.error || "staged digital upload rejected");
    const uploadTimeoutMs = Math.max(15000, Math.min(90000, 8000 + Math.ceil(bytes.byteLength / 160000) * 1000));
    const readyWait = waitForAudio("digital_waveform_ready", (message) => Number(message.id) === id, uploadTimeoutMs);
    const errorWait = waitForAudio("digital_waveform_error", () => true, uploadTimeoutMs).then(
      (message) => Promise.reject(new Error(message.error || "staged digital upload failed")),
      () => new Promise(() => {})
    );
    const chunkBytes = 16000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      if (state.txAbort) throw new Error("RTTY TX halted");
      while (state.socket && state.socket.bufferedAmount > 65536) {
        if (state.txAbort) throw new Error("RTTY TX halted");
        await sleep(2);
      }
      const end = Math.min(offset + chunkBytes, bytes.byteLength);
      state.socket.send(bytes.subarray(offset, end));
      if (elements["rtty-staged-bytes"]) {
        const percent = Math.round(end * 100 / Math.max(1, bytes.byteLength));
        elements["rtty-staged-bytes"].textContent = `${percent}%`;
      }
    }
    const ready = await Promise.race([readyWait, errorWait]);
    if (Number(ready?.bytes) !== bytes.byteLength) throw new Error("ESP32 staged waveform ACK mismatch");
    return { id, bytes: bytes.byteLength };
  }

  async function playStagedDigitalPcm(staged, sampleCount, label = "RTTY") {
    const durationMs = Math.ceil(sampleCount * 1000 / SAMPLE_RATE);
    const pttDelayMs = 350;
    const tailMs = 280;
    const leaseMs = durationMs + pttDelayMs + tailMs + 4000;
    const completeWait = waitForAudio("digital_tx_complete", (message) => Number(message.id) === Number(staged.id), leaseMs + 5000);
    const playWait = waitForAudio("digital_tx_play", (message) => Number(message.id) === Number(staged.id), 3000);
    sendAudioControl({ type: "digital_tx_play", id: staged.id, label, ptt_delay_ms: pttDelayMs, tail_ms: tailMs, lease_ms: leaseMs });
    const play = await playWait;
    if (play.ok === false) throw new Error(play.error || "staged digital TX rejected");
    const complete = await completeWait;
    if (complete.ok === false) throw new Error(complete.reason || "staged digital TX failed");
    return complete;
  }

  function normalizeTxText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .toUpperCase()
      .replace(/[^\n A-Z0-9.,?'!/():;+$&#"-]/g, "")
      .trim();
  }

  function txDurationLabel(samples) {
    const total = Math.max(0, samples / SAMPLE_RATE);
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return minutes > 0 ? `${minutes}:${seconds.toFixed(1).padStart(4, "0")}` : `${seconds.toFixed(1)} s`;
  }

  async function transmitRtty(text) {
    if (state.txBusy) return;
    const clean = normalizeTxText(text);
    if (!clean) {
      showToast("RTTY message is empty", true);
      return;
    }
    if (!state.activeBand) {
      showToast("Select an RTTY band before TX", true);
      return;
    }
    const radioMode = selectedRadioMode();
    if (radioMode !== "DATA-U") {
      const message = "RTTY TX uses AFSK audio: select DATA-U for transmit. RTTY-U/RTTY-L need native FSK keying.";
      showToast(message, true);
      log(message, "warn");
      return;
    }
    state.txBusy = true;
    state.txAbort = false;
    const resumeRx = state.rxEnabled;
    state.rxEnabled = false;
    setRxUi();
    setTxButtons();
    updatePill(elements["rtty-tx-state"], "TX STAGING", "is-warn");
    if (elements["rtty-tx-detail"]) elements["rtty-tx-detail"].textContent = "encoding";
    let staged = null;
    let completed = false;
    try {
      while (state.configuring) await sleep(80);
      await ensureAudio();
      const options = modemOptions();
      const pcm = synthesizeRtty(clean, {
        ...options,
        preMs: 420,
        postMs: 520,
      });
      if (pcm.byteLength > MAX_STAGED_BYTES) throw new Error("RTTY message exceeds staged TX buffer");
      if (elements["rtty-tx-duration"]) elements["rtty-tx-duration"].textContent = txDurationLabel(pcm.length);
      if (elements["rtty-tx-detail"]) elements["rtty-tx-detail"].textContent = `uploading ${Math.round(options.baud)} baud`;
      staged = await stageDigitalPcm(pcm, `RTTY ${Math.round(options.baud)} baud`);
      if (state.txAbort) throw new Error("RTTY TX halted");
      if (elements["rtty-staged-bytes"]) elements["rtty-staged-bytes"].textContent = `${Math.round(staged.bytes / 1024)} KiB`;
      if (elements["rtty-last-tx"]) elements["rtty-last-tx"].textContent = `${formatUtc()} - ${clean.slice(0, 48)}`;
      appendTerminalText(`\n[TX ${formatUtc()}] ${clean}\n`);
      updatePill(elements["rtty-tx-state"], "TX ON AIR", "is-bad");
      if (elements["rtty-tx-detail"]) elements["rtty-tx-detail"].textContent = "on air";
      await playStagedDigitalPcm(staged, pcm.length, `RTTY ${Math.round(options.baud)} baud`);
      completed = true;
      updatePill(elements["rtty-tx-state"], "TX COMPLETE", "is-ok");
      if (elements["rtty-tx-detail"]) elements["rtty-tx-detail"].textContent = "complete";
      log(`RTTY TX complete: ${clean.slice(0, 80)}`);
    } catch (error) {
      if (staged && !completed) {
        try { sendAudioControl({ type: "digital_tx_stop" }); } catch {}
      }
      updatePill(elements["rtty-tx-state"], state.txAbort ? "TX HALTED" : "TX FAILED", state.txAbort ? "is-warn" : "is-bad");
      if (elements["rtty-tx-detail"]) elements["rtty-tx-detail"].textContent = state.txAbort ? "halted" : error.message;
      log(`RTTY TX failed: ${error.message}`, "bad");
      if (!state.txAbort) showToast(error.message, true);
    } finally {
      state.txBusy = false;
      state.txAbort = false;
      state.rxEnabled = resumeRx;
      setRxUi();
      setTxButtons();
      window.setTimeout(() => {
        if (!state.txBusy) updatePill(elements["rtty-tx-state"], "TX IDLE", "is-idle");
      }, 1800);
    }
  }

  function haltTransmit() {
    if (!state.txBusy) return;
    state.txAbort = true;
    try { sendAudioControl({ type: "digital_tx_stop" }); } catch {}
    if (elements["rtty-halt"]) elements["rtty-halt"].disabled = true;
    log("RTTY transmit halted", "warn");
  }

  function applyPreset(kind) {
    const call = sanitizeCall(sharedStationSettings().call || elements["rtty-my-call"]?.value || "MYCALL") || "MYCALL";
    let text = "";
    if (kind === "cq") text = `CQ CQ CQ DE ${call} ${call} K`;
    else if (kind === "de") text = `DE ${call} ${call} K`;
    else if (kind === "ry") text = `RYRYRYRYRY RYRYRYRYRY DE ${call} ${call}`;
    else if (kind === "599") text = "599 599 TU";
    if (elements["rtty-message"]) elements["rtty-message"].value = text;
  }

  function setTxButtons() {
    const busy = state.txBusy;
    if (elements["rtty-send"]) elements["rtty-send"].disabled = busy;
    if (elements["rtty-send-cq"]) elements["rtty-send-cq"].disabled = busy;
    if (elements["rtty-send-ry"]) elements["rtty-send-ry"].disabled = busy;
    if (elements["rtty-halt"]) elements["rtty-halt"].disabled = !busy;
  }

  function buildWaterfall() {
    const canvas = elements["rtty-waterfall"];
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    state.wfCanvas = canvas;
    state.wfCtx = canvas.getContext("2d");
    state.wfWindow = null;
    state.wfReal = null;
    state.wfImag = null;
    state.wfSpectrumDb = null;
    state.wfFloorDb = null;
    state.wfCeilDb = null;
    state.wfAfcDb = null;
    state.wfWriteAccumulator = [];
    state.wfCtx.fillStyle = "#071016";
    state.wfCtx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function pushWaterfallSamples(samples) {
    if (!state.wfCtx || !state.wfCanvas) return;
    state.wfWriteAccumulator.push(...samples);
    while (state.wfWriteAccumulator.length >= WATERFALL_FFT_SIZE) {
      const chunk = state.wfWriteAccumulator.splice(0, WATERFALL_FFT_SIZE);
      drawWaterfallLine(chunk);
    }
  }

  function ensureWaterfallFft() {
    if (state.wfWindow?.length === WATERFALL_FFT_SIZE && state.wfAfcDb?.length === WATERFALL_FFT_SIZE / 2) return;
    state.wfWindow = new Float32Array(WATERFALL_FFT_SIZE);
    state.wfReal = new Float32Array(WATERFALL_FFT_SIZE);
    state.wfImag = new Float32Array(WATERFALL_FFT_SIZE);
    state.wfSpectrumDb = new Float32Array(WATERFALL_FFT_SIZE / 2);
    state.wfAfcDb = new Float32Array(WATERFALL_FFT_SIZE / 2);
    state.wfAfcDb.fill(-120);
    for (let i = 0; i < WATERFALL_FFT_SIZE; i += 1) {
      state.wfWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WATERFALL_FFT_SIZE - 1));
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
      const angle = -2 * Math.PI / len;
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
    if (!ctx || !canvas) return;
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
      const db = 20 * Math.log10(mag + 1e-12);
      state.wfSpectrumDb[i] = db;
      if (state.wfAfcDb) state.wfAfcDb[i] = Math.max(db, state.wfAfcDb[i] - 0.35);
    }
    const width = canvas.width;
    const height = canvas.height;
    const range = currentWaterfallRange();
    const image = ctx.getImageData(0, 0, width, Math.max(1, height - 1));
    ctx.putImageData(image, 0, 1);
    const row = ctx.createImageData(width, 1);
    const rowDb = new Float32Array(width);
    for (let x = 0; x < width; x += 1) {
      const freq = range.low + x * range.span / Math.max(1, width - 1);
      const bin = freq * WATERFALL_FFT_SIZE / RX_WF_RATE;
      const lower = clamp(Math.floor(bin), 0, state.wfSpectrumDb.length - 2);
      const frac = bin - lower;
      rowDb[x] = state.wfSpectrumDb[lower] * (1 - frac) + state.wfSpectrumDb[lower + 1] * frac;
    }
    const targetFloor = sampledPercentile(rowDb, 0.48) - 2;
    let targetCeil = sampledPercentile(rowDb, 0.985) + 5;
    if (targetCeil - targetFloor < 18) targetCeil = targetFloor + 18;
    state.wfFloorDb = state.wfFloorDb === null ? targetFloor : state.wfFloorDb * 0.86 + targetFloor * 0.14;
    state.wfCeilDb = state.wfCeilDb === null ? targetCeil : state.wfCeilDb * 0.8 + targetCeil * 0.2;
    const contrastRange = Math.max(12, state.wfCeilDb - state.wfFloorDb);
    for (let x = 0; x < width; x += 1) {
      const hot = clamp((rowDb[x] - state.wfFloorDb) / contrastRange, 0, 1);
      const [r, g, b] = waterfallColor(hot);
      const idx = x * 4;
      row.data[idx] = r;
      row.data[idx + 1] = g;
      row.data[idx + 2] = b;
      row.data[idx + 3] = 255;
    }
    ctx.putImageData(row, 0, 0);
  }

  function spectrumDbAt(frequencyHz, spectrum = state.wfAfcDb || state.wfSpectrumDb) {
    if (!spectrum?.length) return NaN;
    const bin = Number(frequencyHz) * WATERFALL_FFT_SIZE / RX_WF_RATE;
    const lower = clamp(Math.floor(bin), 1, spectrum.length - 2);
    const frac = clamp(bin - lower, 0, 1);
    return spectrum[lower] * (1 - frac) + spectrum[lower + 1] * frac;
  }

  function waterfallBandFloorDb(spectrum = state.wfAfcDb || state.wfSpectrumDb) {
    if (!spectrum?.length) return NaN;
    const range = currentWaterfallRange();
    const values = [];
    const first = Math.max(1, Math.floor(range.low * WATERFALL_FFT_SIZE / RX_WF_RATE));
    const last = Math.min(spectrum.length - 1, Math.ceil(range.high * WATERFALL_FFT_SIZE / RX_WF_RATE));
    for (let i = first; i <= last; i += 1) values.push(spectrum[i]);
    return sampledPercentile(values, 0.45);
  }

  function findRttyTonePair(shiftHz = modemOptions().shiftHz) {
    const spectrum = state.wfAfcDb || state.wfSpectrumDb;
    const shift = clamp(Number(shiftHz) || DEFAULT_SHIFT_HZ, 40, 1200);
    if (!spectrum?.length) return null;
    const floor = waterfallBandFloorDb(spectrum);
    if (!Number.isFinite(floor)) return null;
    const range = currentWaterfallRange();
    let best = null;
    for (let markHz = Math.ceil(range.low / 5) * 5; markHz <= range.high - shift; markHz += 5) {
      const markDb = spectrumDbAt(markHz, spectrum);
      const spaceDb = spectrumDbAt(markHz + shift, spectrum);
      if (!Number.isFinite(markDb) || !Number.isFinite(spaceDb)) continue;
      const low = Math.min(markDb, spaceDb) - floor;
      const high = Math.max(markDb, spaceDb) - floor;
      const score = low * 1.35 + high * 0.45;
      if (!best || score > best.score) {
        best = { markHz, shiftHz: shift, score, floorDb: floor, markDb, spaceDb };
      }
    }
    if (!best || Math.max(best.markDb, best.spaceDb) < floor + 8 || Math.min(best.markDb, best.spaceDb) < floor + 3) return null;
    return best;
  }

  function rttyTonePairsForAutoRx() {
    const options = modemOptions();
    const shifts = uniqueNumbers([options.shiftHz, 170, 200, 425, 850], 0)
      .filter((shift) => shift >= 40 && shift <= 1200);
    const pairs = [];
    for (const shiftHz of shifts) {
      const pair = findRttyTonePair(shiftHz);
      if (pair) pairs.push(pair);
    }
    return pairs;
  }

  function applyModemSettingsChanged(reason = "RTTY modem set") {
    saveModemSettings();
    updateToneUi();
    state.decoder?.reset(false);
    const options = modemOptions();
    log(`${reason}: ${options.baud} baud, mark ${options.markHz} Hz, shift ${options.shiftHz} Hz${options.rxReverse ? ", RX reverse" : ""}`);
  }

  function snapMarkToWaterfall() {
    const pair = findRttyTonePair(modemOptions().shiftHz);
    if (!pair) {
      showToast("No clear RTTY tone pair in the waterfall", true);
      return;
    }
    if (elements["rtty-mark"]) elements["rtty-mark"].value = String(Math.round(pair.markHz));
    applyModemSettingsChanged("RTTY mark snapped");
    showToast(`Mark ${Math.round(pair.markHz)} Hz`);
  }

  function autoConfigureDecoderFromRecentAudio() {
    const samples = recentPcmSnapshot();
    if (!samples) {
      showToast("Need a few seconds of RX audio first", true);
      return;
    }
    const options = modemOptions();
    const pairs = rttyTonePairsForAutoRx();
    const best = autoSelectRttyCandidate(samples, state.recentSampleRate || state.rxRate || SAMPLE_RATE, options, pairs);
    if (!best || best.frames < 4 || best.score < 0) {
      showToast("No stable RTTY decode found", true);
      log("Auto RX did not find a stable RTTY candidate", "warn");
      return;
    }
    if (elements["rtty-mark"]) elements["rtty-mark"].value = String(Math.round(best.markHz));
    if (elements["rtty-shift"]) elements["rtty-shift"].value = String(Math.round(best.shiftHz));
    if (elements["rtty-baud"]) elements["rtty-baud"].value = String(best.baud);
    if (elements["rtty-rx-reverse"]) elements["rtty-rx-reverse"].checked = Boolean(best.rxReverse);
    applyModemSettingsChanged("Auto RX selected");
    if (best.text.trim()) {
      state.rxText = "";
      appendTerminalText(best.text);
    }
    showToast(`Auto RX ${best.baud} baud ${Math.round(best.markHz)}/${Math.round(best.markHz + best.shiftHz)} Hz${best.rxReverse ? " reverse" : ""}`);
  }

  function txAudioHzFromWaterfallEvent(event) {
    const hitbox = elements["rtty-waterfall-hitbox"];
    if (!hitbox) return DEFAULT_MARK_HZ;
    const rect = hitbox.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const shift = modemOptions().shiftHz;
    const range = currentWaterfallRange();
    return clamp(Math.round((range.low + ratio * range.span) / 5) * 5, range.low, range.high - shift);
  }

  function bindEvents() {
    ["rtty-mark", "rtty-shift", "rtty-baud", "rtty-rx-reverse", "rtty-unshift-space", "rtty-squelch", "rtty-tx-level"].forEach((id) => {
      elements[id]?.addEventListener("change", () => applyModemSettingsChanged());
    });
    elements["rtty-tx-reverse"]?.addEventListener("change", () => {
      saveModemSettings();
      updateToneUi();
    });
    elements["rtty-radio-mode"]?.addEventListener("change", () => {
      saveModemSettings();
      if (state.activeBand) void configureRadioForRtty();
    });
    elements["rtty-tune-dial"]?.addEventListener("click", tuneRttyDialInput);
    elements["rtty-dial-mhz"]?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") tuneRttyDialInput();
    });
    elements["rtty-tune-preset"]?.addEventListener("click", tuneRttyBandPreset);
    elements["rtty-auto-mark"]?.addEventListener("click", snapMarkToWaterfall);
    elements["rtty-auto-rx"]?.addEventListener("click", autoConfigureDecoderFromRecentAudio);
    elements["rtty-enabled"]?.addEventListener("change", async () => {
      state.rxEnabled = Boolean(elements["rtty-enabled"].checked);
      if (state.rxEnabled) {
        try {
          await ensureAudio();
        } catch (error) {
          state.rxEnabled = false;
          showToast(error.message, true);
        }
      }
      setRxUi();
    });
    elements["rtty-clear-rx"]?.addEventListener("click", clearRxText);
    elements["rtty-send"]?.addEventListener("click", () => void transmitRtty(elements["rtty-message"]?.value || ""));
    elements["rtty-send-cq"]?.addEventListener("click", () => {
      applyPreset("cq");
      void transmitRtty(elements["rtty-message"]?.value || "");
    });
    elements["rtty-send-ry"]?.addEventListener("click", () => {
      applyPreset("ry");
      void transmitRtty(elements["rtty-message"]?.value || "");
    });
    elements["rtty-halt"]?.addEventListener("click", haltTransmit);
    elements["rtty-preset"]?.addEventListener("change", () => applyPreset(elements["rtty-preset"].value));
    elements["rtty-message"]?.addEventListener("input", () => setTxButtons());
    elements["rtty-waterfall-hitbox"]?.addEventListener("pointerdown", (event) => {
      state.waterfallDragging = true;
      try { elements["rtty-waterfall-hitbox"].setPointerCapture?.(event.pointerId); } catch {}
      if (elements["rtty-mark"]) elements["rtty-mark"].value = String(txAudioHzFromWaterfallEvent(event));
      applyModemSettingsChanged();
      event.preventDefault();
    });
    elements["rtty-waterfall-hitbox"]?.addEventListener("pointermove", (event) => {
      if (!state.waterfallDragging) return;
      if (elements["rtty-mark"]) elements["rtty-mark"].value = String(txAudioHzFromWaterfallEvent(event));
      updateToneUi();
      event.preventDefault();
    });
    const finishWaterfall = (event) => {
      if (!state.waterfallDragging) return;
      state.waterfallDragging = false;
      if (elements["rtty-mark"]) elements["rtty-mark"].value = String(txAudioHzFromWaterfallEvent(event));
      applyModemSettingsChanged();
      try { elements["rtty-waterfall-hitbox"].releasePointerCapture?.(event.pointerId); } catch {}
      event.preventDefault();
    };
    elements["rtty-waterfall-hitbox"]?.addEventListener("pointerup", finishWaterfall);
    elements["rtty-waterfall-hitbox"]?.addEventListener("pointercancel", finishWaterfall);
    window.addEventListener("resize", () => buildWaterfall());
    window.addEventListener("beforeunload", () => closeAudio(false));
    window.addEventListener("freerig710-settings-changed", () => applySharedStationSettings());
  }

  function tick() {
    if (elements["rtty-utc"]) elements["rtty-utc"].textContent = `${formatUtc()} UTC`;
    updatePill(elements["rtty-clock-state"], "UTC live", "is-ok");
    setTxButtons();
  }

  function initDecoder() {
    state.decoder = new RTTYDecoder({
      char: (char) => appendTerminalText(char === "\r" ? "" : char),
      stats: onDecoderStats,
      clear: () => {},
    }, modemOptions());
  }

  async function initPage() {
    cacheElements();
    loadModemSettings();
    applySharedStationSettings();
    initDecoder();
    updateToneUi();
    populateBandControls();
    buildWaterfall();
    bindEvents();
    setRxUi();
    setTxButtons();
    initAudioOwnerChannel();
    tick();
    setInterval(tick, 250);
    await pollRadioState();
    setInterval(pollRadioState, 1250);
    log("RTTY console ready");
  }

  const exported = Object.freeze({
    BaudotCodec,
    RTTYEncoder,
    RTTYDecoder,
    constants: Object.freeze({
      LETTERS_SHIFT,
      FIGURES_SHIFT,
      DEFAULT_MARK_HZ,
      DEFAULT_SHIFT_HZ,
      RTTY_FILTER_WIDTH_CODE,
      RTTY_WATERFALL_SPAN_HZ,
      RTTY_TX_TONE_RAMP_MS,
      DEFAULT_BAUD,
      DEFAULT_SQUELCH_DB,
      DEFAULT_RADIO_MODE,
      SAMPLE_RATE,
      MAX_STAGED_BYTES,
      RECENT_AUDIO_SECONDS,
      AUTO_RX_ANALYSIS_SECONDS,
    }),
    encodeTextToBaudot: BaudotCodec.encodeText,
    decodeBaudotCodes: BaudotCodec.decodeCodes,
    decodeRttyBufferForOptions,
    decodedTextScore,
    autoSelectRttyCandidate,
    synthesizeRtty,
  });

  if (typeof window !== "undefined") {
    window.FreeRig710API = Object.freeze({ api, post, apiUrl, websocketUrl });
    window.FT710_RTTY = exported;
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("DOMContentLoaded", () => {
      void initPage().catch((error) => {
        console.error(error);
        showToast(error.message || String(error), true);
      });
    });
  }
})();
