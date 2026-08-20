# Hardware

FreeRig710 1.0 is an ESP32-P4 implementation. It does not require a Raspberry Pi for CAT, audio, video capture or FT8.

## Reference hardware

- Yaesu FT-710.
- Waveshare ESP32-P4-NANO — <https://amzn.eu/d/071WkV44>
- TC358743-based HDMI-to-CSI-2 adapter — <https://amzn.eu/d/0g5nXgCs>
- DVI-D-to-HDMI adapter.
- HDMI cable.
- Compatible two-lane CSI ribbon/cable.
- USB-A to USB-B cable for the FT-710.
- Ethernet cable.
- 5 V USB-C supply for the ESP32-P4-NANO.

The Waveshare board used for development has 16 MB NOR flash, 32 MB PSRAM, onboard 100 Mbps Ethernet, USB host and MIPI-CSI.

## Connections

```text
FT-710 USB-B ───────────────────────────────► ESP32-P4-NANO USB-A host
              CAT-2 / Standard COM + UAC1 audio

FT-710 EXT-DISPLAY DVI-D
        │
        ▼
DVI-D → HDMI adapter → HDMI cable → TC358743 HDMI-to-CSI-2
                                      │
                                      ▼
                               MIPI-CSI (2 lanes)
                                      │
                                      ▼
                              ESP32-P4-NANO CSI

ESP32-P4-NANO RJ45 ─────────────────────────► LAN / Apache server / Internet
ESP32-P4-NANO USB-C ────────────────────────► 5 V power + programming UART
```

## Board wiring assumed by the firmware

The firmware's `components/board/include/freerig_board.h` uses the Waveshare ESP32-P4-NANO wiring:

- Ethernet MDC: GPIO 31
- Ethernet MDIO: GPIO 52
- Ethernet PHY reset: GPIO 51
- PHY address: 1
- CSI control I2C SDA: GPIO 7
- CSI control I2C SCL: GPIO 8
- TC358743 reference clock assumption: 27 MHz

The bridge is expected at I2C address `0x0F`. The firmware intentionally ignores the additional device observed at `0x18`.

## Video path

The FT-710 must output **800×480 progressive** video. FreeRig710 programs an EDID into the TC358743, waits for a stable source, starts two-lane CSI capture, and uses the ESP32-P4 hardware JPEG block for the MJPEG stream.

The capture supervisor releases and recreates CSI if the radio is switched off/on or the source disappears, instead of assuming the CSI peripheral can always recover in place.

## USB path

The firmware uses the Waveshare onboard Type-A host port. The FT-710 presents an internal USB topology containing:

- Silicon Labs CP2105 `10c4:ea70`; FreeRig710 claims interface 1, the FT-710 CAT-2 / Standard COM / AUX port.
- C-Media UAC1 audio `0d8c:0013`; FreeRig710 uses 48 kHz receive/transmit audio.

CAT-2 is configured by the firmware for 115200 baud, 8 data bits, no parity, 1 stop bit, no flow control, with DTR/RTS kept low.

FreeRig710 sets the ESP32-P4 DWC host `HCFG.FSLSSUPP` workaround before USB Host event processing so the FT-710 topology enumerates at Full-Speed on the reference hardware.

## Network and time

The firmware uses wired Ethernet with DHCP, hostname `ft710` and mDNS name `ft710.local`. Once it has DHCP, it starts SNTP using `pool.ntp.org`. A valid UTC clock is a transmit-safety prerequisite for automatic FT8 slot TX.
