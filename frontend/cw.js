"use strict";

(() => {
  const API_BASE = (window.FT710_CONFIG?.apiBase || "/ft710-api").replace(/\/$/, "");
  const byId = (id) => document.getElementById(id);

  const MORSE_TO_TEXT = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E",
    "..-.": "F", "--.": "G", "....": "H", "..": "I", ".---": "J",
    "-.-": "K", ".-..": "L", "--": "M", "-.": "N", "---": "O",
    ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T",
    "..-": "U", "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y",
    "--..": "Z", "-----": "0", ".----": "1", "..---": "2", "...--": "3",
    "....-": "4", ".....": "5", "-....": "6", "--...": "7", "---..": "8",
    "----.": "9", ".-.-.-": ".", "--..--": ",", "..--..": "?",
    "-..-.": "/", "-...-": "=", ".-.-.": "+", "-....-": "-",
    ".--.-.": "@", "-.--.": "(", "-.--.-": ")",
  };

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const median = (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  async function request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* no body */ }
    if (!response.ok) throw new Error(payload?.detail || `HTTP ${response.status}`);
    return payload;
  }

  class CWDecoder {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.enabled = false;
      this.sampleRate = 44100;
      this.frameMs = 20;
      this.hopMs = 5;
      this.pending = new Int16Array(0);
      this.scanBuffer = new Int16Array(0);
      this.scanElapsedSamples = 0;
      this.frameSamples = 0;
      this.hopSamples = 0;
      this.frameWindow = null;

      this.detectedTone = 700;
      this.toneLocked = false;
      this.toneCandidate = null;
      this.toneCandidateCount = 0;
      this.lastToneQuality = 0;

      this.amplitudeHistory = [];
      this.threshold = Infinity;
      this.lastAmplitude = 0;
      this.lastProminence = 0;

      this.stableState = false;
      this.stableDuration = 0;
      this.candidateState = null;
      this.candidateDuration = 0;
      this.pattern = "";
      this.patternMarks = [];
      this.characterFlushed = false;
      this.wordFlushed = false;

      this.markHistory = [];
      this.gapHistory = [];
      this.ditMs = 1200 / 25;
      this.gapUnitMs = this.ditMs * 0.65;
      this.lastStatsAt = 0;
      this.lastSignal = false;
      this.rebuildWindows();
    }

    rebuildWindows() {
      this.frameSamples = Math.max(256, Math.round(this.sampleRate * this.frameMs / 1000));
      this.hopSamples = Math.max(64, Math.round(this.sampleRate * this.hopMs / 1000));
      this.frameWindow = new Float32Array(this.frameSamples);
      const denominator = Math.max(1, this.frameSamples - 1);
      for (let index = 0; index < this.frameSamples; index += 1) {
        this.frameWindow[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / denominator);
      }
    }

    reset(clearText = false) {
      this.pending = new Int16Array(0);
      this.scanBuffer = new Int16Array(0);
      this.scanElapsedSamples = 0;
      this.toneLocked = false;
      this.toneCandidate = null;
      this.toneCandidateCount = 0;
      this.lastToneQuality = 0;
      this.amplitudeHistory = [];
      this.threshold = Infinity;
      this.lastAmplitude = 0;
      this.lastProminence = 0;
      this.stableState = false;
      this.stableDuration = 0;
      this.candidateState = null;
      this.candidateDuration = 0;
      this.pattern = "";
      this.patternMarks = [];
      this.characterFlushed = false;
      this.wordFlushed = false;
      this.markHistory = [];
      this.gapHistory = [];
      // Auto speed must not inherit a stale/manual WPM value. A wrong initial
      // value previously made dots look like dashes and then reinforced itself.
      this.ditMs = this.callbacks.autoSpeed()
        ? 60
        : 1200 / clamp(Number(this.callbacks.manualWpm()) || 25, 4, 60);
      this.gapUnitMs = this.ditMs * 0.75;
      this.lastSignal = false;
      if (clearText) this.callbacks.clearText();
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      this.reset(false);
      this.callbacks.signal({
        signal: false,
        tone: this.detectedTone,
        wpm: this.currentWpm(),
        amplitude: 0,
        threshold: 0,
        prominence: 0,
        toneQuality: 0,
      });
    }

    markModel() {
      const usable = this.markHistory
        .filter((duration) => Number.isFinite(duration) && duration >= 22 && duration <= 500)
        .slice(-80);

      if (!usable.length) {
        const dit = clamp(this.ditMs || 60, 20, 300);
        return { dit, threshold: dit * 1.85, confident: false };
      }

      const logs = usable.map((duration) => Math.log(duration));
      let low = Math.min(...logs);
      let high = Math.max(...logs);

      if (usable.length >= 6 && high - low >= Math.log(1.55)) {
        for (let iteration = 0; iteration < 16; iteration += 1) {
          let lowSum = 0;
          let lowCount = 0;
          let highSum = 0;
          let highCount = 0;
          const boundary = (low + high) / 2;
          for (const value of logs) {
            if (value <= boundary) {
              lowSum += value;
              lowCount += 1;
            } else {
              highSum += value;
              highCount += 1;
            }
          }
          if (lowCount) low = lowSum / lowCount;
          if (highCount) high = highSum / highCount;
        }

        const dotCenter = Math.exp(low);
        const dashCenter = Math.exp(high);
        const lowCount = logs.filter((value) => value <= (low + high) / 2).length;
        const highCount = logs.length - lowCount;
        const ratio = dashCenter / Math.max(1, dotCenter);

        if (lowCount >= 2 && highCount >= 2 && ratio >= 1.75 && ratio <= 4.8) {
          const dotSamples = usable.filter((duration) => (
            Math.log(duration) <= (low + high) / 2
          ));
          const dashSamples = usable.filter((duration) => (
            Math.log(duration) > (low + high) / 2
          ));
          const normalized = [
            ...dotSamples,
            ...dashSamples.map((duration) => duration / 3),
          ];
          const dit = clamp(median(normalized), 20, 300);
          return {
            dit,
            threshold: Math.sqrt(dotCenter * dashCenter),
            confident: true,
          };
        }
      }

      // Before both populations are visible, use a neutral 20 WPM prior.
      // A long-only group is interpreted as dashes; a short group as dots.
      const center = median(usable);
      const provisionalDit = center >= 105 ? center / 3 : center;
      const dit = clamp(
        this.ditMs * 0.65 + provisionalDit * 0.35,
        20,
        300,
      );
      return { dit, threshold: dit * 1.85, confident: false };
    }

    currentWpm() {
      if (!this.callbacks.autoSpeed()) return clamp(Number(this.callbacks.manualWpm()) || 25, 4, 60);
      const model = this.markModel();
      return clamp(Math.round(1200 / Math.max(20, model.dit)), 4, 60);
    }

    currentDitMs() {
      if (!this.callbacks.autoSpeed()) return 1200 / clamp(Number(this.callbacks.manualWpm()) || 25, 4, 60);
      return clamp(this.markModel().dit, 20, 300);
    }

    learnGap(durationMs) {
      const dit = this.currentDitMs();
      const minimum = Math.max(8, dit * 0.28);
      const maximum = dit * 1.6;
      if (durationMs < minimum || durationMs > maximum) return;

      this.gapHistory.push(durationMs);
      if (this.gapHistory.length > 80) this.gapHistory.shift();

      const sorted = [...this.gapHistory].sort((a, b) => a - b);
      const lowerCount = Math.max(1, Math.ceil(sorted.length * 0.60));
      const candidate = median(sorted.slice(0, lowerCount));
      if (candidate > 0) {
        this.gapUnitMs = this.gapUnitMs * 0.82 + candidate * 0.18;
      }
    }

    gapThresholds() {
      const dit = this.currentDitMs();
      // A gap of about one dit is still inside the current character.
      // The old thresholds closed characters around one dit, which split
      // ordinary Morse into streams of E/T and inserted spaces inside words.
      const gapUnit = clamp(this.gapUnitMs || dit * 0.75, 8, dit * 1.2);
      return {
        character: clamp(
          Math.max(dit * 1.90, gapUnit * 2.15),
          dit * 1.60,
          dit * 2.40,
        ),
        word: clamp(
          Math.max(dit * 4.60, gapUnit * 5.40),
          dit * 4.00,
          dit * 6.50,
        ),
      };
    }

    appendScanAudio(incoming) {
      const maximum = Math.max(2048, Math.round(this.sampleRate * 0.18));
      if (incoming.length >= maximum) {
        this.scanBuffer = incoming.slice(incoming.length - maximum);
        return;
      }
      const keep = Math.min(this.scanBuffer.length, maximum - incoming.length);
      const next = new Int16Array(keep + incoming.length);
      if (keep) next.set(this.scanBuffer.subarray(this.scanBuffer.length - keep), 0);
      next.set(incoming, keep);
      this.scanBuffer = next;
    }

    feed(arrayBuffer, sampleRate) {
      if (!this.enabled || !(arrayBuffer instanceof ArrayBuffer)) return;
      const incoming = new Int16Array(arrayBuffer);
      if (!incoming.length) return;

      if (Number(sampleRate) !== this.sampleRate) {
        this.sampleRate = Number(sampleRate) || 44100;
        this.rebuildWindows();
        this.reset(false);
      }

      this.appendScanAudio(incoming);
      this.scanElapsedSamples += incoming.length;
      const scanInterval = Math.max(1, Math.round(this.sampleRate * 0.25));
      if (this.callbacks.autoTone() && this.scanElapsedSamples >= scanInterval) {
        this.scanElapsedSamples %= scanInterval;
        this.updateToneLock();
      }

      const combined = new Int16Array(this.pending.length + incoming.length);
      combined.set(this.pending, 0);
      combined.set(incoming, this.pending.length);

      let offset = 0;
      while (offset + this.frameSamples <= combined.length) {
        this.processFrame(combined.subarray(offset, offset + this.frameSamples));
        offset += this.hopSamples;
      }
      this.pending = combined.slice(offset);
    }

    goertzelAmplitude(samples, frequency, sampleRate = this.sampleRate, window = null) {
      const omega = 2 * Math.PI * frequency / sampleRate;
      const coefficient = 2 * Math.cos(omega);
      let previous = 0;
      let previous2 = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const scale = window ? window[index] : 1;
        const value = samples[index] / 32768 * scale;
        const current = value + coefficient * previous - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
      return 2 * Math.sqrt(power) / Math.max(1, samples.length);
    }

    scanStableTone(samples) {
      if (samples.length < Math.round(this.sampleRate * 0.12)) return null;

      const factor = Math.max(1, Math.round(this.sampleRate / 11025));
      const usable = Math.floor(samples.length / factor) * factor;
      const reduced = new Float32Array(usable / factor);
      for (let output = 0, input = 0; output < reduced.length; output += 1, input += factor) {
        let sum = 0;
        for (let inner = 0; inner < factor; inner += 1) sum += samples[input + inner];
        reduced[output] = sum / factor;
      }

      const scanRate = this.sampleRate / factor;
      const window = new Float32Array(reduced.length);
      const denominator = Math.max(1, reduced.length - 1);
      for (let index = 0; index < reduced.length; index += 1) {
        window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / denominator);
      }

      const amplitudes = [];
      let bestFrequency = this.detectedTone;
      let bestAmplitude = 0;
      for (let frequency = 300; frequency <= 1050; frequency += 5) {
        const amplitude = this.goertzelAmplitude(reduced, frequency, scanRate, window);
        amplitudes.push(amplitude);
        if (amplitude > bestAmplitude) {
          bestAmplitude = amplitude;
          bestFrequency = frequency;
        }
      }

      const floor = median(amplitudes);
      const quality = bestAmplitude / Math.max(1e-6, floor);
      return { frequency: bestFrequency, amplitude: bestAmplitude, quality };
    }

    updateToneLock() {
      const scanned = this.scanStableTone(this.scanBuffer);
      if (!scanned) return;
      this.lastToneQuality = scanned.quality;

      const useful = scanned.amplitude >= 0.006 && scanned.quality >= 10;
      if (!useful) {
        this.toneCandidateCount = Math.max(0, this.toneCandidateCount - 1);
        return;
      }

      if (this.toneCandidate !== null && Math.abs(scanned.frequency - this.toneCandidate) <= 10) {
        this.toneCandidate = this.toneCandidate * 0.55 + scanned.frequency * 0.45;
        this.toneCandidateCount += 1;
      } else {
        this.toneCandidate = scanned.frequency;
        this.toneCandidateCount = 1;
      }

      const quietLongEnough = !this.stableState && this.stableDuration >= 900;
      if (this.toneCandidateCount >= 2 && (!this.toneLocked || quietLongEnough)) {
        this.detectedTone = clamp(this.toneCandidate, 300, 1050);
        this.toneLocked = true;
        this.amplitudeHistory = [];
        this.threshold = Infinity;
      }
    }

    updateThreshold() {
      if (this.amplitudeHistory.length < 60) {
        this.threshold = Infinity;
        return;
      }

      const logs = this.amplitudeHistory.map((value) => Math.log(Math.max(1e-7, value)));
      let low = Math.min(...logs);
      let high = Math.max(...logs);
      for (let iteration = 0; iteration < 10; iteration += 1) {
        let lowSum = 0;
        let lowCount = 0;
        let highSum = 0;
        let highCount = 0;
        const midpoint = (low + high) / 2;
        for (const value of logs) {
          if (value <= midpoint) {
            lowSum += value;
            lowCount += 1;
          } else {
            highSum += value;
            highCount += 1;
          }
        }
        if (lowCount) low = lowSum / lowCount;
        if (highCount) high = highSum / highCount;
      }

      const lowAmplitude = Math.exp(low);
      const highAmplitude = Math.exp(high);
      const separation = highAmplitude / Math.max(1e-7, lowAmplitude);
      this.threshold = separation >= 2.3 && highAmplitude >= 0.003
        ? Math.max(0.0025, Math.sqrt(lowAmplitude * highAmplitude))
        : Infinity;
    }

    processFrame(samples) {
      const autoTone = this.callbacks.autoTone();
      const tone = autoTone
        ? this.detectedTone
        : clamp(Number(this.callbacks.manualTone()) || 700, 300, 1050);

      if (!autoTone) {
        this.detectedTone = tone;
        this.toneLocked = true;
      }

      const amplitude = this.goertzelAmplitude(samples, tone, this.sampleRate, this.frameWindow);
      const referenceFrequencies = [tone - 200, tone - 120, tone + 120, tone + 200]
        .filter((frequency) => frequency >= 250 && frequency <= 1150);
      const referenceAmplitudes = referenceFrequencies.map((frequency) => (
        this.goertzelAmplitude(samples, frequency, this.sampleRate, this.frameWindow)
      ));
      const noiseAmplitude = Math.max(1e-6, median(referenceAmplitudes));
      const prominence = amplitude / noiseAmplitude;

      this.lastAmplitude = amplitude;
      this.lastProminence = prominence;
      this.amplitudeHistory.push(amplitude);
      if (this.amplitudeHistory.length > 800) this.amplitudeHistory.shift();
      this.updateThreshold();

      const amplitudeOn = this.threshold * 1.05;
      const amplitudeOff = this.threshold * 0.88;
      const prominenceOn = 2.6;
      const prominenceOff = 2.0;
      const rawSignal = this.threshold !== Infinity
        && amplitude > (this.stableState ? amplitudeOff : amplitudeOn)
        && prominence > (this.stableState ? prominenceOff : prominenceOn);

      this.updateTiming(rawSignal);

      const now = performance.now();
      if (now - this.lastStatsAt >= 120) {
        this.lastStatsAt = now;
        const gaps = this.gapThresholds();
        this.callbacks.signal({
          signal: this.stableState,
          tone: Math.round(tone),
          wpm: this.currentWpm(),
          amplitude,
          threshold: Number.isFinite(this.threshold) ? this.threshold : 0,
          prominence,
          toneQuality: this.lastToneQuality,
          characterGap: gaps.character,
          wordGap: gaps.word,
        });
      }
    }

    updateTiming(rawState) {
      if (rawState === this.stableState) {
        this.stableDuration += this.hopMs;
        this.candidateState = null;
        this.candidateDuration = 0;
      } else {
        if (this.candidateState === rawState) this.candidateDuration += this.hopMs;
        else {
          this.candidateState = rawState;
          this.candidateDuration = this.hopMs;
        }

        if (this.candidateDuration >= 10) {
          const oldState = this.stableState;
          const oldDuration = this.stableDuration;
          this.stableState = rawState;
          this.stableDuration = this.candidateDuration;
          this.candidateState = null;
          this.candidateDuration = 0;
          if (oldState) this.finishMark(oldDuration);
          else this.finishGap(oldDuration);
        }
      }

      if (!this.stableState) this.flushDuringGap();
      if (this.lastSignal !== this.stableState) {
        this.lastSignal = this.stableState;
        this.callbacks.signalEdge(this.stableState);
      }
    }

    finishMark(durationMs) {
      // Use absolute physical limits here. Relative limits based on the current
      // WPM created a feedback loop: at 60 WPM real 180 ms dashes were discarded,
      // while 60 ms dots were classified as dashes.
      if (durationMs < 22) return;
      if (durationMs > 500) {
        this.patternMarks = [];
        this.pattern = "";
        return;
      }

      this.patternMarks.push(durationMs);
      if (this.patternMarks.length > 6) {
        this.patternMarks = [];
        this.pattern = "";
        return;
      }

      if (this.callbacks.autoSpeed()) {
        this.markHistory.push(durationMs);
        if (this.markHistory.length > 80) this.markHistory.shift();
        const model = this.markModel();
        this.ditMs = this.ditMs * 0.72 + model.dit * 0.28;
        this.callbacks.speedEstimate(this.currentWpm());
      }

      const model = this.markModel();
      this.pattern = this.patternMarks
        .map((duration) => duration >= model.threshold ? "-" : ".")
        .join("");
      this.characterFlushed = false;
      this.wordFlushed = false;
    }

    finishGap(durationMs) {
      this.learnGap(durationMs);
      const gaps = this.gapThresholds();
      if (durationMs >= gaps.character) this.flushCharacter();
      if (durationMs >= gaps.word) this.flushWord();
    }

    flushDuringGap() {
      const gaps = this.gapThresholds();
      if (!this.characterFlushed && this.patternMarks.length && this.stableDuration >= gaps.character) {
        this.flushCharacter();
      }
      if (this.characterFlushed && !this.wordFlushed && this.stableDuration >= gaps.word) {
        this.flushWord();
      }
    }

    flushCharacter() {
      if (!this.patternMarks.length || this.characterFlushed) return;
      const model = this.markModel();
      this.pattern = this.patternMarks
        .map((duration) => duration >= model.threshold ? "-" : ".")
        .join("");
      const character = MORSE_TO_TEXT[this.pattern];
      if (character) this.callbacks.appendText(character);
      this.pattern = "";
      this.patternMarks = [];
      this.characterFlushed = true;
    }

    flushWord() {
      if (this.wordFlushed) return;
      this.callbacks.appendText(" ");
      this.wordFlushed = true;
    }
  }

  const controller = {
    DecoderClass: CWDecoder,
    initialized: false,
    audioReady: false,
    voicePtt: false,
    radioState: null,
    ft8Running: false,
    cwState: { sending: false, message: "", wpm: 25, memory_slot: 5, estimated_remaining_s: 0 },
    decoder: null,
    statusTimer: null,

    init() {
      if (this.initialized) return;
      this.initialized = true;

      const decoded = byId("cw-decoded-text");
      const toneAuto = byId("cw-tone-auto");
      const toneHz = byId("cw-tone-hz");
      const speedAuto = byId("cw-speed-auto");
      const wpm = byId("cw-wpm");

      this.decoder = new CWDecoder({
        autoTone: () => toneAuto.checked,
        manualTone: () => toneHz.value,
        autoSpeed: () => speedAuto.checked,
        manualWpm: () => wpm.value,
        appendText: (text) => {
          if (text === " " && !decoded.value.trim()) return;
          let next = decoded.value + text;
          next = next.replace(/ {2,}/g, " ");
          if (next.length > 3000) next = next.slice(-3000);
          decoded.value = next;
          decoded.scrollTop = decoded.scrollHeight;
        },
        clearText: () => { decoded.value = ""; },
        speedEstimate: (value) => {
          if (speedAuto.checked && document.activeElement !== wpm) wpm.value = String(value);
        },
        signalEdge: () => this.render(),
        signal: (stats) => {
          this.lastSignalStats = stats;
          if (toneAuto.checked && document.activeElement !== toneHz) toneHz.value = String(stats.tone);
          if (speedAuto.checked && document.activeElement !== wpm) wpm.value = String(stats.wpm);
          const thresholdText = stats.threshold > 0 ? `${Math.round(stats.amplitude / stats.threshold * 100)}%` : "learning";
          const prominenceText = Number.isFinite(stats.prominence) ? `${stats.prominence.toFixed(1)}×` : "--";
          const signal = byId("cw-signal");
          const spacingText = stats.characterGap && stats.wordGap
            ? ` · gaps ${Math.round(stats.characterGap)}/${Math.round(stats.wordGap)} ms`
            : "";
          signal.textContent = `Tone ${stats.tone} Hz · ${stats.wpm} WPM · ${stats.signal ? "MARK" : "SPACE"} · level ${thresholdText} · SNR ${prominenceText}${spacingText}`;
          signal.classList.toggle("on", Boolean(stats.signal));
          this.render();
        },
      });

      byId("cw-decoder-enabled").addEventListener("change", (event) => {
        const enabled = Boolean(event.target.checked && this.audioReady);
        event.target.checked = enabled;
        this.decoder.setEnabled(enabled);
        this.render();
      });
      toneAuto.addEventListener("change", () => {
        toneHz.disabled = toneAuto.checked;
        this.decoder.reset(false);
      });
      speedAuto.addEventListener("change", () => this.decoder.reset(false));
      toneHz.addEventListener("change", () => this.decoder.reset(false));
      wpm.addEventListener("change", () => {
        wpm.value = String(clamp(Math.round(Number(wpm.value) || 25), 4, 60));
        if (!speedAuto.checked) this.decoder.reset(false);
      });
      byId("cw-clear").addEventListener("click", () => this.decoder.reset(true));
      byId("cw-copy").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(decoded.value);
        } catch (_) {
          decoded.select();
          document.execCommand("copy");
          decoded.setSelectionRange(0, 0);
        }
      });

      const message = byId("cw-message");
      message.addEventListener("input", () => {
        message.value = message.value.toUpperCase();
        byId("cw-character-count").textContent = `${message.value.length} / 50`;
      });
      byId("cw-send-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const text = message.value.trim();
        if (!text) return;
        const button = byId("cw-send");
        button.disabled = true;
        try {
          const result = await request("/api/v1/cw/send", {
            method: "POST",
            body: JSON.stringify({ message: text, wpm: clamp(Math.round(Number(wpm.value) || 25), 4, 60), memory_slot: 5 }),
          });
          this.cwState = result.cw;
          this.render();
        } catch (error) {
          window.alert(error.message);
        } finally {
          this.render();
        }
      });
      byId("cw-stop").addEventListener("click", async () => {
        try {
          const result = await request("/api/v1/cw/stop", { method: "POST", body: "{}" });
          this.cwState = result.cw;
        } catch (error) {
          window.alert(error.message);
        }
        this.render();
      });

      toneHz.disabled = toneAuto.checked;
      this.refreshStatus();
      this.statusTimer = window.setInterval(() => this.refreshStatus(), 750);
      this.render();
    },

    async refreshStatus() {
      try {
        const result = await request("/api/v1/cw/status");
        this.cwState = result.cw;
        this.render();
      } catch (_) { /* main connection indicator handles API errors */ }
    },

    setAudioReady(ready) {
      this.audioReady = Boolean(ready);
      const checkbox = byId("cw-decoder-enabled");
      if (!checkbox) return;
      checkbox.disabled = !this.audioReady;
      if (!this.audioReady && checkbox.checked) {
        checkbox.checked = false;
        this.decoder?.setEnabled(false);
      }
      const signal = byId("cw-signal");
      if (!this.audioReady) signal.textContent = "Tone -- Hz · -- WPM · waiting for audio";
      this.render();
    },

    setVoicePtt(active) {
      this.voicePtt = Boolean(active);
      this.render();
    },

    setFt8Running(running) {
      this.ft8Running = Boolean(running);
      this.render();
    },

    updateRadioState(state) {
      this.radioState = state;
      this.render();
    },

    feedAudio(buffer, sampleRate) {
      this.decoder?.feed(buffer, sampleRate);
    },

    render() {
      if (!this.initialized) return;
      const decoderEnabled = Boolean(byId("cw-decoder-enabled").checked && this.audioReady);
      const sending = Boolean(this.cwState?.sending);
      const signalOn = Boolean(this.lastSignalStats?.signal && decoderEnabled);
      const badge = byId("cw-status");
      badge.className = "cw-status";
      if (sending) {
        badge.textContent = `TX · ${this.cwState.estimated_remaining_s ?? 0}s`;
        badge.classList.add("transmitting");
      } else if (signalOn) {
        badge.textContent = "SIGNAL";
        badge.classList.add("signal");
      } else if (decoderEnabled) {
        badge.textContent = "RX";
        badge.classList.add("receiving");
      } else {
        badge.textContent = "OFF";
      }

      const radioOn = this.radioState?.radio_power === "ON";
      const cwMode = ["CW-U", "CW-L"].includes(this.radioState?.mode);
      byId("cw-send").disabled = sending || !radioOn || !cwMode || this.voicePtt || this.ft8Running;
      byId("cw-stop").disabled = !sending;
      byId("cw-message").disabled = sending;
      byId("cw-wpm").disabled = sending;
    },
  };

  window.FT710_CW = controller;
})();
