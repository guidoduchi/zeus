from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..store import ZeusStore
from ..tickets import (
    EDITABLE_LOCAL_COLUMNS,
    SPARE_PARTS_CHANGE_KEY,
    normalize_done,
    normalize_local,
    normalize_spare_parts,
    newline_values,
)
from ..utils import normalize_ticket_id, parse_date
from .errors import ConflictError, ValidationError
from .serialization import ticket_revision


class PendingsConflictError(ConflictError):
    """Compatibility error retained for callers from Zeus 3.1.2 and earlier."""

    code = "pendings_conflict"


class TicketRevisionConflictError(ConflictError):
    code = "ticket_revision_conflict"


def _normalize_local_changes(changes: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(changes, dict) or not changes:
        raise ValidationError("Choose at least one Zeus work field to update")
    if "Spare" in changes:
        raise ValidationError("Spare is an export-only value and cannot be edited directly")
    allowed = set(EDITABLE_LOCAL_COLUMNS) | {SPARE_PARTS_CHANGE_KEY}
    unknown = sorted(set(changes) - allowed)
    if unknown:
        raise ValidationError(
            "Only Zeus-owned work fields can be edited",
            details={"unknownFields": unknown},
        )
    prepared: dict[str, Any] = {}
    for key, value in changes.items():
        if key == SPARE_PARTS_CHANGE_KEY:
            prepared[key] = _normalize_spare_parts_change(value)
            continue
        if isinstance(value, (dict, list, tuple, set)):
            raise ValidationError(f"{key} must be a text, date, number, or blank value")
        if key == "Done?":
            code, corrected = normalize_done(value)
            if corrected:
                raise ValidationError("MW must be Y, N, P, or ?")
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


def _normalize_spare_parts_change(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValidationError("Spare Parts must be a list of devices")
    if len(value) > 200:
        raise ValidationError("A ticket cannot contain more than 200 damaged devices")
    device_keys = {"device", "model", "faulty_sns", "faulty_sn", "parts"}
    # Legacy faulty_sn/new_sn values remain accepted so protected 3.1.4
    # drafts can be upgraded safely. New UI records use device faulty_sns and
    # part slot/part/bom/notes.
    part_keys = {"slot", "slots", "part", "bom", "faulty_sn", "new_sn", "notes"}
    total_parts = 0
    for device_index, device in enumerate(value, start=1):
        if not isinstance(device, dict):
            raise ValidationError(f"Spare Parts device {device_index} must be an object")
        unknown_device = sorted(set(device) - device_keys)
        if unknown_device:
            raise ValidationError(
                f"Spare Parts device {device_index} has unknown fields: "
                + ", ".join(unknown_device)
            )
        for key in ("device", "model"):
            field = device.get(key)
            if field is not None and isinstance(field, (dict, list, tuple, set)):
                raise ValidationError(
                    f"Spare Parts device {device_index} {key} must be text or blank"
                )
            if field is not None and len(str(field)) > 10_000:
                raise ValidationError(f"Spare Parts device {device_index} {key} is too long")
        raw_serials = device.get("faulty_sns", device.get("faulty_sn"))
        if raw_serials is not None and not isinstance(raw_serials, (str, list)):
            raise ValidationError(
                f"Spare Parts device {device_index} faulty serials must be text, a list, or blank"
            )
        if isinstance(raw_serials, list) and any(
            isinstance(value, (dict, list, tuple, set)) for value in raw_serials
        ):
            raise ValidationError(
                f"Spare Parts device {device_index} faulty serials must contain text only"
            )
        serials = newline_values(raw_serials)
        if len(serials) > 1000:
            raise ValidationError(
                f"Spare Parts device {device_index} cannot contain more than 1,000 faulty serials"
            )
        if any(len(serial) > 120 for serial in serials):
            raise ValidationError(
                f"Spare Parts device {device_index} faulty serials cannot exceed 120 characters each"
            )
        parts = device.get("parts", [])
        if not isinstance(parts, list):
            raise ValidationError(f"Spare Parts device {device_index} parts must be a list")
        total_parts += len(parts)
        if total_parts > 2_000:
            raise ValidationError("A ticket cannot contain more than 2,000 damaged parts")
        for part_index, part in enumerate(parts, start=1):
            if not isinstance(part, dict):
                raise ValidationError(
                    f"Spare Parts device {device_index}, part {part_index} must be an object"
                )
            unknown_part = sorted(set(part) - part_keys)
            if unknown_part:
                raise ValidationError(
                    f"Spare Parts device {device_index}, part {part_index} has unknown fields: "
                    + ", ".join(unknown_part)
                )
            slots = newline_values(part.get("slots", part.get("slot")))
            if len(slots) > 1000:
                raise ValidationError(
                    f"Spare Parts device {device_index}, part {part_index} cannot contain more than 1,000 slots"
                )
            if any(len(slot) > 120 for slot in slots):
                raise ValidationError(
                    f"Spare Parts device {device_index}, part {part_index} slots cannot exceed 120 characters each"
                )
            for key, field in part.items():
                collection_allowed = key in {"slot", "slots"} and isinstance(field, list)
                if field is not None and isinstance(field, (dict, list, tuple, set)) and not collection_allowed:
                    raise ValidationError(
                        f"Spare Parts device {device_index}, part {part_index} {key} "
                        "must be text or blank"
                    )
                if field is not None and not collection_allowed and len(str(field)) > 10_000:
                    raise ValidationError(
                        f"Spare Parts device {device_index}, part {part_index} {key} is too long"
                    )
    return normalize_spare_parts(value)


def _prepare_local_edit(
    ticket: dict[str, Any],
    changes: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    prepared = _normalize_local_changes(changes)
    existing_local = normalize_local(ticket.get("local"))
    proposed_local = deepcopy(existing_local)
    proposed_fields = proposed_local["fields"]
    for key, value in prepared.items():
        if key == SPARE_PARTS_CHANGE_KEY:
            proposed_local["spare_parts"] = value
        else:
            proposed_fields[key] = value
    proposed_local = normalize_local(proposed_local)

    changed_fields = [
        key
        for key, value in prepared.items()
        if (
            existing_local.get("spare_parts") != value
            if key == SPARE_PARTS_CHANGE_KEY
            else _comparable_cell(existing_local["fields"].get(key))
            != _comparable_cell(value)
        )
    ]
    if (
        SPARE_PARTS_CHANGE_KEY in changed_fields
        and existing_local["fields"].get("Spare")
        != proposed_local["fields"].get("Spare")
    ):
        changed_fields.append("Spare")
    return proposed_local, changed_fields


def edit_ticket_in_database(
    store: ZeusStore,
    ticket_id: str,
    changes: dict[str, Any],
    *,
    expected_revision: str,
) -> dict[str, Any]:
    """Persist validated work fields directly to the local Markdown database.

    Operational workbooks are generated output in Zeus 3.1.3. They are never
    read or rewritten as part of a browser save.
    """

    if not expected_revision:
        raise ValidationError("A ticket revision is required for safe editing")
    ticket = store.read_ticket(ticket_id)
    actual_revision = ticket_revision(ticket)
    if actual_revision != expected_revision:
        raise TicketRevisionConflictError(
            "This ticket changed after it was opened. Reload it before saving.",
            details={
                "expectedRevision": expected_revision,
                "actualRevision": actual_revision,
            },
        )

    proposed_local, changed_fields = _prepare_local_edit(ticket, changes)
    if not changed_fields:
        return {
            "changed": False,
            "ticket": ticket,
            "revision": actual_revision,
            "changedFields": [],
            "backup": None,
        }

    summary: dict[str, Any] = {
        "ticket_id": ticket_id,
        "changed_fields": changed_fields,
        "authority": "markdown_database",
    }
    with store.transaction("web-local-edit", summary) as staging:
        current = store.read_ticket(ticket_id, staging)
        current_revision = ticket_revision(current)
        if current_revision != expected_revision:
            raise TicketRevisionConflictError(
                "This ticket changed while the save was starting. Reload it before saving.",
                details={
                    "expectedRevision": expected_revision,
                    "actualRevision": current_revision,
                },
            )
        current["local"] = proposed_local
        store.write_ticket_bundle(staging, current)

    updated = store.read_ticket(ticket_id)
    return {
        "changed": True,
        "ticket": updated,
        "revision": ticket_revision(updated),
        "changedFields": changed_fields,
        "backup": summary.get("backup"),
    }


def edit_tickets_in_database(
    store: ZeusStore,
    edits: list[dict[str, Any]],
) -> dict[str, Any]:
    """Apply a reviewed set of ticket drafts in one all-or-nothing transaction."""

    if not isinstance(edits, list) or not edits:
        raise ValidationError("Choose at least one protected SR draft to save")
    if len(edits) > 500:
        raise ValidationError("No more than 500 SR drafts can be saved at once")

    prepared: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(edits, start=1):
        if not isinstance(raw, dict):
            raise ValidationError(f"Draft update {index} must be an object")
        try:
            ticket_id = normalize_ticket_id(raw.get("ticketId"))
        except ValueError as exc:
            raise ValidationError(f"Draft update {index} has an invalid SR") from exc
        if ticket_id in seen:
            raise ValidationError(f"SR {ticket_id} appears more than once in the draft batch")
        seen.add(ticket_id)
        expected_revision = str(raw.get("revision") or "").strip('"')
        if not expected_revision:
            raise ValidationError(f"SR {ticket_id} requires a revision for safe editing")
        changes = raw.get("changes")
        if not isinstance(changes, dict):
            raise ValidationError(f"SR {ticket_id} changes must be an object")
        ticket = store.read_ticket(ticket_id)
        actual_revision = ticket_revision(ticket)
        if actual_revision != expected_revision:
            raise TicketRevisionConflictError(
                f"SR {ticket_id} changed after the batch was reviewed. Restore its draft before saving.",
                details={
                    "ticketId": ticket_id,
                    "expectedRevision": expected_revision,
                    "actualRevision": actual_revision,
                },
            )
        proposed_local, changed_fields = _prepare_local_edit(ticket, changes)
        prepared.append(
            {
                "ticket_id": ticket_id,
                "expected_revision": expected_revision,
                "proposed_local": proposed_local,
                "changed_fields": changed_fields,
            }
        )

    changed = [entry for entry in prepared if entry["changed_fields"]]
    summary: dict[str, Any] = {
        "ticket_ids": [entry["ticket_id"] for entry in changed],
        "tickets": len(changed),
        "changed_fields": {
            entry["ticket_id"]: entry["changed_fields"] for entry in changed
        },
        "authority": "markdown_database",
    }
    if changed:
        with store.transaction("web-local-batch-edit", summary) as staging:
            for entry in changed:
                current = store.read_ticket(entry["ticket_id"], staging)
                current_revision = ticket_revision(current)
                if current_revision != entry["expected_revision"]:
                    raise TicketRevisionConflictError(
                        f"SR {entry['ticket_id']} changed while the batch save was starting.",
                        details={
                            "ticketId": entry["ticket_id"],
                            "expectedRevision": entry["expected_revision"],
                            "actualRevision": current_revision,
                        },
                    )
                current["local"] = entry["proposed_local"]
                store.write_ticket_bundle(staging, current)

    return {
        "changed": bool(changed),
        "ticketIds": [entry["ticket_id"] for entry in changed],
        "results": [
            {
                "ticketId": entry["ticket_id"],
                "changed": bool(entry["changed_fields"]),
                "changedFields": entry["changed_fields"],
                "revision": ticket_revision(store.read_ticket(entry["ticket_id"])),
            }
            for entry in prepared
        ],
        "backup": summary.get("backup"),
    }


def edit_ticket_through_pendings(
    store: ZeusStore,
    ticket_id: str,
    changes: dict[str, Any],
    *,
    expected_revision: str,
) -> dict[str, Any]:
    """Compatibility alias for extensions written before Zeus 3.1.3."""

    return edit_ticket_in_database(
        store,
        ticket_id,
        changes,
        expected_revision=expected_revision,
    )


def _comparable_cell(value: Any) -> Any:
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except (TypeError, ValueError):
            pass
    if value is None:
        return None
    return str(value).strip()
