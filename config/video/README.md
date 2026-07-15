# TC358743 EDID

`tc358743-edid.hex` is the exact 256-byte EDID used by the tested GeeekPi
HDMI-to-CSI2 installation. Both 128-byte blocks have valid checksums.

The systemd template loads it with:

```bash
v4l2-ctl -d /dev/video0 --set-edid=pad=0,file=/opt/freerig710/config/video/tc358743-edid.hex
```

The service retries for up to 30 seconds because `/dev/video0` may appear
after systemd begins booting.

This is third-party PiKVM data. See `../../THIRD_PARTY_NOTICES.md` and
`../../licenses/GPL-3.0.txt`.
