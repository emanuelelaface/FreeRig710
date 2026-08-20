from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
js = (ROOT / 'frontend' / 'ft8-page.js').read_text()
c = (ROOT / 'components' / 'web_api' / 'control_api.c').read_text()
assert 'reflects the 1 s CAT poll cache' in js
assert 'if (this.txVfoApplyPromise) await this.txVfoApplyPromise;' in js
assert 'const state = await this.ensureFt8TxRadioState' not in js
assert 'static bool ft8_tx_refresh_prekey_vfo' in c
for q in ('"VS;"', '"ST;"', '"FA;"', '"FB;"'):
    assert q in c
assert 'ft710_cat_query' in c
assert 'for (int attempt = 0; attempt < 3; ++attempt)' in c
assert 'FT8 slot became too late during CAT pre-key verification' in c
print('FT8.6.5.15 fresh CAT pre-key regression: OK')
