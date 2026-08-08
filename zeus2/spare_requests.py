from __future__ import annotations

import base64
import json
import re
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, TYPE_CHECKING
from zoneinfo import ZoneInfo

from .utils import atomic_write_json, iso_now, json_dumps, load_json, parse_datetime

if TYPE_CHECKING:
    from .store import ZeusStore


SPARE_REQUEST_MARKER = "<!-- ZEUS_SPARE_REQUEST_V1:"
SPARE_REQUEST_SCHEMA_VERSION = 1
ECUADOR_TIMEZONE = ZoneInfo("America/Guayaquil")
TT_PATTERN = re.compile(r"(?<!\d)(\d{8})(?!\d)")
SPARE_SR_PATTERN = re.compile(r"\bSR\s*[:#-]?\s*(\d{7})(?!\d)", re.IGNORECASE)
RMA_PATTERN = re.compile(r"\b(C\d{10})\b", re.IGNORECASE)
REQUEST_ID_PATTERN = re.compile(r"(?<!\d)(\d{12})(?!\d)")
INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

REQUEST_PROFILE_FILENAME = "spare_request_profiles.json"
BOM_CATALOG_FILENAME = "spare_request_boms.json"


class SpareRequestError(ValueError):
    pass


def normalize_tt(value: Any) -> str:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{8}", text):
        raise SpareRequestError("TT must contain exactly eight digits")
    return text


def normalize_request_id(value: Any) -> str:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{12}", text):
        raise SpareRequestError("Request ID must use YYMMDDHHmmss")
    try:
        datetime.strptime(text, "%y%m%d%H%M%S")
    except ValueError as exc:
        raise SpareRequestError("Request ID is not a valid Ecuador date and time") from exc
    return text


def normalize_spare_sr(value: Any, *, required: bool = False) -> str | None:
    text = str(value or "").strip()
    if not text and not required:
        return None
    match = re.fullmatch(r"(?:SR\s*)?(\d{7})", text, re.IGNORECASE)
    if not match:
        raise SpareRequestError("Spare SR must use SR followed by exactly seven digits")
    return f"SR{match.group(1)}"


def normalize_rma(value: Any, *, required: bool = False) -> str | None:
    text = str(value or "").strip().upper()
    if not text and not required:
        return None
    if not re.fullmatch(r"C\d{10}", text):
        raise SpareRequestError("RMA must use C followed by exactly ten digits")
    return text


def _optional_text(value: Any, *, maximum: int = 500) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > maximum:
        raise SpareRequestError(f"Text values cannot exceed {maximum} characters")
    return text


def _required_text(value: Any, label: str, *, maximum: int = 500) -> str:
    text = _optional_text(value, maximum=maximum)
    if text is None:
        raise SpareRequestError(f"{label} is required")
    return text


def _safe_filename_component(value: Any, *, fallback: str = "NA") -> str:
    text = INVALID_FILENAME.sub(" ", str(value or "")).strip().strip(".")
    text = re.sub(r"\s+", " ", text)
    return text or fallback


def _profile_contact(value: Any, label: str) -> dict[str, str | None]:
    candidate = value if isinstance(value, dict) else {}
    return {
        "name": _required_text(candidate.get("name"), f"{label} name"),
        "email": _optional_text(candidate.get("email"), maximum=320),
        "phone": _optional_text(candidate.get("phone"), maximum=80),
    }


def normalize_profile(value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    initials = re.sub(r"[^A-Za-z0-9]", "", str(candidate.get("clientInitials") or "")).upper()
    if not 1 <= len(initials) <= 8:
        raise SpareRequestError("Client initials must contain 1 to 8 letters or digits")
    return {
        "client_initials": initials,
        "customer_name": _required_text(candidate.get("customerName"), "Customer name"),
        "site_code": _required_text(candidate.get("siteCode"), "Site code", maximum=40).upper(),
        "site_name": _optional_text(candidate.get("siteName"), maximum=160),
        "site_address": _required_text(candidate.get("siteAddress"), "Site address", maximum=1000),
        "cloud": _required_text(candidate.get("cloud"), "Cloud", maximum=120),
        "requester": _profile_contact(candidate.get("requester"), "Requester"),
        "contact": _profile_contact(candidate.get("contact"), "Customer contact"),
    }


def normalize_request_lines(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise SpareRequestError("Add at least one BOM to the request")
    lines: list[dict[str, Any]] = []
    for index, raw in enumerate(value, start=1):
        if not isinstance(raw, dict):
            raise SpareRequestError(f"Request line {index} must be an object")
        bom = _required_text(raw.get("bom"), f"Request line {index} BOM", maximum=120)
        raw_amount = raw.get("amount", 1)
        try:
            if isinstance(raw_amount, bool):
                raise ValueError
            amount = int(raw_amount)
        except (TypeError, ValueError) as exc:
            raise SpareRequestError(f"Request line {index} amount must be a whole number") from exc
        if (
            isinstance(raw_amount, float)
            and not raw_amount.is_integer()
        ) or (
            isinstance(raw_amount, str)
            and not re.fullmatch(r"\d+", raw_amount.strip())
        ):
            raise SpareRequestError(f"Request line {index} amount must be a whole number")
        if not 1 <= amount <= 1000:
            raise SpareRequestError(f"Request line {index} amount must be between 1 and 1000")
        description = _required_text(
            raw.get("description") or raw.get("part"),
            f"Request line {index} description",
            maximum=1000,
        )
        lines.append(
            {
                "bom": bom,
                "amount": amount,
                "description": description,
                "part": _optional_text(raw.get("part"), maximum=300) or description,
                "model": _optional_text(raw.get("model"), maximum=300),
                "device": _optional_text(raw.get("device"), maximum=300),
                "slot": _optional_text(raw.get("slot"), maximum=300),
                "faulty_sn": _optional_text(raw.get("faultySn") or raw.get("faulty_sn"), maximum=300),
                "report_date": _optional_text(raw.get("reportDate") or raw.get("report_date"), maximum=100),
                "source_device_number": raw.get("deviceNumber"),
                "source_part_number": raw.get("partNumber"),
            }
        )
    return lines


def request_description(line: dict[str, Any]) -> str:
    explicit = str(line.get("description") or "").strip()
    details = " ".join(
        str(line.get(key) or "").strip()
        for key in ("model", "device", "slot")
        if str(line.get(key) or "").strip()
    )
    part = str(line.get("part") or explicit).strip()
    return f"{part} for {details}".strip() if details else part


def request_filename(
    request_id: str,
    tt: str,
    profile: dict[str, Any],
    lines: Iterable[dict[str, Any]],
) -> str:
    tokens = []
    for line in lines:
        amount = int(line.get("amount") or 1)
        bom = _safe_filename_component(line.get("bom"))
        tokens.append(f"{amount}x{bom}" if amount != 1 else bom)
    segments = [
        "SP",
        _safe_filename_component(profile.get("client_initials")),
        _safe_filename_component(profile.get("site_code")),
        _safe_filename_component(profile.get("cloud")),
        " ".join(tokens),
        normalize_tt(tt),
        normalize_request_id(request_id),
    ]
    return "–".join(segments) + ".xlsx"


def request_subject(
    request_id: str,
    tt: str,
    lines: Iterable[dict[str, Any]],
) -> str:
    prepared = list(lines)
    first = request_description(prepared[0]) if prepared else "Spare part"
    more = f" +{len(prepared) - 1} more" if len(prepared) > 1 else ""
    return (
        f"[TT {normalize_tt(tt)}] [SPARE PARTS REQUEST] "
        f"{normalize_request_id(request_id)} {first}{more}"
    ).strip()


def next_request_id(existing: Iterable[str] = (), *, now: datetime | None = None) -> str:
    occupied = set(existing)
    current = now or datetime.now(ECUADOR_TIMEZONE)
    if current.tzinfo is None:
        current = current.replace(tzinfo=ECUADOR_TIMEZONE)
    else:
        current = current.astimezone(ECUADOR_TIMEZONE)
    for offset in range(3660):
        candidate = (current + timedelta(seconds=offset)).strftime("%y%m%d%H%M%S")
        if candidate not in occupied:
            return candidate
    raise SpareRequestError("Zeus could not allocate a unique request timestamp")


def _new_item(request_id: str, ordinal: int, line: dict[str, Any]) -> dict[str, Any]:
    return {
        "item_id": f"{request_id}-{ordinal:04d}",
        "ordinal": ordinal,
        "requested_bom": line["bom"],
        "requested_description": line["description"],
        "part": line.get("part"),
        "model": line.get("model"),
        "device": line.get("device"),
        "slot": line.get("slot"),
        "faulty_sn": line.get("faulty_sn"),
        "report_date": line.get("report_date"),
        "source_device_number": line.get("source_device_number"),
        "source_part_number": line.get("source_part_number"),
        "rma": None,
        "delivered_bom": None,
        "new_sn": None,
        "attendance_confirmed_at": None,
        "attendance_source": None,
        "dispatch_at": None,
        "dispatch_source": None,
        "return_condition": None,
        "return_exported_at": None,
        "return_export_filename": None,
        "return_batch_id": None,
        "rt": None,
        "warehouse_candidate_at": None,
        "warehouse_message_key": None,
        "conflicts": [],
        "notes": None,
    }


def create_request_record(
    *,
    request_id: str,
    tt: str,
    source: str,
    profile: dict[str, Any],
    lines: list[dict[str, Any]],
    export_path: Path | None,
    subject: str,
    created_at: str | None = None,
) -> dict[str, Any]:
    identifier = normalize_request_id(request_id)
    ticket_id = normalize_tt(tt)
    normalized_source = str(source or "manual").strip().lower()
    if normalized_source not in {"ticket", "manual", "recovered"}:
        raise SpareRequestError("Request source must be ticket, manual, or recovered")
    timestamp = created_at or iso_now()
    items: list[dict[str, Any]] = []
    ordinal = 1
    for line in lines:
        for _ in range(int(line["amount"])):
            items.append(_new_item(identifier, ordinal, line))
            ordinal += 1
    return {
        "schema_version": SPARE_REQUEST_SCHEMA_VERSION,
        "request_id": identifier,
        "tt": ticket_id,
        "source": normalized_source,
        "tt_editable": normalized_source == "manual",
        "spare_sr": None,
        "profile": deepcopy(profile),
        "request_lines": deepcopy(lines),
        "items": items,
        "export": {
            "request_filename": export_path.name if export_path else None,
            "request_path": str(export_path) if export_path else None,
            "subject": subject,
            "created_at": timestamp,
            "revisions": (
                [{"filename": export_path.name, "path": str(export_path), "created_at": timestamp}]
                if export_path
                else []
            ),
            "returns": [],
        },
        "email": {
            "total_received": 0,
            "total_sent": 0,
            "last_activity_at": None,
            "seen_message_keys": [],
            "messages": [],
        },
        "conflicts": [],
        "history": [
            {
                "timestamp": timestamp,
                "action": "request-created" if export_path else "request-imported",
                "summary": {"source": normalized_source, "items": len(items)},
            }
        ],
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def item_status(item: dict[str, Any], request: dict[str, Any]) -> str:
    if item.get("warehouse_candidate_at"):
        return "awaiting_user_confirmation"
    if item.get("return_exported_at"):
        return "awaiting_warehouse"
    if item.get("dispatch_at"):
        return "dispatched"
    if item.get("rma"):
        return "awaiting_dispatch"
    attended = bool(item.get("attendance_confirmed_at") or request.get("spare_sr"))
    return "awaiting_stock" if attended else "awaiting_confirmation"


def lifecycle_color(item: dict[str, Any], request: dict[str, Any]) -> str:
    if item.get("dispatch_at"):
        return "green"
    if item.get("attendance_confirmed_at") or request.get("spare_sr"):
        return "grey"
    return "black"


def dispatch_age_days(item: dict[str, Any], *, now: datetime | None = None) -> int | None:
    dispatched = parse_datetime(item.get("dispatch_at"))
    if dispatched is None:
        return None
    if dispatched.tzinfo is None:
        dispatched = dispatched.replace(tzinfo=ECUADOR_TIMEZONE)
    else:
        dispatched = dispatched.astimezone(ECUADOR_TIMEZONE)
    current = now or datetime.now(ECUADOR_TIMEZONE)
    if current.tzinfo is None:
        current = current.replace(tzinfo=ECUADOR_TIMEZONE)
    else:
        current = current.astimezone(ECUADOR_TIMEZONE)
    return max(0, (current.date() - dispatched.date()).days)


def aging_color(age_days: int | None) -> str | None:
    if age_days is None:
        return None
    if age_days >= 20:
        return "red"
    if age_days >= 15:
        return "yellow"
    return None


def request_overall_status(request: dict[str, Any]) -> str:
    statuses = [item_status(item, request) for item in request.get("items", [])]
    if not statuses:
        return "empty"
    if len(set(statuses)) == 1:
        return statuses[0]
    dispatched = sum(status in {"dispatched", "awaiting_warehouse", "awaiting_user_confirmation"} for status in statuses)
    confirmed = sum(status not in {"awaiting_confirmation", "awaiting_stock"} for status in statuses)
    if dispatched:
        return f"partial_dispatch_{dispatched}_of_{len(statuses)}"
    return f"partial_confirmation_{confirmed}_of_{len(statuses)}"


def _display(value: Any) -> str:
    if value in (None, ""):
        return "—"
    return str(value).replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>")


def _encode_request(request: dict[str, Any]) -> str:
    return base64.b64encode(json_dumps(request, indent=None).encode("utf-8")).decode("ascii")


def decode_request_record(line: str, path: Path) -> dict[str, Any]:
    if not line.startswith(SPARE_REQUEST_MARKER) or not line.rstrip().endswith(" -->"):
        raise SpareRequestError(f"Spare-request marker is missing or invalid: {path}")
    encoded = line[len(SPARE_REQUEST_MARKER) : line.rfind(" -->")].strip()
    try:
        value = json.loads(base64.b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SpareRequestError(f"Spare-request payload is invalid: {path}") from exc
    if not isinstance(value, dict):
        raise SpareRequestError(f"Spare-request record is not an object: {path}")
    return value


def render_request_markdown(request: dict[str, Any]) -> str:
    lines = [
        f"{SPARE_REQUEST_MARKER}{_encode_request(request)} -->",
        "",
        f"# Spare Request {request['request_id']}",
        "",
        f"- Original TT: **{_display(request.get('tt'))}**",
        f"- Spare SR: **{_display(request.get('spare_sr'))}**",
        f"- Status: **{_display(request_overall_status(request))}**",
        f"- Source: {_display(request.get('source'))}",
        f"- Export: {_display(request.get('export', {}).get('request_filename'))}",
        f"- Subject: {_display(request.get('export', {}).get('subject'))}",
        "",
        "## Profile snapshot",
        "",
        "| Field | Value |",
        "|---|---|",
    ]
    profile = request.get("profile", {})
    for label, key in (
        ("Client", "customer_name"),
        ("Client initials", "client_initials"),
        ("Site", "site_code"),
        ("Address", "site_address"),
        ("Cloud", "cloud"),
    ):
        lines.append(f"| {label} | {_display(profile.get(key))} |")
    lines.extend(
        [
            "",
            "## Items",
            "",
            "| Item | Requested BOM | Delivered BOM | RMA | New SN | State | Dispatch age |",
            "|---|---|---|---|---|---|---|",
        ]
    )
    for item in request.get("items", []):
        age = dispatch_age_days(item)
        lines.append(
            "| "
            + " | ".join(
                (
                    _display(item.get("item_id")),
                    _display(item.get("requested_bom")),
                    _display(item.get("delivered_bom")),
                    _display(item.get("rma")),
                    _display(item.get("new_sn")),
                    _display(item_status(item, request)),
                    _display(f"{age} days" if age is not None else None),
                )
            )
            + " |"
        )
    email = request.get("email", {})
    lines.extend(
        [
            "",
            "## Email summary",
            "",
            f"- Received: **{int(email.get('total_received') or 0)}**",
            f"- Sent: **{int(email.get('total_sent') or 0)}**",
            f"- Last activity: {_display(email.get('last_activity_at'))}",
        ]
    )
    for message in email.get("messages", []):
        lines.extend(
            [
                "",
                f"### {_display(message.get('timestamp'))} — {_display(message.get('direction'))}",
                "",
                f"**Subject:** {_display(message.get('subject'))}",
                "",
            ]
        )
        body = str(message.get("latest_reply_body") or message.get("body") or "")
        lines.extend(f"    {line}" if line else "    " for line in body.splitlines())
    lines.extend(["", "## History", ""])
    for event in request.get("history", []):
        lines.append(
            f"- {_display(event.get('timestamp'))} — **{_display(event.get('action'))}**: "
            f"{_display(json_dumps(event.get('summary') or {}, indent=None))}"
        )
    return "\n".join(lines).rstrip() + "\n"


def validate_request_record(request: dict[str, Any], directory_name: str | None = None) -> None:
    if request.get("schema_version") != SPARE_REQUEST_SCHEMA_VERSION:
        raise SpareRequestError("Unsupported spare-request schema")
    request_id = normalize_request_id(request.get("request_id"))
    if directory_name is not None and request_id != directory_name:
        raise SpareRequestError(
            f"Spare-request directory {directory_name!r} contains ID {request_id!r}"
        )
    normalize_tt(request.get("tt"))
    normalize_spare_sr(request.get("spare_sr"))
    if request.get("source") not in {"ticket", "manual", "recovered"}:
        raise SpareRequestError(f"Spare Request {request_id} has an invalid source")
    items = request.get("items")
    if not isinstance(items, list) or not items:
        raise SpareRequestError(f"Spare Request {request_id} must contain active items")
    item_ids: set[str] = set()
    rmas: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise SpareRequestError(f"Spare Request {request_id} contains an invalid item")
        item_id = str(item.get("item_id") or "")
        if not item_id.startswith(f"{request_id}-") or item_id in item_ids:
            raise SpareRequestError(f"Spare Request {request_id} contains a duplicate or invalid item ID")
        item_ids.add(item_id)
        _required_text(item.get("requested_bom"), "Requested BOM", maximum=120)
        rma = normalize_rma(item.get("rma"))
        if rma and rma in rmas:
            raise SpareRequestError(f"Spare Request {request_id} contains duplicate RMA {rma}")
        if rma:
            rmas.add(rma)
        if not isinstance(item.get("conflicts", []), list):
            raise SpareRequestError(f"Spare Request {request_id} has invalid conflicts")
    email = request.get("email", {})
    if not isinstance(email.get("messages", []), list):
        raise SpareRequestError(f"Spare Request {request_id} has invalid email messages")


def profiles_path(config_home: Path) -> Path:
    return config_home / REQUEST_PROFILE_FILENAME


def bom_catalog_path(config_home: Path) -> Path:
    return config_home / BOM_CATALOG_FILENAME


def load_reference_data(config_home: Path) -> dict[str, Any]:
    profiles = load_json(
        profiles_path(config_home),
        {"schema_version": 1, "customers": [], "sites": [], "requesters": []},
    )
    boms = load_json(
        bom_catalog_path(config_home),
        {"schema_version": 1, "boms": []},
    )
    if not isinstance(profiles, dict) or not isinstance(boms, dict):
        raise SpareRequestError("Spare-request reference data is invalid")
    return {
        "schemaVersion": 1,
        "customers": deepcopy(profiles.get("customers") or []),
        "sites": deepcopy(profiles.get("sites") or []),
        "requesters": deepcopy(profiles.get("requesters") or []),
        "boms": deepcopy(boms.get("boms") or []),
    }


def _validate_reference_list(values: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise SpareRequestError(f"{label} must be a list")
    result: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    for index, value in enumerate(values, start=1):
        if not isinstance(value, dict):
            raise SpareRequestError(f"{label} row {index} must be an object")
        identifier = _required_text(value.get("id"), f"{label} row {index} ID", maximum=100)
        if identifier in identifiers:
            raise SpareRequestError(f"{label} contains duplicate ID {identifier}")
        identifiers.add(identifier)
        result.append(deepcopy(value))
    return result


def save_reference_data(config_home: Path, value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    customers = _validate_reference_list(candidate.get("customers", []), "Customers")
    sites = _validate_reference_list(candidate.get("sites", []), "Sites")
    requesters = _validate_reference_list(candidate.get("requesters", []), "Requesters")
    boms = _validate_reference_list(candidate.get("boms", []), "BOM catalog")
    config_home.mkdir(parents=True, exist_ok=True)
    atomic_write_json(
        profiles_path(config_home),
        {
            "schema_version": 1,
            "customers": customers,
            "sites": sites,
            "requesters": requesters,
        },
    )
    atomic_write_json(
        bom_catalog_path(config_home),
        {"schema_version": 1, "boms": boms},
    )
    return load_reference_data(config_home)


def request_history(request: dict[str, Any], action: str, summary: dict[str, Any]) -> None:
    timestamp = iso_now()
    request.setdefault("history", []).append(
        {"timestamp": timestamp, "action": action, "summary": deepcopy(summary)}
    )
    request["updated_at"] = timestamp


def request_by_item_id(
    requests: Iterable[dict[str, Any]], item_id: str
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for request in requests:
        for item in request.get("items", []):
            if item.get("item_id") == item_id:
                return request, item
    return None


def copy_message_for_request(message: dict[str, Any], item_ids: Iterable[str]) -> dict[str, Any]:
    return {
        key: deepcopy(value)
        for key, value in message.items()
        if key
        in {
            "message_key",
            "timestamp",
            "direction",
            "subject",
            "body",
            "html_body",
            "latest_reply_body",
            "quoted_history_hidden",
            "quoted_history_lines",
            "sender",
            "sender_address",
            "source",
        }
    } | {"item_ids": sorted(set(item_ids))}
