from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import hashlib
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
)
from ..store import ZeusStore
from ..tickets import normalize_local
from ..utils import iso_now, json_dumps, local_today, normalize_ticket_id, parse_date
from .errors import ConflictError, NotFoundError, ValidationError
from .serialization import serialize_ticket_summary, ticket_revision


def _new_window_id(now: datetime | None = None) -> str:
    current = now or datetime.now().astimezone()
    return f"MW-{current.strftime('%y%m%d%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"


def _resolved_window_id(ticket: dict[str, Any]) -> str | None:
    window = maintenance_window_for_local(normalize_local(ticket.get("local")))
    if window.get("status") != STATUS_PLANNED or not window.get("date"):
        return None
    return str(window.get("window_id") or f"MW-SR-{ticket['ticket_id']}")


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
                "canComplete": managed and status == "incomplete",
                "members": [identities[ticket["ticket_id"]] for ticket in sorted(members, key=lambda value: value["ticket_id"], reverse=True)],
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
            "awaitingReview": sum(bool(window["canComplete"]) for window in windows),
        },
    }


def schedule_upcoming_window(
    store: ZeusStore,
    *,
    planned_date: Any,
    start_time: Any,
    ticket_ids: Any,
) -> str:
    planned = parse_date(planned_date)
    if planned is None:
        raise ValidationError("Choose a valid Maintenance Window date")
    if planned < local_today():
        raise ValidationError("Upcoming Maintenance Windows cannot begin in the past")
    try:
        normalized_start = normalize_half_hour_time(
            start_time,
            label="Maintenance Window start time",
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if not isinstance(ticket_ids, list):
        raise ValidationError("Choose the Service Requests attached to this window")
    try:
        normalized_ids = list(dict.fromkeys(normalize_ticket_id(value) for value in ticket_ids))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if not normalized_ids:
        raise ValidationError("Choose at least one Service Request")
    known_window_ids: set[str] = set()
    for ticket in store.iter_tickets():
        window = maintenance_window_for_local(normalize_local(ticket.get("local")))
        if window.get("window_id"):
            known_window_ids.add(str(window["window_id"]))
        known_window_ids.update(
            str(attempt["window_id"])
            for attempt in window.get("attempts") or []
            if attempt.get("window_id")
        )
    for _attempt in range(100):
        window_id = _new_window_id()
        if window_id not in known_window_ids:
            break
    else:  # pragma: no cover - requires 100 UUID-prefix collisions in a row
        raise ConflictError("Zeus could not allocate a unique Maintenance Window ID")
    summary = {
        "window_id": window_id,
        "planned_date": planned.isoformat(),
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
        for ticket in tickets:
            ticket["local"] = set_maintenance_window_plan(
                normalize_local(ticket.get("local")),
                planned,
                start_time=normalized_start,
                window_id=window_id,
            )
            store.write_ticket_bundle(staging, ticket)
    return window_id


def complete_upcoming_window(
    store: ZeusStore,
    window_id: str,
    *,
    expected_revision: str,
    outcomes: Any,
    finish_time: Any = None,
) -> list[str]:
    normalized_window_id = str(window_id or "").strip().upper()
    if not SHARED_WINDOW_ID_PATTERN.fullmatch(normalized_window_id) or not expected_revision:
        raise ValidationError("A current shared Maintenance Window revision is required")
    if not isinstance(outcomes, dict):
        raise ValidationError("Review every linked Service Request before completing the window")

    live_members = [
        ticket
        for ticket in store.iter_tickets(status="active")
        if maintenance_window_for_local(normalize_local(ticket.get("local"))).get("window_id")
        == normalized_window_id
    ]
    if not live_members:
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
        staging_members = [
            ticket
            for ticket in store.iter_tickets(status="active", current_path=staging)
            if maintenance_window_for_local(normalize_local(ticket.get("local"))).get(
                "window_id"
            )
            == normalized_window_id
        ]
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
                    expected_window_id=normalized_window_id,
                    successful=bool(outcomes[ticket_id]),
                    timestamp=timestamp,
                    source="upcoming-manager",
                    finish_time=finish_time,
                )
            except ValueError as exc:
                raise ValidationError(str(exc), details={"ticketId": ticket_id}) from exc
            store.write_ticket_bundle(staging, ticket)
    return sorted(member_ids)
