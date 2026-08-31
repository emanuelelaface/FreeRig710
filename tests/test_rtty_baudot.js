"use strict";

const assert = require("assert");
const path = require("path");

global.window = { location: { hostname: "localhost", origin: "http://localhost" }, FT710_CONFIG: {} };
global.document = { getElementById() { return null; } };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

require(path.join(__dirname, "..", "frontend", "rtty-page.js"));

const rtty = window.FT710_RTTY;
assert.ok(rtty, "RTTY API was not exported");

const roundTrip = "CQ CQ DE SA7CHI 599?";
const codes = rtty.encodeTextToBaudot(roundTrip);
assert.ok(codes.includes(rtty.constants.FIGURES_SHIFT), "figures shift was not inserted");
assert.ok(codes.includes(rtty.constants.LETTERS_SHIFT), "letters shift was not inserted");
assert.equal(rtty.decodeBaudotCodes(codes), roundTrip);

function decodePcm(pcm, options = {}) {
  let decoded = "";
  const decoder = new rtty.RTTYDecoder({
    char(char) {
      decoded += char === "\r" ? "" : char;
    },
  }, {
    baud: 45.45,
    markHz: 2125,
    shiftHz: 170,
    unshiftOnSpace: true,
    ...options,
  });
  decoder.setEnabled(true);
  decoder.feed(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), 48000);
  return decoded;
}

const pcm = rtty.synthesizeRtty("RY TEST", {
  baud: 45.45,
  markHz: 2125,
  shiftHz: 170,
  levelDbfs: -18,
  preMs: 800,
  postMs: 500,
});
assert.ok(pcm instanceof Int16Array, "RTTY encoder did not produce Int16 PCM");
assert.ok(pcm.length > 48000, "RTTY waveform is unexpectedly short");
assert.ok(pcm.byteLength < rtty.constants.MAX_STAGED_BYTES, "RTTY waveform exceeds staged buffer");
assert.equal(rtty.constants.DEFAULT_RADIO_MODE, "DATA-U", "RTTY AFSK TX should default to the FT-710 data-audio mode");
assert.equal(rtty.constants.RTTY_FILTER_WIDTH_CODE, 0, "RTTY band setup should keep the radio mode default filter");
assert.equal(rtty.constants.RTTY_WATERFALL_SPAN_HZ, 2800, "RTTY waterfall should show the full DATA-U audio passband");
assert.equal(rtty.constants.RTTY_TX_TONE_RAMP_MS, 2, "RTTY AFSK tone transitions should be lightly shaped");

function goertzelPower(samples, sampleRate, frequency) {
  const coeff = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    s0 = samples[i] / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

const toneProbe = rtty.synthesizeRtty("RYRYRYRYRYRY", {
  baud: 45.45,
  markHz: 2125,
  shiftHz: 170,
  levelDbfs: -18,
  preMs: 0,
  postMs: 0,
});
const markPower = goertzelPower(toneProbe, 48000, 2125);
const spacePower = goertzelPower(toneProbe, 48000, 2295);
const adjacentPower = Math.max(goertzelPower(toneProbe, 48000, 1955), goertzelPower(toneProbe, 48000, 2465));
assert.ok(markPower > adjacentPower * 8, "RTTY TX waveform is missing the mark tone");
assert.ok(spacePower > adjacentPower * 8, "RTTY TX waveform is missing the space tone");

const decoded = decodePcm(pcm);
assert.ok(decoded.includes("RY TEST"), `RTTY decoder returned ${JSON.stringify(decoded)}`);

const reversedPcm = rtty.synthesizeRtty("CQ TEST", {
  baud: 45.45,
  markHz: 2125,
  shiftHz: 170,
  levelDbfs: -18,
  txReverse: true,
  preMs: 800,
  postMs: 500,
});
const reversedDecoded = decodePcm(reversedPcm, { rxReverse: true });
assert.ok(reversedDecoded.includes("CQ TEST"), `RTTY reverse decoder returned ${JSON.stringify(reversedDecoded)}`);

let seed = 0x710;
const noise = new Int16Array(48000 * 3);
for (let i = 0; i < noise.length; i += 1) {
  seed = (1664525 * seed + 1013904223) >>> 0;
  noise[i] = ((seed >>> 16) & 0x1ff) - 256;
}
const noiseDecoded = decodePcm(noise);
assert.equal(noiseDecoded, "", `RTTY decoder should reject noise, got ${JSON.stringify(noiseDecoded)}`);

const baud50Pcm = rtty.synthesizeRtty("CQ CQ DE SA7CHI TEST", {
  baud: 50,
  markHz: 2125,
  shiftHz: 170,
  levelDbfs: -18,
  preMs: 800,
  postMs: 500,
});
const auto50 = rtty.autoSelectRttyCandidate(baud50Pcm, 48000, {
  baud: 45.45,
  markHz: 2125,
  shiftHz: 170,
  unshiftOnSpace: true,
}, [{ markHz: 2125, shiftHz: 170 }]);
assert.ok(auto50, "Auto RX did not return a candidate");
assert.equal(auto50.baud, 50, `Auto RX selected ${auto50.baud} baud`);
assert.ok(auto50.text.includes("SA7CHI TEST"), `Auto RX decoded ${JSON.stringify(auto50.text)}`);

console.log("RTTY Baudot and AFSK modem contract: OK");
