from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any

from .maintenance_windows import maintenance_window_for_local
from .utils import parse_date, parse_datetime


@dataclass(frozen=True)
class AgingResult:
    evaluated_on: date
    ticket_age_days: int | None
    ticket_age_color: str | None
    planned_date: date | None
    planned_label: str
    planned_days: int | None
    planned_state: str
    planned_color: str | None
    resolve_by: datetime | None
    resolve_label: str
    resolve_days: int | None
    resolve_state: str
    resolve_color: str | None
    communication_inactivity_days: int | None
    communication_label: str
    communication_color: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _threshold_color(value: int | None, yellow: int, red: int) -> str | None:
    if value is None:
        return None
    if value >= red:
        return "red"
    if value >= yellow:
        return "yellow"
    return None


def calculate_ticket_facts(
    *,
    report_date: Any,
    planned_date: Any,
    resolve_by: Any,
    resolve_by_suspend: Any,
    status: Any,
    last_activity_at: Any,
    config: dict[str, Any],
    today: date | None = None,
) -> AgingResult:
    evaluated = today or datetime.now().astimezone().date()
    thresholds = config.get("aging", {})

    reported = parse_date(report_date)
    age_days = (evaluated - reported).days if reported else None
    age_color = _threshold_color(
        age_days,
        int(thresholds.get("ticket_age_yellow_days", 14)),
        int(thresholds.get("ticket_age_red_days", 30)),
    )

    planned = parse_date(planned_date)
    if planned is None:
        planned_days = None
        planned_label = "Unplanned"
        planned_state = "unplanned"
        planned_color = "amber"
    else:
        planned_days = (planned - evaluated).days
        planned_label = planned.isoformat()
        if planned_days < 0:
            planned_state = "overdue"
            planned_color = "red"
        elif planned_days <= int(thresholds.get("planned_due_soon_days", 2)):
            planned_state = "due_soon"
            planned_color = "yellow"
        else:
            planned_state = "future"
            planned_color = None

    normalized_status = str(status or "").lower()
    suspend_tokens = [
        str(value).lower()
        for value in thresholds.get("resolve_suspend_status_contains", ["suspend"])
    ]
    suspended = any(token and token in normalized_status for token in suspend_tokens)
    parsed_resolve = parse_datetime(resolve_by)
    if suspended:
        resolve_label = "Suspended"
        resolve_days = None
        resolve_state = "suspended"
        resolve_color = None
    elif parsed_resolve is None:
        resolve_label = "No deadline"
        resolve_days = None
        resolve_state = "unknown"
        resolve_color = None
    else:
        resolve_days = (parsed_resolve.date() - evaluated).days
        resolve_label = parsed_resolve.date().isoformat()
        if resolve_days < 0:
            resolve_state = "overdue"
            resolve_color = "red"
        elif resolve_days <= int(thresholds.get("resolve_due_soon_days", 3)):
            resolve_state = "due_soon"
            resolve_color = "yellow"
        else:
            resolve_state = "future"
            resolve_color = None

    activity = parse_datetime(last_activity_at)
    if activity is None:
        communication_days = None
        communication_label = "No email found"
        communication_color = "grey"
    else:
        communication_days = (evaluated - activity.date()).days
        communication_label = f"{communication_days} days"
        communication_color = _threshold_color(
            communication_days,
            int(thresholds.get("communication_yellow_days", 3)),
            int(thresholds.get("communication_red_days", 7)),
        )

    return AgingResult(
        evaluated_on=evaluated,
        ticket_age_days=age_days,
        ticket_age_color=age_color,
        planned_date=planned,
        planned_label=planned_label,
        planned_days=planned_days,
        planned_state=planned_state,
        planned_color=planned_color,
        resolve_by=parsed_resolve,
        resolve_label=resolve_label,
        resolve_days=resolve_days,
        resolve_state=resolve_state,
        resolve_color=resolve_color,
        communication_inactivity_days=communication_days,
        communication_label=communication_label,
        communication_color=communication_color,
    )


def aging_for_ticket(
    ticket: dict[str, Any], config: dict[str, Any], *, today: date | None = None
) -> AgingResult:
    upstream = ticket.get("upstream", {}).get("fields", {})
    local_record = ticket.get("local", {})
    maintenance_window = maintenance_window_for_local(local_record)
    current_planned_date = (
        maintenance_window.get("date")
        if maintenance_window.get("status") == "planned"
        else None
    )
    email = ticket.get("email", {})
    return calculate_ticket_facts(
        report_date=upstream.get("Report Date"),
        planned_date=current_planned_date,
        resolve_by=upstream.get("ResolveBy"),
        resolve_by_suspend=upstream.get("Resolve By Suspend"),
        status=upstream.get("Status"),
        last_activity_at=email.get("last_activity_at"),
        config=config,
        today=today,
    )


def report_sort_key(ticket: dict[str, Any], config: dict[str, Any]) -> tuple[Any, ...]:
    facts = aging_for_ticket(ticket, config)
    if facts.planned_state == "overdue":
        planned_group = 0
        planned_value = facts.planned_days or 0  # more negative first
    elif facts.planned_state == "unplanned":
        planned_group = 1
        planned_value = 0
    else:
        planned_group = 2
        planned_value = facts.planned_days if facts.planned_days is not None else 10**9
    inactivity = facts.communication_inactivity_days
    no_email_group = 1 if inactivity is None else 0
    inactivity_sort = 0 if inactivity is None else -inactivity
    return (
        planned_group,
        planned_value,
        no_email_group,
        inactivity_sort,
        -int(ticket["ticket_id"]),
    )


# Compatibility wrapper for scripts written against the first preview.  The
# severity/status fabricated deadline was deliberately removed in 2.0.2.
def calculate_aging(
    report_date: Any,
    severity: Any,
    status: Any,
    config: dict[str, Any],
    *,
    today: date | None = None,
) -> AgingResult:
    return calculate_ticket_facts(
        report_date=report_date,
        planned_date=None,
        resolve_by=None,
        resolve_by_suspend=None,
        status=status,
        last_activity_at=None,
        config=config,
        today=today,
    )
