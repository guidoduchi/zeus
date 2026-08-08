from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..utils import atomic_write_json, iso_now


def process_creation_marker(pid: int) -> str | None:
    """Return an OS process-birth marker to protect against recycled PIDs."""

    if pid <= 0:
        return None
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [
                wintypes.DWORD,
                wintypes.BOOL,
                wintypes.DWORD,
            ]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetProcessTimes.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(wintypes.FILETIME),
                ctypes.POINTER(wintypes.FILETIME),
                ctypes.POINTER(wintypes.FILETIME),
                ctypes.POINTER(wintypes.FILETIME),
            ]
            kernel32.GetProcessTimes.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            process = kernel32.OpenProcess(0x1000, False, pid)
            if not process:
                return None
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            try:
                if not kernel32.GetProcessTimes(
                    process,
                    ctypes.byref(created),
                    ctypes.byref(exited),
                    ctypes.byref(kernel),
                    ctypes.byref(user),
                ):
                    return None
                value = (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
                return str(value)
            finally:
                kernel32.CloseHandle(process)
        except Exception:
            return None
    stat = Path(f"/proc/{pid}/stat")
    try:
        fields = stat.read_text(encoding="utf-8").split()
        return fields[21] if len(fields) > 21 else None
    except OSError:
        return None


def _request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    timeout: float = 0.75,
) -> dict[str, Any] | None:
    request = urllib.request.Request(
        url,
        data=b"{}" if method != "GET" else None,
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return None
    return value if isinstance(value, dict) else None


class InstanceRegistry:
    """Track only Zeus-owned processes under the user's application-data root."""

    def __init__(self, home: Path):
        self.home = home.expanduser().resolve()
        self.runtime = self.home / "runtime"
        self.instances = self.runtime / "instances"
        self.launch_lock = self.runtime / "launch.lock"

    def ensure(self) -> None:
        self.instances.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def launch_guard(self, *, timeout: float = 8.0) -> Iterator[None]:
        self.ensure()
        deadline = time.monotonic() + timeout
        descriptor: int | None = None
        while descriptor is None:
            try:
                descriptor = os.open(
                    self.launch_lock,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            except FileExistsError:
                try:
                    stale = time.time() - self.launch_lock.stat().st_mtime > 30
                except OSError:
                    stale = False
                if stale:
                    self.launch_lock.unlink(missing_ok=True)
                    continue
                if time.monotonic() >= deadline:
                    raise RuntimeError("Another Zeus launch is still being prepared")
                time.sleep(0.1)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(f"{os.getpid()} {iso_now()}\n")
                handle.flush()
                os.fsync(handle.fileno())
            yield
        finally:
            self.launch_lock.unlink(missing_ok=True)

    def register(
        self,
        *,
        instance_id: str,
        port: int,
        control_token: str,
        install_root: Path,
    ) -> Path:
        self.ensure()
        pid = os.getpid()
        record = {
            "schemaVersion": 1,
            "instanceId": instance_id,
            "pid": pid,
            "processCreationMarker": process_creation_marker(pid),
            "port": int(port),
            "url": f"http://127.0.0.1:{int(port)}",
            "controlToken": control_token,
            "installRoot": str(install_root.expanduser().resolve()),
            "startedAt": iso_now(),
        }
        path = self.instances / f"{instance_id}.json"
        atomic_write_json(path, record)
        return path

    def unregister(self, instance_id: str) -> None:
        (self.instances / f"{instance_id}.json").unlink(missing_ok=True)

    def records(self) -> list[dict[str, Any]]:
        self.ensure()
        records: list[dict[str, Any]] = []
        for path in sorted(self.instances.glob("*.json")):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
                continue
            if not isinstance(value, dict) or path.stem != value.get("instanceId"):
                path.unlink(missing_ok=True)
                continue
            value["_recordPath"] = str(path)
            records.append(value)
        return records

    def live_instances(self) -> list[dict[str, Any]]:
        live: list[dict[str, Any]] = []
        for record in self.records():
            url = str(record.get("url") or "")
            health = _request_json(f"{url}/api/health") if url else None
            if (
                health
                and health.get("service") == "zeus"
                and health.get("instanceId") == record.get("instanceId")
            ):
                live.append(record)
                continue
            pid = int(record.get("pid") or 0)
            marker = process_creation_marker(pid)
            if marker is None or marker != record.get("processCreationMarker"):
                Path(str(record["_recordPath"])).unlink(missing_ok=True)
        return live

    def stop_all(self, *, force: bool = True, timeout: float = 5.0) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for record in self.records():
            instance_id = str(record.get("instanceId") or "")
            pid = int(record.get("pid") or 0)
            url = str(record.get("url") or "")
            token = str(record.get("controlToken") or "")
            marker = str(record.get("processCreationMarker") or "")
            graceful = bool(
                url
                and token
                and _request_json(
                    f"{url}/api/system/shutdown",
                    method="POST",
                    headers={"X-Zeus-Control": token},
                    timeout=1.5,
                )
            )
            deadline = time.monotonic() + timeout
            while process_creation_marker(pid) == marker and time.monotonic() < deadline:
                time.sleep(0.1)
            still_same_process = bool(marker and process_creation_marker(pid) == marker)
            forced = False
            if still_same_process and force:
                _terminate_verified_process(pid, marker)
                forced = True
            stopped = process_creation_marker(pid) != marker
            if stopped:
                Path(str(record["_recordPath"])).unlink(missing_ok=True)
            results.append(
                {
                    "instanceId": instance_id,
                    "pid": pid,
                    "gracefulRequestAccepted": graceful,
                    "forced": forced,
                    "stopped": stopped,
                }
            )
        return results


def _terminate_verified_process(pid: int, expected_marker: str) -> None:
    if not expected_marker or process_creation_marker(pid) != expected_marker:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            return


def new_instance_id() -> str:
    return uuid.uuid4().hex


def preferred_port_available(port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        probe.bind(("127.0.0.1", int(port)))
        return True
    except OSError:
        return False
    finally:
        probe.close()
