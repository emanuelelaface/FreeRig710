# Architecture

FreeRig710 separates radio access, media capture, browser delivery and public
authentication into independent components.

## Radio and media ownership

```text
/dev/ttyFT710_CAT
  └── WSJT-X (direct CAT-1 / Enhanced COM, 115200 8N2)

/dev/ttyFT710_AUX
  └── FastAPI direct CAT-2 / Standard COM, 115200 8N1
        ├── polling and state events
        ├── VFO, mode, DSP, tuner and power controls
        ├── memories and CW functions
        └── CAT PTT for browser microphone audio

/dev/video0
  └── GStreamer
        └── latest-frame MJPEG relay
              └── browser radio-display panel

FT-710 USB audio
  ├── ft710_in_44100 → parec → WebSocket → browser speaker
  └── browser microphone → WebSocket → paplay → ft710_out_44100

TigerVNC :105 / TCP 6005 on localhost
  └── WSJT-X + Openbox
        └── websockify/noVNC on private TCP 10005
```

## Web path

```text
Browser
  └── HTTPS https://radio.example.com
        └── Apache form login and encrypted session cookie
              ├── /                    → static frontend
              ├── /ft710-api/          → FastAPI TCP 8100
              └── /ft8/                → noVNC/websockify TCP 10005
```

Apache terminates TLS and is the only public-facing component. The API and
noVNC ports should remain on a private network and be firewalled to the Apache
host.

## FastAPI internals

- `direct_cat.py` serializes all CAT-2 transactions with one process-local
  lock and forces RTS/DTR low.
- `state.py` polls the radio and publishes state changes.
- `video.py` keeps only the newest complete JPEG frame, preventing slow
  clients from building delayed queues.
- `audio.py` bridges ordered 16-bit mono PCM over a WebSocket and uses
  PipeWire/PulseAudio as the timing buffer.
- `ft8.py` starts and stops TigerVNC plus websockify only after explicit user
  action from the web interface.
- `memories.py` stores metadata in a local SQLite runtime database.

The SQLite database, logs and PID files are runtime data and are deliberately
excluded from Git.
