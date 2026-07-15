#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  sudo ./scripts/install-raspberry.sh \
    --user RADIO_USER \
    --domain radio.example.com \
    --raspberry-ip 192.168.1.20 \
    --webserver-ip 192.168.1.10 \
    --radio-serial USB_SERIAL \
    [--install-dir /opt/freerig710] \
    [--audio-devpath '*/usb1/.../*'] \
    [--scope-devpath '*/usb1/...']

The script installs packages, copies the checkout, builds the Python virtual
environment, renders non-secret configuration files and installs systemd/udev
units. It does not configure WSJT-X preferences and does not expose ports in a
firewall.
USAGE
}

[[ ${EUID} -eq 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
radio_user=""
public_domain=""
raspberry_ip=""
webserver_ip=""
radio_serial=""
install_dir="/opt/freerig710"
audio_devpath=""
scope_devpath=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) radio_user="$2"; shift 2 ;;
    --domain) public_domain="$2"; shift 2 ;;
    --raspberry-ip) raspberry_ip="$2"; shift 2 ;;
    --webserver-ip) webserver_ip="$2"; shift 2 ;;
    --radio-serial) radio_serial="$2"; shift 2 ;;
    --install-dir) install_dir="$2"; shift 2 ;;
    --audio-devpath) audio_devpath="$2"; shift 2 ;;
    --scope-devpath) scope_devpath="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

for value_name in radio_user public_domain raspberry_ip webserver_ip radio_serial; do
  [[ -n "${!value_name}" ]] || { echo "Missing required option: ${value_name}" >&2; usage; exit 2; }
done

id "${radio_user}" >/dev/null 2>&1 || { echo "User does not exist: ${radio_user}" >&2; exit 1; }
radio_group="$(id -gn "${radio_user}")"
radio_uid="$(id -u "${radio_user}")"
radio_home="$(getent passwd "${radio_user}" | cut -d: -f6)"
runtime_dir="/run/user/${radio_uid}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  python3 python3-venv python3-pip \
  v4l-utils media-types \
  gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  alsa-utils pipewire pipewire-pulse pulseaudio-utils \
  tigervnc-standalone-server tigervnc-tools novnc websockify wsjtx \
  openbox dbus-x11 xauth x11-xserver-utils

usermod -aG dialout,video,audio,plugdev "${radio_user}"
install -d -o "${radio_user}" -g "${radio_group}" "${install_dir}"

if [[ "$(realpath "${repo_root}")" != "$(realpath "${install_dir}")" ]]; then
  find "${install_dir}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar --exclude=.git --exclude='*.zip' --exclude='*.tar.*' -C "${repo_root}" -cf - . \
    | tar -C "${install_dir}" -xf -
fi
chown -R "${radio_user}:${radio_group}" "${install_dir}"
chmod +x "${install_dir}/api/run-api.sh" "${install_dir}/scripts/"*

runuser -u "${radio_user}" -- python3 -m venv "${install_dir}/api/.venv"
runuser -u "${radio_user}" -- "${install_dir}/api/.venv/bin/python" -m pip install --upgrade pip
runuser -u "${radio_user}" -- "${install_dir}/api/.venv/bin/pip" install -r "${install_dir}/api/requirements.txt"
install -d -o "${radio_user}" -g "${radio_group}" -m 0700 "${install_dir}/api/data"

python3 - "${install_dir}" "${radio_user}" "${radio_home}" "${radio_uid}" \
  "${public_domain}" "${raspberry_ip}" "${webserver_ip}" <<'PY'
from pathlib import Path
import sys

install_dir, user, home, uid, domain, rpi_ip, web_ip = sys.argv[1:]
template = Path(install_dir, "config/environment/ft710-api.env.example").read_text()
replacements = {
    "/opt/freerig710": install_dir,
    "192.0.2.10": rpi_ip,
    "192.0.2.20": web_ip,
    "radio.example.com": domain,
    "/home/radio": home,
    "FT710_FT8_USER=radio": f"FT710_FT8_USER={user}",
    "/run/user/1000": f"/run/user/{uid}",
}
for old, new in replacements.items():
    template = template.replace(old, new)
Path("/etc/ft710-api.env").write_text(template)
PY
chmod 0600 /etc/ft710-api.env
chown root:root /etc/ft710-api.env

# Stable CAT symlinks and optional topology-specific audio/scope rules.
python3 - "${install_dir}/config/udev/99-ft710.rules.template" \
  "${radio_serial}" "${audio_devpath}" "${scope_devpath}" <<'PY'
from pathlib import Path
import sys

template_path, serial, audio_path, scope_path = sys.argv[1:]
text = Path(template_path).read_text().replace("@RADIO_USB_SERIAL@", serial)
if audio_path:
    text = text.replace("@FT710_AUDIO_USB_DEVPATH@", audio_path)
    text = text.replace('# SUBSYSTEM=="sound"', 'SUBSYSTEM=="sound"')
if scope_path:
    text = text.replace("@FT710_SCOPE_USB_DEVPATH@", scope_path)
    text = text.replace('# SUBSYSTEM=="usb"', 'SUBSYSTEM=="usb"')
Path("/etc/udev/rules.d/99-ft710.rules").write_text(text)
PY
udevadm control --reload-rules
udevadm trigger

# Raspberry Pi boot overlay.
boot_config=/boot/firmware/config.txt
[[ -f "${boot_config}" ]] || boot_config=/boot/config.txt
if ! grep -Eq '^dtoverlay=tc358743([,[:space:]]|$)' "${boot_config}"; then
  printf '\n# FreeRig710 HDMI-to-CSI2 bridge\ndtoverlay=tc358743\n' >> "${boot_config}"
fi

# TigerVNC startup file.
install -d -o "${radio_user}" -g "${radio_group}" -m 0700 "${radio_home}/.config/tigervnc"
install -o "${radio_user}" -g "${radio_group}" -m 0755 \
  "${install_dir}/config/tigervnc/xstartup.template" \
  "${radio_home}/.config/tigervnc/xstartup"

# Render system services.
sed \
  -e "s|@USER@|${radio_user}|g" \
  -e "s|@GROUP@|${radio_group}|g" \
  -e "s|@HOME@|${radio_home}|g" \
  -e "s|@INSTALL_DIR@|${install_dir}|g" \
  "${install_dir}/config/systemd/ft710-api.service.template" \
  > /etc/systemd/system/ft710-api.service

sed \
  -e "s|@VIDEO_DEVICE@|/dev/video0|g" \
  -e "s|@EDID_FILE@|${install_dir}/config/video/tc358743-edid.hex|g" \
  "${install_dir}/config/systemd/tc358743-edid.service.template" \
  > /etc/systemd/system/tc358743-edid.service

install -d -o "${radio_user}" -g "${radio_group}" -m 0700 "${radio_home}/.config/systemd/user"
sed -e "s|@INSTALL_DIR@|${install_dir}|g" \
  "${install_dir}/config/systemd/ft710-audio-watch.service.template" \
  > "${radio_home}/.config/systemd/user/ft710-audio-watch.service"
chown "${radio_user}:${radio_group}" "${radio_home}/.config/systemd/user/ft710-audio-watch.service"

loginctl enable-linger "${radio_user}"
systemctl start "user@${radio_uid}.service"
runuser -u "${radio_user}" -- env \
  XDG_RUNTIME_DIR="${runtime_dir}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus" \
  systemctl --user daemon-reload
runuser -u "${radio_user}" -- env \
  XDG_RUNTIME_DIR="${runtime_dir}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=${runtime_dir}/bus" \
  systemctl --user enable ft710-audio-watch.service

systemctl daemon-reload
systemctl enable ft710-api.service tc358743-edid.service

cat <<SUMMARY

Raspberry Pi files installed successfully.

Next steps:
  1. Reboot so the tc358743 overlay and new group memberships are active.
  2. Confirm /dev/ttyFT710_CAT, /dev/ttyFT710_AUX and /dev/video0 exist.
  3. If --audio-devpath was omitted, finish the ALSA card-name udev rule.
  4. Configure the FT-710 and WSJT-X exactly as documented in README.md.
  5. Start services:
       sudo systemctl start tc358743-edid ft710-api
       sudo -u ${radio_user} XDG_RUNTIME_DIR=${runtime_dir} \\
         DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime_dir}/bus \\
         systemctl --user start ft710-audio-watch

The API/noVNC ports are unauthenticated on the private network. Restrict TCP
8100 and 10005 so only the Apache server (${webserver_ip}) can reach them.
SUMMARY
