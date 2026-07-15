from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

LOGGER = logging.getLogger(__name__)

AudioControlHandler = Callable[[dict[str, Any]], Awaitable[None]]
DisconnectHandler = Callable[[], Awaitable[None]]


class AudioBridgeError(RuntimeError):
    pass


class AudioBridge:
    """Bidirectional low-latency PCM bridge over a secure WebSocket.

    The browser and Raspberry exchange ordered 16-bit mono PCM packets. TX
    packets are written to ``paplay`` as soon as they arrive; PulseAudio /
    PipeWire is the only timing buffer. This intentionally avoids the extra
    Python pacing and large jitter buffer used in 1.7.2, which could cause
    repeated rebuffering and audible speech gaps.
    """

    def __init__(self, settings: Any):
        self.settings = settings
        self._session_lock = asyncio.Lock()
        self._active = False
        self._tx_enabled = False
        self._tx_accepting = False
        self._tx_drained = asyncio.Event()
        self._tx_drained.set()
        self._tx_queue: asyncio.Queue[bytes] | None = None
        self._rx_queue: asyncio.Queue[bytes] | None = None
        self._sample_rate: int | None = None
        self._started_at: float | None = None
        self._rx_bytes = 0
        self._tx_bytes = 0
        self._dropped_rx_frames = 0
        self._dropped_tx_frames = 0
        self._tx_peak_queue_packets = 0
        self._rx_peak_queue_packets = 0
        self._last_error: str | None = None
        self._capture_process: asyncio.subprocess.Process | None = None
        self._playback_process: asyncio.subprocess.Process | None = None

    def is_active(self) -> bool:
        return self._active

    def start_tx(self) -> None:
        if not self._active:
            raise AudioBridgeError("Audio bridge is not active")
        self._discard_tx_queue()
        self._tx_enabled = True
        self._tx_accepting = True
        self._tx_drained.clear()

    async def finish_tx(self) -> None:
        """Stop accepting PCM, flush queued packets, then release the tail.

        WebSocket messages are ordered, therefore all microphone packets sent
        before the PTT-OFF message are already queued when this method starts.
        Only a very short tail is retained for the PulseAudio buffer; there is
        no large application-level jitter buffer.
        """
        if not self._tx_enabled:
            self.abort_tx()
            return

        self._tx_accepting = False
        if self._tx_queue is None or self._tx_queue.empty():
            self._tx_drained.set()
        timeout = max(0.10, float(self.settings.audio_ptt_tail_timeout_ms) / 1000.0)
        try:
            await asyncio.wait_for(self._tx_drained.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            LOGGER.warning("TX queue did not drain within %.0f ms", timeout * 1000)

        tail = max(0.0, float(self.settings.audio_ptt_tail_ms) / 1000.0)
        if tail:
            await asyncio.sleep(tail)
        self.abort_tx()

    def abort_tx(self) -> None:
        self._tx_accepting = False
        self._tx_enabled = False
        self._discard_tx_queue()
        self._tx_drained.set()

    def set_tx_enabled(self, enabled: bool) -> None:
        if enabled:
            self.start_tx()
        else:
            self.abort_tx()

    def statistics(self) -> dict[str, Any]:
        now = time.monotonic()
        elapsed = 0.0 if self._started_at is None else max(0.0, now - self._started_at)
        queue_packets = self._tx_queue.qsize() if self._tx_queue is not None else 0
        rx_queue_packets = self._rx_queue.qsize() if self._rx_queue is not None else 0
        return {
            "enabled": bool(self.settings.audio_enabled),
            "active": self._active,
            "sample_rate": self._sample_rate,
            "rx_source": self.settings.audio_rx_source,
            "tx_sink": self.settings.audio_tx_sink,
            "frame_ms": self.settings.audio_frame_ms,
            "rx_packet_ms": self.settings.audio_rx_packet_ms,
            "rx_queue_ms": self.settings.audio_rx_queue_ms,
            "tx_packet_ms": self.settings.audio_tx_packet_ms,
            "latency_ms": self.settings.audio_latency_ms,
            "tx_max_queue_ms": self.settings.audio_tx_max_queue_ms,
            "connected_seconds": round(elapsed, 1),
            "radio_to_browser_bytes": self._rx_bytes,
            "browser_to_radio_bytes": self._tx_bytes,
            "dropped_radio_frames": self._dropped_rx_frames,
            "rx_queue_packets": rx_queue_packets,
            "rx_peak_queue_packets": self._rx_peak_queue_packets,
            "dropped_microphone_frames": self._dropped_tx_frames,
            "tx_queue_packets": queue_packets,
            "tx_peak_queue_packets": self._tx_peak_queue_packets,
            "tx_audio_enabled": self._tx_enabled,
            "tx_accepting": self._tx_accepting,
            "last_error": self._last_error,
        }

    async def shutdown(self) -> None:
        self.abort_tx()
        await self._stop_processes()
        self._active = False

    async def serve(
        self,
        websocket: WebSocket,
        sample_rate: int,
        control_handler: AudioControlHandler,
        disconnect_handler: DisconnectHandler,
    ) -> None:
        if not self.settings.audio_enabled:
            await websocket.accept()
            await websocket.send_json({"type": "error", "message": "Audio is disabled on the server"})
            await websocket.close(code=4403)
            return

        sample_rate = int(sample_rate)
        if sample_rate < 8_000 or sample_rate > 96_000:
            await websocket.accept()
            await websocket.send_json({"type": "error", "message": "Unsupported browser sample rate"})
            await websocket.close(code=4400)
            return

        async with self._session_lock:
            if self._active:
                await websocket.accept()
                await websocket.send_json({"type": "error", "message": "Audio is already in use by another browser"})
                await websocket.close(code=4409)
                return
            self._active = True
            self._sample_rate = sample_rate
            self._started_at = time.monotonic()
            self._rx_bytes = 0
            self._tx_bytes = 0
            self._dropped_rx_frames = 0
            self._dropped_tx_frames = 0
            self._tx_peak_queue_packets = 0
            self._rx_peak_queue_packets = 0
            self._last_error = None
            self.abort_tx()

        await websocket.accept()
        LOGGER.info(
            "Opening browser audio bridge: source=%s sink=%s rate=%s latency=%sms",
            self.settings.audio_rx_source,
            self.settings.audio_tx_sink,
            sample_rate,
            self.settings.audio_latency_ms,
        )

        try:
            await self._start_processes(sample_rate)
            await websocket.send_json(
                {
                    "type": "ready",
                    "sample_rate": sample_rate,
                    "format": "s16le",
                    "channels": 1,
                    "frame_ms": self.settings.audio_frame_ms,
                    "rx_packet_ms": self.settings.audio_rx_packet_ms,
                    "rx_queue_ms": self.settings.audio_rx_queue_ms,
                    "tx_packet_ms": self.settings.audio_tx_packet_ms,
                    "latency_ms": self.settings.audio_latency_ms,
                }
            )
            await self._run_session(websocket, sample_rate, control_handler)
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._last_error = str(exc)
            LOGGER.exception("Audio bridge failed")
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except Exception:
                pass
        finally:
            try:
                await disconnect_handler()
            except Exception:
                LOGGER.exception("Could not release PTT after audio disconnect")
            self.abort_tx()
            await self._stop_processes()
            try:
                await websocket.close()
            except Exception:
                pass
            async with self._session_lock:
                self._active = False
                self._sample_rate = None
                self._started_at = None
            LOGGER.info("Browser audio bridge closed")

    def _subprocess_environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        if self.settings.audio_pulse_server:
            environment["PULSE_SERVER"] = self.settings.audio_pulse_server
        if self.settings.audio_xdg_runtime_dir:
            environment["XDG_RUNTIME_DIR"] = self.settings.audio_xdg_runtime_dir
        return environment

    async def _start_processes(self, sample_rate: int) -> None:
        frame_ms = int(self.settings.audio_frame_ms)
        latency_ms = int(self.settings.audio_latency_ms)
        common = [
            "--raw",
            "--format=s16le",
            f"--rate={sample_rate}",
            "--channels=1",
            "--channel-map=mono",
            f"--latency-msec={latency_ms}",
            f"--process-time-msec={frame_ms}",
        ]
        environment = self._subprocess_environment()

        try:
            self._capture_process = await asyncio.create_subprocess_exec(
                self.settings.parec_binary,
                f"--device={self.settings.audio_rx_source}",
                "--client-name=ft710-web-rx",
                "--stream-name=FT-710 browser receive audio",
                *common,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
                start_new_session=True,
            )
            self._playback_process = await asyncio.create_subprocess_exec(
                self.settings.paplay_binary,
                f"--device={self.settings.audio_tx_sink}",
                "--client-name=ft710-web-tx",
                "--stream-name=FT-710 browser microphone",
                *common,
                stdin=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            await self._stop_processes()
            raise AudioBridgeError(f"Audio helper not found: {exc.filename}") from exc
        except OSError as exc:
            await self._stop_processes()
            raise AudioBridgeError(f"Could not start audio helpers: {exc}") from exc

        await asyncio.sleep(0.18)
        for label, process in (("capture", self._capture_process), ("playback", self._playback_process)):
            if process is not None and process.returncode is not None:
                error = await self._read_stderr(process)
                await self._stop_processes()
                raise AudioBridgeError(f"Audio {label} process exited: {error or process.returncode}")

    async def _run_session(
        self,
        websocket: WebSocket,
        sample_rate: int,
        control_handler: AudioControlHandler,
    ) -> None:
        capture = self._capture_process
        playback = self._playback_process
        if capture is None or capture.stdout is None:
            raise AudioBridgeError("Audio capture process is unavailable")
        if playback is None or playback.stdin is None:
            raise AudioBridgeError("Audio playback process is unavailable")

        frame_bytes = max(320, int(sample_rate * 2 * self.settings.audio_rx_packet_ms / 1000))
        frame_bytes -= frame_bytes % 2
        rx_max_packets = max(4, int(self.settings.audio_rx_queue_ms / max(1, self.settings.audio_rx_packet_ms)))
        rx_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=rx_max_packets)
        self._rx_queue = rx_queue
        max_packets = max(
            4,
            int(self.settings.audio_tx_max_queue_ms / max(1, self.settings.audio_tx_packet_ms)),
        )
        tx_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=max_packets)
        self._tx_queue = tx_queue

        tasks = {
            asyncio.create_task(self._capture_reader(capture, rx_queue, frame_bytes), name="audio-capture-reader"),
            asyncio.create_task(self._browser_sender(websocket, rx_queue), name="audio-browser-sender"),
            asyncio.create_task(self._browser_receiver(websocket, tx_queue, control_handler), name="audio-browser-receiver"),
            asyncio.create_task(self._playback_writer(playback, tx_queue), name="audio-playback-writer"),
            asyncio.create_task(self._watch_helpers(), name="audio-helper-watch"),
        }
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                exception = task.exception()
                if exception is not None:
                    raise exception
        finally:
            self._tx_queue = None
            self._rx_queue = None

    async def _capture_reader(
        self,
        process: asyncio.subprocess.Process,
        queue: asyncio.Queue[bytes],
        frame_bytes: int,
    ) -> None:
        assert process.stdout is not None
        while True:
            try:
                data = await process.stdout.readexactly(frame_bytes)
            except asyncio.IncompleteReadError as exc:
                data = exc.partial
                if not data:
                    error = await self._read_stderr(process)
                    raise AudioBridgeError(f"Radio audio capture stopped: {error or process.returncode}")
            if len(data) % 2:
                data = data[:-1]
            if not data:
                continue
            self._rx_bytes += len(data)
            self._put_ordered_rx(queue, data)

    async def _browser_sender(self, websocket: WebSocket, queue: asyncio.Queue[bytes]) -> None:
        while True:
            data = await queue.get()
            try:
                await websocket.send_bytes(data)
            finally:
                queue.task_done()

    async def _browser_receiver(
        self,
        websocket: WebSocket,
        queue: asyncio.Queue[bytes],
        control_handler: AudioControlHandler,
    ) -> None:
        while True:
            message = await websocket.receive()
            message_type = message.get("type")
            if message_type == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            data = message.get("bytes")
            if data is not None:
                if len(data) % 2:
                    data = data[:-1]
                if data and self._tx_accepting:
                    self._tx_bytes += len(data)
                    self._put_ordered_tx(queue, data)
                elif data:
                    self._dropped_tx_frames += 1
                continue

            text = message.get("text")
            if text is None:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "warning", "message": "Invalid audio control message"})
                continue
            await control_handler(payload)

    async def _playback_writer(
        self,
        process: asyncio.subprocess.Process,
        queue: asyncio.Queue[bytes],
    ) -> None:
        assert process.stdin is not None
        while True:
            data = await queue.get()
            try:
                process.stdin.write(data)
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                error = await self._read_stderr(process)
                raise AudioBridgeError(f"Radio audio playback stopped: {error or exc}") from exc
            finally:
                queue.task_done()

            if not self._tx_accepting and queue.empty():
                self._tx_drained.set()

    async def _watch_helpers(self) -> None:
        capture = self._capture_process
        playback = self._playback_process
        if capture is None or playback is None:
            return
        capture_wait = asyncio.create_task(capture.wait())
        playback_wait = asyncio.create_task(playback.wait())
        done, pending = await asyncio.wait({capture_wait, playback_wait}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        finished = "capture" if capture_wait in done else "playback"
        process = capture if finished == "capture" else playback
        error = await self._read_stderr(process)
        raise AudioBridgeError(f"Audio {finished} helper exited: {error or process.returncode}")

    def _put_ordered_rx(self, queue: asyncio.Queue[bytes], data: bytes) -> None:
        # RX is low bandwidth. Preserve packet order and allow the browser's
        # adaptive buffer to absorb network bursts. Only discard the oldest
        # packet if an entire second of audio has accumulated.
        if queue.full():
            try:
                queue.get_nowait()
                queue.task_done()
            except asyncio.QueueEmpty:
                pass
            self._dropped_rx_frames += 1
        try:
            queue.put_nowait(data)
            self._rx_peak_queue_packets = max(self._rx_peak_queue_packets, queue.qsize())
        except asyncio.QueueFull:
            self._dropped_rx_frames += 1

    def _put_ordered_tx(self, queue: asyncio.Queue[bytes], data: bytes) -> None:
        # Keep speech ordered and low-latency. If the bounded queue fills, drop
        # the oldest packet rather than transmitting stale speech later.
        if queue.full():
            try:
                queue.get_nowait()
                queue.task_done()
            except asyncio.QueueEmpty:
                pass
            self._dropped_tx_frames += 1
        try:
            queue.put_nowait(data)
            self._tx_peak_queue_packets = max(self._tx_peak_queue_packets, queue.qsize())
        except asyncio.QueueFull:
            self._dropped_tx_frames += 1

    def _discard_tx_queue(self) -> None:
        if self._tx_queue is not None:
            self._discard_queue(self._tx_queue)

    @staticmethod
    def _discard_queue(queue: asyncio.Queue[bytes]) -> None:
        while True:
            try:
                queue.get_nowait()
                queue.task_done()
            except asyncio.QueueEmpty:
                break

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> str:
        if process.stderr is None:
            return ""
        try:
            data = await asyncio.wait_for(process.stderr.read(), timeout=0.15)
        except (asyncio.TimeoutError, RuntimeError):
            return ""
        return data.decode("utf-8", errors="replace").strip()

    async def _stop_processes(self) -> None:
        processes = [self._capture_process, self._playback_process]
        self._capture_process = None
        self._playback_process = None

        for process in processes:
            if process is None:
                continue
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except Exception:
                    pass
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    process.terminate()

        for process in processes:
            if process is None or process.returncode is not None:
                continue
            try:
                await asyncio.wait_for(process.wait(), timeout=1.5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    process.kill()
                try:
                    await asyncio.wait_for(process.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
