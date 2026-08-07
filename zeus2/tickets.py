from __future__ import annotations

from copy import deepcopy
from typing import Any

from .utils import iso_now, normalize_ticket_id


UPSTREAM_COLUMNS = [
    "SRNo",
    "Problem Summary",
    "Report Date",
    "Customer Contact",
    "Customer Severity",
    "Product",
    "Current Handler",
    "Status",
    "ResolveBy",
    "Resolve By Suspend",
]

LOCAL_COLUMNS = [
    "Planned Date",
    "Site",
    "Cloud",
    "Model",
    "Device",
    "Slot",
    "Part",
    "BOM",
    "Old SN",
    "New SN",
    "RelatedSR",
    "Notes",
    "Spare",
    "Done?",
]

PENDING_COLUMNS = [
    "SRNo",
    "Problem Summary",
    "Planned Date",
    "Site",
    "Cloud",
    "Model",
    "Device",
    "Slot",
    "Part",
    "BOM",
    "Old SN",
    "New SN",
    "RelatedSR",
    "Notes",
    "Report Date",
    "Customer Contact",
    "Customer Severity",
    "Product",
    "Current Handler",
    "Status",
    "ResolveBy",
    "Resolve By Suspend",
    "Spare",
    "Done?",
]

# These two columns occur in the supplied historical Closed workbook.  They
# are recognized legacy aliases, not permission for arbitrary custom columns.
CLOSED_SCHEMA_DRIFT_COLUMNS = ["Old SerialNumber", "New SerialNumber"]

WORKFLOW_CODE_TO_STATE = {
    "N": "not_done",
    "Y": "completed",
    "P": "attempted_issue_pending",
    "?": "unknown_external",
}


def normalize_done(value: Any) -> tuple[str, bool]:
    """Return the normalized workflow code and whether correction occurred."""

    text = str(value).strip().upper() if value is not None else ""
    if text in WORKFLOW_CODE_TO_STATE:
        return text, False
    return "N", True


def workflow_from_code(value: Any) -> tuple[str, str]:
    code, _ = normalize_done(value)
    return WORKFLOW_CODE_TO_STATE[code], code


def workflow_code(ticket: dict[str, Any]) -> str:
    value = ticket.get("local", {}).get("fields", {}).get("Done?")
    return normalize_done(value)[0]


def empty_local() -> dict[str, Any]:
    return {
        "fields": {column: ("N" if column == "Done?" else None) for column in LOCAL_COLUMNS},
        "presentation": {"cell_styles": {}},
        "mop_fields": {},
    }


def empty_email(ticket_id: str) -> dict[str, Any]:
    return {
        "ticket_id": normalize_ticket_id(ticket_id),
        "total_received": 0,
        "total_sent": 0,
        "latest_received_at": None,
        "latest_sent_at": None,
        "last_activity_at": None,
        "last_direction": None,
        "last_fetched_at": None,
        "last_synchronized_at": None,
        "messages": [],
    }


def new_ticket(
    ticket_id: str,
    upstream_fields: dict[str, Any],
    source: dict[str, Any],
    *,
    sr_url: str | None = None,
    local: dict[str, Any] | None = None,
    lifecycle_status: str = "active",
    timestamp: str | None = None,
) -> dict[str, Any]:
    normalized = normalize_ticket_id(ticket_id)
    current_time = timestamp or iso_now()
    fields = {column: upstream_fields.get(column) for column in UPSTREAM_COLUMNS}
    fields["SRNo"] = normalized
    prepared_local = deepcopy(local) if local is not None else empty_local()
    prepared_local.setdefault("fields", {})["Done?"] = normalize_done(
        prepared_local.get("fields", {}).get("Done?")
    )[0]
    return {
        "schema_version": 2,
        "ticket_id": normalized,
        "lifecycle": {
            "status": lifecycle_status,
            "first_seen_at": current_time,
            "last_seen_at": current_time,
            "closure_pending_at": None,
            "reopened_at": None,
            "reopen_count": 0,
        },
        "upstream": {
            "source": deepcopy(source),
            "fields": fields,
            "sr_url": sr_url,
        },
        "local": prepared_local,
        "email": empty_email(normalized),
        "mop": {"latest": None, "versions": 0},
        "updated_at": current_time,
    }


def refresh_upstream(
    ticket: dict[str, Any],
    upstream_fields: dict[str, Any],
    source: dict[str, Any],
    *,
    sr_url: str | None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    updated = deepcopy(ticket)
    ticket_id = normalize_ticket_id(updated.get("ticket_id"))
    fields = {column: upstream_fields.get(column) for column in UPSTREAM_COLUMNS}
    fields["SRNo"] = ticket_id
    updated.setdefault("upstream", {})["fields"] = fields
    updated["upstream"]["source"] = deepcopy(source)
    updated["upstream"]["sr_url"] = sr_url
    current_time = timestamp or iso_now()
    updated.setdefault("lifecycle", {})["last_seen_at"] = current_time
    updated["updated_at"] = current_time
    return updated


def notes_cell_value(notes: str) -> str | None:
    cleaned = notes.strip()
    return cleaned or None


def ticket_cell_value(ticket: dict[str, Any], column: str) -> Any:
    if column in UPSTREAM_COLUMNS:
        if column == "SRNo":
            return ticket["ticket_id"]
        return ticket.get("upstream", {}).get("fields", {}).get(column)
    return ticket.get("local", {}).get("fields", {}).get(column)
