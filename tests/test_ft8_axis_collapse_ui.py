from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
page=(root/'frontend/ft8-page.js').read_text()

# Every visible waterfall tick is placed by the same DF_LOW/DF_HIGH mapping used by click/cursor logic.
ticks=[int(v) for v in re.findall(r'<span data-df="(\d+)">', html)]
assert ticks == [200,600,1000,1400,1800,2200,2600,3000]
assert 'const DF_LOW = 200;' in page and 'const DF_HIGH = 3000;' in page
assert 'syncWaterfallAxis()' in page
assert '100 * (df - DF_LOW) / (DF_HIGH - DF_LOW)' in page
assert '(DF_LOW + fraction * (DF_HIGH - DF_LOW))' in page
assert '100 * (this.txDfHz - DF_LOW) / (DF_HIGH - DF_LOW)' in page
assert 'left:var(--ft8-axis-left,0%)' in css
assert '.ft8-axis-top{position:relative;height:14px;margin:0 0 2px;' in css

# Closed settings headers are side-by-side and have an explicit down-chevron affordance.
assert html.count('class="ft8-collapse-button" aria-hidden="true">▾</span>') == 2
assert '.ft8-wsjtx-settings{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)' in css
assert '.ft8-filter-panel[open] .ft8-collapse-button{transform:rotate(180deg)}' in css
assert '.ft8-filter-panel summary::-webkit-details-marker{display:none}' in css
print('FT8 waterfall axis/collapsible settings contract tests: OK')
