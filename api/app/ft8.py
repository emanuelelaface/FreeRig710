from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, TextIO

LOGGER = logging.getLogger(__name__)


class FT8ManagerError(RuntimeError):
    pass


class FT8NoVNCManager:
    """Start, stop and inspect WSJT-X through TigerVNC + noVNC.

    TigerVNC only listens on localhost and deliberately uses SecurityTypes=None.
    websockify serves the noVNC files on the configured LAN address. Public
    authentication is therefore delegated to the HTTPS Apache reverse proxy.
    """

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self._lock = threading.RLock()
        self._last_error: str | None = None
        self._last_action: str | None = None
        self._websockify_process: subprocess.Popen[str] | None = None
        self._websockify_log: TextIO | None = None

    def _environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": self.settings.ft8_home,
                "USER": self.settings.ft8_user,
                "LOGNAME": self.settings.ft8_user,
                "XDG_RUNTIME_DIR": self.settings.ft8_xdg_runtime_dir,
                "PULSE_SERVER": self.settings.ft8_pulse_server,
                "DBUS_SESSION_BUS_ADDRESS": self.settings.ft8_dbus_session_bus_address,
            }
        )
        return environment

    @staticmethod
    def _port_listening(port: int) -> bool:
        """Check Linux listening sockets without opening a client connection.

        A raw TCP probe against TigerVNC is counted as an unauthenticated VNC
        attempt. Repeated status polling would therefore blacklist localhost.
        Reading /proc avoids touching the service being inspected.
        """
        wanted_port = f"{port:04X}"
        for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
            try:
                lines = table.read_text(encoding="ascii").splitlines()[1:]
            except OSError:
                continue
            for line in lines:
                fields = line.split()
                if len(fields) < 4:
                    continue
                local_address = fields[1]
                state = fields[3]
                try:
                    local_port = local_address.rsplit(":", 1)[1].upper()
                except IndexError:
                    continue
                if state == "0A" and local_port == wanted_port:
                    return True
        return False

    def _vnc_open(self) -> bool:
        return self._port_listening(self.settings.ft8_vnc_port)

    def _web_open(self) -> bool:
        return self._port_listening(self.settings.ft8_bind_port)

    def is_running(self) -> bool:
        return self._vnc_open() and self._web_open()

    def status(self) -> dict[str, Any]:
        vnc_running = self._vnc_open()
        web_running = self._web_open()
        return {
            "enabled": bool(self.settings.ft8_enabled),
            "running": vnc_running and web_running,
            "backend": "novnc",
            "display": self.settings.ft8_display,
            "url": self.settings.ft8_url,
            "bind_host": self.settings.ft8_bind_host,
            "bind_port": self.settings.ft8_bind_port,
            "vnc_host": self.settings.ft8_vnc_host,
            "vnc_port": self.settings.ft8_vnc_port,
            "vnc_running": vnc_running,
            "websockify_running": web_running,
            "vnc_authentication": False,
            "last_action": self._last_action,
            "last_error": self._last_error,
        }

    def _vnc_start_command(self) -> list[str]:
        return [
            self.settings.tigervncserver_binary,
            self.settings.ft8_display,
            "-geometry",
            self.settings.ft8_geometry,
            "-depth",
            str(self.settings.ft8_depth),
            "-localhost",
            "yes",
            "-SecurityTypes",
            "None",
        ]

    def _vnc_stop_command(self) -> list[str]:
        return [
            self.settings.tigervncserver_binary,
            "-kill",
            self.settings.ft8_display,
        ]

    def _websockify_command(self) -> list[str]:
        return [
            self.settings.websockify_binary,
            f"--web={self.settings.novnc_web_root}",
            f"{self.settings.ft8_bind_host}:{self.settings.ft8_bind_port}",
            f"{self.settings.ft8_vnc_host}:{self.settings.ft8_vnc_port}",
        ]

    def _run(self, command: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                command,
                cwd=self.settings.ft8_working_directory,
                env=self._environment(),
                text=True,
                capture_output=True,
                timeout=timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise FT8ManagerError(f"Executable not found: {exc.filename}") from exc
        except subprocess.TimeoutExpired as exc:
            raise FT8ManagerError(f"Command timed out: {' '.join(command)}") from exc
        except OSError as exc:
            raise FT8ManagerError(f"Could not run {' '.join(command)}: {exc}") from exc

    @staticmethod
    def _details(process: subprocess.CompletedProcess[str]) -> str:
        details = "\n".join(
            value.strip()
            for value in (process.stdout or "", process.stderr or "")
            if value.strip()
        )
        return details or f"exit code {process.returncode}"

    def _wait_for_port(self, host: str, port: int, expected: bool, timeout: float) -> bool:
        del host  # All managed endpoints are local to this Raspberry Pi.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._port_listening(port) is expected:
                return True
            time.sleep(0.20)
        return self._port_listening(port) is expected

    def _validate_installation(self) -> None:
        required_executables = (
            self.settings.tigervncserver_binary,
            self.settings.websockify_binary,
        )
        for executable in required_executables:
            path = Path(executable)
            if not path.exists():
                raise FT8ManagerError(f"Executable not found: {path}")
            if not os.access(path, os.X_OK):
                raise FT8ManagerError(f"Executable is not runnable: {path}")

        web_root = Path(self.settings.novnc_web_root)
        if not (web_root / "vnc.html").is_file():
            raise FT8ManagerError(f"noVNC web root is invalid: {web_root}")

        xstartup = Path(self.settings.ft8_xstartup)
        if not xstartup.is_file():
            raise FT8ManagerError(f"TigerVNC xstartup not found: {xstartup}")
        if not os.access(xstartup, os.X_OK):
            raise FT8ManagerError(f"TigerVNC xstartup is not executable: {xstartup}")

    def _read_pidfile(self) -> int | None:
        try:
            value = Path(self.settings.ft8_websockify_pidfile).read_text(encoding="ascii").strip()
            pid = int(value)
            return pid if pid > 1 else None
        except (OSError, ValueError):
            return None

    def _remove_pidfile(self) -> None:
        try:
            Path(self.settings.ft8_websockify_pidfile).unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            LOGGER.warning("Could not remove websockify pidfile: %s", exc)

    @staticmethod
    def _pid_exists(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _pid_matches_websockify(self, pid: int) -> bool:
        try:
            command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", "replace"
            )
        except OSError:
            return False
        return (
            "websockify" in command
            and f"{self.settings.ft8_bind_host}:{self.settings.ft8_bind_port}" in command
            and f"{self.settings.ft8_vnc_host}:{self.settings.ft8_vnc_port}" in command
        )

    def _matching_websockify_pids(self) -> set[int]:
        """Return every websockify parent/worker belonging to this FT8 bridge."""
        pids: set[int] = set()
        try:
            entries = Path("/proc").iterdir()
        except OSError:
            return pids

        for entry in entries:
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid > 1 and self._pid_matches_websockify(pid):
                pids.add(pid)
        return pids

    def _stop_websockify(self) -> None:
        process = self._websockify_process
        pids = self._matching_websockify_pids()

        if process is not None and process.poll() is None:
            pids.add(process.pid)

        pidfile_pid = self._read_pidfile()
        if (
            pidfile_pid is not None
            and self._pid_exists(pidfile_pid)
            and self._pid_matches_websockify(pidfile_pid)
        ):
            pids.add(pidfile_pid)

        # websockify forks one worker per connection. Terminate every matching
        # process, not just the parent stored in the pidfile.
        for pid in sorted(pids, reverse=True):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

        deadline = time.monotonic() + min(5.0, self.settings.ft8_shutdown_timeout)
        while time.monotonic() < deadline:
            remaining = {pid for pid in pids if self._pid_exists(pid)}
            if not remaining and not self._web_open():
                break
            time.sleep(0.10)

        for pid in sorted(pids, reverse=True):
            if self._pid_exists(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        if process is not None:
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
        self._websockify_process = None
        self._remove_pidfile()

        if self._websockify_log is not None:
            try:
                self._websockify_log.close()
            except OSError:
                pass
            self._websockify_log = None

    def _start_websockify(self) -> None:
        if self._web_open():
            return

        log_path = Path(self.settings.ft8_websockify_log)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        pid_path = Path(self.settings.ft8_websockify_pidfile)
        pid_path.parent.mkdir(parents=True, exist_ok=True)

        self._websockify_log = log_path.open("a", encoding="utf-8")
        command = self._websockify_command()
        LOGGER.info("Starting FT8 noVNC bridge: %s", " ".join(command))
        try:
            process = subprocess.Popen(
                command,
                cwd=self.settings.ft8_working_directory,
                env=self._environment(),
                text=True,
                stdin=subprocess.DEVNULL,
                stdout=self._websockify_log,
                stderr=subprocess.STDOUT,
            )
        except FileNotFoundError as exc:
            raise FT8ManagerError(f"Executable not found: {exc.filename}") from exc
        except OSError as exc:
            raise FT8ManagerError(f"Could not start websockify: {exc}") from exc

        self._websockify_process = process
        pid_path.write_text(f"{process.pid}\n", encoding="ascii")

        if not self._wait_for_port(
            self.settings.ft8_bind_host,
            self.settings.ft8_bind_port,
            True,
            self.settings.ft8_startup_timeout,
        ):
            return_code = process.poll()
            self._stop_websockify()
            raise FT8ManagerError(
                f"websockify did not open {self.settings.ft8_bind_host}:"
                f"{self.settings.ft8_bind_port}; exit code {return_code}"
            )

    def start(self) -> dict[str, Any]:
        if not self.settings.ft8_enabled:
            raise FT8ManagerError("FT8/noVNC control is disabled")

        with self._lock:
            self._validate_installation()

            if self.is_running():
                self._last_action = "already running"
                self._last_error = None
                return self.status()

            if self._web_open() and not self._vnc_open():
                # WSJT-X is the foreground process in xstartup. Closing it makes
                # TigerVNC exit, while websockify can remain alive. Clean that
                # orphan automatically so a second FT8 ON starts normally.
                LOGGER.warning(
                    "Cleaning orphaned FT8 websockify on %s:%s",
                    self.settings.ft8_bind_host,
                    self.settings.ft8_bind_port,
                )
                self._stop_websockify()
                if not self._wait_for_port(
                    self.settings.ft8_bind_host,
                    self.settings.ft8_bind_port,
                    False,
                    self.settings.ft8_shutdown_timeout,
                ):
                    raise FT8ManagerError(
                        f"Port {self.settings.ft8_bind_host}:{self.settings.ft8_bind_port} "
                        "is occupied by a process that is not the managed FT8 websockify"
                    )

            if not self._vnc_open():
                # Clear stale TigerVNC state left behind by an interrupted session.
                self._run(self._vnc_stop_command(), min(5.0, self.settings.ft8_stop_timeout))

                command = self._vnc_start_command()
                LOGGER.info("Starting FT8 TigerVNC session: %s", " ".join(command))
                process = self._run(command, self.settings.ft8_start_command_timeout)
                if process.returncode != 0 and not self._vnc_open():
                    self._last_error = self._details(process)
                    raise FT8ManagerError(f"TigerVNC start failed: {self._last_error}")

                if not self._wait_for_port(
                    self.settings.ft8_vnc_host,
                    self.settings.ft8_vnc_port,
                    True,
                    self.settings.ft8_startup_timeout,
                ):
                    self._last_error = self._details(process)
                    raise FT8ManagerError(
                        f"TigerVNC did not open {self.settings.ft8_vnc_host}:"
                        f"{self.settings.ft8_vnc_port}: {self._last_error}"
                    )

            try:
                self._start_websockify()
            except Exception:
                self._run(self._vnc_stop_command(), self.settings.ft8_stop_timeout)
                raise

            self._last_action = "started"
            self._last_error = None
            return self.status()

    def stop(self) -> dict[str, Any]:
        if not self.settings.ft8_enabled:
            raise FT8ManagerError("FT8/noVNC control is disabled")

        with self._lock:
            if not self._web_open() and not self._vnc_open():
                self._last_action = "already stopped"
                self._last_error = None
                self._remove_pidfile()
                return self.status()

            LOGGER.info("Stopping FT8 noVNC session")
            self._stop_websockify()

            process = self._run(self._vnc_stop_command(), self.settings.ft8_stop_timeout)
            if process.returncode != 0 and self._vnc_open():
                self._last_error = self._details(process)
                raise FT8ManagerError(f"TigerVNC stop failed: {self._last_error}")

            web_stopped = self._wait_for_port(
                self.settings.ft8_bind_host,
                self.settings.ft8_bind_port,
                False,
                self.settings.ft8_shutdown_timeout,
            )
            vnc_stopped = self._wait_for_port(
                self.settings.ft8_vnc_host,
                self.settings.ft8_vnc_port,
                False,
                self.settings.ft8_shutdown_timeout,
            )
            if not web_stopped or not vnc_stopped:
                self._last_error = (
                    f"Shutdown incomplete: websockify_open={not web_stopped}, "
                    f"vnc_open={not vnc_stopped}"
                )
                raise FT8ManagerError(self._last_error)

            self._last_action = "stopped"
            self._last_error = None
            return self.status()
