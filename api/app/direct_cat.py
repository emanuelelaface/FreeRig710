from __future__ import annotations

import re
import threading
import time
from typing import Any, Pattern

import serial
from serial import SerialException


MODE_NAME_TO_CODE = {
    "LSB": "1",
    "USB": "2",
    "CW-U": "3",
    "FM": "4",
    "AM": "5",
    "RTTY-L": "6",
    "CW-L": "7",
    "DATA-L": "8",
    "RTTY-U": "9",
    "DATA-FM": "A",
    "FM-N": "B",
    "DATA-U": "C",
    "AM-N": "D",
    "PSK": "E",
    "DATA-FM-N": "F",
}
MODE_CODE_TO_NAME = {value: key for key, value in MODE_NAME_TO_CODE.items()}

PREAMP_NAME_TO_CODE = {"IPO": "0", "AMP1": "1", "AMP2": "2"}
PREAMP_CODE_TO_NAME = {value: key for key, value in PREAMP_NAME_TO_CODE.items()}

ATTENUATOR_DB_TO_CODE = {0: "0", 6: "1", 12: "2", 18: "3"}
ATTENUATOR_CODE_TO_DB = {value: key for key, value in ATTENUATOR_DB_TO_CODE.items()}

METER_NAME_TO_CODE = {
    "PO": "0",
    "COMP": "1",
    "ALC": "2",
    "VDD": "3",
    "ID": "4",
    "SWR": "5",
}
METER_CODE_TO_NAME = {value: key for key, value in METER_NAME_TO_CODE.items()}

SCOPE_MODE_NAME_TO_CODE = {
    "3DSS CENTER": "0",
    "3DSS CURSOR": "1",
    "3DSS FIX": "2",
    "WATERFALL CENTER EXPAND": "3",
    "WATERFALL CENTER NORMAL": "4",
    "WATERFALL CURSOR EXPAND": "6",
    "WATERFALL CURSOR NORMAL": "7",
    "WATERFALL FIX EXPAND": "9",
    "WATERFALL FIX NORMAL": "A",
}
SCOPE_MODE_CODE_TO_NAME = {value: key for key, value in SCOPE_MODE_NAME_TO_CODE.items()}
# FT-710 firmware 1.?? has been observed returning code 5 after selecting
# WATERFALL CENTER EXPAND, even though the CAT reference marks 5 as reserved
# and documents code 3 for the set command. Keep 3 for writes and accept 5
# as a readback alias so polling does not replace the valid UI state with
# UNKNOWN-5.
SCOPE_MODE_CODE_TO_NAME["5"] = "WATERFALL CENTER EXPAND"

SCOPE_SPEED_NAME_TO_CODE = {
    "SLOW 1": "0",
    "SLOW 2": "1",
    "FAST 1": "2",
    "FAST 2": "3",
    "FAST 3": "4",
    "STOP": "5",
}
SCOPE_SPEED_CODE_TO_NAME = {value: key for key, value in SCOPE_SPEED_NAME_TO_CODE.items()}

SCOPE_SPAN_NAME_TO_CODE = {
    "1 kHz": "0",
    "2 kHz": "1",
    "5 kHz": "2",
    "10 kHz": "3",
    "20 kHz": "4",
    "50 kHz": "5",
    "100 kHz": "6",
    "200 kHz": "7",
    "500 kHz": "8",
    "1 MHz": "9",
}
SCOPE_SPAN_CODE_TO_NAME = {value: key for key, value in SCOPE_SPAN_NAME_TO_CODE.items()}


class SerialCatError(RuntimeError):
    pass


class SerialCatTimeout(SerialCatError):
    """A CAT command was sent successfully, but the radio did not reply in time."""



def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


class YaesuCatClient:
    """Direct FT-710 CAT-2 client.

    This class is the only owner of /dev/ttyFT710_AUX. WSJT-X directly owns
    /dev/ttyFT710_CAT. All serial transactions are serialized with one lock.
    RTS, DTR and software/hardware flow control are disabled deliberately.
    """

    def __init__(
        self,
        device: str = "/dev/ttyFT710_AUX",
        baudrate: int = 115200,
        query_timeout: float = 0.75,
        write_timeout: float = 0.5,
    ) -> None:
        self.device = device
        self.baudrate = int(baudrate)
        self.query_timeout = max(0.1, float(query_timeout))
        self.write_timeout = max(0.1, float(write_timeout))
        self._serial: serial.Serial | None = None
        self._rx_buffer = bytearray()
        self._lock = threading.RLock()

    def close(self) -> None:
        with self._lock:
            if self._serial is not None:
                try:
                    self._serial.close()
                finally:
                    self._serial = None
                    self._rx_buffer.clear()

    def _open_locked(self) -> serial.Serial:
        if self._serial is not None and self._serial.is_open:
            return self._serial

        port = serial.Serial()
        port.port = self.device
        port.baudrate = self.baudrate
        port.bytesize = serial.EIGHTBITS
        port.parity = serial.PARITY_NONE
        port.stopbits = serial.STOPBITS_ONE
        port.timeout = 0.05
        port.write_timeout = self.write_timeout
        port.xonxoff = False
        port.rtscts = False
        port.dsrdtr = False
        if hasattr(port, "exclusive"):
            port.exclusive = True

        # Set these before opening where the driver permits it, then force them
        # low again immediately after open. CAT-2 must never key PTT via RTS/DTR.
        port.rts = False
        port.dtr = False
        try:
            port.open()
            port.rts = False
            port.dtr = False
            port.reset_input_buffer()
            port.reset_output_buffer()
            self._rx_buffer.clear()
            port.write(b"AI0;")  # disable unsolicited Auto Information on CAT-2
            port.flush()
        except Exception:
            try:
                port.close()
            finally:
                raise

        self._serial = port
        return port

    @staticmethod
    def normalize_command(command: str) -> str:
        command = command.strip()
        if not command:
            raise SerialCatError("Empty CAT command")
        if len(command) > 128:
            raise SerialCatError("CAT command is too long")
        if "\n" in command or "\r" in command:
            raise SerialCatError("CAT command must not contain newlines")
        if not all(32 <= ord(char) <= 126 for char in command):
            raise SerialCatError("CAT command must contain printable ASCII only")
        return command.rstrip(";") + ";"

    def _write_locked(self, command: str) -> None:
        port = self._open_locked()
        payload = self.normalize_command(command).encode("ascii")
        try:
            port.write(payload)
            port.flush()
        except (SerialException, OSError) as exc:
            self.close()
            raise SerialCatError(f"CAT-2 write failed on {self.device}: {exc}") from exc

    def set(self, command: str) -> None:
        with self._lock:
            self._write_locked(command)

    def _read_message_locked(self, deadline: float) -> str | None:
        port = self._open_locked()
        while time.monotonic() < deadline:
            terminator = self._rx_buffer.find(b";")
            if terminator >= 0:
                raw = bytes(self._rx_buffer[: terminator + 1])
                del self._rx_buffer[: terminator + 1]
                return raw.decode("ascii", errors="replace")
            try:
                chunk = port.read(max(1, min(128, port.in_waiting or 1)))
            except (SerialException, OSError) as exc:
                self.close()
                raise SerialCatError(f"CAT-2 read failed on {self.device}: {exc}") from exc
            if not chunk:
                continue
            self._rx_buffer.extend(byte for byte in chunk if byte == 59 or 32 <= byte <= 126)
            if len(self._rx_buffer) > 2048:
                self._rx_buffer.clear()
        return None

    def query(
        self,
        command: str,
        expected: str | Pattern[str],
        timeout: float | None = None,
    ) -> re.Match[str]:
        pattern = re.compile(expected) if isinstance(expected, str) else expected
        actual_timeout = self.query_timeout if timeout is None else max(0.1, float(timeout))
        seen: list[str] = []

        with self._lock:
            port = self._open_locked()
            deadline = time.monotonic() + actual_timeout
            try:
                # AI is disabled, so old bytes are stale and should not be allowed
                # to satisfy a new query accidentally.
                port.reset_input_buffer()
                self._rx_buffer.clear()
                self._write_locked(command)
                while time.monotonic() < deadline:
                    message = self._read_message_locked(deadline)
                    if message is None:
                        break
                    seen.append(message)
                    if message == "?;":
                        raise SerialCatError(f"Radio rejected CAT command {command!r}")
                    match = pattern.fullmatch(message)
                    if match:
                        return match
            except SerialCatError:
                raise
            except (SerialException, OSError) as exc:
                self.close()
                raise SerialCatError(f"CAT-2 transaction failed on {self.device}: {exc}") from exc

        detail = f"; received {seen}" if seen else ""
        raise SerialCatTimeout(
            f"CAT-2 timeout on {self.device}: {self.normalize_command(command)}{detail}"
        )

    def test(self, timeout: float | None = None) -> str:
        return self.query("ID;", r"ID([^;]+);", timeout).group(1)

    # ---- Radio power ----------------------------------------------------------

    def read_power_state(self, timeout: float | None = None) -> str:
        match = self.query("PS;", r"PS([01]);", timeout)
        return "ON" if match.group(1) == "1" else "OFF"

    def set_power_state(self, enabled: bool) -> None:
        self.set("PS1;" if enabled else "PS0;")

    # ---- VFO and mode ---------------------------------------------------------

    def read_frequency(self, vfo: str, timeout: float | None = None) -> int:
        vfo = vfo.upper()
        if vfo not in {"A", "B"}:
            raise SerialCatError("VFO must be A or B")
        match = self.query(f"F{vfo};", rf"F{vfo}(\d{{9}});", timeout)
        return int(match.group(1))

    def set_frequency(self, vfo: str, frequency_hz: int) -> None:
        vfo = vfo.upper()
        frequency_hz = int(frequency_hz)
        if vfo not in {"A", "B"}:
            raise SerialCatError("VFO must be A or B")
        if not 30_000 <= frequency_hz <= 75_000_000:
            raise SerialCatError("Frequency outside FT-710 CAT range")
        self.set(f"F{vfo}{frequency_hz:09d};")

    def read_active_vfo(self, timeout: float | None = None) -> str:
        value = self.query("VS;", r"VS([01]);", timeout).group(1)
        return "A" if value == "0" else "B"

    def set_active_vfo(self, vfo: str) -> None:
        vfo = vfo.upper()
        if vfo not in {"A", "B"}:
            raise SerialCatError("VFO must be A or B")
        self.set("VS0;" if vfo == "A" else "VS1;")

    def swap_vfos(self) -> None:
        self.set("SV;")

    def copy_vfo_a_to_b(self) -> None:
        self.set("AB;")

    def copy_vfo_b_to_a(self) -> None:
        self.set("BA;")

    # ---- Memory channels -----------------------------------------------------

    @staticmethod
    def _memory_slot(slot: int) -> int:
        slot = int(slot)
        if not 1 <= slot <= 99:
            raise SerialCatError("Memory channel must be between 001 and 099")
        return slot

    def read_operating_context(self, timeout: float | None = None) -> dict[str, Any]:
        match = self.query(
            "IF;",
            r"IF(?P<channel>[0-9A-Z]{3})(?P<frequency>\d{9})"
            r"(?P<clarifier>[+-]\d{4})(?P<rx_clar>[01])(?P<tx_clar>[01])"
            r"(?P<mode>[0-9A-F])(?P<state>[0-5])(?P<ctcss>[0-2])"
            r"(?P<ctcss_number>\d{2})(?P<shift>[0-2]);",
            timeout,
        )
        clarifier = match.group("clarifier")
        return {
            "channel": match.group("channel"),
            "frequency_hz": int(match.group("frequency")),
            "clarifier_offset_hz": int(clarifier),
            "rx_clarifier": match.group("rx_clar") == "1",
            "tx_clarifier": match.group("tx_clar") == "1",
            "mode": MODE_CODE_TO_NAME.get(match.group("mode"), f"UNKNOWN-{match.group('mode')}"),
            "operating_state": {
                "0": "VFO", "1": "MEMORY", "2": "MEMORY_TUNE",
                "3": "QMB", "5": "PMS",
            }.get(match.group("state"), "UNKNOWN"),
            "ctcss_mode": int(match.group("ctcss")),
            "ctcss_number": int(match.group("ctcss_number")),
            "repeater_shift": int(match.group("shift")),
        }

    def read_memory(self, slot: int, timeout: float | None = None) -> dict[str, Any] | None:
        slot = self._memory_slot(slot)
        try:
            match = self.query(
                f"MR{slot:03d};",
                r"MR(?P<channel>[0-9A-Z]{3})(?P<frequency>\d{9})"
                r"(?P<clarifier>[+-]\d{4})(?P<rx_clar>[01])(?P<tx_clar>[01])"
                r"(?P<mode>[0-9A-F])(?P<state>[0-5])(?P<ctcss>[0-2])"
                r"(?P<ctcss_number>\d{2})(?P<shift>[0-2]);",
                timeout,
            )
        except SerialCatError as exc:
            # Empty FT-710 memory channels are rejected with "?;".
            if "Radio rejected CAT command" in str(exc):
                return None
            raise

        frequency_hz = int(match.group("frequency"))
        mode_code = match.group("mode")
        channel = match.group("channel")
        if channel == "000" or frequency_hz == 0 or mode_code == "0":
            return None
        clarifier = match.group("clarifier")
        return {
            "slot": slot,
            "radio_channel": channel,
            "frequency_hz": frequency_hz,
            "clarifier_offset_hz": int(clarifier),
            "rx_clarifier": match.group("rx_clar") == "1",
            "tx_clarifier": match.group("tx_clar") == "1",
            "mode": MODE_CODE_TO_NAME.get(mode_code, f"UNKNOWN-{mode_code}"),
            "operating_state": int(match.group("state")),
            "ctcss_mode": int(match.group("ctcss")),
            "ctcss_number": int(match.group("ctcss_number")),
            "repeater_shift": int(match.group("shift")),
        }

    def read_memory_tag(self, slot: int, timeout: float | None = None) -> dict[str, Any]:
        slot = self._memory_slot(slot)
        match = self.query(
            f"MT{slot:03d};",
            r"MT(?P<channel>\d{3})(?P<enabled>[01])(?P<tag>[ -~]{12});",
            timeout,
        )
        return {
            "slot": slot,
            "tag_enabled": match.group("enabled") == "1",
            "tag": match.group("tag").rstrip(),
        }

    def write_memory(
        self,
        slot: int,
        frequency_hz: int,
        mode_name: str,
        *,
        clarifier_offset_hz: int = 0,
        rx_clarifier: bool = False,
        tx_clarifier: bool = False,
        ctcss_mode: int = 0,
        ctcss_number: int = 0,
        repeater_shift: int = 0,
    ) -> None:
        slot = self._memory_slot(slot)
        frequency_hz = int(frequency_hz)
        if not 30_000 <= frequency_hz <= 75_000_000:
            raise SerialCatError("Frequency outside FT-710 CAT range")
        try:
            mode_code = MODE_NAME_TO_CODE[mode_name.upper()]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported memory mode: {mode_name}") from exc
        clarifier_offset_hz = int(clamp(int(clarifier_offset_hz), -9990, 9990))
        clarifier = f"{clarifier_offset_hz:+05d}"
        if ctcss_mode not in {0, 1, 2}:
            raise SerialCatError("CTCSS mode must be 0, 1 or 2")
        if not 0 <= int(ctcss_number) <= 99:
            raise SerialCatError("CTCSS number must be between 00 and 99")
        if repeater_shift not in {0, 1, 2}:
            raise SerialCatError("Repeater shift must be 0, 1 or 2")
        self.set(
            f"MW{slot:03d}{frequency_hz:09d}{clarifier}"
            f"{1 if rx_clarifier else 0}{1 if tx_clarifier else 0}"
            f"{mode_code}1{int(ctcss_mode)}{int(ctcss_number):02d}{int(repeater_shift)};"
        )

    def write_memory_tag(self, slot: int, tag: str) -> None:
        slot = self._memory_slot(slot)
        tag = str(tag).strip()
        if len(tag) > 12:
            raise SerialCatError("Memory tag is limited to 12 characters")
        if any(ord(char) < 32 or ord(char) > 126 or char == ";" for char in tag):
            raise SerialCatError("Memory tag must contain printable ASCII characters")
        enabled = "1" if tag else "0"
        self.set(f"MT{slot:03d}{enabled}{tag.ljust(12)};")

    def select_memory(self, slot: int) -> None:
        slot = self._memory_slot(slot)
        context = self.read_operating_context()
        if context["operating_state"] != "MEMORY":
            self.set("VM;")
            time.sleep(0.08)
        self.set(f"MC{slot:03d};")

    def copy_memory_to_vfo(self, slot: int, vfo: str = "A") -> None:
        vfo = vfo.upper()
        if vfo not in {"A", "B"}:
            raise SerialCatError("VFO must be A or B")

        memory = self.read_memory(slot)
        if memory is None:
            raise SerialCatError(f"Memory {int(slot):03d} is empty")

        # On the tested FT-710 firmware MA/MB may follow the VFO that was active
        # before entering memory mode, even though the CAT reference names a
        # fixed destination. Select the requested destination first so the two
        # web buttons are deterministic regardless of the starting VFO.
        self.set_active_vfo(vfo)
        time.sleep(0.08)
        self.select_memory(slot)
        time.sleep(0.08)
        self.set("MA;" if vfo == "A" else "MB;")
        time.sleep(0.12)

        # Firmware revisions may either remain in memory mode or return to VFO
        # after MA/MB. Read IF before using the toggle, so we never toggle back
        # into memory accidentally.
        context = self.read_operating_context()
        if context["operating_state"] != "VFO":
            self.set("VM;")
            time.sleep(0.08)

        self.set_active_vfo(vfo)
        time.sleep(0.08)

        # Verify the destination. If this firmware still applies MA/MB to the
        # current side, force the documented memory frequency and mode directly
        # into the requested VFO as a safe fallback.
        if self.read_frequency(vfo) != memory["frequency_hz"]:
            active_vfo = self.read_active_vfo()
            self.set_frequency(vfo, memory["frequency_hz"])
            time.sleep(0.06)
            self.set_mode(vfo, active_vfo, memory["mode"])
            time.sleep(0.06)
            self.set_active_vfo(vfo)

    def read_main_sub_modes(self, timeout: float | None = None) -> tuple[str, str]:
        main_code = self.query("MD0;", r"MD0([0-9A-F]);", timeout).group(1)
        sub_code = self.query("MD1;", r"MD1([0-9A-F]);", timeout).group(1)
        return (
            MODE_CODE_TO_NAME.get(main_code, f"UNKNOWN-{main_code}"),
            MODE_CODE_TO_NAME.get(sub_code, f"UNKNOWN-{sub_code}"),
        )

    def read_vfo_modes(
        self,
        active_vfo: str | None = None,
        timeout: float | None = None,
    ) -> tuple[str, str]:
        active = active_vfo or self.read_active_vfo(timeout)
        main_mode, sub_mode = self.read_main_sub_modes(timeout)
        return (main_mode, sub_mode) if active == "A" else (sub_mode, main_mode)

    def set_mode(self, vfo: str, active_vfo: str, mode_name: str) -> None:
        try:
            code = MODE_NAME_TO_CODE[mode_name]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported mode: {mode_name}") from exc
        vfo = vfo.upper()
        active_vfo = active_vfo.upper()
        if vfo not in {"A", "B"} or active_vfo not in {"A", "B"}:
            raise SerialCatError("VFO must be A or B")
        band = "0" if vfo == active_vfo else "1"
        self.set(f"MD{band}{code};")

    # ---- Core controls and status --------------------------------------------

    def set_ptt(self, enabled: bool) -> None:
        # TX1 keys the transmitter under CAT control. TX0 always releases it.
        self.set("TX1;" if enabled else "TX0;")

    # ---- CW keyer ------------------------------------------------------------

    def set_break_in(self, enabled: bool) -> None:
        self.set(f"BI{1 if enabled else 0};")

    def set_cw_keyer(self, enabled: bool) -> None:
        self.set(f"KR{1 if enabled else 0};")

    def set_cw_speed(self, wpm: int) -> None:
        wpm = int(clamp(int(wpm), 4, 60))
        self.set(f"KS{wpm:03d};")

    def write_cw_memory(self, slot: int, message: str) -> None:
        slot = int(slot)
        if slot not in {1, 2, 3, 4, 5}:
            raise SerialCatError("CW memory slot must be between 1 and 5")
        if not message or len(message) > 50:
            raise SerialCatError("CW message must contain 1 to 50 characters")
        if ";" in message or "\r" in message or "\n" in message:
            raise SerialCatError("CW message contains an invalid CAT character")
        self.set(f"KM{slot}{message};")

    def play_cw_text_memory(self, slot: int) -> None:
        slot = int(slot)
        if slot not in {1, 2, 3, 4, 5}:
            raise SerialCatError("CW memory slot must be between 1 and 5")
        # KY P1=0 selects CW TEXT memory; P2 selects slot 1..5.
        self.set(f"KY0{slot};")

    def stop_cw(self) -> None:
        # KY00 stops CW text-memory playback.
        self.set("KY00;")

    def send_cw_text(self, message: str, wpm: int, slot: int = 5) -> None:
        # Keep the transaction serialized on CAT-2 and leave a tiny inter-command
        # gap for the radio firmware. The keyer and break-in are intentionally
        # left enabled after playback, matching normal front-panel CW operation.
        self.set_cw_speed(wpm)
        time.sleep(0.04)
        self.set_cw_keyer(True)
        time.sleep(0.04)
        self.set_break_in(True)
        time.sleep(0.04)
        # Keep the transceiver in TX through normal inter-character and
        # inter-word gaps. SD13 is a 1000 ms semi break-in delay on the FT-710.
        self.set("SD13;")
        time.sleep(0.04)
        self.write_cw_memory(slot, message)
        time.sleep(0.08)
        self.play_cw_text_memory(slot)

    def read_tx_power(self, timeout: float | None = None) -> int:
        return int(self.query("PC;", r"PC(\d{3});", timeout).group(1))

    def set_tx_power(self, watts: int) -> None:
        watts = int(clamp(int(watts), 5, 100))
        self.set(f"PC{watts:03d};")

    def read_rf_gain(self, timeout: float | None = None) -> int:
        return int(self.query("RG0;", r"RG0(\d{3});", timeout).group(1))

    def set_rf_gain(self, value: int) -> None:
        value = int(clamp(int(value), 0, 255))
        self.set(f"RG0{value:03d};")

    def read_tuner_state(self, timeout: float | None = None) -> str:
        match = self.query("AC;", r"AC0([02])([013]);", timeout)
        return {"0": "OFF", "1": "ON", "3": "TUNING"}.get(match.group(2), "UNKNOWN")

    def tuner_enable(self) -> None:
        self.set("AC001;")

    def tuner_disable(self) -> None:
        self.set("AC000;")

    def tuner_start(self) -> None:
        self.set("AC003;")

    def read_radio_info(self, timeout: float | None = None) -> dict[str, Any]:
        match = self.query("RI0;", r"RI0([01])([012])([012])0([01])([012])([01]);", timeout)
        return {
            "hi_swr": match.group(1) == "1",
            "recording_state": {"0": "STOP", "1": "RECORDING", "2": "PLAYING"}.get(match.group(2)),
            "tx_state": {"0": "RX", "1": "TX", "2": "TX INHIBIT"}.get(match.group(3), "UNKNOWN"),
            "tuner_busy": match.group(4) == "1",
            "scan_state": {"0": "STOP", "1": "SCANNING", "2": "PAUSE"}.get(match.group(5)),
            "squelch_open": match.group(6) == "1",
        }

    # ---- Receiver front end ---------------------------------------------------

    def read_preamp(self, timeout: float | None = None) -> str:
        code = self.query("PA0;", r"PA0([012]);", timeout).group(1)
        return PREAMP_CODE_TO_NAME[code]

    def set_preamp(self, name: str) -> None:
        try:
            code = PREAMP_NAME_TO_CODE[name.upper()]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported preamp setting: {name}") from exc
        self.set(f"PA0{code};")

    def read_attenuator(self, timeout: float | None = None) -> int:
        code = self.query("RA0;", r"RA0([0123]);", timeout).group(1)
        return ATTENUATOR_CODE_TO_DB[code]

    def set_attenuator(self, db: int) -> None:
        try:
            code = ATTENUATOR_DB_TO_CODE[int(db)]
        except (KeyError, ValueError) as exc:
            raise SerialCatError("Attenuator must be 0, 6, 12 or 18 dB") from exc
        self.set(f"RA0{code};")

    # ---- DSP noise controls ---------------------------------------------------

    def read_dnr(self, timeout: float | None = None) -> bool:
        return self.query("NR0;", r"NR0([01]);", timeout).group(1) == "1"

    def set_dnr(self, enabled: bool) -> None:
        self.set(f"NR0{1 if enabled else 0};")

    def read_dnr_level(self, timeout: float | None = None) -> int:
        return int(self.query("RL0;", r"RL0(\d{2});", timeout).group(1))

    def set_dnr_level(self, level: int) -> None:
        level = int(clamp(int(level), 1, 15))
        self.set(f"RL0{level:02d};")

    def read_noise_blanker(self, timeout: float | None = None) -> bool:
        return self.query("NB0;", r"NB0([01]);", timeout).group(1) == "1"

    def set_noise_blanker(self, enabled: bool) -> None:
        self.set(f"NB0{1 if enabled else 0};")

    def read_noise_blanker_level(self, timeout: float | None = None) -> int:
        return int(self.query("NL0;", r"NL0(\d{3});", timeout).group(1))

    def set_noise_blanker_level(self, level: int) -> None:
        level = int(clamp(int(level), 0, 10))
        self.set(f"NL0{level:03d};")

    def read_auto_notch(self, timeout: float | None = None) -> bool:
        return self.query("BC0;", r"BC0([01]);", timeout).group(1) == "1"

    def set_auto_notch(self, enabled: bool) -> None:
        self.set(f"BC0{1 if enabled else 0};")

    # ---- Display --------------------------------------------------------------

    def read_meter_display(self, timeout: float | None = None) -> str:
        code = self.query("MS;", r"MS([0-5])0;", timeout).group(1)
        return METER_CODE_TO_NAME[code]

    def set_meter_display(self, name: str) -> None:
        try:
            code = METER_NAME_TO_CODE[name.upper()]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported meter display: {name}") from exc
        self.set(f"MS{code}0;")

    def read_scope_mode(self, timeout: float | None = None) -> str:
        code = self.query("SS06;", r"SS06([0-9A])0000;", timeout).group(1)
        return SCOPE_MODE_CODE_TO_NAME.get(code, f"UNKNOWN-{code}")

    def set_scope_mode(self, name: str) -> None:
        try:
            code = SCOPE_MODE_NAME_TO_CODE[name.upper()]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported scope mode: {name}") from exc
        self.set(f"SS06{code}0000;")

    def read_scope_speed(self, timeout: float | None = None) -> str:
        code = self.query("SS00;", r"SS00([0-5])0000;", timeout).group(1)
        return SCOPE_SPEED_CODE_TO_NAME[code]

    def set_scope_speed(self, name: str) -> None:
        try:
            code = SCOPE_SPEED_NAME_TO_CODE[name.upper()]
        except KeyError as exc:
            raise SerialCatError(f"Unsupported scope speed: {name}") from exc
        self.set(f"SS00{code}0000;")

    def read_scope_span(self, timeout: float | None = None) -> str:
        code = self.query("SS05;", r"SS05([0-9])0000;", timeout).group(1)
        return SCOPE_SPAN_CODE_TO_NAME[code]

    def set_scope_span(self, name: str) -> None:
        # Keep the human-readable case from the public mapping, but compare
        # case-insensitively because API clients may send "1 KHZ".
        normalized = name.strip().lower()
        for public_name, code in SCOPE_SPAN_NAME_TO_CODE.items():
            if public_name.lower() == normalized:
                self.set(f"SS05{code}0000;")
                return
        raise SerialCatError(f"Unsupported scope span: {name}")

    # ---- Raw CAT diagnostics --------------------------------------------------

    def raw_exchange(self, command: str, timeout: float | None = None) -> str:
        normalized = self.normalize_command(command)
        prefix = re.escape(normalized[:2])
        return self.query(normalized, rf"({prefix}[^;]*;)", timeout).group(1)

    def raw_set(self, command: str) -> None:
        self.set(command)
