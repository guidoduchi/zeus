from __future__ import annotations

import json
import re
from copy import deepcopy
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

from .fault_tags import fault_tag_history
from .spare_request_excel import archived_rma_values, read_archived_items
from .spare_requests import (
    ECUADOR_TIMEZONE,
    REQUEST_ID_PATTERN,
    RMA_PATTERN,
    SPARE_SR_PATTERN,
    TT_PATTERN,
    copy_message_for_request,
    lifecycle_effect_suppressed,
    normalize_rma,
    normalize_spare_sr,
    request_history,
)
from .utils import atomic_write_text, iso_now, json_dumps, parse_datetime


TT_TOKEN = re.compile(r"\bTT\s*(?:[:#-]\s*)?(\d{8})(?!\d)", re.IGNORECASE)
RT_TOKEN = re.compile(r"\b(RT\d{8})\b", re.IGNORECASE)
FAULT_TAG_TOKEN = re.compile(r"\b(FT-\d{12})\b", re.IGNORECASE)
SPARE_WORDS = re.compile(
    r"spare\s*(?:parts?)?\s*(?:request)?|fault\s*tag|other\s+edi|delivery\s+requirement",
    re.IGNORECASE,
)
class _TableParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._table_depth = 0
        self._table: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.casefold()
        if lowered == "table":
            self._table_depth += 1
            if self._table is None:
                self._table = []
        elif lowered == "tr" and self._table is not None and self._row is None:
            self._row = []
        elif lowered in {"td", "th"} and self._row is not None and self._cell is None:
            self._cell = []
        elif lowered == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.casefold()
        if lowered in {"td", "th"} and self._cell is not None and self._row is not None:
            value = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            self._row.append(value)
            self._cell = None
        elif lowered == "tr" and self._row is not None and self._table is not None:
            if any(self._row):
                self._table.append(self._row)
            self._row = None
        elif lowered == "table" and self._table is not None:
            self._table_depth -= 1
            if self._table_depth <= 0:
                if self._table:
                    self.tables.append(self._table)
                self._table = None
                self._table_depth = 0


def html_tables(value: Any) -> list[list[list[str]]]:
    text = str(value or "")
    if not text:
        return []
    parser = _TableParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        return []
    return parser.tables


def _label(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _header_index(row: list[str], aliases: dict[str, set[str]]) -> dict[str, int]:
    normalized = [_label(value) for value in row]
    result: dict[str, int] = {}
    for name, candidates in aliases.items():
        for index, value in enumerate(normalized):
            if value in candidates:
                result[name] = index
                break
    return result


def _value(row: list[str], index: int | None) -> str:
    if index is None or index >= len(row):
        return ""
    return str(row[index] or "").strip()


def _message_text(message: dict[str, Any]) -> str:
    return "\n".join(
        str(message.get(key) or "") for key in ("subject", "body", "html_body")
    )


def _tt_from_message(message: dict[str, Any]) -> str | None:
    body = "\n".join(str(message.get(key) or "") for key in ("body", "html_body"))
    matches = TT_TOKEN.findall(body)
    if matches:
        return matches[-1]
    subject_matches = TT_TOKEN.findall(str(message.get("subject") or ""))
    return subject_matches[-1] if subject_matches else None


def _request_id_from_message(message: dict[str, Any]) -> str | None:
    subject = str(message.get("subject") or "")
    for match in REQUEST_ID_PATTERN.finditer(subject):
        # Fault Tags intentionally use a separate namespace with the same
        # twelve timestamp digits. Never let ``FT-YYMMDDHHmmss`` masquerade as
        # an outbound request ID when both happen to be allocated that second.
        if subject[max(0, match.start() - 3) : match.start()].casefold() == "ft-":
            continue
        return match.group(1)
    return None


def _trusted_sender(value: Any) -> str:
    return str(value or "").strip().casefold()


def _trusted_domain(value: Any) -> str:
    domain = str(value or "").strip().casefold()
    if not domain:
        return ""
    return domain if domain.startswith("@") else f"@{domain}"


def spare_mail_trust(config: dict[str, Any]) -> dict[str, str]:
    email = config.get("email", {}) if isinstance(config, dict) else {}
    return {
        "request_confirmation_sender": _trusted_sender(
            email.get("request_confirmation_sender")
        ),
        "dispatch_notification_sender": _trusted_sender(
            email.get("dispatch_notification_sender")
        ),
        "warehouse_sender_domain": _trusted_domain(
            email.get("warehouse_sender_domain")
        ),
    }


def parse_request_confirmation(
    message: dict[str, Any], trusted_sender: str
) -> dict[str, Any] | None:
    expected_sender = _trusted_sender(trusted_sender)
    if not expected_sender or sender_address(message) != expected_sender:
        return None
    aliases = {
        "spare_sr": {"sr", "spare sr", "spare parts sr"},
        "rma": {"rma", "rma number"},
        "bom": {"item", "bom", "bom code", "applied item"},
        "description": {"item description", "description", "goods description"},
    }
    assignments: list[dict[str, str | None]] = []
    for table in html_tables(message.get("html_body")):
        for header_row, header in enumerate(table):
            mapping = _header_index(header, aliases)
            if not {"spare_sr", "rma", "bom"}.issubset(mapping):
                continue
            for row in table[header_row + 1 :]:
                try:
                    spare_sr = normalize_spare_sr(_value(row, mapping.get("spare_sr")))
                    rma = normalize_rma(_value(row, mapping.get("rma")))
                except ValueError:
                    continue
                bom = _value(row, mapping.get("bom"))
                if not spare_sr or not rma or not bom:
                    continue
                assignments.append(
                    {
                        "spare_sr": spare_sr,
                        "rma": rma,
                        "requested_bom": bom,
                        "description": _value(row, mapping.get("description")) or None,
                    }
                )
            if assignments:
                break
        if assignments:
            break
    if not assignments:
        text = str(message.get("body") or "")
        fallback = re.compile(
            r"\b(SR\d{7})\b\s+[|;,:\s]+\b(C\d{10})\b\s+[|;,:\s]+([A-Za-z0-9._/-]+)",
            re.IGNORECASE,
        )
        for match in fallback.finditer(text):
            assignments.append(
                {
                    "spare_sr": normalize_spare_sr(match.group(1)),
                    "rma": normalize_rma(match.group(2)),
                    "requested_bom": match.group(3),
                    "description": None,
                }
            )
    if not assignments:
        return None
    return {
        "kind": "confirmation",
        "tt": _tt_from_message(message),
        "request_id": _request_id_from_message(message),
        "assignments": assignments,
    }


def parse_dispatch_notification(
    message: dict[str, Any], trusted_sender: str
) -> dict[str, Any] | None:
    expected_sender = _trusted_sender(trusted_sender)
    if not expected_sender or sender_address(message) != expected_sender:
        return None
    aliases = {
        "order_number": {"order no", "order number", "order no order no"},
        "line_number": {"line no", "line number", "order line no"},
        "bom": {"item", "bom", "bom code"},
        "quantity": {"qty", "quantity"},
        "sn": {"sn", "serial no", "serial number"},
        "spare_sr": {"sr", "spare sr", "spare parts sr"},
    }
    assignments: list[dict[str, Any]] = []
    for table in html_tables(message.get("html_body")):
        for header_row, header in enumerate(table):
            mapping = _header_index(header, aliases)
            if not {"order_number", "line_number", "bom"}.issubset(mapping):
                continue
            for row in table[header_row + 1 :]:
                order_number = _value(row, mapping.get("order_number"))
                line_number = _value(row, mapping.get("line_number"))
                spare_sr = None
                try:
                    # The supported dispatch format uses Order No. for the
                    # C-prefixed RMA and Line No. for the order line. Accept
                    # the older inverse layout as a compatibility fallback,
                    # but never infer an RMA from an arbitrary numeric line.
                    rma = normalize_rma(order_number, required=True)
                except ValueError:
                    try:
                        spare_sr = normalize_spare_sr(order_number, required=True)
                        rma = normalize_rma(line_number, required=True)
                    except ValueError:
                        continue
                explicit_spare_sr = _value(row, mapping.get("spare_sr"))
                if explicit_spare_sr:
                    try:
                        spare_sr = normalize_spare_sr(explicit_spare_sr, required=True)
                    except ValueError:
                        continue
                bom = _value(row, mapping.get("bom"))
                if not rma or not bom:
                    continue
                raw_quantity = _value(row, mapping.get("quantity"))
                try:
                    quantity = int(raw_quantity or 1)
                except ValueError:
                    quantity = 1
                assignments.append(
                    {
                        "spare_sr": spare_sr,
                        "rma": rma,
                        "line_number": line_number,
                        "delivered_bom": bom,
                        "quantity": max(1, quantity),
                        "new_sn": _value(row, mapping.get("sn")) or None,
                    }
                )
            if assignments:
                break
        if assignments:
            break
    if not assignments:
        # Outlook sometimes exposes a useful plain-text rendering without the
        # original HTML table.  Require a C-prefixed Order No. and explicit
        # column separators so unrelated prose cannot trigger a dispatch.
        fallback = re.compile(
            r"\b(C\d{10})\b\s*(?:\||\t|;|,|\s{2,})\s*"
            r"([^|\t;,\r\n]+?)\s*(?:\||\t|;|,|\s{2,})\s*"
            r"([A-Za-z0-9._/-]+)\s*(?:\||\t|;|,|\s{2,})\s*"
            r"(\d+)(?:\s*(?:\||\t|;|,|\s{2,})\s*([^|\t;,\r\n]+))?",
            re.IGNORECASE,
        )
        for match in fallback.finditer(str(message.get("body") or "")):
            assignments.append(
                {
                    "spare_sr": None,
                    "rma": normalize_rma(match.group(1), required=True),
                    "line_number": match.group(2).strip(),
                    "delivered_bom": match.group(3).strip(),
                    "quantity": max(1, int(match.group(4))),
                    "new_sn": match.group(5).strip() if match.group(5) else None,
                }
            )
    if not assignments:
        return None
    return {
        "kind": "dispatch",
        "tt": _tt_from_message(message),
        "assignments": assignments,
    }


def sender_address(message: dict[str, Any]) -> str:
    explicit = str(message.get("sender_address") or "").strip().casefold()
    if explicit:
        return explicit
    match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+", str(message.get("sender") or ""), re.IGNORECASE)
    return match.group(0).casefold() if match else ""


def warehouse_candidates(
    message: dict[str, Any], trusted_domain: str
) -> list[dict[str, str | None]]:
    address = sender_address(message)
    expected_domain = _trusted_domain(trusted_domain)
    if not expected_domain or not address.endswith(expected_domain):
        return []
    text = _message_text(message)
    spare_srs = {normalize_spare_sr(match.group(0)) for match in SPARE_SR_PATTERN.finditer(text)}
    rmas = {normalize_rma(match.group(1)) for match in RMA_PATTERN.finditer(text)}
    rt_match = RT_TOKEN.search(text)
    return [
        {"spare_sr": spare_sr, "rma": rma, "rt": rt_match.group(1).upper() if rt_match else None}
        for spare_sr in sorted(value for value in spare_srs if value)
        for rma in sorted(value for value in rmas if value)
    ]


def is_spare_candidate(
    *,
    subject: str,
    sender: str = "",
    sender_address_value: str = "",
    request_ids: Iterable[str] = (),
    spare_srs: Iterable[str] = (),
    rmas: Iterable[str] = (),
    request_confirmation_sender: str = "",
    dispatch_notification_sender: str = "",
    warehouse_sender_domain: str = "",
) -> bool:
    text = f"{subject}\n{sender}\n{sender_address_value}"
    lowered = text.casefold()
    if SPARE_WORDS.search(text):
        return True
    if any(value and value in text for value in request_ids):
        return True
    if any(value and value.casefold() in lowered for value in spare_srs):
        return True
    if any(value and value.casefold() in lowered for value in rmas):
        return True
    address = sender_address_value.casefold()
    trusted_addresses = {
        value
        for value in (
            _trusted_sender(request_confirmation_sender),
            _trusted_sender(dispatch_notification_sender),
        )
        if value
    }
    trusted_domain = _trusted_domain(warehouse_sender_domain)
    return address in trusted_addresses or bool(
        trusted_domain and address.endswith(trusted_domain)
    )


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    values: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("message_key"):
                values.append(value)
    return values


def _write_ndjson(path: Path, values: Iterable[dict[str, Any]]) -> None:
    atomic_write_text(
        path,
        "".join(json_dumps(value, indent=None) + "\n" for value in values),
    )


def _message_time(message: dict[str, Any]) -> datetime:
    value = parse_datetime(message.get("timestamp"))
    if value is None:
        return datetime.min
    return value.replace(tzinfo=None) if value.tzinfo is not None else value


def _conflict(
    request: dict[str, Any],
    *,
    field: str,
    existing: Any,
    incoming: Any,
    message: dict[str, Any],
    item: dict[str, Any] | None = None,
) -> None:
    target = item if item is not None else request
    conflicts = target.setdefault("conflicts", [])
    key = (field, str(existing), str(incoming), str(message.get("message_key")))
    if any(
        (
            value.get("field"),
            str(value.get("existing")),
            str(value.get("incoming")),
            str(value.get("message_key")),
        )
        == key
        for value in conflicts
    ):
        return
    conflicts.append(
        {
            "field": field,
            "existing": existing,
            "incoming": incoming,
            "message_key": message.get("message_key"),
            "detected_at": iso_now(),
            "resolved_at": None,
            "resolution": None,
            "note": None,
        }
    )


def _associate_message(
    request: dict[str, Any], message: dict[str, Any], item_ids: Iterable[str], retained: int
) -> None:
    email = request.setdefault("email", {})
    key = str(message.get("message_key") or "")
    seen = set(email.get("seen_message_keys") or [])
    if key in seen:
        for stored in email.get("messages", []):
            if stored.get("message_key") == key:
                stored["item_ids"] = sorted(
                    set(stored.get("item_ids") or []) | set(item_ids)
                )
        return
    seen.add(key)
    email["seen_message_keys"] = sorted(seen)
    direction = str(message.get("direction") or "").casefold()
    field = "total_received" if direction == "received" else "total_sent"
    email[field] = int(email.get(field) or 0) + 1
    timestamp = message.get("timestamp")
    current = email.get("last_activity_at")
    if timestamp and (not current or _message_time(message) >= _message_time({"timestamp": current})):
        email["last_activity_at"] = timestamp
    if retained:
        messages = list(email.get("messages") or [])
        messages.append(copy_message_for_request(message, item_ids))
        messages.sort(key=_message_time, reverse=True)
        email["messages"] = messages[:retained]
    else:
        email["messages"] = []


def _global_indices(requests: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, tuple[dict[str, Any], dict[str, Any]]]]:
    spare_sr_index: dict[str, dict[str, Any]] = {}
    rma_index: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for request in requests:
        spare_sr = request.get("spare_sr")
        if spare_sr:
            spare_sr_index[str(spare_sr)] = request
        for item in request.get("items", []):
            identities = [item.get("rma"), *list(item.get("rma_aliases") or [])]
            for identity in identities:
                if identity:
                    rma_index[str(identity)] = (request, item)
    return spare_sr_index, rma_index


def _confirmation_request(
    fact: dict[str, Any],
    assignment: dict[str, Any],
    requests: list[dict[str, Any]],
    request_id_index: dict[str, dict[str, Any]],
    spare_sr_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    request_id = fact.get("request_id")
    if request_id and request_id in request_id_index:
        return [request_id_index[request_id]]
    spare_sr = assignment.get("spare_sr")
    if spare_sr and spare_sr in spare_sr_index:
        return [spare_sr_index[spare_sr]]
    tt = fact.get("tt")
    bom = str(assignment.get("requested_bom") or "").casefold()
    return [
        request
        for request in requests
        if (not tt or request.get("tt") == tt)
        and any(
            not item.get("rma")
            and str(item.get("requested_bom") or "").casefold() == bom
            for item in request.get("items", [])
        )
    ]


def _apply_confirmation(
    message: dict[str, Any],
    fact: dict[str, Any],
    requests: list[dict[str, Any]],
    request_id_index: dict[str, dict[str, Any]],
    retained: int,
    archived_rmas: set[str],
) -> tuple[set[str], bool]:
    affected: dict[str, tuple[dict[str, Any], set[str]]] = {}
    matched_all = True
    spare_sr_index, rma_index = _global_indices(requests)
    for assignment in fact.get("assignments", []):
        candidates = _confirmation_request(
            fact, assignment, requests, request_id_index, spare_sr_index
        )
        if assignment.get("rma") in archived_rmas:
            matched_all = False
            for request in candidates:
                _conflict(
                    request,
                    field="rma_archived",
                    existing="completed item",
                    incoming=assignment.get("rma"),
                    message=message,
                )
            continue
        if len(candidates) != 1:
            matched_all = False
            for request in candidates:
                _conflict(
                    request,
                    field="confirmation_match",
                    existing=request.get("request_id"),
                    incoming={
                        "tt": fact.get("tt"),
                        "spare_sr": assignment.get("spare_sr"),
                        "rma": assignment.get("rma"),
                        "bom": assignment.get("requested_bom"),
                    },
                    message=message,
                )
            continue
        request = candidates[0]
        spare_sr = assignment["spare_sr"]
        existing_spare_sr = request.get("spare_sr")
        if existing_spare_sr and existing_spare_sr != spare_sr:
            _conflict(
                request,
                field="spare_sr",
                existing=existing_spare_sr,
                incoming=spare_sr,
                message=message,
            )
            matched_all = False
            continue
        request["spare_sr"] = spare_sr
        spare_sr_index[spare_sr] = request
        rma = assignment["rma"]
        if rma in rma_index:
            existing_request, existing_item = rma_index[rma]
            if existing_request is not request:
                _conflict(
                    request,
                    field="rma",
                    existing=existing_item.get("item_id"),
                    incoming=rma,
                    message=message,
                )
                matched_all = False
                continue
            item = existing_item
            incoming_bom = str(assignment.get("requested_bom") or "").casefold()
            if str(item.get("requested_bom") or "").casefold() != incoming_bom:
                _conflict(
                    request,
                    field="requested_bom",
                    existing=item.get("requested_bom"),
                    incoming=assignment.get("requested_bom"),
                    message=message,
                    item=item,
                )
                matched_all = False
                continue
        else:
            bom = str(assignment.get("requested_bom") or "").casefold()
            item = next(
                (
                    value
                    for value in request.get("items", [])
                    if not value.get("rma")
                    and str(value.get("requested_bom") or "").casefold() == bom
                ),
                None,
            )
            if item is None:
                _conflict(
                    request,
                    field="confirmation_quantity",
                    existing="no unassigned matching item",
                    incoming=assignment,
                    message=message,
                )
                matched_all = False
                continue
            item["rma"] = rma
            rma_index[rma] = (request, item)
        timestamp = message.get("timestamp") or iso_now()
        message_key = message.get("message_key")
        if not lifecycle_effect_suppressed(request, 1, message_key):
            request["request_sent_at"] = timestamp
            request["request_sent_source"] = "email-inferred"
            request["request_sent_message_key"] = message_key
        if not lifecycle_effect_suppressed(item, 2, message_key):
            item["attendance_confirmed_at"] = timestamp
            item["attendance_source"] = "email"
            item["attendance_message_key"] = message_key
        for pending in request.get("items", []):
            if not pending.get("rma"):
                if not lifecycle_effect_suppressed(pending, 2, message_key):
                    pending["attendance_confirmed_at"] = timestamp
                    pending["attendance_source"] = "email"
                    pending["attendance_message_key"] = message_key
        affected.setdefault(request["request_id"], (request, set()))[1].add(item["item_id"])
    for request, item_ids in affected.values():
        _associate_message(request, message, item_ids, retained)
        request_history(
            request,
            "request-confirmation",
            {"messageKey": message.get("message_key"), "items": sorted(item_ids)},
        )
    return set(affected), matched_all


def _apply_dispatch(
    message: dict[str, Any],
    fact: dict[str, Any],
    requests: list[dict[str, Any]],
    retained: int,
) -> tuple[set[str], bool]:
    _, rma_index = _global_indices(requests)
    affected: dict[str, tuple[dict[str, Any], set[str]]] = {}
    matched_all = True
    for assignment in fact.get("assignments", []):
        pair = rma_index.get(str(assignment.get("rma")))
        if pair is None:
            matched_all = False
            continue
        request, item = pair
        if int(assignment.get("quantity") or 1) != 1:
            _conflict(
                request,
                field="dispatch_quantity",
                existing=1,
                incoming=assignment.get("quantity"),
                message=message,
                item=item,
            )
            matched_all = False
        spare_sr = assignment.get("spare_sr")
        if spare_sr and request.get("spare_sr") and request.get("spare_sr") != spare_sr:
            _conflict(
                request,
                field="spare_sr",
                existing=request.get("spare_sr"),
                incoming=spare_sr,
                message=message,
                item=item,
            )
            matched_all = False
            continue
        if spare_sr:
            request["spare_sr"] = request.get("spare_sr") or spare_sr
        incoming_bom = assignment.get("delivered_bom")
        if item.get("delivered_bom") and item.get("delivered_bom") != incoming_bom:
            _conflict(
                request,
                field="delivered_bom",
                existing=item.get("delivered_bom"),
                incoming=incoming_bom,
                message=message,
                item=item,
            )
        else:
            item["delivered_bom"] = incoming_bom
        incoming_sn = assignment.get("new_sn")
        if incoming_sn and item.get("new_sn") and item.get("new_sn") != incoming_sn:
            _conflict(
                request,
                field="new_sn",
                existing=item.get("new_sn"),
                incoming=incoming_sn,
                message=message,
                item=item,
            )
        elif incoming_sn:
            item["new_sn"] = incoming_sn
        message_key = message.get("message_key")
        if not lifecycle_effect_suppressed(item, 3, message_key):
            item["dispatch_at"] = message.get("timestamp") or iso_now()
            item["dispatch_source"] = "email"
            item["dispatch_message_key"] = message_key
        affected.setdefault(request["request_id"], (request, set()))[1].add(item["item_id"])
    for request, item_ids in affected.values():
        _associate_message(request, message, item_ids, retained)
        request_history(
            request,
            "dispatch-notification",
            {"messageKey": message.get("message_key"), "items": sorted(item_ids)},
        )
    return set(affected), matched_all


def _apply_warehouse(
    message: dict[str, Any],
    facts: list[dict[str, Any]],
    requests: list[dict[str, Any]],
    retained: int,
) -> tuple[set[str], bool]:
    _, rma_index = _global_indices(requests)
    affected: dict[str, tuple[dict[str, Any], set[str]]] = {}
    matched_all = True
    for fact in facts:
        pair = rma_index.get(str(fact.get("rma")))
        if pair is None:
            matched_all = False
            continue
        request, item = pair
        if request.get("spare_sr") != fact.get("spare_sr"):
            matched_all = False
            continue
        message_key = message.get("message_key")
        evidence_at = message.get("timestamp") or iso_now()
        evidence = item.setdefault("warehouse_evidence", [])
        if not any(
            str(entry.get("message_key") or "") == str(message_key or "")
            for entry in evidence
            if isinstance(entry, dict)
        ):
            evidence.append(
                {"message_key": message_key, "timestamp": evidence_at, "rt": fact.get("rt")}
            )
        if not lifecycle_effect_suppressed(item, 5, message_key):
            item["warehouse_candidate_at"] = evidence_at
            item["warehouse_message_key"] = message_key
            item["warehouse_confirmation_source"] = "email"
        if fact.get("rt"):
            item["rt"] = fact["rt"]
        affected.setdefault(request["request_id"], (request, set()))[1].add(item["item_id"])
    for request, item_ids in affected.values():
        _associate_message(request, message, item_ids, retained)
        request_history(
            request,
            "warehouse-evidence-received",
            {"messageKey": message.get("message_key"), "items": sorted(item_ids)},
        )
    return set(affected), matched_all


def _associate_outbound(
    message: dict[str, Any],
    request_id_index: dict[str, dict[str, Any]],
    retained: int,
) -> set[str]:
    if str(message.get("direction") or "").casefold() != "sent":
        return set()
    request_id = _request_id_from_message(message)
    if not request_id or request_id not in request_id_index:
        return set()
    request = request_id_index[request_id]
    message_key = message.get("message_key")
    if not lifecycle_effect_suppressed(request, 1, message_key):
        if not request.get("request_sent_at"):
            request["request_sent_at"] = message.get("timestamp") or iso_now()
            request["request_sent_source"] = "email"
        request["request_sent_message_key"] = message_key
    item_ids = [item.get("item_id") for item in request.get("items", []) if item.get("item_id")]
    _associate_message(request, message, item_ids, retained)
    request_history(
        request,
        "outbound-request-email",
        {"messageKey": message.get("message_key")},
    )
    return {request_id}


def _associate_fault_tag_outbound(
    message: dict[str, Any],
    requests: list[dict[str, Any]],
    fault_tags: list[dict[str, Any]],
    retained: int,
) -> tuple[set[str], set[str]]:
    if str(message.get("direction") or "").casefold() != "sent":
        return set(), set()
    text = _message_text(message)
    if not re.search(r"\bfault\s*tag\b", text, re.IGNORECASE):
        return set(), set()
    explicit_ids = {match.group(1).upper() for match in FAULT_TAG_TOKEN.finditer(text)}
    mentioned_rmas = {
        str(normalize_rma(match.group(1)) or "") for match in RMA_PATTERN.finditer(text)
    }
    candidates = [
        record
        for record in fault_tags
        if record.get("fault_tag_id") in explicit_ids
        or (
            not explicit_ids
            and mentioned_rmas
            and mentioned_rmas
            & {str(member.get("rma") or "") for member in record.get("members", [])}
        )
    ]
    if not candidates:
        # A schema-1 request can still be waiting for database maintenance.
        # Preserve the outbound email association without reviving the old
        # Fault-Tag-as-lifecycle behavior.
        _, legacy_rmas = _global_indices(requests)
        legacy_affected: dict[str, tuple[dict[str, Any], set[str]]] = {}
        for rma in mentioned_rmas:
            pair = legacy_rmas.get(rma)
            if pair is None:
                continue
            request, item = pair
            if not (item.get("return_exported_at") or item.get("fault_tag_generated_at")):
                continue
            legacy_affected.setdefault(
                request["request_id"], (request, set())
            )[1].add(str(item.get("item_id")))
        for request, item_ids in legacy_affected.values():
            _associate_message(request, message, item_ids, retained)
            request_history(
                request,
                "legacy-fault-tag-outbound-email",
                {"messageKey": message.get("message_key"), "items": sorted(item_ids)},
            )
        return set(legacy_affected), set()
    requests_by_id = {request.get("request_id"): request for request in requests}
    affected: dict[str, tuple[dict[str, Any], set[str]]] = {}
    updated_tags: set[str] = set()
    for record in candidates:
        timestamp = message.get("timestamp") or iso_now()
        message_key = message.get("message_key")
        already_recorded = any(
            event.get("action") == "outbound-email-detected"
            and str(event.get("summary", {}).get("messageKey") or "")
            == str(message_key or "")
            for event in record.get("history", [])
            if isinstance(event, dict)
        )
        record.setdefault("email", {}).update(
            {
                "sent_at": record.get("email", {}).get("sent_at") or timestamp,
                "message_key": message_key,
                "subject": message.get("subject"),
            }
        )
        record["locked_at"] = record.get("locked_at") or timestamp
        record["locked_source"] = record.get("locked_source") or "email"
        if not already_recorded:
            fault_tag_history(
                record,
                "outbound-email-detected",
                {"messageKey": message_key},
            )
        updated_tags.add(str(record.get("fault_tag_id")))
        for member in record.get("members", []):
            request = requests_by_id.get(member.get("request_id"))
            if request is not None:
                affected.setdefault(request["request_id"], (request, set()))[1].add(
                    str(member.get("item_id"))
                )
    for request, item_ids in affected.values():
        _associate_message(request, message, item_ids, retained)
        request_history(
            request,
            "fault-tag-outbound-email",
            {"messageKey": message.get("message_key"), "items": sorted(item_ids)},
        )
    return set(affected), updated_tags


def _apply_fault_tag_warehouse(
    message: dict[str, Any],
    facts: list[dict[str, Any]],
    fault_tags: list[dict[str, Any]],
) -> set[str]:
    fact_keys = {
        (str(fact.get("spare_sr") or ""), str(fact.get("rma") or "")): fact
        for fact in facts
    }
    updated: set[str] = set()
    for record in fault_tags:
        covered: list[str] = []
        changed: list[str] = []
        for member in record.get("members", []):
            fact = fact_keys.get(
                (str(member.get("spare_sr") or ""), str(member.get("rma") or ""))
            )
            if fact is None:
                continue
            if str(member.get("warehouse_message_key") or "") == str(
                message.get("message_key") or ""
            ):
                covered.append(str(member.get("item_id")))
                continue
            member["warehouse_evidence_at"] = (
                message.get("timestamp") or iso_now()
            )
            member["warehouse_message_key"] = message.get("message_key")
            if fact.get("rt"):
                member["rt"] = fact.get("rt")
            covered.append(str(member.get("item_id")))
            changed.append(str(member.get("item_id")))
        if changed:
            fault_tag_history(
                record,
                "warehouse-evidence-received",
                {"messageKey": message.get("message_key"), "items": sorted(changed)},
            )
        if covered:
            updated.add(str(record.get("fault_tag_id")))
    return updated


def apply_spare_request_messages(
    store: Any,
    staging_current: Path,
    incoming: Iterable[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    requests = list(store.iter_spare_requests(staging_current))
    fault_tags = list(store.iter_fault_tags(staging_current))
    unmatched_path = store.unmatched_spare_messages_file(staging_current)
    current = now or datetime.now(ECUADOR_TIMEZONE)
    cutoff = (current - timedelta(days=180)).replace(tzinfo=None)
    combined = [*_read_ndjson(unmatched_path), *incoming]
    retained_messages = [
        message for message in combined if _message_time(message) >= cutoff
    ]
    by_key = {
        str(message.get("message_key")): deepcopy(message)
        for message in retained_messages
        if message.get("message_key")
    }
    messages = sorted(by_key.values(), key=_message_time)
    if not requests:
        _write_ndjson(unmatched_path, messages)
        return {
            "updated_requests": [],
            "matched_messages": 0,
            "unmatched_messages": len(messages),
            "conflicts": 0,
            "expired_messages": len(combined) - len(retained_messages),
        }
    request_id_index = {request["request_id"]: request for request in requests}
    workbook_directory = store.configured_directory("workbook_directory")
    closed_path = workbook_directory / "Closed.xlsx" if workbook_directory is not None else None
    archived_rmas = set().union(
        *(
            archived_rma_values(row)
            for row in read_archived_items(closed_path)
        )
    ) if closed_path is not None else set()
    retained = int(store.config.get("email", {}).get("retained_message_count", 7))
    trust = spare_mail_trust(store.config)
    message_state: dict[str, dict[str, Any]] = {
        str(message["message_key"]): {"message": message, "matched": False, "complete": True}
        for message in messages
    }
    updated_fault_tags: set[str] = set()

    # First assign Spare SR/RMA facts, then dispatch facts. This deliberately
    # ignores arrival order so an earlier dispatch can resolve after a later
    # confirmation appears in the same rebuild.
    for state in message_state.values():
        message = state["message"]
        fact = parse_request_confirmation(
            message, trust["request_confirmation_sender"]
        )
        if fact:
            affected, complete = _apply_confirmation(
                message, fact, requests, request_id_index, retained, archived_rmas
            )
            state["matched"] = bool(affected)
            state["complete"] = complete
    for state in message_state.values():
        message = state["message"]
        fact = parse_dispatch_notification(
            message, trust["dispatch_notification_sender"]
        )
        if fact:
            affected, complete = _apply_dispatch(message, fact, requests, retained)
            state["matched"] = state["matched"] or bool(affected)
            state["complete"] = state["complete"] and complete
    for state in message_state.values():
        message = state["message"]
        facts = warehouse_candidates(message, trust["warehouse_sender_domain"])
        if facts:
            affected, complete = _apply_warehouse(message, facts, requests, retained)
            state["matched"] = state["matched"] or bool(affected)
            state["complete"] = state["complete"] and complete
            tag_updates = _apply_fault_tag_warehouse(message, facts, fault_tags)
            updated_fault_tags.update(tag_updates)
            state["matched"] = state["matched"] or bool(tag_updates)
        outbound = _associate_outbound(message, request_id_index, retained)
        state["matched"] = state["matched"] or bool(outbound)
        outbound_requests, outbound_tags = _associate_fault_tag_outbound(
            message, requests, fault_tags, retained
        )
        updated_fault_tags.update(outbound_tags)
        state["matched"] = state["matched"] or bool(outbound_requests or outbound_tags)

    updated: list[str] = []
    for request in requests:
        before = store.read_spare_request(request["request_id"], staging_current)
        if request != before:
            store.write_spare_request(staging_current, request)
            updated.append(request["request_id"])
    for record in fault_tags:
        if record.get("fault_tag_id") in updated_fault_tags:
            store.write_fault_tag(staging_current, record)
    unmatched = [
        state["message"]
        for state in message_state.values()
        if not state["matched"] or not state["complete"]
    ]
    _write_ndjson(unmatched_path, unmatched)
    conflicts = sum(
        len(request.get("conflicts", []))
        + sum(len(item.get("conflicts", [])) for item in request.get("items", []))
        for request in requests
    )
    return {
        "updated_requests": sorted(updated, reverse=True),
        "updated_fault_tags": sorted(updated_fault_tags, reverse=True),
        "matched_messages": sum(bool(state["matched"]) for state in message_state.values()),
        "unmatched_messages": len(unmatched),
        "conflicts": conflicts,
        "expired_messages": len(combined) - len(retained_messages),
    }


def purge_old_active_email_bodies(
    store: Any,
    staging_current: Path,
    *,
    before: datetime,
) -> int:
    removed = 0
    for request in list(store.iter_spare_requests(staging_current)):
        messages = list(request.get("email", {}).get("messages", []))
        retained_messages: list[dict[str, Any]] = []
        for message in messages:
            timestamp = parse_datetime(message.get("timestamp"))
            if timestamp is None:
                retained_messages.append(message)
                continue
            cutoff = before.replace(tzinfo=None) if before.tzinfo is not None else before
            if comparable >= cutoff:
                retained_messages.append(message)
                continue
            removed += 1
        if len(retained_messages) != len(messages):
            request.setdefault("email", {})["messages"] = retained_messages
            request_history(request, "email-records-purged", {"before": before.isoformat()})
            store.write_spare_request(staging_current, request)
    unmatched_path = store.unmatched_spare_messages_file(staging_current)
    unmatched = _read_ndjson(unmatched_path)
    retained_unmatched = []
    for message in unmatched:
        timestamp = parse_datetime(message.get("timestamp"))
        comparable = (
            timestamp.replace(tzinfo=None) if timestamp and timestamp.tzinfo is not None else timestamp
        )
        cutoff = before.replace(tzinfo=None) if before.tzinfo is not None else before
        if comparable is None or comparable >= cutoff:
            retained_unmatched.append(message)
        else:
            removed += 1
    if len(retained_unmatched) != len(unmatched):
        _write_ndjson(unmatched_path, retained_unmatched)
    return removed
