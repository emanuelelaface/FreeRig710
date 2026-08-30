global.window = {};
global.document = { getElementById: () => null };

require("../frontend/sstv.js");

const { EncoderClass, Modes, TxModeKeys } = window.FT710_SSTV;
const expectedSeconds = {
  robot36: [36.5, 37.5],
  pd50: [50.0, 51.2],
  martin2: [58.2, 59.6],
  scottie2: [71.4, 72.8],
  robot72: [72.2, 73.6],
  pd90: [90.2, 91.6],
  scottie1: [109.8, 111.2],
  martin1: [114.5, 115.9],
  pd120: [126.3, 127.7],
};
const maxStagedBytes = 12 * 1024 * 1024;

for (const key of TxModeKeys) {
  const mode = Modes[key];
  const data = new Uint8ClampedArray(mode.width * mode.height * 4);
  for (let pixel = 0; pixel < mode.width * mode.height; pixel += 1) {
    const x = pixel % mode.width;
    const y = Math.floor(pixel / mode.width);
    const offset = pixel * 4;
    data[offset] = Math.round(x * 255 / Math.max(1, mode.width - 1));
    data[offset + 1] = Math.round(y * 255 / Math.max(1, mode.height - 1));
    data[offset + 2] = 128;
    data[offset + 3] = 255;
  }

  const pcm = new EncoderClass({ levelDbfs: -24 }).build(key, {
    width: mode.width,
    height: mode.height,
    data,
  });
  const seconds = pcm.length / 48000;
  const [low, high] = expectedSeconds[key];
  if (!(pcm instanceof Int16Array) || pcm.length === 0) throw new Error(`${key} did not produce PCM`);
  if (pcm.byteLength > maxStagedBytes) throw new Error(`${key} exceeds staged digital waveform limit`);
  if (seconds < low || seconds > high) throw new Error(`${key} duration ${seconds.toFixed(2)}s outside expected range`);
}

console.log("SSTV encoder staged waveform contract: OK");
