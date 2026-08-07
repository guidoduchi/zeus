from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

from .version import __version__


LOG_DIRECTORY = "logs"
LOG_FILENAME = "zeus.log"
MAX_LOG_BYTES = 1_000_000


def diagnostic_log_path(config_home: Path) -> Path:
    """Return the local-only diagnostic log used for recoverable failures."""

    return config_home / LOG_DIRECTORY / LOG_FILENAME


def _rotate_if_needed(path: Path) -> None:
    if not path.exists() or path.stat().st_size < MAX_LOG_BYTES:
        return
    previous = path.with_suffix(".log.1")
    previous.unlink(missing_ok=True)
    os.replace(path, previous)


def record_exception(
    config_home: Path,
    context: str,
    error: BaseException,
) -> Path | None:
    """Append a traceback without allowing diagnostics to break Zeus.

    Logs remain beneath the local Zeus application-data directory.  Callers
    pass only an exception and a short operation label; ticket records and
    email bodies are never serialized here.
    """

    path = diagnostic_log_path(config_home)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed(path)
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        traceback_text = "".join(
            traceback.format_exception(type(error), error, error.__traceback__)
        ).rstrip()
        with path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(
                f"[{timestamp}] Zeus {__version__} | Python "
                f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\n"
            )
            handle.write(f"Context: {context}\n")
            handle.write(traceback_text + "\n\n")
            handle.flush()
            os.fsync(handle.fileno())
        return path
    except Exception:
        return None
