"use strict";

window.FT710_CONFIG = Object.freeze({
  // When this GUI is served from localhost, it talks directly to the ESP32 via mDNS.
  // When served from HTTPS (reverse proxy), app.js uses same-origin paths instead.
  localDefaultBackend: "http://ft710.local",
  clickTuning: Object.freeze({
    nativeWidth: 800,
    nativeHeight: 480,
    waterfallLeft: 5,
    waterfallRight: 795,
    waterfallTop: 187,
    waterfallBottom: 403,
    roundingHz: 10,
  }),
});
