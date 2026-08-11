from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from ..config import (
    SETTING_SPECS,
    coerce_setting_value,
    get_dotted,
    scan_outlook_store_files,
    set_dotted,
)
from ..excel_import import find_latest_advanced_search
from ..store import ZeusStore
from ..storage_migration import storage_status
from .errors import ValidationError


def _path_status(store: ZeusStore, key: str, value: Any) -> dict[str, Any]:
    if key == "data_directory":
        status = storage_status(store)
        return {
            "configured": True,
            "exists": store.root.is_dir(),
            "path": str(store.root),
            "message": (
                "Low space — move the data folder"
                if status["lowSpace"]
                else f"{status['freeBytes'] // (1024 * 1024)} MiB available"
            ),
            **status,
        }
    if not value:
        return {"configured": False, "exists": False, "message": "Not configured"}
    path = store.configured_directory(key)
    if path is None:
        return {"configured": False, "exists": False, "message": "Not configured"}
    status: dict[str, Any] = {
        "configured": True,
        "exists": path.exists(),
        "path": str(path),
    }
    if key == "workbook_directory":
        if not path.is_dir():
            status["message"] = "Folder not found"
        else:
            found = [name for name in ("Pendings.xlsx", "Closed.xlsx") if (path / name).is_file()]
            status["files"] = found
            status["message"] = (
                f"Found {', '.join(found)}" if found else "No managed workbooks found"
            )
    elif key == "advanced_search_directory":
        if not path.is_dir():
            status["message"] = "Folder not found"
        else:
            try:
                latest = find_latest_advanced_search(path, store.config)
            except Exception as exc:
                status["message"] = str(exc)
            else:
                status["latest"] = latest.name
                status["message"] = f"Latest: {latest.name}"
    elif key == "outlook_store_path":
        status["message"] = "Outlook store is available" if path.is_file() else "Outlook store not found"
    elif key == "template_directory":
        count = sum(1 for _ in path.glob("*.docx")) if path.is_dir() else 0
        status["templateCount"] = count
        status["message"] = f"{count} Word template(s) found" if path.is_dir() else "Folder not found"
    elif key == "spare_parts_export_directory":
        count = sum(1 for _ in path.rglob("*.xlsx")) if path.is_dir() else 0
        status["workbookCount"] = count
        status["writeOnly"] = True
        status["message"] = (
            f"Export-only folder · {count} workbook(s)"
            if path.is_dir()
            else "Folder not found"
        )
    elif key in {"spare_request_template_path", "spare_return_template_path"}:
        status["message"] = (
            f"Template available: {path.name}"
            if path.is_file() and path.suffix.lower() == ".xlsx"
            else "XLSX template not found"
        )
    return status


def settings_payload(store: ZeusStore) -> dict[str, Any]:
    config = store.config
    items: list[dict[str, Any]] = []
    for spec in SETTING_SPECS:
        value = str(store.root) if spec.key == "paths.data_directory" else get_dotted(config, spec.key)
        item = {
            "key": spec.key,
            "label": spec.label,
            "category": spec.category,
            "kind": spec.kind,
            "description": spec.description,
            "minimum": spec.minimum,
            "choices": list(spec.choices),
            "nullable": spec.nullable,
            "editable": spec.editable and not (
                spec.key == "email.sync_interval_minutes"
                and config.get("email", {}).get("sync_mode") == "after_fetch"
            ),
            "value": deepcopy(value),
        }
        if spec.key.startswith("paths."):
            item["status"] = _path_status(store, spec.key.split(".", 1)[1], value)
        items.append(item)
    return {"schemaVersion": config.get("schema_version"), "settings": items}


def update_settings(store: ZeusStore, updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict) or not updates:
        raise ValidationError("Choose at least one setting to update")
    config = store.config
    changed: list[str] = []
    for key, raw_value in updates.items():
        spec = next((candidate for candidate in SETTING_SPECS if candidate.key == key), None)
        if spec is None:
            raise ValidationError(f"Unknown configuration setting: {key}")
        if not spec.editable:
            raise ValidationError(f"{spec.label} is fixed")
        if (
            key == "email.sync_interval_minutes"
            and config.get("email", {}).get("sync_mode") == "after_fetch"
            and "email.sync_mode" not in updates
        ):
            raise ValidationError(
                "Email synchronization interval is inherited from the fetch interval in linked mode"
            )
        try:
            value = coerce_setting_value(key, raw_value, base=store.config_home)
            if spec.kind == "directory" and value is not None and not Path(value).is_dir():
                raise ValueError(f"Folder does not exist: {value}")
            if spec.kind == "xlsx_template" and value is not None and not Path(value).is_file():
                raise ValueError(f"XLSX template does not exist: {value}")
            if get_dotted(config, key) != value:
                set_dotted(config, key, value)
                changed.append(key)
        except (OSError, ValueError) as exc:
            raise ValidationError(str(exc), details={"setting": key}) from exc
    if config.get("email", {}).get("sync_mode") == "after_fetch":
        linked_interval = config["email"]["fetch_interval_minutes"]
        if config["email"].get("sync_interval_minutes") != linked_interval:
            config["email"]["sync_interval_minutes"] = linked_interval
            if "email.sync_interval_minutes" not in changed:
                changed.append("email.sync_interval_minutes")
    if changed:
        store.save_config(config)
        store.append_audit("configuration-update", {"changed_settings": changed})
    result = settings_payload(store)
    result["changed"] = changed
    return result


def outlook_candidates(store: ZeusStore, directory: str) -> list[dict[str, Any]]:
    try:
        candidates = scan_outlook_store_files(directory, base=store.config_home)
    except (OSError, ValueError) as exc:
        raise ValidationError(str(exc)) from exc
    selected = store.config.get("paths", {}).get("outlook_store_path")
    return [
        {
            "path": str(path),
            "name": path.name,
            "selected": str(path) == str(selected or ""),
        }
        for path in candidates
    ]
