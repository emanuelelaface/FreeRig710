from pathlib import Path
root=Path(__file__).resolve().parents[1]
c=(root/'components/web_api/control_api.c').read_text()
js=(root/'frontend/ft8.js').read_text()
main_js=(root/'frontend/app.js').read_text()
lb=(root/'frontend/ft8-logbook.js').read_text()
rules=(root/'frontend/ft8-decode-rules.js').read_text()
html=(root/'frontend/ft8.html').read_text()
main_html=(root/'frontend/index.html').read_text()
assert '1.0' in html
assert 'qrz_response_adif_alloc(response)' in c
assert 'qrz_html_decode_inplace(out)' in c
assert 'QRZ reported %lu QSO but ADIF contained no parsable records' in c
assert 'qrz_response_value_alloc(response, "ADIF")' not in c
assert 'Parsed ${p.parsed}' in main_js and 'worked calls' in main_js and 'countries' in main_js
assert 'settings-adi-file' in main_html and 'settings-qrz-sync' in main_html
assert '/api/v1/log/gridtracker/adif' in main_js
assert 'if(dialog?.open)dialog.close()' in js
assert 'NEW DXCC' in js and 'NEW COUNTRY' in js and 'NEW CALL' in js
assert '{id:"new-country"' in rules
assert 'priority:100' in rules and 'priority:98' in rules and 'priority:95' in rules
assert 'lookupGeo?.("COUNTRY",country)' in rules
assert 'newCountry:Boolean(country && !worked && !countryWorked)' in rules
assert 'colorRulesSchema' in js
assert 'countries = Array.from(workedGeoCache.keys())' in lb
assert 'ctyApi?.lookup ? ctyApi.lookup(fields.CALL)' in lb
assert 'APP_FREERIG_COUNTRY_SOURCE' in lb
print('FT8.6.5.20 QRZ import/worked/color contract: OK')
