# Apache2 deployment

The FreeRig710 frontend is static. For remote use, Apache should serve `frontend/` from `/var/www/ft710` and reverse-proxy the ESP32 API/video/audio paths on the same HTTPS origin.

## Why same-origin

When the frontend is served from HTTPS, the current JavaScript uses same-origin URLs:

```text
/api/v1/...
/api/v1/audio/ws
/video.mjpeg
```

Do not use the old Raspberry Pi `/ft710-api/` prefix. Do not proxy `/ft8/` to noVNC/WSJT-X: FT8, JS8 and Winlink are static files served as `/ft8.html`, `/js8.html` and `/winlink.html`.

## 1. Copy the frontend

```bash
sudo install -d -o www-data -g www-data /var/www/ft710
sudo rsync -a --delete frontend/ /var/www/ft710/
```

## 2. Enable Apache modules

```bash
sudo a2enmod ssl headers proxy proxy_http proxy_wstunnel \
  auth_form authn_file authz_user session session_cookie session_crypto
```

## 3. Create the login password file

```bash
sudo htpasswd -c /etc/apache2/freerig710.htpasswd operator
```

Add additional users later without `-c`.

## 4. Create the session crypto key

```bash
openssl rand -base64 48 | sudo tee /etc/apache2/freerig710-session.key >/dev/null
sudo chmod 600 /etc/apache2/freerig710-session.key
```

## 5. Install the virtual host

Copy `deploy/apache/ft710-ssl.conf.example` to `/etc/apache2/sites-available/freerig710-ssl.conf` and edit at least:

- `ServerName`;
- the ESP32 private IP (`192.168.1.88` in the template);
- certificate paths;
- password/session file paths if you changed them.

The template protects the static frontend, REST API, WebSocket, video and digital-mode pages with the same Apache form-login cookie while leaving `/login.html` and `/ft710-login` public.

## 6. Enable and test

```bash
sudo a2ensite freerig710-ssl.conf
sudo apache2ctl configtest
sudo systemctl reload apache2
```

`apache2ctl configtest` must report `Syntax OK` before reload.

## 7. Optional HTTP → HTTPS redirect

`deploy/apache/ft710-http-redirect.conf.example` contains a minimal port-80 redirect virtual host.

## Network/security notes

- Keep ESP32 port 80 on a trusted private LAN/VLAN.
- Expose only Apache HTTPS to remote users.
- Use a real TLS certificate.
- Keep the form-login password file and session crypto key outside the repository.
- QRZ credentials are not stored on the Apache server; they live in ESP32 NVS.
- The ESP32 needs outbound DNS/NTP for UTC sync and outbound HTTPS to QRZ when QRZ features are used.
