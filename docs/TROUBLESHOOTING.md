# Troubleshooting

## CAT symlinks are missing

List the two CP2105 interfaces:

```bash
ls -l /dev/ttyUSB*
for device in /dev/ttyUSB*; do
  echo "=== $device ==="
  udevadm info -q property -n "$device" | grep -E 'ID_VENDOR_ID|ID_MODEL_ID|ID_SERIAL_SHORT|ID_USB_INTERFACE_NUM'
done
```

The FT-710 normally reports vendor `10c4`, product `ea70`, interface `00` for
CAT-1 and interface `01` for CAT-2. Put the radio USB serial in
`/etc/udev/rules.d/99-ft710.rules`, reload rules and reconnect the cable:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
ls -l /dev/ttyFT710_CAT /dev/ttyFT710_AUX
```

WSJT-X must use `ttyFT710_CAT`; FastAPI must use `ttyFT710_AUX`.

## API reports CAT-2 timeouts

Check that the radio has `CAT-2 RATE = 115200`, then confirm that only one
process owns AUX:

```bash
sudo fuser -v /dev/ttyFT710_AUX
sudo journalctl -u ft710-api -n 100 --no-pager
```

Do not configure WSJT-X to use AUX.

## TC358743 or `/dev/video0` is missing

Confirm the boot overlay and reboot:

```bash
grep -n 'dtoverlay=tc358743' /boot/firmware/config.txt
media-ctl -p
v4l2-ctl --list-devices
```

Expected topology:

```text
tc358743 10-000f → unicam-image → /dev/video0
```

## No HDMI signal or wrong resolution

On the radio, set `EXT DISPLAY = ON` and `PIXEL = 800x480`. Verify timings:

```bash
v4l2-ctl -d /dev/video0 --query-dv-timings
v4l2-ctl -d /dev/video0 --set-dv-bt-timings query
v4l2-ctl -d /dev/video0 -V
```

Reload the bundled EDID:

```bash
sudo systemctl restart tc358743-edid.service
sudo systemctl status tc358743-edid.service --no-pager -l
```

## Video API starts but the browser image is blank

Run the capture pipeline manually after stopping the API:

```bash
sudo systemctl stop ft710-api

gst-launch-1.0 -v \
  v4l2src device=/dev/video0 do-timestamp=true ! \
  'video/x-raw,format=UYVY,width=800,height=480,framerate=60/1' ! \
  videoconvert ! autovideosink

sudo systemctl start ft710-api
```

For a headless test, replace `autovideosink` with `jpegenc ! filesink
location=/tmp/ft710-test.jpg`.

## Audio endpoints do not appear

Check the ALSA card and user audio server:

```bash
aplay -l
pactl info
pactl list short sinks
pactl list short sources
```

The udev rule should name the radio card `FT710`. Run:

```bash
/opt/freerig710/scripts/ft710-wsjtx-audio
```

Expected endpoints are `ft710_out_44100` and `ft710_in_44100`. The system API
service and the PipeWire/PulseAudio session must run as the same radio user.

## WSJT-X has no audio

In **File → Settings → Audio**, set both input and output to `pulse`, mono.
Check that the FreeRig710 sink/source are the user-session defaults:

```bash
pactl info | grep -E 'Default Sink|Default Source'
```

## noVNC does not open

Check both listeners:

```bash
ss -ltnp | grep -E ':6005|:10005'
sudo journalctl -u ft710-api -n 200 --no-pager
```

Display `:105` maps to VNC TCP port `6005`. websockify should listen on the
configured private address at port `10005`. The public browser URL is `/ft8/`
through Apache, not direct access to the Raspberry port.

## Apache login loops or returns 500

Check modules and configuration:

```bash
sudo apache2ctl -M | grep -E 'auth_form|authn_file|session|session_cookie|session_crypto|proxy|proxy_http|proxy_wstunnel|ssl|headers|rewrite'
sudo apache2ctl configtest
sudo tail -n 100 /var/log/apache2/freerig710-error.log
```

Verify that these root-owned files exist and are readable by the Apache group:

```text
/etc/apache2/freerig710.htpasswd
/etc/apache2/freerig710-session.key
```
