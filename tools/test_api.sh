#!/usr/bin/env bash
set -euo pipefail
HOST="${1:-ft710.local}"
case "$HOST" in
  http://*|https://*) BASE="${HOST%/}" ;;
  *) BASE="http://${HOST%/}" ;;
esac

pretty() { python3 -m json.tool; }

echo "== FreeRig710 backend: $BASE =="
echo "-- capabilities"
curl -fsS "$BASE/api/v1/capabilities" | pretty
echo "-- state"
curl -fsS "$BASE/api/v1/state" | pretty
echo "-- CAT"
curl -fsS "$BASE/api/v1/hardware/cat" | pretty
echo "-- audio"
curl -fsS "$BASE/api/v1/hardware/audio" | pretty
echo "-- video / CSI recovery diagnostics"
curl -fsS "$BASE/api/v1/hardware/csi" | pretty
echo "-- FT8 timing/audio/decode/TX diagnostics"
curl -fsS "$BASE/api/v1/ft8/status" | pretty
echo "-- QRZ config status"
curl -fsS "$BASE/api/v1/qrz/status" | pretty
