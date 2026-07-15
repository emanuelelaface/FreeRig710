#!/usr/bin/env bash
set -euo pipefail

document_root="${FREERIG710_DOCUMENT_ROOT:-/var/www/ft710}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

[[ ${EUID} -eq 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }
install -d -o root -g root -m 0755 "${document_root}"
cp -a "${repo_root}/frontend/." "${document_root}/"
chown -R root:root "${document_root}"
find "${document_root}" -type d -exec chmod 0755 {} +
find "${document_root}" -type f -exec chmod 0644 {} +
apache2ctl configtest
systemctl reload apache2
echo "Frontend deployed to ${document_root}"
