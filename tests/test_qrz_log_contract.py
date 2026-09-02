from pathlib import Path
root=Path(__file__).resolve().parents[1]
c=(root/'components/web_api/control_api.c').read_text()
js=(root/'frontend/ft8.js').read_text()
lb=(root/'frontend/ft8-logbook.js').read_text()
html=(root/'frontend/ft8.html').read_text()
main_html=(root/'frontend/index.html').read_text()
for field in ['CALL','STATION_CALLSIGN','QSO_DATE','TIME_ON','TIME_OFF','BAND','FREQ','FREQ_RX','MODE','RST_SENT','RST_RCVD','GRIDSQUARE','MY_GRIDSQUARE','TX_PWR','COMMENT','MY_RIG']:
    assert f'"{field}"' in c, field
assert 'KEY=%s&ACTION=INSERT&ADIF=%s' in c
assert 'gridtracker_send_adif' in c
assert 'sendto(sock, adif' in c
assert '/api/v1/log/config' in c
assert '/api/v1/log/qso' in c
assert '/api/v1/log/qso/status' in c
assert '/api/v1/log/gridtracker/adif' in c
assert '"destinations"' in c
assert 'FREERIG_GRIDTRACKER_DEFAULT_PORT' in c
# Automatic duplicate replacement is forbidden: no outgoing INSERT request uses OPTION=REPLACE.
insert_window=c[c.index('static void qrz_log_task'):c.index('static esp_err_t qrz_log_handler')]
assert 'OPTION=REPLACE' not in insert_window
assert 'replaceLocalQso' in lb
assert 'onRecords' in lb
assert 'APP_FREERIG_STATUS:"LOCAL_SAVED"' in js
start=js.index('async handleCompletedQso')
end=js.index('\n    openLogDialog(record)', start)
handle=js[start:end]
assert handle.index('saveLocalQso') < handle.index('this.openLogDialog(record)')
assert 'submitCurrentQsoToQrz' in js
assert '/api/v1/log/qso' in js
assert '/api/v1/log/qso/status' in js
assert 'LOCAL_SAVED' in js and 'QRZ_PENDING' in js and 'QRZ_LOGGED' in js
for token in ['ft8-log-dialog','ft8-log-qso','ft8-auto-log-qrz']:
    assert token in html, token
for token in ['settings-log-qrz-enable','settings-log-gridtracker-enable','settings-gridtracker-host','settings-gridtracker-port','settings-adi-file','settings-qrz-sync']:
    assert token in main_html, token
for token in ['/api/v1/log/gridtracker/adif','createGridTrackerAdifQueue','broadcastGridTrackerChunks']:
    assert token in (root/'frontend/app.js').read_text(), token
print('Shared QSO logging static contract tests: OK')
