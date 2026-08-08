from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import sys
import textwrap
import threading
import time
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from .aging import aging_for_ticket, report_sort_key
from .config import (
    SETTING_SPECS,
    SettingSpec,
    application_home,
    coerce_setting_value,
    default_data_dir,
    get_dotted,
    prepare_outlook_store_path,
    scan_outlook_store_files,
    set_dotted,
)
from .diagnostics import diagnostic_log_path, record_exception
from .excel_export import (
    WorkbookPublicationError,
    list_pendings_backups,
    preview_pendings_restore,
    publish_operational_workbooks,
    restore_pendings_backup,
)
from .mail import (
    MailFetchCancelled,
    MailSyncError,
    fetch_and_commit_outlook,
    strip_quoted_history,
    synchronize_staged_email,
)
from .mop import build_placeholder_values, generate_mop
from .reconcile import sync_newest_advanced_search
from .startup import StartupResult, reconcile_advanced_and_new_mail, run_startup
from .store import StoreError, ZeusStore
from .utils import json_dumps, local_today
from .version import __version__


class Console:
    """Small compatibility console used by tests and command wrappers."""

    def __init__(self, *, no_color: bool = False):
        self.no_color = no_color

    def print(self, value: Any = "") -> None:
        print(value)


def create_store() -> ZeusStore:
    home = application_home()
    store = ZeusStore(default_data_dir(home), config_home=home)
    store.ensure_layout()
    return store


def _json_print(value: Any) -> None:
    print(json_dumps(value))


def _ticket_summary(ticket: dict[str, Any], store: ZeusStore) -> dict[str, Any]:
    facts = aging_for_ticket(ticket, store.config)
    upstream = ticket.get("upstream", {}).get("fields", {})
    local = ticket.get("local", {}).get("fields", {})
    email = ticket.get("email", {})
    return {
        "ticket_id": ticket["ticket_id"],
        "lifecycle": ticket.get("lifecycle", {}).get("status"),
        "done": local.get("Done?", "N"),
        "problem_summary": upstream.get("Problem Summary"),
        "planned_date": facts.planned_label,
        "planned_days": facts.planned_days,
        "ticket_age_days": facts.ticket_age_days,
        "resolve_by": facts.resolve_label,
        "resolve_days": facts.resolve_days,
        "email_inactivity": facts.communication_label,
        "last_email_direction": email.get("last_direction"),
        "received": int(email.get("total_received") or 0),
        "sent": int(email.get("total_sent") or 0),
        "handler": upstream.get("Current Handler"),
        "severity": upstream.get("Customer Severity"),
        "status": upstream.get("Status"),
    }


def command_paths_set(
    store: ZeusStore,
    console: Console,
    *,
    workbook_directory: Path | None = None,
    advanced_search_directory: Path | None = None,
    outlook_store_path: Path | None = None,
) -> dict[str, Any]:
    config = store.config
    paths = config.setdefault("paths", {})
    if workbook_directory is not None:
        directory = workbook_directory.expanduser().resolve()
        directory.mkdir(parents=True, exist_ok=True)
        paths["workbook_directory"] = str(directory)
    if advanced_search_directory is not None:
        directory = advanced_search_directory.expanduser().resolve()
        if not directory.is_dir():
            raise ValueError(f"Advanced Search directory not found: {directory}")
        paths["advanced_search_directory"] = str(directory)
    if outlook_store_path is not None:
        paths["outlook_store_path"] = str(prepare_outlook_store_path(outlook_store_path))
    store.save_config(config)
    result = {"paths": paths, "config": str(store.config_file)}
    console.print(json_dumps(result))
    return result


def command_sync(
    store: ZeusStore,
    console: Console,
    *,
    source: Path | None,
    dry_run: bool,
    allow_older: bool,
    assume_yes: bool,
) -> dict[str, Any]:
    from .reconcile import sync_advanced_search

    path = source or store.configured_directory("advanced_search_directory")
    if path is None:
        raise ValueError("Advanced Search directory is not configured")
    result = sync_advanced_search(
        store, path, dry_run=dry_run, allow_older=allow_older
    )
    console.print(json_dumps(result))
    return result


class StartupProgress:
    def __init__(self) -> None:
        self.cancel_event = threading.Event()
        self.finished = threading.Event()
        self._watcher: threading.Thread | None = None

    def start(self) -> None:
        if os.name != "nt" or not sys.stdin.isatty():
            return

        def watch() -> None:
            try:
                import msvcrt

                while not self.finished.is_set():
                    if msvcrt.kbhit():
                        key = msvcrt.getwch()
                        if key == "\x1b":
                            self.cancel_event.set()
                            return
                    self.finished.wait(0.05)
            except Exception:
                return

        self._watcher = threading.Thread(target=watch, daemon=True)
        self._watcher.start()

    def update(self, event: dict[str, Any]) -> None:
        phase = event.get("phase")
        if phase == "folder":
            message = f"Outlook folders {event.get('index')}/{event.get('count')}"
        elif phase == "scan":
            folder = event.get("folder")
            message = f"Scanning {folder}" if folder else f"Scanned {event.get('scanned', 0):,} messages"
        elif phase == "body":
            message = f"Reading retained bodies {event.get('index')}/{event.get('total')}"
        else:
            return
        print(f"\r{message[:100]:<100}", end="", flush=True)

    def stop(self) -> None:
        self.finished.set()
        if self._watcher:
            self._watcher.join(timeout=0.2)
        if sys.stdout.isatty():
            print("\r" + " " * 100 + "\r", end="", flush=True)


def run_startup_with_progress(store: ZeusStore) -> StartupResult:
    progress = StartupProgress()
    print("Starting Zeus — Outlook fetches can be cancelled with Esc.")
    progress.start()
    try:
        return run_startup(
            store, cancel_event=progress.cancel_event, progress=progress.update
        )
    except KeyboardInterrupt:
        progress.cancel_event.set()
        return StartupResult(
            notices=["Startup operation was interrupted; committed operations remain coherent."]
        )
    finally:
        progress.stop()


ANSI = {
    "reset": "\033[0m",
    "title": "\033[1;37;44m",
    "header": "\033[1;96m",
    "selected": "\033[7m",
    "muted": "\033[90m",
    "warning": "\033[1;91m",
    "notice": "\033[93m",
    "red": "\033[91m",
    "yellow": "\033[93m",
    "amber": "\033[33m",
    "grey": "\033[90m",
    "green": "\033[92m",
    "footer": "\033[1;37;44m",
}


def _styled(text: str, style: str | None = None) -> str:
    if not style or not sys.stdout.isatty():
        return text
    return f"{ANSI.get(style, '')}{text}{ANSI['reset']}"


ANSI_SEQUENCE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SGR_MOUSE = re.compile(r"^\[<(\d+);(\d+);(\d+)([Mm])$")


def _character_width(character: str) -> int:
    if not character or unicodedata.combining(character):
        return 0
    if unicodedata.category(character).startswith("C"):
        return 0
    return 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1


def _display_width(text: str) -> int:
    plain = ANSI_SEQUENCE.sub("", text)
    return sum(_character_width(character) for character in plain)


def _truncate_ansi(text: str, width: int, *, ellipsis: str = "") -> str:
    """Clip styled text by terminal cells without cutting an ANSI sequence."""

    if width <= 0:
        return ""
    if _display_width(text) <= width:
        return text
    ellipsis_width = min(width, _display_width(ellipsis))
    content_width = width - ellipsis_width
    output: list[str] = []
    visible = 0
    position = 0
    while position < len(text):
        match = ANSI_SEQUENCE.match(text, position)
        if match:
            output.append(match.group(0))
            position = match.end()
            continue
        character = text[position]
        cells = _character_width(character)
        if visible + cells > content_width:
            break
        output.append(character)
        visible += cells
        position += 1
    if ellipsis:
        output.append(ellipsis)
    if "\x1b[" in text:
        output.append(ANSI["reset"])
    return "".join(output)


def _fit_plain(text: str, width: int, *, ellipsis: str = "…") -> str:
    clipped = _truncate_ansi(str(text), width, ellipsis=ellipsis)
    return clipped + " " * max(0, width - _display_width(clipped))


@dataclass(frozen=True)
class MouseEvent:
    x: int
    y: int
    kind: str
    button: str | None = None
    delta: int = 0


@dataclass(frozen=True)
class TerminalCapabilities:
    mouse_enabled: bool
    transport: str
    warning: str | None = None


def _parse_sgr_mouse(sequence: str) -> MouseEvent | None:
    match = SGR_MOUSE.match(sequence)
    if not match:
        return None
    code, x, y, suffix = match.groups()
    button_code = int(code)
    if button_code & 64:
        return MouseEvent(
            int(x),
            int(y),
            "wheel",
            delta=1 if button_code & 1 == 0 else -1,
        )
    if suffix == "m":
        return None
    if button_code & 3 == 0:
        return MouseEvent(int(x), int(y), "click", button="left")
    return None


ESCAPE_KEYS = {
    "[A": "up",
    "[B": "down",
    "[D": "left",
    "[C": "right",
    "[5~": "pageup",
    "[6~": "pagedown",
    "[H": "home",
    "[F": "end",
    "[1~": "home",
    "[4~": "end",
    "OA": "up",
    "OB": "down",
    "OD": "left",
    "OC": "right",
    "OH": "home",
    "OF": "end",
}


def _decode_escape_sequence(sequence: str) -> str | MouseEvent:
    mouse = _parse_sgr_mouse(sequence)
    if mouse is not None:
        return mouse
    return ESCAPE_KEYS.get(sequence, "escape")


ENABLE_PROCESSED_INPUT = 0x0001
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_WINDOW_INPUT = 0x0008
ENABLE_MOUSE_INPUT = 0x0010
ENABLE_QUICK_EDIT_MODE = 0x0040
ENABLE_EXTENDED_FLAGS = 0x0080
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
ENABLE_PROCESSED_OUTPUT = 0x0001
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004


def _windows_console_mode_plan(
    input_mode: int,
    output_mode: int,
) -> tuple[int, int, int]:
    """Return the forced transition, interactive input, and output modes.

    Windows enables ``ENABLE_MOUSE_INPUT`` by default.  Re-applying an already
    enabled bit can be a no-op through ConPTY, so Zeus first clears mouse/VT
    input and then enables both native records and VT input explicitly.
    """

    transition_input = (
        (input_mode | ENABLE_EXTENDED_FLAGS)
        & ~ENABLE_MOUSE_INPUT
        & ~ENABLE_QUICK_EDIT_MODE
        & ~ENABLE_VIRTUAL_TERMINAL_INPUT
    )
    interactive_input = (
        input_mode
        | ENABLE_EXTENDED_FLAGS
        | ENABLE_WINDOW_INPUT
        | ENABLE_MOUSE_INPUT
        | ENABLE_VIRTUAL_TERMINAL_INPUT
    ) & ~(
        ENABLE_PROCESSED_INPUT
        | ENABLE_LINE_INPUT
        | ENABLE_ECHO_INPUT
        | ENABLE_QUICK_EDIT_MODE
    )
    interactive_output = (
        output_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
    )
    return transition_input, interactive_input, interactive_output


_WINDOWS_CONSOLE_API: dict[str, Any] | None = None


def _windows_console_api() -> dict[str, Any]:
    global _WINDOWS_CONSOLE_API
    if _WINDOWS_CONSOLE_API is not None:
        return _WINDOWS_CONSOLE_API
    import ctypes
    from ctypes import wintypes

    class COORD(ctypes.Structure):
        _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]

    class SMALL_RECT(ctypes.Structure):
        _fields_ = [
            ("Left", ctypes.c_short),
            ("Top", ctypes.c_short),
            ("Right", ctypes.c_short),
            ("Bottom", ctypes.c_short),
        ]

    class CHAR_UNION(ctypes.Union):
        _fields_ = [("UnicodeChar", wintypes.WCHAR), ("AsciiChar", ctypes.c_char)]

    class KEY_EVENT_RECORD(ctypes.Structure):
        _fields_ = [
            ("bKeyDown", wintypes.BOOL),
            ("wRepeatCount", wintypes.WORD),
            ("wVirtualKeyCode", wintypes.WORD),
            ("wVirtualScanCode", wintypes.WORD),
            ("Char", CHAR_UNION),
            ("dwControlKeyState", wintypes.DWORD),
        ]

    class MOUSE_EVENT_RECORD(ctypes.Structure):
        _fields_ = [
            ("dwMousePosition", COORD),
            ("dwButtonState", wintypes.DWORD),
            ("dwControlKeyState", wintypes.DWORD),
            ("dwEventFlags", wintypes.DWORD),
        ]

    class WINDOW_BUFFER_SIZE_RECORD(ctypes.Structure):
        _fields_ = [("dwSize", COORD)]

    class EVENT_UNION(ctypes.Union):
        _fields_ = [
            ("KeyEvent", KEY_EVENT_RECORD),
            ("MouseEvent", MOUSE_EVENT_RECORD),
            ("WindowBufferSizeEvent", WINDOW_BUFFER_SIZE_RECORD),
        ]

    class INPUT_RECORD(ctypes.Structure):
        _fields_ = [("EventType", wintypes.WORD), ("Event", EVENT_UNION)]

    class CONSOLE_SCREEN_BUFFER_INFO(ctypes.Structure):
        _fields_ = [
            ("dwSize", COORD),
            ("dwCursorPosition", COORD),
            ("wAttributes", wintypes.WORD),
            ("srWindow", SMALL_RECT),
            ("dwMaximumWindowSize", COORD),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel32.GetStdHandle.restype = wintypes.HANDLE
    kernel32.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetConsoleMode.restype = wintypes.BOOL
    kernel32.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.SetConsoleMode.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.ReadConsoleInputW.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(INPUT_RECORD),
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.GetConsoleScreenBufferInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(CONSOLE_SCREEN_BUFFER_INFO),
    ]
    _WINDOWS_CONSOLE_API = {
        "ctypes": ctypes,
        "wintypes": wintypes,
        "kernel32": kernel32,
        "INPUT_RECORD": INPUT_RECORD,
        "CSBI": CONSOLE_SCREEN_BUFFER_INFO,
        "stdin": kernel32.GetStdHandle(-10),
        "stdout": kernel32.GetStdHandle(-11),
    }
    return _WINDOWS_CONSOLE_API


def _get_console_mode(api: dict[str, Any], handle: Any) -> int:
    mode = api["wintypes"].DWORD()
    if not api["kernel32"].GetConsoleMode(
        handle, api["ctypes"].byref(mode)
    ):
        raise OSError("GetConsoleMode failed")
    return int(mode.value)


def _set_console_mode(api: dict[str, Any], handle: Any, mode: int) -> None:
    if not api["kernel32"].SetConsoleMode(handle, mode):
        raise OSError("SetConsoleMode failed")


def _read_windows_record(api: dict[str, Any], timeout_ms: int) -> Any | None:
    kernel32 = api["kernel32"]
    if kernel32.WaitForSingleObject(api["stdin"], max(0, timeout_ms)) != 0:
        return None
    record = api["INPUT_RECORD"]()
    count = api["wintypes"].DWORD()
    if not kernel32.ReadConsoleInputW(
        api["stdin"], api["ctypes"].byref(record), 1, api["ctypes"].byref(count)
    ):
        return None
    return record if int(count.value) else None


def _read_windows_vt_sequence(api: dict[str, Any], deadline: float) -> str:
    sequence = ""
    while len(sequence) < 64:
        remaining = min(20, max(0, int((deadline - time.monotonic()) * 1000)))
        if remaining <= 0:
            break
        record = _read_windows_record(api, remaining)
        if record is None:
            break
        if record.EventType != 1 or not record.Event.KeyEvent.bKeyDown:
            continue
        character = str(record.Event.KeyEvent.Char.UnicodeChar or "")
        if not character:
            continue
        sequence += character
        if sequence in ESCAPE_KEYS:
            break
        if sequence.startswith("[<") and sequence[-1:] in {"M", "m"}:
            break
        if sequence.startswith("[") and sequence.endswith("~"):
            break
    return sequence


def _read_windows_event(timeout: float) -> str | MouseEvent | None:
    api = _windows_console_api()
    ctypes = api["ctypes"]
    kernel32 = api["kernel32"]
    deadline = time.monotonic() + timeout
    while True:
        remaining = max(0, int((deadline - time.monotonic()) * 1000))
        record = _read_windows_record(api, remaining)
        if record is None:
            return None
        if record.EventType == 1:
            event = record.Event.KeyEvent
            if not event.bKeyDown:
                continue
            virtual_key = int(event.wVirtualKeyCode)
            character = str(event.Char.UnicodeChar or "")
            if character == "\x1b" and virtual_key != 0x1B:
                return _decode_escape_sequence(
                    _read_windows_vt_sequence(
                        api, max(deadline, time.monotonic() + 0.05)
                    )
                )
            mapped = {
                0x26: "up",
                0x28: "down",
                0x25: "left",
                0x27: "right",
                0x21: "pageup",
                0x22: "pagedown",
                0x24: "home",
                0x23: "end",
                0x0D: "enter",
                0x1B: "escape",
                0x08: "backspace",
            }.get(virtual_key)
            if mapped:
                return mapped
            control = int(event.dwControlKeyState) & 0x000C
            if control and virtual_key == 0x46:
                return "ctrl-f"
            if control and virtual_key == 0x43:
                return "ctrl-c"
            if character == "\x06":
                return "ctrl-f"
            if character == "\x03":
                return "ctrl-c"
            if character == "\x1b":
                return "escape"
            if character and ord(character) >= 32:
                return character
        elif record.EventType == 2:
            event = record.Event.MouseEvent
            flags = int(event.dwEventFlags)
            info = api["CSBI"]()
            left = top = 0
            if kernel32.GetConsoleScreenBufferInfo(api["stdout"], ctypes.byref(info)):
                left, top = int(info.srWindow.Left), int(info.srWindow.Top)
            x = int(event.dwMousePosition.X) - left + 1
            y = int(event.dwMousePosition.Y) - top + 1
            if flags == 0x0004:
                raw_delta = (int(event.dwButtonState) >> 16) & 0xFFFF
                if raw_delta >= 0x8000:
                    raw_delta -= 0x10000
                return MouseEvent(x, y, "wheel", delta=1 if raw_delta > 0 else -1)
            if flags in {0, 0x0002} and int(event.dwButtonState) & 0x0001:
                return MouseEvent(x, y, "click", button="left")
        elif record.EventType == 4:
            return "resize"
        if time.monotonic() >= deadline:
            return None


@contextmanager
def _terminal_mode() -> Any:
    if not sys.stdin.isatty():
        yield TerminalCapabilities(False, "none")
        return
    if os.name == "nt":
        api: dict[str, Any] | None = None
        original_input: int | None = None
        original_output: int | None = None
        try:
            api = _windows_console_api()
            original_input = _get_console_mode(api, api["stdin"])
            original_output = _get_console_mode(api, api["stdout"])
            transition, interactive, output = _windows_console_mode_plan(
                original_input, original_output
            )
            _set_console_mode(api, api["stdout"], output)
            _set_console_mode(api, api["stdin"], transition)
            _set_console_mode(api, api["stdin"], interactive)
            verified_input = _get_console_mode(api, api["stdin"])
            verified_output = _get_console_mode(api, api["stdout"])
            required_input = (
                ENABLE_MOUSE_INPUT
                | ENABLE_WINDOW_INPUT
                | ENABLE_EXTENDED_FLAGS
                | ENABLE_VIRTUAL_TERMINAL_INPUT
            )
            forbidden_input = (
                ENABLE_QUICK_EDIT_MODE | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
            )
            required_output = (
                ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
            )
            if (
                verified_input & required_input != required_input
                or verified_input & forbidden_input
                or verified_output & required_output != required_output
            ):
                raise OSError("Windows console rejected the interactive mouse mode")
        except Exception as exc:
            if api is not None:
                try:
                    if original_input is not None:
                        _set_console_mode(api, api["stdin"], original_input)
                    if original_output is not None:
                        _set_console_mode(api, api["stdout"], original_output)
                except Exception:
                    pass
            yield TerminalCapabilities(
                False,
                "sgr-fallback",
                f"Mouse transport could not be verified ({exc}); keyboard navigation remains available.",
            )
            return
        try:
            yield TerminalCapabilities(True, "windows-records+vt")
        finally:
            try:
                assert api is not None
                assert original_input is not None
                assert original_output is not None
                _set_console_mode(api, api["stdin"], original_input)
                _set_console_mode(api, api["stdout"], original_output)
            except Exception:
                pass
        return
    import termios
    import tty

    descriptor = sys.stdin.fileno()
    original = termios.tcgetattr(descriptor)
    try:
        tty.setcbreak(descriptor)
        yield TerminalCapabilities(True, "sgr")
    finally:
        termios.tcsetattr(descriptor, termios.TCSADRAIN, original)


@contextmanager
def _screen_mode() -> Any:
    mouse_on = "\033[?1000h\033[?1006h"
    mouse_off = "\033[?1000l\033[?1006l"
    sys.stdout.write(
        "\033[?1049h\033[?25l" + mouse_on + "\033[2J\033[3J\033[H"
    )
    sys.stdout.flush()
    try:
        yield
    finally:
        sys.stdout.write(
            mouse_off + "\033[?25h\033[2J\033[3J\033[H\033[?1049l"
        )
        sys.stdout.flush()


def _request_console_fullscreen() -> None:
    """Best-effort fallback for direct launches outside ``run_zeus.bat``."""

    if os.name != "nt" or not sys.stdout.isatty():
        return
    try:
        import ctypes

        window = ctypes.windll.kernel32.GetConsoleWindow()
        if window:
            ctypes.windll.user32.ShowWindow(window, 3)  # SW_MAXIMIZE
    except Exception:
        pass


def _read_key(timeout: float = 0.25) -> str | MouseEvent | None:
    if os.name == "nt":
        try:
            return _read_windows_event(timeout)
        except Exception:
            import msvcrt

            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if not msvcrt.kbhit():
                    time.sleep(0.02)
                    continue
                char = msvcrt.getwch()
                if char in {"\x00", "\xe0"}:
                    return {
                        "H": "up",
                        "P": "down",
                        "K": "left",
                        "M": "right",
                        "I": "pageup",
                        "Q": "pagedown",
                        "G": "home",
                        "O": "end",
                    }.get(msvcrt.getwch(), "unknown")
                if char == "\x1b":
                    sequence = ""
                    sequence_deadline = time.monotonic() + 0.05
                    while len(sequence) < 64 and time.monotonic() < sequence_deadline:
                        if not msvcrt.kbhit():
                            time.sleep(0.001)
                            continue
                        sequence += msvcrt.getwch()
                        if sequence in ESCAPE_KEYS:
                            break
                        if sequence.startswith("[<") and sequence[-1:] in {"M", "m"}:
                            break
                        if sequence.startswith("[") and sequence.endswith("~"):
                            break
                    return _decode_escape_sequence(sequence)
                return {
                    "\r": "enter",
                    "\x08": "backspace",
                    "\x06": "ctrl-f",
                    "\x03": "ctrl-c",
                }.get(char, char)
            return None
    readable, _, _ = select.select([sys.stdin], [], [], timeout)
    if not readable:
        return None
    char = sys.stdin.read(1)
    if char == "\x1b":
        sequence = ""
        while select.select([sys.stdin], [], [], 0.01)[0]:
            sequence += sys.stdin.read(1)
        return _decode_escape_sequence(sequence)
    return {
        "\n": "enter",
        "\r": "enter",
        "\x7f": "backspace",
        "\x08": "backspace",
        "\x06": "ctrl-f",
        "\x03": "ctrl-c",
    }.get(char, char)


class ZeusTUI:
    ACTIONS = [
        ("publish", "Publish Pendings.xlsx + Closed.xlsx"),
        ("fetch", "Fetch Outlook email for all active tickets"),
        ("sync_email", "Synchronize staged email"),
        ("rebuild_email", "Rebuild email history (full scan, merge only)"),
        ("sync_advanced", "Check Advanced Search now"),
        ("restore", "Restore local fields from a Pendings backup"),
        ("config", "Configuration"),
        ("doctor", "Run diagnostics"),
        ("quit", "Exit Zeus"),
    ]
    SORTS = ["report", "sr", "planned", "email", "age"]

    def __init__(self, store: ZeusStore, startup: StartupResult):
        self.store = store
        self.startup = startup
        self.view = "dashboard"
        self.selected = 0
        self.menu_selected = 0
        self.sort_index = 0
        self.detail_offset = 0
        self.email_selected = 0
        self.show_quoted_history = False
        self.search_mode = False
        self.search_query = ""
        self.status = ""
        self.last_date = local_today()
        self.dirty = True
        self._poll_thread: threading.Thread | None = None
        self._poll_result: StartupResult | Exception | None = None
        self._next_poll = self._poll_deadline()
        self._dashboard_page_size = 1
        self._detail_page_size = 1
        self._detail_total_lines = 0
        self._body_targets: dict[int, tuple[str, int]] = {}
        self._screen_targets: dict[int, tuple[str, int]] = {}
        self._last_screen_size: tuple[int, int] | None = None

    def _poll_deadline(self) -> float:
        minutes = int(
            self.store.config.get("advanced_search", {}).get(
                "poll_interval_minutes", 15
            )
        )
        return float("inf") if minutes == 0 else time.monotonic() + minutes * 60

    def _screen_size(self) -> tuple[int, int]:
        size = shutil.get_terminal_size((120, 32))
        return size.columns, size.lines

    def _header(self, width: int) -> str:
        staged = int(
            self.store.state().get("email_state", {}).get("staged_message_count") or 0
        )
        label = f" ZEUS {__version__} | {self.view.replace('_', ' ').title()}"
        if staged:
            label += f" | Email updates pending: {staged}"
        return _styled(_fit_plain(label, width), "title")

    def _footer(self, width: int) -> str:
        if self.search_mode:
            text = f" Find SR: {self.search_query}_  | Esc close search "
        elif self.view == "dashboard":
            text = (
                " ↑↓/Wheel Select  Click/Enter Open  Ctrl+F Search  "
                "S Sort  M Menu  R Refresh  Q Exit "
            )
        elif self.view == "detail":
            thread_mode = "T Compact" if self.show_quoted_history else "T Full Thread"
            text = (
                " ↑↓/Wheel Scroll  PgUp/PgDn Page  ←→ Email  "
                f"Click Email  {thread_mode}  Esc Back "
            )
        else:
            text = " ↑↓/Wheel Select  Click/Enter Run  Esc Back "
        if self.status:
            text = f" {self.status} |" + text
        return _styled(_fit_plain(text, width), "footer")

    def _all_tickets(self) -> list[dict[str, Any]]:
        tickets = list(self.store.iter_tickets())
        mode = self.SORTS[self.sort_index]
        active = [
            ticket
            for ticket in tickets
            if ticket.get("lifecycle", {}).get("status") == "active"
        ]
        closing = [
            ticket
            for ticket in tickets
            if ticket.get("lifecycle", {}).get("status") == "closure_pending"
        ]

        def key(ticket: dict[str, Any]) -> Any:
            facts = aging_for_ticket(ticket, self.store.config)
            if mode == "sr":
                return (-int(ticket["ticket_id"]),)
            if mode in {"report", "planned"}:
                return report_sort_key(ticket, self.store.config)
            if mode == "email":
                value = facts.communication_inactivity_days
                return (
                    value is None,
                    0 if value is None else -value,
                    -int(ticket["ticket_id"]),
                )
            return (-(facts.ticket_age_days or -1), -int(ticket["ticket_id"]))

        ordered = sorted(active, key=key) + sorted(closing, key=key)
        if self.search_query:
            ordered = [
                ticket
                for ticket in ordered
                if self.search_query in ticket["ticket_id"]
            ]
        return ordered

    def _warnings(self, width: int, max_lines: int = 4) -> list[str]:
        lines: list[str] = []
        for warning in self.startup.warnings:
            for line in textwrap.wrap(f"! {warning}", width=max(20, width - 1)):
                lines.append(_styled(line, "warning"))
        for notice in self.startup.notices:
            for line in textwrap.wrap(f"• {notice}", width=max(20, width - 1)):
                lines.append(_styled(line, "notice"))
        return lines[:max_lines]

    def _dashboard_lines(self, width: int, height: int) -> list[str]:
        self._body_targets = {}
        lines = self._warnings(width)
        if lines:
            lines.append("")
        all_records = list(self.store.iter_tickets())
        active_records = [
            ticket
            for ticket in all_records
            if ticket.get("lifecycle", {}).get("status") == "active"
        ]
        codes = {code: 0 for code in ("Y", "N", "P", "?")}
        overdue = unplanned = no_email = 0
        for ticket in active_records:
            code = str(ticket.get("local", {}).get("fields", {}).get("Done?") or "N")
            codes[code if code in codes else "N"] += 1
            facts = aging_for_ticket(ticket, self.store.config)
            overdue += facts.planned_state == "overdue"
            unplanned += facts.planned_state == "unplanned"
            no_email += facts.communication_inactivity_days is None
        closing_count = len(all_records) - len(active_records)
        summary = (
            f"Active {len(active_records)} | Y {codes['Y']} N {codes['N']} "
            f"P {codes['P']} ? {codes['?']} | Overdue {overdue} | "
            f"Unplanned {unplanned} | No email {no_email} | Pending closure {closing_count}"
        )
        lines.append(
            _styled(_truncate_ansi(summary, width, ellipsis="…"), "header")
        )
        lines.append("")
        tickets = self._all_tickets()
        if not tickets:
            lines.append(_styled("No matching Markdown ticket records.", "muted"))
            return lines
        self.selected = max(0, min(self.selected, len(tickets) - 1))
        available = max(1, height - len(lines) - 2)
        self._dashboard_page_size = available
        start = max(
            0,
            min(self.selected - available // 2, max(0, len(tickets) - available)),
        )
        end = min(len(tickets), start + available)
        header = (
            f"{'SR':<10} {'Life':<16} {'Done':<5} {'Planned':<12} "
            f"{'Age':>5} {'Email':<16} Summary"
        )
        lines.append(
            _styled(_truncate_ansi(header, width, ellipsis="…"), "header")
        )
        for index in range(start, end):
            ticket = tickets[index]
            facts = aging_for_ticket(ticket, self.store.config)
            upstream = ticket.get("upstream", {}).get("fields", {})
            local = ticket.get("local", {}).get("fields", {})
            life = ticket.get("lifecycle", {}).get("status", "")
            prefix = (
                f"{ticket['ticket_id']:<10} {life:<16} "
                f"{str(local.get('Done?') or 'N'):<5} "
            )
            planned = f"{facts.planned_label[:12]:<12}"
            age = f"{str(facts.ticket_age_days if facts.ticket_age_days is not None else '—'):>5}"
            communication = f"{facts.communication_label[:16]:<16}"
            suffix = f" {str(upstream.get('Problem Summary') or '')}"
            if index == self.selected:
                plain = prefix + planned + " " + age + " " + communication + suffix
                rendered = _styled(
                    _truncate_ansi(plain, width, ellipsis="…"), "selected"
                )
            else:
                rendered = (
                    prefix
                    + _styled(planned, facts.planned_color)
                    + " "
                    + _styled(age, facts.ticket_age_color)
                    + " "
                    + _styled(communication, facts.communication_color)
                    + suffix
                )
                rendered = _truncate_ansi(rendered, width, ellipsis="…")
            self._body_targets[len(lines)] = ("ticket", index)
            lines.append(rendered)
        lines.append(
            _styled(
                _truncate_ansi(
                    f"{len(tickets)} ticket(s) | sort: {self.SORTS[self.sort_index]}",
                    width,
                    ellipsis="…",
                ),
                "muted",
            )
        )
        return lines

    def _detail_lines(self, ticket: dict[str, Any], width: int) -> list[str]:
        self._body_targets = {}
        summary = _ticket_summary(ticket, self.store)
        upstream = ticket.get("upstream", {}).get("fields", {})
        local = ticket.get("local", {}).get("fields", {})
        email = ticket.get("email", {})
        lines = [
            _styled(
                f"SR {ticket['ticket_id']} — {upstream.get('Problem Summary') or ''}",
                "header",
            ),
            "",
            f"Lifecycle: {summary['lifecycle']}   Done?: {summary['done']}",
            f"Planned: {summary['planned_date']} ({summary['planned_days']})   Ticket age: {summary['ticket_age_days']} days",
            f"ResolveBy: {summary['resolve_by']} ({summary['resolve_days']})",
            (
                f"Email: received {summary['received']} | sent {summary['sent']} | "
                f"inactivity {summary['email_inactivity']} | last "
                f"{summary['last_email_direction'] or 'No email found'}"
            ),
        ]
        messages = list(email.get("messages", []))
        lines.extend(["", _styled("Retained email replies (newest first)", "header")])
        if not messages:
            lines.append(_styled("  No email found", "grey"))
        else:
            self.email_selected = max(
                0, min(self.email_selected, len(messages) - 1)
            )
            for index, message in enumerate(messages):
                marker = "›" if index == self.email_selected else " "
                label = (
                    f" {marker} {index + 1}. {message.get('timestamp') or 'Unknown time'} "
                    f"| {message.get('direction') or 'unknown'} | "
                    f"{message.get('subject') or '(no subject)'}"
                )
                self._body_targets[len(lines)] = ("email", index)
                lines.append(
                    _styled(label, "selected")
                    if index == self.email_selected
                    else label
                )

            selected_message = messages[self.email_selected]
            lines.extend(
                [
                    "",
                    _styled(
                        f"Selected reply {self.email_selected + 1}/{len(messages)}",
                        "header",
                    ),
                    (
                        f"  From/To: {selected_message.get('sender') or '—'}   "
                        f"Direction: {selected_message.get('direction') or '—'}"
                    ),
                ]
            )
            raw_body = str(selected_message.get("body") or "")
            detected_body, detected_history, detected_lines = strip_quoted_history(
                raw_body
            )
            history_hidden = bool(
                selected_message.get("quoted_history_hidden") or detected_history
            )
            hidden_lines = max(
                int(selected_message.get("quoted_history_lines") or 0),
                detected_lines,
            )
            body = (
                raw_body
                if self.show_quoted_history
                else str(
                    selected_message.get("latest_reply_body")
                    if selected_message.get("latest_reply_body") is not None
                    else detected_body
                )
            )
            if not body:
                body = (
                    "No new text in this reply."
                    if history_hidden
                    else "Body unavailable."
                )
            for source_line in body.splitlines() or [""]:
                wrapped = textwrap.wrap(
                    source_line,
                    width=max(20, width - 4),
                    replace_whitespace=False,
                    drop_whitespace=False,
                ) or [""]
                lines.extend(f"    {part}" for part in wrapped)
            if history_hidden and not self.show_quoted_history:
                detail = (
                    f" ({hidden_lines} quoted line(s))" if hidden_lines else ""
                )
                lines.append(
                    _styled(f"    Earlier reply history hidden{detail}.", "muted")
                )
            elif history_hidden:
                lines.append(
                    _styled("    Full quoted reply history is shown.", "muted")
                )

        def append_fields(title: str, fields: dict[str, Any]) -> None:
            lines.extend(["", _styled(title, "header")])
            wrap_width = max(20, width - 4)
            for key, value in fields.items():
                rendered = value if value not in (None, "") else "—"
                prefix = f"  {key}: "
                available = max(20, width - _display_width(prefix))
                paragraphs = str(rendered).splitlines() or [""]
                first = True
                for paragraph in paragraphs:
                    wrapped = textwrap.wrap(
                        paragraph,
                        width=available if first else wrap_width,
                        replace_whitespace=False,
                        drop_whitespace=False,
                    ) or [""]
                    for part in wrapped:
                        lines.append((prefix if first else "    ") + part)
                        first = False

        append_fields("Advanced Search fields", upstream)
        append_fields("Pendings fields (edit in Excel)", local)
        return lines

    def _body_lines(self, width: int, height: int) -> list[str]:
        if self.view == "menu":
            self._body_targets = {}
            lines = [_styled("Operations", "header"), ""]
            for index, (_, label) in enumerate(self.ACTIONS):
                line = f"  {label}"
                self._body_targets[len(lines)] = ("menu", index)
                lines.append(_styled(line, "selected") if index == self.menu_selected else line)
            return lines
        if self.view == "detail":
            tickets = self._all_tickets()
            if not tickets:
                return [_styled("Ticket no longer exists.", "muted")]
            self.selected = min(self.selected, len(tickets) - 1)
            lines = self._detail_lines(tickets[self.selected], width)
            self._detail_total_lines = len(lines)
            self._detail_page_size = height
            self.detail_offset = max(
                0, min(self.detail_offset, max(0, len(lines) - height))
            )
            targets = self._body_targets
            self._body_targets = {
                line_number - self.detail_offset: target
                for line_number, target in targets.items()
                if self.detail_offset <= line_number < self.detail_offset + height
            }
            return lines[self.detail_offset : self.detail_offset + height]
        return self._dashboard_lines(width, height)

    def _draw(self) -> None:
        width, rows = self._screen_size()
        width = max(20, width)
        rows = max(3, rows)
        body_height = max(1, rows - 2)
        lines = self._body_lines(width, body_height)
        visible_body = lines[:body_height] + [
            "" for _ in range(max(0, body_height - len(lines)))
        ]
        frame_lines = [self._header(width), *visible_body, self._footer(width)]
        self._screen_targets = {
            line_number + 2: target
            for line_number, target in self._body_targets.items()
            if 0 <= line_number < body_height
        }
        # Disable auto-wrap and address every physical row directly.  A long
        # coloured cell can therefore never add a surprise row and scroll the
        # Zeus header away.  3J erases the terminal's scrollback on each view.
        output = ["\033[?7l\033[2J\033[3J\033[H"]
        for row_number, line in enumerate(frame_lines, start=1):
            clipped = _truncate_ansi(str(line), width, ellipsis="…")
            output.append(f"\033[{row_number};1H\033[2K{clipped}")
        output.append("\033[?7h")
        sys.stdout.write("".join(output))
        sys.stdout.flush()
        self.dirty = False

    def _start_poll_if_due(self) -> None:
        if self._poll_thread is not None or time.monotonic() < self._next_poll:
            return

        def work() -> None:
            try:
                self._poll_result = reconcile_advanced_and_new_mail(self.store)
            except Exception as exc:
                self._poll_result = exc

        self.status = "Checking Advanced Search…"
        self._poll_thread = threading.Thread(target=work, daemon=True)
        self._poll_thread.start()
        self._next_poll = self._poll_deadline()
        self.dirty = True

    def _collect_poll(self) -> None:
        if self._poll_thread is None or self._poll_thread.is_alive():
            return
        result = self._poll_result
        self._poll_thread = None
        self._poll_result = None
        if isinstance(result, Exception):
            self.status = f"Advanced Search warning: {result}"
        elif isinstance(result, StartupResult):
            if result.warnings:
                self.startup.warnings = result.warnings
            advanced = result.operations.get("advanced_search", {})
            self.status = (
                "Advanced Search synchronized"
                if advanced.get("material_change")
                else "Advanced Search checked"
            )
        self.dirty = True

    def _handle_search_key(self, key: str) -> None:
        if key == "escape":
            self.search_mode = False
        elif key == "backspace":
            self.search_query = self.search_query[:-1]
            self.selected = 0
        elif key == "enter":
            self.search_mode = False
        elif len(key) == 1 and key.isdigit():
            self.search_query += key
            self.selected = 0
        self.dirty = True

    def _menu_action(self) -> dict[str, Any] | None:
        if self._poll_thread is not None and self._poll_thread.is_alive():
            self.status = "Wait for the current Advanced Search check to finish"
            self.dirty = True
            return None
        return {"action": self.ACTIONS[self.menu_selected][0]}

    def _move_ticket(self, amount: int) -> None:
        maximum = max(0, len(self._all_tickets()) - 1)
        self.selected = max(0, min(maximum, self.selected + amount))

    def _move_email(self, amount: int) -> None:
        tickets = self._all_tickets()
        if not tickets:
            return
        messages = tickets[self.selected].get("email", {}).get("messages", [])
        if not messages:
            return
        self.email_selected = max(
            0, min(len(messages) - 1, self.email_selected + amount)
        )

    def _max_detail_offset(self) -> int:
        return max(0, self._detail_total_lines - self._detail_page_size)

    def _handle_mouse(self, event: MouseEvent) -> dict[str, Any] | None:
        if event.kind == "wheel":
            step = 3 * (1 if event.delta > 0 else -1)
            if self.view == "dashboard":
                self._move_ticket(-step)
            elif self.view == "menu":
                self.menu_selected = max(
                    0,
                    min(len(self.ACTIONS) - 1, self.menu_selected - step),
                )
            elif self.view == "detail":
                self.detail_offset = max(
                    0,
                    min(self._max_detail_offset(), self.detail_offset - step),
                )
            self.dirty = True
            return None
        if event.kind != "click" or event.button != "left":
            return None
        target = self._screen_targets.get(event.y)
        if target is None:
            return None
        kind, index = target
        if kind == "ticket":
            self.selected = index
            self.view = "detail"
            self.detail_offset = 0
            self.email_selected = 0
            self.show_quoted_history = False
        elif kind == "menu":
            self.menu_selected = index
            return self._menu_action()
        elif kind == "email":
            self.email_selected = index
            self.status = f"Selected retained email {index + 1}"
        self.dirty = True
        return None

    def _handle_key(self, key: str) -> dict[str, Any] | None:
        if self.search_mode:
            self._handle_search_key(key)
            return None
        if key in {"ctrl-c", "q", "Q"}:
            return {"action": "quit"}
        if key == "up":
            if self.view == "menu":
                self.menu_selected = max(0, self.menu_selected - 1)
            elif self.view == "dashboard":
                self._move_ticket(-1)
            elif self.view == "detail":
                self.detail_offset = max(0, self.detail_offset - 1)
        elif key == "down":
            if self.view == "menu":
                self.menu_selected = min(len(self.ACTIONS) - 1, self.menu_selected + 1)
            elif self.view == "dashboard":
                self._move_ticket(1)
            elif self.view == "detail":
                self.detail_offset = min(
                    self._max_detail_offset(), self.detail_offset + 1
                )
        elif key == "left" and self.view == "detail":
            self._move_email(-1)
        elif key == "right" and self.view == "detail":
            self._move_email(1)
        elif key in {"t", "T"} and self.view == "detail":
            self.show_quoted_history = not self.show_quoted_history
        elif key == "enter":
            if self.view == "dashboard" and self._all_tickets():
                self.view = "detail"
                self.detail_offset = 0
                self.email_selected = 0
                self.show_quoted_history = False
            elif self.view == "menu":
                return self._menu_action()
        elif key == "escape":
            if self.view in {"detail", "menu"}:
                self.view = "dashboard"
        elif key == "ctrl-f":
            self.view = "dashboard"
            self.search_mode = True
        elif key in {"s", "S"} and self.view == "dashboard":
            self.sort_index = (self.sort_index + 1) % len(self.SORTS)
            self.selected = 0
        elif key in {"m", "M"} and self.view == "dashboard":
            self.view = "menu"
        elif key in {"r", "R"} and self.view == "dashboard":
            self.status = "Refreshed"
        elif key == "pageup":
            if self.view == "detail":
                self.detail_offset = max(
                    0, self.detail_offset - max(1, self._detail_page_size - 2)
                )
            elif self.view == "dashboard":
                self._move_ticket(-self._dashboard_page_size)
        elif key == "pagedown":
            if self.view == "detail":
                self.detail_offset = min(
                    self._max_detail_offset(),
                    self.detail_offset + max(1, self._detail_page_size - 2),
                )
            elif self.view == "dashboard":
                self._move_ticket(self._dashboard_page_size)
        elif key == "home":
            if self.view == "detail":
                self.detail_offset = 0
            elif self.view == "dashboard":
                self.selected = 0
            elif self.view == "menu":
                self.menu_selected = 0
        elif key == "end":
            if self.view == "detail":
                self.detail_offset = self._max_detail_offset()
            elif self.view == "dashboard":
                self.selected = max(0, len(self._all_tickets()) - 1)
            elif self.view == "menu":
                self.menu_selected = len(self.ACTIONS) - 1
        elif key == "resize":
            pass
        self.dirty = True
        return None

    def run(self) -> dict[str, Any] | None:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            for ticket in self._all_tickets():
                print(json_dumps(_ticket_summary(ticket, self.store)))
            return {"action": "quit"}
        if os.name == "nt":
            os.system("")  # enable ANSI processing on supported Windows consoles
        _request_console_fullscreen()
        with _terminal_mode() as terminal, _screen_mode():
            if terminal.warning:
                self.status = terminal.warning
                self.dirty = True
            while True:
                current_size = self._screen_size()
                if current_size != self._last_screen_size:
                    self._last_screen_size = current_size
                    self.dirty = True
                if local_today() != self.last_date:
                    self.last_date = local_today()
                    self.status = "Aging recalculated at midnight"
                    self.dirty = True
                self._start_poll_if_due()
                self._collect_poll()
                if self.dirty:
                    self._draw()
                event = _read_key(0.25)
                if event is None:
                    continue
                result = (
                    self._handle_mouse(event)
                    if isinstance(event, MouseEvent)
                    else self._handle_key(event)
                )
                if result is not None:
                    return result


def _confirm(prompt: str) -> bool:
    return input(f"{prompt} [y/N]: ").strip().lower() in {"y", "yes"}


def _format_setting_value(spec: SettingSpec, value: Any) -> str:
    if value is None or value == "":
        return "Not configured"
    if spec.kind == "boolean":
        return "Enabled" if value else "Disabled"
    if spec.kind == "string_list":
        return ", ".join(str(item) for item in value) or "None"
    if spec.key == "aging.calendar_days":
        return "Calendar days (fixed)"
    if spec.key == "email.sync_mode":
        return "Scheduled independently" if value == "scheduled" else "After every fetch"
    return str(value)


def _directory_preview(spec: SettingSpec, directory: Path, config: dict[str, Any]) -> str:
    if spec.key == "paths.workbook_directory":
        found = [name for name in ("Pendings.xlsx", "Closed.xlsx") if (directory / name).is_file()]
        return f"Managed workbooks found: {', '.join(found) if found else 'none yet'}"
    if spec.key == "paths.advanced_search_directory":
        pattern = str(config.get("advanced_search", {}).get("glob") or "Advanced Search*.xlsx")
        matches = sorted(directory.glob(pattern))
        latest = matches[-1].name if matches else "none"
        return f"Matching workbooks: {len(matches)}; latest by name: {latest}"
    if spec.key == "paths.template_directory":
        return f"Word templates found: {sum(1 for _ in directory.glob('*.docx'))}"
    if spec.key == "paths.spare_parts_export_directory":
        return (
            "Export-only destination; Zeus will not import these files. "
            f"Excel workbooks found: {sum(1 for _ in directory.glob('*.xlsx'))}"
        )
    return ""


def _edit_directory_setting(
    config: dict[str, Any], spec: SettingSpec, *, base: Path
) -> bool:
    current = get_dotted(config, spec.key)
    clear_hint = "; '-' clears it" if spec.nullable else ""
    raw = input(
        f"{spec.label} path [{_format_setting_value(spec, current)}]"
        f" (Enter cancels{clear_hint}): "
    ).strip()
    if not raw:
        return False
    value = coerce_setting_value(spec.key, raw, base=base)
    if value is not None:
        directory = Path(value)
        if not directory.is_dir():
            raise ValueError(f"Folder does not exist: {directory}")
        preview = _directory_preview(spec, directory, config)
        if preview:
            print(preview)
    set_dotted(config, spec.key, value)
    return True


def _edit_xlsx_template_setting(
    config: dict[str, Any], spec: SettingSpec, *, base: Path
) -> bool:
    current = get_dotted(config, spec.key)
    raw = input(
        f"{spec.label} [{_format_setting_value(spec, current)}] "
        "(Enter cancels; '-' clears it): "
    ).strip()
    if not raw:
        return False
    value = coerce_setting_value(spec.key, raw, base=base)
    if value is not None:
        path = Path(value)
        if not path.is_file() or path.suffix.lower() != ".xlsx":
            raise ValueError(f"Excel template does not exist: {path}")
    set_dotted(config, spec.key, value)
    return True


def _outlook_default_directory(current: Any) -> Path | None:
    if not current:
        return None
    path = Path(str(current)).expanduser()
    if path.exists() and path.is_dir():
        return path.resolve()
    if path.suffix.lower() in {".ost", ".pst"}:
        return path.parent.resolve()
    return None


def _edit_outlook_store_setting(
    config: dict[str, Any],
    *,
    base: Path,
    blank_disables_when_unconfigured: bool = False,
) -> bool:
    """Scan a folder and toggle one exact Outlook store selection."""

    current = config.get("paths", {}).get("outlook_store_path")
    default_directory = _outlook_default_directory(current)
    default_label = f" [{default_directory}]" if default_directory else ""
    raw = input(
        "Folder containing classic Outlook .ost/.pst files"
        f"{default_label} (Enter {'uses this folder' if default_directory else 'disables email' if blank_disables_when_unconfigured else 'cancels'}; '-' disables): "
    ).strip().strip('"')
    if raw == "-":
        config.setdefault("paths", {})["outlook_store_path"] = None
        print("Outlook email disabled.")
        return True
    if not raw:
        if default_directory is not None:
            directory = default_directory
        elif blank_disables_when_unconfigured:
            config.setdefault("paths", {})["outlook_store_path"] = None
            print("Outlook email disabled.")
            return True
        else:
            return False
    else:
        directory = Path(raw).expanduser()
        if not directory.is_absolute():
            directory = base / directory
        directory = directory.resolve()

    candidates = scan_outlook_store_files(directory)
    if not candidates:
        raise ValueError(f"No .ost or .pst files were found in {directory}")

    normalized_current: Path | None = None
    if current and Path(str(current)).suffix.lower() in {".ost", ".pst"}:
        try:
            normalized_current = prepare_outlook_store_path(current, base=base)
        except ValueError:
            normalized_current = None
    print(f"\nOutlook stores found in {directory}:")
    print("  0. [ ] Disable Outlook email")
    for index, candidate in enumerate(candidates, start=1):
        marker = "x" if normalized_current == candidate else " "
        print(f"  {index}. [{marker}] {candidate.name}")
    raw_choice = input(
        "Select a store number (select the checked store again to deselect; Enter cancels): "
    ).strip()
    if not raw_choice:
        return False
    try:
        choice = int(raw_choice)
    except ValueError as exc:
        raise ValueError("Outlook store selection must be a listed number") from exc
    if choice == 0:
        selected: Path | None = None
    elif 1 <= choice <= len(candidates):
        candidate = candidates[choice - 1]
        selected = None if candidate == normalized_current else candidate
    else:
        raise ValueError(f"Select a number from 0 to {len(candidates)}")
    config.setdefault("paths", {})["outlook_store_path"] = (
        str(selected) if selected is not None else None
    )
    print(f"Outlook store selected: {selected}" if selected else "Outlook email disabled.")
    return True


def _edit_scalar_setting(config: dict[str, Any], spec: SettingSpec, *, base: Path) -> bool:
    current = get_dotted(config, spec.key)
    print(f"\n{spec.label}: {spec.description}")
    if spec.kind == "boolean":
        print(f"  1. [{'x' if current is True else ' '}] Enabled")
        print(f"  2. [{'x' if current is False else ' '}] Disabled")
        raw = input("Select 1 or 2 (Enter cancels): ").strip()
        if not raw:
            return False
        value = coerce_setting_value(spec.key, {"1": "true", "2": "false"}.get(raw, raw))
    elif spec.kind == "choice":
        for index, choice in enumerate(spec.choices, start=1):
            marker = "x" if current == choice else " "
            print(f"  {index}. [{marker}] {choice}")
        raw = input(f"Select 1-{len(spec.choices)} (Enter cancels): ").strip()
        if not raw:
            return False
        try:
            value = spec.choices[int(raw) - 1]
        except (ValueError, IndexError) as exc:
            raise ValueError("Select one of the listed choices") from exc
    else:
        clear_hint = "; '-' clears it" if spec.nullable else ""
        raw = input(
            f"New value [{_format_setting_value(spec, current)}]"
            f" (Enter cancels{clear_hint}): "
        )
        if not raw.strip():
            return False
        value = coerce_setting_value(spec.key, raw, base=base)
    set_dotted(config, spec.key, value)
    return True


def _interactive_config(store: ZeusStore) -> None:
    while True:
        config = store.config
        print("\nZeus configuration")
        print("Select one item to change. The JSON file is not edited in this screen.")
        previous_category: str | None = None
        for index, spec in enumerate(SETTING_SPECS, start=1):
            if spec.category != previous_category:
                print(f"\n{spec.category}")
                previous_category = spec.category
            lock = " [fixed]" if not spec.editable else ""
            value = _format_setting_value(spec, get_dotted(config, spec.key))
            print(f"  {index:>2}. {spec.label}{lock}: {value}")
        raw = input("\nSetting number (Enter returns): ").strip()
        if not raw:
            return
        try:
            index = int(raw) - 1
            spec = SETTING_SPECS[index]
            if index < 0:
                raise IndexError
        except (ValueError, IndexError):
            print(f"Choose a number from 1 to {len(SETTING_SPECS)}.")
            continue
        if not spec.editable:
            print(spec.description)
            continue
        candidate = config
        try:
            if spec.kind == "outlook_store":
                changed = _edit_outlook_store_setting(candidate, base=store.config_home)
            elif spec.kind == "directory":
                changed = _edit_directory_setting(candidate, spec, base=store.config_home)
            elif spec.kind == "xlsx_template":
                changed = _edit_xlsx_template_setting(candidate, spec, base=store.config_home)
            else:
                changed = _edit_scalar_setting(candidate, spec, base=store.config_home)
            if changed:
                store.save_config(candidate)
                print("Configuration saved.")
        except (OSError, ValueError) as exc:
            print(f"Configuration was not changed: {exc}")


def _first_run_setup(store: ZeusStore) -> None:
    paths = store.config.get("paths", {})
    required_setup = not (
        paths.get("workbook_directory") and paths.get("advanced_search_directory")
    )
    outlook_problem: str | None = None
    if paths.get("outlook_store_path"):
        try:
            prepare_outlook_store_path(
                paths["outlook_store_path"], base=store.config_home
            )
        except ValueError as exc:
            outlook_problem = str(exc)
    if not required_setup and outlook_problem is None:
        return
    print("\nZeus first-run path setup")
    print("Paths are saved under the local Zeus application-data directory.")
    config = store.config
    target = config.setdefault("paths", {})
    if not target.get("workbook_directory"):
        while True:
            raw = input("Folder containing Pendings.xlsx and Closed.xlsx: ").strip().strip('"')
            if not raw:
                continue
            directory = Path(raw).expanduser().resolve()
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                print(f"Cannot use that directory: {exc}")
                continue
            target["workbook_directory"] = str(directory)
            break
    if not target.get("advanced_search_directory"):
        while True:
            raw = input("Folder containing Advanced Search*.xlsx downloads: ").strip().strip('"')
            directory = Path(raw).expanduser().resolve() if raw else None
            if directory is None or not directory.is_dir():
                print("That directory does not exist.")
                continue
            target["advanced_search_directory"] = str(directory)
            break
    if outlook_problem is not None:
        print(f"\nExisting Outlook configuration needs correction: {outlook_problem}")
    if outlook_problem is not None or (
        required_setup and not target.get("outlook_store_path")
    ):
        while True:
            try:
                changed = _edit_outlook_store_setting(
                    config,
                    base=store.config_home,
                    blank_disables_when_unconfigured=True,
                )
                if changed:
                    break
                print("No store was selected. Choose a store or disable Outlook email.")
            except (OSError, ValueError) as exc:
                print(exc)
    store.save_config(config)


def _doctor(store: ZeusStore) -> dict[str, Any]:
    result: dict[str, Any] = {
        "store": "ok",
        "paths": {},
        "tickets": 0,
        "diagnostic_log": str(diagnostic_log_path(store.config_home)),
    }
    try:
        store.validate_current(store.current)
        result["tickets"] = sum(1 for _ in store.iter_ticket_ids())
    except Exception as exc:
        result["store"] = f"error: {exc}"
    for key in (
        "workbook_directory",
        "advanced_search_directory",
        "outlook_store_path",
        "template_directory",
        "spare_parts_export_directory",
        "spare_request_template_path",
        "spare_return_template_path",
    ):
        path = store.configured_directory(key)
        result["paths"][key] = str(path) if path else "not configured"
    return result


def _run_action(store: ZeusStore, action: str) -> bool:
    try:
        if action == "quit":
            return False
        if action == "publish":
            directory = store.configured_directory("workbook_directory")
            if directory is None:
                print("Configure paths.workbook_directory first.")
            elif _confirm("Publish both managed workbooks and finalize pending closures?"):
                create = not (directory / "Pendings.xlsx").exists() or not (directory / "Closed.xlsx").exists()
                if create and not _confirm("One or both files are missing. Create fresh managed workbooks?"):
                    return True
                _json_print(publish_operational_workbooks(store, directory, create_missing=create))
        elif action in {"fetch", "rebuild_email"}:
            # Eligibility must be refreshed before every mailbox scan.
            sync_newest_advanced_search(store)
            progress = StartupProgress()
            progress.start()
            try:
                _json_print(
                    fetch_and_commit_outlook(
                        store,
                        full_scan=True if action == "rebuild_email" else None,
                        cancel_event=progress.cancel_event,
                        progress=progress.update,
                    )
                )
            finally:
                progress.stop()
        elif action == "sync_email":
            _json_print(synchronize_staged_email(store))
        elif action == "sync_advanced":
            _json_print(sync_newest_advanced_search(store))
        elif action == "restore":
            directory = store.configured_directory("workbook_directory")
            if directory is None:
                print("Configure paths.workbook_directory first.")
            else:
                backups = list_pendings_backups(directory)
                if not backups:
                    print("No Pendings backups are available.")
                else:
                    for index, path in enumerate(backups[:10], start=1):
                        print(f"{index}. {path.name}")
                    raw = input("Backup number (blank cancels): ").strip()
                    if raw:
                        choice = int(raw) - 1
                        selected = backups[choice]
                        preview = preview_pendings_restore(store, selected)
                        print(json_dumps(preview))
                        if _confirm(
                            f"Restore local fields and colours from {selected.name}?"
                        ):
                            _json_print(restore_pendings_backup(store, selected, directory))
        elif action == "config":
            _interactive_config(store)
        elif action == "doctor":
            _json_print(_doctor(store))
    except (
        ValueError,
        StoreError,
        WorkbookPublicationError,
        MailSyncError,
        OSError,
    ) as exc:
        print(f"\nERROR: {exc}")
    input("\nPress Enter to return to Zeus...")
    return True


def interactive(store: ZeusStore) -> int:
    if os.name == "nt":
        os.system("")  # enable ANSI processing before first-run/startup output
    _request_console_fullscreen()
    _first_run_setup(store)
    startup = run_startup_with_progress(store)
    running = True
    while running:
        result = ZeusTUI(store, startup).run() or {"action": "quit"}
        running = _run_action(store, result.get("action", "quit"))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="zeus", description="Zeus legacy non-interactive commands")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("startup")
    sub.add_parser("dashboard")
    list_parser = sub.add_parser("list")
    list_parser.add_argument("--status", choices=["all", "active", "closure_pending"], default="all")
    show = sub.add_parser("show")
    show.add_argument("ticket_id")

    paths = sub.add_parser("paths")
    paths_sub = paths.add_subparsers(dest="paths_command", required=True)
    paths_sub.add_parser("show")
    paths_set = paths_sub.add_parser("set")
    paths_set.add_argument("--workbooks", type=Path)
    paths_set.add_argument("--advanced-search", type=Path)
    paths_set.add_argument("--outlook-store", type=Path)

    settings = sub.add_parser("settings")
    settings_sub = settings.add_subparsers(dest="settings_command", required=True)
    settings_sub.add_parser("show")
    settings_set = settings_sub.add_parser("set")
    settings_set.add_argument("key")
    settings_set.add_argument("value")

    sync = sub.add_parser("sync-advanced")
    sync.add_argument("--source", type=Path)
    sync.add_argument("--dry-run", action="store_true")
    sync.add_argument("--allow-older", action="store_true")

    publish = sub.add_parser("publish")
    publish.add_argument("--create-missing", action="store_true")
    publish.add_argument("--yes", action="store_true")

    mail = sub.add_parser("mail")
    mail_sub = mail.add_subparsers(dest="mail_command", required=True)
    mail_sub.add_parser("fetch")
    mail_sub.add_parser("rebuild")
    mail_sub.add_parser("sync")

    restore = sub.add_parser("restore-pendings")
    restore.add_argument("backup", type=Path)
    restore.add_argument("--yes", action="store_true")

    sub.add_parser("doctor")
    mop = sub.add_parser("mop")
    mop_sub = mop.add_subparsers(dest="mop_command", required=True)
    fields = mop_sub.add_parser("fields")
    fields.add_argument("ticket_id")
    generate = mop_sub.add_parser("generate")
    generate.add_argument("ticket_id")
    generate.add_argument("--template", required=True, type=Path)
    generate.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    store: ZeusStore | None = None
    try:
        store = create_store()
        if args.command is None:
            return interactive(store)
        if args.command == "startup":
            _json_print(run_startup_with_progress(store).to_dict())
        elif args.command == "dashboard":
            for ticket in sorted(
                store.iter_tickets(status="active"),
                key=lambda item: report_sort_key(item, store.config),
            ):
                _json_print(_ticket_summary(ticket, store))
        elif args.command == "list":
            _json_print([_ticket_summary(ticket, store) for ticket in store.iter_tickets(status=args.status)])
        elif args.command == "show":
            _json_print(store.read_ticket(args.ticket_id))
        elif args.command == "paths":
            if args.paths_command == "show":
                _json_print(store.config.get("paths", {}))
            else:
                command_paths_set(
                    store,
                    Console(),
                    workbook_directory=args.workbooks,
                    advanced_search_directory=args.advanced_search,
                    outlook_store_path=args.outlook_store,
                )
        elif args.command == "settings":
            if args.settings_command == "show":
                _json_print(store.config)
            else:
                config = store.config
                value = coerce_setting_value(
                    args.key, args.value, base=store.config_home
                )
                set_dotted(config, args.key, value)
                store.save_config(config)
                _json_print(config)
        elif args.command == "sync-advanced":
            command_sync(
                store,
                Console(),
                source=args.source,
                dry_run=args.dry_run,
                allow_older=args.allow_older,
                assume_yes=True,
            )
        elif args.command == "publish":
            if not args.yes:
                parser.error("publish requires --yes in non-interactive mode")
            directory = store.configured_directory("workbook_directory")
            if directory is None:
                raise ValueError("Workbook directory is not configured")
            _json_print(
                publish_operational_workbooks(
                    store, directory, create_missing=args.create_missing
                )
            )
        elif args.command == "mail":
            if args.mail_command == "sync":
                _json_print(synchronize_staged_email(store))
            else:
                sync_newest_advanced_search(store)
                _json_print(
                    fetch_and_commit_outlook(
                        store, full_scan=True if args.mail_command == "rebuild" else None
                    )
                )
        elif args.command == "restore-pendings":
            if not args.yes:
                parser.error("restore-pendings requires --yes")
            directory = store.configured_directory("workbook_directory")
            if directory is None:
                raise ValueError("Workbook directory is not configured")
            _json_print(restore_pendings_backup(store, args.backup, directory))
        elif args.command == "doctor":
            _json_print(_doctor(store))
        elif args.command == "mop":
            if args.mop_command == "fields":
                _json_print(build_placeholder_values(store, args.ticket_id))
            else:
                _json_print(
                    generate_mop(
                        store,
                        args.ticket_id,
                        args.template,
                        copy_to=args.output,
                    )
                )
        return 0
    except KeyboardInterrupt:
        print("Cancelled; no incomplete operation was committed.", file=sys.stderr)
        return 130
    except Exception as exc:
        home = store.config_home if store is not None else application_home()
        log_path = record_exception(home, f"command: {args.command or 'interactive'}", exc)
        print(f"ERROR: {exc}", file=sys.stderr)
        if log_path is not None:
            print(f"Diagnostic log: {log_path}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
