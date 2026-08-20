from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "frontend" / "ft8.html").read_text()
js = (ROOT / "frontend" / "ft8.js").read_text()
css = (ROOT / "frontend" / "ft8-page.css").read_text()

assert html.count("<th>DT</th>") == 0
assert html.count("<th>DF</th>") == 0
assert html.count("<th>MESSAGE</th>") == 2
assert 'colspan="6"' in html
assert 'td.colSpan = 6' in js
assert 'DT ${Number(row.dt).toFixed(2)} s · DF ${Math.round(Number(row.df))} Hz' in js
assert 'width:20ch;min-width:20ch;max-width:20ch' in css
assert '1.0.0' in html
print("FT8.6.5.22 compact activity columns checks passed")
