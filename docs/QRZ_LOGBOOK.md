# Logging integrations

FreeRig710 has a shared **Log** configuration used by the main radio page, FT8, JS8 and RTTY.

Supported destinations:

- **QRZ Logbook**: the ESP32 uploads QSOs to `https://logbook.qrz.com/api` with the stored QRZ API key.
- **GridTracker**: the ESP32 sends ADIF records by UDP to the configured GridTracker host and port. The FreeRig710 default UDP port is `2333`.

The browser builds or selects the QSO data, but the ESP32 performs the QRZ HTTPS request and the GridTracker UDP send. QRZ secrets are not returned to browser JavaScript.

## Configure Logging

Open the main radio page and press **Settings**.

1. Enter **Call** and optionally **Grid**.
2. In **Log**, enable **Log to QRZ** and/or **Log to GridTracker**.
3. For QRZ, enter the **QRZ Logbook API key**.
4. For GridTracker, enter the IP address reachable from the ESP32 network and the UDP port. Use `2333` unless you configured a different ADIF UDP port in GridTracker.
5. Click **Save Settings**.

GridTracker must be configured to receive ADIF UDP broadcasts. If the browser is remote, use the IP route as seen by the ESP32, not necessarily the browser computer's local address.

Leaving the QRZ key field blank while saving keeps the existing saved key. Disabling both log destinations is allowed; manual/automatic QSO logging will then stay disabled until at least one destination is configured.

## Manual QSO Logging

The main page, FT8, JS8 and RTTY expose a **Log QSO** form. Submitting it calls the ESP32 once; the firmware then sends the generated ADIF record to every enabled destination.

If both QRZ and GridTracker are enabled, the job succeeds only when both destinations accept the QSO. The status JSON includes per-destination details so the UI can report partial failures.

## ADI Import And QRZ Sync

The **Log** section in Settings contains:

- **Import ADI file**: imports local ADIF into the shared browser IndexedDB logbook/worked cache.
- **QRZ Sync**: fetches QRZ Logbook ADIF pages and replaces the shared local logbook with the authoritative QRZ result.

When GridTracker logging is enabled, imported or QRZ-synced ADIF records are also forwarded through the ESP32 to GridTracker by UDP. ADI import does not bulk-upload the whole file back to QRZ; QRZ receives QSO uploads through the normal manual/automatic **Log QSO** flow.

## FT8 Local Log

Completed FT8 contacts are first stored locally in the browser. The FT8 logbook maintains an IndexedDB database containing QSO records and worked indexes.

This worked cache is browser/profile specific. If you open FreeRig710 from a different computer, browser or private profile, run an ADI import or QRZ Sync there as well.

The completed-QSO dialog can automatically or manually submit the already-saved local QSO to the enabled log destinations. On success the dialog closes automatically. If logging fails, the local copy remains and the dialog stays available for retry.
