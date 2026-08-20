from pathlib import Path
root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8.js').read_text()
assert '>Filters ON</button>' in html
assert '"Filters OFF":"Filters ON"' in js
assert 'BP ON' not in html+js and 'BP OFF' not in html+js
assert 'id="ft8-reset-qso"' in html
cq=html[html.index('<div class="ft8-cq-box"'):html.index('</div>', html.index('<div class="ft8-cq-box"'))]
assert 'id="ft8-call-cq"' in cq and 'id="ft8-reset-qso"' in cq
assert '.ft8-cq-box .ft8-qso-reset{grid-column:1;grid-row:3;' in css
assert '.ft8-wsjtx-settings .ft8-settings-panel:not([open]){height:38px;min-height:38px;max-height:38px;' in css
assert '.ft8-wsjtx-settings .ft8-settings-panel:not([open])>summary{height:30px;min-height:30px;max-height:30px;' in css
print('FT8 6.5.6+ UI polish contract tests: OK')
