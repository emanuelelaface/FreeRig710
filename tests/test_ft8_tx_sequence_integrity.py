from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "frontend" / "ft8-page.js").read_text()
api = (ROOT / "components" / "web_api" / "control_api.c").read_text()

assert 'const AUTO_TX_ARM_LEAD_MS = 700;' in page
assert 'const stageWaveform = this.txStageWaveform;' in page
assert 'const stageMessage = wanted;' in page
assert 'this.stagedWaveformMessage = stageMessage;' in page
assert 'this.stagedWaveformId !== waveformId || this.stagedWaveformMessage !== String(message || "").trim() || this.stagedWaveformRevision !== revision' in page
assert 'this.armedTxMessage = String(message || "").trim();' in page
assert 'this.armedWaveformId = waveformId;' in page
assert 'async cancelStaleArmedTx(previousMessage, nextMessage)' in page
assert '/api/v1/ft8/tx/stop' in page
assert 'error.code = "FT8_STALE_PLAN"' in page
assert 'notifyTxStarted?.({message:transmittedMessage,slotIndex,waveformId:activeWaveformId})' in page
assert 'active_msg' in api and '\"waveform_id\"' in api
print("FT8 TX sequence-integrity contracts: OK")
