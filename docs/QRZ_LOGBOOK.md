# Logging integrations

FreeRig710 has a shared **Log** configuration used by the main radio page, FT8, JS8 and RTTY.

Supported destinations:

- **QRZ Logbook**: the ESP32 uploads QSOs to `https://logbook.qrz.com/api` with the stored QRZ API key.
- **GridTracker**: the ESP32 behaves as a WSJT-X network-protocol client (schema 3) on the configured host and port. The default GridTracker/WSJT-X receive port is `2237`.

The browser builds or selects the QSO data, but the ESP32 performs the QRZ HTTPS request and owns the persistent GridTracker UDP socket. QRZ secrets are not returned to browser JavaScript.

## Configure Logging

Open the main radio page and press **Settings**.

1. Enter **Call** and optionally **Grid**.
2. In **Log**, enable **Log to QRZ** and/or **GridTracker WSJT-X integration**.
3. For QRZ, enter the **QRZ Logbook API key**.
4. For GridTracker, enter the IP address reachable from the ESP32 network and its **Receive UDP messages from WSJT-X** port. Use `2237` unless GridTracker is configured differently.

Firmware upgrades migrate the former raw-ADIF default port `2333` to `2237`. A previously saved non-default port is preserved.
5. Click **Save Settings**.

The FT8 page emits the same protocol events used by WSJT-X: Heartbeat every 15 seconds, Status on state changes, Decode for every decoded message, Clear, Close, QSO Logged and Logged ADIF. The ESP32 keeps one UDP socket open so GridTracker replies return to the correct source port. Reply, Replay, Clear and Halt Tx requests are accepted; Reply is acted on only when it exactly matches a retained CQ decode, following WSJT-X behavior.

If the browser is remote, use the GridTracker address reachable from the ESP32, not necessarily the browser computer's local address. Multicast targets are also accepted when the network routes them from the ESP32.

Leaving the QRZ key field blank while saving keeps the existing saved key. Disabling both log destinations is allowed; manual/automatic QSO logging will then stay disabled until at least one destination is configured.

## Manual QSO Logging

The main page, FT8, JS8 and RTTY expose a **Log QSO** form. Submitting it calls the ESP32 once; the firmware uploads ADIF to QRZ and emits WSJT-X **QSO Logged** plus **Logged ADIF** messages to GridTracker for the enabled destinations.

If both QRZ and GridTracker are enabled, the job succeeds only when both destinations accept the QSO. The status JSON includes per-destination details so the UI can report partial failures.

## ADI Import And QRZ Sync

The **Log** section in Settings contains:

- **Import ADI file**: imports local ADIF into the shared browser IndexedDB logbook/worked cache.
- **QRZ Sync**: fetches QRZ Logbook ADIF pages and replaces the shared local logbook with the authoritative QRZ result.

ADI import and QRZ Sync update only the local worked database. They are not replayed as live GridTracker traffic. GridTracker receives a QSO when it is logged through the normal manual/automatic **Log QSO** flow, matching WSJT-X rather than an ADIF-broadcast importer.

## FT8 Local Log

Completed FT8 contacts are first stored locally in the browser. The FT8 logbook maintains an IndexedDB database containing QSO records and worked indexes.

This worked cache is browser/profile specific. If you open FreeRig710 from a different computer, browser or private profile, run an ADI import or QRZ Sync there as well.

The completed-QSO dialog can automatically or manually submit the already-saved local QSO to the enabled log destinations. On success the dialog closes automatically. If logging fails, the local copy remains and the dialog stays available for retry.
