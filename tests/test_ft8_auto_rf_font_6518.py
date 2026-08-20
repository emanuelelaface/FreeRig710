from pathlib import Path
root=Path(__file__).resolve().parents[1]
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8-page.js').read_text()
html=(root/'frontend/ft8.html').read_text()
assert '1.0.0' in html
assert '#ft8-rf-gain{' in css
assert 'flex:0 0 9ch' in css
assert 'font-variant-numeric:tabular-nums' in css
assert 'font:800 var(--ft8-font-control)/1 ui-monospace' in css
assert 'gainReadout.textContent = `${actualRfGain} / 255`' in js
assert 'Auto RF Gain model: learning' in js
assert '${actualRfGain} / 255${model}' not in js
assert 'id("ft8-rf-gain").textContent = `${current} / 255 ·' not in js
assert 'id("ft8-rf-gain").textContent = `${current} → ${next}' not in js
print('FT8.6.5.18 Auto RF Gain stable typography contract: OK')
