from __future__ import annotations

import copy
import logging
import math
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable

from .direct_cat import SerialCatError, SerialCatTimeout, YaesuCatClient, clamp

LOGGER = logging.getLogger(__name__)


class PollCycleSuperseded(RuntimeError):
    """Raised when an interactive command makes a polling cycle stale."""


class StateStore:
    def __init__(self, cat2_device: str) -> None:
        self._lock = threading.Lock()
        self._version = 0
        self._state: dict[str, Any] = {
            "connected": False,
            "last_error": None,
            "updated_at": None,
            "cat2_device": cat2_device,
            "radio_id": None,
            "radio_power": None,
            "active_vfo": None,
            "frequency_hz": None,
            "vfo_a_hz": None,
            "vfo_b_hz": None,
            "mode": None,
            "vfo_a_mode": None,
            "vfo_b_mode": None,
            "tx_state": None,
            "hi_swr": None,
            "tuner": None,
            "tuner_busy": None,
            "tx_power_w": None,
            "rf_gain": None,
            "preamp": None,
            "attenuator_db": None,
            "dnr": None,
            "dnr_level": None,
            "noise_blanker": None,
            "noise_blanker_level": None,
            "auto_notch": None,
            "meter_display": None,
            "scope_mode": None,
            "scope_speed": None,
            "scope_span": None,
            "jog_position": 0.0,
            "jog_speed_hz_s": 0.0,
        }

    def update(self, **values: Any) -> None:
        with self._lock:
            self._state.update(values)
            self._state["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._version += 1

    def snapshot(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            return self._version, copy.deepcopy(self._state)


class RadioPoller:
    """Poll real radio state from the dedicated direct CAT-2 serial port."""

    def __init__(
        self,
        client: YaesuCatClient,
        store: StateStore,
        poll_interval: float = 0.75,
        settings_poll_interval: float = 0.5,
    ) -> None:
        self.client = client
        self.store = store
        self.poll_interval = max(0.25, float(poll_interval))
        self.settings_poll_interval = max(0.15, float(settings_poll_interval))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

        self._interactive_condition = threading.Condition()
        self._interactive_waiters = 0
        self._poll_generation = 0

        self._optional_readers: tuple[tuple[str, Callable[..., Any]], ...] = (
            ("tx_power_w", self.client.read_tx_power),
            ("rf_gain", self.client.read_rf_gain),
            ("tuner", self.client.read_tuner_state),
            ("preamp", self.client.read_preamp),
            ("attenuator_db", self.client.read_attenuator),
            ("dnr", self.client.read_dnr),
            ("dnr_level", self.client.read_dnr_level),
            ("noise_blanker", self.client.read_noise_blanker),
            ("noise_blanker_level", self.client.read_noise_blanker_level),
            ("auto_notch", self.client.read_auto_notch),
            ("meter_display", self.client.read_meter_display),
            ("scope_mode", self.client.read_scope_mode),
            ("scope_speed", self.client.read_scope_speed),
            ("scope_span", self.client.read_scope_span),
        )
        self._optional_index = 0
        self._optional_error_last_log: dict[str, float] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._wake.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="ft710-cat2-poller",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._interactive_condition:
            self._interactive_condition.notify_all()
        if self._thread:
            self._thread.join(timeout=3.0)

    def begin_interactive(self) -> None:
        with self._interactive_condition:
            self._poll_generation += 1
            self._interactive_waiters += 1
            self._wake.set()
            self._interactive_condition.notify_all()

    def end_interactive(self) -> None:
        with self._interactive_condition:
            self._interactive_waiters = max(0, self._interactive_waiters - 1)
            self._interactive_condition.notify_all()
        self.request_refresh()

    def request_refresh(self) -> None:
        self._wake.set()

    def _current_generation(self) -> int:
        with self._interactive_condition:
            return self._poll_generation

    def _call(self, generation: int, method: Callable[..., Any], *args: Any) -> Any:
        if self._stop.is_set():
            raise InterruptedError("poller stopping")
        with self._interactive_condition:
            if generation != self._poll_generation or self._interactive_waiters > 0:
                raise PollCycleSuperseded
        return method(*args)

    def _commit_if_current(self, generation: int, values: dict[str, Any]) -> None:
        with self._interactive_condition:
            if generation != self._poll_generation or self._interactive_waiters > 0:
                raise PollCycleSuperseded
            self.store.update(**values)

    def _log_optional_error(self, key: str, exc: Exception) -> None:
        now = time.monotonic()
        last = self._optional_error_last_log.get(key, 0.0)
        if now - last >= 30.0:
            LOGGER.warning("Optional CAT-2 poll %s failed: %s", key, exc)
            self._optional_error_last_log[key] = now

    @staticmethod
    def powered_off_values() -> dict[str, Any]:
        return {
            "connected": True,
            "last_error": None,
            "radio_power": "OFF",
            "active_vfo": None,
            "frequency_hz": None,
            "vfo_a_hz": None,
            "vfo_b_hz": None,
            "mode": None,
            "vfo_a_mode": None,
            "vfo_b_mode": None,
            "tx_state": "RX",
            "hi_swr": False,
            "tuner": None,
            "tuner_busy": False,
            "tx_power_w": None,
            "rf_gain": None,
            "preamp": None,
            "attenuator_db": None,
            "dnr": None,
            "dnr_level": None,
            "noise_blanker": None,
            "noise_blanker_level": None,
            "auto_notch": None,
            "meter_display": None,
            "scope_mode": None,
            "scope_speed": None,
            "scope_span": None,
            "jog_position": 0.0,
            "jog_speed_hz_s": 0.0,
        }

    def _read_core(self, generation: int) -> dict[str, Any]:
        try:
            radio_power = self._call(generation, self.client.read_power_state)
        except SerialCatTimeout:
            # The FT-710 does not answer PS; on CAT-2 while it is powered off.
            # Reaching this timeout means the serial device itself opened and the
            # command was written successfully, so it is a valid OFF indication,
            # not a CAT-2 transport failure. Serial/open/I/O errors still raise
            # SerialCatError and are handled as genuine connection failures.
            return self.powered_off_values()
        if radio_power == "OFF":
            return self.powered_off_values()

        active_vfo = self._call(generation, self.client.read_active_vfo)
        vfo_a_hz = self._call(generation, self.client.read_frequency, "A")
        vfo_b_hz = self._call(generation, self.client.read_frequency, "B")
        vfo_a_mode, vfo_b_mode = self._call(
            generation,
            self.client.read_vfo_modes,
            active_vfo,
        )
        info = self._call(generation, self.client.read_radio_info)
        return {
            "connected": True,
            "last_error": None,
            "radio_power": "ON",
            "active_vfo": active_vfo,
            "vfo_a_hz": vfo_a_hz,
            "vfo_b_hz": vfo_b_hz,
            "frequency_hz": vfo_a_hz if active_vfo == "A" else vfo_b_hz,
            "vfo_a_mode": vfo_a_mode,
            "vfo_b_mode": vfo_b_mode,
            "mode": vfo_a_mode if active_vfo == "A" else vfo_b_mode,
            **info,
        }

    def _read_all_optional_initial(self, generation: int) -> dict[str, Any]:
        values: dict[str, Any] = {}
        for key, reader in self._optional_readers:
            try:
                values[key] = self._call(generation, reader)
            except PollCycleSuperseded:
                raise
            except (SerialCatError, ValueError, TypeError) as exc:
                self._log_optional_error(key, exc)
        return values

    def _read_one_optional(self, generation: int) -> dict[str, Any]:
        key, reader = self._optional_readers[self._optional_index]
        self._optional_index = (self._optional_index + 1) % len(self._optional_readers)
        try:
            return {key: self._call(generation, reader)}
        except PollCycleSuperseded:
            raise
        except (SerialCatError, ValueError, TypeError) as exc:
            self._log_optional_error(key, exc)
            return {}

    def _run(self) -> None:
        first_success = True
        next_optional = 0.0

        while not self._stop.is_set():
            started = time.monotonic()
            generation = self._current_generation()
            try:
                values = self._read_core(generation)
                if values.get("radio_power") == "OFF":
                    self._commit_if_current(generation, values)
                    first_success = True
                    next_optional = 0.0
                    elapsed = time.monotonic() - started
                    wait_time = max(0.05, self.poll_interval - elapsed)
                    self._wake.wait(wait_time)
                    self._wake.clear()
                    continue

                if first_success:
                    try:
                        values["radio_id"] = self._call(generation, self.client.test)
                    except (SerialCatError, ValueError, TypeError) as exc:
                        self._log_optional_error("radio_id", exc)
                    # Publish frequency, active VFO and real mode immediately.
                    self._commit_if_current(generation, values)
                    first_success = False
                    # Prime every secondary setting, publishing each result as it
                    # arrives so the interface never starts with invented values.
                    for key, reader in self._optional_readers:
                        try:
                            value = self._call(generation, reader)
                            self._commit_if_current(generation, {key: value})
                        except PollCycleSuperseded:
                            raise
                        except (SerialCatError, ValueError, TypeError) as exc:
                            self._log_optional_error(key, exc)
                    next_optional = time.monotonic() + self.settings_poll_interval
                else:
                    if time.monotonic() >= next_optional:
                        values.update(self._read_one_optional(generation))
                        next_optional = time.monotonic() + self.settings_poll_interval
                    self._commit_if_current(generation, values)

            except PollCycleSuperseded:
                pass
            except InterruptedError:
                break
            except Exception as exc:
                LOGGER.warning("CAT-2 core polling failed: %s", exc)
                self.store.update(connected=False, last_error=str(exc))
                self.client.close()
                first_success = True

            elapsed = time.monotonic() - started
            wait_time = max(0.05, self.poll_interval - elapsed)
            self._wake.wait(wait_time)
            self._wake.clear()


class FrequencyJogger:
    """Elastic, spring-centered frequency movement handled on the Raspberry."""

    DEAD_ZONE = 0.06

    def __init__(
        self,
        client: YaesuCatClient,
        store: StateStore,
        poller: RadioPoller,
        tick_interval: float = 0.20,
        min_speed_hz_s: float = 10.0,
        max_speed_hz_s: float = 100000.0,
    ) -> None:
        self.client = client
        self.store = store
        self.poller = poller
        self.tick_interval = max(0.05, float(tick_interval))
        self.min_speed_hz_s = max(1.0, float(min_speed_hz_s))
        self.max_speed_hz_s = max(self.min_speed_hz_s, float(max_speed_hz_s))
        self._condition = threading.Condition()
        self._position = 0.0
        self._holding_poller = False
        self._stop = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        with self._condition:
            self._stop = False
        self._thread = threading.Thread(target=self._run, name="ft710-frequency-jog", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        release_poller = False
        with self._condition:
            self._stop = True
            self._position = 0.0
            if self._holding_poller:
                self._holding_poller = False
                release_poller = True
            self._condition.notify_all()
        if release_poller:
            self.poller.end_interactive()
        if self._thread:
            self._thread.join(timeout=2.0)

    def _speed_for_position(self, position: float) -> float:
        magnitude = abs(position)
        if magnitude <= self.DEAD_ZONE:
            return 0.0
        normalized = (magnitude - self.DEAD_ZONE) / (1.0 - self.DEAD_ZONE)
        speed = self.min_speed_hz_s * math.pow(
            self.max_speed_hz_s / self.min_speed_hz_s,
            normalized,
        )
        return math.copysign(speed, position)

    def set_position(self, position: float) -> float:
        position = float(clamp(position, -1.0, 1.0))
        if abs(position) <= self.DEAD_ZONE:
            position = 0.0

        acquire_poller = False
        release_poller = False
        with self._condition:
            was_active = self._position != 0.0
            is_active = position != 0.0
            self._position = position
            if is_active and not was_active and not self._holding_poller:
                self._holding_poller = True
                acquire_poller = True
            elif was_active and not is_active and self._holding_poller:
                self._holding_poller = False
                release_poller = True

        # Invalidate any in-flight poll before waking the jog thread. This keeps
        # an old frequency snapshot from being published after movement starts.
        if acquire_poller:
            self.poller.begin_interactive()
        if release_poller:
            self.poller.end_interactive()
        with self._condition:
            self._condition.notify_all()

        speed = self._speed_for_position(position)
        self.store.update(jog_position=position, jog_speed_hz_s=round(speed, 2))
        return speed

    def _abort(self, error: Exception) -> None:
        LOGGER.warning("Frequency jog stopped: %s", error)
        release_poller = False
        with self._condition:
            self._position = 0.0
            if self._holding_poller:
                self._holding_poller = False
                release_poller = True
        if release_poller:
            self.poller.end_interactive()
        self.store.update(
            jog_position=0.0,
            jog_speed_hz_s=0.0,
            last_error=f"Frequency jog: {error}",
        )

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._stop and self._position == 0.0:
                    self._condition.wait()
                if self._stop:
                    return
                position = self._position

            speed = self._speed_for_position(position)
            try:
                _, state = self.store.snapshot()
                active_vfo = state.get("active_vfo") or self.client.read_active_vfo()
                frequency_key = "vfo_a_hz" if active_vfo == "A" else "vfo_b_hz"
                frequency = state.get(frequency_key)
                if not isinstance(frequency, (int, float)):
                    frequency = self.client.read_frequency(active_vfo)

                delta = int(round(speed * self.tick_interval))
                if delta == 0:
                    delta = 1 if speed > 0 else -1
                new_frequency = int(clamp(int(frequency) + delta, 30_000, 75_000_000))
                self.client.set_frequency(active_vfo, new_frequency)
                self.store.update(
                    **{
                        frequency_key: new_frequency,
                        "frequency_hz": new_frequency,
                        "jog_position": position,
                        "jog_speed_hz_s": round(speed, 2),
                        "connected": True,
                        "last_error": None,
                    }
                )
            except Exception as exc:
                self._abort(exc)

            with self._condition:
                if self._stop:
                    return
                self._condition.wait(self.tick_interval)
