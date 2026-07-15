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
      this.windowMs = 10;
      this.pending = new Int16Array(0);
      this.windowCounter = 0;
      this.amplitudeHistory = [];
      this.markHistory = [];
      this.threshold = Infinity;
      this.detectedTone = 700;
      this.stableState = false;
      this.stableDuration = 0;
      this.candidateState = null;
      this.candidateDuration = 0;
      this.pattern = "";
      this.characterFlushed = false;
      this.wordFlushed = false;
      this.ditMs = 1200 / 25;
      this.lastStatsAt = 0;
      this.lastAmplitude = 0;
      this.lastSignal = false;
    }

    reset(clearText = false) {
      this.pending = new Int16Array(0);
      this.windowCounter = 0;
      this.amplitudeHistory = [];
      this.markHistory = [];
      this.threshold = Infinity;
      this.stableState = false;
      this.stableDuration = 0;
      this.candidateState = null;
      this.candidateDuration = 0;
      this.pattern = "";
      this.characterFlushed = false;
      this.wordFlushed = false;
      this.lastSignal = false;
      if (clearText) this.callbacks.clearText();
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);
      this.reset(false);
      this.callbacks.signal({ signal: false, tone: this.detectedTone, wpm: this.currentWpm(), amplitude: 0, threshold: 0 });
    }

    currentWpm() {
      if (!this.callbacks.autoSpeed()) return clamp(Number(this.callbacks.manualWpm()) || 25, 4, 60);
      return clamp(Math.round(1200 / Math.max(20, this.ditMs)), 4, 60);
    }

    currentDitMs() {
      if (!this.callbacks.autoSpeed()) return 1200 / clamp(Number(this.callbacks.manualWpm()) || 25, 4, 60);
      return clamp(this.ditMs, 20, 300);
    }

    feed(arrayBuffer, sampleRate) {
      if (!this.enabled || !(arrayBuffer instanceof ArrayBuffer)) return;
      const incoming = new Int16Array(arrayBuffer);
      if (!incoming.length) return;
      if (Number(sampleRate) !== this.sampleRate) {
        this.sampleRate = Number(sampleRate) || 44100;
        this.reset(false);
      }

      const combined = new Int16Array(this.pending.length + incoming.length);
      combined.set(this.pending, 0);
      combined.set(incoming, this.pending.length);
      const windowSamples = Math.max(128, Math.round(this.sampleRate * this.windowMs / 1000));
      let offset = 0;
      while (offset + windowSamples <= combined.length) {
        this.processWindow(combined.subarray(offset, offset + windowSamples));
        offset += windowSamples;
      }
      this.pending = combined.slice(offset);
    }

    goertzelAmplitude(samples, frequency) {
      const omega = 2 * Math.PI * frequency / this.sampleRate;
      const coefficient = 2 * Math.cos(omega);
      let previous = 0;
      let previous2 = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index] / 32768;
        const current = value + coefficient * previous - previous2;
        previous2 = previous;
        previous = current;
      }
      const power = Math.max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
      return 2 * Math.sqrt(power) / samples.length;
    }

    scanTone(samples) {
      let bestFrequency = this.detectedTone;
      let bestAmplitude = 0;
      for (let frequency = 300; frequency <= 1050; frequency += 25) {
        const amplitude = this.goertzelAmplitude(samples, frequency);
        if (amplitude > bestAmplitude) {
          bestAmplitude = amplitude;
          bestFrequency = frequency;
        }
      }
      return { frequency: bestFrequency, amplitude: bestAmplitude };
    }

    updateThreshold() {
      if (this.amplitudeHistory.length < 30) {
        this.threshold = Infinity;
        return;
      }
      const logs = this.amplitudeHistory.map((value) => Math.log(Math.max(1e-6, value)));
      let low = Math.min(...logs);
      let high = Math.max(...logs);
      for (let iteration = 0; iteration < 8; iteration += 1) {
        let lowSum = 0;
        let lowCount = 0;
        let highSum = 0;
        let highCount = 0;
        const midpoint = (low + high) / 2;
        for (const value of logs) {
          if (value <= midpoint) { lowSum += value; lowCount += 1; }
          else { highSum += value; highCount += 1; }
        }
        if (lowCount) low = lowSum / lowCount;
        if (highCount) high = highSum / highCount;
      }
      const separation = Math.exp(high - low);
      const highAmplitude = Math.exp(high);
      this.threshold = separation >= 3.0 && highAmplitude >= 0.006
        ? Math.max(0.004, Math.exp((low + high) / 2))
        : Infinity;
    }

    processWindow(samples) {
      this.windowCounter += 1;
      const autoTone = this.callbacks.autoTone();
      let tone = clamp(Number(this.callbacks.manualTone()) || 700, 300, 1050);
      let amplitude;

      if (autoTone && this.windowCounter % 2 === 0) {
        const scanned = this.scanTone(samples);
        amplitude = scanned.amplitude;
        const useful = amplitude > 0.003 && (this.threshold === Infinity || amplitude > this.threshold * 1.1);
        if (useful) this.detectedTone = this.detectedTone * 0.78 + scanned.frequency * 0.22;
        tone = this.detectedTone;
      } else {
        tone = autoTone ? this.detectedTone : tone;
        amplitude = this.goertzelAmplitude(samples, tone);
      }

      this.lastAmplitude = amplitude;
      this.amplitudeHistory.push(amplitude);
      if (this.amplitudeHistory.length > 240) this.amplitudeHistory.shift();
      this.updateThreshold();

      const onThreshold = this.threshold * 1.05;
      const offThreshold = this.threshold * 0.95;
      const rawSignal = this.threshold !== Infinity && amplitude > (this.stableState ? offThreshold : onThreshold);
      this.updateTiming(rawSignal);

      const now = performance.now();
      if (now - this.lastStatsAt >= 120) {
        this.lastStatsAt = now;
        this.callbacks.signal({
          signal: this.stableState,
          tone: Math.round(tone),
          wpm: this.currentWpm(),
          amplitude,
          threshold: Number.isFinite(this.threshold) ? this.threshold : 0,
        });
      }
    }

    updateTiming(rawState) {
      if (rawState === this.stableState) {
        this.stableDuration += this.windowMs;
        this.candidateState = null;
        this.candidateDuration = 0;
      } else {
        if (this.candidateState === rawState) this.candidateDuration += this.windowMs;
        else {
          this.candidateState = rawState;
          this.candidateDuration = this.windowMs;
        }
        if (this.candidateDuration >= 20) {
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
      if (durationMs < 12) return;
      const dit = this.currentDitMs();
      const isDash = durationMs >= dit * 2.05;
      this.pattern += isDash ? "-" : ".";
      if (this.callbacks.autoSpeed()) {
        const candidate = clamp(isDash ? durationMs / 3 : durationMs, 20, 300);
        this.markHistory.push(candidate);
        if (this.markHistory.length > 18) this.markHistory.shift();
        this.ditMs = this.ditMs * 0.70 + median(this.markHistory) * 0.30;
        this.callbacks.speedEstimate(this.currentWpm());
      }
      this.characterFlushed = false;
      this.wordFlushed = false;
    }

    finishGap(durationMs) {
      const dit = this.currentDitMs();
      if (durationMs >= dit * 1.7) this.flushCharacter();
      if (durationMs >= dit * 4.3) this.flushWord();
    }

    flushDuringGap() {
      const dit = this.currentDitMs();
      if (!this.characterFlushed && this.pattern && this.stableDuration >= dit * 1.7) this.flushCharacter();
      if (this.characterFlushed && !this.wordFlushed && this.stableDuration >= dit * 4.3) this.flushWord();
    }

    flushCharacter() {
      if (!this.pattern || this.characterFlushed) return;
      const character = MORSE_TO_TEXT[this.pattern] || "□";
      this.callbacks.appendText(character);
      this.pattern = "";
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
          const signal = byId("cw-signal");
          signal.textContent = `Tone ${stats.tone} Hz · ${stats.wpm} WPM · ${stats.signal ? "MARK" : "SPACE"} · level ${thresholdText}`;
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
