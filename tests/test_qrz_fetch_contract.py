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
assert 'MAX:%u,AFTERLOGID:%" PRIu64' in c
assert 'has_more = page_count > 0U && next_after > job->after_logid' in c
assert 'RESULT=FAIL&COUNT=0' in c
assert 'QRZ FETCH reached end of log' in c
assert 'unsignedDecimalGreaterThan' in main_js
assert 'unsignedDecimalGreaterThan' in js
assert 'if (!job?.has_more || Number(job?.count || 0) === 0) break' not in main_js
assert 'if(!job?.has_more || Number(job?.count||0)===0)break' not in js
assert 'if (pageCount === 0 || pageParsed === 0) break' in main_js
assert 'if(pageCount===0 || pageParsed===0)break' in js
for token in ['settings-adi-file','settings-qrz-sync','settings-adi-progress','settings-logbook-status']:
    assert token in main_html, token
for token in ['ft8-qrz-import','ft8-qrz-sync','ft8-qrz-cancel','ft8-adi-file']:
    assert token not in html, token
print('QRZ FETCH static contract tests: OK')
