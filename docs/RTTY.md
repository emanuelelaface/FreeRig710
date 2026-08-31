# RTTY operating console

FreeRig710 includes a browser RTTY console for Baudot/ITA2 operation. The browser decodes the FT-710 USB receive audio locally and generates 48 kHz mark/space audio for transmit. The ESP32 stages that PCM in PSRAM and owns PTT during playback through the existing guarded staged digital TX path.

The default modem settings are 45.45 baud, 170 Hz shift, 2125 Hz audio mark and 2295 Hz audio space. RX and TX reverse controls are available for inverted signals, and an adaptive decoder squelch suppresses false characters when no clean RTTY signal is present.

Selecting a band configures the FT-710 for RTTY-U simplex by default, disables narrow DSP shaping that can hurt decode, claims the audio WebSocket, and starts browser-side monitoring. Band selection does not force a fixed dial frequency; use the manual Tune control or the band Preset button to move VFO A. The page also exposes RTTY-L and DATA-U as selectable radio modes for stations that need the alternate sideband or the generic data-audio path.

The Mark and Shift controls tune the browser audio decoder and transmitter tones. They do not move the FT-710 IF display or change the radio's internal RTTY tone menu. Use the waterfall click target, Auto Mark, or Auto RX to align the browser decoder with the received mark/space pair.

RTTY transmit is a high-duty-cycle mode. Start with low RF power, keep ALC below the onset point, and verify the mark/space tones on a dummy load before operating on air.
