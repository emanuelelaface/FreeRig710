"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  const MODES = Object.freeze({
    martin1: Object.freeze({
      key: "martin1", label: "Martin M1", vis: 44,
      width: 320, height: 256, family: "martin",
      syncMs: 4.862, porchMs: 0.572, separatorMs: 0.572, channelMs: 146.432,
    }),
    martin2: Object.freeze({
      key: "martin2", label: "Martin M2", vis: 40,
      width: 320, height: 256, family: "martin",
      syncMs: 4.862, porchMs: 0.572, separatorMs: 0.572, channelMs: 73.216,
    }),
    scottie1: Object.freeze({
      key: "scottie1", label: "Scottie S1", vis: 60,
      width: 320, height: 256, family: "scottie",
      syncMs: 9.0, porchMs: 1.5, separatorMs: 1.5, channelMs: 138.240,
    }),
    scottie2: Object.freeze({
      key: "scottie2", label: "Scottie S2", vis: 56,
      width: 320, height: 256, family: "scottie",
      syncMs: 9.0, porchMs: 1.5, separatorMs: 1.5, channelMs: 88.064,
    }),
    scottiedx: Object.freeze({
      key: "scottiedx", label: "Scottie DX", vis: 76,
      width: 320, height: 256, family: "scottie",
      syncMs: 9.0, porchMs: 1.5, separatorMs: 1.5, channelMs: 345.600,
    }),
    robot36: Object.freeze({
      key: "robot36", label: "Robot 36", vis: 8,
      width: 320, height: 240, family: "robot36",
      syncMs: 9.0, porchMs: 3.0, yMs: 88.0,
      separatorMs: 4.5, separatorPorchMs: 1.5, chromaMs: 44.0,
    }),
    robot72: Object.freeze({
      key: "robot72", label: "Robot 72", vis: 12,
      width: 320, height: 240, family: "robot72",
      syncMs: 9.0, porchMs: 3.0, yMs: 138.0,
      separatorMs: 4.5, separatorPorchMs: 1.5, crMs: 69.0, cbMs: 69.0,
    }),
    pd50: Object.freeze({
      key: "pd50", label: "PD50", vis: 93,
      width: 320, height: 256, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 91.520,
    }),
    pd90: Object.freeze({
      key: "pd90", label: "PD90", vis: 99,
      width: 320, height: 256, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 170.240,
    }),
    pd120: Object.freeze({
      key: "pd120", label: "PD120", vis: 95,
      width: 640, height: 496, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 121.600,
    }),
    pd160: Object.freeze({
      key: "pd160", label: "PD160", vis: 98,
      width: 512, height: 400, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 195.584,
    }),
    pd180: Object.freeze({
      key: "pd180", label: "PD180", vis: 96,
      width: 640, height: 496, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 183.040,
    }),
    pd240: Object.freeze({
      key: "pd240", label: "PD240", vis: 97,
      width: 640, height: 496, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 244.480,
    }),
    pd290: Object.freeze({
      key: "pd290", label: "PD290", vis: 94,
      width: 800, height: 616, family: "pd",
      syncMs: 20.0, porchMs: 2.08, channelMs: 228.800,
    }),
  });

  const VIS_TO_MODE = new Map(Object.values(MODES).map((mode) => [mode.vis, mode.key]));
  const SSTV_TX_SAMPLE_RATE = 48000;
  const SSTV_TX_MAX_BYTES = 12 * 1024 * 1024;
  const SSTV_TX_DEFAULT_LEVEL_DBFS = -30;
  const SSTV_TX_MIN_LEVEL_DBFS = -40;
  const SSTV_TX_MAX_LEVEL_DBFS = -1;
  const SSTV_TX_MODE_KEYS = Object.freeze([
    "robot36", "pd50", "martin2", "scottie2", "robot72", "pd90",
    "scottie1", "martin1", "pd120",
  ]);
  const SSTV_TX_SUPPORTED = new Set(SSTV_TX_MODE_KEYS);
  const SSTV_VIDEO_LOW_HZ = 1500;
  const SSTV_VIDEO_SPAN_HZ = 800;
  const SSTV_VIS_HEADER_MS = 300 + 10 + 300 + 30 * 10;

  function sstvLineDurationMs(mode) {
    if (!mode) return 0;
    if (mode.family === "martin") {
      return mode.syncMs + mode.porchMs + 3 * mode.channelMs + 3 * mode.separatorMs;
    }
    if (mode.family === "scottie") {
      return mode.syncMs + mode.porchMs + 3 * mode.channelMs + 2 * mode.separatorMs;
    }
    if (mode.family === "robot36") {
      return mode.syncMs + mode.porchMs + mode.yMs + mode.separatorMs + mode.separatorPorchMs + mode.chromaMs;
    }
    if (mode.family === "robot72") {
      return mode.syncMs + mode.porchMs + mode.yMs
        + mode.separatorMs + mode.separatorPorchMs + mode.crMs
        + mode.separatorMs + mode.separatorPorchMs + mode.cbMs;
    }
    if (mode.family === "pd") {
      return mode.syncMs + mode.porchMs + 4 * mode.channelMs;
    }
    return 0;
  }

  function sstvTxLineCount(mode) {
    if (!mode) return 0;
    return mode.family === "pd" ? Math.ceil(mode.height / 2) : mode.height;
  }

  function sstvTxDurationSeconds(mode) {
    if (!mode) return 0;
    return (SSTV_VIS_HEADER_MS + sstvLineDurationMs(mode) * sstvTxLineCount(mode)) / 1000;
  }

  function sstvTxByteEstimate(mode) {
    return Math.ceil(sstvTxDurationSeconds(mode) * SSTV_TX_SAMPLE_RATE) * 2;
  }

  class SSTVEncoder {
    constructor(options = {}) {
      this.sampleRate = SSTV_TX_SAMPLE_RATE;
      const requestedDbfs = Number(options.levelDbfs);
      let levelDbfs = SSTV_TX_DEFAULT_LEVEL_DBFS;
      if (Number.isFinite(requestedDbfs)) {
        levelDbfs = clamp(requestedDbfs, SSTV_TX_MIN_LEVEL_DBFS, SSTV_TX_MAX_LEVEL_DBFS);
      } else if (Number.isFinite(Number(options.levelPercent))) {
        const levelPercent = clamp(Number(options.levelPercent), 1, 100);
        levelDbfs = 20 * Math.log10(levelPercent / 100);
      }
      this.levelDbfs = levelDbfs;
      this.amplitude = clamp(
        Math.round(32767 * Math.pow(10, levelDbfs / 20)),
        1,
        32767
      );
      this.phase = 0;
      this.twoPi = 2 * Math.PI;
      this.pcm = new Int16Array(0);
      this.offset = 0;
    }

    build(modeKey, imageData, callbacks = {}) {
      const mode = MODES[modeKey];
      if (!mode) throw new Error("Unsupported SSTV mode");
      if (!imageData || imageData.width !== mode.width || imageData.height !== mode.height) {
        throw new Error("SSTV image buffer does not match selected mode");
      }
      this.phase = 0;
      this.offset = 0;
      this.pcm = new Int16Array(this.estimateSamples(mode) + this.sampleRate);
      this.appendVisHeader(mode.vis);

      if (mode.family === "martin") this.appendMartin(mode, imageData, callbacks);
      else if (mode.family === "scottie") this.appendScottie(mode, imageData, callbacks);
      else if (mode.family === "robot36") this.appendRobot36(mode, imageData, callbacks);
      else if (mode.family === "robot72") this.appendRobot72(mode, imageData, callbacks);
      else if (mode.family === "pd") this.appendPd(mode, imageData, callbacks);
      else throw new Error("Unsupported SSTV mode family");

      this.applyEdgeRamp();
      return this.pcm.slice(0, this.offset);
    }

    sampleCount(milliseconds) {
      return Math.max(1, Math.round(this.sampleRate * milliseconds / 1000));
    }

    estimateSamples(mode) {
      const tone = (milliseconds) => this.sampleCount(milliseconds);
      let total = tone(300) + tone(10) + tone(300) + tone(30) * 10;
      if (mode.family === "martin") {
        total += mode.height * (
          tone(mode.syncMs) + tone(mode.porchMs)
          + tone(mode.channelMs) * 3 + tone(mode.separatorMs) * 3
        );
      } else if (mode.family === "scottie") {
        total += mode.height * (
          tone(mode.separatorMs) + tone(mode.channelMs)
          + tone(mode.separatorMs) + tone(mode.channelMs)
          + tone(mode.syncMs) + tone(mode.porchMs) + tone(mode.channelMs)
        );
      } else if (mode.family === "robot36") {
        total += mode.height * (
          tone(mode.syncMs) + tone(mode.porchMs) + tone(mode.yMs)
          + tone(mode.separatorMs) + tone(mode.separatorPorchMs) + tone(mode.chromaMs)
        );
      } else if (mode.family === "robot72") {
        total += mode.height * (
          tone(mode.syncMs) + tone(mode.porchMs) + tone(mode.yMs)
          + tone(mode.separatorMs) + tone(mode.separatorPorchMs) + tone(mode.crMs)
          + tone(mode.separatorMs) + tone(mode.separatorPorchMs) + tone(mode.cbMs)
        );
      } else if (mode.family === "pd") {
        total += Math.ceil(mode.height / 2) * (
          tone(mode.syncMs) + tone(mode.porchMs) + tone(mode.channelMs) * 4
        );
      }
      return total;
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
      this.phase += this.twoPi * frequency / this.sampleRate;
      if (this.phase >= this.twoPi) this.phase -= this.twoPi;
    }

    appendTone(frequency, milliseconds) {
      const count = this.sampleCount(milliseconds);
      this.ensureRoom(count);
      for (let index = 0; index < count; index += 1) this.writeSample(frequency);
    }

    appendVideo(values, milliseconds) {
      const count = this.sampleCount(milliseconds);
      const length = values.length;
      this.ensureRoom(count);
      for (let index = 0; index < count; index += 1) {
        const pixel = Math.min(length - 1, Math.floor(index * length / count));
        const frequency = SSTV_VIDEO_LOW_HZ + values[pixel] * SSTV_VIDEO_SPAN_HZ / 255;
        this.writeSample(frequency);
      }
    }

    appendVisHeader(code) {
      this.appendTone(1900, 300);
      this.appendTone(1200, 10);
      this.appendTone(1900, 300);
      this.appendTone(1200, 30);
      let ones = 0;
      for (let bit = 0; bit < 7; bit += 1) {
        const set = (code >> bit) & 1;
        if (set) ones += 1;
        this.appendTone(set ? 1100 : 1300, 30);
      }
      this.appendTone((ones & 1) ? 1100 : 1300, 30);
      this.appendTone(1200, 30);
    }

    applyEdgeRamp() {
      const ramp = Math.min(this.offset, Math.round(this.sampleRate * 0.006));
      if (ramp <= 1) return;
      for (let index = 0; index < ramp; index += 1) {
        const fadeIn = index / ramp;
        const fadeOut = index / ramp;
        this.pcm[index] = Math.round(this.pcm[index] * fadeIn);
        const tail = this.offset - 1 - index;
        this.pcm[tail] = Math.round(this.pcm[tail] * fadeOut);
      }
    }

    rowChannel(imageData, row, channel) {
      const width = imageData.width;
      const values = new Uint8ClampedArray(width);
      const data = imageData.data;
      for (let x = 0; x < width; x += 1) {
        const offset = (row * width + x) * 4;
        values[x] = this.pixelChannel(data[offset], data[offset + 1], data[offset + 2], channel);
      }
      return values;
    }

    averagedChroma(imageData, firstRow, secondRow, channel) {
      const width = imageData.width;
      const values = new Uint8ClampedArray(width);
      const data = imageData.data;
      const rowB = Math.min(imageData.height - 1, secondRow);
      for (let x = 0; x < width; x += 1) {
        const a = (firstRow * width + x) * 4;
        const b = (rowB * width + x) * 4;
        values[x] = Math.round((
          this.pixelChannel(data[a], data[a + 1], data[a + 2], channel)
          + this.pixelChannel(data[b], data[b + 1], data[b + 2], channel)
        ) / 2);
      }
      return values;
    }

    pixelChannel(red, green, blue, channel) {
      if (channel === "red") return red;
      if (channel === "green") return green;
      if (channel === "blue") return blue;
      if (channel === "y") return clamp(Math.round(0.299 * red + 0.587 * green + 0.114 * blue), 0, 255);
      if (channel === "cb") return clamp(Math.round(128 - 0.168736 * red - 0.331264 * green + 0.5 * blue), 0, 255);
      if (channel === "cr") return clamp(Math.round(128 + 0.5 * red - 0.418688 * green - 0.081312 * blue), 0, 255);
      return 0;
    }

    report(callbacks, line, total) {
      callbacks.progress?.({ line, total });
    }

    appendMartin(mode, imageData, callbacks) {
      for (let row = 0; row < mode.height; row += 1) {
        this.appendTone(1200, mode.syncMs);
        this.appendTone(1500, mode.porchMs);
        this.appendVideo(this.rowChannel(imageData, row, "green"), mode.channelMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendVideo(this.rowChannel(imageData, row, "blue"), mode.channelMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendVideo(this.rowChannel(imageData, row, "red"), mode.channelMs);
        this.appendTone(1500, mode.separatorMs);
        if ((row & 15) === 0 || row + 1 >= mode.height) this.report(callbacks, row + 1, mode.height);
      }
    }

    appendScottie(mode, imageData, callbacks) {
      for (let row = 0; row < mode.height; row += 1) {
        this.appendTone(1500, mode.separatorMs);
        this.appendVideo(this.rowChannel(imageData, row, "green"), mode.channelMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendVideo(this.rowChannel(imageData, row, "blue"), mode.channelMs);
        this.appendTone(1200, mode.syncMs);
        this.appendTone(1500, mode.porchMs);
        this.appendVideo(this.rowChannel(imageData, row, "red"), mode.channelMs);
        if ((row & 15) === 0 || row + 1 >= mode.height) this.report(callbacks, row + 1, mode.height);
      }
    }

    appendRobot36(mode, imageData, callbacks) {
      for (let row = 0; row < mode.height; row += 1) {
        this.appendTone(1200, mode.syncMs);
        this.appendTone(1500, mode.porchMs);
        this.appendVideo(this.rowChannel(imageData, row, "y"), mode.yMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendTone(1900, mode.separatorPorchMs);
        this.appendVideo(this.rowChannel(imageData, row, (row & 1) ? "cb" : "cr"), mode.chromaMs);
        if ((row & 15) === 0 || row + 1 >= mode.height) this.report(callbacks, row + 1, mode.height);
      }
    }

    appendRobot72(mode, imageData, callbacks) {
      for (let row = 0; row < mode.height; row += 1) {
        this.appendTone(1200, mode.syncMs);
        this.appendTone(1500, mode.porchMs);
        this.appendVideo(this.rowChannel(imageData, row, "y"), mode.yMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendTone(1900, mode.separatorPorchMs);
        this.appendVideo(this.rowChannel(imageData, row, "cr"), mode.crMs);
        this.appendTone(1500, mode.separatorMs);
        this.appendTone(1900, mode.separatorPorchMs);
        this.appendVideo(this.rowChannel(imageData, row, "cb"), mode.cbMs);
        if ((row & 15) === 0 || row + 1 >= mode.height) this.report(callbacks, row + 1, mode.height);
      }
    }

    appendPd(mode, imageData, callbacks) {
      const totalRows = mode.height;
      for (let row = 0; row < totalRows; row += 2) {
        const secondRow = Math.min(totalRows - 1, row + 1);
        this.appendTone(1200, mode.syncMs);
        this.appendTone(1500, mode.porchMs);
        this.appendVideo(this.rowChannel(imageData, row, "y"), mode.channelMs);
        this.appendVideo(this.averagedChroma(imageData, row, secondRow, "cr"), mode.channelMs);
        this.appendVideo(this.averagedChroma(imageData, row, secondRow, "cb"), mode.channelMs);
        this.appendVideo(this.rowChannel(imageData, secondRow, "y"), mode.channelMs);
        if ((row & 15) === 0 || row + 2 >= totalRows) this.report(callbacks, Math.min(totalRows, row + 2), totalRows);
      }
    }
  }

  class SSTVDecoder {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.enabled = false;
      // VIS is now advisory only. Decoding always runs in the selected mode.
      this.modePreference = "scottie1";
      this.mode = null;
      this.sampleRate = 48000;
      this.decimation = 2;
      this.frequencyRate = this.sampleRate / this.decimation;
      this.ringSeconds = 8;
      this.resetDemodulator();
      this.resetProtocol(false);
    }

    resetDemodulator() {
      this.oscillatorCos = 1;
      this.oscillatorSin = 0;
      this.oscillatorCounter = 0;
      this.decimationCounter = 0;
      this.basebandI1 = 0;
      this.basebandQ1 = 0;
      this.basebandI2 = 0;
      this.basebandQ2 = 0;
      this.previousPhase = null;
      this.unwrappedPhase = 0;
      this.configureForSampleRate(this.sampleRate);
    }

    configureForSampleRate(sampleRate) {
      this.sampleRate = Number(sampleRate) || 48000;
      this.frequencyRate = this.sampleRate / this.decimation;
      const angular = 2 * Math.PI * 1900 / this.sampleRate;
      this.oscillatorStepCos = Math.cos(angular);
      this.oscillatorStepSin = Math.sin(angular);
      this.lowPassAlpha = 1 - Math.exp(-2 * Math.PI * 1400 / this.sampleRate);
      this.frequencyCapacity = Math.max(8192, Math.ceil(this.frequencyRate * this.ringSeconds));
      this.frequencyRing = new Float32Array(this.frequencyCapacity);
      this.magnitudeRing = new Float32Array(this.frequencyCapacity);
      this.phaseRing = new Float64Array(this.frequencyCapacity);
      this.frequencyIndex = 0;
      this.binSamples = Math.max(8, Math.round(this.frequencyRate * 0.005));
      this.binCount = 0;
      this.binFrequencySum = 0;
      this.binMagnitudeSum = 0;
      this.binValidCount = 0;
      this.syncBinSamples = Math.max(4, Math.round(this.frequencyRate * 0.0005));
      this.syncBinCount = 0;
      this.syncBinFrequencySum = 0;
      this.syncBinMagnitudeSum = 0;
      this.syncBinValidCount = 0;
    }

    setEnabled(enabled) {
      const next = Boolean(enabled);
      if (next === this.enabled) return;
      this.enabled = next;
      this.resetDemodulator();
      this.resetProtocol(true);
      if (!next) {
        this.emitStatus("off", "Decoder off");
        return;
      }
      this.activateMode(this.modePreference, "manual");
    }

    setModePreference(modeKey, restart = true) {
      const next = MODES[modeKey] ? modeKey : "scottie1";
      const changed = next !== this.modePreference;
      this.modePreference = next;
      if (!this.enabled || !restart || !changed) return;
      this.resetDemodulator();
      this.resetProtocol(true);
      this.activateMode(next, "manual");
    }

    reset(clearImage = true) {
      this.resetDemodulator();
      this.resetProtocol(clearImage);
      if (!this.enabled) {
        this.emitStatus("off", "Decoder off");
      } else {
        this.activateMode(this.modePreference, "manual");
      }
    }

    resetProtocol(clearImage) {
      this.mode = null;
      this.frequencyOffset = 0;
      this.imageStartIndex = 0;
      this.lineIndex = 0;
      this.lastSyncStart = -Infinity;
      this.lastQueuedSync = -Infinity;
      this.nextExpectedSync = null;
      this.syncCandidates = [];
      this.acquisitionStartedAt = null;
      this.syntheticSinceReal = 0;
      this.segmentRows = 0;
      this.segmentActive = false;
      this.syncRunStart = null;
      this.syncRunFrequencySum = 0;
      this.syncRunValidCount = 0;
      this.syncRunDurationMs = 0;
      this.syncRunValidMs = 0;
      this.syncRunGapMs = 0;
      this.pendingLines = [];
      this.robot36Pair = null;
      this.lastStatusAt = 0;
      this.lastFrequency = 0;
      this.lastMagnitude = 0;
      this.visState = "leader1";
      this.leader1Ms = 0;
      this.leader1Sum = 0;
      this.leader1Count = 0;
      this.breakMs = 0;
      this.leader2Ms = 0;
      this.leader2Sum = 0;
      this.leader2Count = 0;
      this.visBins = [];
      this.visFrequencyOffset = 0;
      if (clearImage) this.callbacks.clearImage?.();
    }

    activateMode(modeKey, source = "vis") {
      const mode = MODES[modeKey];
      if (!mode) return false;
      this.mode = mode;
      this.lineIndex = 0;
      this.pendingLines = [];
      this.robot36Pair = null;
      this.lastSyncStart = -Infinity;
      this.lastQueuedSync = -Infinity;
      this.nextExpectedSync = null;
      this.syncCandidates = [];
      this.acquisitionStartedAt = null;
      this.syntheticSinceReal = 0;
      this.segmentRows = 0;
      this.segmentActive = false;
      this.imageStartIndex = this.frequencyIndex;
      this.callbacks.mode?.({ ...mode, source, offsetHz: Math.round(this.frequencyOffset) });
      this.emitStatus("sync", `${mode.label} · waiting for line sync`);
      return true;
    }

    feed(arrayBuffer, sampleRate) {
      if (!this.enabled || !(arrayBuffer instanceof ArrayBuffer)) return;
      const incoming = new Int16Array(arrayBuffer);
      if (!incoming.length) return;
      const nextRate = Number(sampleRate) || 48000;
      if (Math.abs(nextRate - this.sampleRate) > 1) {
        const preference = this.modePreference;
        this.resetDemodulator();
        this.resetProtocol(true);
        this.modePreference = preference;
        this.configureForSampleRate(nextRate);
        if (preference !== "auto") this.activateMode(preference, "manual");
      }

      for (let index = 0; index < incoming.length; index += 1) {
        this.processAudioSample(incoming[index] / 32768);
      }
      this.processPendingLines();
    }

    processAudioSample(sample) {
      const mixedI = sample * this.oscillatorCos * 2;
      const mixedQ = -sample * this.oscillatorSin * 2;
      const alpha = this.lowPassAlpha;
      this.basebandI1 += alpha * (mixedI - this.basebandI1);
      this.basebandQ1 += alpha * (mixedQ - this.basebandQ1);
      this.basebandI2 += alpha * (this.basebandI1 - this.basebandI2);
      this.basebandQ2 += alpha * (this.basebandQ1 - this.basebandQ2);

      const nextCos = this.oscillatorCos * this.oscillatorStepCos - this.oscillatorSin * this.oscillatorStepSin;
      const nextSin = this.oscillatorSin * this.oscillatorStepCos + this.oscillatorCos * this.oscillatorStepSin;
      this.oscillatorCos = nextCos;
      this.oscillatorSin = nextSin;
      this.oscillatorCounter += 1;
      if ((this.oscillatorCounter & 4095) === 0) {
        const length = Math.hypot(this.oscillatorCos, this.oscillatorSin) || 1;
        this.oscillatorCos /= length;
        this.oscillatorSin /= length;
      }

      this.decimationCounter += 1;
      if (this.decimationCounter < this.decimation) return;
      this.decimationCounter = 0;

      const phase = Math.atan2(this.basebandQ2, this.basebandI2);
      const magnitude = Math.hypot(this.basebandI2, this.basebandQ2);
      if (this.previousPhase == null) {
        this.previousPhase = phase;
        return;
      }
      let delta = phase - this.previousPhase;
      this.previousPhase = phase;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      else if (delta < -Math.PI) delta += 2 * Math.PI;
      this.unwrappedPhase += delta;
      const frequency = 1900 + delta * this.sampleRate / (2 * Math.PI * this.decimation);
      const valid = magnitude >= 0.0012 && Number.isFinite(frequency) && frequency >= 450 && frequency <= 3250;
      this.writeFrequency(valid ? frequency : NaN, magnitude, this.unwrappedPhase);
    }

    writeFrequency(frequency, magnitude, unwrappedPhase) {
      const position = this.frequencyIndex % this.frequencyCapacity;
      this.frequencyRing[position] = Number.isFinite(frequency) ? frequency : NaN;
      this.magnitudeRing[position] = magnitude;
      this.phaseRing[position] = unwrappedPhase;
      this.frequencyIndex += 1;
      this.lastFrequency = frequency;
      this.lastMagnitude = magnitude;

      this.binCount += 1;
      if (Number.isFinite(frequency)) {
        this.binFrequencySum += frequency;
        this.binMagnitudeSum += magnitude;
        this.binValidCount += 1;
      }
      if (this.binCount >= this.binSamples) {
        const bin = {
          index: this.frequencyIndex - Math.floor(this.binCount / 2),
          frequency: this.binValidCount ? this.binFrequencySum / this.binValidCount : NaN,
          magnitude: this.binValidCount ? this.binMagnitudeSum / this.binValidCount : 0,
          durationMs: this.binCount * 1000 / this.frequencyRate,
        };
        this.binCount = 0;
        this.binFrequencySum = 0;
        this.binMagnitudeSum = 0;
        this.binValidCount = 0;
        this.processVisBin(bin);
      }

      this.syncBinCount += 1;
      if (Number.isFinite(frequency)) {
        this.syncBinFrequencySum += frequency;
        this.syncBinMagnitudeSum += magnitude;
        this.syncBinValidCount += 1;
      }
      if (this.syncBinCount >= this.syncBinSamples) {
        const durationMs = this.syncBinCount * 1000 / this.frequencyRate;
        const syncBinStart = this.frequencyIndex - this.syncBinCount;
        const syncFrequency = this.syncBinValidCount ? this.syncBinFrequencySum / this.syncBinValidCount : NaN;
        const syncMagnitude = this.syncBinValidCount ? this.syncBinMagnitudeSum / this.syncBinValidCount : 0;
        this.syncBinCount = 0;
        this.syncBinFrequencySum = 0;
        this.syncBinMagnitudeSum = 0;
        this.syncBinValidCount = 0;
        if (this.mode) this.processSyncBin(syncFrequency, syncMagnitude, durationMs, syncBinStart);
      }
      if ((this.frequencyIndex & 255) === 0) {
        this.processLineClock();
        this.processPendingLines();
      }
      this.maybeEmitSignalStatus();
    }

    toneNear(frequency, target, tolerance = 170) {
      return Number.isFinite(frequency) && Math.abs((frequency - this.frequencyOffset) - target) <= tolerance;
    }

    resetVisSearch() {
      this.visState = "leader1";
      this.leader1Ms = 0;
      this.leader1Sum = 0;
      this.leader1Count = 0;
      this.breakMs = 0;
      this.leader2Ms = 0;
      this.leader2Sum = 0;
      this.leader2Count = 0;
      this.visBins = [];
    }

    processVisBin(bin) {
      const frequency = bin.frequency;
      const duration = bin.durationMs;
      const nearLeader = Number.isFinite(frequency) && Math.abs(frequency - 1900) <= 190;
      const nearSync = Number.isFinite(frequency) && Math.abs(frequency - 1200) <= 250;

      if (this.visState === "leader1") {
        if (nearLeader) {
          this.leader1Ms += duration;
          this.leader1Sum += frequency;
          this.leader1Count += 1;
        } else {
          this.leader1Ms = 0;
          this.leader1Sum = 0;
          this.leader1Count = 0;
        }
        if (this.leader1Ms >= 180) {
          this.visState = "break";
          this.callbacks.visStage?.({ stage: "leader" });
        }
        return;
      }

      if (this.visState === "break") {
        if (nearLeader && this.breakMs === 0) return;
        if (nearSync) {
          this.breakMs += duration;
          return;
        }
        if (this.breakMs >= 5 && this.breakMs <= 35 && nearLeader) {
          const leaderAverage = this.leader1Count ? this.leader1Sum / this.leader1Count : 1900;
          this.visFrequencyOffset = clamp(leaderAverage - 1900, -700, 700);
          this.visState = "leader2";
          this.leader2Ms = duration;
          this.leader2Sum = frequency;
          this.leader2Count = 1;
          return;
        }
        this.resetVisSearch();
        return;
      }

      if (this.visState === "leader2") {
        if (nearLeader) {
          this.leader2Ms += duration;
          this.leader2Sum += frequency;
          this.leader2Count += 1;
          return;
        }
        if (nearSync && this.leader2Ms >= 180) {
          const secondAverage = this.leader2Count ? this.leader2Sum / this.leader2Count : 1900;
          const secondOffset = secondAverage - 1900;
          this.visFrequencyOffset = clamp((this.visFrequencyOffset + secondOffset) / 2, -700, 700);
          this.visState = "vis";
          this.visBins = [bin];
          this.callbacks.visStage?.({ stage: "code" });
          return;
        }
        this.resetVisSearch();
        return;
      }

      if (this.visState === "vis") {
        this.visBins.push(bin);
        const binsPerBit = Math.max(1, Math.round(30 / duration));
        const requiredBins = binsPerBit * 10;
        if (this.visBins.length < requiredBins) return;
        const tones = [];
        for (let slot = 0; slot < 10; slot += 1) {
          const start = slot * binsPerBit;
          const end = Math.min(this.visBins.length, start + binsPerBit);
          let sum = 0;
          let count = 0;
          for (let index = start; index < end; index += 1) {
            const value = this.visBins[index].frequency;
            if (!Number.isFinite(value)) continue;
            sum += value - this.visFrequencyOffset;
            count += 1;
          }
          tones.push(count ? sum / count : NaN);
        }
        const startOkay = Number.isFinite(tones[0]) && Math.abs(tones[0] - 1200) < 230;
        const stopOkay = Number.isFinite(tones[9]) && Math.abs(tones[9] - 1200) < 230;
        let code = 0;
        let ones = 0;
        for (let bitIndex = 0; bitIndex < 7; bitIndex += 1) {
          const tone = tones[bitIndex + 1];
          const bit = Math.abs(tone - 1100) <= Math.abs(tone - 1300) ? 1 : 0;
          code |= bit << bitIndex;
          ones += bit;
        }
        const parityTone = tones[8];
        const parity = Math.abs(parityTone - 1100) <= Math.abs(parityTone - 1300) ? 1 : 0;
        const parityOkay = ((ones + parity) & 1) === 0;
        const modeKey = VIS_TO_MODE.get(code);
        if (startOkay && stopOkay && parityOkay && modeKey) {
          const mode = MODES[modeKey];
          this.callbacks.visDetected?.({ code, modeKey, mode });
          this.resetVisSearch();
          return;
        }
        this.callbacks.visError?.({ code, startOkay, stopOkay, parityOkay });
        this.resetVisSearch();
      }
    }

    expectedSyncRange() {
      if (!this.mode) return [0, 0];
      if (this.mode.family === "martin") return [3.0, 7.6];
      if (this.mode.family === "pd") return [13.5, 28.0];
      return [5.8, 13.5];
    }

    resetSyncRun() {
      this.syncRunStart = null;
      this.syncRunFrequencySum = 0;
      this.syncRunValidCount = 0;
      this.syncRunDurationMs = 0;
      this.syncRunValidMs = 0;
      this.syncRunGapMs = 0;
    }

    startSyncRun(frequency, durationMs, binStart) {
      this.syncRunStart = binStart;
      this.syncRunFrequencySum = frequency;
      this.syncRunValidCount = 1;
      this.syncRunDurationMs = durationMs;
      this.syncRunValidMs = durationMs;
      this.syncRunGapMs = 0;
    }

    finishSyncRun() {
      if (this.syncRunStart == null) return;
      const runStart = this.syncRunStart;
      const runDurationMs = Math.max(0, this.syncRunDurationMs - this.syncRunGapMs);
      const validDurationMs = this.syncRunValidMs;
      const averageFrequency = this.syncRunValidCount
        ? this.syncRunFrequencySum / this.syncRunValidCount
        : NaN;
      this.resetSyncRun();

      const [minimum, maximum] = this.expectedSyncRange();
      const validFraction = runDurationMs > 0 ? validDurationMs / runDurationMs : 0;
      if (!Number.isFinite(averageFrequency)
          || runDurationMs < minimum
          || runDurationMs > maximum
          || validFraction < 0.55) return;
      this.acceptSync(runStart, averageFrequency, runDurationMs);
    }

    processSyncBin(frequency, magnitude, durationMs, binStart) {
      if (!this.mode) return;
      const strong = Number.isFinite(frequency) && magnitude >= 0.0012;
      const acquisition = this.nextExpectedSync == null;

      if (acquisition) {
        // Before lock, accept only tones in a broad window around the nominal
        // 1200 Hz sync. Coherent timing across several lines chooses the real
        // sync and rejects repeated image details.
        const isAcquisitionSync = strong && Math.abs(frequency - 1200) <= 300;
        const allowedGapMs = this.mode.family === "martin"
          ? 1.5
          : (this.mode.family === "pd" ? 2.8 : 2.0);
        if (isAcquisitionSync) {
          if (this.syncRunStart == null) this.startSyncRun(frequency, durationMs, binStart);
          else {
            this.syncRunFrequencySum += frequency;
            this.syncRunValidCount += 1;
            this.syncRunDurationMs += durationMs;
            this.syncRunValidMs += durationMs;
            this.syncRunGapMs = 0;
          }
          return;
        }
        if (this.syncRunStart == null) return;
        this.syncRunGapMs += durationMs;
        this.syncRunDurationMs += durationMs;
        if (this.syncRunGapMs <= allowedGapMs) return;
        this.finishSyncRun();
        return;
      }

      const corrected = frequency - this.frequencyOffset;
      const isSync = strong && Math.abs(corrected - 1200) <= 115;
      const allowedGapMs = this.mode.family === "martin"
        ? 1.5
        : (this.mode.family === "pd" ? 2.8 : 2.0);

      if (isSync) {
        if (this.syncRunStart == null) this.startSyncRun(frequency, durationMs, binStart);
        else {
          this.syncRunFrequencySum += frequency;
          this.syncRunValidCount += 1;
          this.syncRunDurationMs += durationMs;
          this.syncRunValidMs += durationMs;
          this.syncRunGapMs = 0;
        }
        return;
      }

      if (this.syncRunStart == null) return;
      this.syncRunGapMs += durationMs;
      this.syncRunDurationMs += durationMs;
      if (this.syncRunGapMs <= allowedGapMs) return;
      this.finishSyncRun();
    }

    lineDurationMs(mode = this.mode) {
      if (!mode) return 0;
      if (mode.family === "martin") {
        return mode.syncMs + mode.porchMs + 3 * mode.channelMs + 3 * mode.separatorMs;
      }
      if (mode.family === "scottie") {
        return mode.syncMs + mode.porchMs + 3 * mode.channelMs + 2 * mode.separatorMs;
      }
      if (mode.family === "robot36") {
        return mode.syncMs + mode.porchMs + mode.yMs + mode.separatorMs + mode.separatorPorchMs + mode.chromaMs;
      }
      if (mode.family === "robot72") {
        return mode.syncMs + mode.porchMs + mode.yMs
          + mode.separatorMs + mode.separatorPorchMs + mode.crMs
          + mode.separatorMs + mode.separatorPorchMs + mode.cbMs;
      }
      if (mode.family === "pd") {
        return mode.syncMs + mode.porchMs + 4 * mode.channelMs;
      }
      return 0;
    }

    syncSearchWindowMs() {
      if (!this.mode) return 0;
      if (this.mode.family === "pd") return 18;
      if (this.mode.family === "martin") return 9;
      return 14;
    }

    maximumBridgedLines() {
      if (!this.mode) return 0;
      // Real HF recordings can lose several sync pulses during fading. Bridge
      // briefly, but never continue across silence for the rest of the buffer.
      if (this.mode.family === "pd") return 8;
      if (this.mode.family === "martin") return 12;
      return 18;
    }

    rowsPerDecodedLine() {
      return this.mode?.family === "pd" ? 2 : 1;
    }

    alignNextSegment() {
      if (!this.mode) return;
      if (this.lineIndex > 0 && (this.lineIndex % this.mode.height) !== 0) {
        this.lineIndex = Math.ceil(this.lineIndex / this.mode.height) * this.mode.height;
      }
      this.segmentRows = 0;
      this.segmentActive = true;
    }

    unlockLineClock(message = "searching for coherent line sync") {
      this.processPendingLines();
      this.nextExpectedSync = null;
      this.syncCandidates = [];
      this.acquisitionStartedAt = null;
      this.syntheticSinceReal = 0;
      this.segmentActive = false;
      this.lastQueuedSync = -Infinity;
      this.resetSyncRun();
      this.emitStatus("sync", `${this.mode.label} · ${message}`);
    }

    rememberSyncCandidate(candidate) {
      const period = this.msToSamples(this.lineDurationMs());
      const keepAfter = candidate.start - period * 10;
      this.syncCandidates.push(candidate);
      this.syncCandidates = this.syncCandidates.filter((item) => item.start >= keepAfter);
      if (this.acquisitionStartedAt == null) this.acquisitionStartedAt = candidate.start;
    }

    candidateNear(target, window, frequency, beforeIndex = Infinity) {
      let best = null;
      let bestError = Infinity;
      for (const candidate of this.syncCandidates) {
        if (candidate.start >= beforeIndex) continue;
        if (Math.abs(candidate.averageFrequency - frequency) > 85) continue;
        const error = Math.abs(candidate.start - target);
        if (error <= window && error < bestError) {
          best = candidate;
          bestError = error;
        }
      }
      return best;
    }

    acquisitionPattern() {
      if (this.mode?.family === "pd") return { slots: 6, required: 5 };
      return { slots: 8, required: 6 };
    }

    coherentChains() {
      const period = this.msToSamples(this.lineDurationMs());
      const window = this.msToSamples(this.syncSearchWindowMs());
      const { slots, required } = this.acquisitionPattern();
      const chains = [];

      for (const latest of this.syncCandidates) {
        const matches = [];
        for (let slot = 0; slot < slots; slot += 1) {
          const target = latest.start - slot * period;
          const match = this.candidateNear(target, window, latest.averageFrequency, latest.start + 1);
          if (match && !matches.includes(match)) matches.push(match);
        }
        if (matches.length < required) continue;
        const frequencies = matches.map((item) => item.averageFrequency);
        const spread = Math.max(...frequencies) - Math.min(...frequencies);
        if (spread > 68) continue;
        const averageFrequency = frequencies.reduce((sum, value) => sum + value, 0) / frequencies.length;
        let timingError = 0;
        for (const match of matches) {
          const slot = Math.round((latest.start - match.start) / period);
          timingError += Math.abs(match.start - (latest.start - slot * period));
        }
        chains.push({ latest, matches, averageFrequency, spread, timingError, slots });
      }
      return chains;
    }

    acquisitionQuality(chain) {
      const offset = chain.averageFrequency - 1200;
      const period = this.msToSamples(this.lineDurationMs());
      const start = chain.latest.start - (chain.slots - 1) * period;
      const end = chain.latest.start;
      let finite = 0;
      let video = 0;
      let invalid = 0;
      const bins = new Set();
      for (let index = Math.max(0, start); index < end; index += 8) {
        const magnitude = this.ringMagnitudeAt(index);
        const raw = this.ringFrequencyAt(index);
        if (!Number.isFinite(raw) || magnitude < 0.0012) {
          invalid += 1;
          continue;
        }
        const corrected = raw - offset;
        finite += 1;
        if (corrected >= 1400 && corrected <= 2450) {
          video += 1;
          bins.add(Math.floor((corrected - 1400) / 50));
        }
      }
      return {
        videoFraction: finite ? video / finite : 0,
        validFraction: (finite + invalid) ? finite / (finite + invalid) : 0,
        videoBins: bins.size,
      };
    }

    tryAcquireLineClock(candidate) {
      const period = this.msToSamples(this.lineDurationMs());
      this.rememberSyncCandidate(candidate);
      const { slots } = this.acquisitionPattern();
      if (candidate.start - this.acquisitionStartedAt < period * (slots - 0.8)) return false;

      const chains = this.coherentChains();
      if (!chains.length) return false;
      for (const chain of chains) chain.quality = this.acquisitionQuality(chain);
      const maximumTimingError = this.msToSamples(this.mode.family === "pd" ? 6 : 3.2);
      // The instantaneous FM estimator is noisier on real Scottie signals:
      // valid HF recordings can put about one third of samples just outside
      // the nominal 1400..2450 Hz image band even when the 9 ms / line-period
      // sync chain is exact. Keep the stricter gate for other families.
      const minimumVideoFraction = this.mode.family === "scottie" ? 0.60 : 0.70;
      const viable = chains.filter((chain) =>
        chain.timingError <= maximumTimingError
        && chain.quality.videoFraction >= minimumVideoFraction
        && chain.quality.validFraction >= 0.55
        && chain.quality.videoBins >= 10);
      if (!viable.length) return false;

      // The real sync is below the video tones. Prefer the lowest coherent,
      // image-like chain, then the most precise clock.
      viable.sort((left, right) =>
        (left.averageFrequency - right.averageFrequency)
        || (right.matches.length - left.matches.length)
        || (left.timingError - right.timingError));
      const selected = viable[0];
      const offset = selected.averageFrequency - 1200;
      if (offset < -500 || offset > 650) return false;

      this.frequencyOffset = clamp(offset, -500, 650);
      this.alignNextSegment();
      this.lastQueuedSync = -Infinity;
      for (let slot = selected.slots - 1; slot >= 0; slot -= 1) {
        const predicted = selected.latest.start - slot * period;
        let best = null;
        let bestError = Infinity;
        for (const match of selected.matches) {
          const error = Math.abs(match.start - predicted);
          if (error < bestError) {
            best = match;
            bestError = error;
          }
        }
        const tracked = best && bestError <= this.msToSamples(this.syncSearchWindowMs())
          ? predicted + (best.start - predicted) * 0.35
          : predicted;
        this.queueTrackedLine(tracked, best?.durationMs || 0, !best || bestError > this.msToSamples(this.syncSearchWindowMs()));
      }
      this.lastSyncStart = selected.latest.start;
      this.nextExpectedSync = selected.latest.start + period;
      this.syntheticSinceReal = 0;
      this.syncCandidates = [];
      this.acquisitionStartedAt = null;
      this.processPendingLines();
      this.emitStatus("receiving", `${this.mode.label} · line clock locked · correction ${Math.round(this.frequencyOffset)} Hz`);
      return true;
    }

    queueTrackedLine(syncStart, durationMs = 0, synthetic = false) {
      if (!this.mode || !this.segmentActive) return false;
      const rowsPerLine = this.rowsPerDecodedLine();
      if (this.segmentRows + this.pendingLines.length * rowsPerLine >= this.mode.height) return false;
      const lineSamples = this.msToSamples(this.lineDurationMs());
      const minimumGap = Math.max(this.msToSamples(40), lineSamples * 0.48);
      if (syncStart - this.lastQueuedSync < minimumGap) return false;
      this.lastQueuedSync = syncStart;

      let earliest = syncStart;
      let end = syncStart + lineSamples;
      if (this.mode.family === "scottie") {
        earliest = syncStart - this.msToSamples(2 * this.mode.channelMs + this.mode.separatorMs);
        end = syncStart + this.msToSamples(this.mode.syncMs + this.mode.porchMs + this.mode.channelMs);
      }
      const oldestAvailable = Math.max(0, this.frequencyIndex - this.frequencyCapacity + 2);
      if (earliest < oldestAvailable || earliest < this.imageStartIndex) return false;
      this.pendingLines.push({ syncStart, earliest, end, durationMs, synthetic });
      return true;
    }

    processLineClock() {
      if (!this.mode || this.nextExpectedSync == null || !this.segmentActive) return;
      const period = this.msToSamples(this.lineDurationMs());
      const window = this.msToSamples(this.syncSearchWindowMs());
      while (this.frequencyIndex > this.nextExpectedSync + window) {
        if (this.syntheticSinceReal >= this.maximumBridgedLines()) {
          this.unlockLineClock("sync lost · searching again");
          return;
        }
        if (!this.queueTrackedLine(this.nextExpectedSync, 0, true)) return;
        this.syntheticSinceReal += 1;
        this.nextExpectedSync += period;
      }
    }

    acceptSync(syncStart, averageFrequency, durationMs) {
      if (!this.mode) return;
      const candidate = { start: syncStart, averageFrequency, durationMs };
      if (this.nextExpectedSync == null) {
        this.tryAcquireLineClock(candidate);
        return;
      }

      const period = this.msToSamples(this.lineDurationMs());
      const window = this.msToSamples(this.syncSearchWindowMs());
      const measuredOffset = averageFrequency - 1200;
      if (Math.abs(measuredOffset - this.frequencyOffset) > 85) return;

      const delta = syncStart - this.nextExpectedSync;
      const missed = Math.max(0, Math.round(delta / period));
      const predicted = this.nextExpectedSync + missed * period;
      if (missed > this.maximumBridgedLines() || Math.abs(syncStart - predicted) > window) return;

      while (this.nextExpectedSync < predicted - window / 2) {
        if (!this.queueTrackedLine(this.nextExpectedSync, 0, true)) break;
        this.syntheticSinceReal += 1;
        this.nextExpectedSync += period;
      }

      const error = syncStart - this.nextExpectedSync;
      const trackedSync = this.nextExpectedSync + error * 0.35;
      this.queueTrackedLine(trackedSync, durationMs, false);
      this.nextExpectedSync = trackedSync + period;
      this.syntheticSinceReal = 0;
      this.lastSyncStart = syncStart;
      this.frequencyOffset = clamp(this.frequencyOffset * 0.88 + measuredOffset * 0.12, -500, 650);
      this.processPendingLines();
    }

    processPendingLines() {
      if (!this.mode || !this.pendingLines.length) return;
      while (this.pendingLines.length && this.pendingLines[0].end <= this.frequencyIndex - 2) {
        const pending = this.pendingLines.shift();
        this.decodeLine(pending);
        if (!this.segmentActive) {
          this.pendingLines = [];
          break;
        }
      }
    }

    msToSamples(milliseconds) {
      return Math.round(milliseconds * this.frequencyRate / 1000);
    }

    ringFrequencyAt(absoluteIndex) {
      if (absoluteIndex < 0 || absoluteIndex >= this.frequencyIndex) return NaN;
      if (this.frequencyIndex - absoluteIndex > this.frequencyCapacity) return NaN;
      return this.frequencyRing[absoluteIndex % this.frequencyCapacity];
    }

    ringPhaseAt(absoluteIndex) {
      if (absoluteIndex < 0 || absoluteIndex >= this.frequencyIndex) return NaN;
      if (this.frequencyIndex - absoluteIndex > this.frequencyCapacity) return NaN;
      return this.phaseRing[absoluteIndex % this.frequencyCapacity];
    }

    ringMagnitudeAt(absoluteIndex) {
      if (absoluteIndex < 0 || absoluteIndex >= this.frequencyIndex) return 0;
      if (this.frequencyIndex - absoluteIndex > this.frequencyCapacity) return 0;
      return this.magnitudeRing[absoluteIndex % this.frequencyCapacity];
    }

    extractPixels(start, durationMs, count) {
      const totalSamples = Math.max(count, this.msToSamples(durationMs));
      const values = new Uint8ClampedArray(count);
      const samplesPerPixel = totalSamples / count;
      const regressionWindow = Math.max(8, Math.round(samplesPerPixel * 1.55));
      for (let pixel = 0; pixel < count; pixel += 1) {
        const center = start + (pixel + 0.5) * samplesPerPixel;
        let begin = Math.max(Math.floor(start), Math.round(center - regressionWindow / 2));
        let end = Math.min(Math.ceil(start + totalSamples), begin + regressionWindow);
        begin = Math.max(Math.floor(start), end - regressionWindow);
        if (end <= begin + 1) end = begin + 2;

        let n = 0;
        let sumX = 0;
        let sumY = 0;
        let sumXX = 0;
        let sumXY = 0;
        for (let index = begin; index < end; index += 1) {
          if (this.ringMagnitudeAt(index) < 0.0012) continue;
          const phase = this.ringPhaseAt(index);
          if (!Number.isFinite(phase)) continue;
          const x = index - begin;
          n += 1;
          sumX += x;
          sumY += phase;
          sumXX += x * x;
          sumXY += x * phase;
        }
        let frequency = 1500;
        const denominator = n * sumXX - sumX * sumX;
        if (n >= 2 && Math.abs(denominator) > 1e-9) {
          const slope = (n * sumXY - sumX * sumY) / denominator;
          frequency = 1900 + slope * this.frequencyRate / (2 * Math.PI) - this.frequencyOffset;
        } else {
          let sum = 0;
          let valid = 0;
          for (let index = begin; index < end; index += 1) {
            const raw = this.ringFrequencyAt(index);
            if (!Number.isFinite(raw)) continue;
            sum += raw - this.frequencyOffset;
            valid += 1;
          }
          if (valid) frequency = sum / valid;
        }
        values[pixel] = clamp(Math.round((frequency - 1500) * 255 / 800), 0, 255);
      }
      return values;
    }

    rgbLine(red, green, blue) {
      const row = new Uint8ClampedArray(red.length * 4);
      for (let pixel = 0; pixel < red.length; pixel += 1) {
        const offset = pixel * 4;
        row[offset] = red[pixel];
        row[offset + 1] = green[pixel];
        row[offset + 2] = blue[pixel];
        row[offset + 3] = 255;
      }
      return row;
    }

    ycbcrLine(y, cb, cr) {
      const row = new Uint8ClampedArray(y.length * 4);
      for (let pixel = 0; pixel < y.length; pixel += 1) {
        const luminance = y[pixel];
        const blueDifference = cb[pixel] - 128;
        const redDifference = cr[pixel] - 128;
        const offset = pixel * 4;
        row[offset] = clamp(Math.round(luminance + 1.402 * redDifference), 0, 255);
        row[offset + 1] = clamp(Math.round(luminance - 0.344136 * blueDifference - 0.714136 * redDifference), 0, 255);
        row[offset + 2] = clamp(Math.round(luminance + 1.772 * blueDifference), 0, 255);
        row[offset + 3] = 255;
      }
      return row;
    }

    grayscaleLine(y) {
      return this.rgbLine(y, y, y);
    }

    decodeLine({ syncStart }) {
      const mode = this.mode;
      const width = mode.width;
      const line = this.lineIndex;
      const output = [];

      if (mode.family === "martin") {
        let position = syncStart + this.msToSamples(mode.syncMs + mode.porchMs);
        const green = this.extractPixels(position, mode.channelMs, width);
        position += this.msToSamples(mode.channelMs + mode.separatorMs);
        const blue = this.extractPixels(position, mode.channelMs, width);
        position += this.msToSamples(mode.channelMs + mode.separatorMs);
        const red = this.extractPixels(position, mode.channelMs, width);
        output.push({ y: line, row: this.rgbLine(red, green, blue) });
      } else if (mode.family === "scottie") {
        const blueStart = syncStart - this.msToSamples(mode.channelMs);
        const greenStart = blueStart - this.msToSamples(mode.separatorMs + mode.channelMs);
        const redStart = syncStart + this.msToSamples(mode.syncMs + mode.porchMs);
        const green = this.extractPixels(greenStart, mode.channelMs, width);
        const blue = this.extractPixels(blueStart, mode.channelMs, width);
        const red = this.extractPixels(redStart, mode.channelMs, width);
        output.push({ y: line, row: this.rgbLine(red, green, blue) });
      } else if (mode.family === "robot36") {
        let position = syncStart + this.msToSamples(mode.syncMs + mode.porchMs);
        const yChannel = this.extractPixels(position, mode.yMs, width);
        position += this.msToSamples(mode.yMs + mode.separatorMs + mode.separatorPorchMs);
        const chroma = this.extractPixels(position, mode.chromaMs, width);
        if ((line & 1) === 0) {
          this.robot36Pair = { line, y: yChannel, cr: chroma };
          output.push({ y: line, row: this.grayscaleLine(yChannel) });
        } else if (this.robot36Pair && this.robot36Pair.line === line - 1) {
          output.push({ y: line - 1, row: this.ycbcrLine(this.robot36Pair.y, chroma, this.robot36Pair.cr) });
          output.push({ y: line, row: this.ycbcrLine(yChannel, chroma, this.robot36Pair.cr) });
          this.robot36Pair = null;
        } else {
          output.push({ y: line, row: this.grayscaleLine(yChannel) });
        }
      } else if (mode.family === "robot72") {
        let position = syncStart + this.msToSamples(mode.syncMs + mode.porchMs);
        const yChannel = this.extractPixels(position, mode.yMs, width);
        position += this.msToSamples(mode.yMs + mode.separatorMs + mode.separatorPorchMs);
        const cr = this.extractPixels(position, mode.crMs, width);
        position += this.msToSamples(mode.crMs + mode.separatorMs + mode.separatorPorchMs);
        const cb = this.extractPixels(position, mode.cbMs, width);
        output.push({ y: line, row: this.ycbcrLine(yChannel, cb, cr) });
      } else if (mode.family === "pd") {
        let position = syncStart + this.msToSamples(mode.syncMs + mode.porchMs);
        const yFirst = this.extractPixels(position, mode.channelMs, width);
        position += this.msToSamples(mode.channelMs);
        const cr = this.extractPixels(position, mode.channelMs, width);
        position += this.msToSamples(mode.channelMs);
        const cb = this.extractPixels(position, mode.channelMs, width);
        position += this.msToSamples(mode.channelMs);
        const ySecond = this.extractPixels(position, mode.channelMs, width);
        output.push({ y: line, row: this.ycbcrLine(yFirst, cb, cr) });
        if (line + 1 < mode.height) {
          output.push({ y: line + 1, row: this.ycbcrLine(ySecond, cb, cr) });
        }
      }

      if (output.length) this.callbacks.lines?.(output, { line, mode });
      const decodedRows = mode.family === "pd" ? 2 : 1;
      this.lineIndex += decodedRows;
      this.segmentRows += decodedRows;
      const frameLine = this.lineIndex % mode.height;
      const progress = clamp(frameLine / mode.height, 0, 1);
      this.callbacks.progress?.({
        line: this.lineIndex,
        frameLine,
        total: mode.height,
        progress,
      });
      if (this.lineIndex > 0 && frameLine === 0) {
        this.callbacks.complete?.({ mode, line: this.lineIndex });
      }
      if (this.segmentRows >= mode.height) {
        this.unlockLineClock("image complete · searching for the next transmission");
      } else {
        this.emitStatus("receiving", `${mode.label} · ${this.segmentRows}/${mode.height} rows in current image`);
      }
    }

    maybeEmitSignalStatus() {
      const now = performance.now();
      if (now - this.lastStatusAt < 240) return;
      this.lastStatusAt = now;
      this.callbacks.signal?.({
        frequency: Number.isFinite(this.lastFrequency) ? Math.round(this.lastFrequency - this.frequencyOffset) : null,
        magnitude: this.lastMagnitude,
        offsetHz: Math.round(this.frequencyOffset),
        mode: this.mode,
        line: this.lineIndex,
      });
    }

    emitStatus(state, text) {
      this.callbacks.status?.({ state, text, mode: this.mode, line: this.lineIndex });
    }
  }

  class AudioHistory {
    constructor(seconds = 360) {
      this.seconds = Math.max(60, Number(seconds) || 360);
      this.sampleRate = 0;
      this.capacity = 0;
      this.samples = new Int16Array(0);
      this.totalWritten = 0;
    }

    configure(sampleRate) {
      const nextRate = Math.max(8000, Math.round(Number(sampleRate) || 48000));
      if (nextRate === this.sampleRate && this.capacity > 0) return false;
      this.sampleRate = nextRate;
      this.capacity = Math.max(1, Math.round(this.sampleRate * this.seconds));
      this.samples = new Int16Array(this.capacity);
      this.totalWritten = 0;
      return true;
    }

    clear() {
      this.totalWritten = 0;
      if (this.samples.length) this.samples.fill(0);
    }

    append(incoming, sampleRate) {
      const reset = this.configure(sampleRate);
      if (!(incoming instanceof Int16Array) || incoming.length === 0) return reset;
      let offset = 0;
      while (offset < incoming.length) {
        const position = this.totalWritten % this.capacity;
        const count = Math.min(incoming.length - offset, this.capacity - position);
        this.samples.set(incoming.subarray(offset, offset + count), position);
        this.totalWritten += count;
        offset += count;
      }
      return reset;
    }

    get availableSamples() {
      return Math.min(this.totalWritten, this.capacity);
    }

    get oldestIndex() {
      return this.totalWritten - this.availableSamples;
    }

    get durationSeconds() {
      return this.sampleRate ? this.availableSamples / this.sampleRate : 0;
    }

    read(startIndex, maximumSamples) {
      if (!this.capacity || maximumSamples <= 0) return { start: this.totalWritten, samples: new Int16Array(0) };
      const start = Math.max(this.oldestIndex, Math.min(this.totalWritten, Math.floor(startIndex)));
      const end = Math.min(this.totalWritten, start + Math.max(0, Math.floor(maximumSamples)));
      const output = new Int16Array(Math.max(0, end - start));
      if (!output.length) return { start, samples: output };
      const position = start % this.capacity;
      const first = Math.min(output.length, this.capacity - position);
      output.set(this.samples.subarray(position, position + first), 0);
      if (first < output.length) output.set(this.samples.subarray(0, output.length - first), first);
      return { start, samples: output };
    }
  }

  const controller = {
    DecoderClass: SSTVDecoder,
    EncoderClass: SSTVEncoder,
    HistoryClass: AudioHistory,
    Modes: MODES,
    TxModeKeys: SSTV_TX_MODE_KEYS,
    initialized: false,
    audioReady: false,
    decoder: null,
    history: new AudioHistory(360),
    canvas: null,
    context: null,
    canvasWrap: null,
    frameCanvases: [],
    frameContexts: [],
    frameWidth: 320,
    frameHeight: 256,
    statusState: "off",
    decoderStatusText: "Decoder off",
    lastSignal: null,
    totalRenderedRows: 0,
    frozen: false,
    followLive: true,
    programmaticScroll: false,
    replayActive: false,
    replayCursor: 0,
    replayStart: 0,
    replayGeneration: 0,
    replayScheduled: false,
    suggestedModeKey: null,
    enabledWanted: false,
    txImageSource: null,
    txImageUrl: "",
    txImageName: "",
    txBusy: false,
    txAbortRequested: false,

    init() {
      if (this.initialized) return;
      const canvas = byId("sstv-canvas");
      const canvasWrap = byId("sstv-canvas-wrap");
      if (!canvas || !canvasWrap) return;
      this.initialized = true;
      this.canvas = canvas;
      this.canvasWrap = canvasWrap;
      this.context = canvas.getContext("2d", { alpha: false });
      this.context.imageSmoothingEnabled = false;
      this.frameCanvases = [canvas];
      this.frameContexts = [this.context];
      const modeSelect = byId("sstv-mode");
      const enabled = byId("sstv-enabled");
      const txMode = byId("sstv-tx-mode");

      if (txMode && txMode.options.length === 0) {
        for (const key of SSTV_TX_MODE_KEYS) {
          const mode = MODES[key];
          const option = document.createElement("option");
          option.value = key;
          option.textContent = `${mode.label} · ${this.formatDuration(sstvTxDurationSeconds(mode))}`;
          txMode.appendChild(option);
        }
      }

      try {
        const savedMode = localStorage.getItem("ft710-sstv-mode-v1");
        if (savedMode && MODES[savedMode]) modeSelect.value = savedMode;
        const savedTxMode = localStorage.getItem("ft710-sstv-tx-mode-v1");
        if (savedTxMode && SSTV_TX_SUPPORTED.has(savedTxMode) && txMode) txMode.value = savedTxMode;
        this.enabledWanted = localStorage.getItem("ft710-sstv-enabled-v1") === "1";
      } catch (_) { /* Local storage is optional. */ }
      if (!MODES[modeSelect.value]) modeSelect.value = "scottie1";
      if (txMode && !SSTV_TX_SUPPORTED.has(txMode.value)) txMode.value = "robot36";

      this.canvasWrap.addEventListener("scroll", () => {
        if (this.programmaticScroll) return;
        const remaining = this.canvasWrap.scrollHeight
          - this.canvasWrap.clientHeight
          - this.canvasWrap.scrollTop;
        this.followLive = remaining <= 12;
        this.updateProgressUi();
      }, { passive: true });

      this.decoder = new SSTVDecoder({
        clearImage: () => this.clearCanvas(),
        mode: (mode) => {
          this.prepareCanvas(mode.width, mode.height);
          this.updateProgressUi();
          this.render();
        },
        lines: (lines) => this.appendRows(lines),
        progress: () => this.updateProgressUi(),
        complete: () => {
          byId("sstv-save").disabled = this.totalRenderedRows === 0;
        },
        signal: (signal) => {
          this.lastSignal = signal;
          const frequency = signal.frequency == null ? "--" : `${signal.frequency} Hz`;
          const offset = `${signal.offsetHz >= 0 ? "+" : ""}${signal.offsetHz} Hz`;
          const level = signal.magnitude > 0.0012 ? "signal" : "quiet";
          byId("sstv-signal").textContent = `Tone ${frequency} · correction ${offset} · ${level}`;
        },
        status: ({ state, text }) => {
          this.statusState = state;
          this.decoderStatusText = text;
          if (!this.replayActive && !this.frozen) byId("sstv-detail").textContent = text;
          this.render();
        },
        visStage: ({ stage }) => {
          if (stage === "leader") byId("sstv-vis").textContent = "VIS candidate · reading header";
          else byId("sstv-vis").textContent = "VIS candidate · reading code";
        },
        visDetected: ({ code, modeKey, mode }) => {
          this.suggestedModeKey = modeKey;
          byId("sstv-vis").textContent = `VIS ${code} suggests ${mode.label}`;
        },
        visError: ({ code }) => {
          byId("sstv-vis").textContent = `VIS uncertain · code ${code}`;
        },
      });

      enabled.addEventListener("change", () => {
        const active = Boolean(enabled.checked && this.audioReady);
        this.enabledWanted = active;
        enabled.checked = active;
        try { localStorage.setItem("ft710-sstv-enabled-v1", active ? "1" : "0"); } catch (_) { /* optional */ }
        this.cancelReplay();
        this.history.clear();
        this.frozen = false;
        this.followLive = true;
        this.updateFreezeButton();
        this.decoder.setModePreference(modeSelect.value, false);
        this.decoder.setEnabled(active);
        modeSelect.disabled = !active;
        byId("sstv-freeze").disabled = !active;
        if (active) {
          this.clearCanvas();
          byId("sstv-vis").textContent = "VIS suggestion --";
          byId("sstv-detail").textContent = `${MODES[modeSelect.value].label} · live decoding`;
        }
        this.updateBufferUi();
        this.render();
      });

      modeSelect.addEventListener("change", () => {
        if (!MODES[modeSelect.value]) return;
        try { localStorage.setItem("ft710-sstv-mode-v1", modeSelect.value); } catch (_) { /* optional */ }
        this.frozen = false;
        this.followLive = true;
        this.updateFreezeButton();
        this.decoder.setModePreference(modeSelect.value, false);
        if (enabled.checked && this.audioReady) this.redecodeEntireBuffer("mode changed");
      });

      byId("sstv-freeze").addEventListener("click", () => this.toggleFreeze());
      byId("sstv-save").addEventListener("click", () => this.saveVisiblePng());
      byId("sstv-image-choose")?.addEventListener("click", () => byId("sstv-image-file")?.click());
      byId("sstv-image-file")?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        if (file) void this.loadTxImage(file);
      });
      txMode?.addEventListener("change", () => {
        if (!SSTV_TX_SUPPORTED.has(txMode.value)) txMode.value = "robot36";
        try { localStorage.setItem("ft710-sstv-tx-mode-v1", txMode.value); } catch (_) { /* optional */ }
        this.drawTxPreview();
        this.renderTxUi();
      });
      byId("sstv-send-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.transmitSelectedImage();
      });
      byId("sstv-stop")?.addEventListener("click", () => this.stopTransmit());

      modeSelect.disabled = true;
      enabled.disabled = true;
      byId("sstv-freeze").disabled = true;
      this.prepareCanvas(this.frameWidth, this.frameHeight);
      this.updateBufferUi();
      this.drawTxPreview();
      this.renderTxUi();
      this.render();
    },

    selectedTxMode() {
      const key = byId("sstv-tx-mode")?.value || "robot36";
      return MODES[key] && SSTV_TX_SUPPORTED.has(key) ? MODES[key] : MODES.robot36;
    },

    releaseTxImage() {
      if (this.txImageSource?.close) {
        try { this.txImageSource.close(); } catch (_) { /* already closed */ }
      }
      if (this.txImageUrl) URL.revokeObjectURL(this.txImageUrl);
      this.txImageSource = null;
      this.txImageUrl = "";
      this.txImageName = "";
    },

    async loadImageSource(file) {
      const imageLike = file && (/^image\//i.test(file.type || "") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || ""));
      if (!imageLike) throw new Error("Select an image file");
      if (window.createImageBitmap) {
        try {
          return { source: await window.createImageBitmap(file), url: "" };
        } catch (_) {
          // Some browsers refuse createImageBitmap for formats they can still
          // decode through an HTMLImageElement.
        }
      }
      const url = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("Unable to decode image"));
          img.src = url;
        });
        return { source: image, url };
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    },

    async loadTxImage(file) {
      this.txStatus(`Loading ${file.name}...`);
      try {
        const loaded = await this.loadImageSource(file);
        this.releaseTxImage();
        this.txImageSource = loaded.source;
        this.txImageUrl = loaded.url;
        this.txImageName = file.name || "image";
        this.drawTxPreview();
        this.renderTxUi();
      } catch (error) {
        this.renderTxUi();
        this.txStatus(error?.message || "Image load failed", true);
      }
    },

    drawImageCover(context, source, width, height) {
      context.fillStyle = "#05080c";
      context.fillRect(0, 0, width, height);
      if (!source) return;
      const sourceWidth = source.width || source.naturalWidth || 1;
      const sourceHeight = source.height || source.naturalHeight || 1;
      const scale = Math.max(width / sourceWidth, height / sourceHeight);
      const drawWidth = sourceWidth * scale;
      const drawHeight = sourceHeight * scale;
      const dx = (width - drawWidth) / 2;
      const dy = (height - drawHeight) / 2;
      context.drawImage(source, dx, dy, drawWidth, drawHeight);
    },

    drawTxPreview() {
      const canvas = byId("sstv-tx-preview");
      if (!canvas) return;
      const mode = this.selectedTxMode();
      canvas.width = mode.width;
      canvas.height = mode.height;
      const wrap = byId("sstv-tx-preview-wrap");
      wrap?.style.setProperty("--sstv-frame-width", String(mode.width));
      wrap?.style.setProperty("--sstv-frame-height", String(mode.height));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      this.drawImageCover(ctx, this.txImageSource, mode.width, mode.height);
      if (!this.txImageSource) {
        ctx.fillStyle = "#8fa2b5";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("No image selected", mode.width / 2, mode.height / 2);
      }
    },

    txImageData(mode) {
      if (!this.txImageSource) throw new Error("Choose an image first");
      const canvas = document.createElement("canvas");
      canvas.width = mode.width;
      canvas.height = mode.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      this.drawImageCover(ctx, this.txImageSource, mode.width, mode.height);
      return ctx.getImageData(0, 0, mode.width, mode.height);
    },

    txStatus(text, isError = false) {
      const detail = byId("sstv-tx-detail");
      if (!detail) return;
      detail.textContent = text;
      detail.classList.toggle("error", Boolean(isError));
    },

    renderTxUi() {
      const choose = byId("sstv-image-choose");
      const send = byId("sstv-send");
      const stop = byId("sstv-stop");
      const modeSelect = byId("sstv-tx-mode");
      const bridge = window.FT710_AUDIO_BRIDGE;
      const bridgeReady = Boolean(bridge?.isReady?.());
      const stagedReady = Boolean(bridge?.supportsStagedDigitalTx?.());
      const tuneReady = Boolean(bridge?.supportsDigitalAlcTune?.());
      const mode = this.selectedTxMode();
      const bytes = sstvTxByteEstimate(mode);
      const byteLabel = `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
      const durationLabel = this.formatDuration(sstvTxDurationSeconds(mode));
      if (choose) choose.disabled = this.txBusy;
      if (modeSelect) modeSelect.disabled = this.txBusy;
      if (send) send.disabled = this.txBusy || !this.txImageSource || !bridgeReady || !stagedReady || !tuneReady || bytes > SSTV_TX_MAX_BYTES;
      if (stop) stop.disabled = !this.txBusy;
      if (this.txBusy) return;
      if (!this.txImageSource) {
        this.txStatus(`Choose image · ${mode.label} · ${durationLabel} · ${byteLabel}`);
      } else if (bytes > SSTV_TX_MAX_BYTES) {
        this.txStatus(`${mode.label} exceeds staged TX limit · ${byteLabel}`, true);
      } else if (!bridgeReady) {
        this.txStatus(`${this.txImageName} · enable audio before SSTV TX`);
      } else if (!stagedReady) {
        this.txStatus("ESP32 firmware does not advertise staged digital TX", true);
      } else if (!tuneReady) {
        this.txStatus("ESP32 firmware does not advertise bounded ALC tune", true);
      } else {
        this.txStatus(`${this.txImageName} · ${mode.label} · ${durationLabel} · ${byteLabel} · auto ALC`);
      }
    },

    async transmitSelectedImage() {
      if (this.txBusy) return;
      const bridge = window.FT710_AUDIO_BRIDGE;
      const mode = this.selectedTxMode();
      const label = `SSTV ${mode.label}`;
      let finalStatus = "";
      let finalError = false;

      try {
        if (!this.txImageSource) throw new Error("Choose an image first");
        if (!bridge?.isReady?.()) throw new Error("Enable audio first");
        if (!bridge?.supportsStagedDigitalTx?.()) throw new Error("ESP32 firmware does not advertise staged digital TX");
        if (!bridge?.supportsDigitalAlcTune?.()) throw new Error("ESP32 firmware does not advertise bounded ALC tune");
        if (sstvTxByteEstimate(mode) > SSTV_TX_MAX_BYTES) throw new Error(`${mode.label} exceeds staged TX limit`);

        this.txBusy = true;
        this.txAbortRequested = false;
        this.renderTxUi();

        const calibration = await bridge.calibrateDigitalAlc({
          shouldAbort: () => this.txAbortRequested,
          onStatus: (text) => this.txStatus(text),
        });
        if (this.txAbortRequested) throw new Error("SSTV TX stopped");
        const levelDbfs = Number.isFinite(Number(calibration?.levelDbfs))
          ? Number(calibration.levelDbfs)
          : SSTV_TX_DEFAULT_LEVEL_DBFS;
        this.txStatus(`Encoding ${label} · TX audio ${levelDbfs.toFixed(1)} dBFS`);
        await new Promise((resolve) => window.setTimeout(resolve, 20));

        const imageData = this.txImageData(mode);
        const encoder = new SSTVEncoder({ levelDbfs });
        const pcm = encoder.build(mode.key, imageData, {
          progress: ({ line, total }) => {
            if ((line & 31) === 1 || line >= total) this.txStatus(`Encoding ${label} · ${line}/${total} rows`);
          },
        });
        if (this.txAbortRequested) throw new Error("SSTV TX stopped");
        if (pcm.byteLength > SSTV_TX_MAX_BYTES) throw new Error(`${mode.label} exceeds staged TX limit`);

        this.txStatus(`Uploading ${label} · ${(pcm.byteLength / 1024 / 1024).toFixed(1)} MiB`);
        const staged = await bridge.stageDigitalPcm(pcm, {
          label,
          shouldAbort: () => this.txAbortRequested,
          onProgress: ({ sentBytes, totalBytes }) => {
            const percent = Math.round(sentBytes * 100 / Math.max(1, totalBytes));
            this.txStatus(`Uploading ${label} · ${percent}%`);
          },
        });
        if (this.txAbortRequested) throw new Error("SSTV TX stopped");

        this.txStatus(`Transmitting ${label} · ${this.formatDuration(pcm.length / SSTV_TX_SAMPLE_RATE)}`);
        await bridge.playStagedDigitalPcm(staged, pcm.length, {
          label,
          pttDelayMs: 350,
          tailMs: 300,
        });
        finalStatus = `SSTV TX complete · ${mode.label}`;
      } catch (error) {
        if (this.txAbortRequested) {
          finalStatus = `SSTV TX stopped · ${mode.label}`;
        } else {
          finalStatus = error?.message || "SSTV TX failed";
          finalError = true;
          window.showToast?.(finalStatus, true);
        }
      } finally {
        this.txBusy = false;
        this.txAbortRequested = false;
        this.renderTxUi();
        if (finalStatus) this.txStatus(finalStatus, finalError);
      }
    },

    stopTransmit() {
      if (!this.txBusy) return;
      this.txAbortRequested = true;
      byId("sstv-stop").disabled = true;
      this.txStatus("Stopping SSTV TX...");
      window.FT710_AUDIO_BRIDGE?.stopDigitalAlcTune?.();
      window.FT710_AUDIO_BRIDGE?.stopStagedDigitalTx?.();
    },

    setAudioReady(ready) {
      this.audioReady = Boolean(ready);
      const enabled = byId("sstv-enabled");
      if (!enabled) return;
      enabled.disabled = !this.audioReady;
      if (this.audioReady) {
        enabled.checked = this.enabledWanted;
        this.decoder?.setEnabled(this.enabledWanted);
      } else {
        enabled.checked = false;
        this.cancelReplay();
        this.history.clear();
        this.decoder?.setEnabled(false);
      }
      const active = Boolean(this.audioReady && enabled.checked);
      byId("sstv-mode").disabled = !active;
      byId("sstv-freeze").disabled = !active;
      if (!this.audioReady) {
        byId("sstv-detail").textContent = "Enable audio first";
        byId("sstv-signal").textContent = "Tone -- Hz · waiting for audio";
      }
      this.updateBufferUi();
      this.renderTxUi();
      this.render();
    },

    feedAudio(buffer, sampleRate) {
      if (!(buffer instanceof ArrayBuffer)) return;
      const enabled = Boolean(this.initialized && this.audioReady && byId("sstv-enabled")?.checked);
      if (!enabled) return;
      const incoming = new Int16Array(buffer);
      if (!incoming.length) return;
      const rateReset = this.history.append(incoming, sampleRate);
      this.updateBufferUi();

      if (rateReset) {
        this.cancelReplay();
        this.followLive = true;
        this.decoder.reset(true);
      }

      if (this.replayActive) {
        this.scheduleReplay();
        return;
      }
      this.decoder.feed(buffer, sampleRate);
    },

    redecodeEntireBuffer(reason = "mode changed") {
      if (!this.decoder?.enabled) return;
      this.cancelReplay();
      this.frozen = false;
      this.followLive = true;
      this.updateFreezeButton();
      this.decoder.reset(true);
      this.totalRenderedRows = 0;
      byId("sstv-save").disabled = true;

      if (this.history.availableSamples === 0) {
        byId("sstv-detail").textContent = `${MODES[byId("sstv-mode").value].label} · buffer empty, decoding live`;
        this.updateProgressUi();
        this.render();
        return;
      }

      this.replayActive = true;
      this.replayStart = this.history.oldestIndex;
      this.replayCursor = this.replayStart;
      this.replayGeneration += 1;
      byId("sstv-detail").textContent = `Re-decoding complete audio buffer · ${reason}`;
      this.updateProgressUi();
      this.render();
      this.scheduleReplay();
    },

    cancelReplay() {
      this.replayGeneration += 1;
      this.replayActive = false;
      this.replayScheduled = false;
    },

    scheduleReplay() {
      if (!this.replayActive || this.replayScheduled) return;
      this.replayScheduled = true;
      const generation = this.replayGeneration;
      const callback = (deadline) => {
        if (generation === this.replayGeneration) this.replayScheduled = false;
        this.pumpReplay(generation, deadline);
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(callback, { timeout: 40 });
      } else {
        window.setTimeout(() => callback(null), 0);
      }
    },

    pumpReplay(generation, deadline) {
      if (!this.replayActive || generation !== this.replayGeneration) return;
      const started = performance.now();
      const chunkSamples = Math.max(4096, Math.round(this.history.sampleRate * 0.35));
      let chunks = 0;

      while (this.replayActive && generation === this.replayGeneration) {
        const oldest = this.history.oldestIndex;
        if (this.replayCursor < oldest) {
          this.replayCursor = oldest;
          this.replayStart = oldest;
          this.decoder.reset(true);
          this.totalRenderedRows = 0;
        }

        const target = this.history.totalWritten;
        if (this.replayCursor >= target) break;
        const part = this.history.read(this.replayCursor, chunkSamples);
        if (!part.samples.length) break;
        this.decoder.feed(part.samples.buffer, this.history.sampleRate);
        this.replayCursor = part.start + part.samples.length;
        chunks += 1;

        const idleLow = deadline && typeof deadline.timeRemaining === "function" && deadline.timeRemaining() < 3;
        if (chunks >= 4 || idleLow || performance.now() - started > 16) break;
      }

      this.updateProgressUi();
      if (this.replayCursor < this.history.totalWritten) {
        this.scheduleReplay();
        return;
      }

      this.replayActive = false;
      byId("sstv-detail").textContent = `${MODES[byId("sstv-mode").value].label} · live decoding`;
      this.updateProgressUi();
      this.render();
    },

    toggleFreeze() {
      if (!this.decoder?.enabled) return;
      if (!this.frozen) {
        this.frozen = true;
        byId("sstv-detail").textContent = "Image frozen · audio buffer continues recording";
        this.updateFreezeButton();
        this.render();
        return;
      }
      this.frozen = false;
      this.followLive = true;
      this.updateFreezeButton();
      this.redecodeEntireBuffer("resume after freeze");
    },

    updateFreezeButton() {
      const button = byId("sstv-freeze");
      if (!button) return;
      button.textContent = this.frozen ? "Resume decoding" : "Freeze image";
    },

    makeFrameCanvas(index) {
      const frame = index === 0 ? this.canvas : document.createElement("canvas");
      frame.width = this.frameWidth;
      frame.height = this.frameHeight;
      frame.className = "sstv-frame-canvas";
      frame.setAttribute("aria-label", `Decoded SSTV buffer frame ${index + 1}`);
      if (index > 0) this.canvasWrap.appendChild(frame);
      const context = frame.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = false;
      this.fillContextBackground(context, this.frameWidth, this.frameHeight);
      this.frameCanvases[index] = frame;
      this.frameContexts[index] = context;
      return context;
    },

    ensureFrame(index) {
      while (this.frameCanvases.length <= index) this.makeFrameCanvas(this.frameCanvases.length);
      return this.frameContexts[index];
    },

    appendRows(lines) {
      if (!this.context || !this.canvas || this.frozen || !Array.isArray(lines)) return;
      for (const item of lines) {
        if (!(item.row instanceof Uint8ClampedArray) || item.row.length !== this.frameWidth * 4) continue;
        const absoluteRow = Math.max(0, Math.floor(Number(item.y) || 0));
        const frameIndex = Math.floor(absoluteRow / this.frameHeight);
        const frameRow = absoluteRow % this.frameHeight;
        const context = this.ensureFrame(frameIndex);
        const rowImage = context.createImageData(this.frameWidth, 1);
        rowImage.data.set(item.row);
        context.putImageData(rowImage, 0, frameRow);
        this.totalRenderedRows = Math.max(this.totalRenderedRows, absoluteRow + 1);
      }
      byId("sstv-save").disabled = this.totalRenderedRows === 0;
      byId("sstv-freeze").disabled = this.totalRenderedRows === 0;
      this.updateProgressUi();
      if (this.followLive) this.scrollToLatest();
    },

    prepareCanvas(width, height) {
      this.frameWidth = Math.max(1, Math.floor(width || 320));
      this.frameHeight = Math.max(1, Math.floor(height || 256));
      this.canvasWrap.style.setProperty("--sstv-frame-width", String(this.frameWidth));
      this.canvasWrap.style.setProperty("--sstv-frame-height", String(this.frameHeight));
      this.clearCanvas();
      const progress = byId("sstv-progress");
      progress.max = this.frameHeight;
      progress.value = 0;
    },

    fillContextBackground(context, width, height) {
      context.fillStyle = "rgb(8, 12, 17)";
      context.fillRect(0, 0, width, height);
    },

    clearCanvas() {
      if (!this.canvasWrap || !this.canvas) return;
      for (const frame of this.frameCanvases.slice(1)) frame.remove();
      this.frameCanvases = [];
      this.frameContexts = [];
      this.canvas.width = this.frameWidth;
      this.canvas.height = this.frameHeight;
      this.canvas.className = "sstv-frame-canvas";
      this.context = this.makeFrameCanvas(0);
      this.totalRenderedRows = 0;
      this.followLive = true;
      this.setScrollTop(0);
      const save = byId("sstv-save");
      if (save) save.disabled = true;
      const freeze = byId("sstv-freeze");
      if (freeze) freeze.disabled = !this.decoder?.enabled;
      this.updateProgressUi();
    },

    setScrollTop(value) {
      if (!this.canvasWrap) return;
      this.programmaticScroll = true;
      this.canvasWrap.scrollTop = Math.max(0, value);
      window.requestAnimationFrame(() => {
        this.programmaticScroll = false;
        this.updateProgressUi();
      });
    },

    scrollToLatest() {
      if (!this.canvasWrap) return;
      window.requestAnimationFrame(() => {
        if (!this.followLive) return;
        this.setScrollTop(this.canvasWrap.scrollHeight - this.canvasWrap.clientHeight);
      });
    },

    visibleRowRange() {
      if (!this.canvasWrap || !this.frameCanvases.length || this.totalRenderedRows <= 0) {
        return { start: 0, end: 0 };
      }
      const firstHeight = this.frameCanvases[0].getBoundingClientRect().height || this.frameHeight;
      const scale = this.frameHeight / Math.max(1, firstHeight);
      const start = clamp(Math.floor(this.canvasWrap.scrollTop * scale), 0, Math.max(0, this.totalRenderedRows - 1));
      const end = Math.min(this.totalRenderedRows, start + this.frameHeight);
      return { start, end };
    },

    updateBufferUi() {
      const element = byId("sstv-buffer");
      if (!element) return;
      const current = this.formatDuration(this.history.durationSeconds);
      const maximum = this.formatDuration(this.history.seconds);
      element.textContent = `Audio buffer ${current} / ${maximum}`;
    },

    updateProgressUi() {
      const progress = byId("sstv-progress");
      const label = byId("sstv-progress-label");
      if (!progress || !label) return;
      progress.max = this.frameHeight;
      const frameLine = this.totalRenderedRows === 0
        ? 0
        : ((this.totalRenderedRows - 1) % this.frameHeight) + 1;
      progress.value = frameLine;

      if (this.replayActive) {
        const end = Math.max(this.replayStart + 1, this.history.totalWritten);
        const ratio = clamp((this.replayCursor - this.replayStart) / (end - this.replayStart), 0, 1);
        label.textContent = `Re-decode ${Math.round(ratio * 100)}% · ${this.totalRenderedRows} rows`;
      } else if (this.frozen) {
        const range = this.visibleRowRange();
        label.textContent = `Frozen · rows ${range.start + 1}-${range.end} / ${this.totalRenderedRows}`;
      } else if (this.totalRenderedRows > 0) {
        const range = this.visibleRowRange();
        const position = this.followLive ? "latest" : "scrolled";
        label.textContent = `Live · ${position} · rows ${range.start + 1}-${range.end} / ${this.totalRenderedRows}`;
      } else {
        label.textContent = "Live · 0 decoded rows";
      }
    },

    formatDuration(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0));
      const minutes = Math.floor(total / 60);
      const remainder = total % 60;
      return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    },

    saveVisiblePng() {
      if (!this.canvasWrap || this.totalRenderedRows === 0) return;
      const output = document.createElement("canvas");
      output.width = this.frameWidth;
      output.height = this.frameHeight;
      const outputContext = output.getContext("2d", { alpha: false });
      outputContext.imageSmoothingEnabled = false;
      this.fillContextBackground(outputContext, this.frameWidth, this.frameHeight);

      const range = this.visibleRowRange();
      let sourceRow = range.start;
      let destinationRow = 0;
      let remaining = this.frameHeight;
      while (remaining > 0 && sourceRow < this.totalRenderedRows) {
        const frameIndex = Math.floor(sourceRow / this.frameHeight);
        const frameRow = sourceRow % this.frameHeight;
        const available = Math.min(
          remaining,
          this.frameHeight - frameRow,
          this.totalRenderedRows - sourceRow,
        );
        const sourceCanvas = this.frameCanvases[frameIndex];
        if (!sourceCanvas || available <= 0) break;
        outputContext.drawImage(
          sourceCanvas,
          0, frameRow, this.frameWidth, available,
          0, destinationRow, this.frameWidth, available,
        );
        sourceRow += available;
        destinationRow += available;
        remaining -= available;
      }

      const selected = MODES[byId("sstv-mode")?.value];
      const mode = selected?.label?.replace(/\s+/g, "-").toLowerCase() || "sstv";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      link.href = output.toDataURL("image/png");
      link.download = `ft710-${mode}-rows-${range.start + 1}-${range.start + this.frameHeight}-${stamp}.png`;
      link.click();
    },

    render() {
      if (!this.initialized) return;
      const enabled = Boolean(byId("sstv-enabled").checked && this.audioReady);
      const badge = byId("sstv-status");
      badge.className = "sstv-status";
      if (!enabled) {
        badge.textContent = "OFF";
      } else if (this.frozen) {
        badge.textContent = "HOLD";
        badge.classList.add("complete");
      } else if (this.replayActive) {
        badge.textContent = "RE-DECODE";
        badge.classList.add("vis");
      } else if (this.statusState === "receiving") {
        badge.textContent = "LIVE";
        badge.classList.add("receiving");
      } else {
        badge.textContent = "WAIT";
        badge.classList.add("waiting");
      }
    },
  };

  window.FT710_SSTV = controller;
})();
