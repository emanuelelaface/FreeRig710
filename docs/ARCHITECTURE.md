# Architecture

FreeRig710 moves the old Raspberry Pi responsibilities into the ESP32-P4 firmware and the browser.

## Firmware components

- `board` — fixed Waveshare ESP32-P4-NANO board wiring.
- `network_eth` — Ethernet, DHCP, mDNS and SNTP.
- `tc358743` — HDMI/DVI receiver and EDID/CSI transmitter configuration.
- `video_capture` — ESP32-P4 CSI capture and recovery.
- `video_jpeg` — hardware JPEG/MJPEG path.
- `ft710_usb` — USB host topology enumeration and Full-Speed host workaround.
- `ft710_cat` — CP2105 CAT-2/AUX transport and radio state polling/control.
- `ft710_audio` — UAC1 receive stream.
- `ft710_audio_tx` — UAC1 transmit stream.
- `freerig_config` — NVS station/logging/memory metadata.
- `freerig_memories` — FT-710 memory synchronization.
- `web_api` — HTTP API, MJPEG, bidirectional audio WebSocket, QRZ/GridTracker logging and FT8 TX services.

## Frontend

- `index.html`, `app.js`, `styles.css` — main station UI.
- `ft8.html`, `ft8-page.js`, `ft8.js`, `ft8-page.css` — FT8 operating console.
- `ft8-worker.js` — FT8 RX/TX codec worker and waveform preparation.
- `ft8-qso-machine.js` — QSO state machine.
- `ft8-logbook.js` — local ADIF/IndexedDB worked/QSO database and QRZ sync support.
- `ft8-decode-rules.js` — FT8 filter/color rule matching.
- `ft8-geo.js` — compact offline Maidenhead geography index.
- `js8.html`, `js8-page.js`, `js8-page.css` — native browser JS8 operating console.
- `vendor/js8/` — vendored JS8 WASM codec assets from wfweb/JS8Call-improved.
- `winlink.html` — browser Winlink/ARDOP console adapted from DL2MAN's ARDOP Winlink work.
- `settings.js` — shared station/backend settings used by Radio, FT8, JS8 and Winlink.
- `audio-worklet.js` — shared browser audio processing.
- `cw.js`, `sstv.js` — auxiliary browser modes.

## Important API paths

```text
/api/v1/state
/api/v1/radio/*
/api/v1/memories/*
/api/v1/qrz/*
/api/v1/ft8/*
/api/v1/audio/ws
/video.mjpeg
/video.jpg
```

Apache should proxy only the API/audio/video paths. `index.html`, `ft8.html`, `js8.html` and `winlink.html` are static files served directly from the web root.
