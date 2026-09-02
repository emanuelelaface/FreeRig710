# JS8 Operating Console

![JS8 console](images/js8-console.png)

FreeRig710 includes a native browser JS8 console for keyboard-to-keyboard weak-signal operation. It is not a remote JS8Call desktop: the browser runs the JS8 codec and UI, while FreeRig710 keeps CAT, split VFO control, PTT, RF-gain handling and 48 kHz audio transport on the existing FT-710 API and audio WebSocket path.

## Radio Setup

No JS8 band is selected when the page opens. Select a band explicitly; the page then configures the FT-710 for DATA-U operation and split TX/RX handling.

The page uses the shared station settings from the main Settings dialog:

- Call;
- Grid;
- ESP32 backend;
- QRZ Logbook destination;
- GridTracker UDP destination.

Call and grid are shown in JS8 as read-only values so all digital pages use the same station identity.

## Operating Controls

- **Band buttons** set the JS8 dial frequency and radio state.
- **Submode** selects Slow, Normal, Fast, JS8 40 or JS8 60.
- **Waterfall** shows the JS8 passband; click it to choose the TX audio frequency.
- **Monitor** starts and stops browser-side decode.
- **Auto RF Gain** follows the same automatic/manual model used by the FT8 page.
- **Heard** lists decoded calls, SNR, offset, grid and last activity.
- **QSO** shows RX/TX traffic in a scrollable view and keeps direct-message context.
- **CQ**, **Heartbeat** and directed-message controls transmit through the FreeRig710 staged audio path.

## Heartbeat Replies

A received heartbeat request has the form:

```text
CALLSIGN: @HB HEARTBEAT GRID
```

Only that request type should offer the quick heartbeat-reply action. Reports such as:

```text
CALLSIGN: OTHERCALL HEARTBEAT SNR +03
```

are already replies and should not be treated as new heartbeat requests.

## QSO And Logging

JS8 messages can span multiple frames. That is normal: longer free-text messages are split into the number of JS8 frames required by the selected submode and payload size.

The JS8 **Log QSO** form submits the prepared QSO to the enabled shared Log destinations. QRZ Logbook submission uses ADIF mode `MFSK` with `SUBMODE=JS8`, because QRZ maps JS8 as an MFSK submode. GridTracker receives the same ADIF record by UDP when enabled.

## Upstream Codec

The JS8 codec assets are vendored from `wfweb`, based on JS8Call-improved:

- wfweb: <https://github.com/adecarolis/wfweb>
- JS8Call-improved: <https://github.com/JS8Call-improved/JS8Call-improved>

See [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for GPL-3.0 attribution and redistribution notes for the vendored JS8 codec assets.
