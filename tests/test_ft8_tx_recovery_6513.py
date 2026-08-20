from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "frontend" / "ft8-page.js").read_text()

# Fresh Enable TX must clear any abort latch left by closeAudio()/old aborts.
assert "A fresh operator Enable TX is a new session" in page
assert "this.txAbortRequested = false;" in page

# Scheduler self-heals stale local ARMED state instead of requiring Halt -> Enable.
assert "async recoverStaleAutoTxLatch()" in page
assert "AUTO_TX_ARM_STALE_RECOVERY_MS = 3200" in page
assert 'this.renderAutoTxState("recovered stale arm latch")' in page
assert "if (this.txAbortRequested && !this.autoTxArming) this.txAbortRequested = false;" in page

# Backend IDLE/ACTIVE events explicitly release the local arming latch.
active = page.index('if (state === "ACTIVE")')
idle = page.index('} else if (state === "IDLE")')
assert 'this.autoTxArming = false;' in page[active:idle]
assert 'this.autoTxArming = false;' in page[idle:idle+450]
print("FT8 TX enable/recovery regression: OK")
