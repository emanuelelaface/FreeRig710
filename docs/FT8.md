# FT8 operating console

![FT8 console](images/ft8-console.png)

FreeRig710 1.0 includes its own browser FT8 console. It is not a noVNC view of WSJT-X.

## Processing split

### Browser

The browser receives 48 kHz FT-710 USB audio from the ESP32, builds 15-second FT8 slots, performs decode work in a Web Worker, maintains Band Activity, the QSO state machine, offline geography, worked/logbook indexes and the operator UI.

### ESP32-P4

The ESP32 validates radio state, synchronizes UTC, owns PTT/deadlines, receives the complete staged 48 kHz TX waveform and feeds the FT-710 UAC1 output. It can refuse TX when the expected A/B DATA-U split/frequencies/power/audio/clock conditions are not satisfied.

## Waterfall

The operating waterfall covers approximately 200–3000 Hz. Clicking it moves the TX audio cursor/DF. The display shows current TX DF and the resulting VFO-B RF placement.

## Band Activity

Columns are deliberately compact:

```text
UTC | SNR | MESSAGE | CALL | LOCATION | WORKED
```

`DT` and `DF` remain in the decoded row data for filtering/QSO/frequency logic but are hidden from the fixed columns; they are available from row context/tooltip.

A single click on **any valid decoded message**, not only `CQ`, selects the transmitter callsign and starts a QSO attempt. FreeRig710 prepares `DXCALL MYCALL GRID`, arms TX when allowed, and continues with the normal report/R-report/RR73/73 sequence when the selected DX replies.

A different callsign cannot steal an already-active QSO.

## Location

When a decode contains a Maidenhead locator, the offline geography index can show:

- continent;
- country;
- region/admin area;
- representative nearby city.

The city is an estimate derived from the Maidenhead area, not the station's exact position, and is shown with `~` where appropriate. Geography learned from a locator is cached per callsign for later report/RR73/73 messages that do not repeat the grid.

## Worked status and colors

The local logbook can mark rows as worked, new call, new country, new DXCC or related band-specific states. Color rules are priority-based and can be edited from the **Colors** section.

Default logic gives new DXCC/new country a higher priority than ordinary CQ, so a CQ from a genuinely new entity/country is visually distinct from a normal green CQ.

Country names from QRZ/ADIF/offline geography are normalized before comparison. Broad country normalization is independent from DXCC: for example England and Scotland belong to the UK country family for `NEW COUNTRY`, while they can still be separate DXCC entities.

## Band selection

Choosing a band configures the FT-710 for integrated FT8 operation and sets the standard dial frequency stored in `ft8.html`. 60 m and 4 m are explicitly marked regional.

## Receiver controls

- **Monitor** starts/stops FT8 receive processing.
- **Auto RF Gain** adjusts FT-710 RF gain toward the **RX Target**; the visible gain readout has fixed-width typography so it does not jump while learning/updating.
- Disabling Auto RF Gain enables the manual RX RF Gain slider.
- **RX Filters** filters the decode list without changing the decoder core.

## Calling CQ

**Enable CQ** prepares the CQ sequence **and arms TX**; it is not only a message-preparation button. The CQ preview shows the message that will be sent.

## Calling a decoded station

Click the desired Band Activity row. FreeRig710 extracts the transmitting CALL, selects the row/frequency, prepares the initial directed message and attempts to arm TX. If the station answers your call, Auto Seq progresses through the QSO.

## QSO controls

- **Enable TX** — arms the selected prepared message for the appropriate slot.
- **Halt TX** — cancels armed/active automatic TX.
- **Tune ALC / Stop Tune** — bounded calibration helper.
- **Auto Seq** — automatically advances message stages from received replies.
- **Call 1st** — CQ response behavior.
- **Hold TX frequency** — keeps selected TX DF while receiving replies elsewhere.
- **Retry max / Timeout slots** — bounds automatic retry behavior.
- **Reset** — resets the current QSO state.

## Log QSO

The FT8 logbook is local-first:

1. a completed contact is stored in IndexedDB;
2. the completion dialog can upload it to QRZ;
3. on QRZ success the dialog closes automatically;
4. on QRZ failure the local copy remains and the dialog stays available for retry.

Use **QRZ Import** for a full worked-history population and **QRZ Sync** for later incremental updates. ADIF files can also be dropped/imported locally.

## External FT8 runtime dependencies

The current worker loads pinned FT8 codec modules from jsDelivr at runtime:

- RX: `ft8js` 0.0.2 / `ft8_lib`;
- TX: `@e04/ft8ts` 0.0.14.

Therefore the geography/worked database is offline, but the current decoder/encoder module loading is not fully air-gapped. See `THIRD_PARTY_NOTICES.md`.
