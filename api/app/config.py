from __future__ import annotations

import os
import pwd
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return default if value is None else int(value)


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return default if value is None else float(value)


_CURRENT_UID = os.getuid()
_CURRENT_USER = pwd.getpwuid(_CURRENT_UID).pw_name
_DEFAULT_HOME = Path(os.getenv("HOME", str(Path.home())))
_DEFAULT_RUNTIME_DIR = os.getenv("XDG_RUNTIME_DIR", f"/run/user/{_CURRENT_UID}")
_DEFAULT_INSTALL_DIR = Path(
    os.getenv("FREERIG710_INSTALL_DIR", str(_DEFAULT_HOME / "FreeRig710"))
)


@dataclass(frozen=True, slots=True)
class Settings:
    root_path: str = os.getenv("FT710_ROOT_PATH", "/ft710-api").rstrip("/")

    # Dedicated FT-710 CAT-2 (Standard COM) port used only by this API.
    # WSJT-X directly owns CAT-1 (Enhanced COM) through /dev/ttyFT710_CAT.
    cat2_device: str = os.getenv("FT710_CAT2_DEVICE", "/dev/ttyFT710_AUX")
    cat2_baud: int = _env_int("FT710_CAT2_BAUD", 115200)
    cat2_query_timeout: float = _env_float("FT710_CAT2_QUERY_TIMEOUT", 0.75)
    cat2_write_timeout: float = _env_float("FT710_CAT2_WRITE_TIMEOUT", 0.5)

    poll_interval: float = _env_float("FT710_POLL_INTERVAL", 0.75)
    settings_poll_interval: float = _env_float("FT710_SETTINGS_POLL_INTERVAL", 0.5)

    memories_db: str = os.getenv(
        "FT710_MEMORIES_DB", str(_DEFAULT_INSTALL_DIR / "api/data/memories.sqlite3")
    )
    memory_query_timeout: float = _env_float("FT710_MEMORY_QUERY_TIMEOUT", 0.30)

    jog_tick_interval: float = _env_float("FT710_JOG_TICK_INTERVAL", 0.20)
    jog_min_speed_hz_s: float = _env_float("FT710_JOG_MIN_SPEED_HZ_S", 10.0)
    jog_max_speed_hz_s: float = _env_float("FT710_JOG_MAX_SPEED_HZ_S", 100000.0)

    video_enabled: bool = _env_bool("FT710_VIDEO_ENABLED", True)
    video_device: str = os.getenv("FT710_VIDEO_DEVICE", "/dev/video0")
    video_width: int = _env_int("FT710_VIDEO_WIDTH", 800)
    video_height: int = _env_int("FT710_VIDEO_HEIGHT", 480)
    video_input_fps: int = _env_int("FT710_VIDEO_INPUT_FPS", 60)
    video_output_fps: int = _env_int("FT710_VIDEO_OUTPUT_FPS", 8)
    video_jpeg_quality: int = _env_int("FT710_VIDEO_JPEG_QUALITY", 55)
    video_client_max_mbps: float = _env_float("FT710_VIDEO_CLIENT_MAX_MBPS", 3.0)
    gst_launch_binary: str = os.getenv("FT710_GST_LAUNCH_BINARY", "/usr/bin/gst-launch-1.0")

    # Audio is idle until a browser explicitly enables it. These endpoint names
    # are created by scripts/ft710-wsjtx-audio and consumed by both WSJT-X and
    # the browser audio bridge.
    audio_enabled: bool = _env_bool("FT710_AUDIO_ENABLED", True)
    audio_rx_source: str = os.getenv("FT710_AUDIO_RX_SOURCE", "ft710_in_44100")
    audio_tx_sink: str = os.getenv("FT710_AUDIO_TX_SINK", "ft710_out_44100")
    audio_frame_ms: int = _env_int("FT710_AUDIO_FRAME_MS", 20)
    audio_rx_packet_ms: int = _env_int("FT710_AUDIO_RX_PACKET_MS", 40)
    audio_rx_queue_ms: int = _env_int("FT710_AUDIO_RX_QUEUE_MS", 1000)
    audio_latency_ms: int = _env_int("FT710_AUDIO_LATENCY_MS", 100)
    audio_tx_packet_ms: int = _env_int("FT710_AUDIO_TX_PACKET_MS", 20)
    audio_tx_max_queue_ms: int = _env_int("FT710_AUDIO_TX_MAX_QUEUE_MS", 240)
    audio_ptt_tail_ms: int = _env_int("FT710_AUDIO_PTT_TAIL_MS", 80)
    audio_ptt_tail_timeout_ms: int = _env_int("FT710_AUDIO_PTT_TAIL_TIMEOUT_MS", 350)
    audio_tx_idle_silence: bool = _env_bool("FT710_AUDIO_TX_IDLE_SILENCE", True)
    audio_pulse_server: str = os.getenv(
        "FT710_AUDIO_PULSE_SERVER", f"unix:{_DEFAULT_RUNTIME_DIR}/pulse/native"
    )
    audio_xdg_runtime_dir: str = os.getenv(
        "FT710_AUDIO_XDG_RUNTIME_DIR", _DEFAULT_RUNTIME_DIR
    )
    # Set this to the public HTTPS origin. An empty value disables the explicit
    # Origin comparison and is intended only for local setup and diagnostics.
    audio_allowed_origin: str = os.getenv("FT710_AUDIO_ALLOWED_ORIGIN", "").rstrip("/")
    parec_binary: str = os.getenv("FT710_PAREC_BINARY", "/usr/bin/parec")
    paplay_binary: str = os.getenv("FT710_PAPLAY_BINARY", "/usr/bin/paplay")
    ptt_watchdog_seconds: float = _env_float("FT710_PTT_WATCHDOG_SECONDS", 1.5)

    # Dedicated WSJT-X desktop served by TigerVNC + noVNC. TigerVNC listens on
    # localhost without VNC authentication. The noVNC port must be reachable
    # only by the authenticated Apache reverse proxy or a trusted private LAN.
    ft8_enabled: bool = _env_bool("FT710_FT8_ENABLED", True)
    tigervncserver_binary: str = os.getenv(
        "FT710_TIGERVNCSERVER_BINARY", "/usr/bin/tigervncserver"
    )
    websockify_binary: str = os.getenv("FT710_WEBSOCKIFY_BINARY", "/usr/bin/websockify")
    novnc_web_root: str = os.getenv("FT710_NOVNC_WEB_ROOT", "/usr/share/novnc")
    ft8_display: str = os.getenv("FT710_FT8_DISPLAY", ":105")
    ft8_geometry: str = os.getenv("FT710_FT8_GEOMETRY", "1280x800")
    ft8_depth: int = _env_int("FT710_FT8_DEPTH", 24)
    ft8_vnc_host: str = os.getenv("FT710_FT8_VNC_HOST", "127.0.0.1")
    ft8_vnc_port: int = _env_int("FT710_FT8_VNC_PORT", 6005)
    ft8_bind_host: str = os.getenv("FT710_FT8_BIND_HOST", "127.0.0.1")
    ft8_bind_port: int = _env_int("FT710_FT8_BIND_PORT", 10005)
    ft8_url: str = os.getenv(
        "FT710_FT8_URL",
        "/ft8/vnc.html?autoconnect=1&reconnect=1&resize=scale&quality=9&compression=2&path=websockify",
    )
    ft8_xstartup: str = os.getenv(
        "FT710_FT8_XSTARTUP", str(_DEFAULT_HOME / ".config/tigervnc/xstartup")
    )
    ft8_working_directory: str = os.getenv(
        "FT710_FT8_WORKING_DIRECTORY", str(_DEFAULT_INSTALL_DIR)
    )
    ft8_home: str = os.getenv("FT710_FT8_HOME", str(_DEFAULT_HOME))
    ft8_user: str = os.getenv("FT710_FT8_USER", _CURRENT_USER)
    ft8_xdg_runtime_dir: str = os.getenv("FT710_FT8_XDG_RUNTIME_DIR", _DEFAULT_RUNTIME_DIR)
    ft8_pulse_server: str = os.getenv(
        "FT710_FT8_PULSE_SERVER", f"unix:{_DEFAULT_RUNTIME_DIR}/pulse/native"
    )
    ft8_dbus_session_bus_address: str = os.getenv(
        "FT710_FT8_DBUS_SESSION_BUS_ADDRESS", f"unix:path={_DEFAULT_RUNTIME_DIR}/bus"
    )
    ft8_websockify_pidfile: str = os.getenv(
        "FT710_FT8_WEBSOCKIFY_PIDFILE", f"{_DEFAULT_RUNTIME_DIR}/ft710-websockify.pid"
    )
    ft8_websockify_log: str = os.getenv(
        "FT710_FT8_WEBSOCKIFY_LOG", str(_DEFAULT_INSTALL_DIR / "api/data/websockify.log")
    )
    ft8_start_command_timeout: float = _env_float("FT710_FT8_START_COMMAND_TIMEOUT", 20.0)
    ft8_startup_timeout: float = _env_float("FT710_FT8_STARTUP_TIMEOUT", 20.0)
    ft8_stop_timeout: float = _env_float("FT710_FT8_STOP_TIMEOUT", 20.0)
    ft8_shutdown_timeout: float = _env_float("FT710_FT8_SHUTDOWN_TIMEOUT", 12.0)

    allow_raw_cat: bool = _env_bool("FT710_ALLOW_RAW_CAT", False)
    cors_origins: tuple[str, ...] = tuple(
        origin.strip()
        for origin in os.getenv("FT710_CORS_ORIGINS", "").split(",")
        if origin.strip()
    )


settings = Settings()
