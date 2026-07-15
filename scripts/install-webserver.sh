#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  sudo ./scripts/install-webserver.sh \
    --domain radio.example.com \
    --raspberry-ip 192.168.1.20 \
    --username RADIO_LOGIN \
    [--admin-email webmaster@example.com] \
    [--document-root /var/www/ft710]

A valid Let's Encrypt certificate must already exist under:
  /etc/letsencrypt/live/DOMAIN/
Obtain it first with certbot, then run this script again.
USAGE
}

[[ ${EUID} -eq 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
domain=""
raspberry_ip=""
username=""
admin_email="webmaster@localhost"
document_root="/var/www/ft710"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --raspberry-ip) raspberry_ip="$2"; shift 2 ;;
    --username) username="$2"; shift 2 ;;
    --admin-email) admin_email="$2"; shift 2 ;;
    --document-root) document_root="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "${domain}" && -n "${raspberry_ip}" && -n "${username}" ]] || { usage; exit 2; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y apache2 apache2-utils openssl certbot python3-certbot-apache

a2enmod ssl headers rewrite proxy proxy_http proxy_wstunnel \
  auth_form authn_file session session_cookie session_crypto

install -d -o root -g root -m 0755 "${document_root}"
find "${document_root}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "${repo_root}/frontend/." "${document_root}/"
chown -R root:root "${document_root}"
find "${document_root}" -type d -exec chmod 0755 {} +
find "${document_root}" -type f -exec chmod 0644 {} +

if [[ ! -f /etc/apache2/freerig710.htpasswd ]]; then
  echo "Create the Apache login password for ${username}:"
  htpasswd -c /etc/apache2/freerig710.htpasswd "${username}"
else
  echo "Keeping the existing /etc/apache2/freerig710.htpasswd"
fi
chown root:www-data /etc/apache2/freerig710.htpasswd
chmod 0640 /etc/apache2/freerig710.htpasswd

if [[ ! -f /etc/apache2/freerig710-session.key ]]; then
  umask 0077
  openssl rand -base64 48 > /etc/apache2/freerig710-session.key
fi
chown root:www-data /etc/apache2/freerig710-session.key
chmod 0640 /etc/apache2/freerig710-session.key

certificate_dir="/etc/letsencrypt/live/${domain}"
if [[ ! -f "${certificate_dir}/fullchain.pem" || ! -f "${certificate_dir}/privkey.pem" ]]; then
  cat >&2 <<CERT
No certificate was found for ${domain}.
Run a command such as:

  sudo certbot certonly --apache -d ${domain}

Then rerun this installation script. Frontend files and authentication files
have already been installed; no secret was printed.
CERT
  exit 3
fi

sed \
  -e "s|@SERVER_ADMIN@|${admin_email}|g" \
  -e "s|@PUBLIC_DOMAIN@|${domain}|g" \
  -e "s|@DOCUMENT_ROOT@|${document_root}|g" \
  -e "s|@RASPBERRY_PI_IP@|${raspberry_ip}|g" \
  "${repo_root}/config/apache/freerig710.conf.template" \
  > /etc/apache2/sites-available/freerig710.conf

apache2ctl configtest
a2ensite freerig710.conf
systemctl reload apache2

echo "FreeRig710 is installed at https://${domain}/"
