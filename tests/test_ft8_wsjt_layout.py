from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8.js').read_text()
page=(root/'frontend/ft8-page.js').read_text()
qso=(root/'frontend/ft8-qso-machine.js').read_text()
# WSJT-X-like composition: waterfall -> dual activity -> band/receiver controls -> collapsible settings -> QSO -> log.
order=[html.index('ft8-wsjtx-waterfall'),html.index('ft8-wsjtx-activity'),html.index('ft8-wsjtx-control-strip'),html.index('ft8-wsjtx-settings'),html.index('ft8-wsjtx-qso'),html.index('ft8-wsjtx-log')]
assert order==sorted(order)
assert html.count('data-qso-stage=')==5
for stage in ['INITIAL','REPORT','R_REPORT','RR73','73']:
    assert f'data-qso-stage="{stage}"' in html
assert 'selectTxStage(stage' in qso
assert 'recordTxActivity' in js and 'notifyTxStarted' in js and 'ft8-row-local-tx' in js
assert 'notifyTxStarted' in page
assert 'const activity=[...rxRows,...txRows]' in js
# Waterfall must use multiple hue regions, including yellow/red high-energy levels.
for token in ['level<0.18','level<0.38','level<0.58','level<0.76','level<0.90','r=255']:
    assert token in js
assert 'data-ft8-band="20m"' in html and 'syncBandButtons' in page
assert '<details class="ft8-filter-panel ft8-settings-panel">' in html
assert '<details class="ft8-filter-panel ft8-settings-panel ft8-colors-panel">' in html
ids=re.findall(r'\bid="([^"]+)"',html)
assert len(ids)==len(set(ids)), 'duplicate DOM ids'
print('FT8 WSJT-X layout/manual-sequence/TX-activity contract tests: OK')
