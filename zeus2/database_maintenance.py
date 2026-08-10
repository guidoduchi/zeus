from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from .maintenance_windows import (
    LOCAL_SCHEMA_VERSION,
    MAINTENANCE_WINDOW_SCHEMA_VERSION,
    maintenance_window_summary,
)
from .spare_requests import render_request_markdown, validate_request_record
from .store import StoreError, ZeusStore, render_ticket_markdown
from .tickets import normalize_local
from .utils import atomic_write_json, atomic_write_text, iso_now


CURRENT_DATABASE_SCHEMA_VERSION = 3


def _schema_version(value: Any) -> int:
    if isinstance(value, bool) or (
        isinstance(value, float) and not value.is_integer()
    ):
        raise ValueError
    version = int(value)
    if version < 1:
        raise ValueError
    return version


def _relative(store: ZeusStore, path: Path) -> str:
    try:
        return path.relative_to(store.root).as_posix()
    except ValueError:
        return str(path)


def _prepared_ticket(ticket: dict[str, Any]) -> dict[str, Any]:
    prepared = deepcopy(ticket)
    prepared["local"] = normalize_local(prepared.get("local"))
    return prepared


def inspect_database(store: ZeusStore) -> dict[str, Any]:
    """Read and compare every Markdown record without changing the store."""

    outdated_tickets: list[str] = []
    markdown_repairs: list[str] = []
    review_records: list[dict[str, str]] = []
    blocked_records: list[dict[str, str]] = []
    ticket_count = 0
    request_count = 0
    state_path = store.current / "state.json"
    try:
        if not state_path.is_file():
            raise StoreError(f"State file is missing: {state_path}")
        state = store.state()
    except Exception as exc:
        state = {}
        blocked_records.append(
            {"path": _relative(store, state_path), "message": str(exc)}
        )
    raw_stored_version = state.get("database_schema_version")
    if raw_stored_version is None:
        raw_stored_version = 2
    try:
        stored_version = _schema_version(raw_stored_version)
    except (TypeError, ValueError):
        stored_version = 0
        blocked_records.append(
            {
                "path": _relative(store, state_path),
                "message": "database_schema_version must be a whole number",
            }
        )
    if stored_version > CURRENT_DATABASE_SCHEMA_VERSION:
        blocked_records.append(
            {
                "path": _relative(store, state_path),
                "message": (
                    f"Database schema {stored_version} is newer than this Zeus "
                    f"release supports ({CURRENT_DATABASE_SCHEMA_VERSION})"
                ),
            }
        )
    if state and state.get("schema_version") != 2:
        blocked_records.append(
            {
                "path": _relative(store, state_path),
                "message": "Store schema_version is missing or unsupported",
            }
        )

    for ticket_id in store.iter_ticket_ids():
        ticket_count += 1
        path = store.ticket_file(ticket_id)
        try:
            ticket = store.read_ticket(ticket_id)
            store.validate_ticket(ticket, ticket_id)
            prepared = _prepared_ticket(ticket)
            canonical = render_ticket_markdown(prepared)
            existing = path.read_text(encoding="utf-8")
        except Exception as exc:
            blocked_records.append(
                {"path": _relative(store, path), "message": str(exc)}
            )
            continue
        local = ticket.get("local") if isinstance(ticket.get("local"), dict) else {}
        try:
            raw_local_version = local.get("schema_version")
            local_version = _schema_version(
                1 if raw_local_version is None else raw_local_version
            )
        except (TypeError, ValueError):
            blocked_records.append(
                {
                    "path": _relative(store, path),
                    "message": "local.schema_version must be a whole number",
                }
            )
            continue
        if local_version > LOCAL_SCHEMA_VERSION:
            blocked_records.append(
                {
                    "path": _relative(store, path),
                    "message": (
                        f"Local schema {local_version} is newer than this Zeus "
                        f"release supports ({LOCAL_SCHEMA_VERSION})"
                    ),
                }
            )
            continue
        raw_window = local.get("maintenance_window")
        if isinstance(raw_window, dict) and raw_window.get("schema_version") is not None:
            try:
                window_version = _schema_version(raw_window.get("schema_version"))
            except (TypeError, ValueError):
                blocked_records.append(
                    {
                        "path": _relative(store, path),
                        "message": "Maintenance Window schema_version must be a whole number",
                    }
                )
                continue
            if window_version > MAINTENANCE_WINDOW_SCHEMA_VERSION:
                blocked_records.append(
                    {
                        "path": _relative(store, path),
                        "message": (
                            f"Maintenance Window schema {window_version} is newer "
                            f"than this Zeus release supports "
                            f"({MAINTENANCE_WINDOW_SCHEMA_VERSION})"
                        ),
                    }
                )
                continue
        if local_version < LOCAL_SCHEMA_VERSION:
            outdated_tickets.append(ticket_id)
        elif existing != canonical:
            markdown_repairs.append(_relative(store, path))
        mw = maintenance_window_summary(prepared.get("local"))
        if mw.get("reviewRequired"):
            review_records.append(
                {
                    "ticketId": ticket_id,
                    "message": "Completed MW has no known historical date.",
                }
            )

    for request_id in store.iter_spare_request_ids():
        request_count += 1
        path = store.spare_request_file(request_id)
        try:
            request = store.read_spare_request(request_id)
            validate_request_record(request, request_id)
            canonical = render_request_markdown(request)
            existing = path.read_text(encoding="utf-8")
        except Exception as exc:
            blocked_records.append(
                {"path": _relative(store, path), "message": str(exc)}
            )
            continue
        if existing != canonical:
            markdown_repairs.append(_relative(store, path))

    upgrade_required = bool(
        stored_version < CURRENT_DATABASE_SCHEMA_VERSION or outdated_tickets
    )
    repair_required = bool(markdown_repairs)
    if blocked_records:
        status = "blocked"
    elif upgrade_required:
        status = "upgrade_available"
    elif repair_required:
        status = "repair_available"
    else:
        status = "current"
    return {
        "status": status,
        "currentSchemaVersion": CURRENT_DATABASE_SCHEMA_VERSION,
        "storedSchemaVersion": stored_version,
        "ticketCount": ticket_count,
        "spareRequestCount": request_count,
        "outdatedTicketCount": len(outdated_tickets),
        "outdatedTicketIds": outdated_tickets,
        "repairableMarkdownCount": len(markdown_repairs),
        "repairableMarkdown": markdown_repairs,
        "reviewCount": len(review_records),
        "reviewRecords": review_records,
        "blockedCount": len(blocked_records),
        "blockedRecords": blocked_records,
        "canApply": not blocked_records and (upgrade_required or repair_required),
        "backupRequired": True,
    }


def maintain_database(store: ZeusStore, *, confirmed: bool) -> dict[str, Any]:
    preview = inspect_database(store)
    if preview["blockedCount"]:
        raise StoreError(
            "Database maintenance is blocked because one or more embedded records "
            "cannot be validated. Restore a known-good backup instead of guessing."
        )
    if not confirmed:
        raise StoreError("Database maintenance requires explicit confirmation")
    if not preview["canApply"]:
        return {**preview, "changed": False, "backup": None}

    summary: dict[str, Any] = {
        "from_schema_version": preview["storedSchemaVersion"],
        "to_schema_version": CURRENT_DATABASE_SCHEMA_VERSION,
        "tickets_upgraded": preview["outdatedTicketCount"],
        "markdown_records_repaired": preview["repairableMarkdownCount"],
        "review_records": preview["reviewCount"],
    }
    with store.transaction("database-maintenance", summary) as staging:
        for ticket_id in list(store.iter_ticket_ids(current_path=staging)):
            ticket = store.read_ticket(ticket_id, staging)
            prepared = _prepared_ticket(ticket)
            atomic_write_text(
                store.ticket_file(ticket_id, staging),
                render_ticket_markdown(prepared),
            )
        for request_id in list(store.iter_spare_request_ids(current_path=staging)):
            request = store.read_spare_request(request_id, staging)
            atomic_write_text(
                store.spare_request_file(request_id, staging),
                render_request_markdown(request),
            )
        state = store.state(staging)
        state["database_schema_version"] = CURRENT_DATABASE_SCHEMA_VERSION
        state["last_database_maintenance_at"] = iso_now()
        atomic_write_json(staging / "state.json", state)

    result = inspect_database(store)
    result.update(
        {
            "changed": True,
            "backup": summary.get("backup"),
            "upgradedTickets": preview["outdatedTicketCount"],
            "repairedMarkdown": preview["repairableMarkdownCount"],
            "reviewRecords": preview["reviewRecords"],
        }
    )
    return result
