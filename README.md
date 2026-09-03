# FreeRig710

**FreeRig710** is a self-hosted browser station for the **Yaesu FT-710**, built around a **Waveshare ESP32-P4-NANO**. The ESP32-P4 handles CAT, USB audio, the FT-710 external-display capture, the HTTP/WebSocket API and the guarded transmit path; the browser provides the radio UI plus FT8, JS8, RTTY and Winlink/ARDOP operating consoles.

[![Buy FreeRig710 on Tindie](https://raw.githubusercontent.com/emanuelelaface/USBtoC64/main/images/tindie-logo.png)](https://www.tindie.com/products/burglar_ot/freerig-710/)

> **RF safety:** this software can key a real transmitter. Start at low power or into a dummy load, verify CAT/PTT/audio behavior locally, and do not expose the ESP32 HTTP port directly to the public Internet.

FreeRig710 is not affiliated with or endorsed by Yaesu. "Yaesu" and "FT-710" identify the supported radio only.

## Screenshots

### Main radio console

![FreeRig710 main radio console](docs/images/main-console.png)

### FT8 console

![FreeRig710 FT8 operating console](docs/images/ft8-console.png)

### JS8 console

![FreeRig710 JS8 operating console](docs/images/js8-console.png)

### Winlink / ARDOP console

![FreeRig710 Winlink ARDOP operating console](docs/images/winlink-console.png)

## Documentation

- [Hardware](docs/HARDWARE.md) - reference wiring, ESP32-P4-NANO board, HDMI-to-CSI capture and FT-710 USB path.
- [Installation](docs/INSTALLATION.md) - ESP-IDF setup, build, flash, boot validation and local web serving.
- [Radio setup](docs/RADIO_SETUP.md) - FT-710 CAT/audio/display settings and transmit safety checks.
- [Main interface](docs/MAIN_INTERFACE.md) - radio display, VFOs, receiver controls, audio/PTT, memories, CW/SSTV and settings.
- [FT8](docs/FT8.md) - integrated browser FT8 operation, waterfall, QSO automation and shared logging.
- [JS8](docs/JS8.md) - native browser JS8 operation, heartbeat replies, directed messages and shared logging.
- [RTTY](docs/RTTY.md) - browser Baudot/ITA2 AFSK decode, staged digital audio transmit and manual logging.
- [Winlink / ARDOP](docs/WINLINK.md) - browser Winlink client, gateway CSV import, dial/center frequency handling and DL2MAN credits.
- [Logging](docs/QRZ_LOGBOOK.md) - QRZ API key storage, GridTracker UDP, QSO upload, ADI import and QRZ sync.
- [Apache deployment](docs/APACHE.md) - HTTPS reverse proxy and form-login protection.
- [Architecture](docs/ARCHITECTURE.md) - firmware/frontend components and API paths.
- [Printable case](hardware/case/README.md) - STL notes for the supplied ESP32-P4 enclosure.
- [Security](SECURITY.md) - security and RF safety reporting notes.
- [Third-party notices](THIRD_PARTY_NOTICES.md) - FT8, JS8, Winlink and data-license attribution.
- [Changelog](CHANGELOG.md) - release history.

## Repository Layout

```text
components/        ESP-IDF components for radio, audio, video, network and API
main/              ESP32-P4 application entry point
frontend/          static radio, FT8, JS8 and Winlink web interfaces
deploy/apache/     authenticated Apache reverse-proxy templates
docs/              operator and developer documentation
hardware/case/     printable enclosure files
tests/             regression and static contract tests
tools/             diagnostics, helpers and the Windows GUI server executable
```

## Local Web Server

For development on macOS/Linux:

```bash
python3 tools/serve_gui.py
```

For Windows, use:

```text
tools\serve_gui.exe
```

Both serve the static frontend locally; when loaded from `localhost`, the browser uses `http://ft710.local` as the ESP32 backend unless changed in the main Settings dialog.

## License

FreeRig710 source code is released under the [MIT License](LICENSE). Some browser digital-mode components and datasets have their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
