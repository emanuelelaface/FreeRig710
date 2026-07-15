#!/usr/bin/env bash
set -u

failures=0
check() {
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '[OK]   %s\n' "${description}"
  else
    printf '[FAIL] %s\n' "${description}"
    failures=$((failures + 1))
  fi
}

check "CAT-1 symlink exists" test -e /dev/ttyFT710_CAT
check "CAT-2 symlink exists" test -e /dev/ttyFT710_AUX
check "TC358743 video device exists" test -e /dev/video0
check "TC358743 media topology is visible" sh -c "media-ctl -p | grep -q tc358743"
check "EDID service is active" systemctl is-active --quiet tc358743-edid.service
check "FastAPI service is active" systemctl is-active --quiet ft710-api.service
check "PipeWire/PulseAudio server is reachable" pactl info
check "FreeRig710 audio sink exists" sh -c "pactl list short sinks | awk '{print \$2}' | grep -qx ft710_out_44100"
check "FreeRig710 audio source exists" sh -c "pactl list short sources | awk '{print \$2}' | grep -qx ft710_in_44100"

printf '\nDetected video timing:\n'
v4l2-ctl -d /dev/video0 --query-dv-timings 2>/dev/null || true

exit "${failures}"
