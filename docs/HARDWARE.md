# Hardware

## Required equipment

- **Yaesu FT-710** transceiver.
- **Raspberry Pi 4 Model B**, which is the platform used to develop and test
  this project.
- A reliable Raspberry Pi power supply and a microSD card or USB SSD.
- A network connection for the Raspberry Pi, preferably wired Ethernet.
- A commercially available **USB-A male to USB-B male cable**. This is the
  cable commonly sold as a “USB printer cable”. USB-B connects to the FT-710;
  USB-A connects to the Raspberry Pi.
- A **GeeekPi HDMI-to-CSI2 capture board** based on the Toshiba TC358743.
- The correct CSI ribbon cable for the Raspberry Pi 4 camera connector.
- A **DVI-to-HDMI adapter** connected to the FT-710 `EXT-DISPLAY` output.
- A standard **HDMI-to-HDMI cable** from that adapter to the GeeekPi board.
- An antenna system or dummy load appropriate for the intended operation.
- A 13.8 V DC power supply capable of supplying the FT-710 safely.

A separate Apache server is recommended for public HTTPS access. The tested
installation uses a second Debian machine, but Apache may run on another Linux
host or on the same Raspberry Pi if paths and firewall rules are adjusted.

## Physical signal paths

```text
FT-710 USB-B
  └── USB-A to USB-B cable
        └── Raspberry Pi 4 USB-A
             ├── CAT-1 / Enhanced COM → WSJT-X
             ├── CAT-2 / Standard COM → FreeRig710 API
             └── USB audio → PipeWire/PulseAudio

FT-710 EXT-DISPLAY (DVI-D)
  └── DVI-to-HDMI adapter
        └── HDMI-to-HDMI cable
              └── GeeekPi HDMI-to-CSI2
                    └── CSI ribbon cable
                          └── Raspberry Pi 4 CSI connector
```

The FT-710 external display is configured for **800 × 480**. The TC358743
installation used during development reports `800x480p60`, UYVY, through
`unicam` as `/dev/video0`.

## Cooling and reliability

Continuous video conversion, GStreamer encoding, VNC and WSJT-X can keep a
Raspberry Pi 4 busy. A ventilated case with a heatsink and fan is recommended.
Use a stable supply and avoid undervoltage, especially when several USB
devices are connected.
