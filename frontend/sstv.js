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

  class SSTVDecoder {
    constructor(callbacks = {}) {
      this.callbacks = callbacks;
      this.enabled = false;
      this.modePreference = "auto";
      this.mode = null;
      this.sampleRate = 44100;
      this.decimation = 2;
      this.frequencyRate = this.sampleRate / this.decimation;
      this.ringSeconds = 4;
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
      this.sampleRate = Number(sampleRate) || 44100;
      this.frequencyRate = this.sampleRate / this.decimation;
      const angular = 2 * Math.PI * 1900 / this.sampleRate;
      this.oscillatorStepCos = Math.cos(angular);
      this.oscillatorStepSin = Math.sin(angular);
      this.lowPassAlpha = 1 - Math.exp(-2 * Math.PI * 1050 / this.sampleRate);
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
      if (this.modePreference !== "auto") this.activateMode(this.modePreference, "manual");
      else this.emitStatus("waiting", "Waiting for VIS header");
    }

    setModePreference(modeKey) {
      const next = modeKey === "auto" || MODES[modeKey] ? modeKey : "auto";
      if (next === this.modePreference) return;
      this.modePreference = next;
      if (!this.enabled) return;
      this.resetDemodulator();
      this.resetProtocol(true);
      if (next === "auto") this.emitStatus("waiting", "Waiting for VIS header");
      else this.activateMode(next, "manual");
    }

    reset(clearImage = true) {
      this.resetDemodulator();
      this.resetProtocol(clearImage);
      if (!this.enabled) {
        this.emitStatus("off", "Decoder off");
      } else if (this.modePreference === "auto") {
        this.emitStatus("waiting", "Waiting for VIS header");
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
      this.syncRunStart = null;
      this.syncRunFrequencySum = 0;
      this.syncRunValidCount = 0;
      this.syncRunDurationMs = 0;
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
      this.imageStartIndex = this.frequencyIndex;
      this.callbacks.mode?.({ ...mode, source, offsetHz: Math.round(this.frequencyOffset) });
      this.emitStatus("sync", `${mode.label} · waiting for line sync`);
      return true;
    }

    feed(arrayBuffer, sampleRate) {
      if (!this.enabled || !(arrayBuffer instanceof ArrayBuffer)) return;
      const incoming = new Int16Array(arrayBuffer);
      if (!incoming.length) return;
      const nextRate = Number(sampleRate) || 44100;
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
      const valid = magnitude >= 0.0012 && Number.isFinite(frequency) && frequency >= 650 && frequency <= 2850;
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
        if (this.modePreference === "auto" && !this.mode) this.processVisBin(bin);
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
      if ((this.frequencyIndex & 1023) === 0) this.processPendingLines();
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
          this.emitStatus("vis", "VIS leader detected");
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
          this.frequencyOffset = clamp(leaderAverage - 1900, -250, 250);
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
          this.frequencyOffset = clamp((this.frequencyOffset + secondOffset) / 2, -250, 250);
          this.visState = "vis";
          this.visBins = [bin];
          this.emitStatus("vis", "Reading VIS code");
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
            sum += value - this.frequencyOffset;
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
          this.activateMode(modeKey, "vis");
          return;
        }
        this.callbacks.visError?.({ code, startOkay, stopOkay, parityOkay });
        this.resetVisSearch();
        this.emitStatus("waiting", `VIS not recognized${VIS_TO_MODE.has(code) ? "" : ` · code ${code}`}`);
      }
    }

    expectedSyncRange() {
      if (!this.mode) return [0, 0];
      if (this.mode.family === "martin") return [3.2, 7.2];
      if (this.mode.family === "pd") return [14.0, 27.0];
      return [6.2, 12.8];
    }

    processSyncBin(frequency, magnitude, durationMs, binStart) {
      const corrected = frequency - this.frequencyOffset;
      const isSync = Number.isFinite(corrected) && magnitude >= 0.0012 && Math.abs(corrected - 1200) <= 170;
      if (isSync) {
        if (this.syncRunStart == null) {
          this.syncRunStart = binStart;
          this.syncRunFrequencySum = Number.isFinite(frequency) ? frequency : 0;
          this.syncRunValidCount = Number.isFinite(frequency) ? 1 : 0;
          this.syncRunDurationMs = durationMs;
        } else {
          if (Number.isFinite(frequency)) {
            this.syncRunFrequencySum += frequency;
            this.syncRunValidCount += 1;
          }
          this.syncRunDurationMs += durationMs;
        }
        return;
      }
      if (this.syncRunStart == null) return;
      const runStart = this.syncRunStart;
      const runDurationMs = this.syncRunDurationMs;
      const averageFrequency = this.syncRunValidCount
        ? this.syncRunFrequencySum / this.syncRunValidCount
        : 1200 + this.frequencyOffset;
      this.syncRunStart = null;
      this.syncRunFrequencySum = 0;
      this.syncRunValidCount = 0;
      this.syncRunDurationMs = 0;
      const [minimum, maximum] = this.expectedSyncRange();
      if (runDurationMs < minimum || runDurationMs > maximum) return;
      this.acceptSync(runStart, averageFrequency, runDurationMs);
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

    acceptSync(syncStart, averageFrequency, durationMs) {
      const lineSamples = this.msToSamples(this.lineDurationMs());
      const minimumGap = Math.max(this.msToSamples(40), lineSamples * 0.48);
      if (syncStart - this.lastSyncStart < minimumGap) return;
      this.lastSyncStart = syncStart;
      const measuredOffset = averageFrequency - 1200;
      this.frequencyOffset = clamp(this.frequencyOffset * 0.82 + measuredOffset * 0.18, -250, 250);

      const mode = this.mode;
      let earliest = syncStart;
      let end = syncStart + lineSamples;
      if (mode.family === "scottie") {
        earliest = syncStart - this.msToSamples(2 * mode.channelMs + mode.separatorMs);
        end = syncStart + this.msToSamples(mode.syncMs + mode.porchMs + mode.channelMs);
      }
      const oldestAvailable = Math.max(0, this.frequencyIndex - this.frequencyCapacity + 2);
      if (earliest < oldestAvailable || earliest < this.imageStartIndex) return;
      this.pendingLines.push({ syncStart, earliest, end, durationMs });
      this.processPendingLines();
    }

    processPendingLines() {
      if (!this.mode || !this.pendingLines.length) return;
      while (this.pendingLines.length && this.pendingLines[0].end <= this.frequencyIndex - 2) {
        const pending = this.pendingLines.shift();
        if (this.lineIndex >= this.mode.height) break;
        this.decodeLine(pending);
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
      this.lineIndex += mode.family === "pd" ? 2 : 1;
      const progress = clamp(this.lineIndex / mode.height, 0, 1);
      this.callbacks.progress?.({ line: this.lineIndex, total: mode.height, progress });
      if (this.lineIndex >= mode.height) {
        this.callbacks.complete?.({ mode });
        this.emitStatus("complete", `${mode.label} · complete`);
      } else {
        this.emitStatus("receiving", `${mode.label} · line ${this.lineIndex}/${mode.height}`);
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

  const controller = {
    DecoderClass: SSTVDecoder,
    Modes: MODES,
    initialized: false,
    audioReady: false,
    decoder: null,
    canvas: null,
    context: null,
    imageData: null,
    statusState: "off",
    lastSignal: null,

    init() {
      if (this.initialized) return;
      const canvas = byId("sstv-canvas");
      if (!canvas) return;
      this.initialized = true;
      this.canvas = canvas;
      this.context = canvas.getContext("2d", { alpha: false });
      this.context.imageSmoothingEnabled = false;
      const modeSelect = byId("sstv-mode");
      const enabled = byId("sstv-enabled");

      this.decoder = new SSTVDecoder({
        clearImage: () => this.clearCanvas(),
        mode: (mode) => {
          this.prepareCanvas(mode.width, mode.height);
          byId("sstv-vis").textContent = mode.source === "vis"
            ? `VIS ${mode.vis} · ${mode.label}`
            : `Manual · ${mode.label}`;
          this.render();
        },
        lines: (lines) => {
          if (!this.imageData) return;
          for (const item of lines) {
            if (item.y < 0 || item.y >= this.canvas.height) continue;
            this.imageData.data.set(item.row, item.y * this.canvas.width * 4);
            this.context.putImageData(this.imageData, 0, 0, 0, item.y, this.canvas.width, 1);
          }
        },
        progress: ({ line, total, progress }) => {
          const progressElement = byId("sstv-progress");
          progressElement.max = total;
          progressElement.value = line;
          byId("sstv-progress-label").textContent = `${line} / ${total} · ${Math.round(progress * 100)}%`;
          byId("sstv-save").disabled = line === 0;
        },
        complete: () => {
          byId("sstv-save").disabled = false;
          this.render();
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
          byId("sstv-detail").textContent = text;
          this.render();
        },
        visError: ({ code }) => {
          byId("sstv-vis").textContent = `Unrecognized VIS ${code}`;
        },
      });

      enabled.addEventListener("change", () => {
        const active = Boolean(enabled.checked && this.audioReady);
        enabled.checked = active;
        this.decoder.setEnabled(active);
        modeSelect.disabled = !active;
        this.render();
      });
      modeSelect.addEventListener("change", () => {
        this.decoder.setModePreference(modeSelect.value);
      });
      byId("sstv-reset").addEventListener("click", () => {
        this.decoder.reset(true);
        byId("sstv-save").disabled = true;
        byId("sstv-progress").value = 0;
        byId("sstv-progress-label").textContent = "0 / -- · 0%";
        byId("sstv-vis").textContent = modeSelect.value === "auto" ? "VIS --" : `Manual · ${MODES[modeSelect.value]?.label || "--"}`;
      });
      byId("sstv-save").addEventListener("click", () => this.savePng());

      modeSelect.disabled = true;
      enabled.disabled = true;
      this.clearCanvas();
      this.render();
    },

    setAudioReady(ready) {
      this.audioReady = Boolean(ready);
      const enabled = byId("sstv-enabled");
      if (!enabled) return;
      enabled.disabled = !this.audioReady;
      if (!this.audioReady && enabled.checked) {
        enabled.checked = false;
        this.decoder?.setEnabled(false);
      }
      byId("sstv-mode").disabled = !this.audioReady || !enabled.checked;
      if (!this.audioReady) {
        byId("sstv-detail").textContent = "Enable audio first";
        byId("sstv-signal").textContent = "Tone -- Hz · waiting for audio";
      }
      this.render();
    },

    feedAudio(buffer, sampleRate) {
      this.decoder?.feed(buffer, sampleRate);
    },

    prepareCanvas(width, height) {
      if (this.canvas.width !== width || this.canvas.height !== height || !this.imageData) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.imageData = this.context.createImageData(width, height);
      } else {
        this.imageData.data.fill(0);
      }
      for (let index = 3; index < this.imageData.data.length; index += 4) this.imageData.data[index] = 255;
      this.context.putImageData(this.imageData, 0, 0);
      const progress = byId("sstv-progress");
      progress.max = height;
      progress.value = 0;
      byId("sstv-progress-label").textContent = `0 / ${height} · 0%`;
      byId("sstv-save").disabled = true;
    },

    clearCanvas() {
      const width = this.canvas?.width || 320;
      const height = this.canvas?.height || 256;
      if (!this.context) return;
      this.imageData = this.context.createImageData(width, height);
      for (let index = 0; index < this.imageData.data.length; index += 4) {
        this.imageData.data[index] = 8;
        this.imageData.data[index + 1] = 12;
        this.imageData.data[index + 2] = 17;
        this.imageData.data[index + 3] = 255;
      }
      this.context.putImageData(this.imageData, 0, 0);
    },

    savePng() {
      if (!this.canvas) return;
      const mode = this.decoder?.mode?.label?.replace(/\s+/g, "-").toLowerCase() || "sstv";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const link = document.createElement("a");
      link.href = this.canvas.toDataURL("image/png");
      link.download = `ft710-${mode}-${stamp}.png`;
      link.click();
    },

    render() {
      if (!this.initialized) return;
      const enabled = Boolean(byId("sstv-enabled").checked && this.audioReady);
      const badge = byId("sstv-status");
      badge.className = "sstv-status";
      if (!enabled) {
        badge.textContent = "OFF";
      } else if (this.statusState === "complete") {
        badge.textContent = "DONE";
        badge.classList.add("complete");
      } else if (this.statusState === "receiving") {
        badge.textContent = "RX";
        badge.classList.add("receiving");
      } else if (this.statusState === "vis") {
        badge.textContent = "VIS";
        badge.classList.add("vis");
      } else {
        badge.textContent = "WAIT";
        badge.classList.add("waiting");
      }
    },
  };

  window.FT710_SSTV = controller;
})();
