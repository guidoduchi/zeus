from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from .config import save_config
from .store import FileLock, ZeusStore
from .utils import atomic_write_json, iso_now, json_dumps, load_json, sha256_file


MINIMUM_FREE_BYTES = 20 * 1024 * 1024
MIGRATION_MARKER_FILENAME = "data_migration.json"
EXCLUDED_ROOT_FILES = {".zeus.lock"}


class StorageMigrationError(RuntimeError):
    pass


def migration_marker_path(config_home: Path) -> Path:
    return config_home.expanduser().resolve() / MIGRATION_MARKER_FILENAME


def _existing_anchor(path: Path) -> Path:
    candidate = path.expanduser().resolve()
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    if not candidate.exists():
        raise StorageMigrationError(f"Cannot inspect storage for {path}")
    return candidate


def free_bytes(path: Path) -> int:
    return int(shutil.disk_usage(_existing_anchor(path)).free)


def _manifest(root: Path) -> list[dict[str, Any]]:
    if not root.is_dir():
        raise StorageMigrationError(f"Zeus data folder was not found: {root}")
    rows: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda value: value.as_posix().casefold()):
        if not path.is_file() or (path.parent == root and path.name in EXCLUDED_ROOT_FILES):
            continue
        relative = path.relative_to(root).as_posix()
        rows.append(
            {
                "path": relative,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return rows


def _manifest_digest(rows: list[dict[str, Any]]) -> str:
    payload = json_dumps(rows, indent=None).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def directory_size(root: Path) -> int:
    if not root.exists():
        return 0
    total = 0
    for path in root.rglob("*"):
        if path.is_file() and not (path.parent == root and path.name in EXCLUDED_ROOT_FILES):
            try:
                total += path.stat().st_size
            except OSError:
                continue
    return total


def storage_status(store: ZeusStore) -> dict[str, Any]:
    available = free_bytes(store.root)
    size = directory_size(store.root)
    marker = load_json(migration_marker_path(store.config_home), None)
    return {
        "currentPath": str(store.root),
        "dataBytes": size,
        "freeBytes": available,
        "minimumFreeBytes": MINIMUM_FREE_BYTES,
        "lowSpace": available < MINIMUM_FREE_BYTES,
        "migrationPending": isinstance(marker, dict)
        and marker.get("state") in {"prepared", "cleanup_pending"},
    }


def _validate_destination(source: Path, destination: Path) -> None:
    if destination == source:
        raise StorageMigrationError("The selected data folder is already in use")
    if source in destination.parents or destination in source.parents:
        raise StorageMigrationError("The new data folder cannot contain, or be inside, the current data folder")
    if destination.exists():
        if not destination.is_dir():
            raise StorageMigrationError(f"The selected destination is not a folder: {destination}")
        try:
            if any(destination.iterdir()):
                raise StorageMigrationError("Choose an empty folder for the Zeus data migration")
        except OSError as exc:
            raise StorageMigrationError(f"Cannot inspect destination {destination}: {exc}") from exc


def prepare_data_migration(store: ZeusStore, destination: Path) -> dict[str, Any]:
    source = store.root.expanduser().resolve()
    target = destination.expanduser().resolve()
    _validate_destination(source, target)
    source_size = directory_size(source)
    available = free_bytes(target)
    required = source_size + MINIMUM_FREE_BYTES
    if available < required:
        raise StorageMigrationError(
            "The destination needs enough free space for the current Zeus data "
            f"plus a 20 MiB reserve ({required} bytes required, {available} available)"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".{target.name}.zeus-migration-{uuid.uuid4().hex}"
    marker_path = migration_marker_path(store.config_home)
    if marker_path.exists():
        raise StorageMigrationError("A Zeus data migration is already awaiting restart")
    with FileLock(store.lock_file):
        source_manifest = _manifest(source)
        clone_moved = False
        try:
            shutil.copytree(
                source,
                staging,
                ignore=shutil.ignore_patterns(*EXCLUDED_ROOT_FILES),
                copy_function=shutil.copy2,
            )
            cloned_manifest = _manifest(staging)
            if cloned_manifest != source_manifest:
                raise StorageMigrationError("The cloned Zeus data failed file verification")
            if target.exists():
                target.rmdir()
            os.replace(staging, target)
            clone_moved = True
            marker = {
                "schema_version": 1,
                "state": "prepared",
                "prepared_at": iso_now(),
                "old_root": str(source),
                "new_root": str(target),
                "manifest_sha256": _manifest_digest(source_manifest),
                "file_count": len(source_manifest),
                "bytes_copied": sum(int(row["size"]) for row in source_manifest),
            }
            atomic_write_json(marker_path, marker)
            config = deepcopy(store.config)
            config.setdefault("paths", {})["data_directory"] = str(target)
            save_config(store.config_home, config)
        except Exception:
            marker_path.unlink(missing_ok=True)
            if clone_moved:
                shutil.rmtree(target, ignore_errors=True)
            raise
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
    return {
        "restartRequired": True,
        "oldPath": str(source),
        "newPath": str(target),
        "bytesCopied": marker["bytes_copied"],
        "freeBytesAfterCopy": free_bytes(target),
    }


def configured_data_root(config_home: Path, config: dict[str, Any]) -> Path:
    """Resolve the configured mutable root without performing a handoff."""

    configured = config.get("paths", {}).get("data_directory")
    if configured:
        path = Path(str(configured)).expanduser()
        if not path.is_absolute():
            path = config_home / path
        return path.resolve()
    return (config_home / "data").resolve()


def finalize_pending_data_migration(
    config_home: Path,
    config: dict[str, Any],
) -> tuple[Path, list[str]]:
    """Select the startup data root and finalize a verified post-restart move."""

    home = config_home.expanduser().resolve()
    selected = configured_data_root(home, config)
    marker_path = migration_marker_path(home)
    marker = load_json(marker_path, None)
    if not isinstance(marker, dict) or marker.get("state") not in {
        "prepared",
        "cleanup_pending",
    }:
        return selected, []
    try:
        old_root = Path(str(marker["old_root"])).expanduser().resolve()
        new_root = Path(str(marker["new_root"])).expanduser().resolve()
        expected_digest = str(marker["manifest_sha256"])
    except (KeyError, TypeError, ValueError) as exc:
        raise StorageMigrationError("The pending Zeus migration marker is invalid") from exc
    if selected != new_root:
        raise StorageMigrationError("The pending Zeus migration does not match the configured data folder")
    if old_root == new_root or old_root in new_root.parents or new_root in old_root.parents:
        raise StorageMigrationError("The pending Zeus migration contains unsafe folder paths")

    if marker.get("state") == "cleanup_pending":
        # This clone was already hash-verified and selected on the previous
        # startup. It is now authoritative and may have received legitimate
        # writes before Windows releases a handle on the old tree. Never
        # compare it with the pre-handoff digest or roll back at this stage.
        if not new_root.is_dir():
            raise StorageMigrationError(
                "The active migrated Zeus data folder is unavailable while old-folder cleanup is pending"
            )
        try:
            if old_root.exists():
                shutil.rmtree(old_root)
        except OSError as exc:
            return new_root, [
                "Zeus is using the migrated data folder, but could not yet remove the old "
                f"copy at {old_root}: {exc}. It will retry on the next restart."
            ]
        marker_path.unlink(missing_ok=True)
        return new_root, [
            f"Zeus moved its data to {new_root} and removed the verified original copy."
        ]

    new_valid = new_root.is_dir() and _manifest_digest(_manifest(new_root)) == expected_digest
    old_valid = old_root.is_dir() and _manifest_digest(_manifest(old_root)) == expected_digest
    if not new_valid or not old_valid:
        if old_root.is_dir():
            rolled_back = deepcopy(config)
            default_old = (home / "data").resolve()
            rolled_back.setdefault("paths", {})["data_directory"] = (
                None if old_root == default_old else str(old_root)
            )
            save_config(home, rolled_back)
            marker_path.unlink(missing_ok=True)
            if new_root.is_dir():
                shutil.rmtree(new_root, ignore_errors=True)
            return old_root, [
                "The requested data-folder move could not be verified after restart. "
                "Zeus kept the original data and restored its previous location."
            ]
        raise StorageMigrationError(
            "Neither side of the pending Zeus data migration passed verification"
        )

    cleanup_marker = deepcopy(marker)
    cleanup_marker["state"] = "cleanup_pending"
    cleanup_marker["verified_at"] = iso_now()
    atomic_write_json(marker_path, cleanup_marker)
    try:
        shutil.rmtree(old_root)
    except OSError as exc:
        return new_root, [
            "Zeus is using the migrated data folder, but could not yet remove the old "
            f"copy at {old_root}: {exc}. It will retry on the next restart."
        ]
    marker_path.unlink(missing_ok=True)
    return new_root, [
        f"Zeus moved its data to {new_root} and removed the verified original copy."
    ]
