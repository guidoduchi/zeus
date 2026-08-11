from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
import time
from datetime import date, datetime, time as datetime_time, timezone
from pathlib import Path
from typing import Any, Iterable


ISO_Z_SUFFIX = "Z"
ATOMIC_REPLACE_ATTEMPTS = 8
ATOMIC_REPLACE_BASE_DELAY_SECONDS = 0.05


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return now_utc().isoformat().replace("+00:00", ISO_Z_SUFFIX)


def to_iso(value: datetime | date | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.isoformat(timespec="seconds")
        return value.isoformat(timespec="seconds").replace("+00:00", ISO_Z_SUFFIX)
    return value.isoformat()


def parse_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime_time.min)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith(ISO_Z_SUFFIX):
        text = text[:-1] + "+00:00"
    for parser in (
        datetime.fromisoformat,
        lambda candidate: datetime.strptime(candidate, "%Y-%m-%d %H:%M:%S"),
        lambda candidate: datetime.strptime(candidate, "%Y-%m-%d"),
        lambda candidate: datetime.strptime(candidate, "%d-%b-%y"),
        lambda candidate: datetime.strptime(candidate, "%d-%b-%Y"),
    ):
        try:
            return parser(text)
        except (TypeError, ValueError):
            continue
    return None


def parse_date(value: Any) -> date | None:
    parsed = parse_datetime(value)
    return parsed.date() if parsed else None


def normalize_ticket_id(value: Any) -> str:
    if value is None or isinstance(value, bool):
        raise ValueError("ticket ID is blank or invalid")
    if isinstance(value, int):
        text = str(value)
    elif isinstance(value, float):
        if not value.is_integer():
            raise ValueError(f"ticket ID {value!r} is not an integer")
        text = str(int(value))
    else:
        text = str(value).strip()
        if re.fullmatch(r"\d+\.0", text):
            text = text[:-2]
    if not re.fullmatch(r"\d{8}", text):
        raise ValueError(f"ticket ID {text!r} must contain exactly 8 digits")
    return text


def local_today() -> date:
    """Return the machine's local calendar date.

    Zeus schedules are deliberately based on calendar dates, not rolling
    24-hour windows.  Keeping this helper in one place also makes scheduling
    behavior deterministic in tests.
    """

    return datetime.now().astimezone().date()


def calendar_days_since(value: Any, *, today: date | None = None) -> int | None:
    parsed = parse_datetime(value)
    if parsed is None:
        return None
    return ((today or local_today()) - parsed.astimezone().date() if parsed.tzinfo else
            (today or local_today()) - parsed.date()).days


def split_multi(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        candidates: Iterable[Any] = value
    else:
        candidates = re.split(r"[\r\n;,]+", str(value))
    result: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        text = str(candidate).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def coerce_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return to_iso(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    return value


def json_dumps(value: Any, *, indent: int | None = 2) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        indent=indent,
        sort_keys=False,
        default=coerce_json_value,
    )


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding=encoding, newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        _replace_with_retry(temporary_path, path)
    except Exception:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            # Preserve the original write error. A locked temporary file lives
            # only inside Zeus's disposable transaction directory.
            pass
        raise


def _replace_with_retry(source: Path, destination: Path) -> None:
    """Replace one file after bounded retries for transient Windows locks.

    Antivirus, indexing, and inherited read-only attributes can briefly deny a
    replace even inside Zeus's private transaction clone. Non-permission
    failures remain immediate; a persistent denial is raised after less than
    three seconds so the caller can preserve the previous database and report
    a useful diagnostic.
    """

    for attempt in range(1, ATOMIC_REPLACE_ATTEMPTS + 1):
        try:
            os.replace(source, destination)
            return
        except OSError as exc:
            retryable = (
                isinstance(exc, PermissionError)
                or getattr(exc, "winerror", None) in {5, 32}
                or getattr(exc, "errno", None) in {1, 13}
            )
            if not retryable or attempt >= ATOMIC_REPLACE_ATTEMPTS:
                if retryable and hasattr(exc, "add_note"):
                    exc.add_note(
                        f"Zeus retried the atomic replacement {attempt} times: "
                        f"{source} -> {destination}"
                    )
                raise
            if destination.exists():
                try:
                    destination.chmod(destination.stat().st_mode | stat.S_IWRITE)
                except OSError:
                    # A sharing lock can also block chmod. The later retry is
                    # still useful and the original replace error is retained.
                    pass
            delay = min(
                ATOMIC_REPLACE_BASE_DELAY_SECONDS * (2 ** (attempt - 1)),
                0.5,
            )
            time.sleep(delay)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json_dumps(value) + "\n")


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def hash_identifier(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def safe_filename(value: str, fallback: str = "output") -> str:
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return sanitized or fallback


def excel_column_name(index: int) -> str:
    if index < 1:
        raise ValueError("Excel column index must be at least 1")
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result
