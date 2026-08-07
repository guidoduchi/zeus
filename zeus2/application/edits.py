from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

from openpyxl import load_workbook

from ..excel_import import (
    WorkbookValidationError,
    read_pendings,
    validate_pendings_against_state,
)
from ..reconcile import import_pendings
from ..store import ZeusStore
from ..tickets import LOCAL_COLUMNS, normalize_done
from ..utils import parse_date, sha256_file
from .errors import ConflictError, FeatureUnavailableError, ValidationError
from .serialization import ticket_revision


class PendingsConflictError(ConflictError):
    code = "pendings_conflict"


class TicketRevisionConflictError(ConflictError):
    code = "ticket_revision_conflict"


def _normalize_local_changes(changes: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(changes, dict) or not changes:
        raise ValidationError("Choose at least one Pendings field to update")
    unknown = sorted(set(changes) - set(LOCAL_COLUMNS))
    if unknown:
        raise ValidationError(
            "Only Pendings-owned fields can be edited in Zeus",
            details={"unknownFields": unknown},
        )
    prepared: dict[str, Any] = {}
    for key, value in changes.items():
        if isinstance(value, (dict, list, tuple, set)):
            raise ValidationError(f"{key} must be a text, date, number, or blank value")
        if key == "Done?":
            code, corrected = normalize_done(value)
            if corrected:
                raise ValidationError("Done? must be Y, N, P, or ?")
            prepared[key] = code
            continue
        if value is None:
            prepared[key] = None
            continue
        text = str(value)
        if len(text) > 100_000:
            raise ValidationError(f"{key} is too long")
        text = text if key == "Notes" else text.strip()
        if key == "Planned Date" and text.strip():
            planned = parse_date(text)
            if planned is None:
                raise ValidationError("Planned Date must be a recognizable calendar date")
            prepared[key] = planned
        else:
            prepared[key] = text if text else None
    return prepared


def _backup_directory(workbook_directory: Path) -> Path:
    target = workbook_directory / "Zeus Backups" / "Web edits"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _create_edit_backup(path: Path, *, retention: int) -> Path:
    target = _backup_directory(path.parent)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = target / f"Pendings-before-web-edit-{stamp}.xlsx"
    shutil.copy2(path, backup)
    backups = sorted(
        target.glob("Pendings-before-web-edit-*.xlsx"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for stale in backups[max(1, retention) :]:
        stale.unlink(missing_ok=True)
    return backup


def _restore_workbook(backup: Path, destination: Path) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".zeus-web-edit-rollback-",
        suffix=".xlsx",
        dir=destination.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(backup, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def edit_ticket_through_pendings(
    store: ZeusStore,
    ticket_id: str,
    changes: dict[str, Any],
    *,
    expected_revision: str,
) -> dict[str, Any]:
    """Edit Pendings first, then import its validated result into Markdown.

    Pendings.xlsx remains the first source of truth.  A browser save is
    therefore implemented as a safe workbook edit rather than a competing
    direct write to the Markdown record.
    """

    if not expected_revision:
        raise ValidationError("A ticket revision is required for safe editing")
    ticket = store.read_ticket(ticket_id)
    actual_revision = ticket_revision(ticket)
    if actual_revision != expected_revision:
        raise TicketRevisionConflictError(
            "This ticket changed after it was opened. Reload it before saving.",
            details={"expectedRevision": expected_revision, "actualRevision": actual_revision},
        )

    workbook_directory = store.configured_directory("workbook_directory")
    if workbook_directory is None:
        raise FeatureUnavailableError(
            "Configure the workbook folder before editing ticket fields in Zeus"
        )
    path = workbook_directory / "Pendings.xlsx"
    if not path.is_file():
        raise FeatureUnavailableError(
            "Pendings.xlsx does not exist. Zeus will not create it during a ticket edit."
        )

    state = store.state()
    last_import_sha = state.get("pendings_state", {}).get("last_import_sha256")
    current_sha = sha256_file(path)
    if not last_import_sha or current_sha != last_import_sha:
        raise PendingsConflictError(
            "Pendings.xlsx changed outside Zeus. Query data first so those Excel edits are imported.",
            details={"lastImportedSha256": last_import_sha, "currentSha256": current_sha},
        )

    managed = read_pendings(path)
    validate_pendings_against_state(
        managed,
        database_ids=set(store.iter_ticket_ids()),
        snapshot=state.get("publication_state", {}).get("pendings_snapshot"),
    )
    if ticket_id not in managed.records:
        raise PendingsConflictError(
            f"Pendings.xlsx no longer contains SR {ticket_id}. Query data before editing."
        )

    prepared = _normalize_local_changes(changes)
    existing = ticket.get("local", {}).get("fields", {})
    changed_fields = [
        key for key, value in prepared.items() if _comparable_cell(existing.get(key)) != _comparable_cell(value)
    ]
    if not changed_fields:
        return {
            "changed": False,
            "ticket": ticket,
            "revision": actual_revision,
            "changedFields": [],
            "backup": None,
        }

    workbook = load_workbook(path, data_only=False, read_only=False, keep_links=True)
    descriptor = -1
    temporary: Path | None = None
    backup: Path | None = None
    try:
        worksheet = workbook.worksheets[0]
        mapping = {
            str(cell.value).strip(): index
            for index, cell in enumerate(worksheet[1], start=1)
            if cell.value not in (None, "")
        }
        row_number = int(managed.records[ticket_id]["row_number"])
        for field in changed_fields:
            column_number = mapping.get(field)
            if column_number is None:
                raise WorkbookValidationError(f"Pendings.xlsx is missing the {field} column")
            worksheet.cell(row=row_number, column=column_number).value = prepared[field]

        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".zeus-web-edit-",
            suffix=".xlsx",
            dir=path.parent,
        )
        os.close(descriptor)
        descriptor = -1
        temporary = Path(temporary_name)
        workbook.save(temporary)
        candidate = read_pendings(temporary)
        validate_pendings_against_state(
            candidate,
            database_ids=set(store.iter_ticket_ids()),
            snapshot=state.get("publication_state", {}).get("pendings_snapshot"),
        )
        retention = int(store.config.get("excel", {}).get("backup_retention_count", 10))
        backup = _create_edit_backup(path, retention=retention)
        try:
            os.replace(temporary, path)
            temporary = None
        except PermissionError as exc:
            raise FeatureUnavailableError(
                "Pendings.xlsx is locked. Save and close it in Excel, then try again."
            ) from exc

        try:
            import_summary = import_pendings(store, path)
        except Exception:
            _restore_workbook(backup, path)
            raise
    finally:
        workbook.close()
        if descriptor >= 0:
            os.close(descriptor)
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    updated = store.read_ticket(ticket_id)
    store.append_audit(
        "web-local-edit",
        {
            "ticket_id": ticket_id,
            "changed_fields": changed_fields,
            "pendings_backup": backup.name if backup else None,
        },
    )
    return {
        "changed": True,
        "ticket": updated,
        "revision": ticket_revision(updated),
        "changedFields": changed_fields,
        "backup": str(backup) if backup else None,
        "import": import_summary,
    }


def _comparable_cell(value: Any) -> Any:
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except (TypeError, ValueError):
            pass
    if value is None:
        return None
    return str(value).strip()
