from pathlib import Path
root=Path(__file__).resolve().parents[1]
c=(root/'components/web_api/control_api.c').read_text()
js=(root/'frontend/ft8.js').read_text()
html=(root/'frontend/ft8.html').read_text()
main_js=(root/'frontend/app.js').read_text()
main_html=(root/'frontend/index.html').read_text()
required_c=[
    'ACTION=FETCH','MAX:%u,AFTERLOGID:', 'MAX:%u', 'MODSINCE:%s',
    'xTaskCreate(qrz_fetch_task', '/api/v1/qrz/fetch', '/api/v1/qrz/fetch/status',
    '/api/v1/qrz/fetch/page', '/api/v1/qrz/fetch/cancel', 'QRZ_FETCH_MAX_RECORDS 250U',
    'text/plain; charset=utf-8', 'APP_QRZLOG_LOGID:'
]
for token in required_c:
    assert token in c, token
assert 'KEY=%s&ACTION=FETCH&OPTION=%s' in c
assert 'cJSON_AddStringToObject(o, "api_key"' not in c

assert 'qrz_response_value_alloc(response, "RESULT")' in c
assert 'QRZ RESULT=AUTH: FETCH not authorized' in c
assert 'QRZ RESULT=%s: %s' in c
assert 'QRZ rejected FETCH request' not in c
assert 'TYPE:ADIF,STATUS:ALL' not in c
assert 'OPTION=%s' in c
assert 'COUNT=%s' in c
for token in ['/api/v1/qrz/fetch','/api/v1/qrz/fetch/status','/api/v1/qrz/fetch/page','max:250']:
    assert token in js, token
for token in ['/api/v1/qrz/fetch','/api/v1/qrz/fetch/status','/api/v1/qrz/fetch/page','max: 250']:
    assert token in main_js, token
for token in ['settings-adi-file','settings-qrz-sync','settings-adi-progress','settings-logbook-status']:
    assert token in main_html, token
for token in ['ft8-qrz-import','ft8-qrz-sync','ft8-qrz-cancel','ft8-adi-file']:
    assert token not in html, token
print('QRZ FETCH static contract tests: OK')
