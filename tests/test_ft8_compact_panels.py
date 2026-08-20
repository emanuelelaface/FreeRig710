from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8.js').read_text()
assert '<strong>RX Filters</strong>' in html
assert '<strong>Colors</strong>' in html
assert 'ft8-settings-panel" open' not in html
assert html.count('class="ft8-filter-panel ft8-settings-panel') == 2
assert '.ft8-filter-grid input[type=checkbox]{width:20px;height:20px' in css
assert '.ft8-filter-grid input,.ft8-filter-grid select{min-height:30px' in css
assert 'grid-template-columns:repeat(6,minmax(0,1fr))' in css
assert 'event.preventDefault();event.stopPropagation();this.decodeFilters.bypass' in js
ids=re.findall(r'\bid="([^"]+)"',html)
assert len(ids)==len(set(ids)), 'duplicate DOM ids'
print('FT8 compact/collapsible panels contract tests: OK')
