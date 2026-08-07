from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from .excel_import import (
    ManagedWorkbook,
    WorkbookValidationError,
    find_latest_advanced_search,
    read_advanced_search,
    read_closed,
    read_pendings,
    validate_closed_against_index,
    validate_pendings_against_state,
)
from .store import StoreError, ZeusStore
from .tickets import UPSTREAM_COLUMNS, new_ticket, normalize_local, refresh_upstream
from .utils import atomic_write_json, iso_now, sha256_file


class ReconciliationError(StoreError):
    """Raised when a requested reconciliation would be unsafe."""


def _protected_snapshot(workbook: ManagedWorkbook) -> dict[str, Any]:
    return {
        "filename": workbook.path.name,
        "sha256": workbook.sha256,
        "captured_at": iso_now(),
        "header_order": workbook.header_order,
        "ticket_ids": sorted(workbook.records, reverse=True),
        "protected_values": {
            ticket_id: deepcopy(record["upstream_fields"])
            for ticket_id, record in workbook.records.items()
        },
    }


def import_pendings(
    store: ZeusStore,
    path: Path,
    *,
    bootstrap_if_empty: bool = True,
) -> dict[str, Any]:
    """Validate and atomically import only Pendings-owned data.

    This is the permanent first startup operation.  Protected cells are
    compared with the last generated snapshot, so an older exported value is
    not mistaken for corruption after Advanced Search legitimately changes it.
    """

    store.ensure_layout()
    workbook = read_pendings(path)
    database_ids = set(store.iter_ticket_ids())
    state = store.state()
    snapshot = state.get("publication_state", {}).get("pendings_snapshot")
    validate_pendings_against_state(
        workbook, database_ids=database_ids, snapshot=snapshot
    )
    if not database_ids and workbook.records and not bootstrap_if_empty:
        raise ReconciliationError(
            "The ticket database is empty and Pendings bootstrap was disabled"
        )

    bootstrap = not database_ids and bool(workbook.records)
    changed_ids: list[str] = []
    timestamp = iso_now()
    summary: dict[str, Any] = {
        "path": str(workbook.path),
        "rows": len(workbook.records),
        "bootstrap": bootstrap,
        "changed_ids": changed_ids,
        "done_corrections": workbook.done_corrections,
    }

    with store.transaction("pendings-import", summary, backup=bool(database_ids)) as staging:
        if bootstrap:
            source = {
                "kind": "pendings_bootstrap",
                "filename": workbook.path.name,
                "sha256": workbook.sha256,
                "processed_at": timestamp,
            }
            for ticket_id, record in workbook.records.items():
                local = normalize_local(record["local"])
                ticket = new_ticket(
                    ticket_id,
                    record["upstream_fields"],
                    source,
                    sr_url=record.get("sr_url"),
                    local=local,
                    timestamp=timestamp,
                )
                store.write_ticket_bundle(staging, ticket)
                changed_ids.append(ticket_id)
        else:
            for ticket_id, record in workbook.records.items():
                ticket = store.read_ticket(ticket_id, staging)
                local = normalize_local(record["local"])
                if ticket.get("local") != local:
                    ticket["local"] = deepcopy(local)
                    ticket["updated_at"] = timestamp
                    store.write_ticket_bundle(staging, ticket)
                    changed_ids.append(ticket_id)

        staged_state = store.state(staging)
        staged_state.setdefault("pendings_state", {})["last_import_at"] = timestamp
        staged_state["pendings_state"]["last_error"] = None
        staged_state["pendings_state"]["last_import_sha256"] = workbook.sha256
        # The first trusted workbook becomes the protected-cell baseline even
        # before the first Zeus publication.
        if snapshot is None:
            staged_state.setdefault("publication_state", {})[
                "pendings_snapshot"
            ] = _protected_snapshot(workbook)
        atomic_write_json(staging / "state.json", staged_state)
    summary["changed"] = len(changed_ids)
    return summary


def record_pendings_error(store: ZeusStore, message: str) -> None:
    """Record a startup warning without changing any ticket record."""

    summary = {"error": message}
    with store.transaction("pendings-import-error", summary, backup=False) as staging:
        state = store.state(staging)
        state.setdefault("pendings_state", {})["last_error"] = message
        state["pendings_state"]["last_error_at"] = iso_now()
        atomic_write_json(staging / "state.json", state)


def initialize_closed_index(store: ZeusStore, path: Path) -> dict[str, Any]:
    """Validate Closed.xlsx and initialize/check its append-only ID index."""

    workbook = read_closed(path)
    index = store.closed_index()
    validate_closed_against_index(workbook, index)
    indexed = {str(value) for value in index.get("ticket_ids", [])}
    actual = set(workbook.records)
    if index.get("validated_at") is not None:
        return {"initialized": False, "rows": len(actual)}
    summary = {"initialized": True, "rows": len(actual)}
    with store.transaction("closed-index-initialize", summary, backup=False) as staging:
        atomic_write_json(
            staging / "closed_index.json",
            {
                "schema_version": 1,
                "ticket_ids": sorted(actual, reverse=True),
                "row_count": len(actual),
                "validated_at": iso_now(),
                "workbook_sha256": workbook.sha256,
            },
        )
    return summary


def _field_changes(
    old_fields: dict[str, Any], new_fields: dict[str, Any]
) -> list[str]:
    return [
        column
        for column in UPSTREAM_COLUMNS
        if old_fields.get(column) != new_fields.get(column)
    ]


def compute_sync_plan(
    store: ZeusStore,
    records: dict[str, dict[str, Any]],
    source: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    current = {ticket["ticket_id"]: ticket for ticket in store.iter_tickets()}
    source_ids = set(records)
    existing_ids = set(current)
    closed_ids = {
        str(value) for value in store.closed_index().get("ticket_ids", [])
    }
    reappeared_closed = sorted(source_ids & closed_ids, reverse=True)
    if reappeared_closed:
        raise ReconciliationError(
            "Advanced Search contains ticket IDs already finalized in Closed.xlsx: "
            + ", ".join(reappeared_closed)
        )

    timestamp = iso_now()
    updates: dict[str, dict[str, Any]] = {}
    added: list[str] = []
    refreshed: list[str] = []
    reactivated: list[str] = []
    closure_pending: list[str] = []
    changed_fields: dict[str, list[str]] = {}

    for ticket_id in sorted(source_ids, reverse=True):
        record = records[ticket_id]
        if ticket_id not in current:
            updates[ticket_id] = new_ticket(
                ticket_id,
                record["upstream_fields"],
                source,
                sr_url=record.get("sr_url"),
                timestamp=timestamp,
            )
            added.append(ticket_id)
            continue
        original = current[ticket_id]
        changes = _field_changes(
            original.get("upstream", {}).get("fields", {}),
            record["upstream_fields"],
        )
        if original.get("upstream", {}).get("sr_url") != record.get("sr_url"):
            changes.append("SR hyperlink")
        updated = refresh_upstream(
            original,
            record["upstream_fields"],
            source,
            sr_url=record.get("sr_url"),
            timestamp=timestamp,
        )
        lifecycle = updated.setdefault("lifecycle", {})
        if lifecycle.get("status") == "closure_pending":
            lifecycle["status"] = "active"
            lifecycle["closure_pending_at"] = None
            lifecycle["reopened_at"] = timestamp
            lifecycle["reopen_count"] = int(lifecycle.get("reopen_count") or 0) + 1
            reactivated.append(ticket_id)
        if changes:
            refreshed.append(ticket_id)
            changed_fields[ticket_id] = changes
        updates[ticket_id] = updated

    for ticket_id in sorted(existing_ids - source_ids, reverse=True):
        original = current[ticket_id]
        if original.get("lifecycle", {}).get("status") == "closure_pending":
            continue
        updated = deepcopy(original)
        lifecycle = updated.setdefault("lifecycle", {})
        lifecycle["status"] = "closure_pending"
        lifecycle["closure_pending_at"] = timestamp
        updated["updated_at"] = timestamp
        updates[ticket_id] = updated
        closure_pending.append(ticket_id)

    active_total = len(source_ids)
    pending_total = len(existing_ids - source_ids)
    summary: dict[str, Any] = {
        "source": source,
        "added": len(added),
        "added_ids": added,
        "refreshed": len(refreshed),
        "refreshed_ids": refreshed,
        "reactivated": len(reactivated),
        "reactivated_ids": reactivated,
        "closure_pending": len(closure_pending),
        "closure_pending_ids": closure_pending,
        "changed_fields": changed_fields,
        "active_total": active_total,
        "closure_pending_total": pending_total,
    }
    summary["material_change"] = any(
        summary[key]
        for key in ("added", "refreshed", "reactivated", "closure_pending")
    )
    return summary, updates


def sync_advanced_search(
    store: ZeusStore,
    source_path: Path,
    *,
    dry_run: bool = False,
    allow_older: bool = False,
    allow_changed_same_name: bool = False,
    expected_sha256: str | None = None,
) -> dict[str, Any]:
    store.ensure_layout()
    selected = find_latest_advanced_search(source_path, store.config)
    previous = store.state().get("advanced_search_state") or {}
    selected_hash = sha256_file(selected)
    same_name = previous.get("last_processed_filename") == selected.name
    same_hash = previous.get("sha256") == selected_hash
    if expected_sha256 and selected_hash != expected_sha256:
        raise ReconciliationError(
            "The selected Advanced Search workbook changed after preview"
        )
    if same_name and same_hash:
        return {
            "source": {
                "kind": "advanced_search",
                "filename": selected.name,
                "sha256": selected_hash,
                "source_timestamp": previous.get("source_timestamp"),
            },
            "selected_file": str(selected),
            "dry_run": dry_run,
            "same_source": True,
            "material_change": False,
            "added": 0,
            "added_ids": [],
            "refreshed": 0,
            "refreshed_ids": [],
            "reactivated": 0,
            "reactivated_ids": [],
            "closure_pending": 0,
            "closure_pending_ids": [],
            "active_total": sum(1 for _ in store.iter_ticket_ids(status="active")),
            "closure_pending_total": sum(
                1 for _ in store.iter_ticket_ids(status="closure_pending")
            ),
            "committed": False,
            "reason": "source_already_processed",
        }
    records, source = read_advanced_search(selected, config=store.config)
    if expected_sha256 and source["sha256"] != expected_sha256:
        raise ReconciliationError(
            "The selected Advanced Search workbook changed after preview"
        )

    same_name = previous.get("last_processed_filename") == source["filename"]
    same_hash = previous.get("sha256") == source["sha256"]
    if same_name and not same_hash and not allow_changed_same_name:
        raise ReconciliationError(
            f"{source['filename']} has different contents from the file already "
            "processed under that exact name"
        )
    previous_timestamp = str(previous.get("source_timestamp") or "")
    source_timestamp = str(source.get("source_timestamp") or "")
    if (
        previous_timestamp
        and source_timestamp
        and source_timestamp < previous_timestamp
        and not allow_older
    ):
        raise ReconciliationError(
            f"{selected.name} is older than the last processed Advanced Search"
        )

    summary, updates = compute_sync_plan(store, records, source)
    summary.update(
        {
            "selected_file": str(selected),
            "dry_run": dry_run,
            "same_source": same_name and same_hash,
        }
    )
    if dry_run:
        return summary
    if same_name and same_hash and not summary["material_change"]:
        summary["committed"] = False
        summary["reason"] = "source_already_processed"
        return summary

    with store.transaction("advanced-search-sync", summary) as staging:
        for ticket_id, ticket in updates.items():
            store.write_ticket_bundle(staging, ticket)
        state = store.state(staging)
        state["advanced_search_state"] = {
            "last_processed_filename": source["filename"],
            "source_timestamp": source.get("source_timestamp"),
            "sha256": source["sha256"],
            "processed_at": iso_now(),
            "ticket_count": len(records),
        }
        atomic_write_json(staging / "state.json", state)
    summary["committed"] = True
    return summary


def sync_newest_advanced_search(store: ZeusStore) -> dict[str, Any]:
    directory = store.configured_directory("advanced_search_directory")
    if directory is None:
        raise WorkbookValidationError("Advanced Search directory is not configured")
    return sync_advanced_search(store, directory)


# Older command scripts used this function name.  2.0.2 no longer needs an
# explicit migration command because the first trusted startup imports
# Pendings automatically.
def migrate_legacy_workbooks(
    store: ZeusStore,
    *,
    pendings_path: Path,
    closed_path: Path,
    source_path: Path | None = None,
    replace: bool = False,
) -> dict[str, Any]:
    if any(store.iter_ticket_ids()) and not replace:
        raise ReconciliationError("The Zeus database already contains tickets")
    pending = import_pendings(store, pendings_path)
    closed = initialize_closed_index(store, closed_path)
    advanced = (
        sync_advanced_search(store, source_path)
        if source_path is not None
        else None
    )
    return {"pendings": pending, "closed": closed, "advanced_search": advanced}
