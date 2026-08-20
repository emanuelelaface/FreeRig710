"use strict";

// FT8.5.10.3 codec worker: RX decode + canonical 12 kHz WSJT-X-port TX source.
// RX remains on ft8js/ft8_lib (MIT), already validated on-air.
// TX deliberately uses @e04/ft8ts 0.0.14 (GPL-3.0), a browser-capable pure
// TypeScript port of the WSJT-X v2.7.0 FT8 implementation.  It synthesizes
// as the canonical WSJT-X-port 12 kHz waveform. FreeRig710 then performs a
// deterministic OFFLINE band-limited 4x interpolation to the FT-710 USB rate
// (48 kHz) before the whole waveform is staged on the ESP32. There is NO tone
// recovery, NO FreeRig710 GFSK reimplementation and NO realtime TX resampling.
const FT8JS_DECODE_MODULE_URL = "https://cdn.jsdelivr.net/npm/ft8js@0.0.2/wasm/decode.js";
const FT8TS_TX_MODULE_URL = "https://cdn.jsdelivr.net/npm/@e04/ft8ts@0.0.14/+esm";
const RESULT_SIZE = 2048;
const SLOT_SAMPLES = 180000;                 // 15 s @ 12 kHz for RX decoder
const FT8_SYMBOLS = 79;
const FT8_SYMBOL_SECONDS = 0.160;
const ENCODE_RATE = 12000;
const TX_RATE = 48000;
const ENCODE_SAMPLES = Math.round(FT8_SYMBOLS * FT8_SYMBOL_SECONDS * ENCODE_RATE); // 151680 = 12.64 s
const ENCODE_ALLOC_SAMPLES = SLOT_SAMPLES;   // upstream wrapper allocates 15 s; only first 12.64 s is written

const SNR_FFT_SIZE = 2048;
const SNR_FFT_HOP = 1024;
const SNR_REFERENCE_BW_HZ = 2500;

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
      if (i < j) { const tr = real[i]; real[i] = real[j]; real[j] = tr; const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let wr = 1, wi = 0;
        for (let j = 0; j < len / 2; j += 1) {
          const a = start + j, b = a + len / 2;
          const br = real[b] * wr - imag[b] * wi, bi = real[b] * wi + imag[b] * wr;
          const ar = real[a], ai = imag[a];
          real[a] = ar + br; imag[a] = ai + bi; real[b] = ar - br; imag[b] = ai - bi;
          const nextWr = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nextWr;
        }
      }
    }
    return { real, imag };
  }
}

function median(values) {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length & 1 ? values[mid] : 0.5 * (values[mid - 1] + values[mid]);
}

// Estimate received FT8 SNR from the actual 12 kHz PCM rather than from the
// ft8_lib sync score.  WSJT-X reports S/N in a 2500 Hz reference bandwidth.
// We average a Hann-windowed PSD over the slot, subtract the local noise floor
// from the decoded ~50 Hz FT8 channel, then scale that noise PSD to 2500 Hz.
function estimateSnr2500(samples, results, validSamples = samples?.length || 0) {
  if (!(samples instanceof Float32Array) || !results?.length) return results;
  const fft = new Radix2FFT(SNR_FFT_SIZE);
  const block = new Float64Array(SNR_FFT_SIZE);
  const psd = new Float64Array(SNR_FFT_SIZE / 2 + 1);
  let frames = 0;
  const usableSamples = Math.max(0, Math.min(samples.length, Number(validSamples) || samples.length));
  for (let start = 0; start + SNR_FFT_SIZE <= usableSamples; start += SNR_FFT_HOP) {
    for (let i = 0; i < SNR_FFT_SIZE; i += 1) block[i] = samples[start + i];
    const { real, imag } = fft.transform(block);
    for (let k = 0; k < psd.length; k += 1) psd[k] += real[k] * real[k] + imag[k] * imag[k];
    frames += 1;
  }
  if (!frames) return results;
  for (let k = 0; k < psd.length; k += 1) psd[k] /= frames;
  const binHz = ENCODE_RATE / SNR_FFT_SIZE;

  for (const result of results) {
    const base = Number(result.df);
    if (!Number.isFinite(base)) { result.snr = NaN; continue; }
    // ft8js reports the candidate base frequency (tone 0).  Include the full
    // 8-tone span plus a small Hann leakage guard on each side.
    const sigLoHz = Math.max(200, base - 8);
    const sigHiHz = Math.min(3000, base + 7 * 6.25 + 8);
    const sigLo = Math.max(1, Math.floor(sigLoHz / binHz));
    const sigHi = Math.min(psd.length - 2, Math.ceil(sigHiHz / binHz));
    let bandPower = 0;
    for (let k = sigLo; k <= sigHi; k += 1) bandPower += psd[k];
    const sigBins = Math.max(1, sigHi - sigLo + 1);

    // Use the median local PSD so nearby FT8 carriers do not dominate the
    // noise estimate. Exclude ~100 Hz around this decoded channel.
    const noiseBins = [];
    const searchLo = Math.max(1, Math.floor(Math.max(200, base - 350) / binHz));
    const searchHi = Math.min(psd.length - 2, Math.ceil(Math.min(3000, base + 7 * 6.25 + 350) / binHz));
    const excludeLo = Math.floor((base - 70) / binHz);
    const excludeHi = Math.ceil((base + 7 * 6.25 + 70) / binHz);
    for (let k = searchLo; k <= searchHi; k += 1) if (k < excludeLo || k > excludeHi) noiseBins.push(psd[k]);
    const noisePerBin = median(noiseBins.filter((v) => Number.isFinite(v) && v > 0));
    if (!Number.isFinite(noisePerBin) || noisePerBin <= 0) { result.snr = NaN; continue; }
    const noiseInBand = noisePerBin * sigBins;
    // The PSD spans the whole 15 s receive slot while an FT8 waveform is
    // nominally 12.64 s long. Correct the decoded-signal energy for that duty
    // factor before converting to the 2500 Hz reference-bandwidth SNR.
    const captureSeconds = Math.max(12.64, usableSamples / ENCODE_RATE);
    const signalPower = Math.max(noisePerBin * 1e-6, bandPower - noiseInBand) * (captureSeconds / 12.64);
    // Because signal energy is integrated across FFT bins, reference the
    // median per-bin noise power by the actual number of bins in 2500 Hz.
    // (Using Hann ENBW here would overstate SNR by ~1.76 dB.)
    const noise2500 = noisePerBin * (SNR_REFERENCE_BW_HZ / binHz);
    const snr = 10 * Math.log10(signalPower / Math.max(1e-30, noise2500));
    result.snr = Math.max(-35, Math.min(35, snr));
  }
  return results;
}

let decoder = null;
let decoderLoading = null;
let encoder = null;
let encoderLoading = null;

function parseResults(raw) {
  return raw
    .replaceAll("\x00", "")
    .trim()
    .split("\n")
    .filter((row) => row.length > 0)
    .map((row) => {
      const c1 = row.indexOf(",");
      const c2 = c1 >= 0 ? row.indexOf(",", c1 + 1) : -1;
      const c3 = c2 >= 0 ? row.indexOf(",", c2 + 1) : -1;
      if (c1 < 0 || c2 < 0 || c3 < 0) return null;
      return {
        db: Number(row.slice(0, c1)),
        dt: Number(row.slice(c1 + 1, c2)),
        df: Number(row.slice(c2 + 1, c3)),
        text: row.slice(c3 + 1),
      };
    })
    .filter((row) => row && Number.isFinite(row.db) && Number.isFinite(row.dt) && Number.isFinite(row.df));
}

async function ensureDecoder() {
  if (decoder) return decoder;
  if (!decoderLoading) {
    decoderLoading = (async () => {
      const imported = await import(FT8JS_DECODE_MODULE_URL);
      const factory = imported?.default;
      if (typeof factory !== "function") throw new Error("ft8js decoder module factory missing");
      const module = await factory();
      if (!module || typeof module.cwrap !== "function" || typeof module._malloc !== "function" || typeof module._free !== "function") {
        throw new Error("ft8js decoder module API incomplete");
      }
      const initDecode = module.cwrap("init_decode", "number", [], []);
      const execDecode = module.cwrap("exec_decode", null, ["number", "number", "number"], { async: true });
      const decoderPtr = initDecode();
      const resultPtr = module._malloc(RESULT_SIZE);
      if (!decoderPtr || !resultPtr) throw new Error("ft8_lib decoder allocation failed");
      decoder = { module, execDecode, decoderPtr, resultPtr };
      self.postMessage({ type: "decoder-ready", library: "ft8js decoder module", version: "0.0.2", backend: "ft8_lib/WASM" });
      return decoder;
    })().catch((error) => { decoderLoading = null; throw error; });
  }
  return decoderLoading;
}

async function ensureEncoder() {
  if (encoder) return encoder;
  if (!encoderLoading) {
    encoderLoading = (async () => {
      const module = await import(FT8TS_TX_MODULE_URL);
      if (!module || typeof module.encodeFT8 !== "function") {
        throw new Error("@e04/ft8ts encodeFT8 API missing");
      }
      encoder = { encodeFT8: module.encodeFT8 };
      self.postMessage({
        type: "encoder-ready",
        library: "@e04/ft8ts",
        version: "0.0.14",
        backend: "WSJT-X v2.7.0 TypeScript port",
      });
      return encoder;
    })().catch((error) => { encoderLoading = null; throw error; });
  }
  return encoderLoading;
}

async function decodeSlot(samples) {
  const d = await ensureDecoder();
  if (!(samples instanceof Float32Array) || samples.length !== SLOT_SAMPLES) {
    throw new Error(`expected ${SLOT_SAMPLES} Float32 samples, got ${samples?.length || 0}`);
  }
  const inputBytes = samples.byteLength;
  const inputPtr = d.module._malloc(inputBytes);
  if (!inputPtr) throw new Error("FT8 input allocation failed");
  try {
    d.module.HEAPF32.set(samples, inputPtr / Float32Array.BYTES_PER_ELEMENT);
    await d.execDecode(d.decoderPtr, inputPtr, d.resultPtr);
    const raw = new Uint8Array(d.module.HEAPU8.buffer, d.resultPtr, RESULT_SIZE);
    return parseResults(new TextDecoder("utf-8").decode(raw));
  } finally {
    d.module._free(inputPtr);
  }
}


const FT8_TONE_SPACING_HZ = 6.25;

// Deterministic offline 4x interpolation.  The TX source produced by ft8ts is
// the canonical WSJT-X-port waveform at 12 kHz.  We must not pace it in real
// time from JavaScript; instead render the whole 48 kHz waveform here, then
// stage it in ESP32 PSRAM before the slot.  A windowed-sinc interpolator keeps
// the phase/frequency waveform band-limited without the sample-repeat images
// used in early FT8 prototypes.
function sinc(x) {
  if (Math.abs(x) < 1e-12) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczos(x, radius) {
  const ax = Math.abs(x);
  if (ax >= radius) return 0;
  return sinc(x) * sinc(x / radius);
}

function resample12kTo48k(input) {
  if (!(input instanceof Float32Array) || input.length !== ENCODE_SAMPLES) {
    throw new Error(`expected ${ENCODE_SAMPLES} source samples for 4x interpolation`);
  }
  const factor = 4;
  const radius = 8; // 16 source-sample window; ample for the <3 kHz FT8 passband.
  const output = new Float32Array(input.length * factor);
  for (let m = 0; m < output.length; m += 1) {
    const t = m / factor;
    const center = Math.floor(t);
    let acc = 0;
    let weight = 0;
    const first = center - radius + 1;
    const last = center + radius;
    for (let k = first; k <= last; k += 1) {
      if (k < 0 || k >= input.length) continue;
      const w = lanczos(t - k, radius);
      acc += input[k] * w;
      weight += w;
    }
    output[m] = Math.abs(weight) > 1e-12 ? acc / weight : 0;
  }
  return output;
}

function waveformStats(samples) {
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Number(samples[i]) || 0;
    peak = Math.max(peak, Math.abs(v));
    sumSq += v * v;
  }
  return { peak, rmsDbfs: 20 * Math.log10(Math.max(1e-12, Math.sqrt(sumSq / Math.max(1, samples.length)))) };
}

async function encodeTx(message, frequency, levelDbfs) {
  const text = String(message || "").trim().toUpperCase();
  if (!text) throw new Error("empty FT8 message");
  const baseHz = Number(frequency);
  if (!Number.isFinite(baseHz) || baseHz < 200 || baseHz > 3000) throw new Error("invalid FT8 audio frequency");
  const dbfs = Math.max(-40, Math.min(-1, Number(levelDbfs)));
  const e = await ensureEncoder();

  // ft8ts is a pure TypeScript port of the WSJT-X v2.7.0 implementation.  Its
  // current public encoder returns the canonical 12 kHz / 12.64 s waveform.
  const raw12 = e.encodeFT8(text, { sampleRate: ENCODE_RATE, baseFrequency: baseHz });
  if (!(raw12 instanceof Float32Array)) throw new Error("ft8ts encodeFT8 did not return Float32Array");
  if (raw12.length !== ENCODE_SAMPLES) throw new Error(`ft8ts 12 kHz TX length mismatch: expected ${ENCODE_SAMPLES}, got ${raw12.length}`);

  const sourceStats = waveformStats(raw12);
  if (!(sourceStats.peak > 0)) throw new Error("ft8ts returned a silent FT8 waveform");

  // Normalize once, interpolate offline, then apply the ALC-calibrated peak
  // level.  No real-time browser clock participates in RF playback.
  const normalized = new Float32Array(raw12.length);
  for (let i = 0; i < raw12.length; i += 1) normalized[i] = raw12[i] / sourceStats.peak;
  const rendered48 = resample12kTo48k(normalized);
  const gain = Math.pow(10, dbfs / 20);
  const pcm = new Int16Array(rendered48.length);
  let peakPcm = 0;
  let sumSq = 0;
  for (let i = 0; i < rendered48.length; i += 1) {
    const v = Math.max(-1, Math.min(1, rendered48[i] * gain));
    sumSq += v * v;
    const q = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    pcm[i] = q;
    peakPcm = Math.max(peakPcm, Math.abs(q));
  }
  if (pcm.length !== 606720) throw new Error(`48 kHz FT8 render length mismatch: ${pcm.length}`);

  return {
    message: text,
    tones: new Uint8Array(0),
    sourceRate: ENCODE_RATE,
    targetRate: TX_RATE,
    durationMs: pcm.length * 1000 / TX_RATE,
    audioBaseHz: baseHz,
    audioTopHz: baseHz + 7 * FT8_TONE_SPACING_HZ,
    levelDbfs: dbfs,
    peakFloat: sourceStats.peak,
    sourceRmsDbfs: sourceStats.rmsDbfs,
    pcm,
    sampleRate: TX_RATE,
    stagedSampleRate: TX_RATE,
    samples: pcm.length,
    peakPcm,
    rmsDbfs: 20 * Math.log10(Math.max(1e-12, Math.sqrt(sumSq / Math.max(1, rendered48.length)))),
    amRippleDb: NaN,
    resampler: "ft8ts WSJT-X-port 12 kHz → offline Lanczos-8 48 kHz → staged PSRAM",
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    try { await ensureDecoder(); }
    catch (error) { self.postMessage({ type: "decoder-error", error: String(error?.message || error) }); }
    return;
  }
  if (message.type === "init-encoder") {
    try { await ensureEncoder(); }
    catch (error) { self.postMessage({ type: "encoder-error", error: String(error?.message || error) }); }
    return;
  }
  if (message.type === "encode") {
    const requestId = Number(message.requestId);
    const started = performance.now();
    try {
      const result = await encodeTx(message.message, message.frequency, message.levelDbfs);
      self.postMessage({
        type: "encode-result",
        requestId,
        elapsedMs: performance.now() - started,
        message: result.message,
        sourceRate: result.sourceRate,
        targetRate: result.targetRate,
        durationMs: result.durationMs,
        audioBaseHz: result.audioBaseHz,
        audioTopHz: result.audioTopHz,
        levelDbfs: result.levelDbfs,
        peakFloat: result.peakFloat,
        sourceRmsDbfs: result.sourceRmsDbfs,
        sampleRate: result.sampleRate,
        stagedSampleRate: result.stagedSampleRate,
        samples: result.samples,
        peakPcm: result.peakPcm,
        rmsDbfs: result.rmsDbfs,
        amRippleDb: result.amRippleDb,
        resampler: result.resampler,
        tones: Array.from(result.tones),
        pcm: result.pcm.buffer,
      }, [result.pcm.buffer]);
    } catch (error) {
      self.postMessage({ type: "encode-error", requestId, elapsedMs: performance.now() - started, error: String(error?.message || error) });
    }
    return;
  }
  if (message.type !== "decode") return;

  const slotIndex = Number(message.slotIndex);
  const started = performance.now();
  try {
    const samples = message.samples instanceof ArrayBuffer ? new Float32Array(message.samples) : null;
    const results = await decodeSlot(samples);
    estimateSnr2500(samples, results, Number(message.validSamples) || samples.length);
    self.postMessage({ type: "decode-result", slotIndex, elapsedMs: performance.now() - started, results });
  } catch (error) {
    self.postMessage({ type: "decode-error", slotIndex, elapsedMs: performance.now() - started, error: String(error?.message || error) });
  }
};
