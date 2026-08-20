from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
core = (ROOT / "frontend" / "ft8.js").read_text()
page = (ROOT / "frontend" / "ft8-page.js").read_text()
machine = (ROOT / "frontend" / "ft8-qso-machine.js").read_text()

# UI and TX planner must read the state-machine report, not a stale controller copy.
assert 'const q = this.qsoMachine?.snapshot?.() || this.qso || {};' in core
assert 'const sequenceReport = /^[+-]\\d{2}$/.test(String(q.txReport || "")) ? q.txReport : this.txReport;' in core
assert 'this.txReport = String(snapshot.txReport);' in core
assert 'this.qsoMachine.identity({myCall:this.myCall,myGrid:this.myGrid});' in core

# Decoder parser tolerates Unicode minus glyphs seen in browser/UI text.
assert '.replace(/[−–—]/g, "-")' in core

# Never arm an old retry while the preceding RX decode is still pending.
assert 'isDecodePendingForSlot(slotIndex)' in core
assert 'this.decodeBusySlotIndex = slotIndex;' in core
assert 'window.FT710_FT8?.isDecodePendingForSlot?.(precedingRxSlot)' in page
assert 'waiting RX decode' in page

# Latest-plan-wins staging/arming. A stale async continuation cannot restage/arm JO65.
for needle in [
    'txPlanRevision: 0',
    'stagedWaveformRevision: 0',
    'armedPlanRevision: 0',
    'txPlanStillCurrent(message, revision',
    'throw this.stalePlanError(stageMessage, revision)',
    'this.stagedWaveformRevision = revision;',
    'this.stagedWaveformRevision !== revision',
    'this.armedPlanRevision = revision;',
    'stale plan after arm',
]:
    assert needle in page, needle

# Only messages from the selected DX addressed to My Call may advance the sequence.
assert 'directedKinds.has(kind)&&to!==this.myCall' in machine

print('FT8.6.5.10 QSO sequence contracts: OK')
