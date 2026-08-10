from __future__ import annotations

from copy import deepcopy
from datetime import date
from typing import Any

from .utils import iso_now, local_today, parse_date


LOCAL_SCHEMA_VERSION = 2
MAINTENANCE_WINDOW_SCHEMA_VERSION = 1

STATUS_PLANNED = "planned"
STATUS_UNPLANNED = "unplanned"
STATUS_INCOMPLETE = "incomplete"
STATUS_COMPLETED = "completed"
STATUS_NO_VISIBILITY = "no_visibility"

MAINTENANCE_WINDOW_STATUSES = {
    STATUS_PLANNED,
    STATUS_UNPLANNED,
    STATUS_INCOMPLETE,
    STATUS_COMPLETED,
    STATUS_NO_VISIBILITY,
}

STATUS_TO_LEGACY_CODE = {
    STATUS_PLANNED: "N",
    STATUS_UNPLANNED: "N",
    STATUS_INCOMPLETE: "P",
    STATUS_COMPLETED: "Y",
    STATUS_NO_VISIBILITY: "?",
}

STATUS_LABELS = {
    STATUS_PLANNED: "Planned",
    STATUS_UNPLANNED: "Unplanned",
    STATUS_INCOMPLETE: "Incomplete",
    STATUS_COMPLETED: "Complete",
    STATUS_NO_VISIBILITY: "No visibility",
}


def validate_maintenance_window_record(value: Any) -> None:
    """Reject semantic corruption without rejecting a legacy record entirely."""

    if not isinstance(value, dict):
        raise ValueError("Maintenance Window record must be an object")
    raw_schema = value.get("schema_version")
    if raw_schema is not None:
        if isinstance(raw_schema, bool) or (
            isinstance(raw_schema, float) and not raw_schema.is_integer()
        ):
            raise ValueError("Maintenance Window schema_version is invalid")
        try:
            schema_version = int(raw_schema)
        except (TypeError, ValueError) as exc:
            raise ValueError("Maintenance Window schema_version is invalid") from exc
        if schema_version != MAINTENANCE_WINDOW_SCHEMA_VERSION:
            raise ValueError(
                f"Maintenance Window schema {schema_version} is unsupported"
            )
    status = str(value.get("status") or "").strip().lower()
    if status not in MAINTENANCE_WINDOW_STATUSES:
        raise ValueError("Maintenance Window status is invalid")
    raw_date = value.get("date")
    if raw_date not in (None, "") and parse_date(raw_date) is None:
        raise ValueError("Maintenance Window date is invalid")
    attempts = value.get("attempts", [])
    if not isinstance(attempts, list):
        raise ValueError("Maintenance Window attempts must be a list")
    for index, attempt in enumerate(attempts, start=1):
        if not isinstance(attempt, dict):
            raise ValueError(f"Maintenance Window attempt {index} must be an object")
        if parse_date(attempt.get("date")) is None:
            raise ValueError(f"Maintenance Window attempt {index} date is invalid")
        if str(attempt.get("outcome") or "").strip().lower() not in {
            "completed",
            "incomplete",
        }:
            raise ValueError(f"Maintenance Window attempt {index} outcome is invalid")
        if attempt.get("confirmed_at") is not None and not isinstance(
            attempt.get("confirmed_at"), str
        ):
            raise ValueError(
                f"Maintenance Window attempt {index} confirmed_at is invalid"
            )
        if attempt.get("source") is not None and not isinstance(
            attempt.get("source"), str
        ):
            raise ValueError(f"Maintenance Window attempt {index} source is invalid")
    if "review_required" in value and not isinstance(value.get("review_required"), bool):
        raise ValueError("Maintenance Window review_required must be true or false")


def _legacy_code(value: Any) -> str:
    text = str(value or "").strip().upper()
    return text if text in {"N", "Y", "P", "?"} else "N"


def _date_text(value: Any) -> str | None:
    parsed = parse_date(value)
    return parsed.isoformat() if parsed else None


def _normalize_attempts(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    attempts: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for candidate in value:
        if not isinstance(candidate, dict):
            continue
        attempt_date = _date_text(candidate.get("date"))
        outcome = str(candidate.get("outcome") or "").strip().lower()
        if attempt_date is None or outcome not in {"completed", "incomplete"}:
            continue
        confirmed_at = str(candidate.get("confirmed_at") or "").strip() or None
        source = str(candidate.get("source") or "manual").strip() or "manual"
        key = (attempt_date, outcome, confirmed_at or "")
        if key in seen:
            continue
        seen.add(key)
        attempts.append(
            {
                "date": attempt_date,
                "outcome": outcome,
                "confirmed_at": confirmed_at,
                "source": source,
            }
        )
    return attempts


def maintenance_window_from_legacy(
    fields: dict[str, Any] | None,
    *,
    source: str = "migration",
) -> dict[str, Any]:
    """Convert the historical Planned Date + Done? pair without guessing success.

    A legacy ``P`` is an attempted, unsuccessful MW, so its date belongs in
    attempt history and is no longer a current plan. A dated ``?`` becomes a
    real plan because the explicit date is stronger evidence than the old
    visibility flag; Zeus will request an outcome after it passes.
    """

    values = fields or {}
    planned_date = _date_text(values.get("Planned Date"))
    code = _legacy_code(values.get("Done?"))
    attempts: list[dict[str, Any]] = []
    review_required = False

    if code == "Y":
        status = STATUS_COMPLETED
        if planned_date:
            attempts.append(
                {
                    "date": planned_date,
                    "outcome": "completed",
                    "confirmed_at": None,
                    "source": source,
                }
            )
        else:
            review_required = True
    elif code == "P":
        status = STATUS_INCOMPLETE
        if planned_date:
            attempts.append(
                {
                    "date": planned_date,
                    "outcome": "incomplete",
                    "confirmed_at": None,
                    "source": source,
                }
            )
        planned_date = None
    elif planned_date:
        status = STATUS_PLANNED
    elif code == "?":
        status = STATUS_NO_VISIBILITY
    else:
        status = STATUS_UNPLANNED

    return {
        "schema_version": MAINTENANCE_WINDOW_SCHEMA_VERSION,
        "status": status,
        "date": planned_date,
        "attempts": attempts,
        "review_required": review_required,
    }


def normalize_maintenance_window(
    value: Any,
    *,
    legacy_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        return maintenance_window_from_legacy(legacy_fields)

    prepared = deepcopy(value)
    status = str(prepared.get("status") or "").strip().lower()
    if status not in MAINTENANCE_WINDOW_STATUSES:
        return maintenance_window_from_legacy(legacy_fields)
    planned_date = _date_text(prepared.get("date"))
    attempts = _normalize_attempts(prepared.get("attempts"))
    if status != STATUS_COMPLETED and planned_date is not None:
        # A current calendar date is stronger than every undated state. This
        # also repairs hand-edited structured records without hiding the date.
        status = STATUS_PLANNED
    elif status == STATUS_PLANNED and planned_date is None:
        status = STATUS_UNPLANNED
    review_required = bool(
        status == STATUS_COMPLETED
        and planned_date is None
        and not any(attempt.get("outcome") == "completed" for attempt in attempts)
    )
    return {
        "schema_version": MAINTENANCE_WINDOW_SCHEMA_VERSION,
        "status": status,
        "date": planned_date,
        "attempts": attempts,
        "review_required": review_required,
    }


def legacy_projection(value: dict[str, Any]) -> dict[str, Any]:
    prepared = normalize_maintenance_window(value)
    status = prepared["status"]
    return {
        "Planned Date": prepared.get("date") if status in {STATUS_PLANNED, STATUS_COMPLETED} else None,
        "Done?": STATUS_TO_LEGACY_CODE[status],
    }


def maintenance_window_for_local(local: dict[str, Any] | None) -> dict[str, Any]:
    """Resolve the structured record while accepting one last legacy mutation path.

    Zeus 3.1.6 writes both the structured value and its two generated legacy
    projections. If an older importer or script changes those projections,
    the mismatch is intentionally treated as an incoming compatibility edit.
    """

    values = local or {}
    fields = values.get("fields") if isinstance(values.get("fields"), dict) else {}
    structured = values.get("maintenance_window")
    if not isinstance(structured, dict):
        return maintenance_window_from_legacy(fields)

    prepared = normalize_maintenance_window(structured, legacy_fields=fields)
    expected = legacy_projection(prepared)
    actual = {
        "Planned Date": _date_text(fields.get("Planned Date")),
        "Done?": _legacy_code(fields.get("Done?")),
    }
    if actual != expected:
        migrated = maintenance_window_from_legacy(fields, source="legacy-edit")
        migrated["attempts"] = [
            *_normalize_attempts(prepared.get("attempts")),
            *_normalize_attempts(migrated.get("attempts")),
        ]
        migrated["attempts"] = _normalize_attempts(migrated["attempts"])
        return migrated
    return prepared


def synchronize_maintenance_window(local: dict[str, Any]) -> dict[str, Any]:
    prepared = deepcopy(local)
    fields = prepared.setdefault("fields", {})
    window = maintenance_window_for_local(prepared)
    prepared["schema_version"] = LOCAL_SCHEMA_VERSION
    prepared["maintenance_window"] = window
    fields.update(legacy_projection(window))
    return prepared


def maintenance_window_summary(
    local: dict[str, Any] | None,
    *,
    today: date | None = None,
) -> dict[str, Any]:
    window = maintenance_window_for_local(local)
    status = window["status"]
    planned_date = _date_text(window.get("date"))
    current_day = today or local_today()
    parsed = parse_date(planned_date)
    confirmation_required = bool(
        status == STATUS_PLANNED and parsed is not None and parsed < current_day
    )
    if status == STATUS_COMPLETED:
        display = STATUS_LABELS[STATUS_COMPLETED]
        color = "green"
    elif planned_date:
        display = planned_date
        color = "red" if confirmation_required else None
    elif status == STATUS_INCOMPLETE:
        display = STATUS_LABELS[status]
        color = "yellow"
    elif status == STATUS_NO_VISIBILITY:
        display = STATUS_LABELS[status]
        color = "grey"
    else:
        display = STATUS_LABELS[STATUS_UNPLANNED]
        color = "yellow"
    return {
        "schemaVersion": int(window.get("schema_version") or 1),
        "status": status,
        "date": planned_date,
        "display": display,
        "color": color,
        "confirmationRequired": confirmation_required,
        "attempts": deepcopy(window.get("attempts") or []),
        "reviewRequired": bool(window.get("review_required")),
    }


def set_maintenance_window_plan(
    local: dict[str, Any],
    planned_date: Any,
) -> dict[str, Any]:
    parsed = parse_date(planned_date)
    if parsed is None:
        raise ValueError("Maintenance Window date must be a recognizable calendar date")
    prepared = synchronize_maintenance_window(local)
    window = prepared["maintenance_window"]
    window["status"] = STATUS_PLANNED
    window["date"] = parsed.isoformat()
    window["review_required"] = False
    prepared["fields"].update(legacy_projection(window))
    return prepared


def set_maintenance_window_status(
    local: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    normalized = str(status or "").strip().lower()
    if normalized not in {
        STATUS_UNPLANNED,
        STATUS_INCOMPLETE,
        STATUS_COMPLETED,
        STATUS_NO_VISIBILITY,
    }:
        raise ValueError("Maintenance Window status is invalid")
    prepared = synchronize_maintenance_window(local)
    window = prepared["maintenance_window"]
    window["status"] = normalized
    if normalized != STATUS_COMPLETED:
        window["date"] = None
    window["review_required"] = normalized == STATUS_COMPLETED and not window.get("date")
    prepared["fields"].update(legacy_projection(window))
    return prepared


def confirm_maintenance_window(
    local: dict[str, Any],
    *,
    expected_date: Any,
    successful: bool,
    timestamp: str | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    prepared = synchronize_maintenance_window(local)
    window = prepared["maintenance_window"]
    current_date = _date_text(window.get("date"))
    expected = _date_text(expected_date)
    if window.get("status") != STATUS_PLANNED or current_date is None:
        raise ValueError("This ticket no longer has a pending Maintenance Window decision")
    if expected != current_date:
        raise ValueError("The Maintenance Window date changed before it was confirmed")
    if parse_date(current_date) >= local_today():
        raise ValueError("The Maintenance Window can be confirmed only after its date has passed")

    outcome = "completed" if successful else "incomplete"
    window["attempts"] = _normalize_attempts(
        [
            *(window.get("attempts") or []),
            {
                "date": current_date,
                "outcome": outcome,
                "confirmed_at": timestamp or iso_now(),
                "source": source,
            },
        ]
    )
    window["status"] = STATUS_COMPLETED if successful else STATUS_INCOMPLETE
    window["date"] = current_date if successful else None
    window["review_required"] = False
    prepared["fields"].update(legacy_projection(window))
    return prepared
