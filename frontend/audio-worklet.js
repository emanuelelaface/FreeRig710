"use strict";

class FT710CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedMs = Number(options?.processorOptions?.frameMs ?? 20);
    const frameMs = Math.max(10, Math.min(60, requestedMs));
    this.frameSamples = Math.max(128, Math.round(sampleRate * frameMs / 1000));
    this.frame = new Int16Array(this.frameSamples);
    this.offset = 0;
    this.enabled = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "capture") return;
      this.enabled = Boolean(event.data.enabled);
      this.frame = new Int16Array(this.frameSamples);
      this.offset = 0;
    };
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channel = input[0];

    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.frame[this.offset] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
      this.offset += 1;
      if (this.offset >= this.frame.length) {
        const completed = this.frame;
        this.port.postMessage(completed.buffer, [completed.buffer]);
        this.frame = new Int16Array(this.frameSamples);
        this.offset = 0;
      }
    }
    return true;
  }
}

class FT710PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions || {};
    const targetMs = Math.max(100, Math.min(350, Number(opts.targetBufferMs ?? 300)));
    const startMs = Math.max(80, Math.min(targetMs, Number(opts.startBufferMs ?? 280)));
    const maximumMs = Math.max(targetMs + 100, Math.min(1500, Number(opts.maximumBufferMs ?? 1000)));

    this.capacity = Math.max(4096, Math.round(sampleRate * 2.0));
    this.ring = new Float32Array(this.capacity);
    this.totalWritten = 0;
    this.readPosition = 0;
    this.started = false;
    this.lastSample = 0;
    this.targetSamples = sampleRate * targetMs / 1000;
    this.startSamples = sampleRate * startMs / 1000;
    this.maximumSamples = sampleRate * maximumMs / 1000;
    this.minimumSamples = sampleRate * 0.045;
    this.underruns = 0;
    this.overruns = 0;
    this.reportCounter = 0;
    this.playbackRate = 1;

    this.port.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const samples = new Int16Array(event.data);
      if (samples.length === 0) return;

      for (let index = 0; index < samples.length; index += 1) {
        this.ring[this.totalWritten % this.capacity] = samples[index] / 32768;
        this.totalWritten += 1;
      }

      let buffered = this.totalWritten - this.readPosition;
      if (buffered > this.maximumSamples || buffered > this.capacity - 256) {
        // A stalled tab/network must not leave seconds of stale receive audio.
        // Jump back to the target delay and restart with a clean short buffer.
        this.readPosition = Math.max(0, this.totalWritten - this.targetSamples);
        this.started = true;
        this.overruns += 1;
      }
    };
  }

  sampleAt(position) {
    if (position < 0 || position >= this.totalWritten) return 0;
    return this.ring[Math.floor(position) % this.capacity];
  }

  fillSilence(channel) {
    channel.fill(0);
    for (let index = 1; index < channel.length; index += 1) channel[index] = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    let buffered = this.totalWritten - this.readPosition;

    if (!this.started) {
      if (buffered < this.startSamples) {
        channel.fill(0);
        for (let outputIndex = 1; outputIndex < output.length; outputIndex += 1) {
          output[outputIndex].fill(0);
        }
        this.report(output[0].length);
        return true;
      }
      this.started = true;
      this.lastSample = 0;
    }

    // Correct clock drift gently. High buffer -> consume a little faster;
    // low buffer -> consume a little slower. The correction is inaudible but
    // prevents periodic drop-outs between the radio USB clock and Mac clock.
    buffered = this.totalWritten - this.readPosition;
    const normalizedError = (buffered - this.targetSamples) / Math.max(1, this.targetSamples);
    const correction = Math.max(-0.012, Math.min(0.012, normalizedError * 0.018));
    this.playbackRate = 1 + correction;

    let produced = 0;
    for (; produced < channel.length; produced += 1) {
      if (this.readPosition + 1 >= this.totalWritten) break;
      const base = Math.floor(this.readPosition);
      const fraction = this.readPosition - base;
      const first = this.sampleAt(base);
      const second = this.sampleAt(base + 1);
      const value = first + (second - first) * fraction;
      channel[produced] = value;
      this.lastSample = value;
      this.readPosition += this.playbackRate;
    }

    if (produced < channel.length) {
      // Smoothly fade the last render quantum rather than producing a click.
      const remaining = channel.length - produced;
      for (let index = 0; index < remaining; index += 1) {
        channel[produced + index] = this.lastSample * (1 - (index + 1) / remaining);
      }
      this.readPosition = this.totalWritten;
      this.started = false;
      this.underruns += 1;
    } else if ((this.totalWritten - this.readPosition) < this.minimumSamples) {
      // Slow down before a true underrun; do not force a rebuffer yet.
      this.playbackRate = Math.min(this.playbackRate, 0.988);
    }

    for (let outputIndex = 1; outputIndex < output.length; outputIndex += 1) {
      output[outputIndex].set(channel);
    }
    this.report(channel.length);
    return true;
  }

  report(renderedSamples) {
    this.reportCounter += renderedSamples;
    if (this.reportCounter < sampleRate) return;
    this.reportCounter -= sampleRate;
    const bufferedMs = Math.max(0, (this.totalWritten - this.readPosition) * 1000 / sampleRate);
    this.port.postMessage({
      type: "rx-stats",
      bufferedMs: Math.round(bufferedMs),
      underruns: this.underruns,
      overruns: this.overruns,
      playbackRate: Number(this.playbackRate.toFixed(5)),
    });
  }
}

registerProcessor("ft710-capture", FT710CaptureProcessor);
registerProcessor("ft710-playback", FT710PlaybackProcessor);
