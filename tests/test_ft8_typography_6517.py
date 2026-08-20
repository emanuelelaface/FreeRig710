from pathlib import Path
root=Path(__file__).resolve().parents[1]
css=(root/'frontend/ft8-page.css').read_text()
html=(root/'frontend/ft8.html').read_text()
assert '1.0.0' in html
assert '--ft8-control-height:31px' in css
assert '--ft8-font-control:.70rem' in css
assert '--ft8-font-emphasis:.72rem' in css
assert '.ft8-page-body button{' in css
assert '.ft8-page-body button.small{' in css
assert '.ft8-cq-box #ft8-call-cq,' in css
assert '.ft8-cq-box .ft8-qso-reset{' in css
assert 'font-size:var(--ft8-font-emphasis)' in css
assert '.ft8-wsjtx-log .ft8-qrz-sync-controls button,' in css
assert '.ft8-page-body .status-list{font-size:var(--ft8-font-control)' in css
print('FT8.6.5.17 typography/control normalization contract: OK')
