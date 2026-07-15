# FT-710 radio configuration

These settings are required before starting FreeRig710. Menu names follow the
English FT-710 Operation Manual.

## 1. Enable the external display

Press the **FUNC** knob, then select:

```text
DISPLAY SETTING
└── EXT MONITOR
    ├── EXT DISPLAY: ON
    └── PIXEL: 800x480
```

The FT-710 `EXT-DISPLAY` connector is DVI-D. Connect it through the DVI-to-HDMI
adapter and HDMI cable to the GeeekPi board.

## 2. Configure both USB CAT ports

Press the **FUNC** knob, then select:

```text
OPERATION SETTING
└── GENERAL
    ├── CAT-1 RATE: 115200 bps
    ├── CAT-1 CAT-3 STOP BIT: 2bit
    └── CAT-2 RATE: 115200 bps
```

Port ownership is strict:

```text
CAT-1 / Enhanced COM / /dev/ttyFT710_CAT → WSJT-X
CAT-2 / Standard COM / /dev/ttyFT710_AUX → FreeRig710 FastAPI
```

There is no `rigctld` layer in this installation. WSJT-X opens CAT-1 directly;
the API opens CAT-2 directly. Do not point both applications at the same
serial device.

CAT-2 uses 8 data bits, no parity and one stop bit. The API disables RTS, DTR
and flow control. CAT-1 is configured in WSJT-X with 8 data bits, two stop
bits and no handshake.

## 3. Check the FT8 preset

The FT-710 FT8 `PRESET` can store `CAT-1 RATE` and `CAT-1 CAT-3 STOP BIT`.
Ensure the preset used for WSJT-X also contains:

```text
CAT-1 RATE: 115200 bps
CAT-1 CAT-3 STOP BIT: 2bit
```

Otherwise enabling the preset may silently change the serial settings and
break WSJT-X CAT control.

## 4. USB audio and transmit source

For browser microphone transmission or WSJT-X data transmission, select the
appropriate USB modulation source on the radio for the active mode. During
initial testing, disable VOX and use CAT PTT. Test with a dummy load or low RF
power.

## Manual references

Relevant sections in the FT-710 Operation Manual include:

- display connection and rear-panel `EXT-DISPLAY` description;
- `OPERATION SETTING → GENERAL` CAT settings;
- `DISPLAY SETTING → EXT MONITOR`;
- FT8 preset configuration;
- USB A-to-B computer connection.

The Yaesu manual is not redistributed in this repository.
