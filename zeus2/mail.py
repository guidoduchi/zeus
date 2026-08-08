from __future__ import annotations

import csv
import json
import ntpath
import os
import platform
import re
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Event
from typing import Any, Callable, Iterable

from .diagnostics import record_exception
from .spare_request_mail import apply_spare_request_messages, is_spare_candidate
from .store import ZeusStore
from .utils import (
    atomic_write_json,
    atomic_write_text,
    hash_identifier,
    iso_now,
    json_dumps,
    local_today,
    parse_datetime,
    to_iso,
)


ProgressCallback = Callable[[dict[str, Any]], None]
STANDALONE_ID = re.compile(r"(?<!\d)(\d{8})(?!\d)")
SPARE_REQUEST = re.compile(r"spare\s+request", re.IGNORECASE)
TT_ID = re.compile(r"\bTT\s*(?:[:#-]\s*)?(\d{8})(?!\d)", re.IGNORECASE)
ORIGINAL_MESSAGE_SEPARATOR = re.compile(
    r"^\s*-{2,}\s*(?:original\s+message|mensaje\s+original|"
    r"mensagem\s+original|message\s+d['’]origine)\s*-{2,}\s*$",
    re.IGNORECASE,
)
WROTE_SEPARATOR = re.compile(
    r"^\s*(?:on\s+.+\s+wrote:|el\s+.+\s+escribi[oó]:|"
    r"em\s+.+\s+escreveu:|le\s+.+\s+a\s+[eé]crit\s*:?)\s*$",
    re.IGNORECASE,
)
OUTLOOK_HEADER = re.compile(
    r"^\s*(from|de|von|da|sent|sent\s+on|enviado|enviado\s+el|"
    r"enviado\s+em|envoy[eé]|gesendet|date|fecha|to|para|an|[aà]|cc|"
    r"subject|asunto|assunto|objet|betreff)\s*:",
    re.IGNORECASE,
)
DIVIDER = re.compile(r"^\s*(?:_{5,}|-{5,})\s*$")
_OUTLOOK_EXECUTOR = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="zeus-outlook-com"
)


class MailSyncError(RuntimeError):
    diagnostic_log_path: Path | None = None


class MailFetchCancelled(MailSyncError):
    pass


def _header_kind(label: str) -> str:
    normalized = re.sub(r"\s+", " ", label.strip().lower())
    if normalized in {"from", "de", "von", "da"}:
        return "from"
    if normalized in {
        "sent",
        "sent on",
        "enviado",
        "enviado el",
        "enviado em",
        "envoye",
        "envoyé",
        "gesendet",
        "date",
        "fecha",
    }:
        return "sent"
    if normalized in {"to", "para", "an", "a", "à"}:
        return "to"
    if normalized in {"subject", "asunto", "assunto", "objet", "betreff"}:
        return "subject"
    return "cc"


def _looks_like_outlook_header(lines: list[str], start: int) -> bool:
    """Recognize a reply header without treating an isolated ``From:`` as history."""

    kinds: set[str] = set()
    non_header_lines = 0
    for line in lines[start : start + 10]:
        if not line.strip():
            continue
        match = OUTLOOK_HEADER.match(line)
        if match:
            kinds.add(_header_kind(match.group(1)))
            continue
        if kinds:
            non_header_lines += 1
            if non_header_lines >= 2:
                break
    return "from" in kinds and "sent" in kinds and bool(
        {"to", "subject"} & kinds
    )


def strip_quoted_history(body: Any) -> tuple[str, bool, int]:
    """Return only the newly authored portion of a plain-text email reply.

    Outlook reply bodies contain the complete conversation underneath a
    localized header block. Zeus derives the new text for its compact view and
    records how much quoted material was hidden. The original body remains
    available for the explicit full-thread view.
    """

    normalized = str(body or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in normalized.split("\n")]
    cut: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if ORIGINAL_MESSAGE_SEPARATOR.match(line) or WROTE_SEPARATOR.match(line):
            cut = index
            break
        if DIVIDER.match(line):
            next_line = index + 1
            while next_line < len(lines) and not lines[next_line].strip():
                next_line += 1
            if next_line < len(lines) and _looks_like_outlook_header(lines, next_line):
                cut = index
                break
        if OUTLOOK_HEADER.match(line) and _looks_like_outlook_header(lines, index):
            cut = index
            if index and DIVIDER.match(lines[index - 1]):
                cut -= 1
            break
        if stripped.startswith(">"):
            remainder = [value for value in lines[index:] if value.strip()]
            quoted = sum(value.lstrip().startswith(">") for value in remainder)
            if remainder and quoted / len(remainder) >= 0.6:
                cut = index
                break

    kept = lines if cut is None else lines[:cut]
    while kept and not kept[0].strip():
        kept.pop(0)
    while kept and not kept[-1].strip():
        kept.pop()
    cleaned = "\n".join(kept)
    hidden_lines = (
        sum(1 for line in lines[cut:] if line.strip()) if cut is not None else 0
    )
    return cleaned, cut is not None, hidden_lines


def _clean_message_body(message: dict[str, Any]) -> dict[str, Any]:
    cleaned = deepcopy(message)
    body, hidden, hidden_lines = strip_quoted_history(cleaned.get("body"))
    if hidden:
        # Preserve the original plain-text body for an explicit full-thread
        # view, while making the compact reply available without reparsing.
        cleaned["latest_reply_body"] = body
        cleaned["quoted_history_hidden"] = True
        cleaned["quoted_history_lines"] = hidden_lines
    else:
        cleaned.pop("latest_reply_body", None)
        cleaned.pop("quoted_history_hidden", None)
        cleaned.pop("quoted_history_lines", None)
    return cleaned


def extract_ticket_ids(subject: str, known_ids: set[str]) -> list[str]:
    """Apply the locked Huawei subject classifier.

    ``Spare Request`` subjects exclusively trust TT tokens.  All other
    subjects accept any standalone known eight-digit ID, because Outlook I/O
    dominates runtime and the active-ID intersection prevents unrelated
    numbers from being associated.
    """

    pattern = TT_ID if SPARE_REQUEST.search(subject or "") else STANDALONE_ID
    result: list[str] = []
    seen: set[str] = set()
    for match in pattern.finditer(subject or ""):
        ticket_id = match.group(1)
        if ticket_id in known_ids and ticket_id not in seen:
            seen.add(ticket_id)
            result.append(ticket_id)
    return result


def interval_due(
    interval_days: int,
    last_successful_at: Any,
    *,
    today: date | None = None,
) -> bool:
    interval = int(interval_days)
    if interval == -1:
        return True
    if interval == 0:
        return False
    if interval < -1:
        raise ValueError("interval must be -1, 0, or positive")
    parsed = parse_datetime(last_successful_at)
    if parsed is None:
        return True
    then = parsed.astimezone().date() if parsed.tzinfo else parsed.date()
    return ((today or local_today()) - then).days >= interval


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    result: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise MailSyncError(
                    f"Invalid staged email data at line {line_number}"
                ) from exc
            if not isinstance(value, dict):
                raise MailSyncError(
                    f"Invalid staged email object at line {line_number}"
                )
            result.append(value)
    return result


def _write_ndjson(path: Path, messages: Iterable[dict[str, Any]]) -> None:
    text = "".join(json_dumps(message, indent=None) + "\n" for message in messages)
    atomic_write_text(path, text)


def _timestamp_key(value: Any) -> datetime:
    parsed = parse_datetime(value)
    if parsed is None:
        return datetime.min
    if parsed.tzinfo is not None:
        return parsed.astimezone().replace(tzinfo=None)
    return parsed


def _normalize_direction(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if text in {"received", "receive", "inbound", "incoming", "in", "r"}:
        return "received"
    if text in {"sent", "send", "outbound", "outgoing", "out", "s"}:
        return "sent"
    return None


def _normalize_message(raw: dict[str, Any]) -> dict[str, Any]:
    direction = _normalize_direction(raw.get("direction"))
    timestamp = parse_datetime(raw.get("timestamp"))
    ticket_ids = sorted(
        {str(value) for value in raw.get("ticket_ids", [])}, reverse=True
    )
    spare_candidate = bool(raw.get("spare_candidate"))
    if direction is None or timestamp is None or (not ticket_ids and not spare_candidate):
        raise MailSyncError(
            "Fetched message lacks direction, timestamp, or a ticket/Spare Request association"
        )
    raw_key = str(raw.get("message_key") or raw.get("message_id") or "").strip()
    if not raw_key:
        raw_key = (
            f"{raw.get('subject', '')}|{to_iso(timestamp)}|{direction}|"
            f"{','.join(ticket_ids)}"
        )
    message_key = (
        raw_key
        if re.fullmatch(r"[0-9a-f]{64}", raw_key.lower())
        else hash_identifier(raw_key)
    )
    return _clean_message_body({
        "schema_version": 2,
        "message_key": message_key,
        "ticket_ids": ticket_ids,
        "timestamp": to_iso(timestamp),
        "direction": direction,
        "subject": str(raw.get("subject") or ""),
        "body": str(raw.get("body") or ""),
        "html_body": str(raw.get("html_body") or ""),
        "sender": str(raw.get("sender") or ""),
        "sender_address": str(raw.get("sender_address") or ""),
        "spare_candidate": spare_candidate,
        "source": str(raw.get("source") or "outlook"),
    })


def _merge_staging(
    existing: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    by_key = {str(message.get("message_key")): deepcopy(message) for message in existing}
    added = 0
    for message in incoming:
        key = message["message_key"]
        if key not in by_key:
            by_key[key] = deepcopy(message)
            added += 1
            continue
        current = by_key[key]
        current["ticket_ids"] = sorted(
            set(current.get("ticket_ids", [])) | set(message.get("ticket_ids", [])),
            reverse=True,
        )
        if not current.get("body") and message.get("body"):
            current["body"] = message["body"]
        for field in (
            "html_body",
            "sender_address",
            "spare_candidate",
            "latest_reply_body",
            "quoted_history_hidden",
            "quoted_history_lines",
        ):
            if field in message:
                current[field] = deepcopy(message[field])
        if not current.get("subject") and message.get("subject"):
            current["subject"] = message["subject"]
    merged = sorted(
        by_key.values(),
        key=lambda item: (_timestamp_key(item.get("timestamp")), item["message_key"]),
    )
    return merged, added


def _apply_sync_to_staging(
    store: ZeusStore,
    staging_current: Path,
    *,
    ticket_ids: set[str] | None,
    update_global_timer: bool,
    synchronized_at: str,
) -> dict[str, Any]:
    staged_path = store.staging_file(staging_current)
    staged_messages = _read_ndjson(staged_path)
    active_ids = set(store.iter_ticket_ids(status="active", current_path=staging_current))
    targets = active_ids if ticket_ids is None else active_ids & ticket_ids
    retained_count = int(store.config.get("email", {}).get("retained_message_count", 7))
    updated_tickets: list[str] = []
    added_associations = 0

    for ticket_id in sorted(targets, reverse=True):
        ticket = store.read_ticket(ticket_id, staging_current)
        email = ticket.setdefault("email", {})
        seen = set(email.get("seen_message_keys", []))
        relevant = [
            message
            for message in staged_messages
            if ticket_id in message.get("ticket_ids", [])
            and message.get("message_key") not in seen
        ]
        for message in relevant:
            seen.add(message["message_key"])
            if message["direction"] == "received":
                email["total_received"] = int(email.get("total_received") or 0) + 1
            else:
                email["total_sent"] = int(email.get("total_sent") or 0) + 1
        added_associations += len(relevant)

        all_retained = {
            message["message_key"]: _clean_message_body(message)
            for message in email.get("messages", [])
            if message.get("message_key")
        }
        for message in relevant:
            if retained_count:
                all_retained[message["message_key"]] = {
                    key: deepcopy(value)
                    for key, value in message.items()
                    if key != "ticket_ids"
                }
        retained = sorted(
            all_retained.values(),
            key=lambda item: (_timestamp_key(item.get("timestamp")), item.get("message_key", "")),
            reverse=True,
        )[:retained_count]
        email["messages"] = retained if retained_count else []
        email["seen_message_keys"] = sorted(seen)

        received_times = [
            message.get("timestamp")
            for message in relevant
            if message.get("direction") == "received"
        ]
        sent_times = [
            message.get("timestamp")
            for message in relevant
            if message.get("direction") == "sent"
        ]
        if received_times:
            candidates = [email.get("latest_received_at"), *received_times]
            email["latest_received_at"] = max(
                (value for value in candidates if value), key=_timestamp_key
            )
        if sent_times:
            candidates = [email.get("latest_sent_at"), *sent_times]
            email["latest_sent_at"] = max(
                (value for value in candidates if value), key=_timestamp_key
            )
        activity = [
            (email.get("latest_received_at"), "received"),
            (email.get("latest_sent_at"), "sent"),
        ]
        activity = [(value, direction) for value, direction in activity if value]
        if activity:
            latest_value, latest_direction = max(
                activity, key=lambda item: _timestamp_key(item[0])
            )
            email["last_activity_at"] = latest_value
            email["last_direction"] = latest_direction
        email["last_synchronized_at"] = synchronized_at
        store.write_ticket_bundle(staging_current, ticket)
        updated_tickets.append(ticket_id)

    remaining: list[dict[str, Any]] = []
    for message in staged_messages:
        remaining_ids = [
            ticket_id
            for ticket_id in message.get("ticket_ids", [])
            if ticket_id not in targets
        ]
        if remaining_ids:
            retained_message = deepcopy(message)
            retained_message["ticket_ids"] = remaining_ids
            remaining.append(retained_message)
    _write_ndjson(staged_path, remaining)

    state = store.state(staging_current)
    email_state = state.setdefault("email_state", {})
    if update_global_timer:
        email_state["last_successful_email_sync_at"] = synchronized_at
    email_state["staged_message_count"] = len(remaining)
    email_state["staged_at"] = email_state.get("staged_at") if remaining else None
    atomic_write_json(staging_current / "state.json", state)
    return {
        "updated_tickets": updated_tickets,
        "new_message_associations": added_associations,
        "remaining_staged_messages": len(remaining),
    }


def commit_fetched_messages(
    store: ZeusStore,
    messages: Iterable[dict[str, Any]],
    *,
    fetched_ticket_ids: Iterable[str],
    full_scan: bool,
    synchronize: bool,
    update_global_fetch_timer: bool = True,
    update_global_sync_timer: bool = True,
    diagnostics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Atomically stage one successful fetch and optionally synchronize it."""

    store.ensure_layout()
    normalized = [_normalize_message(message) for message in messages]
    eligible = set(store.iter_ticket_ids(status="active"))
    fetched_ids = {str(value) for value in fetched_ticket_ids} & eligible
    fetched_at = iso_now()
    summary: dict[str, Any] = {
        "fetched_at": fetched_at,
        "full_scan": full_scan,
        "synchronize": synchronize,
        "fetched_tickets": sorted(fetched_ids, reverse=True),
        "scanned_messages": (diagnostics or {}).get("scanned", len(normalized)),
        "matched_messages": len(normalized),
        "diagnostics": diagnostics or {},
    }
    with store.transaction("email-fetch", summary) as staging:
        filtered: list[dict[str, Any]] = []
        seen_by_ticket = {
            ticket_id: set(
                store.read_ticket(ticket_id, staging)
                .get("email", {})
                .get("seen_message_keys", [])
            )
            for ticket_id in fetched_ids
        }
        for message in normalized:
            pending_ids = [
                ticket_id
                for ticket_id in message.get("ticket_ids", [])
                if ticket_id in fetched_ids
                and message["message_key"] not in seen_by_ticket.get(ticket_id, set())
            ]
            if pending_ids:
                candidate = deepcopy(message)
                candidate["ticket_ids"] = pending_ids
                filtered.append(candidate)
        existing = _read_ndjson(store.staging_file(staging))
        merged, added = _merge_staging(existing, filtered)
        _write_ndjson(store.staging_file(staging), merged)
        for ticket_id in sorted(fetched_ids, reverse=True):
            ticket = store.read_ticket(ticket_id, staging)
            ticket.setdefault("email", {})["last_fetched_at"] = fetched_at
            store.write_ticket_bundle(staging, ticket)
        state = store.state(staging)
        email_state = state.setdefault("email_state", {})
        if update_global_fetch_timer:
            email_state["last_successful_full_email_fetch_at"] = fetched_at
        if full_scan and update_global_fetch_timer:
            email_state["initial_full_scan_completed"] = True
        email_state["staged_at"] = fetched_at if merged else email_state.get("staged_at")
        email_state["staged_message_count"] = len(merged)
        atomic_write_json(staging / "state.json", state)
        summary["new_staged_messages"] = added
        summary["staged_message_count"] = len(merged)
        if synchronize:
            summary["synchronization"] = _apply_sync_to_staging(
                store,
                staging,
                ticket_ids=fetched_ids,
                update_global_timer=update_global_sync_timer,
                synchronized_at=fetched_at,
            )
        spare_candidates = [
            message for message in normalized if message.get("spare_candidate")
        ]
        summary["spare_request_sync"] = apply_spare_request_messages(
            store,
            staging,
            spare_candidates,
        )
    return summary


def synchronize_staged_email(
    store: ZeusStore,
    *,
    ticket_ids: Iterable[str] | None = None,
    update_global_timer: bool = True,
) -> dict[str, Any]:
    targets = {str(value) for value in ticket_ids} if ticket_ids is not None else None
    synchronized_at = iso_now()
    summary: dict[str, Any] = {
        "synchronized_at": synchronized_at,
        "ticket_ids": sorted(targets, reverse=True) if targets is not None else "all active",
    }
    with store.transaction("email-sync", summary) as staging:
        summary.update(
            _apply_sync_to_staging(
                store,
                staging,
                ticket_ids=targets,
                update_global_timer=update_global_timer,
                synchronized_at=synchronized_at,
            )
        )
        summary["spare_request_sync"] = apply_spare_request_messages(
            store,
            staging,
            [],
        )
    return summary


def _cancelled(cancel_event: Event | None) -> bool:
    return bool(cancel_event and cancel_event.is_set())


def _notify(callback: ProgressCallback | None, **payload: Any) -> None:
    if callback:
        callback(payload)


def _walk_folders(folder: Any) -> Iterable[Any]:
    yield folder
    for index in range(1, int(folder.Folders.Count) + 1):
        yield from _walk_folders(folder.Folders.Item(index))


def _normalize_windows_path(value: Any) -> str:
    # Use ntpath explicitly so path matching remains testable off Windows and
    # behaves identically on the Windows-only Outlook code path.
    return ntpath.normcase(ntpath.normpath(str(value or "").strip().strip('"')))


def _select_outlook_store(namespace: Any, configured_path: Path) -> Any:
    target = _normalize_windows_path(configured_path)
    stores = namespace.Stores
    available: list[str] = []
    for index in range(1, int(stores.Count) + 1):
        store = stores.Item(index)
        file_path = str(getattr(store, "FilePath", "") or "")
        if file_path:
            available.append(file_path)
        if _normalize_windows_path(file_path) == target:
            return store
    same_folder = [
        path
        for path in available
        if _normalize_windows_path(ntpath.dirname(path)) == target
    ]
    if same_folder:
        ost_paths = [path for path in same_folder if ntpath.splitext(path)[1].lower() == ".ost"]
        if len(ost_paths) == 1:
            guidance = (
                " Set paths.outlook_store_path to the exact mailbox store: "
                f"{ost_paths[0]}"
            )
        else:
            guidance = (
                " Set paths.outlook_store_path to one exact open .ost or .pst "
                f"file. Candidates: {same_folder}"
            )
        raise MailSyncError(
            "Configured Outlook store path is a folder, not a store file: "
            f"{configured_path}.{guidance}"
        )
    raise MailSyncError(
        "Configured Outlook store is not open in classic Outlook: "
        f"{configured_path}. Available store paths: {available or ['none']}"
    )


def _internet_message_id(item: Any) -> str:
    try:
        value = item.PropertyAccessor.GetProperty(
            "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
        )
        return str(value or "")
    except Exception:
        return ""


def _sender_smtp_address(item: Any, direction: str) -> str:
    if direction == "sent":
        return str(getattr(item, "SenderEmailAddress", "") or "")
    address = str(getattr(item, "SenderEmailAddress", "") or "")
    if address and not address.startswith("/O="):
        return address
    try:
        sender = getattr(item, "Sender", None)
        exchange_user = sender.GetExchangeUser() if sender is not None else None
        smtp = str(getattr(exchange_user, "PrimarySmtpAddress", "") or "")
        return smtp or address
    except Exception:
        return address


def _folder_metadata(
    folder: Any,
    *,
    direction: str,
    store_id: str,
    cutoff: datetime | None,
    known_ids: set[str],
    request_ids: set[str],
    spare_srs: set[str],
    rmas: set[str],
    cancel_event: Event | None,
    callback: ProgressCallback | None,
) -> tuple[list[dict[str, Any]], int]:
    items = folder.Items
    date_property = "[ReceivedTime]" if direction == "received" else "[SentOn]"
    try:
        items.Sort(date_property, True)
    except Exception:
        pass
    matched: list[dict[str, Any]] = []
    scanned = 0
    _notify(
        callback,
        phase="scan",
        folder=str(getattr(folder, "FolderPath", getattr(folder, "Name", ""))),
        total=int(getattr(items, "Count", 0) or 0),
        direction=direction,
    )
    for index in range(1, int(items.Count) + 1):
        if _cancelled(cancel_event):
            raise MailFetchCancelled("Email fetch cancelled")
        try:
            item = items.Item(index)
            if getattr(item, "Class", None) != 43:
                continue
            timestamp_value = (
                getattr(item, "ReceivedTime", None)
                if direction == "received"
                else getattr(item, "SentOn", None)
            )
            timestamp = parse_datetime(timestamp_value)
            if timestamp is None:
                continue
            comparable = timestamp.astimezone().replace(tzinfo=None) if timestamp.tzinfo else timestamp
            if cutoff is not None and comparable < cutoff:
                # Items were sorted newest-first; stop instead of walking the
                # rest of a large OST-backed folder.
                break
            scanned += 1
            subject = str(getattr(item, "Subject", "") or "")
            ticket_ids = extract_ticket_ids(subject, known_ids)
            sender = str(
                getattr(item, "SenderName", "")
                if direction == "received"
                else getattr(item, "To", "")
            )
            sender_address_value = _sender_smtp_address(item, direction)
            spare_candidate = is_spare_candidate(
                subject=subject,
                sender=sender,
                sender_address_value=sender_address_value,
                request_ids=request_ids,
                spare_srs=spare_srs,
                rmas=rmas,
            )
            if not ticket_ids and not spare_candidate:
                continue
            entry_id = str(getattr(item, "EntryID", "") or "")
            internet_id = _internet_message_id(item)
            raw_key = internet_id or f"{store_id}|{entry_id}"
            matched.append(
                {
                    "message_key": hash_identifier(raw_key),
                    "ticket_ids": ticket_ids,
                    "timestamp": to_iso(timestamp),
                    "direction": direction,
                    "subject": subject,
                    "sender": sender,
                    "sender_address": sender_address_value,
                    "body": "",
                    "html_body": "",
                    "spare_candidate": spare_candidate,
                    "entry_id": entry_id,
                    "store_id": store_id,
                    "source": "outlook",
                }
            )
            if scanned % 100 == 0:
                _notify(callback, phase="scan", scanned=scanned, matched=len(matched))
        except MailFetchCancelled:
            raise
        except Exception:
            continue
    return matched, scanned


def _fetch_outlook_messages_on_worker(
    store: ZeusStore,
    *,
    ticket_ids: Iterable[str] | None = None,
    full_scan: bool | None = None,
    cancel_event: Event | None = None,
    progress: ProgressCallback | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if platform.system() != "Windows":
        raise MailSyncError("Outlook fetching is available only on Windows")
    outlook_path = store.configured_directory("outlook_store_path")
    if outlook_path is None:
        raise MailSyncError("Outlook store path is not configured")
    try:
        import pythoncom  # type: ignore[import-not-found]
        import win32com.client  # type: ignore[import-not-found]
    except ImportError as exc:
        raise MailSyncError(
            "Outlook support requires pywin32 and classic Outlook"
        ) from exc

    active_ids = set(store.iter_ticket_ids(status="active"))
    active_requests = list(store.iter_spare_requests())
    spare_ticket_ids = {str(request.get("tt")) for request in active_requests if request.get("tt")}
    eligible_ids = active_ids | spare_ticket_ids
    known_ids = eligible_ids if ticket_ids is None else eligible_ids & {str(value) for value in ticket_ids}
    request_ids = {str(request.get("request_id")) for request in active_requests if request.get("request_id")}
    spare_srs = {str(request.get("spare_sr")) for request in active_requests if request.get("spare_sr")}
    rmas = {
        str(item.get("rma"))
        for request in active_requests
        for item in request.get("items", [])
        if item.get("rma")
    }
    if not known_ids:
        return [], {"scanned": 0, "matched": 0, "folders": 0, "full_scan": True}
    state = store.state().get("email_state", {})
    is_full = (
        not bool(state.get("initial_full_scan_completed"))
        if full_scan is None
        else bool(full_scan)
    )
    cutoff: datetime | None = None
    if not is_full:
        last = parse_datetime(state.get("last_successful_full_email_fetch_at"))
        if last is not None:
            if last.tzinfo is not None:
                last = last.astimezone().replace(tzinfo=None)
            overlap = int(store.config.get("email", {}).get("incremental_overlap_days", 7))
            cutoff = last - timedelta(days=overlap)

    pythoncom.CoInitialize()
    try:
        namespace = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
        outlook_store = _select_outlook_store(namespace, outlook_path)
        store_id = str(getattr(outlook_store, "StoreID", "") or "")
        inbox = outlook_store.GetDefaultFolder(6)
        sent = outlook_store.GetDefaultFolder(5)
        metadata: list[dict[str, Any]] = []
        scanned = 0
        folders = list(_walk_folders(inbox)) + [sent]
        for index, folder in enumerate(folders, start=1):
            if _cancelled(cancel_event):
                raise MailFetchCancelled("Email fetch cancelled")
            direction = "sent" if folder is sent else "received"
            _notify(progress, phase="folder", index=index, count=len(folders))
            found, count = _folder_metadata(
                folder,
                direction=direction,
                store_id=store_id,
                cutoff=cutoff,
                known_ids=known_ids,
                request_ids=request_ids,
                spare_srs=spare_srs,
                rmas=rmas,
                cancel_event=cancel_event,
                callback=progress,
            )
            metadata.extend(found)
            scanned += count

        # Bodies are the expensive part.  Retrieve only the union of each
        # ticket's newest configured N matches.
        retained_count = int(store.config.get("email", {}).get("retained_message_count", 7))
        body_keys: set[str] = set()
        body_keys.update(
            message["message_key"]
            for message in metadata
            if message.get("spare_candidate")
        )
        if retained_count:
            for ticket_id in known_ids:
                candidates = [
                    message for message in metadata if ticket_id in message["ticket_ids"]
                ]
                candidates.sort(
                    key=lambda message: _timestamp_key(message["timestamp"]), reverse=True
                )
                body_keys.update(
                    message["message_key"] for message in candidates[:retained_count]
                )
        for index, message in enumerate(metadata, start=1):
            if message["message_key"] not in body_keys:
                continue
            if _cancelled(cancel_event):
                raise MailFetchCancelled("Email fetch cancelled")
            try:
                item = namespace.GetItemFromID(message["entry_id"], message["store_id"])
                message["body"] = str(getattr(item, "Body", "") or "")
                message["html_body"] = str(getattr(item, "HTMLBody", "") or "")
            except Exception:
                message["body"] = ""
                message["html_body"] = ""
            _notify(progress, phase="body", index=index, total=len(metadata))
        for message in metadata:
            message.pop("entry_id", None)
            message.pop("store_id", None)
        if _cancelled(cancel_event):
            raise MailFetchCancelled("Email fetch cancelled")
        diagnostics = {
            "scanned": scanned,
            "matched": len(metadata),
            "folders": len(folders),
            "full_scan": is_full,
            "cutoff": to_iso(cutoff),
        }
        return metadata, diagnostics
    finally:
        pythoncom.CoUninitialize()


def fetch_outlook_messages(
    store: ZeusStore,
    *,
    ticket_ids: Iterable[str] | None = None,
    full_scan: bool | None = None,
    cancel_event: Event | None = None,
    progress: ProgressCallback | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Serialize all Outlook COM work on one dedicated worker thread."""

    future = _OUTLOOK_EXECUTOR.submit(
        _fetch_outlook_messages_on_worker,
        store,
        ticket_ids=ticket_ids,
        full_scan=full_scan,
        cancel_event=cancel_event,
        progress=progress,
    )
    try:
        return future.result()
    except (MailFetchCancelled, MailSyncError):
        raise
    except Exception as exc:
        log_path = record_exception(store.config_home, "Outlook COM worker", exc)
        details = f" Diagnostic log: {log_path}" if log_path is not None else ""
        wrapped = MailSyncError(
            "Classic Outlook was temporarily unavailable or could not be initialized."
            f"{details}"
        )
        wrapped.diagnostic_log_path = log_path
        raise wrapped from exc


def fetch_and_commit_outlook(
    store: ZeusStore,
    *,
    ticket_ids: Iterable[str] | None = None,
    full_scan: bool | None = None,
    synchronize: bool | None = None,
    update_global_timers: bool = True,
    cancel_event: Event | None = None,
    progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    active = set(store.iter_ticket_ids(status="active"))
    spare_tts = {
        str(request.get("tt"))
        for request in store.iter_spare_requests()
        if request.get("tt")
    }
    eligible = active | spare_tts
    targets = eligible if ticket_ids is None else eligible & {str(value) for value in ticket_ids}
    messages, diagnostics = fetch_outlook_messages(
        store,
        ticket_ids=targets,
        full_scan=full_scan,
        cancel_event=cancel_event,
        progress=progress,
    )
    if synchronize is None:
        synchronize = store.config.get("email", {}).get("sync_mode") == "after_fetch"
    return commit_fetched_messages(
        store,
        messages,
        fetched_ticket_ids=targets,
        full_scan=bool(diagnostics.get("full_scan")),
        synchronize=bool(synchronize),
        update_global_fetch_timer=update_global_timers,
        update_global_sync_timer=update_global_timers,
        diagnostics=diagnostics,
    )


def import_mail_csv(store: ZeusStore, csv_path: Path) -> dict[str, Any]:
    """Test/support adapter that follows the same staging contract as Outlook."""

    csv_path = csv_path.expanduser().resolve()
    if not csv_path.is_file():
        raise MailSyncError(f"Mail CSV not found: {csv_path}")
    known_ids = set(store.iter_ticket_ids(status="active")) | {
        str(request.get("tt"))
        for request in store.iter_spare_requests()
        if request.get("tt")
    }
    active_requests = list(store.iter_spare_requests())
    request_ids = {str(request.get("request_id")) for request in active_requests}
    spare_srs = {str(request.get("spare_sr")) for request in active_requests if request.get("spare_sr")}
    rmas = {
        str(item.get("rma"))
        for request in active_requests
        for item in request.get("items", [])
        if item.get("rma")
    }
    messages: list[dict[str, Any]] = []
    scanned = 0
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row_number, row in enumerate(reader, start=2):
            scanned += 1
            subject = str(row.get("subject") or "")
            ids = extract_ticket_ids(subject, known_ids)
            direction = _normalize_direction(row.get("direction"))
            timestamp = parse_datetime(row.get("timestamp"))
            spare_candidate = is_spare_candidate(
                subject=subject,
                sender=str(row.get("sender") or ""),
                sender_address_value=str(row.get("sender_address") or ""),
                request_ids=request_ids,
                spare_srs=spare_srs,
                rmas=rmas,
            )
            if (not ids and not spare_candidate) or direction is None or timestamp is None:
                continue
            messages.append(
                {
                    "message_id": row.get("message_id")
                    or f"csv:{csv_path.name}:{row_number}:{subject}:{timestamp}",
                    "ticket_ids": ids,
                    "timestamp": timestamp,
                    "direction": direction,
                    "subject": subject,
                    "body": row.get("body") or "",
                    "html_body": row.get("html_body") or "",
                    "sender": row.get("sender") or "",
                    "sender_address": row.get("sender_address") or "",
                    "spare_candidate": spare_candidate,
                    "source": "csv",
                }
            )
    return commit_fetched_messages(
        store,
        messages,
        fetched_ticket_ids=known_ids,
        full_scan=True,
        synchronize=False,
        diagnostics={"scanned": scanned, "matched": len(messages), "source": "csv"},
    )


# Compatibility entry point from the preview package.
def sync_outlook(
    store: ZeusStore,
    *,
    mailbox: str | None = None,
    days: int | None = None,
    include_subfolders: bool = True,
) -> dict[str, Any]:
    if mailbox:
        raise MailSyncError(
            "Zeus selects Outlook by configured store path, not mailbox name"
        )
    return fetch_and_commit_outlook(store)
