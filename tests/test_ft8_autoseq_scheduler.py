from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
s = (ROOT / "frontend" / "ft8-page.js").read_text()

assert "const AUTO_TX_ARM_LEAD_MS = 700;" in s
assert "if (lead > AUTO_TX_ARM_LEAD_MS || lead < -AUTO_TX_MAX_LATE_MS) return;" in s
assert "const refreshedPlan = window.FT710_FT8?.getTxPlan?.() || {};" in s
assert "if (refreshedMessage !== message || !this.txPlanStillCurrent(message, revision)) return;" in s
assert "const planBeforeArm = window.FT710_FT8?.getTxPlan?.() || {};" in s
assert 'String(planBeforeArm.message || "").trim() !== String(message || "").trim() || !this.txPlanStillCurrent(message, revision)' in s
# The obsolete behavior that allowed /arm up to five seconds early must stay gone.
assert "if (lead > 5000 || lead < -AUTO_TX_MAX_LATE_MS) return;" not in s
print("FT8 Auto Seq stale-arm regression contract: OK")

assert 'async cancelStaleArmedTx(previousMessage, nextMessage)' in s
assert 'error.code = "FT8_STALE_PLAN"' in s
assert 'this.stagedWaveformMessage === stageMessage' in s
assert 'const stageWaveform = this.txStageWaveform;' in s
assert 'this.armedTxMessage = String(message || "").trim();' in s
assert 'ESP32 ACTIVE waveform/message/revision binding mismatch' in s
