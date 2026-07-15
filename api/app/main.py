from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .audio import AudioBridge
from .config import settings
from .direct_cat import (
    ATTENUATOR_DB_TO_CODE,
    METER_NAME_TO_CODE,
    MODE_NAME_TO_CODE,
    PREAMP_NAME_TO_CODE,
    SCOPE_MODE_NAME_TO_CODE,
    SCOPE_SPAN_NAME_TO_CODE,
    SCOPE_SPEED_NAME_TO_CODE,
    SerialCatError,
    YaesuCatClient,
)
from .ft8 import FT8ManagerError, FT8NoVNCManager
from .memories import MemoryRepository
from .state import FrequencyJogger, RadioPoller, StateStore
from .video import VideoRelay

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
LOGGER = logging.getLogger(__name__)

cat = YaesuCatClient(
    device=settings.cat2_device,
    baudrate=settings.cat2_baud,
    query_timeout=settings.cat2_query_timeout,
    write_timeout=settings.cat2_write_timeout,
)
store = StateStore(settings.cat2_device)
poller = RadioPoller(
    client=cat,
    store=store,
    poll_interval=settings.poll_interval,
    settings_poll_interval=settings.settings_poll_interval,
)
jogger = FrequencyJogger(
    client=cat,
    store=store,
    poller=poller,
    tick_interval=settings.jog_tick_interval,
    min_speed_hz_s=settings.jog_min_speed_hz_s,
    max_speed_hz_s=settings.jog_max_speed_hz_s,
)
video = VideoRelay(settings)
audio = AudioBridge(settings)
ft8 = FT8NoVNCManager(settings)
memories = MemoryRepository(settings.memories_db)


@asynccontextmanager
async def lifespan(_: FastAPI):
    memories.initialize()
    poller.start()
    jogger.start()
    video.start()
    watchdog_task = asyncio.create_task(_ptt_watchdog(), name="ft710-ptt-watchdog")
    try:
        yield
    finally:
        await _stop_cw("API shutdown", ignore_errors=True)
        await _force_ptt_release("API shutdown")
        watchdog_task.cancel()
        await asyncio.gather(watchdog_task, return_exceptions=True)
        await audio.shutdown()
        video.stop()
        jogger.stop()
        poller.stop()
        cat.close()


app = FastAPI(
    title="FreeRig710 API",
    version="1.14.0",
    root_path=settings.root_path,
    lifespan=lifespan,
)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Authorization"],
    )


class FrequencyRequest(BaseModel):
    frequency_hz: int = Field(ge=30_000, le=75_000_000)
    vfo: Literal["ACTIVE", "A", "B"] = "ACTIVE"


class ModeRequest(BaseModel):
    mode: Literal[
        "LSB", "USB", "CW-U", "FM", "AM", "RTTY-L", "CW-L", "DATA-L",
        "RTTY-U", "DATA-FM", "FM-N", "DATA-U", "AM-N", "PSK", "DATA-FM-N",
    ]
    vfo: Literal["ACTIVE", "A", "B"] = "ACTIVE"


class TxPowerRequest(BaseModel):
    watts: int = Field(ge=5, le=100)


class RfGainRequest(BaseModel):
    value: int = Field(ge=0, le=255)


class TunerRequest(BaseModel):
    action: Literal["enable", "disable", "tune"]


class VfoSelectRequest(BaseModel):
    vfo: Literal["A", "B"]


class VfoOperationRequest(BaseModel):
    action: Literal["swap", "copy_a_to_b", "copy_b_to_a"]


class PreampRequest(BaseModel):
    value: Literal["IPO", "AMP1", "AMP2"]


class AttenuatorRequest(BaseModel):
    db: Literal[0, 6, 12, 18]


class DnrRequest(BaseModel):
    enabled: bool | None = None
    level: int | None = Field(default=None, ge=1, le=15)


class NoiseBlankerRequest(BaseModel):
    enabled: bool | None = None
    level: int | None = Field(default=None, ge=0, le=10)


class AutoNotchRequest(BaseModel):
    enabled: bool


class MeterDisplayRequest(BaseModel):
    value: Literal["PO", "COMP", "ALC", "VDD", "ID", "SWR"]


class ScopeRequest(BaseModel):
    mode: str | None = None
    speed: str | None = None
    span: str | None = None


class JogRequest(BaseModel):
    position: float = Field(ge=-1.0, le=1.0)


class RawCatRequest(BaseModel):
    command: str = Field(min_length=1, max_length=128)
    expect_reply: bool = False


class VideoSettingsRequest(BaseModel):
    fps: int | None = Field(default=None, ge=1, le=30)
    jpeg_quality: int | None = Field(default=None, ge=20, le=95)


class RadioPowerRequest(BaseModel):
    enabled: bool


class FT8Request(BaseModel):
    enabled: bool


class CWSendRequest(BaseModel):
    message: str = Field(min_length=1, max_length=50)
    wpm: int = Field(default=25, ge=4, le=60)
    memory_slot: Literal[1, 2, 3, 4, 5] = 5


class MemorySaveRequest(BaseModel):
    slot: int | None = Field(default=None, ge=1, le=99)
    name: str = Field(default="", max_length=12)
    category: str = Field(default="", max_length=24)
    note: str = Field(default="", max_length=240)
    overwrite: bool = False


class MemoryEditRequest(BaseModel):
    frequency_hz: int | None = Field(default=None, ge=30_000, le=75_000_000)
    mode: str | None = None
    name: str | None = Field(default=None, max_length=12)
    category: str | None = Field(default=None, max_length=24)
    note: str | None = Field(default=None, max_length=240)


class MemoryRecallRequest(BaseModel):
    action: Literal["memory", "vfo_a", "vfo_b"] = "memory"


class MemoryMetadataRequest(BaseModel):
    category: str | None = Field(default=None, max_length=24)
    note: str | None = Field(default=None, max_length=240)


_interactive_cat_lock = asyncio.Lock()


def _snapshot() -> dict:
    _, value = store.snapshot()
    return value


def _active_vfo_from_state() -> str:
    value = _snapshot().get("active_vfo")
    return value if value in {"A", "B"} else "A"


async def run_cat_call(callable_, *args, stop_jog: bool = True):
    if stop_jog:
        jogger.set_position(0.0)
    poller.begin_interactive()
    try:
        async with _interactive_cat_lock:
            return await asyncio.to_thread(callable_, *args)
    except SerialCatError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    finally:
        poller.end_interactive()


CW_MORSE = {
    "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".",
    "F": "..-.", "G": "--.", "H": "....", "I": "..", "J": ".---",
    "K": "-.-", "L": ".-..", "M": "--", "N": "-.", "O": "---",
    "P": ".--.", "Q": "--.-", "R": ".-.", "S": "...", "T": "-",
    "U": "..-", "V": "...-", "W": ".--", "X": "-..-", "Y": "-.--",
    "Z": "--..", "0": "-----", "1": ".----", "2": "..---", "3": "...--",
    "4": "....-", "5": ".....", "6": "-....", "7": "--...", "8": "---..",
    "9": "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..",
    "/": "-..-.", "=": "-...-", "+": ".-.-.", "-": "-....-",
    "@": ".--.-.", "(": "-.--.", ")": "-.--.-",
}
CW_ALLOWED_CHARACTERS = frozenset(CW_MORSE) | {" "}

_cw_state_lock = asyncio.Lock()
_cw_sending = False
_cw_message = ""
_cw_wpm = 25
_cw_memory_slot = 5
_cw_started_at = 0.0
_cw_expected_end = 0.0
_cw_generation = 0
_cw_finish_task: asyncio.Task | None = None


def _normalize_cw_message(value: str) -> str:
    message = " ".join(value.upper().split())
    if not message:
        raise HTTPException(status_code=422, detail="CW message is empty")
    if len(message) > 50:
        raise HTTPException(status_code=422, detail="CW message is limited to 50 characters")
    unsupported = sorted({character for character in message if character not in CW_ALLOWED_CHARACTERS})
    if unsupported:
        rendered = " ".join(repr(character) for character in unsupported)
        raise HTTPException(status_code=422, detail=f"Unsupported CW character(s): {rendered}")
    return message


def _estimate_cw_seconds(message: str, wpm: int) -> float:
    units = 0
    words = message.split(" ")
    for word_index, word in enumerate(words):
        for char_index, character in enumerate(word):
            pattern = CW_MORSE[character]
            units += sum(1 if symbol == "." else 3 for symbol in pattern)
            units += max(0, len(pattern) - 1)
            if char_index < len(word) - 1:
                units += 3
        if word_index < len(words) - 1:
            units += 7
    return max(0.4, units * 1.2 / max(4, int(wpm)))


def _cw_status() -> dict:
    now = time.monotonic()
    return {
        "sending": _cw_sending,
        "message": _cw_message,
        "wpm": _cw_wpm,
        "memory_slot": _cw_memory_slot,
        "estimated_remaining_s": round(max(0.0, _cw_expected_end - now), 1) if _cw_sending else 0.0,
    }


async def _cw_finish_after(generation: int, delay: float) -> None:
    global _cw_sending
    try:
        await asyncio.sleep(max(0.1, delay))
        async with _cw_state_lock:
            if generation == _cw_generation:
                _cw_sending = False
    except asyncio.CancelledError:
        raise


async def _stop_cw(reason: str, *, ignore_errors: bool = False) -> None:
    global _cw_sending, _cw_expected_end, _cw_generation, _cw_finish_task
    async with _cw_state_lock:
        was_sending = _cw_sending
        _cw_generation += 1
        task = _cw_finish_task
        _cw_finish_task = None
        _cw_sending = False
        _cw_expected_end = 0.0
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    if was_sending:
        try:
            await run_cat_call(cat.stop_cw, stop_jog=False)
            LOGGER.info("CW transmission stopped: %s", reason)
        except Exception:
            if not ignore_errors:
                raise
            LOGGER.exception("Could not stop CW transmission during %s", reason)


_ptt_state_lock = asyncio.Lock()
_ptt_active = False
_ptt_deadline = 0.0


async def _set_ptt(enabled: bool, *, drain_audio: bool = True) -> None:
    global _ptt_active, _ptt_deadline
    async with _ptt_state_lock:
        if enabled:
            if _cw_sending:
                raise RuntimeError("Stop the CW transmission before using voice PTT")
            if not audio.is_active():
                raise RuntimeError("Audio must be active before PTT can be keyed")
            if not _ptt_active:
                # Key CAT first. Only after TX1 succeeds do we accept browser microphone frames.
                await run_cat_call(cat.set_ptt, True, stop_jog=False)
                _ptt_active = True
                audio.start_tx()
                store.update(tx_state="TX")
            _ptt_deadline = time.monotonic() + settings.ptt_watchdog_seconds
        else:
            _ptt_deadline = 0.0
            if _ptt_active:
                # A normal toggle back to RX flushes the small ordered TX queue and
                # keeps only the configured PulseAudio tail. Safety releases
                # caused by disconnects/watchdog abort immediately.
                if drain_audio:
                    await audio.finish_tx()
                else:
                    audio.abort_tx()
                await run_cat_call(cat.set_ptt, False, stop_jog=False)
                _ptt_active = False
                store.update(tx_state="RX")


async def _force_ptt_release(reason: str) -> None:
    if not _ptt_active:
        audio.set_tx_enabled(False)
        return
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            await _set_ptt(False, drain_audio=False)
            LOGGER.warning("PTT released automatically: %s", reason)
            return
        except Exception as exc:
            last_error = exc
            LOGGER.warning(
                "Automatic PTT release attempt %d/3 failed (%s): %s",
                attempt,
                reason,
                exc,
            )
            await asyncio.sleep(0.15)
    LOGGER.error("Could not release PTT automatically (%s): %s", reason, last_error)


async def _ptt_watchdog() -> None:
    while True:
        await asyncio.sleep(0.20)
        if not _ptt_active:
            continue
        if not audio.is_active():
            await _force_ptt_release("audio disconnected")
        elif time.monotonic() >= _ptt_deadline:
            await _force_ptt_release("PTT keepalive timeout")


async def _audio_control(payload: dict) -> None:
    global _ptt_deadline
    message_type = payload.get("type")
    if message_type == "ptt":
        await _set_ptt(bool(payload.get("enabled")))
        return
    if message_type == "ptt_keepalive":
        if _ptt_active:
            _ptt_deadline = time.monotonic() + settings.ptt_watchdog_seconds
        return
    raise RuntimeError(f"Unsupported audio control message: {message_type!r}")


@app.exception_handler(SerialCatError)
async def cat_exception_handler(_: Request, exc: SerialCatError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(FT8ManagerError)
async def ft8_exception_handler(_: Request, exc: FT8ManagerError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.get("/")
async def root():
    prefix = settings.root_path
    return {
        "service": "FT-710 Raspberry API",
        "version": "1.14.0",
        "cat2_device": settings.cat2_device,
        "docs": f"{prefix}/docs",
        "state": f"{prefix}/api/v1/state",
        "events": f"{prefix}/api/v1/events",
        "video": f"{prefix}/video.mjpeg",
        "video_settings": f"{prefix}/api/v1/video/settings",
        "audio_status": f"{prefix}/api/v1/audio/status",
        "audio_websocket": f"{prefix}/api/v1/audio/ws",
        "radio_power": f"{prefix}/api/v1/radio/power",
        "ft8_status": f"{prefix}/api/v1/ft8/status",
        "ft8_control": f"{prefix}/api/v1/ft8",
        "cw_status": f"{prefix}/api/v1/cw/status",
        "cw_send": f"{prefix}/api/v1/cw/send",
        "cw_stop": f"{prefix}/api/v1/cw/stop",
        "memories": f"{prefix}/api/v1/memories",
        "memories_sync": f"{prefix}/api/v1/memories/sync",
    }


@app.get("/api/v1/health")
async def health():
    state = _snapshot()
    return {
        "ok": bool(state["connected"]),
        "cat2_connected": state["connected"],
        "cat2_device": settings.cat2_device,
        "cat2_baud": settings.cat2_baud,
        "video_enabled": settings.video_enabled,
        "video_running": video.is_running(),
        "video": video.statistics(),
        "audio": {**audio.statistics(), "ptt": _ptt_active},
        "ft8": ft8.status(),
        "cw": _cw_status(),
        "memories_db": settings.memories_db,
        "last_error": state["last_error"],
    }


@app.get("/api/v1/capabilities")
async def capabilities():
    return {
        "modes": list(MODE_NAME_TO_CODE),
        "preamp": list(PREAMP_NAME_TO_CODE),
        "attenuator_db": list(ATTENUATOR_DB_TO_CODE),
        "meter_displays": list(METER_NAME_TO_CODE),
        "scope_modes": list(SCOPE_MODE_NAME_TO_CODE),
        "scope_speeds": list(SCOPE_SPEED_NAME_TO_CODE),
        "scope_spans": list(SCOPE_SPAN_NAME_TO_CODE),
        "cw": {
            "min_wpm": 4,
            "max_wpm": 60,
            "memory_slot": 5,
            "max_message_characters": 50,
            "allowed_characters": "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,?/=+-@()",
        },
        "memories": {
            "channels": 99,
            "tag_max_characters": 12,
            "physical_delete_supported": False,
            "web_metadata": ["category", "note"],
        },
        "frequency_min_hz": 30_000,
        "frequency_max_hz": 75_000_000,
        "video_fps_range": {"min": 1, "max": 30},
        "video_jpeg_quality_range": {"min": 20, "max": 95},
        "audio_enabled": settings.audio_enabled,
        "audio_single_client": True,
        "ptt_watchdog_seconds": settings.ptt_watchdog_seconds,
        "ft8_enabled": settings.ft8_enabled,
        "ft8_url": settings.ft8_url,
        "raw_cat_enabled": settings.allow_raw_cat,
    }


def _wait_for_radio_power(expected: str, timeout: float) -> bool:
    deadline = time.monotonic() + max(0.5, timeout)
    while time.monotonic() < deadline:
        try:
            cat.close()
            actual = cat.read_power_state(timeout=min(1.0, settings.cat2_query_timeout))
            if actual == expected:
                return True
        except SerialCatError:
            pass
        time.sleep(0.35)
    return False


@app.get("/api/v1/ft8/status")
async def ft8_status():
    return {"ok": True, "ft8": await asyncio.to_thread(ft8.status)}


@app.post("/api/v1/ft8")
async def set_ft8(payload: FT8Request):
    radio_power = _snapshot().get("radio_power")
    if radio_power != "ON":
        raise HTTPException(status_code=409, detail="The radio must be powered on before FT8 can be started or stopped")
    if payload.enabled and audio.is_active():
        raise HTTPException(status_code=409, detail="Disable browser audio before starting FT8")
    if payload.enabled and _cw_sending:
        raise HTTPException(status_code=409, detail="Stop the CW transmission before starting FT8")
    try:
        result = await asyncio.to_thread(ft8.start if payload.enabled else ft8.stop)
    except FT8ManagerError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "ft8": result}


@app.post("/api/v1/radio/power")
async def set_radio_power(payload: RadioPowerRequest):
    jogger.set_position(0.0)

    if payload.enabled:
        # Keep the normal poller paused throughout the boot transition so an
        # old PS0 snapshot cannot overwrite STARTING after PS1 has been sent.
        poller.begin_interactive()
        try:
            async with _interactive_cat_lock:
                await asyncio.to_thread(cat.set_power_state, True)
                store.update(radio_power="STARTING", connected=True, last_error=None)
                confirmed = await asyncio.to_thread(_wait_for_radio_power, "ON", 12.0)
                if confirmed:
                    store.update(radio_power="ON", connected=True, last_error=None)
        except SerialCatError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        finally:
            poller.end_interactive()
        return {
            "ok": True,
            "confirmed": confirmed,
            "state": _snapshot(),
            "ft8": await asyncio.to_thread(ft8.status),
        }

    await _stop_cw("radio power off", ignore_errors=True)
    await _force_ptt_release("radio power off")
    if audio.is_active():
        await audio.shutdown()
    try:
        await asyncio.to_thread(ft8.stop)
    except FT8ManagerError as exc:
        LOGGER.warning("Could not stop FT8 before radio power off: %s", exc)

    poller.begin_interactive()
    try:
        async with _interactive_cat_lock:
            await asyncio.to_thread(cat.set_power_state, False)
            cat.close()
            store.update(**RadioPoller.powered_off_values())
    except SerialCatError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    finally:
        poller.end_interactive()
    return {
        "ok": True,
        "confirmed": True,
        "state": _snapshot(),
        "ft8": await asyncio.to_thread(ft8.status),
    }


@app.get("/api/v1/cw/status")
async def cw_status():
    return {"ok": True, "cw": _cw_status()}


@app.post("/api/v1/cw/send")
async def cw_send(payload: CWSendRequest):
    global _cw_sending, _cw_message, _cw_wpm, _cw_memory_slot
    global _cw_started_at, _cw_expected_end, _cw_generation, _cw_finish_task

    state = _snapshot()
    if state.get("radio_power") != "ON":
        raise HTTPException(status_code=409, detail="The radio must be powered on before sending CW")
    if state.get("mode") not in {"CW-U", "CW-L"}:
        raise HTTPException(status_code=409, detail="Select CW-U or CW-L before sending CW")
    if _ptt_active:
        raise HTTPException(status_code=409, detail="Release voice PTT before sending CW")
    if ft8.status().get("running"):
        raise HTTPException(status_code=409, detail="Stop FT8 before sending CW")

    message = _normalize_cw_message(payload.message)
    duration = _estimate_cw_seconds(message, payload.wpm)

    async with _cw_state_lock:
        if _cw_sending:
            raise HTTPException(status_code=409, detail="A CW message is already being transmitted")
        await run_cat_call(
            cat.send_cw_text,
            message,
            payload.wpm,
            payload.memory_slot,
            stop_jog=False,
        )
        _cw_generation += 1
        generation = _cw_generation
        _cw_sending = True
        _cw_message = message
        _cw_wpm = payload.wpm
        _cw_memory_slot = payload.memory_slot
        _cw_started_at = time.monotonic()
        _cw_expected_end = _cw_started_at + duration + 0.8
        if _cw_finish_task:
            _cw_finish_task.cancel()
        _cw_finish_task = asyncio.create_task(
            _cw_finish_after(generation, duration + 0.8),
            name="ft710-cw-finish",
        )
    return {"ok": True, "cw": _cw_status()}


@app.post("/api/v1/cw/stop")
async def cw_stop():
    await _stop_cw("operator request")
    return {"ok": True, "cw": _cw_status()}


def _normalize_memory_name(value: str) -> str:
    name = " ".join(str(value).strip().split()).upper()
    if len(name) > 12:
        raise HTTPException(status_code=422, detail="Memory name is limited to 12 characters")
    if any(ord(character) < 32 or ord(character) > 126 or character == ";" for character in name):
        raise HTTPException(status_code=422, detail="Memory name must contain printable ASCII characters")
    return name


def _read_memory_and_tag(slot: int) -> dict | None:
    memory = cat.read_memory(slot, timeout=settings.memory_query_timeout)
    if memory is None:
        memories.mark_empty(slot)
        return None
    tag = cat.read_memory_tag(slot, timeout=settings.memory_query_timeout)
    memory.update(tag)
    return memories.upsert_radio(memory)


def _find_free_memory_slot() -> int:
    for slot in range(1, 100):
        if cat.read_memory(slot, timeout=settings.memory_query_timeout) is None:
            return slot
    raise SerialCatError("All 99 FT-710 memory channels are occupied")


def _sync_radio_memories() -> dict:
    present = 0
    empty = 0
    errors: list[dict[str, str | int]] = []
    for slot in range(1, 100):
        try:
            memory = cat.read_memory(slot, timeout=settings.memory_query_timeout)
            if memory is None:
                memories.mark_empty(slot)
                empty += 1
                continue
            try:
                memory.update(cat.read_memory_tag(slot, timeout=settings.memory_query_timeout))
            except SerialCatError as exc:
                memory.update(tag="", tag_enabled=False)
                errors.append({"slot": slot, "error": f"Tag read: {exc}"})
            memories.upsert_radio(memory)
            present += 1
        except SerialCatError as exc:
            errors.append({"slot": slot, "error": str(exc)})
            if len(errors) >= 5:
                raise SerialCatError(
                    "Memory synchronization stopped after repeated CAT errors: "
                    + str(errors[-1]["error"])
                ) from exc
    return {"present": present, "empty": empty, "errors": errors}


def _write_and_verify_memory(
    slot: int,
    *,
    frequency_hz: int,
    mode: str,
    name: str,
    base: dict | None = None,
) -> dict:
    base = base or {}
    cat.write_memory(
        slot,
        frequency_hz,
        mode,
        clarifier_offset_hz=base.get("clarifier_offset_hz", 0),
        rx_clarifier=base.get("rx_clarifier", False),
        tx_clarifier=base.get("tx_clarifier", False),
        ctcss_mode=base.get("ctcss_mode", 0),
        ctcss_number=base.get("ctcss_number", 0),
        repeater_shift=base.get("repeater_shift", 0),
    )
    time.sleep(0.10)
    cat.write_memory_tag(slot, name)
    time.sleep(0.12)
    verified = _read_memory_and_tag(slot)
    if verified is None:
        raise SerialCatError(f"Memory {slot:03d} was not readable after writing")
    return verified


@app.get("/api/v1/memories")
async def list_memories(include_empty: bool = False):
    return {
        "ok": True,
        "memories": await asyncio.to_thread(
            memories.list,
            include_empty=include_empty,
        ),
        "physical_delete_supported": False,
    }


@app.post("/api/v1/memories/sync")
async def sync_memories():
    if _snapshot().get("radio_power") != "ON":
        raise HTTPException(status_code=409, detail="The radio must be powered on to synchronize memories")
    summary = await run_cat_call(_sync_radio_memories)
    return {
        "ok": True,
        "summary": summary,
        "memories": memories.list(),
        "physical_delete_supported": False,
    }


@app.post("/api/v1/memories")
async def save_current_memory(payload: MemorySaveRequest):
    state = _snapshot()
    if state.get("radio_power") != "ON":
        raise HTTPException(status_code=409, detail="The radio must be powered on to save a memory")
    frequency_hz = state.get("frequency_hz")
    mode = state.get("mode")
    if not isinstance(frequency_hz, int) or mode not in MODE_NAME_TO_CODE:
        raise HTTPException(status_code=409, detail="Current radio frequency or mode is unavailable")
    name = _normalize_memory_name(payload.name)

    def save() -> dict:
        slot = payload.slot if payload.slot is not None else _find_free_memory_slot()
        existing = cat.read_memory(slot, timeout=settings.memory_query_timeout)
        if existing is not None and not payload.overwrite:
            raise SerialCatError(f"Memory {slot:03d} is already occupied; enable overwrite to replace it")
        _write_and_verify_memory(
            slot,
            frequency_hz=frequency_hz,
            mode=mode,
            name=name,
        )
        memories.update_metadata(
            slot,
            category=payload.category,
            note=payload.note,
            hidden=False,
        )
        return memories.get(slot) or {}

    try:
        record = await run_cat_call(save)
    except HTTPException as exc:
        if exc.status_code == 502 and "already occupied" in str(exc.detail):
            raise HTTPException(status_code=409, detail=exc.detail) from exc
        raise
    return {"ok": True, "memory": record, "state": _snapshot()}


@app.put("/api/v1/memories/{slot}")
async def edit_memory(slot: int, payload: MemoryEditRequest):
    if not 1 <= slot <= 99:
        raise HTTPException(status_code=404, detail="Memory channel must be between 001 and 099")
    if payload.mode is not None and payload.mode.upper() not in MODE_NAME_TO_CODE:
        raise HTTPException(status_code=422, detail=f"Unsupported memory mode: {payload.mode}")

    def edit() -> dict:
        current = cat.read_memory(slot, timeout=settings.memory_query_timeout)
        if current is None:
            raise SerialCatError(f"Memory {slot:03d} is empty")
        try:
            current.update(cat.read_memory_tag(slot, timeout=settings.memory_query_timeout))
        except SerialCatError:
            current.update(tag="", tag_enabled=False)
        name = current.get("tag", "") if payload.name is None else _normalize_memory_name(payload.name)
        _write_and_verify_memory(
            slot,
            frequency_hz=payload.frequency_hz or current["frequency_hz"],
            mode=(payload.mode or current["mode"]).upper(),
            name=name,
            base=current,
        )
        memories.update_metadata(
            slot,
            category=payload.category,
            note=payload.note,
            hidden=False,
        )
        return memories.get(slot) or {}

    try:
        record = await run_cat_call(edit)
    except HTTPException as exc:
        if exc.status_code == 502 and "is empty" in str(exc.detail):
            raise HTTPException(status_code=404, detail=exc.detail) from exc
        raise
    return {"ok": True, "memory": record, "state": _snapshot()}


@app.post("/api/v1/memories/{slot}/recall")
async def recall_memory(slot: int, payload: MemoryRecallRequest):
    if not 1 <= slot <= 99:
        raise HTTPException(status_code=404, detail="Memory channel must be between 001 and 099")

    def recall() -> None:
        if cat.read_memory(slot, timeout=settings.memory_query_timeout) is None:
            raise SerialCatError(f"Memory {slot:03d} is empty")

        # The radio may recall per-channel receiver front-end settings when it
        # enters a real memory channel.  The web memory model intentionally
        # recalls frequency/mode without changing the operator's current
        # IPO/AMP or attenuator choice, so snapshot and restore both controls.
        preamp = cat.read_preamp(timeout=settings.memory_query_timeout)
        attenuator_db = cat.read_attenuator(timeout=settings.memory_query_timeout)
        try:
            if payload.action == "memory":
                cat.select_memory(slot)
            else:
                cat.copy_memory_to_vfo(slot, "A" if payload.action == "vfo_a" else "B")
        finally:
            time.sleep(0.10)
            cat.set_preamp(preamp)
            cat.set_attenuator(attenuator_db)

    try:
        await run_cat_call(recall)
    except HTTPException as exc:
        if exc.status_code == 502 and "is empty" in str(exc.detail):
            raise HTTPException(status_code=404, detail=exc.detail) from exc
        raise
    await asyncio.sleep(0.15)
    poller.request_refresh()
    return {"ok": True, "action": payload.action, "slot": slot, "state": _snapshot()}


@app.patch("/api/v1/memories/{slot}/metadata")
async def update_memory_metadata(slot: int, payload: MemoryMetadataRequest):
    if not 1 <= slot <= 99:
        raise HTTPException(status_code=404, detail="Memory channel must be between 001 and 099")
    record = await asyncio.to_thread(
        memories.update_metadata,
        slot,
        category=payload.category,
        note=payload.note,
    )
    return {"ok": True, "memory": record}


@app.get("/api/v1/state")
async def state():
    return _snapshot()


@app.get("/api/v1/events")
async def events(request: Request):
    async def event_stream():
        last_version = -1
        keepalive_counter = 0
        while not await request.is_disconnected():
            version, snapshot = store.snapshot()
            if version != last_version:
                payload = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
                yield f"event: state\ndata: {payload}\n\n"
                last_version = version
                keepalive_counter = 0
            else:
                keepalive_counter += 1
                if keepalive_counter >= 20:
                    yield ": keepalive\n\n"
                    keepalive_counter = 0
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/v1/audio/status")
async def audio_status():
    return {"ok": True, "audio": {**audio.statistics(), "ptt": _ptt_active}}


@app.websocket("/api/v1/audio/ws")
async def audio_websocket(websocket: WebSocket):
    origin = (websocket.headers.get("origin") or "").rstrip("/")
    if settings.audio_allowed_origin and origin != settings.audio_allowed_origin:
        LOGGER.warning("Rejected audio WebSocket origin: %r", origin)
        await websocket.close(code=1008, reason="Invalid audio origin")
        return
    try:
        sample_rate = int(websocket.query_params.get("sample_rate", "48000"))
    except ValueError:
        sample_rate = 48_000
    await audio.serve(
        websocket,
        sample_rate=sample_rate,
        control_handler=_audio_control,
        disconnect_handler=lambda: _force_ptt_release("audio WebSocket closed"),
    )


@app.get("/api/v1/video/settings")
async def get_video_settings():
    return {
        "ok": True,
        "settings": video.current_settings(),
        "statistics": video.statistics(),
    }


@app.post("/api/v1/video/settings")
async def set_video_settings(payload: VideoSettingsRequest):
    if payload.fps is None and payload.jpeg_quality is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="fps or jpeg_quality is required",
        )
    values = await asyncio.to_thread(
        video.reconfigure,
        fps=payload.fps,
        jpeg_quality=payload.jpeg_quality,
    )
    return {
        "ok": True,
        "settings": {
            "fps": values["fps"],
            "jpeg_quality": values["jpeg_quality"],
        },
        "restarted": values["restarted"],
    }


@app.get("/video.mjpeg")
async def video_mjpeg():
    if not settings.video_enabled:
        raise HTTPException(status_code=503, detail="Video disabled")
    return StreamingResponse(
        video.stream_mjpeg(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def command_result() -> dict:
    return {"ok": True, "state": _snapshot()}


@app.post("/api/v1/radio/frequency")
async def set_frequency(payload: FrequencyRequest):
    active = _active_vfo_from_state()
    target = active if payload.vfo == "ACTIVE" else payload.vfo
    await run_cat_call(cat.set_frequency, target, payload.frequency_hz)
    values = {"vfo_a_hz" if target == "A" else "vfo_b_hz": payload.frequency_hz}
    if target == active:
        values["frequency_hz"] = payload.frequency_hz
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/mode")
async def set_mode(payload: ModeRequest):
    active = _active_vfo_from_state()
    target = active if payload.vfo == "ACTIVE" else payload.vfo
    await run_cat_call(cat.set_mode, target, active, payload.mode)
    values = {"vfo_a_mode" if target == "A" else "vfo_b_mode": payload.mode}
    if target == active:
        values["mode"] = payload.mode
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/tx-power")
async def set_tx_power(payload: TxPowerRequest):
    await run_cat_call(cat.set_tx_power, payload.watts)
    store.update(tx_power_w=payload.watts)
    return command_result()


@app.post("/api/v1/radio/rf-gain")
async def set_rf_gain(payload: RfGainRequest):
    await run_cat_call(cat.set_rf_gain, payload.value)
    store.update(rf_gain=payload.value)
    return command_result()


@app.post("/api/v1/radio/tuner")
async def tuner(payload: TunerRequest):
    actions = {
        "enable": cat.tuner_enable,
        "disable": cat.tuner_disable,
        "tune": cat.tuner_start,
    }
    await run_cat_call(actions[payload.action])
    store.update(tuner={"enable": "ON", "disable": "OFF", "tune": "TUNING"}[payload.action])
    return command_result()


@app.post("/api/v1/radio/vfo/select")
async def select_vfo(payload: VfoSelectRequest):
    await run_cat_call(cat.set_active_vfo, payload.vfo)
    state = _snapshot()
    store.update(
        active_vfo=payload.vfo,
        frequency_hz=state.get("vfo_a_hz") if payload.vfo == "A" else state.get("vfo_b_hz"),
        mode=state.get("vfo_a_mode") if payload.vfo == "A" else state.get("vfo_b_mode"),
    )
    return command_result()


@app.post("/api/v1/radio/vfo/operation")
async def vfo_operation(payload: VfoOperationRequest):
    actions = {
        "swap": cat.swap_vfos,
        "copy_a_to_b": cat.copy_vfo_a_to_b,
        "copy_b_to_a": cat.copy_vfo_b_to_a,
    }
    await run_cat_call(actions[payload.action])
    state = _snapshot()
    active = state.get("active_vfo") or "A"
    if payload.action == "swap":
        values = {
            "vfo_a_hz": state.get("vfo_b_hz"),
            "vfo_b_hz": state.get("vfo_a_hz"),
            "vfo_a_mode": state.get("vfo_b_mode"),
            "vfo_b_mode": state.get("vfo_a_mode"),
        }
    elif payload.action == "copy_a_to_b":
        values = {"vfo_b_hz": state.get("vfo_a_hz"), "vfo_b_mode": state.get("vfo_a_mode")}
    else:
        values = {"vfo_a_hz": state.get("vfo_b_hz"), "vfo_a_mode": state.get("vfo_b_mode")}
    if active == "A":
        values.update(frequency_hz=values.get("vfo_a_hz", state.get("vfo_a_hz")), mode=values.get("vfo_a_mode", state.get("vfo_a_mode")))
    else:
        values.update(frequency_hz=values.get("vfo_b_hz", state.get("vfo_b_hz")), mode=values.get("vfo_b_mode", state.get("vfo_b_mode")))
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/preamp")
async def set_preamp(payload: PreampRequest):
    await run_cat_call(cat.set_preamp, payload.value)
    store.update(preamp=payload.value)
    return command_result()


@app.post("/api/v1/radio/attenuator")
async def set_attenuator(payload: AttenuatorRequest):
    await run_cat_call(cat.set_attenuator, payload.db)
    store.update(attenuator_db=payload.db)
    return command_result()


@app.post("/api/v1/radio/dnr")
async def set_dnr(payload: DnrRequest):
    if payload.enabled is None and payload.level is None:
        raise HTTPException(status_code=422, detail="enabled or level is required")

    def apply() -> None:
        if payload.enabled is not None:
            cat.set_dnr(payload.enabled)
        if payload.level is not None:
            cat.set_dnr_level(payload.level)

    await run_cat_call(apply)
    values = {}
    if payload.enabled is not None:
        values["dnr"] = payload.enabled
    if payload.level is not None:
        values["dnr_level"] = payload.level
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/noise-blanker")
async def set_noise_blanker(payload: NoiseBlankerRequest):
    if payload.enabled is None and payload.level is None:
        raise HTTPException(status_code=422, detail="enabled or level is required")

    def apply() -> None:
        if payload.enabled is not None:
            cat.set_noise_blanker(payload.enabled)
        if payload.level is not None:
            cat.set_noise_blanker_level(payload.level)

    await run_cat_call(apply)
    values = {}
    if payload.enabled is not None:
        values["noise_blanker"] = payload.enabled
    if payload.level is not None:
        values["noise_blanker_level"] = payload.level
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/auto-notch")
async def set_auto_notch(payload: AutoNotchRequest):
    await run_cat_call(cat.set_auto_notch, payload.enabled)
    store.update(auto_notch=payload.enabled)
    return command_result()


@app.post("/api/v1/radio/meter-display")
async def set_meter_display(payload: MeterDisplayRequest):
    await run_cat_call(cat.set_meter_display, payload.value)
    store.update(meter_display=payload.value)
    return command_result()


@app.post("/api/v1/radio/scope")
async def set_scope(payload: ScopeRequest):
    if payload.mode is None and payload.speed is None and payload.span is None:
        raise HTTPException(status_code=422, detail="mode, speed or span is required")
    if payload.mode is not None and payload.mode.upper() not in SCOPE_MODE_NAME_TO_CODE:
        raise HTTPException(status_code=422, detail=f"Unsupported scope mode: {payload.mode}")
    if payload.speed is not None and payload.speed.upper() not in SCOPE_SPEED_NAME_TO_CODE:
        raise HTTPException(status_code=422, detail=f"Unsupported scope speed: {payload.speed}")
    if payload.span is not None and payload.span.lower() not in {name.lower() for name in SCOPE_SPAN_NAME_TO_CODE}:
        raise HTTPException(status_code=422, detail=f"Unsupported scope span: {payload.span}")

    def apply() -> None:
        if payload.mode is not None:
            cat.set_scope_mode(payload.mode)
        if payload.speed is not None:
            cat.set_scope_speed(payload.speed)
        if payload.span is not None:
            cat.set_scope_span(payload.span)

    await run_cat_call(apply)
    values = {}
    if payload.mode is not None:
        values["scope_mode"] = payload.mode.upper()
    if payload.speed is not None:
        values["scope_speed"] = payload.speed.upper()
    if payload.span is not None:
        for public_name in SCOPE_SPAN_NAME_TO_CODE:
            if public_name.lower() == payload.span.lower():
                values["scope_span"] = public_name
                break
    store.update(**values)
    return command_result()


@app.post("/api/v1/radio/jog")
async def set_jog(payload: JogRequest):
    speed = jogger.set_position(payload.position)
    return {"ok": True, "speed_hz_s": round(speed, 2), "state": _snapshot()}


@app.post("/api/v1/cat")
async def raw_cat(payload: Annotated[RawCatRequest, Body()]):
    if not settings.allow_raw_cat:
        raise HTTPException(status_code=403, detail="Raw CAT endpoint is disabled")
    if payload.expect_reply:
        response = await run_cat_call(cat.raw_exchange, payload.command)
        return {"ok": True, "response": response}
    await run_cat_call(cat.raw_set, payload.command)
    return {"ok": True, "response": None}
