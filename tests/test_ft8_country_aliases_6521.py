from pathlib import Path
root=Path(__file__).resolve().parents[1]
log=(root/'frontend/ft8-logbook.js').read_text()
js=(root/'frontend/ft8.js').read_text()
html=(root/'frontend/ft8.html').read_text()
assert 'COUNTRY_KEY_SCHEMA = 1' in log
assert '"ENGLAND":"UNITED KINGDOM"' in log
assert '"SCOTLAND":"UNITED KINGDOM"' in log
assert '"WALES":"UNITED KINGDOM"' in log
assert '"NORTHERN IRELAND":"UNITED KINGDOM"' in log
assert '"THE NETHERLANDS":"NETHERLANDS"' in log
assert 'const canonicalCountry = countryKey(record.country)' in log
assert 'k === "COUNTRY" ? countryKey(value)' in log
assert 'countryKeySchema' in js and 'rebuildIndices()' in js
assert '1.0' in html
print('FT8.6.5.21 country alias/index migration contract: OK')
