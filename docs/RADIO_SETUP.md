# Yaesu FT-710 setup

## External display

FreeRig710's video path expects the FT-710 external display to be enabled at **800×480**.

On the FT-710, enable the external monitor/output and select the 800×480 pixel mode before testing video capture.

Expected signal in FreeRig710 is 800×480 progressive at approximately 60 Hz.

## USB and CAT

Connect the FT-710 USB-B port to the Waveshare ESP32-P4-NANO Type-A USB host port.

Set the FT-710 **CAT-2 / Standard COM** rate to **115200 baud**. The firmware claims the CP2105 CAT-2/AUX interface and configures its USB-UART side as 115200 8N1 with flow control disabled.

FreeRig710 deliberately uses CAT-2 so the radio control path is distinct from the old Raspberry Pi/WSJT-X architecture. There is no external WSJT-X process in FreeRig710.

## FT8 operating configuration

Selecting a band on the FT8 page applies the radio state required by the integrated FT8 implementation:

- VFO A set to the selected FT8 dial frequency;
- VFO A mode `DATA-U`;
- VFO B mode `DATA-U`;
- RX on VFO A;
- split enabled A → B for TX;
- VFO B positioned to produce the selected audio TX DF;
- digital filters used by the normal UI disabled for the FT8 receive path;
- receive width set to 3.2 kHz.

The default dial-frequency table in `frontend/ft8.html` is:

| Band | Dial frequency |
|---|---:|
| 160 m | 1.840 MHz |
| 80 m | 3.573 MHz |
| 60 m | 5.357 MHz (regional) |
| 40 m | 7.074 MHz |
| 30 m | 10.136 MHz |
| 20 m | 14.074 MHz |
| 17 m | 18.100 MHz |
| 15 m | 21.074 MHz |
| 12 m | 24.915 MHz |
| 10 m | 28.074 MHz |
| 6 m | 50.313 MHz |
| 4 m | 70.154 MHz (regional) |

Always check your licence, band plan and local regulations before transmitting, especially on the entries marked regional.

## TX safety model

Before automatic FT8 TX the ESP32 checks radio power/state, VFO/mode/split configuration, expected frequencies and power, UAC1 TX, audio WebSocket, UTC clock synchronization and current RX/TX ownership.

During browser microphone or FT8 RF TX, FreeRig710 temporarily suspends UAC RX and halts CAT BULK IN on the validated ESP32-P4 USB-host path to avoid RF-audible UAC1 TX discontinuities. CAT TX remains available so `TX0` can release PTT, and watchdog/deadline logic remains authoritative.
