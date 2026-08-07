from __future__ import annotations

import hashlib
from copy import deepcopy
from typing import Any, Iterable

from ..aging import aging_for_ticket, report_sort_key
from ..mail import strip_quoted_history
from ..store import ZeusStore
from ..tickets import normalize_local
from ..utils import json_dumps, normalize_ticket_id, parse_date


COLUMN_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"key": "ticketId", "label": "SR", "width": 94, "default": True},
    {"key": "risk", "label": "", "width": 18, "default": True},
    {"key": "lifecycle", "label": "Life", "width": 108, "default": True},
    {"key": "done", "label": "Done", "width": 58, "default": True},
    {"key": "plannedDate", "label": "Planned", "width": 116, "default": True},
    {"key": "ticketAgeDays", "label": "Age", "width": 62, "default": True},
    {"key": "emailLabel", "label": "Email", "width": 142, "default": True},
    {"key": "emailCount", "label": "Emails", "width": 68, "default": True},
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
    {"key": "done", "label": "Done", "width": 58, "default": False},
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
        "emailLabel": facts.communication_label,
        "emailCount": email_count,
        "emailColor": facts.communication_color,
        "lastEmailDirection": email.get("last_direction"),
        "received": int(email.get("total_received") or 0),
        "sent": int(email.get("total_sent") or 0),
        "summary": upstream.get("Problem Summary") or "",
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
    result.update(
        {
            "upstreamFields": deepcopy(
                ticket.get("upstream", {}).get("fields", {})
            ),
            "localFields": local_fields,
            "spareParts": deepcopy(prepared_local.get("spare_parts", [])),
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
    targets the parent SR and crosses the Pendings-first edit transaction.
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
            parts = list(device.get("parts") or []) or [None]
            for part_index, part in enumerate(parts, start=1):
                part = part or {}
                bom = str(part.get("bom") or "").strip()
                row = {
                    "rowId": f"{ticket_id}:{device_index}:{part_index}",
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
                    "deviceNumber": device_index,
                    "partNumber": part_index if part else None,
                    "device": device.get("device") or "—",
                    "model": device.get("model") or "—",
                    "slot": part.get("slot") or "—",
                    "part": part.get("part") or "—",
                    "bom": bom or "—",
                    "bomColor": None if bom else "yellow",
                    "faultySn": part.get("faulty_sn") or "—",
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
