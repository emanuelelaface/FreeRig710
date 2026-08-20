from pathlib import Path
root=Path(__file__).resolve().parents[1]
html=(root/'frontend/ft8.html').read_text()
css=(root/'frontend/ft8-page.css').read_text()
js=(root/'frontend/ft8.js').read_text()
page=(root/'frontend/ft8-page.js').read_text()

# Band Activity click calls any parseable decoded station and attempts Auto TX.
assert 'if(accepted&&!rxFrequency) window.FT710_FT8_PAGE?.enableAutoTxFromSelection?.();' in js
assert 'row.parsed?.kind==="CQ"' not in js[js.index('const renderBody ='):js.index('renderBody(id("ft8-decodes-body")')]
assert 'return true;' in js[js.index('    selectDecode(row) {'):js.index('    updateTxReportFromRow(row) {')]
assert 'return false;' in js[js.index('    selectDecode(row) {'):js.index('    updateTxReportFromRow(row) {')]

# Enable CQ must create the CQ plan, sync DF/parity, and attempt to arm Auto TX.
cq_handler=js[js.index('id("ft8-call-cq")'):js.index('document.querySelectorAll("[data-qso-stage]")')]
assert 'startCallingCq' in cq_handler
assert 'page?.qsoSelected?.' in cq_handler
assert 'snap.state==="CALLING_CQ"' in cq_handler
assert 'getTxSlotParity?.()' in cq_handler
assert 'page?.enableAutoTxFromSelection?.();' in cq_handler
assert 'getTxDf()' in page and 'getTxSlotParity()' in page
assert 'void this.enableAutoTx();' in page[page.index('enableAutoTxFromSelection()'):page.index('txPlanStillCurrent')]

# The small CQ label is gone; button and preview bar have the same explicit height.
cq=html[html.index('<div class="ft8-cq-box"'):html.index('</div>',html.index('<div class="ft8-cq-box"'))]
assert '<span>CQ</span>' not in cq
assert 'id="ft8-call-cq"' in cq and 'id="ft8-cq-preview"' in cq
assert '.ft8-cq-box button,.ft8-cq-box strong{height:31px;min-height:31px;box-sizing:border-box}' in css
assert '.ft8-cq-box{display:grid;grid-template-columns:auto 1fr;' in css
print('FT8.6.5.16 any-decode click / CQ arm contract: OK')
