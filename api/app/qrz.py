from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode
from urllib.request import Request, urlopen


class QrzLogbookError(RuntimeError):
    """Raised when a QRZ Logbook operation cannot be completed."""


_CALL_RE = re.compile(r"^[A-Z0-9/]{3,16}$")

# ADIF nominal band limits. They identify the logbook band; they are not a
# regulatory band plan and do not grant permission to transmit.
_BANDS: tuple[tuple[int, int, str], ...] = (
    (135_700, 137_800, "2190m"),
    (472_000, 479_000, "630m"),
    (1_800_000, 2_000_000, "160m"),
    (3_500_000, 4_000_000, "80m"),
    (5_060_000, 5_450_000, "60m"),
    (7_000_000, 7_300_000, "40m"),
    (10_100_000, 10_150_000, "30m"),
    (14_000_000, 14_350_000, "20m"),
    (18_068_000, 18_168_000, "17m"),
    (21_000_000, 21_450_000, "15m"),
    (24_890_000, 24_990_000, "12m"),
    (28_000_000, 29_700_000, "10m"),
    (50_000_000, 54_000_000, "6m"),
    (70_000_000, 71_000_000, "4m"),
)

_OVERRIDE_MODES: dict[str, tuple[str, str | None]] = {
    "FT8": ("FT8", None),
    "FT4": ("MFSK", "FT4"),
    "PSK31": ("PSK", "PSK31"),
    "RTTY": ("RTTY", None),
    "SSB": ("SSB", None),
    "CW": ("CW", None),
    "AM": ("AM", None),
    "FM": ("FM", None),
    "SSTV": ("SSTV", None),
}


def normalize_callsign(value: str) -> str:
    callsign = value.strip().upper()
    if not _CALL_RE.fullmatch(callsign):
        raise QrzLogbookError("Invalid callsign. Use 3-16 letters, digits or '/'.")
    return callsign


def band_from_frequency(frequency_hz: int) -> str:
    for lower, upper, band in _BANDS:
        if lower <= frequency_hz <= upper:
            return band
    raise QrzLogbookError(
        f"Frequency {frequency_hz / 1_000_000:.6f} MHz is outside the supported amateur bands"
    )


def adif_mode(radio_mode: str, override: str = "AUTO") -> tuple[str, str | None]:
    normalized_override = override.strip().upper()
    normalized_radio = radio_mode.strip().upper()

    if normalized_override != "AUTO":
        try:
            mode, submode = _OVERRIDE_MODES[normalized_override]
        except KeyError as exc:
            raise QrzLogbookError(f"Unsupported QRZ log mode: {override}") from exc
        if mode == "SSB" and normalized_radio in {"USB", "LSB"}:
            submode = normalized_radio
        return mode, submode

    if normalized_radio in {"USB", "LSB"}:
        return "SSB", normalized_radio
    if normalized_radio in {"CW-U", "CW-L"}:
        return "CW", None
    if normalized_radio in {"AM", "AM-N"}:
        return "AM", None
    if normalized_radio in {"FM", "FM-N"}:
        return "FM", None
    if normalized_radio in {"RTTY-L", "RTTY-U"}:
        return "RTTY", None
    if normalized_radio in {"DATA-L", "DATA-U"}:
        raise QrzLogbookError(
            "The radio reports DATA mode. Select the actual QRZ mode, for example FT8, FT4, RTTY or PSK31."
        )
    raise QrzLogbookError(f"Radio mode {radio_mode!r} cannot be mapped to ADIF")


def _field(name: str, value: object | None) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    return f"<{name.upper()}:{len(text)}>{text}"


def _frequency_mhz(frequency_hz: int) -> str:
    return f"{frequency_hz / 1_000_000:.6f}".rstrip("0").rstrip(".")


@dataclass(frozen=True, slots=True)
class QrzLogbookSettings:
    api_key: str
    station_callsign: str
    endpoint: str
    user_agent: str
    timeout: float

    @classmethod
    def from_environment(cls) -> "QrzLogbookSettings":
        station = os.getenv("FT710_QRZ_STATION_CALLSIGN", "").strip().upper()
        default_agent = f"FreeRig710/1.19.0 ({station or 'unconfigured'})"
        try:
            timeout = float(os.getenv("FT710_QRZ_TIMEOUT", "10"))
        except ValueError:
            timeout = 10.0
        return cls(
            api_key=os.getenv("FT710_QRZ_LOGBOOK_KEY", "").strip(),
            station_callsign=station,
            endpoint=os.getenv("FT710_QRZ_ENDPOINT", "https://logbook.qrz.com/api").strip(),
            user_agent=os.getenv("FT710_QRZ_USER_AGENT", default_agent).strip()[:128],
            timeout=max(1.0, timeout),
        )


class QrzLogbookClient:
    def __init__(self, settings: QrzLogbookSettings | None = None) -> None:
        self.settings = settings or QrzLogbookSettings.from_environment()

    @property
    def configured(self) -> bool:
        return bool(self.settings.api_key and self.settings.station_callsign)

    def public_status(self) -> dict[str, object]:
        return {
            "configured": self.configured,
            "station_callsign": self.settings.station_callsign or None,
            "endpoint": self.settings.endpoint,
        }

    def insert_qso(
        self,
        *,
        call: str,
        timestamp_utc: datetime,
        frequency_hz: int,
        rx_frequency_hz: int | None,
        radio_mode: str,
        mode_override: str,
        tx_power_w: int | None,
    ) -> dict[str, object]:
        if not self.configured:
            raise QrzLogbookError(
                "QRZ Log is not configured. Set FT710_QRZ_LOGBOOK_KEY and FT710_QRZ_STATION_CALLSIGN."
            )

        call = normalize_callsign(call)
        station = normalize_callsign(self.settings.station_callsign)
        band = band_from_frequency(frequency_hz)
        mode, submode = adif_mode(radio_mode, mode_override)

        fields = [
            _field("CALL", call),
            _field("STATION_CALLSIGN", station),
            _field("QSO_DATE", timestamp_utc.strftime("%Y%m%d")),
            _field("TIME_ON", timestamp_utc.strftime("%H%M%S")),
            _field("BAND", band),
            _field("FREQ", _frequency_mhz(frequency_hz)),
            _field("MODE", mode),
            _field("SUBMODE", submode),
            _field("FREQ_RX", _frequency_mhz(rx_frequency_hz) if rx_frequency_hz and rx_frequency_hz != frequency_hz else None),
            _field("TX_PWR", tx_power_w),
            _field("MY_RIG", "Yaesu FT-710"),
            "<EOR>",
        ]
        adif = "".join(part for part in fields if part)
        data = urlencode(
            {
                "KEY": self.settings.api_key,
                "ACTION": "INSERT",
                "ADIF": adif,
            }
        ).encode("utf-8")
        request = Request(
            self.settings.endpoint,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": self.settings.user_agent,
            },
        )

        try:
            with urlopen(request, timeout=self.settings.timeout) as response:
                response_text = response.read().decode("utf-8", errors="replace").strip()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            raise QrzLogbookError(f"QRZ HTTP {exc.code}: {detail or exc.reason}") from exc
        except URLError as exc:
            raise QrzLogbookError(f"Cannot reach QRZ Logbook: {exc.reason}") from exc
        except TimeoutError as exc:
            raise QrzLogbookError("QRZ Logbook request timed out") from exc

        parsed = {
            key.upper(): values[-1]
            for key, values in parse_qs(response_text, keep_blank_values=True).items()
        }
        result = parsed.get("RESULT", "").upper()
        if result not in {"OK", "REPLACE"}:
            reason = parsed.get("REASON") or response_text or "Unknown QRZ response"
            raise QrzLogbookError(f"QRZ rejected the QSO: {reason}")

        logid = parsed.get("LOGID") or parsed.get("LOGIDS")
        return {
            "result": result,
            "logid": logid,
            "call": call,
            "station_callsign": station,
            "qso_date": timestamp_utc.strftime("%Y%m%d"),
            "time_on": timestamp_utc.strftime("%H%M%S"),
            "band": band,
            "frequency_hz": frequency_hz,
            "rx_frequency_hz": rx_frequency_hz if rx_frequency_hz != frequency_hz else None,
            "mode": mode,
            "submode": submode,
            "radio_mode": radio_mode,
            "tx_power_w": tx_power_w,
        }
