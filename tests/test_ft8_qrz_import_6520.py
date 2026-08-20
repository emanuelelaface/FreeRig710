from pathlib import Path
root=Path(__file__).resolve().parents[1]
c=(root/'components/web_api/control_api.c').read_text()
js=(root/'frontend/ft8.js').read_text()
lb=(root/'frontend/ft8-logbook.js').read_text()
rules=(root/'frontend/ft8-decode-rules.js').read_text()
html=(root/'frontend/ft8.html').read_text()
assert '1.0.0' in html
assert 'qrz_response_adif_alloc(response)' in c
assert 'qrz_html_decode_inplace(out)' in c
assert 'QRZ reported %lu QSO but ADIF contained no parsable records' in c
assert 'qrz_response_value_alloc(response, "ADIF")' not in c
assert 'QSO parsed' in js and 'worked calls' in js and 'countries' in js
assert 'if(dialog?.open)dialog.close()' in js
assert 'NEW DXCC' in js and 'NEW COUNTRY' in js and 'NEW CALL' in js
assert '{id:"new-country"' in rules
assert 'priority:100' in rules and 'priority:98' in rules and 'priority:95' in rules
assert 'lookupGeo?.("COUNTRY",country)' in rules
assert 'newCountry:Boolean(country && !countryWorked)' in rules
assert 'colorRulesSchema' in js
assert 'countries = Array.from(workedGeoCache.keys())' in lb
assert 'geoApi.resolve(fields.CALL || "", fields.GRIDSQUARE)' in lb
print('FT8.6.5.20 QRZ import/worked/color contract: OK')
