from pathlib import Path
root = Path(__file__).resolve().parents[1]
css = (root / 'frontend/ft8-page.css').read_text()
html = (root / 'frontend/ft8.html').read_text()
assert '1.0' in html
assert '.ft8-qso-station-column{align-self:stretch;display:flex;flex-direction:column}' in css
assert '.ft8-cq-box{flex:1;grid-template-rows:auto minmax(26px,1fr) auto;align-items:start}' in css
assert '.ft8-cq-box .ft8-qso-reset{grid-column:1;grid-row:3;' in css
assert 'align-self:end' in css
assert 'margin-top:10px' in css
print('FT8 reset placement regression: PASS')
