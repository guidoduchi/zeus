from __future__ import annotations

import hashlib
from copy import deepcopy
from datetime import datetime
from typing import Any, Iterable

from ..aging import aging_for_ticket, report_sort_key
from ..mail import strip_quoted_history
from ..spare_request_excel import read_archived_items
from ..spare_requests import (
    ECUADOR_TIMEZONE,
    LIFECYCLE_STAGE_LABELS,
    active_source_part_keys,
    aging_color as spare_aging_color,
    dispatch_age_days,
    item_status,
    lifecycle_color,
    lifecycle_stage_details,
    request_overall_status,
    source_part_key,
)
from ..store import ZeusStore
from ..tickets import normalize_local
from ..utils import json_dumps, normalize_ticket_id, parse_date, parse_datetime


COLUMN_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"key": "ticketId", "label": "SR", "width": 94, "default": True},
    {"key": "risk", "label": "", "width": 18, "default": True},
    {"key": "lifecycle", "label": "Life", "width": 108, "default": True},
    {"key": "done", "label": "MW", "width": 104, "default": True},
    {"key": "plannedDate", "label": "Planned", "width": 116, "default": True},
    {"key": "ticketAgeDays", "label": "Age", "width": 62, "default": True},
    {"key": "emailLabel", "label": "Last Email", "width": 154, "default": True},
    {"key": "severity", "label": "Severity", "width": 92, "default": True},
    {"key": "summary", "label": "Summary", "width": 360, "default": True, "flex": True},
    {"key": "product", "label": "Product", "width": 190, "default": False},
    {"key": "handler", "label": "Current Handler", "width": 190, "default": False},
    {"key": "status", "label": "Status", "width": 160, "default": False},
    {"key": "resolveBy", "label": "Resolve By", "width": 116, "default": False},
    {"key": "site", "label": "Site", "width": 120, "default": False},
    {"key": "cloud", "label": "Cloud", "width": 120, "default": False},
    {"key": "model", "label": "Model", "width": 140, "default": False},
    {"key": "device", "label": "Device", "width": 150, "default": False},
)

SPARE_PART_COLUMN_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"key": "ticketId", "label": "SR", "width": 94, "default": True},
    {"key": "risk", "label": "", "width": 18, "default": True},
    {"key": "plannedDate", "label": "Planned", "width": 116, "default": True},
    {"key": "site", "label": "Site", "width": 110, "default": True},
    {"key": "cloud", "label": "Cloud", "width": 130, "default": True},
    {"key": "device", "label": "Device", "width": 165, "default": True},
    {"key": "model", "label": "Model", "width": 145, "default": True},
    {"key": "slot", "label": "Slot", "width": 105, "default": True},
    {"key": "part", "label": "Part", "width": 150, "default": True},
    {"key": "bom", "label": "BOM", "width": 150, "default": True},
    {"key": "faultySn", "label": "Faulty SN", "width": 155, "default": True},
    {"key": "newSn", "label": "New SN", "width": 155, "default": True},
    {"key": "lifecycle", "label": "Life", "width": 108, "default": False},
    {"key": "done", "label": "MW", "width": 104, "default": False},
    {"key": "summary", "label": "Summary", "width": 320, "default": False, "flex": True},
)

DEFAULT_SORT_DIRECTIONS = {
    "report": "asc",
    "sr": "desc",
    "planned": "asc",
    "email": "desc",
    "age": "desc",
    "severity": "asc",
    "status": "asc",
}

SPARE_PART_DEFAULT_SORT_DIRECTIONS = {
    "sr": "desc",
    "planned": "asc",
    "site": "asc",
    "cloud": "asc",
    "device": "asc",
    "part": "asc",
    "bom": "asc",
}

SPARE_REQUEST_COLUMN_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"key": "ticketId", "label": "TT", "width": 94, "default": True},
    {"key": "rma", "label": "RMA", "width": 132, "default": True},
    {"key": "emailLabel", "label": "Last Email", "width": 154, "default": True},
    {"key": "risk", "label": "", "width": 18, "default": True},
    {"key": "trackingId", "label": "Tracking ID", "width": 128, "default": True},
    {"key": "lifecycleStage", "label": "Lifecycle", "width": 220, "default": True},
    {"key": "statusLabel", "label": "Status", "width": 170, "default": False},
    {"key": "dispatchAgeDays", "label": "Days", "width": 62, "default": True},
    {"key": "requestedBom", "label": "Requested BOM", "width": 145, "default": True},
    {"key": "deliveredBom", "label": "Delivered BOM", "width": 145, "default": True},
    {"key": "part", "label": "Part", "width": 175, "default": True},
    {"key": "newSn", "label": "New SN", "width": 160, "default": True},
    {"key": "site", "label": "Site", "width": 100, "default": True},
    {"key": "cloud", "label": "Cloud", "width": 125, "default": True},
    {"key": "device", "label": "Device", "width": 155, "default": False},
    {"key": "model", "label": "Model", "width": 145, "default": False},
    {"key": "slot", "label": "Slot", "width": 110, "default": False},
    {"key": "requestId", "label": "Zeus ID", "width": 128, "default": False},
    {"key": "conflictCount", "label": "Conflicts", "width": 78, "default": False},
    {"key": "archiveReason", "label": "Archive reason", "width": 125, "default": False},
    {"key": "archivedAt", "label": "Archived at", "width": 165, "default": False},
    {"key": "notes", "label": "Archive note", "width": 260, "default": False, "flex": True},
)

SPARE_REQUEST_DEFAULT_SORT_DIRECTIONS = {
    "tt": "desc",
    "tracking": "desc",
    "rma": "asc",
    "email": "desc",
    "status": "asc",
    "age": "desc",
    "site": "asc",
    "cloud": "asc",
    "bom": "asc",
}


def ticket_revision(ticket: dict[str, Any]) -> str:
    """Return a stable optimistic-concurrency token for one ticket."""

    payload = {
        "ticket_id": ticket.get("ticket_id"),
        "lifecycle": ticket.get("lifecycle"),
        "local": ticket.get("local"),
        "upstream": ticket.get("upstream"),
        "updated_at": ticket.get("updated_at"),
    }
    return hashlib.sha256(json_dumps(payload, indent=None).encode("utf-8")).hexdigest()


def _risk(*colors: str | None) -> str:
    if "red" in colors:
        return "red"
    if "yellow" in colors:
        return "yellow"
    if "grey" in colors:
        return "grey"
    return "none"


def _last_email_label(days: int | None, _count: int) -> str:
    if days is None:
        return "No email"
    if days == 0:
        return "Today"
    if days == 1:
        return "1 day"
    return f"{days} days"


def serialize_ticket_summary(
    ticket: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    facts = aging_for_ticket(ticket, config)
    upstream = ticket.get("upstream", {}).get("fields", {})
    prepared_local = normalize_local(ticket.get("local"))
    local = prepared_local.get("fields", {})
    email = ticket.get("email", {})
    email_count = int(email.get("total_received") or 0) + int(email.get("total_sent") or 0)
    devices = [
        str(device.get("device"))
        for device in prepared_local.get("spare_parts", [])
        if device.get("device")
    ]
    models = [
        str(device.get("model"))
        for device in prepared_local.get("spare_parts", [])
        if device.get("model")
    ]
    return {
        "rowId": ticket["ticket_id"],
        "ticketId": ticket["ticket_id"],
        "revision": ticket_revision(ticket),
        "lifecycle": ticket.get("lifecycle", {}).get("status") or "unknown",
        "done": str(local.get("Done?") or "N"),
        "plannedDate": facts.planned_label,
        "plannedDays": facts.planned_days,
        "plannedState": facts.planned_state,
        "plannedColor": facts.planned_color,
        "ticketAgeDays": facts.ticket_age_days,
        "ticketAgeColor": facts.ticket_age_color,
        "emailInactivityDays": facts.communication_inactivity_days,
        "emailLabel": _last_email_label(
            facts.communication_inactivity_days,
            email_count,
        ),
        "emailCount": email_count,
        "emailColor": facts.communication_color,
        "lastEmailDirection": email.get("last_direction"),
        "received": int(email.get("total_received") or 0),
        "sent": int(email.get("total_sent") or 0),
        "summary": upstream.get("Problem Summary") or "",
        "customerContact": (
            upstream.get("Customer Contact")
            or upstream.get("Contact Name")
            or upstream.get("Contact Person")
            or "—"
        ),
        "severity": upstream.get("Customer Severity") or "—",
        "product": upstream.get("Product") or "—",
        "handler": upstream.get("Current Handler") or "—",
        "status": upstream.get("Status") or "—",
        "resolveBy": facts.resolve_label,
        "resolveDays": facts.resolve_days,
        "site": local.get("Site") or "—",
        "cloud": local.get("Cloud") or "—",
        "model": ", ".join(dict.fromkeys(models)) or "—",
        "device": ", ".join(dict.fromkeys(devices)) or "—",
        "risk": _risk(
            facts.planned_color,
            facts.ticket_age_color,
            facts.communication_color,
            facts.resolve_color,
        ),
    }


def serialize_archived_ticket_summary(
    ticket: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    """Serialize a finalized SR without applying live-ticket warning colors."""

    result = serialize_ticket_summary(ticket, config)
    result.update(
        {
            "lifecycle": "closed",
            "plannedColor": None,
            "ticketAgeColor": None,
            "emailInactivityDays": None,
            "emailLabel": "Archived",
            "emailColor": None,
            "risk": "grey",
        }
    )
    return result


def _message_payload(message: dict[str, Any]) -> dict[str, Any]:
    raw_body = str(message.get("body") or "")
    detected_reply, detected_history, detected_lines = strip_quoted_history(
        raw_body
    )
    stored_reply = message.get("latest_reply_body")
    latest_reply = (
        str(stored_reply)
        if stored_reply is not None
        else detected_reply if detected_history else None
    )
    history_hidden = bool(
        detected_history
        or (message.get("quoted_history_hidden") and latest_reply is not None)
    )
    return {
        "messageKey": message.get("message_key"),
        "timestamp": message.get("timestamp"),
        "direction": message.get("direction"),
        "subject": message.get("subject") or "(no subject)",
        "sender": message.get("sender"),
        # The lossless Outlook body remains available for the explicit full
        # thread view.  Older Markdown records predate the stored compact
        # fields, so derive their safe display form at the API boundary too.
        "body": raw_body,
        "latestReplyBody": latest_reply,
        "quotedHistoryHidden": history_hidden,
        "quotedHistoryLines": max(
            int(message.get("quoted_history_lines") or 0),
            detected_lines,
        ),
    }


def serialize_ticket_detail(
    ticket: dict[str, Any],
    config: dict[str, Any],
    *,
    read_only: bool = False,
    source: str = "current",
    active_requests: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    result = (
        serialize_archived_ticket_summary(ticket, config)
        if read_only
        else serialize_ticket_summary(ticket, config)
    )
    email = ticket.get("email", {})
    prepared_local = normalize_local(ticket.get("local"))
    local_fields = deepcopy(prepared_local.get("fields", {}))
    planned_date = parse_date(local_fields.get("Planned Date"))
    # Native browser date controls consume ISO calendar dates.  Invalid legacy
    # labels such as ``Unplanned`` are represented by an empty date control;
    # the summary still exposes the human-readable "Unplanned" label.
    local_fields["Planned Date"] = planned_date.isoformat() if planned_date else None
    spare_parts = deepcopy(prepared_local.get("spare_parts", []))
    active_by_source: dict[tuple[str, int, int], set[str]] = {}
    active_by_device: dict[tuple[str, int], set[str]] = {}
    for active_request in active_requests:
        request_id = str(active_request.get("request_id") or "")
        for item in active_request.get("items", []):
            if not isinstance(item, dict):
                continue
            key = source_part_key(active_request.get("tt"), item)
            if key is not None:
                active_by_source.setdefault(key, set()).add(request_id)
                active_by_device.setdefault((key[0], key[1]), set()).add(request_id)
    ticket_id = str(ticket.get("ticket_id") or "")
    for device_index, device in enumerate(spare_parts, start=1):
        device_number = int(device.get("device_number") or device_index)
        device_active: set[str] = set(
            active_by_device.get((ticket_id, device_number), set())
        )
        for part_index, part in enumerate(device.get("parts") or [], start=1):
            part_number = int(part.get("part_number") or part_index)
            active_ids = active_by_source.get(
                (ticket_id, device_number, part_number), set()
            )
            submitted_ids = set(part.get("submitted_request_ids") or []) | active_ids
            part["submitted_request_ids"] = sorted(submitted_ids)
            part["submitted"] = bool(submitted_ids)
            part["active_request_ids"] = sorted(active_ids)
            device_active.update(active_ids)
        device["active_request_ids"] = sorted(device_active)
        device["has_submitted_parts"] = any(
            bool(part.get("submitted_request_ids"))
            for part in device.get("parts") or []
        )
    result.update(
        {
            "upstreamFields": deepcopy(
                ticket.get("upstream", {}).get("fields", {})
            ),
            "localFields": local_fields,
            "spareParts": spare_parts,
            "email": {
                "totalReceived": int(email.get("total_received") or 0),
                "totalSent": int(email.get("total_sent") or 0),
                "lastActivityAt": email.get("last_activity_at"),
                "lastFetchedAt": email.get("last_fetched_at"),
                "lastSynchronizedAt": email.get("last_synchronized_at"),
                "messages": [
                    _message_payload(message)
                    for message in list(email.get("messages") or [])
                ],
            },
            "mop": deepcopy(ticket.get("mop") or {"latest": None, "versions": 0}),
            "lifecycleDetails": deepcopy(ticket.get("lifecycle") or {}),
            "updatedAt": ticket.get("updated_at"),
            "readOnly": read_only,
            "source": source,
        }
    )
    return result


def _ticket_search_text(ticket: dict[str, Any]) -> str:
    upstream = ticket.get("upstream", {}).get("fields", {})
    local = normalize_local(ticket.get("local"))
    values = [
        ticket.get("ticket_id"),
        *upstream.values(),
        *local.get("fields", {}).values(),
        json_dumps(local.get("spare_parts", []), indent=None),
    ]
    return "\n".join(str(value) for value in values if value not in (None, "")).casefold()


def _sort_key(ticket: dict[str, Any], config: dict[str, Any], mode: str) -> Any:
    facts = aging_for_ticket(ticket, config)
    upstream = ticket.get("upstream", {}).get("fields", {})
    if mode == "sr":
        return (int(ticket["ticket_id"]),)
    if mode in {"report", "planned"}:
        return report_sort_key(ticket, config)
    if mode == "email":
        value = facts.communication_inactivity_days
        return (value is not None, -1 if value is None else value, int(ticket["ticket_id"]))
    if mode == "age":
        return (-1 if facts.ticket_age_days is None else facts.ticket_age_days, int(ticket["ticket_id"]))
    if mode == "severity":
        return (str(upstream.get("Customer Severity") or "").casefold(), -int(ticket["ticket_id"]))
    if mode == "status":
        return (str(upstream.get("Status") or "").casefold(), -int(ticket["ticket_id"]))
    return report_sort_key(ticket, config)


def dashboard_payload(
    store: ZeusStore,
    *,
    sort: str = "report",
    direction: str | None = None,
    search: str = "",
    dataset_revision: int = 0,
) -> dict[str, Any]:
    config = store.config
    direction = direction or DEFAULT_SORT_DIRECTIONS.get(sort, "asc")
    all_records = list(store.iter_tickets())
    active = [
        ticket
        for ticket in all_records
        if ticket.get("lifecycle", {}).get("status") == "active"
    ]
    closing = [ticket for ticket in all_records if ticket not in active]
    query = search.strip().casefold()
    reverse = direction == "desc"
    ordered = sorted(active, key=lambda value: _sort_key(value, config, sort), reverse=reverse) + sorted(
        closing, key=lambda value: _sort_key(value, config, sort), reverse=reverse
    )
    if query:
        ordered = [ticket for ticket in ordered if query in _ticket_search_text(ticket)]

    codes = {code: 0 for code in ("Y", "N", "P", "?")}
    overdue = unplanned = no_email = 0
    for ticket in active:
        code = str(ticket.get("local", {}).get("fields", {}).get("Done?") or "N")
        codes[code if code in codes else "N"] += 1
        facts = aging_for_ticket(ticket, config)
        overdue += int(facts.planned_state == "overdue")
        unplanned += int(facts.planned_state == "unplanned")
        no_email += int(facts.communication_inactivity_days is None)

    return {
        "workspace": "service-requests",
        "datasetRevision": dataset_revision,
        "sort": sort,
        "direction": direction,
        "search": search,
        "stats": {
            "active": len(active),
            "doneY": codes["Y"],
            "doneN": codes["N"],
            "doneP": codes["P"],
            "doneUnknown": codes["?"],
            "overdue": overdue,
            "unplanned": unplanned,
            "noEmail": no_email,
            "pendingClosure": len(closing),
        },
        "tickets": [serialize_ticket_summary(ticket, config) for ticket in ordered],
        "columns": [deepcopy(column) for column in COLUMN_DEFINITIONS],
    }


def _spare_part_rows(
    tickets: Iterable[dict[str, Any]],
    config: dict[str, Any],
    *,
    read_only: bool = False,
    source: str = "current",
) -> list[dict[str, Any]]:
    """Flatten normalized ticket hardware without creating another authority.

    The row identifiers are presentation identities only.  Every mutation still
    targets the parent SR and crosses the database edit transaction.
    Device-only records remain visible as incomplete rows so the management
    view can never hide normalized data merely because its first part has not
    been filled yet.
    """

    rows: list[dict[str, Any]] = []
    for ticket in tickets:
        ticket_id = normalize_ticket_id(ticket.get("ticket_id"))
        prepared_local = normalize_local(ticket.get("local"))
        local = prepared_local.get("fields", {})
        summary = (
            serialize_archived_ticket_summary(ticket, config)
            if read_only
            else serialize_ticket_summary(ticket, config)
        )
        for device_index, device in enumerate(
            prepared_local.get("spare_parts", []), start=1
        ):
            device_number = int(device.get("device_number") or device_index)
            parts = list(device.get("parts") or []) or [None]
            for part_index, part in enumerate(parts, start=1):
                part = part or {}
                part_number = (
                    int(part.get("part_number") or part_index)
                    if part
                    else None
                )
                bom = str(part.get("bom") or "").strip()
                row = {
                    "rowId": f"{ticket_id}:{device_number}:{part_number or 0}",
                    "ticketId": ticket_id,
                    "revision": summary["revision"],
                    "lifecycle": summary["lifecycle"],
                    "done": summary["done"],
                    "plannedDate": summary["plannedDate"],
                    "plannedDays": summary["plannedDays"],
                    "plannedState": summary["plannedState"],
                    "plannedColor": summary["plannedColor"],
                    "site": local.get("Site") or "—",
                    "cloud": local.get("Cloud") or "—",
                    "deviceNumber": device_number,
                    "partNumber": part_number,
                    "device": device.get("device") or "—",
                    "model": device.get("model") or "—",
                    "slot": part.get("slot") or "—",
                    "part": part.get("part") or "—",
                    "bom": bom or "—",
                    "bomColor": None if bom else "yellow",
                    "submitted": bool(part.get("submitted_request_ids")),
                    "submittedRequestIds": list(part.get("submitted_request_ids") or []),
                    "faultySn": "\n".join(device.get("faulty_sns") or []) or "—",
                    "newSn": part.get("new_sn") or "—",
                    "summary": summary["summary"],
                    "risk": summary["risk"],
                    "hasPart": bool(part),
                    "readOnly": read_only,
                    "source": source,
                }
                rows.append(row)
    return rows


def _spare_part_search_text(row: dict[str, Any]) -> str:
    return "\n".join(
        str(value)
        for key, value in row.items()
        if key not in {"revision", "risk", "plannedColor", "bomColor"}
        and value not in (None, "", "—")
    ).casefold()


def _spare_part_sort_value(row: dict[str, Any], mode: str) -> Any:
    if mode == "sr":
        return int(row["ticketId"])
    if mode == "planned":
        return row.get("plannedDays")
    value = str(row.get(mode) or "").casefold()
    return None if value in {"", "—"} else value


def spare_parts_dashboard_payload(
    store: ZeusStore,
    *,
    sort: str = "sr",
    direction: str | None = None,
    search: str = "",
    dataset_revision: int = 0,
    closed_tickets: Iterable[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Return SR-owned hardware from current Markdown and finalized Closed rows."""

    direction = direction or SPARE_PART_DEFAULT_SORT_DIRECTIONS.get(sort, "asc")
    current_tickets = list(store.iter_tickets())
    archived_tickets = list(closed_tickets)
    current_ids = {
        normalize_ticket_id(ticket.get("ticket_id")) for ticket in current_tickets
    }
    archived_ids = {
        normalize_ticket_id(ticket.get("ticket_id")) for ticket in archived_tickets
    }
    duplicated = sorted(current_ids & archived_ids, reverse=True)
    if duplicated:
        raise ValueError(
            "Spare Parts cannot project an SR as both current and closed: "
            + ", ".join(duplicated[:20])
        )
    all_rows = _spare_part_rows(current_tickets, store.config) + _spare_part_rows(
        archived_tickets,
        store.config,
        read_only=True,
        source="closed",
    )
    query = search.strip().casefold()
    rows = (
        [row for row in all_rows if query in _spare_part_search_text(row)]
        if query
        else list(all_rows)
    )
    # Stable two-stage sorting keeps devices and parts in hierarchy order even
    # when the selected primary field is descending.  Missing values remain at
    # the bottom in either direction.
    rows.sort(
        key=lambda row: (
            int(row["ticketId"]),
            int(row.get("deviceNumber") or 0),
            int(row.get("partNumber") or 0),
        )
    )
    present = [row for row in rows if _spare_part_sort_value(row, sort) is not None]
    missing = [row for row in rows if _spare_part_sort_value(row, sort) is None]
    present.sort(
        key=lambda row: _spare_part_sort_value(row, sort),
        reverse=direction == "desc",
    )
    rows = present + missing

    tickets = {row["ticketId"] for row in all_rows}
    current_part_tickets = {
        row["ticketId"] for row in all_rows if not row["readOnly"]
    }
    closed_part_tickets = {
        row["ticketId"] for row in all_rows if row["readOnly"]
    }
    devices = {
        (row["ticketId"], row["deviceNumber"])
        for row in all_rows
    }
    actual_parts = [row for row in all_rows if row["hasPart"]]
    return {
        "workspace": "spare-parts",
        "datasetRevision": dataset_revision,
        "sort": sort,
        "direction": direction,
        "search": search,
        "stats": {
            "tickets": len(tickets),
            "currentTickets": len(current_part_tickets),
            "closedTickets": len(closed_part_tickets),
            "devices": len(devices),
            "parts": len(actual_parts),
            "withBom": sum(row["bom"] != "—" for row in actual_parts),
            "missingBom": sum(row["bom"] == "—" for row in actual_parts),
            "newSnRecorded": sum(row["newSn"] != "—" for row in actual_parts),
        },
        "spareParts": rows,
        "columns": [deepcopy(column) for column in SPARE_PART_COLUMN_DEFINITIONS],
    }


SPARE_STATUS_LABELS = {
    "awaiting_confirmation": "Awaiting confirmation",
    "awaiting_stock": "Awaiting stock",
    "awaiting_dispatch": "Awaiting dispatch",
    "dispatched": "Dispatched",
    "awaiting_warehouse": "Awaiting warehouse",
    "awaiting_user_confirmation": "Confirm warehouse return",
    "warehouse_confirmed": "Warehouse confirmed",
    "cancelled": "Cancelled",
    "returned": "Returned",
}


def spare_request_revision(request: dict[str, Any]) -> str:
    """Return an optimistic-concurrency token for one independent request."""

    return hashlib.sha256(
        json_dumps(request, indent=None).encode("utf-8")
    ).hexdigest()


def _spare_email_facts(
    request: dict[str, Any], *, now: datetime | None = None
) -> tuple[int | None, str, str | None, int]:
    email = request.get("email", {})
    total = int(email.get("total_received") or 0) + int(email.get("total_sent") or 0)
    last = parse_datetime(email.get("last_activity_at"))
    if last is None:
        return None, _last_email_label(None, total), "grey", total
    current = now or datetime.now(ECUADOR_TIMEZONE)
    if current.tzinfo is not None and last.tzinfo is None:
        last = last.replace(tzinfo=ECUADOR_TIMEZONE)
    elif current.tzinfo is None and last.tzinfo is not None:
        current = current.replace(tzinfo=ECUADOR_TIMEZONE)
    days = max(0, (current.date() - last.date()).days)
    color = "red" if days >= 7 else "yellow" if days >= 3 else None
    return days, _last_email_label(days, total), color, total


def _request_conflict_count(request: dict[str, Any]) -> int:
    unresolved = sum(
        not value.get("resolved_at") for value in request.get("conflicts", [])
    )
    return unresolved + sum(
        sum(not value.get("resolved_at") for value in item.get("conflicts", []))
        for item in request.get("items", [])
    )


def serialize_spare_request_item(
    request: dict[str, Any], item: dict[str, Any]
) -> dict[str, Any]:
    email_days, email_label, email_color, email_count = _spare_email_facts(request)
    age = dispatch_age_days(item)
    status = item_status(item, request)
    lifecycle = lifecycle_color(item, request)
    age_color = spare_aging_color(age)
    conflicts = _request_conflict_count(request)
    profile = request.get("profile", {})
    stage = lifecycle_stage_details(item, request)
    tracking_id = request.get("spare_sr") or request.get("request_id")
    return {
        "rowId": item.get("item_id"),
        "requestId": request.get("request_id"),
        "itemId": item.get("item_id"),
        "ticketId": request.get("tt"),
        "rma": item.get("rma") or "—",
        "spareSr": request.get("spare_sr") or "—",
        "trackingId": tracking_id or "—",
        "trackingIdProvisional": not bool(request.get("spare_sr")),
        "lifecycleStage": stage["stage"],
        "lifecycleStageLabel": stage["label"],
        "lifecycleStageSource": stage["source"],
        "status": status,
        "statusLabel": SPARE_STATUS_LABELS.get(status, status.replace("_", " ").title()),
        "lifecycleColor": lifecycle,
        "dispatchAgeDays": age,
        "dispatchAgeColor": age_color,
        "emailInactivityDays": email_days,
        "emailLabel": email_label,
        "emailColor": email_color,
        "emailCount": email_count,
        "requestedBom": item.get("requested_bom") or "—",
        "deliveredBom": item.get("delivered_bom") or "—",
        "part": item.get("part") or item.get("requested_description") or "—",
        "model": item.get("model") or "—",
        "device": item.get("device") or "—",
        "slot": item.get("slot") or "—",
        "faultySn": item.get("faulty_sn") or "—",
        "newSn": item.get("new_sn") or "—",
        "site": profile.get("site_code") or "—",
        "cloud": profile.get("cloud") or "—",
        "conflictCount": conflicts,
        "risk": "red" if conflicts or age_color == "red" else "yellow" if age_color == "yellow" or email_color == "yellow" else "grey" if lifecycle == "grey" else "none",
        "readOnly": False,
        "source": "active",
    }


def _archived_spare_row(row: dict[str, Any]) -> dict[str, Any]:
    status = str(row.get("Status") or "returned").casefold()
    email_days = row.get("Email inactivity days")
    email_count = int(row.get("Emails received") or 0) + int(row.get("Emails sent") or 0)
    if status == "returned":
        stage = 6
        stage_label = LIFECYCLE_STAGE_LABELS[stage]
    elif row.get("Return Export"):
        stage = 4
        stage_label = LIFECYCLE_STAGE_LABELS[stage]
    elif row.get("Dispatch Date"):
        stage = 3
        stage_label = LIFECYCLE_STAGE_LABELS[stage]
    elif row.get("Spare SR") and row.get("RMA"):
        stage = 2
        stage_label = LIFECYCLE_STAGE_LABELS[stage]
    else:
        stage = 0
        stage_label = "Cancelled" if status == "cancelled" else LIFECYCLE_STAGE_LABELS[stage]
    return {
        "rowId": str(row.get("Item ID") or ""),
        "requestId": str(row.get("Request ID") or ""),
        "itemId": str(row.get("Item ID") or ""),
        "ticketId": str(row.get("TT") or ""),
        "rma": row.get("RMA") or "—",
        "spareSr": row.get("Spare SR") or "—",
        "trackingId": row.get("Spare SR") or row.get("Request ID") or "—",
        "trackingIdProvisional": not bool(row.get("Spare SR")),
        "lifecycleStage": stage,
        "lifecycleStageLabel": stage_label,
        "lifecycleStageSource": "archive",
        "status": status,
        "statusLabel": SPARE_STATUS_LABELS.get(status, status.replace("_", " ").title()),
        "lifecycleColor": "grey",
        "dispatchAgeDays": None,
        "dispatchAgeColor": None,
        "emailInactivityDays": email_days,
        "emailLabel": _last_email_label(
            None if email_days in (None, "") else int(email_days),
            email_count,
        ),
        "emailColor": None,
        "emailCount": email_count,
        "requestedBom": row.get("Requested BOM") or "—",
        "deliveredBom": row.get("Delivered BOM") or "—",
        "part": row.get("Part") or row.get("Description") or "—",
        "model": row.get("Model") or "—",
        "device": row.get("Device") or "—",
        "slot": row.get("Slot") or "—",
        "faultySn": row.get("Faulty SN") or "—",
        "newSn": row.get("New SN") or "—",
        "site": row.get("Site") or "—",
        "cloud": row.get("Cloud") or "—",
        "conflictCount": 0,
        "risk": "grey",
        "archivedAt": row.get("Archived At"),
        "archiveReason": row.get("Archive Reason"),
        "notes": row.get("Notes"),
        "readOnly": True,
        "source": "closed",
    }


def _eligible_spare_rows(store: ZeusStore) -> list[dict[str, Any]]:
    rows = _spare_part_rows(store.iter_tickets(status="active"), store.config)
    occupied = active_source_part_keys(store.iter_spare_requests())
    return [
        {**row, "eligible": True}
        for row in rows
        if (
            row.get("hasPart")
            and row.get("bom") != "—"
            and not row.get("submitted")
            and (
                row.get("ticketId"),
                row.get("deviceNumber"),
                row.get("partNumber"),
            )
            not in occupied
        )
    ]


def _spare_request_search_text(row: dict[str, Any]) -> str:
    return "\n".join(
        str(value)
        for key, value in row.items()
        if key not in {"risk", "emailColor", "dispatchAgeColor", "lifecycleColor"}
        and value not in (None, "", "—")
    ).casefold()


def _spare_request_sort_value(row: dict[str, Any], mode: str) -> Any:
    if mode in {"tt", "sr"}:
        return int(row.get("ticketId") or 0)
    if mode == "rma":
        return None if row.get("rma") == "—" else str(row.get("rma"))
    if mode == "tracking":
        return str(row.get("trackingId") or "")
    if mode == "email":
        return row.get("emailInactivityDays")
    if mode == "age":
        return row.get("dispatchAgeDays")
    if mode == "bom":
        return str(row.get("requestedBom") or row.get("bom") or "").casefold()
    return str(row.get(mode) or "").casefold()


def spare_requests_dashboard_payload(
    store: ZeusStore,
    *,
    view: str = "active",
    sort: str = "tt",
    direction: str | None = None,
    search: str = "",
    dataset_revision: int = 0,
    closed_path: Any = None,
) -> dict[str, Any]:
    """Serialize independent requests, reusable SR candidates, or Closed rows."""

    direction = direction or SPARE_REQUEST_DEFAULT_SORT_DIRECTIONS.get(sort, "asc")
    requests = list(store.iter_spare_requests())
    if view == "eligible":
        rows = _eligible_spare_rows(store)
        columns = tuple(
            {**column, "label": "TT"} if column.get("key") == "ticketId" else column
            for column in SPARE_PART_COLUMN_DEFINITIONS
        )
    elif view == "completed":
        rows = [_archived_spare_row(row) for row in read_archived_items(closed_path)] if closed_path else []
        columns = SPARE_REQUEST_COLUMN_DEFINITIONS
    else:
        rows = [
            serialize_spare_request_item(request, item)
            for request in requests
            for item in request.get("items", [])
        ]
        columns = SPARE_REQUEST_COLUMN_DEFINITIONS
    query = search.strip().casefold()
    if query:
        rows = [row for row in rows if query in _spare_request_search_text(row)]
    mode = "sr" if view == "eligible" and sort == "tt" else sort
    rows.sort(key=lambda row: str(row.get("rowId") or ""))
    present = [row for row in rows if _spare_request_sort_value(row, mode) not in (None, "")]
    missing = [row for row in rows if _spare_request_sort_value(row, mode) in (None, "")]
    present.sort(
        key=lambda row: _spare_request_sort_value(row, mode),
        reverse=direction == "desc",
    )
    active_items = [item for request in requests for item in request.get("items", [])]
    statuses = [
        item_status(item, request)
        for request in requests
        for item in request.get("items", [])
    ]
    return {
        "workspace": "spare-requests",
        "view": view,
        "datasetRevision": dataset_revision,
        "sort": sort,
        "direction": direction,
        "search": search,
        "stats": {
            "activeRequests": len(requests),
            "activeItems": len(active_items),
            "awaitingStock": statuses.count("awaiting_stock"),
            "awaitingDispatch": statuses.count("awaiting_dispatch"),
            "dispatched": sum(status in {"dispatched", "awaiting_warehouse", "awaiting_user_confirmation", "warehouse_confirmed"} for status in statuses),
            "warehouseCandidates": statuses.count("warehouse_confirmed"),
            "conflicts": sum(_request_conflict_count(request) for request in requests),
            "eligibleParts": len(_eligible_spare_rows(store)),
            "completedItems": len(read_archived_items(closed_path)) if closed_path else 0,
        },
        "spareRequests": present + missing if view != "eligible" else [],
        "eligibleParts": present + missing if view == "eligible" else [],
        "columns": [deepcopy(column) for column in columns],
    }


def serialize_spare_request_detail(request: dict[str, Any]) -> dict[str, Any]:
    email_days, email_label, email_color, email_count = _spare_email_facts(request)
    return {
        "requestId": request.get("request_id"),
        "revision": spare_request_revision(request),
        "ticketId": request.get("tt"),
        "reportDate": request.get("report_date") or next(
            (
                line.get("report_date")
                for line in request.get("request_lines", [])
                if line.get("report_date")
            ),
            None,
        ),
        "ttEditable": bool(request.get("tt_editable")),
        "source": request.get("source"),
        "creationMethod": request.get("creation_method") or (
            "zeus_export"
            if request.get("export", {}).get("request_filename")
            else "legacy"
        ),
        "spareSr": request.get("spare_sr"),
        "trackingId": request.get("spare_sr") or request.get("request_id"),
        "trackingIdProvisional": not bool(request.get("spare_sr")),
        "requestSentAt": request.get("request_sent_at"),
        "canDelete": not bool(request.get("spare_sr")) and not any(
            item.get("rma") or item.get("attendance_confirmed_at")
            for item in request.get("items", [])
        ),
        "status": request_overall_status(request),
        "profile": deepcopy(request.get("profile") or {}),
        "requestLines": deepcopy(request.get("request_lines") or []),
        "items": [
            {
                **deepcopy(item),
                "status": item_status(item, request),
                "statusLabel": SPARE_STATUS_LABELS.get(item_status(item, request), item_status(item, request)),
                "lifecycleColor": lifecycle_color(item, request),
                "dispatchAgeDays": dispatch_age_days(item),
                "dispatchAgeColor": spare_aging_color(dispatch_age_days(item)),
                "lifecycle": lifecycle_stage_details(item, request),
            }
            for item in request.get("items", [])
        ],
        "export": deepcopy(request.get("export") or {}),
        "email": {
            **deepcopy(request.get("email") or {}),
            "inactivityDays": email_days,
            "label": email_label,
            "color": email_color,
            "count": email_count,
        },
        "conflicts": deepcopy(request.get("conflicts") or []),
        "conflictCount": _request_conflict_count(request),
        "history": deepcopy(request.get("history") or []),
        "createdAt": request.get("created_at"),
        "updatedAt": request.get("updated_at"),
    }
