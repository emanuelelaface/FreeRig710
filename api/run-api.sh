#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UVICORN_BINARY="${FT710_UVICORN_BINARY:-${SCRIPT_DIR}/.venv/bin/uvicorn}"
API_HOST="${FT710_API_HOST:-127.0.0.1}"
API_PORT="${FT710_API_PORT:-8100}"
LOG_LEVEL="${FT710_UVICORN_LOG_LEVEL:-info}"
FORWARDED_ALLOW_IPS="${FT710_FORWARDED_ALLOW_IPS:-127.0.0.1}"

if [[ ! -x "${UVICORN_BINARY}" ]]; then
  printf 'Uvicorn is not executable: %s\n' "${UVICORN_BINARY}" >&2
  printf 'Create the virtual environment and install api/requirements.txt first.\n' >&2
  exit 1
fi

cd "${SCRIPT_DIR}"
exec "${UVICORN_BINARY}" app.main:app \
  --host "${API_HOST}" \
  --port "${API_PORT}" \
  --workers 1 \
  --log-level "${LOG_LEVEL}" \
  --proxy-headers \
  --forwarded-allow-ips="${FORWARDED_ALLOW_IPS}"
