"use strict";

(() => {
  const SLOT_MS = 15_000;
  const INPUT_RATE = 48_000;
  const TARGET_RATE = 12_000;
  const SLOT_SAMPLES = TARGET_RATE * 15;
  const MIN_DECODE_SAMPLES = TARGET_RATE * 13.5;
  const FFT_SIZE = 2048;
  const HOP_SIZE = 1024;
  const FREQ_LOW = 200;
  const FREQ_HIGH = 3000;
  const MAX_ROWS = 160;
  const GRID_RE = /^[A-R]{2}\d{2}(?:[A-X]{2})?$/;
  const REPORT_RE = /^[+-]\d{2}$/;
  const R_REPORT_RE = /^R[+-]\d{2}$/;
  const ACK_WORDS = new Set(["RRR", "RR73", "73"]);

  const normalizeCall = (value) => String(value || "").trim().toUpperCase().replace(/^<|>$/g, "");
  const normalizeGrid = (value) => String(value || "").trim().toUpperCase();
  const isCall = (value) => {
    const v = normalizeCall(value);
    return v && v !== "..." && /^[A-Z0-9/]{3,16}$/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
  };

  const id = (name) => document.getElementById(name);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  class Radix2FFT {
    constructor(size) {
      this.size = size;
      this.real = new Float64Array(size);
      this.imag = new Float64Array(size);
      this.window = new Float64Array(size);
      for (let i = 0; i < size; i += 1) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
    }
    transform(input) {
      const n = this.size, real = this.real, imag = this.imag;
      for (let i = 0; i < n; i += 1) { real[i] = input[i] * this.window[i]; imag[i] = 0; }
      for (let i = 1, j = 0; i < n; i += 1) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const angle = -2 * Math.PI / len, wLenR = Math.cos(angle), wLenI = Math.sin(angle);
        for (let start = 0; start < n; start += len) {
          let wr = 1, wi = 0;
          for (let j = 0; j < len / 2; j += 1) {
            const a = start + j, b = a + len / 2;
            const br = real[b] * wr - imag[b] * wi, bi = real[b] * wi + imag[b] * wr;
            const ar = real[a], ai = imag[a];
            real[a] = ar + br; imag[a] = ai + bi; real[b] = ar - br; imag[b] = ai - bi;
            const nextWr = wr * wLenR - wi * wLenI; wi = wr * wLenI + wi * wLenR; wr = nextWr;
          }
        }
      }
      return { real, imag };
    }
  }

  const controller = {
    initialized: false,
    audioReady: false,
    enabled: false,
    controlSender: null,
    statusTimer: null,
    probeTimer: null,
    animationFrame: null,
    fft: new Radix2FFT(FFT_SIZE),
    fftBuffer: new Float64Array(FFT_SIZE),
    fftFill: 0,
    downsamplePhase: 0,
    downsampleAccum: 0,
    downsampleCount: 0,
    totalInputSamples: 0,
    firstAudioPerf: null,
    lastChunkPerf: null,
    chunkIntervals: [],
    lastLevelDb: -120,
    displayLevelDb: -120,
    meterSumSq: 0,
    meterSampleCount: 0,
    meterDisplayLastPerf: null,
    lastServerStatus: null,
    serverClockValid: false,
    serverClockDeltaMs: null,
    serverClockRttMs: null,
    worker: null,
    decoderReady: false,
    decoderError: "",
    encoderReady: false,
    encoderError: "",
    encodeRequestSeq: 1,
    encodeWaiters: new Map(),
    decodeBusy: false,
    decodeBusySlotIndex: null,
    captureSlotIndex: null,
    captureSlotStartedUnixMs: 0,
    captureBuffer: new Float32Array(SLOT_SAMPLES),
    captureCount: 0,
    captureArmed: false,
    decodeRows: [],
    txActivityRows: [],
    logbookReady: false,
    qrzSyncRunning: false,
    qsoCompletionPromise: null,
    qsoCompletionKey: "",
    currentLocalQsoId: "",
    currentLocalQsoRecord: null,
    decodeFilters: null,
    colorRules: null,
    qsoMachine: null,
    autoSeq: true,
    callFirst: true,
    holdTxFrequency: true,
    slotsSubmitted: 0,
    slotsRejected: 0,
    lastQsoSlotTick: null,
    earlyDecodeSlotIndex: null,
    earlyDecodeSubmitted: false,
    myCall: "",
    myGrid: "",
    txReport: "+00",
    qso: { state: "IDLE", dxCall: "", dxGrid: "", df: null, rxSlotParity: null, txSlotParity: 0, lastHeard: "", lastHeardUnixMs: 0, startedUnixMs: 0, nextMessage: "" },

    init() {
      this.initQsoMachine();
      if (this.initialized) return;
      this.initialized = true;
      const checkbox = id("ft8-enabled");
      if (!checkbox) return;
      checkbox.checked = false;
      checkbox.addEventListener("change", () => {
        this.enabled = Boolean(checkbox.checked && this.audioReady);
        checkbox.checked = this.enabled;
        try { localStorage.setItem("freerig710-ft8-rx-enabled-v1", this.enabled ? "1" : "0"); } catch (_) {}
        if (this.enabled) {
          this.resetAudioMetrics();
          this.resetSlotCapture();
          this.ensureWorker();
        } else {
          this.resetSlotCapture();
        }
        this.renderStatus();
      });
      id("ft8-clear-decodes")?.addEventListener("click", () => { this.decodeRows = []; this.txActivityRows = []; this.renderDecodeRows(); });
      this.initLogbook();
      this.initQsoLogging();
      this.initDecodeRules();
      id("ft8-reset-qso")?.addEventListener("click", () => this.resetQso());
      id("ft8-my-grid")?.addEventListener("input", (event) => {
        event.target.value = event.target.value.toUpperCase().replace(/[^A-R0-9]/g, "").slice(0, 6);
        this.myGrid = event.target.value;
        try { localStorage.setItem("freerig710-ft8-my-grid-v1", this.myGrid); } catch (_) {}
        this.recomputeQsoNext();
      });
      id("ft8-tx-report")?.addEventListener("change", (event) => {
        let value = Number(event.target.value);
        if (!Number.isFinite(value)) value = Number(this.txReport) || 0;
        value = Math.max(-30, Math.min(30, Math.round(value)));
        this.txReport = `${value >= 0 ? "+" : "-"}${String(Math.abs(value)).padStart(2, "0")}`;
        event.target.value = String(value);
        this.recomputeQsoNext();
      });
      try { this.myGrid = localStorage.getItem("freerig710-ft8-my-grid-v1") || ""; } catch (_) {}
      // Reports are measurements, not preferences. Do not restore the old
      // persisted -10 placeholder; a selected DX decode supplies the report.
      try { localStorage.removeItem("freerig710-ft8-tx-report-v1"); } catch (_) {}
      if (id("ft8-my-grid")) id("ft8-my-grid").value = this.myGrid;
      if (id("ft8-tx-report")) id("ft8-tx-report").value = String(Number(this.txReport));
      void this.refreshStationIdentity();
      this.renderQso();
      this.statusTimer = window.setInterval(() => { if (this.enabled) void this.refreshServerStatus(); }, 2000);
      this.probeTimer = window.setInterval(() => { if (this.enabled) this.sendTimingProbe(); }, 3000);
      this.animationFrame = window.requestAnimationFrame(() => this.animateClock());
      this.renderStatus();
      this.renderDecodeRows();
      void this.refreshServerStatus();
    },

    ensureWorker() {
      if (this.worker) return;
      try {
        this.worker = new Worker("ft8-worker.js?v=1.0", { type: "module" });
        this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
        this.worker.onerror = (event) => {
          this.decoderReady = false;
          this.decoderError = event.message || "worker error";
          id("ft8-decoder-state").textContent = `ERROR · ${this.decoderError}`;
        };
        id("ft8-decoder-state").textContent = "loading ft8_lib/WASM…";
        this.worker.postMessage({ type: "init" });
      } catch (error) {
        this.decoderError = String(error?.message || error);
        id("ft8-decoder-state").textContent = `ERROR · ${this.decoderError}`;
      }
    },

    handleWorkerMessage(message) {
      if (!message) return;
      if (message.type === "decoder-ready") {
        this.decoderReady = true;
        this.decoderError = "";
        id("ft8-decoder-state").textContent = `${message.backend} · ${message.library} ${message.version}`;
        this.renderStatus();
        return;
      }
      if (message.type === "decoder-error") {
        this.decoderReady = false;
        this.decoderError = message.error || "load failed";
        id("ft8-decoder-state").textContent = `ERROR · ${this.decoderError}`;
        this.renderStatus();
        return;
      }
      if (message.type === "encoder-ready") {
        this.encoderReady = true;
        this.encoderError = "";
        id("ft8-encoder-state") && (id("ft8-encoder-state").textContent = `${message.backend} · ${message.library} ${message.version}`);
        window.FT710_FT8_PAGE?.encoderStateChanged?.({ ready: true, detail: `${message.backend} · ${message.library} ${message.version}` });
        return;
      }
      if (message.type === "encoder-error") {
        this.encoderReady = false;
        this.encoderError = message.error || "load failed";
        id("ft8-encoder-state") && (id("ft8-encoder-state").textContent = `ERROR · ${this.encoderError}`);
        window.FT710_FT8_PAGE?.encoderStateChanged?.({ ready: false, detail: this.encoderError });
        return;
      }
      if (message.type === "encode-result" || message.type === "encode-error") {
        const waiter = this.encodeWaiters.get(Number(message.requestId));
        if (waiter) {
          this.encodeWaiters.delete(Number(message.requestId));
          if (message.type === "encode-error") waiter.reject(new Error(message.error || "FT8 encode failed"));
          else waiter.resolve({
            message: message.message,
            pcm: message.pcm instanceof ArrayBuffer ? new Int16Array(message.pcm) : new Int16Array(),
            sourceRate: Number(message.sourceRate) || 12000,
            targetRate: Number(message.targetRate) || 48000,
            sampleRate: Number(message.sampleRate) || 48000,
            stagedSampleRate: Number.isFinite(Number(message.stagedSampleRate)) ? Number(message.stagedSampleRate) : 0,
            samples: Number(message.samples) || 0,
            durationMs: Number(message.durationMs),
            audioBaseHz: Number(message.audioBaseHz),
            audioTopHz: Number(message.audioTopHz),
            levelDbfs: Number(message.levelDbfs),
            peakFloat: Number(message.peakFloat),
            peakPcm: Number(message.peakPcm),
            sourceRmsDbfs: Number(message.sourceRmsDbfs),
            rmsDbfs: Number(message.rmsDbfs),
            amRippleDb: Number(message.amRippleDb),
            resampler: String(message.resampler || "WSJT-X source → WebAudio microphone-clock path"),
            tones: Array.isArray(message.tones) ? message.tones : [],
            elapsedMs: Number(message.elapsedMs),
          });
        }
        return;
      }
      if (message.type === "decode-result") {
        this.decodeBusy = false;
        this.decodeBusySlotIndex = null;
        const slotIndex = Number(message.slotIndex);
        const slotStart = slotIndex * SLOT_MS;
        const results = Array.isArray(message.results) ? message.results : [];
        id("ft8-decode-state").textContent = `${results.length} msg · ${Number(message.elapsedMs || 0).toFixed(0)} ms`;
        for (const result of results) this.addDecode(slotStart, result, slotIndex);
        this.renderDecodeRows();
        return;
      }
      if (message.type === "decode-error") {
        this.decodeBusy = false;
        this.decodeBusySlotIndex = null;
        id("ft8-decode-state").textContent = `ERROR · ${message.error || "decode failed"}`;
      }
    },

    async encodeTxWaveform(message, frequency = 1500, levelDbfs = -12) {
      this.ensureWorker();
      if (!this.worker) throw new Error("FT8 Worker is unavailable");
      const requestId = this.encodeRequestSeq++;
      if (this.encodeRequestSeq > 0x7fffffff) this.encodeRequestSeq = 1;
      const encoded = await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          this.encodeWaiters.delete(requestId);
          reject(new Error("FT8 encoder timeout"));
        }, 12000);
        this.encodeWaiters.set(requestId, {
          resolve: (value) => { window.clearTimeout(timeout); resolve(value); },
          reject: (error) => { window.clearTimeout(timeout); reject(error); },
        });
        this.worker.postMessage({ type: "encode", requestId, message, frequency, levelDbfs });
      });
      if (!(encoded.pcm instanceof Int16Array) || encoded.pcm.length !== 606720) {
        throw new Error(`WSJT-X-port FT8 render returned ${encoded.pcm?.length || 0} samples, expected 606720 at 48 kHz`);
      }
      if (encoded.sampleRate !== 48000 || encoded.stagedSampleRate !== 48000) {
        throw new Error(`WSJT-X-port FT8 staged rate must be 48000 Hz (got ${encoded.sampleRate}/${encoded.stagedSampleRate})`);
      }
      return encoded;
    },

    preloadEncoder() {
      this.ensureWorker();
      this.worker?.postMessage({ type: "init-encoder" });
    },

    getServerUnixMs() {
      return Date.now() + (this.serverClockValid && Number.isFinite(this.serverClockDeltaMs) ? this.serverClockDeltaMs : 0);
    },

    getTimingEstimate() {
      return { valid: this.serverClockValid, deltaMs: this.serverClockDeltaMs, rttMs: this.serverClockRttMs, serverUnixMs: this.getServerUnixMs() };
    },

    isDecodePendingForSlot(slotIndex) {
      return Boolean(this.decodeBusy && Number(this.decodeBusySlotIndex) === Number(slotIndex));
    },

    getTxPlan() {
      // The state machine is the single source of truth for the message that
      // may be transmitted.  Do not derive TX from the rendered/cached QSO
      // object: UI rendering can lag a decode by one turn of the event loop.
      const q = this.qsoMachine?.snapshot?.() || this.qso || {};
      let message = String(q.nextMessage || "").trim();
      message = message.replace(/\s+\(optional\)$/i, "");
      if (!message || message.includes("[")) message = "";
      return {
        message,
        state: q.state || "IDLE",
        dxCall: q.dxCall || "",
        df: q.df,
        txSlotParity: Number(q.txSlotParity || 0) & 1,
        txReport: q.txReport || this.txReport,
      };
    },

    getQsoSnapshot() {
      return {
        state: this.qso?.state || "IDLE",
        dxCall: this.qso?.dxCall || "",
        dxGrid: this.qso?.dxGrid || "",
        df: this.qso?.df,
        rxSlotParity: this.qso?.rxSlotParity,
        txSlotParity: Number(this.qso?.txSlotParity || 0) & 1,
        startedUnixMs: Number(this.qso?.startedUnixMs) || 0,
        completedUnixMs: Number(this.qso?.completedUnixMs) || 0,
        lastHeard: this.qso?.lastHeard || "",
        attempts: Number(this.qso?.attempts)||0,
        retryAttempts: Number(this.qso?.retryAttempts)||0,
        rstRcvd: this.qso?.rstRcvd || "",
        history: Array.isArray(this.qso?.history)?this.qso.history.slice():[],
        txReport: this.qso?.txReport || this.txReport,
        myGrid: this.myGrid,
      };
    },

    notifyTxStarted(info = {}) {
      const message=String(info?.message||"").trim().toUpperCase();if(!message)return;
      this.recordTxActivity({message,slotIndex:info?.slotIndex,df:this.qso?.df,waveformId:info?.waveformId});
    },

    notifyTxComplete(info = {}) {
      const message = String(info?.message || "").trim().toUpperCase();
      if (!message) return;
      this.recordTxActivity({message,slotIndex:info?.slotIndex,df:this.qso?.df,waveformId:info?.waveformId});
      if(this.qsoMachine){const snap=this.qsoMachine.onTxComplete({message,slotIndex:info?.slotIndex,unixMs:this.getServerUnixMs()});this.syncQsoFromMachine(snap);if(snap.state==="ERROR")void window.FT710_FT8_PAGE?.haltAutoTx?.("QSO TX sequence mismatch",false);else if(!this.autoSeq&&!snap.state.startsWith("COMPLETE"))void window.FT710_FT8_PAGE?.haltAutoTx?.("Auto Seq off",false);return;}
    },

    recordTxActivity({message,slotIndex=null,df=null,waveformId=0}={}) {
      const text=String(message||"").trim().toUpperCase();if(!text)return;
      const slot=Number(slotIndex);const unixMs=Number.isFinite(slot)?slot*SLOT_MS:this.getServerUnixMs();
      const txDf=Number.isFinite(Number(df))?Math.round(Number(df)):1500;
      const key=`TX|${Number.isFinite(slot)?slot:Math.floor(unixMs/SLOT_MS)}|${txDf}|${text}`;
      if(this.txActivityRows.some(row=>row.key===key))return;
      this.txActivityRows.unshift({key,time:new Date(unixMs).toISOString().slice(11,19),db:null,snr:null,dt:null,df:txDf,text,parsed:this.parseMessage(text),slotIndex:Number.isFinite(slot)?slot:Math.floor(unixMs/SLOT_MS),unixMs,isTx:true,waveformId:Number(waveformId)||0});
      if(this.txActivityRows.length>80)this.txActivityRows.length=80;
      this.renderDecodeRows();
    },

    setAudioReady(ready) {
      this.audioReady = Boolean(ready);
      const checkbox = id("ft8-enabled");
      if (!checkbox) return;
      checkbox.disabled = !this.audioReady;
      if (this.audioReady) {
        let wanted = false;
        try { wanted = localStorage.getItem("freerig710-ft8-rx-enabled-v1") === "1"; } catch (_) {}
        this.enabled = wanted;
        checkbox.checked = wanted;
        if (wanted) { this.resetAudioMetrics(); this.resetSlotCapture(); this.ensureWorker(); }
      } else {
        this.enabled = false;
        checkbox.checked = false;
        this.resetSlotCapture();
      }
      this.renderStatus();
    },

    enableDecode(enabled) {
      const checkbox = id("ft8-enabled");
      const wanted = Boolean(enabled && this.audioReady);
      this.enabled = wanted;
      if (checkbox) checkbox.checked = wanted;
      try { localStorage.setItem("freerig710-ft8-rx-enabled-v1", wanted ? "1" : "0"); } catch (_) {}
      if (wanted) {
        this.resetAudioMetrics();
        this.resetSlotCapture();
        this.ensureWorker();
      } else {
        this.resetSlotCapture();
      }
      this.renderStatus();
    },

    setTxSlotParity(parity) {
      this.qso.txSlotParity = Number(parity) & 1;
      this.renderQso();
    },

    setControlSender(sender) { this.controlSender = typeof sender === "function" ? sender : null; },

    resetAudioMetrics() {
      this.fftFill = 0; this.downsamplePhase = 0; this.downsampleAccum = 0; this.downsampleCount = 0;
      this.totalInputSamples = 0; this.firstAudioPerf = null; this.lastChunkPerf = null; this.chunkIntervals = []; this.lastLevelDb = -120;
      this.displayLevelDb = -120; this.meterSumSq = 0; this.meterSampleCount = 0; this.meterDisplayLastPerf = null;
      const canvas = id("ft8-waterfall");
      if (canvas) { const ctx = canvas.getContext("2d"); ctx.fillStyle = "#070b10"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    },

    resetSlotCapture() {
      this.captureSlotIndex = null;
      this.captureSlotStartedUnixMs = 0;
      this.captureCount = 0;
      this.captureArmed = false;
      this.earlyDecodeSlotIndex = null;
      this.earlyDecodeSubmitted = false;
      this.captureBuffer.fill(0);
      if (id("ft8-capture-state")) id("ft8-capture-state").textContent = this.enabled ? "arming at next UTC slot" : "idle";
    },

    feedAudio(buffer, sampleRate) {
      if (!this.enabled || !(buffer instanceof ArrayBuffer)) return;
      const samples = new Int16Array(buffer);
      if (!samples.length) return;
      const nowPerf = performance.now();
      if (this.firstAudioPerf == null) this.firstAudioPerf = nowPerf;
      if (this.lastChunkPerf != null) {
        this.chunkIntervals.push(nowPerf - this.lastChunkPerf);
        if (this.chunkIntervals.length > 200) this.chunkIntervals.shift();
      }
      this.lastChunkPerf = nowPerf;
      this.totalInputSamples += samples.length;

      let sumSq = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const x = samples[i] / 32768;
        sumSq += x * x;
        this.downsampleAccum += x;
        this.downsampleCount += 1;
        this.downsamplePhase += TARGET_RATE;
        if (this.downsamplePhase >= sampleRate) {
          const y = this.downsampleAccum / Math.max(1, this.downsampleCount);
          this.downsampleAccum = 0; this.downsampleCount = 0; this.downsamplePhase -= sampleRate;
          this.pushDownsampled(y);
        }
      }
      const rms = Math.sqrt(sumSq / samples.length);
      this.lastLevelDb = rms > 1e-9 ? 20 * Math.log10(rms) : -120;

      // Human-readable meter: integrate signal energy for one second, then
      // convert the one-second RMS to dBFS.  Auto RF gain intentionally keeps
      // using lastLevelDb at the fast chunk cadence; only the displayed meter
      // is slowed down so it can actually be read.
      this.meterSumSq += sumSq;
      this.meterSampleCount += samples.length;
      if (this.meterDisplayLastPerf == null) this.meterDisplayLastPerf = nowPerf;
      if (nowPerf - this.meterDisplayLastPerf >= 1000 && this.meterSampleCount > 0) {
        const displayRms = Math.sqrt(this.meterSumSq / this.meterSampleCount);
        this.displayLevelDb = displayRms > 1e-9 ? 20 * Math.log10(displayRms) : -120;
        this.meterSumSq = 0;
        this.meterSampleCount = 0;
        this.meterDisplayLastPerf = nowPerf;
      }
      this.renderAudioMetrics(sampleRate);
    },

    pushDownsampled(sample) {
      this.fftBuffer[this.fftFill++] = sample;
      if (this.fftFill >= FFT_SIZE) {
        this.drawWaterfallRow();
        this.fftBuffer.copyWithin(0, HOP_SIZE, FFT_SIZE);
        this.fftFill = FFT_SIZE - HOP_SIZE;
      }
      this.captureSample(sample);
    },

    captureSample(sample) {
      // Use the ESP32 SNTP-disciplined UTC estimate for FT8 slot boundaries.
      // Falling back to Date.now() is only for the brief period before the
      // first timing probe returns.
      const now = this.getServerUnixMs();
      const slotIndex = Math.floor(now / SLOT_MS);
      if (this.captureSlotIndex == null) {
        this.captureSlotIndex = slotIndex;
        this.captureSlotStartedUnixMs = slotIndex * SLOT_MS;
        this.captureCount = 0;
        this.captureArmed = false; // First partial slot after enabling is discarded.
        return;
      }
      if (slotIndex !== this.captureSlotIndex) {
        if (this.captureArmed) this.finishCaptureSlot(this.captureSlotIndex, this.captureCount);
        this.captureSlotIndex = slotIndex;
        this.captureSlotStartedUnixMs = slotIndex * SLOT_MS;
        this.captureCount = 0;
        this.captureBuffer.fill(0);
        this.captureArmed = true;
        this.earlyDecodeSlotIndex = null;
        this.earlyDecodeSubmitted = false;
      }
      if (!this.captureArmed) return;
      if (this.captureCount < SLOT_SAMPLES) this.captureBuffer[this.captureCount++] = sample;
      if (!this.earlyDecodeSubmitted && this.captureCount >= Math.round(TARGET_RATE * 13.2)) {
        this.earlyDecodeSubmitted = true;
        this.earlyDecodeSlotIndex = this.captureSlotIndex;
        this.submitDecodeSlot(this.captureSlotIndex, this.captureCount, true);
      }
      const pct = Math.min(100, 100 * this.captureCount / SLOT_SAMPLES);
      id("ft8-capture-state").textContent = `${this.captureSlotIndex % 2 === 0 ? "EVEN" : "ODD"} · ${(this.captureCount / TARGET_RATE).toFixed(2)} s · ${pct.toFixed(0)}%`;
    },

    finishCaptureSlot(slotIndex, count) {
      // Early decode at ~13.2 s is the one used for fast auto-sequencing.
      // At the UTC boundary submit a full-slot retry only when the worker is
      // available and the early pass did not already occupy it.
      if (this.earlyDecodeSlotIndex === slotIndex) {
        if (!this.decodeBusy && count >= MIN_DECODE_SAMPLES) this.submitDecodeSlot(slotIndex, count, false);
        return;
      }
      this.submitDecodeSlot(slotIndex, count, false);
    },

    submitDecodeSlot(slotIndex, count, early = false) {
      const minimum = early ? Math.round(TARGET_RATE * 13.0) : MIN_DECODE_SAMPLES;
      if (count < minimum) {
        if (!early) { this.slotsRejected += 1; id("ft8-decode-state").textContent = "incomplete"; }
        return false;
      }
      if (!this.worker) this.ensureWorker();
      if (!this.decoderReady || !this.worker) {
        if (!early) id("ft8-decode-state").textContent = this.decoderError ? `decoder unavailable` : "decoder loading";
        return false;
      }
      if (this.decodeBusy) return false;
      const validSamples = Math.min(count, SLOT_SAMPLES);
      const samples = new Float32Array(SLOT_SAMPLES);
      samples.set(this.captureBuffer.subarray(0, validSamples));
      this.decodeBusy = true;
      this.decodeBusySlotIndex = slotIndex;
      this.slotsSubmitted += 1;
      id("ft8-decode-state").textContent = `${early ? "early " : ""}decoding ${slotIndex % 2 === 0 ? "EVEN" : "ODD"} · ${(validSamples / TARGET_RATE).toFixed(2)} s…`;
      this.worker.postMessage({ type: "decode", slotIndex, validSamples, early, samples: samples.buffer }, [samples.buffer]);
      return true;
    },

    initQsoMachine() {
      const api=window.FreeRig710FT8QsoMachine; if(!api)return;
      this.qsoMachine=new api.QsoMachine({maxRetries:6,timeoutSlots:8,completeOnSent73:true,callFirst:true,autoSeq:true});
      const syncOptions=()=>{this.autoSeq=Boolean(id("ft8-auto-seq")?.checked);this.callFirst=Boolean(id("ft8-call-first")?.checked);this.holdTxFrequency=Boolean(id("ft8-hold-tx")?.checked);this.qsoMachine?.configure({autoSeq:this.autoSeq,callFirst:this.callFirst,maxRetries:Number(id("ft8-qso-retries")?.value)||6,timeoutSlots:Number(id("ft8-qso-timeout")?.value)||8});};
      for(const domId of ["ft8-auto-seq","ft8-call-first","ft8-hold-tx","ft8-qso-retries","ft8-qso-timeout"]) id(domId)?.addEventListener("change",syncOptions);
      id("ft8-call-cq")?.addEventListener("click",()=>{syncOptions();this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid,txReport:this.txReport});const page=window.FT710_FT8_PAGE;const cursorDf=Number(page?.getTxDf?.());const txParity=Number(page?.getTxSlotParity?.())&1;const snap=this.qsoMachine.startCallingCq({df:Number.isFinite(cursorDf)?cursorDf:(this.qso?.df??1500),txSlotParity:txParity,unixMs:this.getServerUnixMs()});this.syncQsoFromMachine(snap);if(snap.state==="CALLING_CQ"){page?.qsoSelected?.({df:snap.df,rxSlotParity:snap.rxSlotParity,txSlotParity:snap.txSlotParity,dxCall:""});page?.enableAutoTxFromSelection?.();}});
      document.querySelectorAll("[data-qso-stage]").forEach(button=>button.addEventListener("click",()=>this.selectQsoStage(button.dataset.qsoStage)));
      syncOptions();
    },

    selectQsoStage(stage) {
      if(!this.qsoMachine)return;
      const page=window.FT710_FT8_PAGE;
      if(page?.canReplanQso && !page.canReplanQso())return;
      this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid,txReport:this.txReport});
      const before=this.qsoMachine.snapshot();
      if(!before.dxCall)return;
      if(["COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED"].includes(before.state)){this.currentLocalQsoId="";this.currentLocalQsoRecord=null;this.qsoCompletionKey="";}
      const snap=this.qsoMachine.selectTxStage(stage,{unixMs:this.getServerUnixMs()});
      this.syncQsoFromMachine(snap);
      page?.rearmAutoTxFromSelection?.();
    },

    syncQsoFromMachine(snapshot=this.qsoMachine?.snapshot?.()) {
      if(!snapshot)return;
      // Keep the operator-visible report and Message Sequence synchronized
      // with the report actually owned by the QSO state machine.  Previously
      // this.txReport could remain at the SNR measured on the original CQ
      // while the machine had already updated to a later DX report.
      if (/^[+-]\d{2}$/.test(String(snapshot.txReport || ""))) {
        this.txReport = String(snapshot.txReport);
        const reportInput = id("ft8-tx-report");
        if (reportInput && document.activeElement !== reportInput) reportInput.value = String(Number(this.txReport));
      }
      this.qso={state:snapshot.state,dxCall:snapshot.dxCall,dxGrid:snapshot.dxGrid,df:snapshot.df,rxSlotParity:snapshot.rxSlotParity,txSlotParity:snapshot.txSlotParity,lastHeard:snapshot.lastHeard,lastHeardUnixMs:snapshot.lastHeardUnixMs,startedUnixMs:snapshot.startedUnixMs,completedUnixMs:snapshot.completedUnixMs,rstRcvd:snapshot.rstRcvd,txReport:snapshot.txReport,nextMessage:snapshot.nextMessage,attempts:snapshot.attempts,retryAttempts:snapshot.retryAttempts,history:snapshot.history};
      this.renderDecodeRows(); this.renderQso();
      if(snapshot.state==="COMPLETE") void this.handleCompletedQso(snapshot);
    },

    isAutoSeqEnabled(){return this.autoSeq;},

    async initDecodeRules() {
      const rulesApi=window.FreeRig710FT8DecodeRules, lb=window.FreeRig710FT8Logbook;
      if(!rulesApi) return;
      this.decodeFilters={...rulesApi.DEFAULT_FILTERS}; this.colorRules=rulesApi.DEFAULT_RULES.map(r=>({...r}));
      try {
        const savedF=await lb?.getPreference?.("decodeFilters",null); if(savedF) this.decodeFilters={...this.decodeFilters,...savedF};
        const savedR=await lb?.getPreference?.("colorRules",null); if(Array.isArray(savedR)&&savedR.length) this.colorRules=savedR.map(r=>({...r}));
        const ruleSchema=Number(await lb?.getPreference?.("colorRulesSchema",1)||1);
        if(ruleSchema<2){
          const byId=new Map(this.colorRules.map(r=>[r.id,r]));
          if(!byId.has("new-country")){const r=rulesApi.DEFAULT_RULES.find(x=>x.id==="new-country");if(r)this.colorRules.push({...r});}
          const legacy={"new-dxcc":75,"new-dxcc-band":73};
          for(const rule of this.colorRules){const fresh=rulesApi.DEFAULT_RULES.find(x=>x.id===rule.id);if(fresh&&legacy[rule.id]===Number(rule.priority))rule.priority=fresh.priority;}
          await lb?.setPreference?.("colorRules",this.colorRules);await lb?.setPreference?.("colorRulesSchema",2);
        }
      } catch(_) {}
      const map={
        cqOnly:"ft8-filter-cq",showMyCall:"ft8-filter-mycall",showStandard:"ft8-filter-standard",showFree:"ft8-filter-free",showBeacon:"ft8-filter-beacon",
        anyMsgNewContinent:"ft8-filter-any-new-continent",anyMsgNewCountry:"ft8-filter-any-new-country",anyMsgNewDxcc:"ft8-filter-any-new-dxcc",anyMsgNewDxccBand:"ft8-filter-any-new-dxcc-band",
        anyMsgNewCall:"ft8-filter-any-new-call",anyMsgNewBand:"ft8-filter-any-new-band",anyMsgNewMode:"ft8-filter-any-new-mode",anyMsgNewGrid:"ft8-filter-any-new-grid",
        minSnr:"ft8-filter-snr",dfMin:"ft8-filter-df-min",dfMax:"ft8-filter-df-max",includeCalls:"ft8-filter-include",excludeCalls:"ft8-filter-exclude",ignoreCalls:"ft8-filter-ignore",
        continent:"ft8-filter-continent",country:"ft8-filter-country",region:"ft8-filter-region",dxcc:"ft8-filter-dxcc",gridPrefix:"ft8-filter-grid",worked:"ft8-filter-worked",workedBand:"ft8-filter-worked-band",workedMode:"ft8-filter-worked-mode",
        workedToday:"ft8-filter-worked-today",workedYesterday:"ft8-filter-worked-yesterday",newDxcc:"ft8-filter-new-dxcc",newDxccBand:"ft8-filter-new-dxcc-band",newBand:"ft8-filter-new-band",newMode:"ft8-filter-new-mode",newGrid:"ft8-filter-new-grid",
        minDistanceKm:"ft8-filter-distance-min",maxDistanceKm:"ft8-filter-distance-max"
      };
      const writeControls=()=>{for(const [key,domId] of Object.entries(map)){const el=id(domId);if(!el)continue;const v=this.decodeFilters[key];if(el.type==="checkbox")el.checked=Boolean(v);else el.value=String(v??"");}const b=id("ft8-filter-bypass");if(b)b.textContent=this.decodeFilters.bypass?"Filters OFF":"Filters ON";};
      const save=()=>{void lb?.setPreference?.("decodeFilters",this.decodeFilters);this.renderDecodeRows();};
      for(const [key,domId] of Object.entries(map)){const el=id(domId);el?.addEventListener("change",()=>{this.decodeFilters[key]=el.type==="checkbox"?el.checked:(el.type==="number"?(el.value===""?"":Number(el.value)):el.value);save();});}
      id("ft8-filter-bypass")?.addEventListener("click",(event)=>{event.preventDefault();event.stopPropagation();this.decodeFilters.bypass=!this.decodeFilters.bypass;writeControls();save();});
      const persistRules=()=>{void lb?.setPreference?.("colorRules",this.colorRules);void lb?.setPreference?.("colorRulesSchema",2);this.renderDecodeRows();};
      const renderRules=()=>{
        const box=id("ft8-color-rules");if(!box)return;box.textContent="";
        for(const rule of this.colorRules){
          const row=document.createElement("div");row.className="ft8-color-rule";
          const en=document.createElement("input");en.type="checkbox";en.checked=rule.enabled!==false;en.title="Enable rule";
          const label=document.createElement("input");label.type="text";label.className="ft8-rule-label";label.value=rule.label||rule.id;label.title="Rule label";
          const criteria=document.createElement("input");criteria.type="text";criteria.className="ft8-rule-criteria";criteria.value=rule.criteria||"";criteria.placeholder="optional match";criteria.title="call=JA*;dxcc=339;country=Japan;continent=AS;state=...;grid=PM;band=20M;mode=FT8;worked=no";
          const pr=document.createElement("input");pr.type="number";pr.value=String(rule.priority);pr.title="Priority";
          const fg=document.createElement("input");fg.type="color";fg.value=rule.fg;fg.title="Foreground";
          const bg=document.createElement("input");bg.type="color";bg.value=rule.bg;bg.title="Background";
          const remove=document.createElement("button");remove.type="button";remove.className="secondary small ft8-rule-remove";remove.textContent="×";remove.title="Remove custom rule";remove.disabled=!String(rule.id||"").startsWith("custom-");
          row.append(en,label,criteria,pr,fg,bg,remove);box.appendChild(row);
          const changed=()=>{rule.enabled=en.checked;rule.label=label.value.trim()||rule.id;rule.criteria=criteria.value.trim();rule.priority=Number(pr.value)||0;rule.fg=fg.value;rule.bg=bg.value;persistRules();};
          for(const el of [en,label,criteria,pr,fg,bg])el.addEventListener("change",changed);
          remove.addEventListener("click",()=>{if(remove.disabled)return;this.colorRules=this.colorRules.filter(x=>x!==rule);renderRules();persistRules();});
        }
      };
      id("ft8-rules-add")?.addEventListener("click",()=>{this.colorRules.push({id:`custom-${Date.now()}`,label:"Custom",enabled:true,priority:50,fg:"#ffffff",bg:"#263341",criteria:"call=JA*"});renderRules();persistRules();});
      id("ft8-rules-reset")?.addEventListener("click",()=>{this.colorRules=rulesApi.DEFAULT_RULES.map(r=>({...r,enabled:true}));renderRules();persistRules();});
      id("ft8-rules-preset")?.addEventListener("click",()=>{this.colorRules=rulesApi.DEFAULT_RULES.map(r=>({...r}));renderRules();persistRules();});
      writeControls();renderRules();this.renderDecodeRows();
    },

    decodeRuleContext() {
      return {myCall:this.myCall,myGrid:this.myGrid,selectedCall:this.qso?.dxCall||"",selectedRegion:this.decodeFilters?.region||this.decodeFilters?.continent||"",band:window.FT710_FT8_PAGE?.activeBand||"",mode:"FT8",logbook:window.FreeRig710FT8Logbook,cty:window.FreeRig710FT8CTY,geo:window.FreeRig710FT8Geo};
    },

    async initLogbook() {
      const lb = window.FreeRig710FT8Logbook;
      const status = id("ft8-adi-status"), progress = id("ft8-adi-progress"), drop = id("ft8-adi-drop"), fileInput = id("ft8-adi-file");
      if (!lb) { if (status) status.textContent = "Logbook module unavailable"; return; }
      const renderIndexCount = async () => {
        try {
          const counts = await lb.loadIndexCaches();
          this.logbookReady = true;
          if (id("ft8-logbook-count")) id("ft8-logbook-count").textContent = `${counts.calls} worked calls · ${counts.dxcc} DXCC · ${counts.countries||0} countries`;
          if (status && !status.dataset.importing) {
            const ctyStats=window.FreeRig710FT8CTY?.stats?.()||{};
            status.textContent = ctyStats.loaded ? `Ready · ADIF ${lb.ADIF_VERSION} · CTY ${ctyStats.entities||0} entities` : `Ready · ADIF ${lb.ADIF_VERSION} · CTY database missing`;
          }
          this.renderDecodeRows(); this.renderSelectedWorked();
          return counts;
        } catch (error) { if (status) status.textContent = `Logbook error: ${error?.message || error}`; }
      };
      const importFile = async (file) => {
        if (!file) return;
        if (status) { status.dataset.importing = "1"; status.textContent = `Importing ${file.name}…`; }
        if (progress) progress.value = 0;
        try {
          const result = await lb.importAdiFile(file, { onProgress: (p) => {
            if (progress) progress.value = p.total ? Math.min(100, Math.round(p.bytes * 100 / p.total)) : 0;
            if (status) status.textContent = `Parsed ${p.parsed} · new ${p.imported} · duplicates ${p.duplicates} · errors ${p.errors}`;
          }});
          if (progress) progress.value = 100;
          if (status) status.textContent = `Done · ${result.imported} new · ${result.duplicates} duplicates · ${result.errors} errors`;
          await renderIndexCount();
        } catch (error) {
          if (status) status.textContent = `Import failed: ${error?.message || error}`;
        } finally { if (status) delete status.dataset.importing; }
      };
      fileInput?.addEventListener("change", () => void importFile(fileInput.files?.[0]));
      drop?.addEventListener("click", (event) => { if (event.target !== fileInput) fileInput?.click(); });
      drop?.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput?.click(); } });
      for (const eventName of ["dragenter","dragover"]) drop?.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.add("dragover"); });
      for (const eventName of ["dragleave","drop"]) drop?.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove("dragover"); });
      drop?.addEventListener("drop", (event) => void importFile(event.dataTransfer?.files?.[0]));
      id("ft8-qrz-sync")?.addEventListener("click", () => void this.runQrzSync(renderIndexCount));
      window.addEventListener("freerig-ft8-logbook-updated", () => void renderIndexCount());
      try {
        await window.FreeRig710FT8CTY?.ready;
        const wantedSchema=Number(lb.COUNTRY_KEY_SCHEMA||0);
        const haveSchema=Number(await lb.getPreference?.("countryKeySchema",0)||0);
        const ctyStats=window.FreeRig710FT8CTY?.stats?.()||{};
        if(wantedSchema>haveSchema && ctyStats.loaded){
          if(status)status.textContent="Reconciling callsign/DXCC country index…";
          await lb.reconcileCtyMetadata?.();
          await lb.rebuildIndices();
          await lb.setPreference?.("countryKeySchema",wantedSchema);
        } else if(wantedSchema>haveSchema && !ctyStats.loaded) {
          console.warn("FT8 CTY database unavailable; country migration deferred",ctyStats.error||"");
        }
      } catch(error) { console.warn("FT8 CTY/country index migration",error); }
      await renderIndexCount();
    },

    initQsoLogging() {
      const dialog=id("ft8-log-dialog"), form=id("ft8-log-form"), auto=id("ft8-auto-log-qrz");
      id("ft8-log-qso")?.addEventListener("click",()=>{if(this.currentLocalQsoRecord)this.openLogDialog(this.currentLocalQsoRecord);else void this.handleCompletedQso(this.qsoMachine?.snapshot?.());});
      id("ft8-log-close")?.addEventListener("click",()=>dialog?.close?.());
      form?.addEventListener("submit",event=>{event.preventDefault();void this.submitCurrentQsoToQrz();});
      auto?.addEventListener("change",()=>void window.FreeRig710FT8Logbook?.setPreference?.("autoLogCompletedQso",Boolean(auto.checked)));
      void (async()=>{try{const v=await window.FreeRig710FT8Logbook?.getPreference?.("autoLogCompletedQso",false);if(auto)auto.checked=Boolean(v);}catch(_){}})();
    },

    completedQsoFields(snapshot) {
      const page=window.FT710_FT8_PAGE?.getOperatingContext?.()||{};
      const started=new Date(Number(snapshot?.startedUnixMs)||this.getServerUnixMs());
      const completed=new Date(Number(snapshot?.completedUnixMs)||this.getServerUnixMs());
      const adifDate=d=>`${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,"0")}${String(d.getUTCDate()).padStart(2,"0")}`;
      const adifTime=d=>`${String(d.getUTCHours()).padStart(2,"0")}${String(d.getUTCMinutes()).padStart(2,"0")}${String(d.getUTCSeconds()).padStart(2,"0")}`;
      const mhz=hz=>Number.isFinite(Number(hz))&&Number(hz)>0?(Number(hz)/1e6).toFixed(6):"";
      return {
        CALL:String(snapshot?.dxCall||"").toUpperCase(),STATION_CALLSIGN:String(this.myCall||"").toUpperCase(),
        QSO_DATE:adifDate(started),TIME_ON:adifTime(started),TIME_OFF:adifTime(completed),
        BAND:String(page.band||"").toUpperCase(),FREQ:mhz(page.frequencyHz),FREQ_RX:mhz(page.rxFrequencyHz),MODE:"FT8",
        RST_SENT:String(snapshot?.txReport||this.txReport||""),RST_RCVD:String(snapshot?.rstRcvd||""),
        GRIDSQUARE:String(snapshot?.dxGrid||"").toUpperCase(),MY_GRIDSQUARE:String(this.myGrid||"").toUpperCase(),
        TX_PWR:Number(page.txPowerW)>0?String(Math.round(Number(page.txPowerW))):"",COMMENT:"",MY_RIG:"Yaesu FT-710",
        APP_FREERIG_STATUS:"LOCAL_SAVED"
      };
    },

    async handleCompletedQso(snapshot=this.qsoMachine?.snapshot?.()) {
      if(!snapshot||!snapshot.dxCall||!["COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED"].includes(snapshot.state))return null;
      const key=`${snapshot.dxCall}|${Number(snapshot.startedUnixMs)||0}`;
      if(this.qsoCompletionKey===key&&this.currentLocalQsoRecord){this.openLogDialog(this.currentLocalQsoRecord);return this.currentLocalQsoRecord;}
      if(this.qsoCompletionPromise)return this.qsoCompletionPromise;
      this.qsoCompletionPromise=(async()=>{
        const lb=window.FreeRig710FT8Logbook;if(!lb)throw new Error("Local logbook unavailable");
        this.qsoCompletionKey=key;
        if(this.qsoMachine?.snapshot?.().state==="COMPLETE")this.syncQsoFromMachine(this.qsoMachine.markLogPending({unixMs:this.getServerUnixMs()}));
        void window.FT710_FT8_PAGE?.haltAutoTx?.("QSO complete",false);
        const fields=this.completedQsoFields(snapshot);
        const saved=await lb.saveLocalQso(fields,{source:"local-ft8"});
        const record=await lb.updateQso(saved.record.id,{logStatus:"LOCAL_SAVED",qrzError:"",fields:{APP_FREERIG_STATUS:"LOCAL_SAVED"}});
        this.currentLocalQsoId=record.id;this.currentLocalQsoRecord=record;
        if(this.qsoMachine&&["LOG_PENDING","COMPLETE"].includes(this.qsoMachine.snapshot().state))this.syncQsoFromMachine(this.qsoMachine.markLocalSaved({unixMs:this.getServerUnixMs()}));
        this.openLogDialog(record);this.renderQso();
        const auto=Boolean(await lb.getPreference("autoLogCompletedQso",false));
        if(auto)await this.submitCurrentQsoToQrz();
        return record;
      })().catch(error=>{const st=id("ft8-log-status");if(st)st.textContent=`Local log failed: ${error?.message||error}`;console.error("FT8 local QSO log",error);return null;}).finally(()=>{this.qsoCompletionPromise=null;});
      return this.qsoCompletionPromise;
    },

    openLogDialog(record) {
      if(!record)return;const f=record.fields||{};const d=v=>String(v||"");
      const date=d(f.QSO_DATE);const toDate=x=>x.length===8?`${x.slice(0,4)}-${x.slice(4,6)}-${x.slice(6,8)}`:"";const toTime=x=>{const z=d(x).replace(/[^0-9]/g,"").padEnd(6,"0");return z?`${z.slice(0,2)}:${z.slice(2,4)}:${z.slice(4,6)}`:"";};
      const values={"ft8-log-call":f.CALL,"ft8-log-grid":f.GRIDSQUARE,"ft8-log-rst-sent":f.RST_SENT,"ft8-log-rst-rcvd":f.RST_RCVD,"ft8-log-date":toDate(date),"ft8-log-time-on":toTime(f.TIME_ON),"ft8-log-time-off":toTime(f.TIME_OFF),"ft8-log-freq":f.FREQ,"ft8-log-band":f.BAND,"ft8-log-power":f.TX_PWR,"ft8-log-comment":f.COMMENT};
      for(const [domId,value] of Object.entries(values)){const el=id(domId);if(el)el.value=d(value);}
      if(id("ft8-log-local-state"))id("ft8-log-local-state").textContent=record.logStatus==="QRZ_LOGGED"?`QRZ LOGID ${record.qrzLogId||"confirmed"}`:"Local copy saved";
      if(id("ft8-log-status"))id("ft8-log-status").textContent=record.qrzError?`QRZ error: ${record.qrzError} · local copy retained`:"The QSO is already stored locally. QRZ can be retried without losing it.";
      const dialog=id("ft8-log-dialog");if(dialog&&!dialog.open){if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");}
    },

    async submitCurrentQsoToQrz() {
      const lb=window.FreeRig710FT8Logbook,post=window.FreeRig710API?.post,api=window.FreeRig710API?.api;if(!this.currentLocalQsoId||!lb||typeof post!=="function"||typeof api!=="function")return;
      const status=id("ft8-log-status"),submit=id("ft8-log-submit");if(submit)submit.disabled=true;
      try{
        const date=String(id("ft8-log-date")?.value||"");const timeOn=String(id("ft8-log-time-on")?.value||"00:00:00");const timeOff=String(id("ft8-log-time-off")?.value||timeOn);
        const dateAdif=date.replaceAll("-","");const timeAdif=v=>v.replaceAll(":","").slice(0,6).padEnd(6,"0");
        const freqMhz=Number(id("ft8-log-freq")?.value);if(!dateAdif||!Number.isFinite(freqMhz)||freqMhz<=0)throw new Error("Date and frequency are required");
        const patch={CALL:String(id("ft8-log-call")?.value||"").trim().toUpperCase(),GRIDSQUARE:String(id("ft8-log-grid")?.value||"").trim().toUpperCase(),RST_SENT:String(id("ft8-log-rst-sent")?.value||"").trim(),RST_RCVD:String(id("ft8-log-rst-rcvd")?.value||"").trim(),QSO_DATE:dateAdif,TIME_ON:timeAdif(timeOn),TIME_OFF:timeAdif(timeOff),FREQ:freqMhz.toFixed(6),BAND:String(id("ft8-log-band")?.value||"").trim().toUpperCase(),TX_PWR:String(id("ft8-log-power")?.value||"").trim(),COMMENT:String(id("ft8-log-comment")?.value||"").trim(),MODE:"FT8",APP_FREERIG_STATUS:"QRZ_PENDING"};
        if(!patch.CALL||!patch.BAND)throw new Error("Call and band are required");
        let record=await lb.replaceLocalQso(this.currentLocalQsoId,patch,{logStatus:"QRZ_PENDING",qrzError:""});this.currentLocalQsoId=record.id;this.currentLocalQsoRecord=record;
        if(this.qsoMachine)this.syncQsoFromMachine(this.qsoMachine.markQrzPending({unixMs:this.getServerUnixMs()}));
        if(status)status.textContent="Sending local QSO to QRZ…";
        const original=record.fields||{};const hz=Math.round(freqMhz*1e6);const rxHz=Number(original.FREQ_RX)>0?Math.round(Number(original.FREQ_RX)*1e6):hz;
        const accepted=await post("/api/v1/qrz/log",{call:patch.CALL,grid:patch.GRIDSQUARE,my_grid:original.MY_GRIDSQUARE||this.myGrid,rst_sent:patch.RST_SENT,rst_rcvd:patch.RST_RCVD,mode:"FT8",timestamp_utc:`${date}T${timeOn}Z`,timestamp_off_utc:`${date}T${timeOff}Z`,frequency_hz:hz,rx_frequency_hz:rxHz,band:patch.BAND,tx_power_w:Number(patch.TX_PWR)||0,comment:patch.COMMENT,my_rig:original.MY_RIG||"Yaesu FT-710"});
        const jobId=Number(accepted?.job?.job_id||0);if(!jobId)throw new Error("QRZ worker did not return a job id");let job=accepted.job;const deadline=Date.now()+20000;
        while(["queued","running"].includes(job?.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,300));const r=await api("/api/v1/qrz/log/status");if(Number(r?.job?.job_id)===jobId)job=r.job;}
        if(job?.state!=="ok")throw new Error(job?.detail||"QRZ logging not confirmed");
        const logid=String(job?.qso?.logid||"");record=await lb.updateQso(this.currentLocalQsoId,{logStatus:"QRZ_LOGGED",qrzLogId:logid,qrzError:"",fields:{APP_FREERIG_STATUS:"QRZ_LOGGED",...(logid?{APP_QRZLOG_LOGID:logid}:{})}});this.currentLocalQsoRecord=record;
        if(this.qsoMachine)this.syncQsoFromMachine(this.qsoMachine.markQrzLogged({unixMs:this.getServerUnixMs()}));
        if(status)status.textContent=`QRZ logged${logid?` · LOGID ${logid}`:""}`;if(id("ft8-log-local-state"))id("ft8-log-local-state").textContent=logid?`QRZ LOGID ${logid}`:"QRZ confirmed";
        const dialog=id("ft8-log-dialog");if(dialog?.open)dialog.close();
      }catch(error){
        const msg=error?.message||String(error);if(this.currentLocalQsoId&&lb){try{this.currentLocalQsoRecord=await lb.updateQso(this.currentLocalQsoId,{logStatus:"LOCAL_SAVED",qrzError:msg,fields:{APP_FREERIG_STATUS:"LOCAL_SAVED"}});}catch(_){}}
        if(this.qsoMachine?.snapshot?.().state==="QRZ_PENDING")this.syncQsoFromMachine(this.qsoMachine.markLocalSaved({unixMs:this.getServerUnixMs()}));if(status)status.textContent=`QRZ failed: ${msg} · local QSO retained`;
      }finally{if(submit)submit.disabled=false;this.renderQso();}
    },

    async waitQrzFetchJob(jobId, deadlineMs = 20000) {
      const api = window.FreeRig710API?.api;
      if (typeof api !== "function") throw new Error("API unavailable");
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        const status = await api("/api/v1/qrz/fetch/status");
        const job = status?.job;
        if (Number(job?.job_id) !== Number(jobId)) { await new Promise(r => setTimeout(r, 250)); continue; }
        if (job.state === "ok" || job.state === "error" || job.state === "cancelled") return job;
        await new Promise(r => setTimeout(r, 300));
      }
      throw new Error("QRZ FETCH timeout");
    },

    async runQrzSync(renderIndexCount = null) {
      if (this.qrzSyncRunning) return;
      const lb = window.FreeRig710FT8Logbook, api = window.FreeRig710API?.api, post = window.FreeRig710API?.post;
      if (!lb || typeof api !== "function" || typeof post !== "function") return;
      const statusEl=id("ft8-qrz-sync-status"), sync=id("ft8-qrz-sync");
      this.qrzSyncRunning=true;
      if(sync)sync.disabled=true;
      let totalParsed=0,totalFetched=0,totalErrors=0,pages=0;
      const stagedRecords=[];
      try {
        const qrz = await api("/api/v1/qrz/status");
        if (!qrz?.qrz?.configured) throw new Error("Configure station callsign and QRZ Logbook API key first");
        await window.FreeRig710FT8CTY?.ready;
        // QRZ Sync is the authoritative logbook reconciliation.  Always fetch
        // the complete QRZ log from LOGID 0, stage it in memory, and replace
        // IndexedDB only after every page has completed successfully.  A failed
        // sync failure therefore leaves the previous local log untouched.
        let after = "0";
        if(statusEl)statusEl.textContent="QRZ Sync · authoritative full reconciliation from LOGID 0";
        for (;;) {
          let job=null,lastError=null;
          for(let attempt=0;attempt<3;attempt+=1){
            try{
              const accepted=await post("/api/v1/qrz/fetch",{after_logid:after,max:250});
              job=await this.waitQrzFetchJob(Number(accepted?.job?.job_id||0));
              if(job?.state!=="ok") throw new Error(job?.detail||"QRZ FETCH rejected");
              lastError=null;break;
            }catch(error){lastError=error;if(error?.name==="AbortError")throw error;if(attempt<2)await new Promise(r=>setTimeout(r,1000*(2**attempt)));}
          }
          if(lastError)throw lastError;
          const pageResponse=await fetch(window.FreeRig710API.apiUrl("/api/v1/qrz/fetch/page"),{cache:"no-store"});
          if(!pageResponse.ok)throw new Error(`QRZ page HTTP ${pageResponse.status}`);
          const adif=await pageResponse.text();
          const parsed=adif.trim()?lb.parseAdi(adif):{records:[],stats:{records:0,errors:0,ignored:0,errorMessages:[]}};
          const pageParsed=Number(parsed?.stats?.records||0), pageErrors=Number(parsed?.stats?.errors||0);
          if(Number(job?.count||0)>0 && pageParsed===0) throw new Error(`QRZ returned ${job?.count||0} QSO but the ADIF parser produced 0 records`);
          stagedRecords.push(...(parsed?.records||[]));
          pages+=1;totalFetched+=Number(job?.count||0);totalParsed+=pageParsed;totalErrors+=pageErrors;
          after=String(job?.next_after_logid||after);
          if(statusEl)statusEl.textContent=`QRZ page ${pages} · ${job?.count||0} fetched / ${pageParsed} parsed · ${totalParsed} staged`;
          if(!job?.has_more || Number(job?.count||0)===0)break;
        }
        if(statusEl)statusEl.textContent=`QRZ Sync · replacing local log with ${totalParsed} QRZ QSO…`;
        const replaced=await lb.replaceAllRecords(stagedRecords,{source:"qrz"});
        await lb.setSyncState("qrz",{nextAfterLogId:after,lastPageCount:pages?Number(stagedRecords.length):0,lastSyncAt:new Date().toISOString(),complete:true,authoritative:true,qsoCount:Number(replaced?.stored||0)});
        const counts=typeof renderIndexCount==="function" ? await renderIndexCount() : await lb.loadIndexCaches();
        window.dispatchEvent(new CustomEvent("freerig-ft8-logbook-updated"));
        if(statusEl)statusEl.textContent=`QRZ complete · ${pages} page${pages===1?"":"s"} · ${totalFetched} fetched · ${replaced?.stored||0} QRZ QSO stored · ${replaced?.duplicates||0} duplicate records · ${counts?.calls||0} worked calls · ${counts?.dxcc||0} DXCC · ${counts?.countries||0} countries${totalErrors?` · ${totalErrors} ADIF warnings`:""}`;
      } catch(error) {
        if(statusEl)statusEl.textContent=`QRZ sync failed: ${error?.message||error} · local log unchanged`;
      } finally {
        this.qrzSyncRunning=false;if(sync)sync.disabled=false;
      }
    },

    renderSelectedWorked() {
      const el = id("ft8-selected-worked"); if (!el) return;
      const call = this.qso?.dxCall || "";
      if (!call) { el.textContent = "Select a station to show worked-before history."; return; }
      const info = window.FreeRig710FT8Logbook?.lookupCall?.(call);
      if (!info) { el.textContent = `${call}: not worked in the local logbook.`; return; }
      const last = info.lastQso ? `${info.lastQso.slice(0,4)}-${info.lastQso.slice(4,6)}-${info.lastQso.slice(6,8)} ${info.lastQso.slice(8,10)}:${info.lastQso.slice(10,12)} UTC` : "unknown";
      el.textContent = `${call}: worked ${info.count}× · bands ${info.bands.join(", ") || "--"} · modes ${info.modes.join(", ") || "--"} · last ${last}${info.country ? ` · ${info.country}` : ""}`;
    },

    parseMessage(text) {
      const raw = String(text || "").trim().toUpperCase().replace(/[−–—]/g, "-").replace(/[＋﹢]/g, "+").replace(/\s+/g, " ");
      const tokens = raw.split(" ").filter(Boolean);
      const parsed = { raw, kind: "OTHER", from: "", to: "", call: "", grid: "", payload: "", cqModifier: "" };
      if (!tokens.length) return parsed;
      if (tokens[0] === "CQ") {
        parsed.kind = "CQ";
        const last = tokens[tokens.length - 1];
        if (GRID_RE.test(last) && tokens.length >= 3) { parsed.grid = last; parsed.call = normalizeCall(tokens[tokens.length - 2]); }
        else if (tokens.length >= 2) parsed.call = normalizeCall(tokens[tokens.length - 1]);
        if (tokens.length > (parsed.grid ? 3 : 2)) parsed.cqModifier = tokens.slice(1, parsed.grid ? -2 : -1).join(" ");
        parsed.from = parsed.call;
        return parsed;
      }
      if (tokens.length >= 3 && isCall(tokens[0]) && isCall(tokens[1])) {
        parsed.to = normalizeCall(tokens[0]); parsed.from = normalizeCall(tokens[1]); parsed.payload = tokens.slice(2).join(" ");
        if (ACK_WORDS.has(tokens[2])) parsed.kind = tokens[2];
        else if (R_REPORT_RE.test(tokens[2])) parsed.kind = "R_REPORT";
        else if (REPORT_RE.test(tokens[2])) parsed.kind = "REPORT";
        else if (GRID_RE.test(tokens[2])) { parsed.kind = "GRID"; parsed.grid = tokens[2]; }
        else parsed.kind = "DIRECTED";
      }
      return parsed;
    },

    addDecode(slotStartUnixMs, result, slotIndex = Math.floor(slotStartUnixMs / SLOT_MS)) {
      const dt = Number(result?.dt ?? 0), df = Number(result?.df ?? 0), db = Number(result?.db ?? 0);
      const snrEstimate = Number(result?.snr);
      const text = String(result?.text ?? "").trim();
      if (!text) return;
      const timestamp = new Date(slotStartUnixMs + Math.max(0, dt) * 1000).toISOString().slice(11, 19);
      const key = `${slotStartUnixMs}|${Math.round(df)}|${text}`;
      if (this.decodeRows.some((row) => row.key === key)) return;
      const parsed = this.parseMessage(text);
      const row = { key, time: timestamp, db, snr: Number.isFinite(snrEstimate) ? snrEstimate : db, dt, df, text, parsed, slotIndex, unixMs:slotStartUnixMs + Math.max(0,dt)*1000 };
      this.decodeRows.unshift(row);
      this.advanceQsoFromRow(row);
      if (this.decodeRows.length > MAX_ROWS) this.decodeRows.length = MAX_ROWS;
    },

    renderDecodeRows() {
      const rulesApi=window.FreeRig710FT8DecodeRules; const context=this.decodeRuleContext();
      const filters=this.decodeFilters||rulesApi?.DEFAULT_FILTERS||{};
      const filteredRows=rulesApi ? this.decodeRows.filter(row=>rulesApi.passes(row,filters,context)) : this.decodeRows;
      const renderBody = (body, rows, emptyText, rxFrequency = false) => {
        if (!body) return;
        body.textContent = "";
        if (!rows.length) {
          const tr = document.createElement("tr"); tr.className = "ft8-empty-row";
          const td = document.createElement("td"); td.colSpan = 6; td.textContent = emptyText; tr.appendChild(td); body.appendChild(tr); return;
        }
        for (const row of rows) {
          const tr = document.createElement("tr");
          const isTx=Boolean(row.isTx);
          tr.title = isTx ? `Local FT8 transmission${row.waveformId?` · waveform ${row.waveformId}`:""}` : (rxFrequency ? "Select this station/QSO" : "Click to call this decoded station");
          if(!isTx)tr.tabIndex=0;
          if (row.parsed?.kind === "CQ") tr.classList.add("ft8-row-cq");
          if (this.myCall && row.parsed?.to === this.myCall) tr.classList.add("ft8-row-mycall");
          if (this.qso.dxCall && row.parsed?.from === this.qso.dxCall) tr.classList.add("ft8-row-selected-dx");
          const meta=isTx?{}:(rulesApi?.enrich(row,context)||{}); const worked=meta.worked;
          if (worked) { tr.classList.add("ft8-row-worked"); tr.title += ` · ${meta.call} worked ${worked.count}×`; }
          if (rxFrequency) tr.classList.add("ft8-row-rx-frequency");
          if(isTx)tr.classList.add("ft8-row-local-tx");
          if(!isTx){const rule=rulesApi?.winningRule(row,this.colorRules,context,filters); if(rule){tr.dataset.rule=rule.id;tr.style.color=rule.fg;tr.style.backgroundColor=rule.bg;tr.title += ` · ${rule.label}`;}}
          if(!isTx){
            const select = () => {
              const accepted=this.selectDecode(row);
              if(accepted) window.FT710_FT8_PAGE?.rearmAutoTxFromSelection?.();
              return accepted;
            };
            tr.addEventListener("click", select);
            tr.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
          }
          const workedText=isTx?"--":(worked ? `${worked.count}×${meta.workedBand?" · band":""}` : (meta.newDxcc?"NEW DXCC":(meta.newCountry?"NEW COUNTRY":(meta.call?"NEW CALL":"--"))));
          if(!isTx) tr.title += ` · DT ${Number(row.dt).toFixed(2)} s · DF ${Math.round(Number(row.df))} Hz`;
          const values=isTx
            ? [row.time,"Tx",row.text,this.myCall||"--"]
            : [row.time,Number(row.snr).toFixed(1),row.text,meta.call||"--"];
          for (const value of values) { const td=document.createElement("td");td.textContent=value;tr.appendChild(td); }
          const geoTd=document.createElement("td"); geoTd.className="ft8-geo-cell";
          if(isTx){geoTd.textContent="LOCAL";}
          else {
            const primary=[meta.continent,meta.country].filter(Boolean).join(" · ") || meta.dxcc || "--";
            const secondary=[meta.state,meta.city ? `${meta.geoApproximate?"~":""}${meta.city}` : ""].filter(Boolean).join(" · ");
            const top=document.createElement("div");top.className="ft8-geo-primary";top.textContent=primary;geoTd.appendChild(top);
            if(secondary){const sub=document.createElement("div");sub.className="ft8-geo-secondary";sub.textContent=secondary;geoTd.appendChild(sub);}
            const details=[];
            if(meta.grid)details.push(meta.grid);
            if(meta.dxcc)details.push(`DXCC ${meta.dxcc}`);
            if(meta.ctyName)details.push(`${meta.ctyName}${meta.ctyEntity?` · CTY ${meta.ctyEntity}`:""}`);
            if(meta.ctySource)details.push(meta.ctySource);
            if(meta.geoSource)details.push(meta.geoSource);
            if(meta.geoCountryConflict)details.push("Maidenhead country conflicts with callsign entity; region/city suppressed");
            if(meta.geoApproximate&&!meta.geoCountryConflict)details.push("location approximate from Maidenhead grid");
            if(meta.geoNearby&&meta.geoNearbyDistanceKm)details.push(`nearest populated place ~${Math.round(meta.geoNearbyDistanceKm)} km from grid centre`);
            if(details.length)geoTd.title=details.join(" · ");
          }
          tr.appendChild(geoTd);
          const workedTd=document.createElement("td");workedTd.textContent=workedText;tr.appendChild(workedTd);
          body.appendChild(tr);
        }
      };

      renderBody(id("ft8-decodes-body"), filteredRows, this.enabled ? "No FT8 decodes match current filters" : "Select a band to start FT8 RX");
      const rxBody = id("ft8-rx-decodes-body");
      if (rxBody) {
        if (this.qso.df == null) renderBody(rxBody, [], "Click a station in Band Activity");
        else {
          const rxRows = filteredRows.filter((row) => Math.abs(Number(row.df) - Number(this.qso.df)) <= 30 || row.parsed?.to===this.myCall || (this.qso.dxCall && row.parsed?.from===this.qso.dxCall));
          const txRows=this.txActivityRows.filter(row=>Math.abs(Number(row.df)-Number(this.qso.df))<=30);
          const activity=[...rxRows,...txRows].sort((a,b)=>(Number(b.unixMs)||Number(b.slotIndex)*SLOT_MS)-(Number(a.unixMs)||Number(a.slotIndex)*SLOT_MS));
          renderBody(rxBody, activity, `No activity near ${Math.round(this.qso.df)} Hz`, true);
        }
      }
    },

    async refreshStationIdentity() {
      if (typeof window.FreeRig710API?.api !== "function") return;
      try {
        const result = await window.FreeRig710API.api("/api/v1/qrz/status");
        this.myCall = normalizeCall(result?.qrz?.station_callsign || result?.station_callsign);
        this.renderQso();
      } catch (_) {}
    },

    selectDecode(row) {
      const page=window.FT710_FT8_PAGE;
      if(page?.canReplanQso && !page.canReplanQso())return false;
      if(["COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED","ABORTED","TIMEOUT","ERROR"].includes(this.qso?.state)){this.currentLocalQsoId="";this.currentLocalQsoRecord=null;this.qsoCompletionKey="";}
      const p = row?.parsed || this.parseMessage(row?.text);
      const dx = normalizeCall(p.kind === "CQ" ? p.call : (p.from !== this.myCall ? p.from : p.to));
      if (!isCall(dx) || dx === this.myCall) return false;
      const rxParity = Number(row.slotIndex) & 1;
      if(this.qsoMachine){
        this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid,txReport:this.txReport});
        const before=this.qsoMachine.snapshot();
        const terminal=["IDLE","COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED","ABORTED","TIMEOUT","ERROR"].includes(before.state);
        const replacingStoppedQso=!terminal&&Boolean(before.dxCall)&&before.dxCall!==dx&&Boolean(page?.canTakeOverStoppedQso?.());
        if(!terminal&&before.dxCall&&before.dxCall!==dx&&!replacingStoppedQso)return false;
        this.syncQsoFromMachine(this.qsoMachine.resumeFromRx({parsed:p,text:row.text||"",snr:row.snr,df:Math.round(Number(row.df||0)),slotIndex:row.slotIndex,unixMs:this.getServerUnixMs(),force:replacingStoppedQso}));
      } else this.qso = { state: p.kind === "CQ" ? "ANSWERING_CQ" : "SELECTED", dxCall: dx, dxGrid: p.grid || "", df: Math.round(Number(row.df || 0)), rxSlotParity: rxParity, txSlotParity: rxParity ^ 1, lastHeard: row.text, lastHeardUnixMs: Date.now(), startedUnixMs: Date.now(), nextMessage: "" };
      this.updateTxReportFromRow(row);
      window.FT710_FT8_PAGE?.qsoSelected?.({ df: this.qso.df, rxSlotParity: this.qso.rxSlotParity, txSlotParity: this.qso.txSlotParity, dxCall: this.qso.dxCall });
      this.renderDecodeRows(); this.renderQso();
      return true;
    },

    updateTxReportFromRow(row) {
      const snr = Number(row?.snr);
      if (!Number.isFinite(snr)) return;
      const value = clamp(Math.round(snr), -30, 30);
      this.txReport = `${value >= 0 ? "+" : "-"}${String(Math.abs(value)).padStart(2, "0")}`;
      const input = id("ft8-tx-report");
      if (input) { input.value = String(value); input.title = `Auto from latest decoded SNR estimate: ${snr.toFixed(1)} dB/2500 Hz`; }
      if (this.qsoMachine?.setReport) this.syncQsoFromMachine(this.qsoMachine.setReport(this.txReport));
    },

    advanceQsoFromRow(row, force = false) {
      const p = row.parsed || this.parseMessage(row.text);
      if(this.qsoMachine){
        this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid});
        const before=this.qsoMachine.snapshot();
        const snap=this.qsoMachine.onRx({parsed:p,text:row.text,snr:row.snr,slotIndex:row.slotIndex,unixMs:Date.now(),df:row.df});
        if(force||snap.state!==before.state||snap.dxCall!==before.dxCall||snap.lastHeard!==before.lastHeard)this.syncQsoFromMachine(snap);
        return;
      }
      if (!this.qso.dxCall) return;
    },

    recomputeQsoNext() {
      if(this.qsoMachine){this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid,txReport:this.txReport});this.syncQsoFromMachine(this.qsoMachine.snapshot());return;}
    },

    resetQso() {
      const page=window.FT710_FT8_PAGE;
      if(page?.canReplanQso && !page.canReplanQso())return;
      this.currentLocalQsoId="";this.currentLocalQsoRecord=null;this.qsoCompletionKey="";
      if(this.qsoMachine)this.syncQsoFromMachine(this.qsoMachine.reset());
      else {this.qso = { state: "IDLE", dxCall: "", dxGrid: "", df: null, rxSlotParity: null, txSlotParity: 0, lastHeard: "", lastHeardUnixMs: 0, startedUnixMs: 0, nextMessage: "" };this.renderDecodeRows();this.renderQso();}
    },

    abortQso(reason = "operator halt") {
      if (!this.qsoMachine) return;
      const snap = this.qsoMachine.abort(reason, {unixMs:this.getServerUnixMs()});
      this.syncQsoFromMachine(snap);
    },

    failQso(reason = "FT8 TX error") {
      if (!this.qsoMachine) return;
      const before = this.qsoMachine.snapshot();
      if (["IDLE","COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED","ABORTED","TIMEOUT","ERROR"].includes(before.state)) return;
      this.syncQsoFromMachine(this.qsoMachine.markError(reason, {unixMs:this.getServerUnixMs()}));
    },

    renderQso() {
      const q = this.qso;
      if (id("ft8-my-call")) id("ft8-my-call").textContent = this.myCall || "not configured in QRZ";
      if (id("ft8-dx-call")) id("ft8-dx-call").value = q.dxCall || "";
      if (id("ft8-dx-grid")) id("ft8-dx-grid").value = q.dxGrid || "";
      if (id("ft8-qso-state")) id("ft8-qso-state").textContent = q.state.replaceAll("_", " ");
      if (id("ft8-qso-df")) id("ft8-qso-df").textContent = q.df == null ? "--" : `${q.df} Hz`;
      if (id("ft8-qso-slot")) id("ft8-qso-slot").textContent = q.rxSlotParity == null ? `TX ${q.txSlotParity ? "ODD" : "EVEN"}` : `${q.rxSlotParity ? "ODD" : "EVEN"} RX → ${q.txSlotParity ? "ODD" : "EVEN"} TX`;
      if (id("ft8-rx-frequency-label")) id("ft8-rx-frequency-label").textContent = q.df == null ? "No QSO selected" : `${Math.round(q.df)} Hz · ${q.dxCall || "selected frequency"}`;
      if (id("ft8-qso-last")) id("ft8-qso-last").textContent = q.lastHeard || "--";
      if (id("ft8-qso-next")) id("ft8-qso-next").textContent = q.nextMessage || "Select a CQ or decoded station";
      if (id("ft8-reset-qso")) id("ft8-reset-qso").disabled = !q.dxCall;
      if (id("ft8-log-qso")) id("ft8-log-qso").disabled = !this.currentLocalQsoId && !["COMPLETE","LOG_PENDING","LOGGED_LOCAL","QRZ_PENDING","QRZ_LOGGED"].includes(q.state);
      const me=this.myCall||"MYCALL",dx=q.dxCall||"DXCALL",grid=this.myGrid||"GRID";
      const sequenceReport = /^[+-]\d{2}$/.test(String(q.txReport || "")) ? q.txReport : this.txReport;
      const seq={INITIAL:`${dx} ${me} ${grid}`,REPORT:`${dx} ${me} ${sequenceReport}`,R_REPORT:`${dx} ${me} R${sequenceReport}`,RR73:`${dx} ${me} RR73`,"73":`${dx} ${me} 73`};
      const activeStage=({SELECTED:"INITIAL",ANSWERING_CQ:"INITIAL",WAIT_DX_REPORT:"INITIAL",SEND_REPORT:"REPORT",WAIT_R_REPORT:"REPORT",SEND_R_REPORT:"R_REPORT",WAIT_RR73:"R_REPORT",SEND_RR73:"RR73",WAIT_73:"RR73",SEND_73:"73",COMPLETE:"73",LOG_PENDING:"73",LOGGED_LOCAL:"73",QRZ_PENDING:"73",QRZ_LOGGED:"73"})[q.state]||"";
      document.querySelectorAll("[data-qso-stage]").forEach(button=>{const stage=button.dataset.qsoStage;button.textContent=seq[stage]||stage;button.disabled=!q.dxCall;button.classList.toggle("active",stage===activeStage);button.setAttribute("aria-pressed",stage===activeStage?"true":"false");});
      if(id("ft8-cq-preview"))id("ft8-cq-preview").textContent=grid?`CQ ${me} ${grid}`:`CQ ${me}`;
      this.renderSelectedWorked();
      const stepper=id("ft8-qso-stepper");if(stepper){const state=q.state;const order={IDLE:-1,SELECTED:0,ANSWERING_CQ:1,CALLING_CQ:1,WAIT_DX_REPORT:1,SEND_REPORT:2,WAIT_R_REPORT:2,SEND_R_REPORT:2,WAIT_RR73:3,SEND_RR73:3,WAIT_73:4,SEND_73:4,COMPLETE:5,LOG_PENDING:5,LOGGED_LOCAL:5,QRZ_PENDING:5,QRZ_LOGGED:5,ABORTED:1,TIMEOUT:1,ERROR:1};const current=order[state]??0;Array.from(stepper.children).forEach((el,i)=>{el.classList.toggle("done",i<current);el.classList.toggle("active",i===current);el.classList.toggle("error",["ABORTED","TIMEOUT","ERROR"].includes(state)&&i===current);});}
      window.FT710_FT8_PAGE?.qsoPlanChanged?.(this.getTxPlan());
    },

    drawWaterfallRow() {
      const canvas = id("ft8-waterfall"); if (!canvas) return;
      const ctx = canvas.getContext("2d", { alpha: false });
      const { real, imag } = this.fft.transform(this.fftBuffer), w = canvas.width, h = canvas.height;
      ctx.drawImage(canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
      const row = ctx.createImageData(w, 1);
      for (let x = 0; x < w; x += 1) {
        const freq = FREQ_LOW + (FREQ_HIGH - FREQ_LOW) * x / Math.max(1, w - 1);
        const bin = clamp(Math.round(freq * FFT_SIZE / TARGET_RATE), 1, FFT_SIZE / 2 - 1);
        const power = real[bin] * real[bin] + imag[bin] * imag[bin];
        const db = 10 * Math.log10(power / (FFT_SIZE * FFT_SIZE) + 1e-12), level = clamp((db + 82) / 58, 0, 1);
        let r=0,g=0,b=0;
        if(level<0.18){const t=level/0.18;r=2;g=Math.round(10+38*t);b=Math.round(45+155*t);}
        else if(level<0.38){const t=(level-0.18)/0.20;r=0;g=Math.round(48+190*t);b=Math.round(200-55*t);}
        else if(level<0.58){const t=(level-0.38)/0.20;r=Math.round(15+80*t);g=Math.round(238-18*t);b=Math.round(145-120*t);}
        else if(level<0.76){const t=(level-0.58)/0.18;r=Math.round(95+160*t);g=Math.round(220+25*t);b=Math.round(25-20*t);}
        else if(level<0.90){const t=(level-0.76)/0.14;r=255;g=Math.round(245-145*t);b=Math.round(5+5*t);}
        else{const t=(level-0.90)/0.10;r=255;g=Math.round(100-70*t);b=Math.round(10+20*t);}
        const o=x*4;row.data[o]=r;row.data[o+1]=g;row.data[o+2]=b;row.data[o+3]=255;
      }
      ctx.putImageData(row, 0, 0);
    },

    renderAudioMetrics(sampleRate) {
      id("ft8-rx-tap").textContent = `${sampleRate} Hz · ${(this.totalInputSamples / sampleRate).toFixed(1)} s observed`;
      id("ft8-audio-level").textContent = `${this.displayLevelDb.toFixed(1)} dBFS · 1 s RMS`;
      if (this.firstAudioPerf != null && this.totalInputSamples > sampleRate * 5) {
        const elapsedWall = Math.max(1, performance.now() - this.firstAudioPerf), elapsedAudio = this.totalInputSamples * 1000 / sampleRate;
        const ppm = (elapsedAudio / elapsedWall - 1) * 1e6;
        id("ft8-sample-clock").textContent = `${ppm >= 0 ? "+" : ""}${ppm.toFixed(0)} ppm`;
      }
      if (this.chunkIntervals.length > 8) {
        const mean = this.chunkIntervals.reduce((a, b) => a + b, 0) / this.chunkIntervals.length;
        const variance = this.chunkIntervals.reduce((a, v) => a + (v - mean) ** 2, 0) / this.chunkIntervals.length;
        id("ft8-jitter").textContent = `${Math.sqrt(variance).toFixed(1)} ms RMS · mean ${mean.toFixed(1)}`;
      }
    },

    animateClock() {
      const now = this.getServerUnixMs(), phase = ((now % SLOT_MS) + SLOT_MS) % SLOT_MS, slotIndex = Math.floor(now / SLOT_MS), next = SLOT_MS - phase;
      id("ft8-utc").textContent = new Date(now).toISOString().slice(11, 23);
      id("ft8-slot").textContent = `${slotIndex % 2 === 0 ? "EVEN" : "ODD"} · ${slotIndex}`;
      id("ft8-next").textContent = `${(next / 1000).toFixed(2)} s`;
      const progress = id("ft8-timing-progress"); if (progress) progress.style.width = `${phase * 100 / SLOT_MS}%`;
      if (this.qsoMachine && this.lastQsoSlotTick !== slotIndex) {
        this.lastQsoSlotTick = slotIndex;
        const before = this.qsoMachine.snapshot();
        const snap = this.qsoMachine.onSlot({slotIndex, ownSlot:(slotIndex & 1) === (Number(before.txSlotParity) & 1), unixMs:now});
        if (snap.state !== before.state || snap.silentSlots !== before.silentSlots) this.syncQsoFromMachine(snap);
      }
      this.animationFrame = window.requestAnimationFrame(() => this.animateClock());
    },

    sendTimingProbe() {
      if (!this.controlSender) return;
      this.controlSender({ type: "timing_probe", client_unix_ms: Date.now(), client_perf_ms: performance.now() });
    },

    handleControl(message) {
      if (!message || message.type !== "timing_probe") return;
      const receivedPerf = performance.now(), rtt = Math.max(0, receivedPerf - Number(message.client_perf_ms || receivedPerf));
      if (message.clock_valid && Number.isFinite(Number(message.server_unix_ms))) {
        const browserMid = Number(message.client_unix_ms) + rtt / 2, delta = Number(message.server_unix_ms) - browserMid;
        this.serverClockValid = true;
        this.serverClockRttMs = rtt;
        this.serverClockDeltaMs = Number.isFinite(this.serverClockDeltaMs)
          ? this.serverClockDeltaMs * 0.7 + delta * 0.3
          : delta;
        id("ft8-server-clock").textContent = `SNTP valid · RTT ${rtt.toFixed(1)} ms`;
        id("ft8-clock-delta").textContent = `${this.serverClockDeltaMs >= 0 ? "+" : ""}${this.serverClockDeltaMs.toFixed(1)} ms`;
        const clockBadge = id("ft8-clock-state");
        if (clockBadge) {
          clockBadge.textContent = "CLOCK SYNC";
          clockBadge.classList.add("live");
          clockBadge.classList.remove("warning", "error");
        }
      } else {
        this.serverClockValid = false;
        this.serverClockRttMs = rtt;
        id("ft8-server-clock").textContent = `ESP32 UTC not synchronized · RTT ${rtt.toFixed(1)} ms`;
        id("ft8-clock-delta").textContent = "browser UTC only";
        const clockBadge = id("ft8-clock-state");
        if (clockBadge) {
          clockBadge.textContent = "CLOCK WAIT";
          clockBadge.classList.add("warning");
          clockBadge.classList.remove("live", "error");
        }
      }
    },

    async refreshServerStatus() {
      if (typeof window.FreeRig710API?.api !== "function") return;
      try {
        const result = await window.FreeRig710API.api("/api/v1/ft8/status"), f = result?.ft8 || null;
        this.lastServerStatus = f; if (!f) return;
        const rx = f.audio_rx || {};
        id("ft8-usb-packets").textContent = `${rx.packets_total ?? 0} total · ${rx.packets_skipped ?? 0} skipped · ${rx.packets_error ?? 0} errors`;
        id("ft8-pcm-drops").textContent = `${rx.pcm_stream_dropped_bytes ?? 0} bytes`;
        const clockBadge = id("ft8-clock-state");
        if (f.time_sync?.synced) {
          id("ft8-server-clock").textContent = `SNTP synced · count ${f.time_sync.sync_count ?? 0}`;
          if (clockBadge) { clockBadge.textContent = "CLOCK SYNC"; clockBadge.classList.add("live"); clockBadge.classList.remove("warning", "error"); }
        } else if (f.time_sync?.started) {
          id("ft8-server-clock").textContent = "SNTP waiting for sync";
          if (clockBadge) { clockBadge.textContent = "CLOCK WAIT"; clockBadge.classList.add("warning"); clockBadge.classList.remove("live", "error"); }
        } else {
          id("ft8-server-clock").textContent = "SNTP not started";
          if (clockBadge) { clockBadge.textContent = "CLOCK --"; clockBadge.classList.remove("live", "warning", "error"); }
        }
      } catch (_) {
        id("ft8-server-clock").textContent = "FT8 status API unavailable";
        const clockBadge = id("ft8-clock-state");
        if (clockBadge) { clockBadge.textContent = "CLOCK ERR"; clockBadge.classList.add("error"); clockBadge.classList.remove("live", "warning"); }
      }
    },

    renderStatus() {
      const badge = id("ft8-status"); if (!badge) return;
      badge.className = "ft8-status";
      if (this.enabled && this.audioReady) {
        badge.textContent = this.decoderReady ? "RX DECODE" : "RX ARM"; badge.classList.add("receiving");
        id("ft8-detail").textContent = this.decoderReady
          ? "RX decode and QSO planner active; automatic FT8 TX uses the validated staged 48 kHz ESP32 path."
          : "RX armed while decoder/encoder load; automatic FT8 TX remains staged before the slot.";
        this.sendTimingProbe();
      } else if (!this.audioReady) {
        badge.textContent = "WAIT AUDIO"; badge.classList.add("waiting"); id("ft8-rx-tap").textContent = "waiting for audio";
      } else {
        badge.textContent = "OFF"; id("ft8-rx-tap").textContent = "ready · decoder disabled";
      }
    },
  };

  window.FT710_FT8 = controller;
})();
