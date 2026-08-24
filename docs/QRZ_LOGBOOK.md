# QRZ Logbook integration

FreeRig710 uses the QRZ Logbook API for two purposes:

1. upload completed QSOs;
2. import/synchronize worked QSOs so the FT8 interface can identify worked calls, countries and DXCC entities.

## Obtain the API key

QRZ's Logbook API page is:

<https://www.qrz.com/docs/logbook30/api>

Select the API key belonging to the logbook/callsign you want FreeRig710 to use. QRZ states that the key grants full read/write access to that logbook; treat it as a password. QRZ also documents Logbook API access as a subscriber feature.

## Store the key in FreeRig710

Open the main radio page and press the Settings button in the header.

1. Enter **Call**.
2. Enter the **QRZ Logbook API key**.
3. Click **Save Settings**.

The ESP32 stores:

- callsign as NVS key `qrz_call`;
- API key as NVS key `qrz_key`.

The browser can query whether a key is configured, but the API does not return the secret itself.

Leaving the key field blank while saving keeps the existing saved key. The firmware validates the callsign before committing configuration.

## Manual log from the main page

The main QRZ panel builds a QSO from the current radio context and submits it through the ESP32 to `https://logbook.qrz.com/api`. FT8 and JS8 can also submit completed or prepared contacts through the same ESP32 QRZ path.

The ESP32 performs the QRZ HTTPS request, so the API key never needs to be exposed to browser JavaScript.

## FT8 local log

Completed FT8 contacts are first stored locally in the browser. The FT8 logbook maintains an IndexedDB database containing QSO records and worked indexes.

This means the worked cache is **browser/profile specific**. If you open FreeRig710 from a different computer, browser or private profile, run an import/sync there as well.

## QRZ Import

Use **QRZ Import** for the first population/rebuild of the local worked database. The import walks QRZ pages, parses ADIF and merges contacts into local IndexedDB.

The status reports fetched/parsed/new/duplicate counts plus worked calls, DXCC and countries. If QRZ reports records but ADIF parsing returns zero, the operation fails visibly rather than reporting a misleading successful zero-record import.

## QRZ Sync

Use **QRZ Sync** after the full import. It resumes from stored synchronization state and merges newer records without rebuilding everything from scratch.

## Worked / country / DXCC behavior

FreeRig710 tracks several concepts separately:

- **worked call** — exact station callsign already present in the log;
- **worked country** — normalized geographic country family used for visual country highlighting;
- **worked DXCC** — DXCC entity when the ADIF data provides it.

Country aliases are canonicalized, so examples such as `Netherlands`/`The Netherlands` compare as one country. England, Scotland, Wales and Northern Ireland compare as **United Kingdom** for the broad country highlight, but remain separate DXCC entities where DXCC data is available.

If an imported QSO has a Maidenhead locator but incomplete country/region fields, FreeRig710 can enrich the local worked index using its offline grid geography table.

## Automatic FT8 logging

The completed-QSO dialog can upload the already-saved local QSO to QRZ. On a successful QRZ result the dialog closes automatically. If QRZ fails, it remains open so the operation can be retried without losing the local contact.
