from __future__ import annotations

import logging
import subprocess
import threading
import time
from collections import deque
from collections.abc import Iterator

from .config import Settings

LOGGER = logging.getLogger(__name__)

JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"
MJPEG_BOUNDARY = b"frame"
MAX_JPEG_BYTES = 8 * 1024 * 1024
VIDEO_FPS_MIN = 1
VIDEO_FPS_MAX = 30
JPEG_QUALITY_MIN = 20
JPEG_QUALITY_MAX = 95


class VideoRelay:
    """Capture the display and broadcast only the newest complete JPEG frame.

    GStreamer writes a concatenated JPEG stream to stdout.  A background reader
    extracts complete JPEG images and stores exactly one frame in memory.  Each
    HTTP client independently waits for the next frame ID.  If a client is slow,
    it skips old frames instead of building an ever-growing TCP/HTTP queue.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._stop = threading.Event()
        self._process_lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._supervisor: threading.Thread | None = None

        self._frame_condition = threading.Condition()
        self._latest_frame: bytes | None = None
        self._frame_id = 0
        self._last_frame_monotonic: float | None = None
        self._frame_history: deque[tuple[float, int]] = deque(maxlen=240)
        self._active_clients = 0

        # Runtime video parameters can be changed from the web interface.
        # They are intentionally independent from the frozen environment settings.
        self._config_lock = threading.Lock()
        self._output_fps = max(
            VIDEO_FPS_MIN,
            min(VIDEO_FPS_MAX, int(settings.video_output_fps)),
        )
        self._jpeg_quality = max(
            JPEG_QUALITY_MIN,
            min(JPEG_QUALITY_MAX, int(settings.video_jpeg_quality)),
        )
        self._config_revision = 0

    def current_settings(self) -> dict[str, int]:
        with self._config_lock:
            return {
                "fps": self._output_fps,
                "jpeg_quality": self._jpeg_quality,
            }

    def reconfigure(
        self,
        *,
        fps: int | None = None,
        jpeg_quality: int | None = None,
    ) -> dict[str, int | bool]:
        """Update encoder settings and restart only the GStreamer subprocess."""
        if fps is not None and not VIDEO_FPS_MIN <= int(fps) <= VIDEO_FPS_MAX:
            raise ValueError(f"fps must be between {VIDEO_FPS_MIN} and {VIDEO_FPS_MAX}")
        if (
            jpeg_quality is not None
            and not JPEG_QUALITY_MIN <= int(jpeg_quality) <= JPEG_QUALITY_MAX
        ):
            raise ValueError(
                f"jpeg_quality must be between {JPEG_QUALITY_MIN} and {JPEG_QUALITY_MAX}"
            )

        changed = False
        with self._config_lock:
            if fps is not None and fps != self._output_fps:
                self._output_fps = int(fps)
                changed = True
            if jpeg_quality is not None and jpeg_quality != self._jpeg_quality:
                self._jpeg_quality = int(jpeg_quality)
                changed = True
            if changed:
                self._config_revision += 1
            values = {
                "fps": self._output_fps,
                "jpeg_quality": self._jpeg_quality,
                "restarted": changed,
            }

        if changed:
            LOGGER.info(
                "Reconfiguring video: %s fps, JPEG quality %s",
                values["fps"],
                values["jpeg_quality"],
            )
            with self._process_lock:
                proc = self._process
            if proc is not None and proc.poll() is None:
                proc.terminate()

        return values

    def build_command(self) -> tuple[list[str], int]:
        s = self.settings
        with self._config_lock:
            output_fps = self._output_fps
            jpeg_quality = self._jpeg_quality
            revision = self._config_revision
        command = [
            s.gst_launch_binary,
            "-q",
            "v4l2src",
            f"device={s.video_device}",
            "do-timestamp=true",
            "!",
            f"video/x-raw,format=UYVY,width={s.video_width},height={s.video_height},framerate={s.video_input_fps}/1",
            "!",
            "queue",
            "leaky=downstream",
            "max-size-buffers=1",
            "max-size-bytes=0",
            "max-size-time=0",
            "!",
            "videoconvert",
            "!",
            "videorate",
            "drop-only=true",
            "!",
            f"video/x-raw,format=I420,width={s.video_width},height={s.video_height},framerate={output_fps}/1",
            "!",
            "queue",
            "leaky=downstream",
            "max-size-buffers=1",
            "max-size-bytes=0",
            "max-size-time=0",
            "!",
            "jpegenc",
            f"quality={jpeg_quality}",
            "!",
            "fdsink",
            "fd=1",
            "sync=false",
        ]
        return command, revision

    def start(self) -> None:
        if not self.settings.video_enabled:
            LOGGER.info("Video relay disabled")
            return
        if self._supervisor and self._supervisor.is_alive():
            return
        self._stop.clear()
        self._supervisor = threading.Thread(
            target=self._supervise,
            name="ft710-video-supervisor",
            daemon=True,
        )
        self._supervisor.start()

    def stop(self) -> None:
        self._stop.set()
        with self._frame_condition:
            self._frame_condition.notify_all()

        with self._process_lock:
            proc = self._process
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                proc.kill()

        if self._supervisor:
            self._supervisor.join(timeout=4.0)

    def is_running(self) -> bool:
        with self._process_lock:
            return self._process is not None and self._process.poll() is None

    def frame_age_seconds(self) -> float | None:
        with self._frame_condition:
            if self._last_frame_monotonic is None:
                return None
            return max(0.0, time.monotonic() - self._last_frame_monotonic)

    def statistics(self) -> dict[str, float | int | None]:
        """Return lightweight capture and estimated network statistics."""
        with self._frame_condition:
            now = time.monotonic()
            recent = [(ts, size) for ts, size in self._frame_history if now - ts <= 5.0]
            frame_age = (
                None
                if self._last_frame_monotonic is None
                else max(0.0, now - self._last_frame_monotonic)
            )
            latest_size = len(self._latest_frame) if self._latest_frame is not None else None
            active_clients = self._active_clients

        if len(recent) >= 2:
            duration = max(0.001, recent[-1][0] - recent[0][0])
            capture_fps = (len(recent) - 1) / duration
            capture_mbps = (sum(size for _, size in recent[1:]) * 8.0) / duration / 1_000_000.0
        else:
            capture_fps = 0.0
            capture_mbps = 0.0

        per_client_cap = max(0.0, self.settings.video_client_max_mbps)
        estimated_per_client = min(capture_mbps, per_client_cap) if per_client_cap else capture_mbps
        runtime = self.current_settings()
        return {
            "configured_fps": runtime["fps"],
            "jpeg_quality": runtime["jpeg_quality"],
            "active_clients": active_clients,
            "latest_frame_bytes": latest_size,
            "frame_age_s": frame_age,
            "capture_fps": round(capture_fps, 2),
            "capture_mbps": round(capture_mbps, 3),
            "client_max_mbps": per_client_cap,
            "estimated_egress_mbps": round(estimated_per_client * active_clients, 3),
        }

    def _supervise(self) -> None:
        while not self._stop.is_set():
            command, process_revision = self.build_command()
            runtime = self.current_settings()
            LOGGER.info(
                "Starting GStreamer latest-frame capture at %s fps, JPEG quality %s",
                runtime["fps"],
                runtime["jpeg_quality"],
            )
            try:
                proc = subprocess.Popen(
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
            except FileNotFoundError:
                LOGGER.exception("gst-launch-1.0 not found: %s", self.settings.gst_launch_binary)
                self._stop.wait(5.0)
                continue

            with self._process_lock:
                self._process = proc

            # If a setting changed between command construction and process start,
            # stop this stale process immediately; the supervisor will launch the
            # newest configuration on the next iteration.
            with self._config_lock:
                stale_configuration = process_revision != self._config_revision
            if stale_configuration and proc.poll() is None:
                proc.terminate()

            stderr_thread = threading.Thread(
                target=self._drain_stderr,
                args=(proc,),
                name="ft710-gstreamer-stderr",
                daemon=True,
            )
            stderr_thread.start()

            try:
                self._read_jpeg_stream(proc)
            except Exception:
                if not self._stop.is_set():
                    LOGGER.exception("Video frame reader failed")

            return_code = proc.wait()
            stderr_thread.join(timeout=1.0)
            with self._process_lock:
                self._process = None

            if not self._stop.is_set():
                with self._config_lock:
                    configuration_changed = process_revision != self._config_revision
                if configuration_changed:
                    LOGGER.info("GStreamer stopped for video reconfiguration")
                    self._stop.wait(0.15)
                else:
                    LOGGER.warning("GStreamer exited with code %s; restarting", return_code)
                    self._stop.wait(2.0)

    def _drain_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stderr is not None
        for raw_line in iter(proc.stderr.readline, b""):
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line:
                LOGGER.warning("GStreamer: %s", line)
            if self._stop.is_set():
                return

    def _read_jpeg_stream(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stdout is not None
        pending = bytearray()

        while not self._stop.is_set():
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                return
            pending.extend(chunk)

            while True:
                start = pending.find(JPEG_SOI)
                if start < 0:
                    # Keep a possible first byte of the SOI marker across reads.
                    if pending[-1:] == b"\xff":
                        pending[:] = b"\xff"
                    else:
                        pending.clear()
                    break

                if start:
                    del pending[:start]

                end = pending.find(JPEG_EOI, len(JPEG_SOI))
                if end < 0:
                    if len(pending) > MAX_JPEG_BYTES:
                        LOGGER.warning("Discarding oversized/incomplete JPEG frame")
                        del pending[:2]
                    break

                frame_end = end + len(JPEG_EOI)
                frame = bytes(pending[:frame_end])
                del pending[:frame_end]
                self._publish_frame(frame)

    def _publish_frame(self, frame: bytes) -> None:
        with self._frame_condition:
            now = time.monotonic()
            self._latest_frame = frame
            self._frame_id += 1
            self._last_frame_monotonic = now
            self._frame_history.append((now, len(frame)))
            self._frame_condition.notify_all()

    def stream_mjpeg(self) -> Iterator[bytes]:
        """Yield newest-frame MJPEG parts with an optional per-client bitrate cap."""
        last_sent_id = -1
        rate_bytes_s = max(0.0, self.settings.video_client_max_mbps) * 1_000_000.0 / 8.0
        tokens = rate_bytes_s
        token_time = time.monotonic()

        with self._frame_condition:
            self._active_clients += 1

        try:
            while not self._stop.is_set():
                with self._frame_condition:
                    self._frame_condition.wait_for(
                        lambda: self._stop.is_set() or self._frame_id != last_sent_id,
                        timeout=5.0,
                    )
                    if self._stop.is_set():
                        return

                    frame = self._latest_frame
                    frame_id = self._frame_id

                if frame is None or frame_id == last_sent_id:
                    continue

                # Mark this source frame as considered even when it is skipped, so a
                # slow client always advances to the newest image rather than building
                # a backlog.
                last_sent_id = frame_id
                part = (
                    b"--" + MJPEG_BOUNDARY + b"\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode("ascii") + b"\r\n"
                    b"Cache-Control: no-cache\r\n\r\n"
                    + frame
                    + b"\r\n"
                )

                if rate_bytes_s > 0:
                    now = time.monotonic()
                    capacity = max(rate_bytes_s, float(len(part)))
                    tokens = min(capacity, tokens + (now - token_time) * rate_bytes_s)
                    token_time = now
                    if len(part) > tokens:
                        continue
                    tokens -= len(part)

                yield part
        finally:
            with self._frame_condition:
                self._active_clients = max(0, self._active_clients - 1)

