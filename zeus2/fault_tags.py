from __future__ import annotations

import base64
import json
import re
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from .spare_requests import ECUADOR_TIMEZONE, normalize_rma, normalize_spare_sr, normalize_tt
from .utils import iso_now, json_dumps


FAULT_TAG_MARKER = "<!-- ZEUS_FAULT_TAG_V1:"
FAULT_TAG_SCHEMA_VERSION = 1
FAULT_TAG_ID_PATTERN = re.compile(r"FT-(\d{12})$")


class FaultTagError(ValueError):
    pass


def normalize_fault_tag_id(value: Any) -> str:
    text = str(value or "").strip().upper()
    match = FAULT_TAG_ID_PATTERN.fullmatch(text)
    if not match:
        raise FaultTagError("Fault Tag ID must use FT-YYMMDDHHmmss")
    try:
        datetime.strptime(match.group(1), "%y%m%d%H%M%S")
    except ValueError as exc:
        raise FaultTagError("Fault Tag ID contains an invalid Ecuador date and time") from exc
    return text


def next_fault_tag_id(
    existing: Iterable[str] = (), *, now: datetime | None = None
) -> str:
    occupied = {str(value).upper() for value in existing}
    current = now or datetime.now(ECUADOR_TIMEZONE)
    if current.tzinfo is None:
        current = current.replace(tzinfo=ECUADOR_TIMEZONE)
    else:
        current = current.astimezone(ECUADOR_TIMEZONE)
    for offset in range(3660):
        candidate = f"FT-{(current + timedelta(seconds=offset)).strftime('%y%m%d%H%M%S')}"
        if candidate not in occupied:
            return candidate
    raise FaultTagError("Zeus could not allocate a unique Fault Tag ID")


def normalize_return_site(value: Any) -> dict[str, str | None]:
    candidate = value if isinstance(value, dict) else {}
    code = str(candidate.get("code") or candidate.get("siteCode") or "").strip().upper()
    address = str(candidate.get("address") or candidate.get("siteAddress") or "").strip()
    cloud = str(candidate.get("cloud") or "").strip()
    name = str(candidate.get("name") or candidate.get("siteName") or "").strip() or None
    if not code:
        raise FaultTagError("The actual return site code is required")
    if not address:
        raise FaultTagError("The actual return site address is required")
    if not cloud:
        raise FaultTagError("The actual return-site cloud is required")
    return {"code": code, "name": name, "address": address, "cloud": cloud}


def create_fault_tag_record(
    *,
    fault_tag_id: str,
    members: list[dict[str, Any]],
    return_site: dict[str, Any],
    export: dict[str, Any],
    created_at: str | None = None,
) -> dict[str, Any]:
    identifier = normalize_fault_tag_id(fault_tag_id)
    if not members:
        raise FaultTagError("A Fault Tag must contain at least one item")
    timestamp = created_at or iso_now()
    prepared_members: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in members:
        item_id = str(raw.get("item_id") or raw.get("itemId") or "").strip()
        if not item_id or item_id in seen:
            raise FaultTagError("Fault Tag members must have unique item IDs")
        seen.add(item_id)
        condition = str(raw.get("condition") or "").strip().title()
        if condition not in {"Faulty", "New"}:
            raise FaultTagError("Fault Tag condition must be Faulty or New")
        prepared_members.append(
            {
                "item_id": item_id,
                "request_id": str(raw.get("request_id") or raw.get("requestId") or ""),
                "tt": normalize_tt(raw.get("tt")),
                "spare_sr": normalize_spare_sr(raw.get("spare_sr"), required=True),
                "rma": normalize_rma(raw.get("rma"), required=True),
                "condition": condition,
                "source_site": str(raw.get("source_site") or "").strip().upper() or None,
                "requested_bom": str(raw.get("requested_bom") or "").strip() or None,
                "new_sn": str(raw.get("new_sn") or "").strip() or None,
                "warehouse_evidence_at": raw.get("warehouse_evidence_at"),
                "warehouse_message_key": raw.get("warehouse_message_key"),
                "user_confirmed_at": raw.get("user_confirmed_at"),
                "request_snapshot": deepcopy(raw.get("request_snapshot")),
                "item_snapshot": deepcopy(raw.get("item_snapshot")),
            }
        )
    site = normalize_return_site(return_site)
    return {
        "schema_version": FAULT_TAG_SCHEMA_VERSION,
        "fault_tag_id": identifier,
        "return_site": site,
        "mixed_source_sites": len(
            {member.get("source_site") for member in prepared_members if member.get("source_site")}
        ) > 1,
        "members": prepared_members,
        "export": {
            "filename": str(export.get("filename") or "").strip() or None,
            "path": str(export.get("path") or "").strip() or None,
            "subject": str(export.get("subject") or "").strip(),
            "created_at": timestamp,
            "revisions": deepcopy(export.get("revisions") or []),
        },
        "email": {
            "sent_at": None,
            "message_key": None,
            "subject": None,
        },
        "locked_at": None,
        "locked_source": None,
        "history": [
            {
                "timestamp": timestamp,
                "action": "fault-tag-exported",
                "summary": {
                    "items": sorted(seen),
                    "filename": export.get("filename"),
                    "return_site": site["code"],
                },
            }
        ],
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def fault_tag_status(record: dict[str, Any]) -> str:
    members = list(record.get("members") or [])
    if members and all(member.get("user_confirmed_at") for member in members):
        return "completed"
    covered = sum(bool(member.get("warehouse_evidence_at")) for member in members)
    if covered == len(members) and members:
        return "awaiting_user_confirmation"
    if covered:
        return "partial_warehouse"
    if record.get("email", {}).get("sent_at"):
        return "sent"
    return "exported"


def validate_fault_tag_record(record: dict[str, Any], directory_name: str | None = None) -> None:
    if record.get("schema_version") != FAULT_TAG_SCHEMA_VERSION:
        raise FaultTagError("Unsupported Fault Tag schema")
    identifier = normalize_fault_tag_id(record.get("fault_tag_id"))
    if directory_name is not None and identifier != directory_name:
        raise FaultTagError(
            f"Fault Tag directory {directory_name!r} contains ID {identifier!r}"
        )
    normalize_return_site(record.get("return_site"))
    members = record.get("members")
    if not isinstance(members, list) or not members:
        raise FaultTagError(f"Fault Tag {identifier} must contain members")
    item_ids: set[str] = set()
    for member in members:
        if not isinstance(member, dict):
            raise FaultTagError(f"Fault Tag {identifier} contains an invalid member")
        item_id = str(member.get("item_id") or "")
        if not item_id or item_id in item_ids:
            raise FaultTagError(f"Fault Tag {identifier} contains duplicate item IDs")
        item_ids.add(item_id)
        normalize_tt(member.get("tt"))
        normalize_spare_sr(member.get("spare_sr"), required=True)
        normalize_rma(member.get("rma"), required=True)
        if member.get("condition") not in {"Faulty", "New"}:
            raise FaultTagError(f"Fault Tag {identifier} contains an invalid condition")
    if not isinstance(record.get("history", []), list):
        raise FaultTagError(f"Fault Tag {identifier} has invalid history")


def fault_tag_history(record: dict[str, Any], action: str, summary: dict[str, Any]) -> None:
    timestamp = iso_now()
    record.setdefault("history", []).append(
        {"timestamp": timestamp, "action": action, "summary": deepcopy(summary)}
    )
    record["updated_at"] = timestamp


def _encode(record: dict[str, Any]) -> str:
    return base64.b64encode(json_dumps(record, indent=None).encode("utf-8")).decode("ascii")


def decode_fault_tag_record(line: str, path: Path) -> dict[str, Any]:
    if not line.startswith(FAULT_TAG_MARKER) or not line.rstrip().endswith(" -->"):
        raise FaultTagError(f"Fault Tag marker is missing or invalid: {path}")
    encoded = line[len(FAULT_TAG_MARKER) : line.rfind(" -->")].strip()
    try:
        value = json.loads(base64.b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FaultTagError(f"Fault Tag payload is invalid: {path}") from exc
    if not isinstance(value, dict):
        raise FaultTagError(f"Fault Tag record is not an object: {path}")
    return value


def _display(value: Any) -> str:
    if value in (None, ""):
        return "—"
    return str(value).replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>")


def render_fault_tag_markdown(record: dict[str, Any]) -> str:
    identifier = normalize_fault_tag_id(record.get("fault_tag_id"))
    site = record.get("return_site", {})
    lines = [
        f"{FAULT_TAG_MARKER}{_encode(record)} -->",
        "",
        f"# Fault Tag {identifier}",
        "",
        f"- Status: **{_display(fault_tag_status(record))}**",
        f"- Return site: **{_display(site.get('code'))}**",
        f"- Export: {_display(record.get('export', {}).get('filename'))}",
        f"- Sent email: {_display(record.get('email', {}).get('sent_at'))}",
        "",
        "## Members",
        "",
        "| Item | TT | Spare SR | RMA | Condition | Warehouse evidence | User confirmed |",
        "|---|---|---|---|---|---|---|",
    ]
    for member in record.get("members", []):
        lines.append(
            "| "
            + " | ".join(
                _display(member.get(key))
                for key in (
                    "item_id",
                    "tt",
                    "spare_sr",
                    "rma",
                    "condition",
                    "warehouse_evidence_at",
                    "user_confirmed_at",
                )
            )
            + " |"
        )
    lines.extend(["", "## History", ""])
    for event in record.get("history", []):
        lines.append(
            f"- {_display(event.get('timestamp'))} — **{_display(event.get('action'))}**: "
            f"{_display(json_dumps(event.get('summary') or {}, indent=None))}"
        )
    return "\n".join(lines).rstrip() + "\n"
