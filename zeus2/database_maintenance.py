from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

from .maintenance_windows import (
    LOCAL_SCHEMA_VERSION,
    MAINTENANCE_WINDOW_SCHEMA_VERSION,
    maintenance_window_summary,
)
from .fault_tags import (
    create_fault_tag_record,
    fault_tag_history,
    next_fault_tag_id,
    render_fault_tag_markdown,
    validate_fault_tag_record,
)
from .spare_requests import (
    SPARE_REQUEST_SCHEMA_VERSION,
    ECUADOR_TIMEZONE,
    render_request_markdown,
    upgrade_request_record,
    validate_request_record,
)
from .store import StoreError, ZeusStore, render_ticket_markdown
from .tickets import normalize_local
from .utils import atomic_write_json, atomic_write_text, iso_now, parse_datetime


CURRENT_DATABASE_SCHEMA_VERSION = 4


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


def _migrate_legacy_fault_tags(store: ZeusStore, staging: Path) -> int:
    """Separate legacy return exports into independent Fault Tag documents.

    A record is migrated only when every required fact already exists. Missing
    or mixed facts remain on the request for human review; maintenance never
    invents a site, RMA, Spare SR, or return condition.
    """

    requests = list(store.iter_spare_requests(staging))
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for request in requests:
        for item in request.get("items", []):
            if item.get("fault_tag_ids"):
                continue
            filename = str(
                item.get("return_batch_id") or item.get("return_export_filename") or ""
            ).strip()
            if filename and item.get("return_exported_at"):
                grouped.setdefault(filename, []).append((request, item))
    occupied = {
        *store.iter_fault_tag_ids(staging),
        *store.iter_fault_tag_ids(staging, completed=True),
    }
    migrated = 0
    for filename, pairs in grouped.items():
        sites = {
            (
                str(request.get("profile", {}).get("site_code") or "").strip(),
                str(request.get("profile", {}).get("site_address") or "").strip(),
                str(request.get("profile", {}).get("cloud") or "").strip(),
            )
            for request, _ in pairs
        }
        if len(sites) != 1:
            continue
        site_code, site_address, cloud = next(iter(sites))
        if not all(
            request.get("spare_sr")
            and item.get("rma")
            and str(item.get("return_condition") or "").title() in {"Faulty", "New"}
            and site_code
            and site_address
            and cloud
            for request, item in pairs
        ):
            continue
        parsed = parse_datetime(pairs[0][1].get("return_exported_at"))
        identifier = next_fault_tag_id(
            occupied,
            now=(
                parsed.replace(tzinfo=ECUADOR_TIMEZONE)
                if parsed is not None and parsed.tzinfo is None
                else parsed.astimezone(ECUADOR_TIMEZONE)
                if parsed is not None
                else datetime.now(ECUADOR_TIMEZONE)
            ),
        )
        occupied.add(identifier)
        export_path = None
        export_subject = f"[LEGACY FAULT TAG {identifier}]"
        for request, _ in pairs:
            prior = next(
                (
                    entry
                    for entry in request.get("export", {}).get("returns", [])
                    if entry.get("filename") == filename
                ),
                None,
            )
            if prior:
                export_path = prior.get("path") or export_path
                export_subject = prior.get("subject") or export_subject
        created_at = str(pairs[0][1].get("return_exported_at") or iso_now())
        record = create_fault_tag_record(
            fault_tag_id=identifier,
            members=[
                {
                    "item_id": item.get("item_id"),
                    "request_id": request.get("request_id"),
                    "tt": request.get("tt"),
                    "spare_sr": request.get("spare_sr"),
                    "rma": item.get("rma"),
                    "condition": str(item.get("return_condition")).title(),
                    "source_site": request.get("profile", {}).get("site_code"),
                    "requested_bom": item.get("requested_bom"),
                    "new_sn": item.get("new_sn"),
                    "warehouse_evidence_at": item.get("warehouse_candidate_at"),
                    "warehouse_message_key": item.get("warehouse_message_key"),
                    "user_confirmed_at": item.get("completion_confirmed_at"),
                }
                for request, item in pairs
            ],
            return_site={
                "code": site_code,
                "address": site_address,
                "cloud": cloud,
                "name": pairs[0][0].get("profile", {}).get("site_name"),
            },
            export={
                "filename": filename,
                "path": export_path,
                "subject": export_subject,
                "revisions": [
                    {"filename": filename, "path": export_path, "created_at": created_at}
                ],
            },
            created_at=created_at,
        )
        sent_at = next(
            (item.get("fault_tag_sent_at") for _, item in pairs if item.get("fault_tag_sent_at")),
            None,
        )
        if sent_at:
            record["email"]["sent_at"] = sent_at
            record["locked_at"] = sent_at
            record["locked_source"] = "legacy-email-evidence"
        fault_tag_history(
            record,
            "migrated-from-legacy-return-export",
            {"legacyFilename": filename},
        )
        store.write_fault_tag(staging, record)
        for request, item in pairs:
            item.setdefault("fault_tag_ids", []).append(identifier)
        for request in {pair[0]["request_id"]: pair[0] for pair in pairs}.values():
            store.write_spare_request(staging, request)
        migrated += 1
    return migrated


def inspect_database(store: ZeusStore) -> dict[str, Any]:
    """Read and compare every Markdown record without changing the store."""

    outdated_tickets: list[str] = []
    outdated_requests: list[str] = []
    markdown_repairs: list[str] = []
    review_records: list[dict[str, str]] = []
    blocked_records: list[dict[str, str]] = []
    ticket_count = 0
    request_count = 0
    fault_tag_count = 0
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
            prepared_request = upgrade_request_record(request)
            canonical = render_request_markdown(prepared_request)
            existing = path.read_text(encoding="utf-8")
        except Exception as exc:
            blocked_records.append(
                {"path": _relative(store, path), "message": str(exc)}
            )
            continue
        try:
            request_schema = _schema_version(request.get("schema_version", 1))
        except (TypeError, ValueError):
            blocked_records.append(
                {
                    "path": _relative(store, path),
                    "message": "Spare Request schema_version must be a whole number",
                }
            )
            continue
        if request_schema < SPARE_REQUEST_SCHEMA_VERSION:
            outdated_requests.append(request_id)
        elif existing != canonical:
            markdown_repairs.append(_relative(store, path))
        if any(item.get("lifecycle_review_required") for item in prepared_request.get("items", [])):
            review_records.append(
                {
                    "path": _relative(store, path),
                    "message": "Legacy return export was separated from replacement confirmation; review the lifecycle evidence.",
                }
            )

    for completed in (False, True):
        for fault_tag_id in store.iter_fault_tag_ids(completed=completed):
            fault_tag_count += 1
            path = store.fault_tag_file(fault_tag_id, completed=completed)
            try:
                record = store.read_fault_tag(fault_tag_id, completed=completed)
                validate_fault_tag_record(record, fault_tag_id)
                canonical = render_fault_tag_markdown(record)
                existing = path.read_text(encoding="utf-8")
            except Exception as exc:
                blocked_records.append(
                    {"path": _relative(store, path), "message": str(exc)}
                )
                continue
            if existing != canonical:
                markdown_repairs.append(_relative(store, path))

    upgrade_required = bool(
        stored_version < CURRENT_DATABASE_SCHEMA_VERSION
        or outdated_tickets
        or outdated_requests
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
        "faultTagCount": fault_tag_count,
        "outdatedTicketCount": len(outdated_tickets),
        "outdatedTicketIds": outdated_tickets,
        "outdatedSpareRequestCount": len(outdated_requests),
        "outdatedSpareRequestIds": outdated_requests,
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
        "spare_requests_upgraded": preview.get("outdatedSpareRequestCount", 0),
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
            store.write_spare_request(staging, upgrade_request_record(request))
        summary["fault_tags_migrated"] = _migrate_legacy_fault_tags(store, staging)
        for completed in (False, True):
            for fault_tag_id in list(
                store.iter_fault_tag_ids(staging, completed=completed)
            ):
                record = store.read_fault_tag(
                    fault_tag_id, staging, completed=completed
                )
                store.write_fault_tag(staging, record, completed=completed)
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
            "upgradedSpareRequests": preview.get("outdatedSpareRequestCount", 0),
            "migratedFaultTags": summary.get("fault_tags_migrated", 0),
            "repairedMarkdown": preview["repairableMarkdownCount"],
            "reviewRecords": preview["reviewRecords"],
        }
    )
    return result
