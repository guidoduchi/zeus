from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
from pathlib import Path
import re
from typing import Any
import uuid

from ..maintenance_windows import (
    SHARED_WINDOW_ID_PATTERN,
    STATUS_PLANNED,
    confirm_maintenance_window,
    maintenance_window_for_local,
    maintenance_window_summary,
    normalize_half_hour_time,
    set_maintenance_window_plan,
    set_maintenance_window_status,
    STATUS_UNPLANNED,
)
from ..store import StoreError, ZeusStore
from ..tickets import normalize_local
from ..utils import (
    atomic_write_json,
    iso_now,
    json_dumps,
    local_today,
    normalize_ticket_id,
    parse_date,
)
from .errors import ConflictError, NotFoundError, ValidationError
from .serialization import serialize_ticket_summary, ticket_revision


STANDALONE_WINDOW_ID_PATTERN = re.compile(r"^MW-SR-(\d{8})$")
UNLINKED_WINDOW_STATE_KEY = "unlinked_maintenance_windows"


def _new_window_id(now: datetime | None = None) -> str:
    current = now or datetime.now().astimezone()
    return f"MW-{current.strftime('%y%m%d%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"


def _normalize_manager_window_id(value: Any) -> str:
    window_id = str(value or "").strip().upper()
    if not (
        SHARED_WINDOW_ID_PATTERN.fullmatch(window_id)
        or STANDALONE_WINDOW_ID_PATTERN.fullmatch(window_id)
    ):
        raise ValidationError("Maintenance Window ID is invalid")
    return window_id


def _normalize_ticket_ids(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValidationError("Service Request selection must be a list")
    try:
        return list(dict.fromkeys(normalize_ticket_id(ticket_id) for ticket_id in value))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _normalize_schedule(
    planned_date: Any,
    start_time: Any,
    *,
    allow_past: bool,
) -> tuple[str, str | None]:
    planned = parse_date(planned_date)
    if planned is None:
        raise ValidationError("Choose a valid Maintenance Window date")
    if not allow_past and planned < local_today():
        raise ValidationError("Upcoming Maintenance Windows cannot begin in the past")
    try:
        normalized_start = normalize_half_hour_time(
            start_time,
            label="Maintenance Window start time",
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return planned.isoformat(), normalized_start


def _normalize_unlinked_window(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StoreError("Unlinked Maintenance Window record must be an object")
    window_id = str(value.get("window_id") or "").strip().upper()
    if not SHARED_WINDOW_ID_PATTERN.fullmatch(window_id):
        raise StoreError("Unlinked Maintenance Window ID is invalid")
    planned = parse_date(value.get("date"))
    if planned is None:
        raise StoreError(f"Unlinked Maintenance Window {window_id} date is invalid")
    try:
        start_time = normalize_half_hour_time(
            value.get("start_time"),
            label="Maintenance Window start time",
        )
    except ValueError as exc:
        raise StoreError(f"Unlinked Maintenance Window {window_id}: {exc}") from exc
    created_at = str(value.get("created_at") or "").strip() or iso_now()
    updated_at = str(value.get("updated_at") or "").strip() or created_at
    return {
        "schema_version": 1,
        "window_id": window_id,
        "date": planned.isoformat(),
        "start_time": start_time,
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _unlinked_windows(
    store: ZeusStore,
    current_path: Path | None = None,
) -> list[dict[str, Any]]:
    raw = store.state(current_path).get(UNLINKED_WINDOW_STATE_KEY, [])
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise StoreError("Unlinked Maintenance Window state must be a list")
    windows = [_normalize_unlinked_window(value) for value in raw]
    identifiers = [window["window_id"] for window in windows]
    if len(identifiers) != len(set(identifiers)):
        raise StoreError("Unlinked Maintenance Window state contains duplicate IDs")
    return windows


def _write_unlinked_windows(
    store: ZeusStore,
    current_path: Path,
    windows: list[dict[str, Any]],
) -> None:
    state = store.state(current_path)
    state[UNLINKED_WINDOW_STATE_KEY] = sorted(
        (_normalize_unlinked_window(window) for window in windows),
        key=lambda window: window["window_id"],
    )
    atomic_write_json(current_path / "state.json", state)


def _unlinked_revision(window: dict[str, Any]) -> str:
    return hashlib.sha256(
        json_dumps(_normalize_unlinked_window(window), indent=None).encode("utf-8")
    ).hexdigest()


def _resolved_window_id(ticket: dict[str, Any]) -> str | None:
    window = maintenance_window_for_local(normalize_local(ticket.get("local")))
    if window.get("status") != STATUS_PLANNED or not window.get("date"):
        return None
    return str(window.get("window_id") or f"MW-SR-{ticket['ticket_id']}")


def _members_for_window(
    store: ZeusStore,
    window_id: str,
    current_path: Path | None = None,
) -> list[dict[str, Any]]:
    return [
        ticket
        for ticket in store.iter_tickets(status="active", current_path=current_path)
        if _resolved_window_id(ticket) == window_id
    ]


def _known_window_ids(store: ZeusStore) -> set[str]:
    known: set[str] = {
        window["window_id"] for window in _unlinked_windows(store)
    }
    for ticket in store.iter_tickets():
        current_id = _resolved_window_id(ticket)
        if current_id:
            known.add(current_id)
        window = maintenance_window_for_local(normalize_local(ticket.get("local")))
        known.update(
            str(attempt["window_id"])
            for attempt in window.get("attempts") or []
            if attempt.get("window_id")
        )
    return known


def _allocate_window_id(store: ZeusStore) -> str:
    known = _known_window_ids(store)
    for _attempt in range(100):
        window_id = _new_window_id()
        if window_id not in known:
            return window_id
    raise ConflictError("Zeus could not allocate a unique Maintenance Window ID")


def _window_revision(members: list[dict[str, Any]]) -> str:
    payload = [
        {
            "ticket_id": ticket["ticket_id"],
            "revision": ticket_revision(ticket),
            "window": maintenance_window_for_local(normalize_local(ticket.get("local"))),
        }
        for ticket in sorted(members, key=lambda value: value["ticket_id"])
    ]
    return hashlib.sha256(json_dumps(payload, indent=None).encode("utf-8")).hexdigest()


def _ticket_identity(ticket: dict[str, Any], store: ZeusStore) -> dict[str, Any]:
    summary = serialize_ticket_summary(ticket, store.config)
    return {
        "ticketId": summary["ticketId"],
        "summary": summary["summary"],
        "site": summary["site"],
        "cloud": summary["cloud"],
        "severity": summary["severity"],
        "handler": summary["handler"],
    }


def upcoming_payload(store: ZeusStore, *, dataset_revision: int = 0) -> dict[str, Any]:
    tickets = list(store.iter_tickets(status="active"))
    identities = {
        ticket["ticket_id"]: _ticket_identity(ticket, store) for ticket in tickets
    }
    grouped: dict[str, list[dict[str, Any]]] = {}
    for ticket in tickets:
        window_id = _resolved_window_id(ticket)
        if window_id:
            grouped.setdefault(window_id, []).append(ticket)

    windows: list[dict[str, Any]] = []
    for window_id, members in grouped.items():
        first_window = maintenance_window_for_local(normalize_local(members[0].get("local")))
        dates = {maintenance_window_for_local(normalize_local(ticket.get("local"))).get("date") for ticket in members}
        starts = {maintenance_window_for_local(normalize_local(ticket.get("local"))).get("start_time") for ticket in members}
        if len(dates) != 1 or len(starts) != 1:
            # A shared ID with divergent member facts is never silently merged
            # in the UI. Surface it as a conflict that must be corrected before
            # completion.
            status = "conflict"
            date_value = str(first_window.get("date") or "") or None
            start_value = first_window.get("start_time")
        else:
            date_value = next(iter(dates))
            start_value = next(iter(starts))
            status = (
                "incomplete"
                if any(
                    maintenance_window_summary(normalize_local(ticket.get("local"))).get(
                        "confirmationRequired"
                    )
                    for ticket in members
                )
                else "planned"
            )
        managed = bool(first_window.get("window_id"))
        windows.append(
            {
                "windowId": window_id,
                "revision": _window_revision(members),
                "date": date_value,
                "startTime": start_value,
                "status": status,
                "managed": managed,
                "kind": "shared" if managed else "standalone",
                "canComplete": status == "incomplete",
                "members": [identities[ticket["ticket_id"]] for ticket in sorted(members, key=lambda value: value["ticket_id"], reverse=True)],
            }
        )
    for window in _unlinked_windows(store):
        windows.append(
            {
                "windowId": window["window_id"],
                "revision": _unlinked_revision(window),
                "date": window["date"],
                "startTime": window.get("start_time"),
                "status": "planned",
                "managed": True,
                "kind": "unlinked",
                "canComplete": False,
                "members": [],
            }
        )
    windows.sort(key=lambda value: (str(value.get("date") or ""), str(value.get("startTime") or "99:99"), value["windowId"]))

    archived_groups: dict[str, dict[str, Any]] = {}
    for ticket in tickets:
        window = maintenance_window_for_local(normalize_local(ticket.get("local")))
        for attempt in window.get("attempts") or []:
            window_id = attempt.get("window_id")
            if not window_id:
                continue
            group = archived_groups.setdefault(
                str(window_id),
                {
                    "windowId": str(window_id),
                    "date": attempt.get("date"),
                    "startTime": attempt.get("start_time"),
                    "finishTime": attempt.get("finish_time"),
                    "finishDate": attempt.get("finish_date"),
                    "confirmedAt": attempt.get("confirmed_at"),
                    "members": [],
                },
            )
            confirmed_at = str(attempt.get("confirmed_at") or "")
            if confirmed_at > str(group.get("confirmedAt") or ""):
                group["confirmedAt"] = attempt.get("confirmed_at")
            if attempt.get("finish_time") and not group.get("finishTime"):
                group["finishTime"] = attempt.get("finish_time")
                group["finishDate"] = attempt.get("finish_date")
            group["members"].append(
                {
                    **identities[ticket["ticket_id"]],
                    "outcome": attempt.get("outcome"),
                }
            )
    archived = sorted(
        archived_groups.values(),
        key=lambda value: (str(value.get("date") or ""), str(value.get("confirmedAt") or "")),
        reverse=True,
    )[:20]

    candidates: list[dict[str, Any]] = []
    for ticket in sorted(tickets, key=lambda value: value["ticket_id"], reverse=True):
        current_id = _resolved_window_id(ticket)
        candidates.append(
            {
                **identities[ticket["ticket_id"]],
                "available": current_id is None,
                "currentWindowId": current_id,
                "currentWindow": (
                    maintenance_window_summary(normalize_local(ticket.get("local")))
                    if current_id
                    else None
                ),
            }
        )
    return {
        "datasetRevision": dataset_revision,
        "windows": windows,
        "archived": archived,
        "candidates": candidates,
        "stats": {
            "windows": len(windows),
            "tickets": sum(len(window["members"]) for window in windows),
            "awaitingReview": sum(
                window.get("status") == "incomplete" for window in windows
            ),
        },
    }


def schedule_upcoming_window(
    store: ZeusStore,
    *,
    planned_date: Any,
    start_time: Any,
    ticket_ids: Any,
) -> str:
    planned, normalized_start = _normalize_schedule(
        planned_date,
        start_time,
        allow_past=False,
    )
    normalized_ids = _normalize_ticket_ids(ticket_ids)
    window_id = _allocate_window_id(store)
    summary = {
        "window_id": window_id,
        "planned_date": planned,
        "start_time": normalized_start,
        "ticket_ids": normalized_ids,
    }
    with store.transaction("upcoming-maintenance-window-schedule", summary) as staging:
        tickets: list[dict[str, Any]] = []
        for ticket_id in normalized_ids:
            try:
                ticket = store.read_ticket(ticket_id, staging)
            except Exception as exc:
                raise NotFoundError(f"SR {ticket_id} was not found") from exc
            if ticket.get("lifecycle", {}).get("status") != "active":
                raise ValidationError(f"SR {ticket_id} is no longer active")
            current = maintenance_window_for_local(normalize_local(ticket.get("local")))
            if current.get("status") == STATUS_PLANNED and current.get("date"):
                raise ConflictError(
                    f"SR {ticket_id} already belongs to an unfinished Maintenance Window",
                    details={
                        "ticketId": ticket_id,
                        "windowId": current.get("window_id") or f"MW-SR-{ticket_id}",
                        "date": current.get("date"),
                    },
                )
            tickets.append(ticket)
        if tickets:
            for ticket in tickets:
                ticket["local"] = set_maintenance_window_plan(
                    normalize_local(ticket.get("local")),
                    planned,
                    start_time=normalized_start,
                    window_id=window_id,
                )
                store.write_ticket_bundle(staging, ticket)
        else:
            timestamp = iso_now()
            unlinked = _unlinked_windows(store, staging)
            unlinked.append(
                {
                    "schema_version": 1,
                    "window_id": window_id,
                    "date": planned,
                    "start_time": normalized_start,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
            )
            _write_unlinked_windows(store, staging, unlinked)
    return window_id


def complete_upcoming_window(
    store: ZeusStore,
    window_id: str,
    *,
    expected_revision: str,
    outcomes: Any,
    finish_time: Any = None,
) -> list[str]:
    normalized_window_id = _normalize_manager_window_id(window_id)
    if not expected_revision:
        raise ValidationError("A current Maintenance Window revision is required")
    if not isinstance(outcomes, dict):
        raise ValidationError("Review every linked Service Request before completing the window")

    live_members = _members_for_window(store, normalized_window_id)
    if not live_members:
        if any(
            window["window_id"] == normalized_window_id
            for window in _unlinked_windows(store)
        ):
            raise ValidationError(
                "Attach at least one Service Request before reviewing this Maintenance Window"
            )
        raise NotFoundError(f"Maintenance Window {normalized_window_id} was not found")
    if _window_revision(live_members) != expected_revision:
        raise ConflictError(
            "This Maintenance Window changed after the review opened. Reload it before confirming."
        )
    live_windows = [
        maintenance_window_for_local(normalize_local(ticket.get("local")))
        for ticket in live_members
    ]
    if (
        any(window.get("status") != STATUS_PLANNED for window in live_windows)
        or len({window.get("date") for window in live_windows}) != 1
        or len({window.get("start_time") for window in live_windows}) != 1
    ):
        raise ConflictError(
            "The linked Service Requests no longer agree on this Maintenance Window. Reload before completing it."
        )
    member_ids = {ticket["ticket_id"] for ticket in live_members}
    if set(outcomes) != member_ids or any(not isinstance(value, bool) for value in outcomes.values()):
        raise ValidationError("Choose Completed or Incomplete for every linked Service Request")

    timestamp = iso_now()
    summary = {
        "window_id": normalized_window_id,
        "ticket_ids": sorted(member_ids),
        "outcomes": deepcopy(outcomes),
        "finish_time": str(finish_time or "") or None,
    }
    with store.transaction("upcoming-maintenance-window-completion", summary) as staging:
        staging_members = _members_for_window(store, normalized_window_id, staging)
        if (
            {ticket["ticket_id"] for ticket in staging_members} != member_ids
            or _window_revision(staging_members) != expected_revision
        ):
            raise ConflictError(
                "This Maintenance Window changed while completion was starting. Reload it."
            )
        for ticket in staging_members:
            ticket_id = ticket["ticket_id"]
            window = maintenance_window_for_local(normalize_local(ticket.get("local")))
            try:
                ticket["local"] = confirm_maintenance_window(
                    normalize_local(ticket.get("local")),
                    expected_date=window.get("date"),
                    expected_window_id=(
                        normalized_window_id
                        if SHARED_WINDOW_ID_PATTERN.fullmatch(normalized_window_id)
                        else None
                    ),
                    successful=bool(outcomes[ticket_id]),
                    timestamp=timestamp,
                    source="upcoming-manager",
                    finish_time=finish_time,
                )
            except ValueError as exc:
                raise ValidationError(str(exc), details={"ticketId": ticket_id}) from exc
            store.write_ticket_bundle(staging, ticket)
    return sorted(member_ids)


def update_upcoming_window(
    store: ZeusStore,
    window_id: str,
    *,
    expected_revision: str,
    planned_date: Any,
    start_time: Any,
    ticket_ids: Any,
) -> tuple[str, list[str]]:
    normalized_window_id = _normalize_manager_window_id(window_id)
    if not expected_revision:
        raise ValidationError("A current Maintenance Window revision is required")
    planned, normalized_start = _normalize_schedule(
        planned_date,
        start_time,
        allow_past=True,
    )
    normalized_ids = _normalize_ticket_ids(ticket_ids)
    live_members = _members_for_window(store, normalized_window_id)
    live_unlinked = [
        window
        for window in _unlinked_windows(store)
        if window["window_id"] == normalized_window_id
    ]
    if bool(live_members) == bool(live_unlinked):
        if live_members:
            raise ConflictError(
                "This Maintenance Window has both linked and unlinked records. Repair it before editing."
            )
        raise NotFoundError(f"Maintenance Window {normalized_window_id} was not found")
    current_revision = (
        _window_revision(live_members)
        if live_members
        else _unlinked_revision(live_unlinked[0])
    )
    if current_revision != expected_revision:
        raise ConflictError(
            "This Maintenance Window changed after editing opened. Reload it before saving."
        )

    resulting_window_id = normalized_window_id
    current_member_ids = {ticket["ticket_id"] for ticket in live_members}
    if STANDALONE_WINDOW_ID_PATTERN.fullmatch(normalized_window_id) and (
        set(normalized_ids) != current_member_ids or len(normalized_ids) != 1
    ):
        resulting_window_id = _allocate_window_id(store)

    summary = {
        "window_id": normalized_window_id,
        "resulting_window_id": resulting_window_id,
        "planned_date": planned,
        "start_time": normalized_start,
        "previous_ticket_ids": sorted(current_member_ids),
        "ticket_ids": normalized_ids,
    }
    with store.transaction("upcoming-maintenance-window-update", summary) as staging:
        staging_members = _members_for_window(store, normalized_window_id, staging)
        staging_unlinked = [
            window
            for window in _unlinked_windows(store, staging)
            if window["window_id"] == normalized_window_id
        ]
        staging_revision = (
            _window_revision(staging_members)
            if staging_members
            else _unlinked_revision(staging_unlinked[0]) if staging_unlinked else ""
        )
        if staging_revision != expected_revision:
            raise ConflictError(
                "This Maintenance Window changed while the update was starting. Reload it."
            )

        target_tickets: dict[str, dict[str, Any]] = {}
        for ticket_id in normalized_ids:
            try:
                ticket = store.read_ticket(ticket_id, staging)
            except Exception as exc:
                raise NotFoundError(f"SR {ticket_id} was not found") from exc
            if ticket.get("lifecycle", {}).get("status") != "active":
                raise ValidationError(f"SR {ticket_id} is no longer active")
            current_id = _resolved_window_id(ticket)
            if current_id and current_id != normalized_window_id:
                raise ConflictError(
                    f"SR {ticket_id} already belongs to an unfinished Maintenance Window",
                    details={"ticketId": ticket_id, "windowId": current_id},
                )
            target_tickets[ticket_id] = ticket

        target_ids = set(normalized_ids)
        for ticket in staging_members:
            if ticket["ticket_id"] in target_ids:
                continue
            ticket["local"] = set_maintenance_window_status(
                normalize_local(ticket.get("local")), STATUS_UNPLANNED
            )
            store.write_ticket_bundle(staging, ticket)

        shared_id = (
            resulting_window_id
            if SHARED_WINDOW_ID_PATTERN.fullmatch(resulting_window_id)
            else None
        )
        for ticket_id in normalized_ids:
            ticket = target_tickets[ticket_id]
            ticket["local"] = set_maintenance_window_plan(
                normalize_local(ticket.get("local")),
                planned,
                start_time=normalized_start,
                window_id=shared_id,
            )
            store.write_ticket_bundle(staging, ticket)

        unlinked = [
            window
            for window in _unlinked_windows(store, staging)
            if window["window_id"] not in {normalized_window_id, resulting_window_id}
        ]
        if not normalized_ids:
            previous = staging_unlinked[0] if staging_unlinked else None
            timestamp = iso_now()
            unlinked.append(
                {
                    "schema_version": 1,
                    "window_id": resulting_window_id,
                    "date": planned,
                    "start_time": normalized_start,
                    "created_at": (
                        previous.get("created_at") if previous else timestamp
                    ),
                    "updated_at": timestamp,
                }
            )
        _write_unlinked_windows(store, staging, unlinked)
    return resulting_window_id, normalized_ids


def delete_upcoming_window(
    store: ZeusStore,
    window_id: str,
    *,
    expected_revision: str,
) -> list[str]:
    normalized_window_id = _normalize_manager_window_id(window_id)
    if not expected_revision:
        raise ValidationError("A current Maintenance Window revision is required")
    live_members = _members_for_window(store, normalized_window_id)
    live_unlinked = [
        window
        for window in _unlinked_windows(store)
        if window["window_id"] == normalized_window_id
    ]
    if bool(live_members) == bool(live_unlinked):
        if live_members:
            raise ConflictError(
                "This Maintenance Window has both linked and unlinked records. Repair it before deleting."
            )
        raise NotFoundError(f"Maintenance Window {normalized_window_id} was not found")
    current_revision = (
        _window_revision(live_members)
        if live_members
        else _unlinked_revision(live_unlinked[0])
    )
    if current_revision != expected_revision:
        raise ConflictError(
            "This Maintenance Window changed after deletion opened. Reload it before confirming."
        )
    member_ids = sorted(ticket["ticket_id"] for ticket in live_members)
    with store.transaction(
        "upcoming-maintenance-window-delete",
        {"window_id": normalized_window_id, "ticket_ids": member_ids},
    ) as staging:
        staging_members = _members_for_window(store, normalized_window_id, staging)
        staging_unlinked = [
            window
            for window in _unlinked_windows(store, staging)
            if window["window_id"] == normalized_window_id
        ]
        staging_revision = (
            _window_revision(staging_members)
            if staging_members
            else _unlinked_revision(staging_unlinked[0]) if staging_unlinked else ""
        )
        if staging_revision != expected_revision:
            raise ConflictError(
                "This Maintenance Window changed while deletion was starting. Reload it."
            )
        for ticket in staging_members:
            ticket["local"] = set_maintenance_window_status(
                normalize_local(ticket.get("local")), STATUS_UNPLANNED
            )
            store.write_ticket_bundle(staging, ticket)
        _write_unlinked_windows(
            store,
            staging,
            [
                window
                for window in _unlinked_windows(store, staging)
                if window["window_id"] != normalized_window_id
            ],
        )
    return member_ids
