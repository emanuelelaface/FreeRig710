# Changelog

## 1.0 — 2026-08-20

First public ESP32-P4 release, promoted from the validated FT8.6.5.22 engineering baseline.

Highlights:

- Waveshare ESP32-P4-NANO implementation replaces the old Raspberry Pi runtime.
- Direct FT-710 CAT-2 control and bidirectional UAC1 audio over USB Host.
- TC358743 DVI/HDMI-to-CSI capture with 800×480 MJPEG video.
- Integrated main radio web console.
- Integrated FT8 waterfall/decoder, QSO sequencing and staged RF TX.
- Any valid Band Activity message can start a QSO attempt, not only CQ rows.
- CQ Enable prepares CQ and arms TX.
- QRZ Logbook upload/import/sync and local worked database.
- Offline Maidenhead geography and worked/new DXCC/country/call highlighting.
- Country alias normalization for QRZ/GeoNames differences.
- Compact Band Activity columns: UTC, SNR, MESSAGE, CALL, LOCATION, WORKED.
- Apache same-origin HTTPS deployment with form/session authentication.
- Printable top/bottom STL enclosure files and complete public documentation.
