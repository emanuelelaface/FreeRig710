from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "frontend" / "ft8-page.js").read_text()
engine = (ROOT / "frontend" / "ft8.js").read_text()
html = (ROOT / "frontend" / "ft8.html").read_text()

# The main TX readout must mirror the frequency shown by the radio for VFO B.
assert '<span>TX VFO B</span><strong id="ft8-tx-rf">' in html
tx_plan = page[page.index("    updateTxPlan(pushRadio = false) {"):page.index("    async selectWaterfallDf(event) {")]
assert 'id("ft8-tx-rf").textContent = formatHz(this.txVfoBDialHz());' in tx_plan
assert 'id("ft8-tx-rf").textContent = formatHz(this.txRfHz());' not in tx_plan

# Band changes are serialized, stale generations stop issuing CAT commands,
# and READY is shown only after observed A/B/mode/split verification.
assert "radioConfigPromise: null" in page
assert "radioConfigGeneration: 0" in page
configure = page[page.index("    async configureRadioForFt8(recovery = false) {"):page.index("    syncWaterfallAxis() {")]
for token in (
    "const previous = this.radioConfigPromise || Promise.resolve(false);",
    "radioConfigurationStillCurrent(target)",
    "radioConfigurationMatches(state, target)",
    "verifyFt8RadioConfiguration(target)",
    "both VFOs verified",
):
    assert token in configure

# Returning from a suspended/BFCache page reconciles the authoritative ESP32
# status and recreates a stale audio connection without requiring a reload.
for token in (
    'document.addEventListener("visibilitychange"',
    'document.addEventListener("freeze"',
    'document.addEventListener("resume"',
    'window.addEventListener("pageshow"',
    'window.addEventListener("focus"',
    'recoverFromSuspension("FT8 page restored from browser cache", true)',
    "await this.refreshTxDiagnostics();",
    "Date.now() - this.lastAudioMessageAt > 3000",
    'this.renderAutoTxState("recovering browser-suspended FT8 state");',
    "radio VFOs could not be restored for the selected FT8 band",
    "suspensionRecoveryRequired",
    "if (this.resumeRecoveryPromise) await this.resumeRecoveryPromise;",
    "autoTxEnableGeneration",
    'error.code = "FT8_ENABLE_CANCELLED"',
):
    assert token in page

# A Chromium-frozen codec Worker is probed and recreated, clearing stale
# decode/encode operations that otherwise keep the QSO scheduler inert.
worker = (ROOT / "frontend" / "ft8-worker.js").read_text()
for token in (
    "workerProbeWaiters: new Map()",
    "decodeBusySinceMs",
    "async recoverFromSuspension(reason",
    "this.restartWorker(",
    'worker.postMessage({ type: "ping", requestId });',
):
    assert token in engine
assert 'if (message.type === "ping")' in worker
assert 'type: "pong"' in worker
assert "v=1.0-resume3" in html

# A new row click can safely stop/take over an old automatic QSO instead of
# being silently ignored by stale browser TX flags.
assert "async selectDecodeFromActivity(row)" in engine
assert "prepareForActivitySelection({switchingDx})" in engine
assert 'await this.haltAutoTx("new Band Activity selection");' in page

print("FT8 resume/band/VFO regression contract: OK")
