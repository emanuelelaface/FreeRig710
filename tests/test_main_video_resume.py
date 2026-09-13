from pathlib import Path

root = Path(__file__).resolve().parents[1]
app = (root / "frontend" / "app.js").read_text()
index = (root / "frontend" / "index.html").read_text()

assert 'const VIDEO_HIDDEN_GRACE_MS = 20000;' in app
assert 'const VIDEO_FIRST_FRAME_TIMEOUT_MS = 1800;' in app
assert 'const VIDEO_ERROR_RETRY_MS = 400;' in app
assert 'const VIDEO_STALL_RETRY_MS = 250;' in app
assert 'if (document.hidden) stop();\n    else if (!manuallyPaused) load();' not in app
assert 'hiddenStopTimer = setTimeout(() =>' in app
assert 'if (!image.getAttribute("src") || !streamLive)' in app
assert 'retryTimer = setTimeout(load, VIDEO_ERROR_RETRY_MS);' in app
assert 'retryTimer = setTimeout(load, VIDEO_STALL_RETRY_MS);' in app
assert '}, VIDEO_FIRST_FRAME_TIMEOUT_MS);' in app
assert 'window.addEventListener("pageshow"' in app
assert 'document.addEventListener("resume", recoverAfterSystemWake);' in app
assert 'if (blurredForMs > VIDEO_HIDDEN_GRACE_MS) recoverAfterSystemWake();' in app
assert 'window.addEventListener("online", recoverAfterSystemWake);' in app

# CAT polling and optional radio audio are explicitly restarted after a frozen
# page or network sleep instead of requiring a browser reload.
assert 'timeoutMs: 5000' in app
assert 'window.addEventListener("pageshow", start);' in app
assert 'document.addEventListener("resume", start);' in app
assert 'window.addEventListener("focus", start);' in app
assert 'window.addEventListener("online", start);' in app
assert 'const recoverAudioAfterWake = async () =>' in app
assert 'scheduleAudioRecovery(250)' in app
assert 'audioOwnerChannel = null;' in app
assert 'app.js?v=1.0-wake1' in index
print("main video resume contract: OK")
