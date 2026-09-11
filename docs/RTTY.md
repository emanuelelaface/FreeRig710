# RTTY operating console

FreeRig710 includes a browser RTTY console for Baudot/ITA2 operation. The browser decodes the FT-710 USB receive audio locally and generates 48 kHz mark/space audio for transmit. The ESP32 stages that PCM in PSRAM and owns PTT during playback through the existing guarded staged digital TX path.

The default modem settings are DATA-L AFSK, 45.45 baud, 170 Hz shift, 2125 Hz audio mark and 2295 Hz audio space. DATA-U AFSK is also available: changing sideband swaps the audio mark and space frequencies (2295/2125 Hz for the default pair), keeping normal RTTY polarity on RF. RX and TX reverse controls apply an additional inversion for inverted signals, and an adaptive decoder squelch suppresses false characters when no clean RTTY signal is present.

Selecting a band configures the FT-710 for DATA-L simplex by default, keeps the data-audio filter path, claims the audio WebSocket, and starts browser-side monitoring. Band selection does not force a fixed dial frequency; use the manual Tune control or the band Preset button to move VFO A. Both DATA-L and DATA-U support receive and transmit. The mode menu only offers AFSK modes. The first load after this update uses DATA-L; subsequent explicit mode choices are saved locally.

The Mark and Shift controls tune the browser audio decoder and transmitter tones. Space is Mark plus Shift in DATA-L, or Mark minus Shift in DATA-U. The waterfall shows the full 200-3000 Hz data-audio span, matching the AFSK path used for transmit, with the Mark and Space cursors following the selected sideband. These controls do not move the FT-710 IF display or change the radio's internal RTTY tone menu. Use the waterfall click target, Auto Mark, or Auto RX to align the browser decoder with the received mark/space pair.

The RTTY page includes a **Log QSO** panel matching the main, FT8 and JS8 logging flow. It builds an ADIF RTTY QSO from the current radio context and submits it through the ESP32 to the enabled shared Log destinations.

RTTY transmit is a high-duty-cycle mode. Start with low RF power, keep ALC below the onset point, and verify the mark/space tones on a dummy load before operating on air. Native FT-710 RTTY-U/RTTY-L FSK transmit would need firmware support for the radio keying path, such as RTS/DTR or DAKY, instead of browser audio.
