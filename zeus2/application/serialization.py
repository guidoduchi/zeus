from __future__ import annotations

import hashlib
from copy import deepcopy
from typing import Any

from ..aging import aging_for_ticket, report_sort_key
from ..store import ZeusStore
from ..tickets import spare_from_bom
from ..utils import json_dumps, parse_date


COLUMN_DEFINITIONS: tuple[dict[str, Any], ...] = (
    {"key": "risk", "label": "", "width": 18, "default": True},
    {"key": "ticketId", "label": "SR", "width": 94, "default": True},
    {"key": "lifecycle", "label": "Life", "width": 108, "default": True},
    {"key": "done", "label": "Done", "width": 58, "default": True},
    {"key": "plannedDate", "label": "Planned", "width": 116, "default": True},
    {"key": "ticketAgeDays", "label": "Age", "width": 62, "default": True},
    {"key": "emailLabel", "label": "Email", "width": 142, "default": True},
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
    local = ticket.get("local", {}).get("fields", {})
    email = ticket.get("email", {})
    return {
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
        "model": local.get("Model") or "—",
        "device": local.get("Device") or "—",
        "risk": _risk(
            facts.planned_color,
            facts.ticket_age_color,
            facts.communication_color,
            facts.resolve_color,
        ),
    }


def _message_payload(message: dict[str, Any]) -> dict[str, Any]:
    return {
        "messageKey": message.get("message_key"),
        "timestamp": message.get("timestamp"),
        "direction": message.get("direction"),
        "subject": message.get("subject") or "(no subject)",
        "sender": message.get("sender"),
        "body": str(message.get("body") or ""),
        "latestReplyBody": message.get("latest_reply_body"),
        "quotedHistoryHidden": bool(message.get("quoted_history_hidden")),
        "quotedHistoryLines": int(message.get("quoted_history_lines") or 0),
    }


def serialize_ticket_detail(
    ticket: dict[str, Any], config: dict[str, Any]
) -> dict[str, Any]:
    result = serialize_ticket_summary(ticket, config)
    email = ticket.get("email", {})
    local_fields = deepcopy(ticket.get("local", {}).get("fields", {}))
    planned_date = parse_date(local_fields.get("Planned Date"))
    # Native browser date controls consume ISO calendar dates.  Invalid legacy
    # labels such as ``Unplanned`` are represented by an empty date control;
    # the summary still exposes the human-readable "Unplanned" label.
    local_fields["Planned Date"] = planned_date.isoformat() if planned_date else None
    local_fields["Spare"] = spare_from_bom(local_fields.get("BOM"))
    result.update(
        {
            "upstreamFields": deepcopy(
                ticket.get("upstream", {}).get("fields", {})
            ),
            "localFields": local_fields,
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
        }
    )
    return result


def _ticket_search_text(ticket: dict[str, Any]) -> str:
    upstream = ticket.get("upstream", {}).get("fields", {})
    local = ticket.get("local", {}).get("fields", {})
    values = [ticket.get("ticket_id"), *upstream.values(), *local.values()]
    return "\n".join(str(value) for value in values if value not in (None, "")).casefold()


def _sort_key(ticket: dict[str, Any], config: dict[str, Any], mode: str) -> Any:
    facts = aging_for_ticket(ticket, config)
    upstream = ticket.get("upstream", {}).get("fields", {})
    if mode == "sr":
        return (-int(ticket["ticket_id"]),)
    if mode in {"report", "planned"}:
        return report_sort_key(ticket, config)
    if mode == "email":
        value = facts.communication_inactivity_days
        return (value is None, 0 if value is None else -value, -int(ticket["ticket_id"]))
    if mode == "age":
        return (-(facts.ticket_age_days or -1), -int(ticket["ticket_id"]))
    if mode == "severity":
        return (str(upstream.get("Customer Severity") or "").casefold(), -int(ticket["ticket_id"]))
    if mode == "status":
        return (str(upstream.get("Status") or "").casefold(), -int(ticket["ticket_id"]))
    return report_sort_key(ticket, config)


def dashboard_payload(
    store: ZeusStore,
    *,
    sort: str = "report",
    search: str = "",
    dataset_revision: int = 0,
) -> dict[str, Any]:
    config = store.config
    all_records = list(store.iter_tickets())
    active = [
        ticket
        for ticket in all_records
        if ticket.get("lifecycle", {}).get("status") == "active"
    ]
    closing = [ticket for ticket in all_records if ticket not in active]
    query = search.strip().casefold()
    ordered = sorted(active, key=lambda value: _sort_key(value, config, sort)) + sorted(
        closing, key=lambda value: _sort_key(value, config, sort)
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
        "datasetRevision": dataset_revision,
        "sort": sort,
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
