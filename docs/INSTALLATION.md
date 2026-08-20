# Installation

## 1. Install ESP-IDF

The validated FreeRig710 1.0 baseline uses ESP-IDF 6.0.2.

Set up ESP-IDF using Espressif's normal installation instructions, then verify:

```bash
idf.py --version
```

## 2. Build

```bash
git clone https://github.com/emanuelelaface/FreeRig710.git
cd FreeRig710
. "$IDF_PATH/export.sh"
idf.py fullclean
idf.py build
```

The project sets `IDF_TARGET` to `esp32p4` in the root `CMakeLists.txt`.

Managed dependencies are declared in the component manifests:

- `espressif/usb` 1.0.0
- `espressif/mdns` 1.11.0
- `espressif/cjson` compatible with `^1.7.19`

## 3. Flash

Connect the Waveshare programming USB-C port and identify the serial device, then:

```bash
idf.py -p /dev/ttyUSB0 flash monitor
```

Do not force a chip-revision mismatch. The tested board uses pre-v3 ESP32-P4 silicon (rev v1.3) and `sdkconfig.defaults` explicitly enables the pre-v3 family. If your board has newer v3.x silicon, review the Waveshare/Espressif revision configuration before flashing.

## 4. Connect the radio

With the FT-710 configured as described in `RADIO_SETUP.md`:

- FT-710 USB-B → ESP32-P4-NANO USB-A host.
- FT-710 EXT-DISPLAY → DVI/HDMI adapter → HDMI → TC358743 → MIPI-CSI.
- ESP32-P4-NANO RJ45 → LAN.

## 5. Validate the boot log

A healthy boot should eventually show:

- DHCP address;
- mDNS `ft710.local`;
- SNTP synchronized UTC;
- TC358743 detected at `0x0F`;
- stable 800×480 input;
- continuous CSI/JPEG capture;
- FT-710 CP2105 CAT bridge;
- CAT-2/AUX configured at 115200 8N1;
- UAC1 audio RX/TX initialized.

Useful direct endpoints on the ESP32 include:

```text
http://ft710.local/
http://ft710.local/api/v1/health
http://ft710.local/api/v1/state
http://ft710.local/api/v1/hardware/cat
http://ft710.local/api/v1/hardware/audio
http://ft710.local/video.mjpeg
```

## 6. Deploy the web frontend

For Apache deployment:

```bash
sudo install -d -o www-data -g www-data /var/www/ft710
sudo rsync -a --delete frontend/ /var/www/ft710/
```

Then follow `APACHE.md`.

For a development machine, `tools/serve_gui.py` can serve the static frontend; when loaded from localhost, `frontend/config.js` points the frontend at `http://ft710.local`.

## 7. First-use checklist

1. Verify the main page reports **CAT connected**.
2. Verify live video.
3. Change frequency/mode at low risk and confirm the radio follows.
4. Enable browser RX audio.
5. Configure QRZ only after normal CAT/network operation is stable.
6. For FT8, start with low RF power or a dummy load.
7. Wait for **CLOCK SYNC** before automatic FT8 TX.
8. Verify the selected FT8 band configures VFO A/B as expected before arming TX.
