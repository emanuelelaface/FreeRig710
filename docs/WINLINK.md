# Winlink / ARDOP Console

![Winlink ARDOP console](images/winlink-console.png)

FreeRig710 includes a browser Winlink/ARDOP client integrated with the FT-710 CAT and audio path. The ARDOP/B2F client work is based on DL2MAN's browser ARDOP Winlink project and is adapted here to use FreeRig710's radio setup, audio WebSocket and PTT safety path.

## Station Settings

The Winlink page uses the shared station settings from the main Settings dialog:

- Call;
- Grid;
- ESP32 backend.

The Winlink account password remains local to the Winlink page and is used only to compute the Secure Login response for the `;PQ` challenge. It is not transmitted in clear text.

## Gateway List

Import the downloaded Winlink RMS channel CSV from the Winlink page. The UI stores the imported gateway list locally in the browser and filters/sorts it by mode, band and distance from the configured grid.

The CSV frequency is the ARDOP RF center frequency. In DATA-U/USB operation FreeRig710 shows and sets the FT-710 dial frequency as:

```text
TRX dial kHz = Winlink center kHz - 1.5 kHz
```

Example:

```text
Winlink center: 14110.4 kHz
FT-710 dial:    14108.9 kHz
```

That offset places the ARDOP audio center around 1500 Hz in the radio passband.

## Connecting

Selecting a gateway applies the FT-710 DATA-U setup and the correct dial frequency when CAT is connected. The page can then send ARDOP ConReq frames, wait for ConAck/DataACK, and continue into the Winlink B2F session.

The interface includes:

- gateway CSV import;
- busy-channel lock with manual override;
- QRP auto retry;
- outbox/inbox handling;
- Secure Login challenge/response;
- ARDOP diagnostics such as leader offset, SNR, mode decisions, ACK/NAK and frame decode status.

## Practical Notes

HF Winlink depends on propagation, gateway availability, frequency accuracy, audio level and clean PTT timing. A failed `ConReq` sequence does not necessarily mean the software is broken; a partial session with ConAck/DataACK is much more useful for modem debugging.

For gateway frequencies, compare FreeRig710's displayed **TRX/Dial** value against the CSV **Frequency** using the 1.5 kHz center offset above.

## Credits

The browser ARDOP/Winlink work is based on DL2MAN's ARDOP Winlink project:

- DL2MAN ARDOP project: <https://dl2man.de/ARDOP/>
- DL2MAN browser client: <https://dl2man.de/ARDOP/client/>

The Winlink 2000 network is operated by the Amateur Radio Safety Foundation, Inc. Use this client under your own callsign, licence and responsibility, and keep an independent fallback for emergency or field use.

See [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for attribution and licensing notes.
