#!/usr/bin/env bash
set -euo pipefail

install_dir="${FREERIG710_INSTALL_DIR:-/opt/freerig710}"
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

[[ ${EUID} -eq 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }
[[ -f /etc/systemd/system/ft710-api.service ]] || {
  echo "ft710-api.service is not installed." >&2
  exit 1
}

service_user="$(systemctl show -p User --value ft710-api.service)"
service_group="$(id -gn "${service_user}")"

systemctl stop ft710-api.service
cp -a "${repo_root}/api/app/." "${install_dir}/api/app/"
cp "${repo_root}/api/requirements.txt" "${repo_root}/api/run-api.sh" "${install_dir}/api/"
cp "${repo_root}/scripts/ft710-audio-watch" "${repo_root}/scripts/ft710-wsjtx-audio" "${install_dir}/scripts/"
chown -R "${service_user}:${service_group}" "${install_dir}/api" "${install_dir}/scripts"
chmod +x "${install_dir}/api/run-api.sh" "${install_dir}/scripts/ft710-"*
runuser -u "${service_user}" -- "${install_dir}/api/.venv/bin/pip" install -r "${install_dir}/api/requirements.txt"
systemctl start ft710-api.service
systemctl --no-pager --full status ft710-api.service
