from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "frontend" / "ft8-page.js").read_text()
api = (ROOT / "components" / "web_api" / "control_api.c").read_text()

assert "const AUTO_TX_MAX_LATE_MS = 1450;" in page
assert "phase <= AUTO_TX_MAX_LATE_MS" in page
assert "lead < -AUTO_TX_MAX_LATE_MS" in page
assert "#define FT8_TX_ARM_MAX_LATE_MS 1650U" in api
assert "#define FT8_TX_HARD_STOP_OFFSET_MS 14650U" in api
assert "current FT8 TX slot is already too late to arm safely" in api
assert "s_ft8_tx_hard_stop_unix_ms = target_unix + FT8_TX_HARD_STOP_OFFSET_MS;" in api
print("FT8 same-slot bounded late-start contract: OK")

assert "ft8_waveform_ready is emitted by the ESP32 only after every byte" in page
assert "alreadyInsideTargetSlot" in page
# Even the backend acceptance edge leaves margin before the hard stop for the
# 12.64 s staged waveform (CAT/PTT setup still needs hardware verification).
assert 1650 + 12640 < 14650
assert 14650 < 15000
