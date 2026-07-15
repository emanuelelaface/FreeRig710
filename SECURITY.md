# Security policy and deployment warnings

FreeRig710 can tune and transmit through a real amateur-radio transceiver. A
configuration error can expose radio control, microphone audio or an
unauthenticated VNC desktop to other users. Treat the Raspberry Pi and Apache
server as security-sensitive station equipment.

## Never commit these files

Do not add any of the following to Git:

- `/etc/ft710-api.env` when it contains site-specific private data;
- Apache `htpasswd` files;
- `/etc/apache2/freerig710-session.key`;
- TLS private keys or Let's Encrypt directories;
- SSH private keys, access tokens or passwords;
- runtime SQLite databases, logs, PID files or VNC state;
- WSJT-X configuration containing personal information you do not want public.

The included `.gitignore` blocks the common forms, but always review
`git status` and `git diff --cached` before committing.

## Network isolation

The FastAPI service on TCP 8100 and websockify/noVNC on TCP 10005 do not
provide their own user login. Authentication and TLS are provided by Apache.
On a two-host installation, firewall the Raspberry Pi so only the Apache
server can reach those two ports. Do not forward either port directly from an
Internet router.

TigerVNC is intentionally started with `SecurityTypes=None` and listens only
on localhost. websockify publishes that desktop on the configured private
address. Anyone who can bypass Apache and reach port 10005 may control WSJT-X.

## Browser audio and PTT

Use HTTPS. The backend compares the audio WebSocket `Origin` header with
`FT710_AUDIO_ALLOWED_ORIGIN`; configure the exact public HTTPS origin. Keep
`FT710_ALLOW_RAW_CAT=false` unless you are debugging on a trusted network.

Test transmit functions into a dummy load or at very low power. Use a headset
to prevent acoustic feedback. Verify that CAT PTT releases when the browser is
closed, the network is disconnected or the API is stopped.

## Credentials

Use a strong, unique Apache login password. The session encryption key is
generated locally with `openssl rand` and must remain readable only by root
and the Apache group. Rotate the password and session key if they are ever
exposed.

## Reporting a vulnerability

When publishing this repository, configure the security-contact method for
your Git hosting provider. Do not open a public issue containing credentials,
private IP layouts, private keys or exploitable station details.
