from pathlib import Path

root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8.js').read_text()
geo=(root/'frontend/ft8-geo.js').read_text()
rules=(root/'frontend/ft8-decode-rules.js').read_text()

assert '1.0.0' in html
assert html.count('<th>LOCATION</th>') == 2
assert 'ft8-geo.js?v=1.0.0' in html
assert html.index('ft8-geo.js') < html.index('ft8-decode-rules.js')
assert 'ft8-geo-cell' in css and 'ft8-geo-secondary' in css
assert 'location approximate from Maidenhead grid' in js
assert 'nearest populated place ~' in js
assert 'FreeRig710FT8Geo' in geo
assert 'fetch(' not in geo and 'XMLHttpRequest' not in geo and 'WebSocket' not in geo
assert geo.count('GeoNames offline') >= 1
assert 'geoApi.resolve(call,grid)' in rules
assert 'geoApproximate' in rules and 'geoNearbyDistanceKm' in rules
assert (root/'frontend/ft8-geo.js').stat().st_size < 400_000
print('FT8.6.5.19 offline geography UI/runtime contract: OK')
