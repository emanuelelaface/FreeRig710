from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


RADIO_FIELDS = (
    "frequency_hz",
    "mode",
    "tag",
    "tag_enabled",
    "clarifier_offset_hz",
    "rx_clarifier",
    "tx_clarifier",
    "ctcss_mode",
    "ctcss_number",
    "repeater_shift",
)


class MemoryRepository:
    """Small SQLite cache for FT-710 memories and web-only metadata."""

    def __init__(self, database_path: str) -> None:
        self.database_path = Path(database_path).expanduser()
        self._lock = threading.RLock()

    def initialize(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 99),
                    present INTEGER NOT NULL DEFAULT 0,
                    frequency_hz INTEGER,
                    mode TEXT,
                    tag TEXT NOT NULL DEFAULT '',
                    tag_enabled INTEGER NOT NULL DEFAULT 0,
                    clarifier_offset_hz INTEGER NOT NULL DEFAULT 0,
                    rx_clarifier INTEGER NOT NULL DEFAULT 0,
                    tx_clarifier INTEGER NOT NULL DEFAULT 0,
                    ctcss_mode INTEGER NOT NULL DEFAULT 0,
                    ctcss_number INTEGER NOT NULL DEFAULT 0,
                    repeater_shift INTEGER NOT NULL DEFAULT 0,
                    category TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    hidden INTEGER NOT NULL DEFAULT 0,
                    synced_at TEXT,
                    metadata_updated_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_memories_present_hidden
                    ON memories (present, hidden, slot);
                """
            )
            # Version 1.12.2 removes the panel-only Delete/Hide feature.
            # Make any records hidden by 1.12.1 visible again.
            connection.execute("UPDATE memories SET hidden = 0 WHERE hidden <> 0")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _normalize_slot(slot: int) -> int:
        value = int(slot)
        if not 1 <= value <= 99:
            raise ValueError("Memory channel must be between 001 and 099")
        return value

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        for key in ("present", "tag_enabled", "rx_clarifier", "tx_clarifier", "hidden"):
            result[key] = bool(result[key])
        return result

    def list(self, *, include_hidden: bool = False, include_empty: bool = False) -> list[dict[str, Any]]:
        conditions = []
        parameters: list[Any] = []
        if not include_hidden:
            conditions.append("hidden = 0")
        if not include_empty:
            conditions.append("present = 1")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM memories {where} ORDER BY slot",
                parameters,
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def get(self, slot: int) -> dict[str, Any] | None:
        slot = self._normalize_slot(slot)
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM memories WHERE slot = ?", (slot,)).fetchone()
        return self._row_to_dict(row) if row else None

    def upsert_radio(self, memory: dict[str, Any]) -> dict[str, Any]:
        slot = self._normalize_slot(memory["slot"])
        values = {field: memory.get(field) for field in RADIO_FIELDS}
        values["tag"] = values.get("tag") or ""
        values["tag_enabled"] = int(bool(values.get("tag_enabled")))
        values["rx_clarifier"] = int(bool(values.get("rx_clarifier")))
        values["tx_clarifier"] = int(bool(values.get("tx_clarifier")))
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO memories (
                    slot, present, frequency_hz, mode, tag, tag_enabled,
                    clarifier_offset_hz, rx_clarifier, tx_clarifier,
                    ctcss_mode, ctcss_number, repeater_shift, synced_at
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(slot) DO UPDATE SET
                    present = 1,
                    frequency_hz = excluded.frequency_hz,
                    mode = excluded.mode,
                    tag = excluded.tag,
                    tag_enabled = excluded.tag_enabled,
                    clarifier_offset_hz = excluded.clarifier_offset_hz,
                    rx_clarifier = excluded.rx_clarifier,
                    tx_clarifier = excluded.tx_clarifier,
                    ctcss_mode = excluded.ctcss_mode,
                    ctcss_number = excluded.ctcss_number,
                    repeater_shift = excluded.repeater_shift,
                    synced_at = excluded.synced_at
                """,
                (
                    slot,
                    values["frequency_hz"],
                    values["mode"],
                    values["tag"],
                    values["tag_enabled"],
                    values.get("clarifier_offset_hz") or 0,
                    values["rx_clarifier"],
                    values["tx_clarifier"],
                    values.get("ctcss_mode") or 0,
                    values.get("ctcss_number") or 0,
                    values.get("repeater_shift") or 0,
                    now,
                ),
            )
        return self.get(slot) or {}

    def mark_empty(self, slot: int) -> None:
        slot = self._normalize_slot(slot)
        now = self._now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO memories (slot, present, synced_at)
                VALUES (?, 0, ?)
                ON CONFLICT(slot) DO UPDATE SET
                    present = 0,
                    frequency_hz = NULL,
                    mode = NULL,
                    tag = '',
                    tag_enabled = 0,
                    clarifier_offset_hz = 0,
                    rx_clarifier = 0,
                    tx_clarifier = 0,
                    ctcss_mode = 0,
                    ctcss_number = 0,
                    repeater_shift = 0,
                    synced_at = excluded.synced_at
                """,
                (slot, now),
            )

    def update_metadata(
        self,
        slot: int,
        *,
        category: str | None = None,
        note: str | None = None,
        hidden: bool | None = None,
    ) -> dict[str, Any]:
        slot = self._normalize_slot(slot)
        assignments = []
        values: list[Any] = []
        if category is not None:
            assignments.append("category = ?")
            values.append(category.strip()[:24])
        if note is not None:
            assignments.append("note = ?")
            values.append(note.strip()[:240])
        if hidden is not None:
            assignments.append("hidden = ?")
            values.append(int(bool(hidden)))
        if not assignments:
            existing = self.get(slot)
            if existing is None:
                raise KeyError(slot)
            return existing
        assignments.append("metadata_updated_at = ?")
        values.append(self._now())
        values.append(slot)
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO memories (slot) VALUES (?) ON CONFLICT(slot) DO NOTHING",
                (slot,),
            )
            connection.execute(
                f"UPDATE memories SET {', '.join(assignments)} WHERE slot = ?",
                values,
            )
        return self.get(slot) or {}

    def first_cached_free_slot(self) -> int | None:
        with self._lock, self._connect() as connection:
            occupied = {
                int(row[0])
                for row in connection.execute("SELECT slot FROM memories WHERE present = 1")
            }
        return next((slot for slot in range(1, 100) if slot not in occupied), None)

    def replace_radio_snapshot(self, memories: Iterable[dict[str, Any]], empty_slots: Iterable[int]) -> None:
        for memory in memories:
            self.upsert_radio(memory)
        for slot in empty_slots:
            self.mark_empty(slot)
