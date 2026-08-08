from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

from ..application.errors import FeatureUnavailableError, ValidationError


_DIALOG_LOCK = threading.Lock()


def choose_directory(*, initial: Path | None = None, title: str = "Choose a folder") -> Path | None:
    """Open a native folder picker on the machine running Zeus."""

    with _DIALOG_LOCK:
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            try:
                selected = filedialog.askdirectory(
                    parent=root,
                    title=title,
                    initialdir=str(initial) if initial and initial.is_dir() else None,
                    mustexist=True,
                )
            finally:
                root.destroy()
        except Exception as exc:
            raise FeatureUnavailableError(
                "The native folder picker could not open. Enter the path manually instead."
            ) from exc
    return Path(selected).expanduser().resolve() if selected else None


def choose_file(
    *,
    initial: Path | None = None,
    title: str = "Choose a file",
    filetypes: tuple[tuple[str, str], ...] = (("All files", "*.*"),),
) -> Path | None:
    with _DIALOG_LOCK:
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            try:
                selected = filedialog.askopenfilename(
                    parent=root,
                    title=title,
                    initialdir=str(initial) if initial and initial.is_dir() else None,
                    filetypes=filetypes,
                )
            finally:
                root.destroy()
        except Exception as exc:
            raise FeatureUnavailableError(
                "The native file picker could not open. Enter the path manually instead."
            ) from exc
    return Path(selected).expanduser().resolve() if selected else None


def open_folder(path: Path) -> None:
    target = path.expanduser().resolve()
    if target.is_file():
        target = target.parent
    if not target.is_dir():
        raise ValidationError(f"Folder not found: {target}")
    try:
        if sys.platform == "win32":
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except OSError as exc:
        raise FeatureUnavailableError(f"Could not open {target}") from exc
