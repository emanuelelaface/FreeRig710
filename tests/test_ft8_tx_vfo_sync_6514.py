from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
js = (ROOT / 'frontend' / 'ft8-page.js').read_text()
assert 'txVfoApplyPromise: null' in js
assert 'txVfoApplyGeneration: 0' in js
assert 'const previous = this.txVfoApplyPromise || Promise.resolve(true);' in js
# 6.5.15 keeps the serialized setter from 6.5.14 but no longer gates Enable/arm
# on the 1 Hz cached VFO-B snapshot.
assert js.count('ensureFt8TxRadioState(') == 1
assert 'VFO/split state changed; FT8 TX refused' not in js
assert 'safeToRepair' in js
print('FT8 VFO setter serialization regression: OK')
