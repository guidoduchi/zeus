from __future__ import annotations

import base64
import json
import os
import re
import shutil
import uuid
import zipfile
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import (
    CONFIG_FILENAME,
    config_path,
    ensure_config,
    load_config,
    resolve_path_setting,
    save_config,
)
from .maintenance_windows import (
    LOCAL_SCHEMA_VERSION,
    maintenance_window_summary,
    validate_maintenance_window_record,
)
from .fault_tags import (
    decode_fault_tag_record,
    normalize_fault_tag_id,
    render_fault_tag_markdown,
    validate_fault_tag_record,
)
from .reference_data import ensure_reference_layout
from .spare_requests import (
    decode_request_record,
    normalize_request_id,
    render_request_markdown,
    upgrade_request_record,
    validate_request_record,
)
from .tickets import LOCAL_COLUMNS, UPSTREAM_COLUMNS, empty_email, normalize_local
from .utils import (
    atomic_write_json,
    atomic_write_text,
    iso_now,
    json_dumps,
    load_json,
    normalize_ticket_id,
    safe_filename,
    sha256_file,
)


RECORD_MARKER = "<!-- ZEUS_RECORD_V2:"


class StoreError(RuntimeError):
    """Raised when Zeus cannot safely read or mutate its local store."""


class StoreLockedError(StoreError):
    """Raised when another Zeus mutation appears to be in progress."""


class FileLock:
    def __init__(self, path: Path, *, stale_after_hours: int = 24):
        self.path = path
        self.stale_after_hours = stale_after_hours
        self.acquired = False

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        try:
            descriptor = os.open(self.path, flags, 0o600)
        except FileExistsError as exc:
            age_hours = (
                datetime.now(timezone.utc).timestamp() - self.path.stat().st_mtime
            ) / 3600
            if age_hours <= self.stale_after_hours:
                raise StoreLockedError(
                    f"Zeus data is locked by another operation: {self.path}"
                ) from exc
            stale_name = self.path.with_name(
                f"{self.path.name}.stale-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
            )
            os.replace(self.path, stale_name)
            descriptor = os.open(self.path, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json_dumps({"pid": os.getpid(), "created_at": iso_now()}) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.acquired = True
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self.acquired:
            self.path.unlink(missing_ok=True)
            self.acquired = False


def _display(value: Any) -> str:
    if value is None or value == "":
        return "—"
    return str(value).replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>")


def _encode_record(ticket: dict[str, Any]) -> str:
    payload = json_dumps(ticket, indent=None).encode("utf-8")
    return base64.b64encode(payload).decode("ascii")


def _decode_record(line: str, path: Path) -> dict[str, Any]:
    if not line.startswith(RECORD_MARKER) or not line.rstrip().endswith(" -->"):
        raise StoreError(f"Ticket record marker is missing or invalid: {path}")
    encoded = line[len(RECORD_MARKER) : line.rfind(" -->")].strip()
    try:
        value = json.loads(base64.b64decode(encoded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StoreError(f"Ticket record payload is invalid: {path}") from exc
    if not isinstance(value, dict):
        raise StoreError(f"Ticket record is not an object: {path}")
    return value


def render_ticket_markdown(ticket: dict[str, Any]) -> str:
    """Render one self-contained, human-readable and machine-safe record."""

    ticket_id = normalize_ticket_id(ticket.get("ticket_id"))
    lifecycle = ticket.get("lifecycle", {})
    upstream = ticket.get("upstream", {}).get("fields", {})
    prepared_local = normalize_local(ticket.get("local"))
    local = prepared_local.get("fields", {})
    maintenance_window = maintenance_window_summary(prepared_local)
    email = ticket.get("email", {})
    lines = [
        f"{RECORD_MARKER}{_encode_record(ticket)} -->",
        "",
        f"# SR {ticket_id}",
        "",
        f"- Lifecycle: **{_display(lifecycle.get('status'))}**",
        f"- Problem: {_display(upstream.get('Problem Summary'))}",
        f"- Last updated: {_display(ticket.get('updated_at'))}",
        "",
        "## Advanced Search fields",
        "",
        "| Field | Value |",
        "|---|---|",
    ]
    for column in UPSTREAM_COLUMNS:
        lines.append(f"| {_display(column)} | {_display(upstream.get(column))} |")
    lines.extend(
        [
            "",
            "## Maintenance Window",
            "",
            f"- Current: **{_display(maintenance_window.get('display'))}**",
            f"- State: {_display(maintenance_window.get('status'))}",
            "",
            "| Date | Outcome | Confirmed at | Source |",
            "|---|---|---|---|",
        ]
    )
    attempts = maintenance_window.get("attempts") or []
    if attempts:
        for attempt in attempts:
            lines.append(
                "| "
                + " | ".join(
                    _display(attempt.get(key))
                    for key in ("date", "outcome", "confirmed_at", "source")
                )
                + " |"
            )
    else:
        lines.append("| — | — | — | — |")
    lines.extend(["", "## Pendings fields", "", "| Field | Value |", "|---|---|"])
    for column in LOCAL_COLUMNS:
        lines.append(f"| {_display(column)} | {_display(local.get(column))} |")
    lines.extend(["", "## Spare parts"])
    spare_parts = prepared_local.get("spare_parts", [])
    if not spare_parts:
        lines.extend(["", "_No spare-parts record._"])
    for device_number, device in enumerate(spare_parts, start=1):
        lines.extend(
            [
                "",
                f"### Device {device_number}: {_display(device.get('device'))}",
                "",
                f"- Model: {_display(device.get('model'))}",
                "",
                "| Slot | Part | BOM | Faulty SN | New SN |",
                "|---|---|---|---|---|",
            ]
        )
        parts = device.get("parts") or []
        if not parts:
            lines.append("| — | — | — | — | — |")
        for part in parts:
            lines.append(
                "| "
                + " | ".join(
                    _display(part.get(key))
                    for key in ("slot", "part", "bom", "faulty_sn", "new_sn")
                )
                + " |"
            )
    received = int(email.get("total_received") or 0)
    sent = int(email.get("total_sent") or 0)
    lines.extend(
        [
            "",
            "## Email summary",
            "",
            f"- Received: **{received}**",
            f"- Sent: **{sent}**",
            f"- Last activity: {_display(email.get('last_activity_at'))}",
            f"- Last direction: {_display(email.get('last_direction'))}",
            f"- Last synchronized: {_display(email.get('last_synchronized_at'))}",
        ]
    )
    messages = email.get("messages") or []
    if not messages:
        lines.extend(["", "_No retained email bodies._"])
    for index, message in enumerate(messages, start=1):
        direction = str(message.get("direction") or "unknown").capitalize()
        lines.extend(
            [
                "",
                f"### {index}. {direction} — {_display(message.get('timestamp'))}",
                "",
                f"**Subject:** {_display(message.get('subject'))}",
                "",
            ]
        )
        has_compact_reply = message.get("latest_reply_body") is not None
        body = str(
            message.get("latest_reply_body")
            if has_compact_reply
            else message.get("body") or ""
        )
        if body:
            lines.extend(f"    {line}" if line else "    " for line in body.splitlines())
        elif has_compact_reply:
            lines.append("_No new text in this reply._")
        else:
            lines.append("_Body unavailable._")
        if message.get("quoted_history_hidden"):
            hidden_lines = int(message.get("quoted_history_lines") or 0)
            detail = f" ({hidden_lines} quoted line(s))" if hidden_lines else ""
            lines.extend(["", f"_Earlier reply history hidden{detail}._"])
    return "\n".join(lines).rstrip() + "\n"


class ZeusStore:
    def __init__(self, root: Path, *, config_home: Path | None = None):
        self.root = root.expanduser().resolve()
        self.config_home = (config_home or self.root.parent).expanduser().resolve()
        self.config_file = config_path(self.config_home)
        self.current = self.root / "current"
        self.tickets = self.current / "tickets"
        self.staging = self.current / "email_staging"
        self.spare_requests = self.current / "spare_requests" / "active"
        self.fault_tags = self.current / "spare_requests" / "fault_tags" / "active"
        self.completed_fault_tags = (
            self.current / "spare_requests" / "fault_tags" / "completed"
        )
        self.backups = self.root / "backups"
        self.audit_dir = self.root / "audit"
        self.audit_file = self.audit_dir / "events.ndjson"
        self.lock_file = self.root / ".zeus.lock"

    @property
    def config(self) -> dict[str, Any]:
        return load_config(self.config_home)

    def save_config(self, config: dict[str, Any]) -> Path:
        return save_config(self.config_home, config)

    def configured_directory(self, key: str) -> Path | None:
        return resolve_path_setting(
            self.config_home, self.config.get("paths", {}).get(key)
        )

    def ensure_layout(self, *, create_current: bool = True) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.backups.mkdir(parents=True, exist_ok=True)
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        ensure_config(self.config_home)
        ensure_reference_layout(self.root, self.config_home)
        if create_current and not self.current.exists():
            self._create_empty_current(self.current)
        elif create_current:
            # Additive 3.1.1 migration: existing Zeus 2/3 stores gain the
            # independent Spare Request tree without rewriting ticket data.
            self.spare_requests.mkdir(parents=True, exist_ok=True)
            self.fault_tags.mkdir(parents=True, exist_ok=True)
            self.completed_fault_tags.mkdir(parents=True, exist_ok=True)
            unmatched = self.unmatched_spare_messages_file()
            if not unmatched.exists():
                atomic_write_text(unmatched, "")

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {
            "schema_version": 2,
            "database_schema_version": 4,
            "created_at": iso_now(),
            "updated_at": iso_now(),
            "advanced_search_state": None,
            "pendings_state": {"last_import_at": None, "last_error": None},
            "publication_state": {
                "last_published_at": None,
                "pendings_snapshot": None,
            },
            "email_state": {
                "initial_full_scan_completed": False,
                "last_successful_full_email_fetch_at": None,
                "last_successful_email_sync_at": None,
                "staged_at": None,
                "staged_message_count": 0,
            },
        }

    @classmethod
    def _create_empty_current(cls, path: Path) -> None:
        (path / "tickets").mkdir(parents=True, exist_ok=True)
        (path / "email_staging").mkdir(parents=True, exist_ok=True)
        atomic_write_text(path / "email_staging" / "messages.ndjson", "")
        (path / "spare_requests" / "active").mkdir(parents=True, exist_ok=True)
        (path / "spare_requests" / "fault_tags" / "active").mkdir(
            parents=True, exist_ok=True
        )
        (path / "spare_requests" / "fault_tags" / "completed").mkdir(
            parents=True, exist_ok=True
        )
        atomic_write_text(path / "spare_requests" / "unmatched_messages.ndjson", "")
        atomic_write_json(path / "closed_index.json", {
            "schema_version": 1,
            "ticket_ids": [],
            "row_count": 0,
            "validated_at": None,
        })
        atomic_write_json(path / "state.json", cls._empty_state())

    def state(self, current_path: Path | None = None) -> dict[str, Any]:
        base = current_path or self.current
        state = load_json(base / "state.json", {})
        if not isinstance(state, dict):
            raise StoreError(f"Invalid state file: {base / 'state.json'}")
        return state

    def closed_index(self, current_path: Path | None = None) -> dict[str, Any]:
        base = current_path or self.current
        value = load_json(base / "closed_index.json", {})
        if not isinstance(value, dict):
            raise StoreError("closed_index.json is invalid")
        return value

    def ticket_dir(self, ticket_id: str, current_path: Path | None = None) -> Path:
        base = current_path or self.current
        return base / "tickets" / normalize_ticket_id(ticket_id)

    def ticket_file(self, ticket_id: str, current_path: Path | None = None) -> Path:
        normalized = normalize_ticket_id(ticket_id)
        return self.ticket_dir(normalized, current_path) / f"{normalized}.md"

    def staging_file(self, current_path: Path | None = None) -> Path:
        return (current_path or self.current) / "email_staging" / "messages.ndjson"

    def spare_request_root(self, current_path: Path | None = None) -> Path:
        return (current_path or self.current) / "spare_requests"

    def spare_request_active(self, current_path: Path | None = None) -> Path:
        return self.spare_request_root(current_path) / "active"

    def spare_request_dir(
        self, request_id: str, current_path: Path | None = None
    ) -> Path:
        return self.spare_request_active(current_path) / normalize_request_id(request_id)

    def spare_request_file(
        self, request_id: str, current_path: Path | None = None
    ) -> Path:
        normalized = normalize_request_id(request_id)
        return self.spare_request_dir(normalized, current_path) / f"{normalized}.md"

    def unmatched_spare_messages_file(self, current_path: Path | None = None) -> Path:
        return self.spare_request_root(current_path) / "unmatched_messages.ndjson"

    def fault_tag_root(self, current_path: Path | None = None) -> Path:
        return self.spare_request_root(current_path) / "fault_tags"

    def fault_tag_collection(
        self, current_path: Path | None = None, *, completed: bool = False
    ) -> Path:
        return self.fault_tag_root(current_path) / ("completed" if completed else "active")

    def fault_tag_dir(
        self,
        fault_tag_id: str,
        current_path: Path | None = None,
        *,
        completed: bool = False,
    ) -> Path:
        return self.fault_tag_collection(current_path, completed=completed) / normalize_fault_tag_id(
            fault_tag_id
        )

    def fault_tag_file(
        self,
        fault_tag_id: str,
        current_path: Path | None = None,
        *,
        completed: bool = False,
    ) -> Path:
        identifier = normalize_fault_tag_id(fault_tag_id)
        return self.fault_tag_dir(
            identifier, current_path, completed=completed
        ) / f"{identifier}.md"

    def read_fault_tag(
        self,
        fault_tag_id: str,
        current_path: Path | None = None,
        *,
        completed: bool | None = None,
    ) -> dict[str, Any]:
        candidates = (
            [completed] if completed is not None else [False, True]
        )
        for archived in candidates:
            path = self.fault_tag_file(
                fault_tag_id, current_path, completed=bool(archived)
            )
            if not path.is_file():
                continue
            with path.open("r", encoding="utf-8") as handle:
                first_line = handle.readline().rstrip("\n")
            try:
                return decode_fault_tag_record(first_line, path)
            except ValueError as exc:
                raise StoreError(str(exc)) from exc
        raise StoreError(f"Fault Tag not found: {normalize_fault_tag_id(fault_tag_id)}")

    def iter_fault_tag_ids(
        self,
        current_path: Path | None = None,
        *,
        completed: bool = False,
    ) -> Iterator[str]:
        base = self.fault_tag_collection(current_path, completed=completed)
        if not base.exists():
            return
        for directory in sorted(
            base.iterdir(), key=lambda item: item.name, reverse=True
        ):
            if not directory.is_dir():
                continue
            try:
                identifier = normalize_fault_tag_id(directory.name)
            except ValueError:
                continue
            if (directory / f"{identifier}.md").is_file():
                yield identifier

    def iter_fault_tags(
        self,
        current_path: Path | None = None,
        *,
        completed: bool = False,
    ) -> Iterator[dict[str, Any]]:
        for identifier in self.iter_fault_tag_ids(
            current_path, completed=completed
        ):
            yield self.read_fault_tag(
                identifier, current_path, completed=completed
            )

    def write_fault_tag(
        self,
        current_path: Path,
        record: dict[str, Any],
        *,
        completed: bool = False,
    ) -> Path:
        prepared = deepcopy(record)
        identifier = normalize_fault_tag_id(prepared.get("fault_tag_id"))
        prepared["fault_tag_id"] = identifier
        prepared["updated_at"] = iso_now()
        try:
            validate_fault_tag_record(prepared, identifier)
        except ValueError as exc:
            raise StoreError(str(exc)) from exc
        directory = self.fault_tag_dir(
            identifier, current_path, completed=completed
        )
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{identifier}.md"
        atomic_write_text(path, render_fault_tag_markdown(prepared))
        return path

    def delete_fault_tag(
        self,
        fault_tag_id: str,
        current_path: Path,
        *,
        completed: bool = False,
    ) -> None:
        directory = self.fault_tag_dir(
            fault_tag_id, current_path, completed=completed
        )
        if directory.exists():
            shutil.rmtree(directory)

    def archive_fault_tag(self, fault_tag_id: str, current_path: Path) -> None:
        identifier = normalize_fault_tag_id(fault_tag_id)
        source = self.fault_tag_dir(identifier, current_path, completed=False)
        if not source.is_dir():
            raise StoreError(f"Active Fault Tag not found: {identifier}")
        destination = self.fault_tag_dir(identifier, current_path, completed=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise StoreError(f"Completed Fault Tag already exists: {identifier}")
        os.replace(source, destination)

    def read_spare_request(
        self, request_id: str, current_path: Path | None = None
    ) -> dict[str, Any]:
        path = self.spare_request_file(request_id, current_path)
        if not path.is_file():
            raise StoreError(f"Spare Request not found: {normalize_request_id(request_id)}")
        with path.open("r", encoding="utf-8") as handle:
            first_line = handle.readline().rstrip("\n")
        try:
            return decode_request_record(first_line, path)
        except ValueError as exc:
            raise StoreError(str(exc)) from exc

    def iter_spare_request_ids(
        self, current_path: Path | None = None
    ) -> Iterator[str]:
        base = self.spare_request_active(current_path)
        if not base.exists():
            return
        for directory in sorted(base.iterdir(), key=lambda item: item.name, reverse=True):
            if not directory.is_dir() or not re.fullmatch(r"\d{12}", directory.name):
                continue
            markdown = directory / f"{directory.name}.md"
            if markdown.is_file():
                yield directory.name

    def iter_spare_requests(
        self, current_path: Path | None = None
    ) -> Iterator[dict[str, Any]]:
        for request_id in self.iter_spare_request_ids(current_path):
            yield self.read_spare_request(request_id, current_path)

    def write_spare_request(
        self, current_path: Path, request: dict[str, Any]
    ) -> Path:
        prepared = upgrade_request_record(request)
        request_id = normalize_request_id(prepared.get("request_id"))
        prepared["request_id"] = request_id
        prepared["updated_at"] = iso_now()
        try:
            validate_request_record(prepared, request_id)
        except ValueError as exc:
            raise StoreError(str(exc)) from exc
        directory = self.spare_request_dir(request_id, current_path)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{request_id}.md"
        atomic_write_text(path, render_request_markdown(prepared))
        return path

    def delete_spare_request(self, request_id: str, current_path: Path) -> None:
        directory = self.spare_request_dir(request_id, current_path)
        if directory.exists():
            shutil.rmtree(directory)

    def read_ticket(self, ticket_id: str, current_path: Path | None = None) -> dict[str, Any]:
        path = self.ticket_file(ticket_id, current_path)
        if not path.is_file():
            raise StoreError(f"Ticket not found: {normalize_ticket_id(ticket_id)}")
        with path.open("r", encoding="utf-8") as handle:
            first_line = handle.readline().rstrip("\n")
        return _decode_record(first_line, path)

    def read_notes(self, ticket_id: str, current_path: Path | None = None) -> str:
        ticket = self.read_ticket(ticket_id, current_path)
        return str(ticket.get("local", {}).get("fields", {}).get("Notes") or "")

    def read_mail_summary(
        self, ticket_id: str, current_path: Path | None = None
    ) -> dict[str, Any]:
        ticket = self.read_ticket(ticket_id, current_path)
        email = dict(ticket.get("email") or empty_email(ticket_id))
        # Compatibility aliases simplify MOP fields and old scripts while the
        # on-disk record uses the exact 2.0.2 terminology.
        email.setdefault("last_inbound", email.get("latest_received_at"))
        email.setdefault("last_outbound", email.get("latest_sent_at"))
        email.setdefault("last_activity", email.get("last_activity_at"))
        email.setdefault("message_count", int(email.get("total_received") or 0) + int(email.get("total_sent") or 0))
        email.setdefault("last_mail_sync", email.get("last_synchronized_at"))
        return email

    def iter_ticket_ids(
        self, *, status: str = "all", current_path: Path | None = None
    ) -> Iterator[str]:
        base = (current_path or self.current) / "tickets"
        if not base.exists():
            return
        normalized_status = "active" if status == "open" else status
        for directory in sorted(base.iterdir(), key=lambda item: item.name, reverse=True):
            if not directory.is_dir() or not directory.name.isdigit():
                continue
            markdown = directory / f"{directory.name}.md"
            if not markdown.is_file():
                continue
            if normalized_status != "all":
                ticket = self.read_ticket(directory.name, current_path)
                if ticket.get("lifecycle", {}).get("status") != normalized_status:
                    continue
            yield directory.name

    def iter_tickets(
        self, *, status: str = "all", current_path: Path | None = None
    ) -> Iterator[dict[str, Any]]:
        for ticket_id in self.iter_ticket_ids(status=status, current_path=current_path):
            yield self.read_ticket(ticket_id, current_path)

    def write_ticket_bundle(
        self,
        current_path: Path,
        ticket: dict[str, Any],
        *,
        notes: str | None = None,
        mail_summary: dict[str, Any] | None = None,
    ) -> Path:
        ticket = dict(ticket)
        ticket_id = normalize_ticket_id(ticket.get("ticket_id"))
        ticket["ticket_id"] = ticket_id
        ticket["local"] = normalize_local(ticket.get("local"))
        if notes is not None:
            ticket.setdefault("local", {}).setdefault("fields", {})["Notes"] = notes
        if mail_summary is not None:
            ticket["email"] = dict(mail_summary)
        ticket["updated_at"] = iso_now()
        directory = self.ticket_dir(ticket_id, current_path)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "mops").mkdir(parents=True, exist_ok=True)
        path = directory / f"{ticket_id}.md"
        atomic_write_text(path, render_ticket_markdown(ticket))
        # Preview builds used sidecars.  A transaction that upgrades such a
        # record removes them only after the Markdown replacement exists.
        for legacy in ("ticket.json", "notes.md", "mail-summary.json"):
            (directory / legacy).unlink(missing_ok=True)
        return path

    def delete_ticket_bundle(self, ticket_id: str, current_path: Path) -> None:
        directory = self.ticket_dir(ticket_id, current_path)
        if directory.exists():
            shutil.rmtree(directory)

    def validate_ticket(self, ticket: dict[str, Any], directory_name: str) -> None:
        ticket_id = normalize_ticket_id(ticket.get("ticket_id"))
        if ticket_id != directory_name:
            raise StoreError(
                f"Ticket directory {directory_name!r} contains ID {ticket_id!r}"
            )
        if ticket.get("schema_version") != 2:
            raise StoreError(f"Ticket {ticket_id} has an unsupported schema")
        lifecycle = ticket.get("lifecycle", {}).get("status")
        if lifecycle not in {"active", "closure_pending"}:
            raise StoreError(f"Ticket {ticket_id} has invalid lifecycle status")
        fields = ticket.get("upstream", {}).get("fields", {})
        if normalize_ticket_id(fields.get("SRNo")) != ticket_id:
            raise StoreError(f"Ticket {ticket_id} has a mismatched upstream SRNo")
        email = ticket.get("email", {})
        if not isinstance(email.get("messages", []), list):
            raise StoreError(f"Ticket {ticket_id} has invalid retained email data")
        if not isinstance(ticket.get("local", {}).get("spare_parts", []), list):
            raise StoreError(f"Ticket {ticket_id} has invalid spare-parts data")
        local = ticket.get("local", {})
        raw_local_schema = local.get("schema_version")
        try:
            local_schema = int(
                1 if raw_local_schema is None else raw_local_schema
            )
        except (TypeError, ValueError) as exc:
            raise StoreError(f"Ticket {ticket_id} has an invalid local schema") from exc
        if (
            isinstance(raw_local_schema, bool)
            or (
                isinstance(raw_local_schema, float)
                and not raw_local_schema.is_integer()
            )
            or local_schema < 1
            or local_schema > LOCAL_SCHEMA_VERSION
        ):
            raise StoreError(f"Ticket {ticket_id} has an unsupported local schema")
        if "maintenance_window" in local:
            try:
                validate_maintenance_window_record(local.get("maintenance_window"))
            except ValueError as exc:
                raise StoreError(f"Ticket {ticket_id}: {exc}") from exc

    def validate_current(self, current_path: Path) -> None:
        state = self.state(current_path)
        if state.get("schema_version") != 2:
            raise StoreError("Unsupported or missing store schema version")
        tickets_path = current_path / "tickets"
        if not tickets_path.is_dir():
            raise StoreError("Ticket directory is missing")
        for directory in tickets_path.iterdir():
            if not directory.is_dir():
                continue
            ticket = self.read_ticket(directory.name, current_path)
            self.validate_ticket(ticket, directory.name)
        spare_root = self.spare_request_active(current_path)
        if not spare_root.is_dir():
            raise StoreError("Spare Request directory is missing")
        global_rmas: set[str] = set()
        global_spare_srs: set[str] = set()
        for directory in spare_root.iterdir():
            if not directory.is_dir():
                continue
            request = self.read_spare_request(directory.name, current_path)
            try:
                validate_request_record(request, directory.name)
            except ValueError as exc:
                raise StoreError(str(exc)) from exc
            spare_sr = request.get("spare_sr")
            if spare_sr and spare_sr in global_spare_srs:
                raise StoreError(f"Spare SR {spare_sr} belongs to more than one active request")
            if spare_sr:
                global_spare_srs.add(str(spare_sr))
            for item in request.get("items", []):
                identities = [item.get("rma"), *list(item.get("rma_aliases") or [])]
                for identity in identities:
                    if identity and identity in global_rmas:
                        raise StoreError(
                            f"RMA identity {identity} belongs to more than one active Spare Request"
                        )
                    if identity:
                        global_rmas.add(str(identity))
        active_item_ids = {
            str(item.get("item_id"))
            for request in self.iter_spare_requests(current_path)
            for item in request.get("items", [])
            if item.get("item_id")
        }
        active_fault_tag_members: set[str] = set()
        for completed in (False, True):
            fault_tag_root = self.fault_tag_collection(
                current_path, completed=completed
            )
            if not fault_tag_root.is_dir():
                raise StoreError("Fault Tag directory is missing")
            for directory in fault_tag_root.iterdir():
                if not directory.is_dir():
                    continue
                record = self.read_fault_tag(
                    directory.name, current_path, completed=completed
                )
                try:
                    validate_fault_tag_record(record, directory.name)
                except ValueError as exc:
                    raise StoreError(str(exc)) from exc
                if completed:
                    continue
                for member in record.get("members", []):
                    item_id = str(member.get("item_id") or "")
                    if item_id not in active_item_ids and not member.get(
                        "user_confirmed_at"
                    ):
                        raise StoreError(
                            f"Active Fault Tag {directory.name} references missing item {item_id}"
                        )
                    if item_id in active_fault_tag_members:
                        raise StoreError(
                            f"Active item {item_id} belongs to more than one Fault Tag"
                        )
                    active_fault_tag_members.add(item_id)
        index = self.closed_index(current_path)
        ids = index.get("ticket_ids", [])
        if not isinstance(ids, list) or len(ids) != len(set(ids)):
            raise StoreError("closed_index.json has invalid or duplicate IDs")
        staging_path = self.staging_file(current_path)
        if staging_path.exists():
            with staging_path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, start=1):
                    if not line.strip():
                        continue
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise StoreError(
                            f"Invalid email staging data at line {line_number}"
                        ) from exc
                    if not isinstance(value, dict) or not value.get("message_key"):
                        raise StoreError(
                            f"Invalid email staging message at line {line_number}"
                        )
        unmatched_path = self.unmatched_spare_messages_file(current_path)
        if unmatched_path.exists():
            with unmatched_path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, start=1):
                    if not line.strip():
                        continue
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError as exc:
                        raise StoreError(
                            f"Invalid unmatched Spare Request email at line {line_number}"
                        ) from exc
                    if not isinstance(value, dict) or not value.get("message_key"):
                        raise StoreError(
                            f"Invalid unmatched Spare Request message at line {line_number}"
                        )

    def create_backup(
        self, action: str, metadata: dict[str, Any] | None = None
    ) -> Path | None:
        if not self.current.exists():
            return None
        self.backups.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        destination = self.backups / (
            f"{timestamp}_{safe_filename(action)}_{uuid.uuid4().hex[:8]}.zip"
        )
        manifest: dict[str, Any] = {
            "schema_version": 2,
            "created_at": iso_now(),
            "action": action,
            "metadata": metadata or {},
            "files": {},
        }
        with zipfile.ZipFile(
            destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            if self.config_file.exists():
                archive.write(self.config_file, CONFIG_FILENAME)
                manifest["files"][CONFIG_FILENAME] = sha256_file(self.config_file)
            for path in sorted(self.current.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(self.root).as_posix()
                archive.write(path, relative)
                manifest["files"][relative] = sha256_file(path)
            archive.writestr("manifest.json", json_dumps(manifest) + "\n")
        return destination

    @contextmanager
    def transaction(
        self,
        action: str,
        summary: dict[str, Any],
        *,
        from_scratch: bool = False,
        backup: bool = True,
    ) -> Iterator[Path]:
        self.ensure_layout(create_current=not from_scratch)
        with FileLock(self.lock_file):
            if backup and self.current.exists():
                backup_path = self.create_backup(action, summary)
                if backup_path:
                    summary.setdefault("backup", backup_path.name)
            # Staging below the already-writable data root inherits its ACLs;
            # this avoids the Windows Python 3.13 tempfile ACL failure.
            transaction_root = (self.root / f".txn-{uuid.uuid4().hex}").resolve()
            transaction_root.mkdir()
            staging_current = transaction_root / "current"
            old_current = self.root / f".current-old-{uuid.uuid4().hex}"
            commit_completed = False
            try:
                if from_scratch or not self.current.exists():
                    self._create_empty_current(staging_current)
                else:
                    shutil.copytree(self.current, staging_current)
                yield staging_current
                state = self.state(staging_current)
                state["updated_at"] = iso_now()
                atomic_write_json(staging_current / "state.json", state)
                self.validate_current(staging_current)
                had_current = self.current.exists()
                if had_current:
                    os.replace(self.current, old_current)
                try:
                    os.replace(staging_current, self.current)
                except Exception:
                    if had_current and old_current.exists() and not self.current.exists():
                        os.replace(old_current, self.current)
                    raise
                try:
                    self.append_audit(action, summary)
                except Exception:
                    failed = transaction_root / "failed-current"
                    if self.current.exists():
                        os.replace(self.current, failed)
                    if had_current and old_current.exists():
                        os.replace(old_current, self.current)
                    raise
                if old_current.exists():
                    shutil.rmtree(old_current, ignore_errors=True)
                commit_completed = True
            finally:
                if transaction_root.exists():
                    shutil.rmtree(transaction_root, ignore_errors=True)
                if commit_completed and old_current.exists() and self.current.exists():
                    shutil.rmtree(old_current, ignore_errors=True)

    def append_audit(self, action: str, summary: dict[str, Any]) -> None:
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        event = {
            "schema_version": 2,
            "timestamp": iso_now(),
            "action": action,
            "summary": summary,
        }
        with self.audit_file.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json_dumps(event, indent=None) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def list_backups(self) -> list[Path]:
        self.backups.mkdir(parents=True, exist_ok=True)
        return sorted(
            self.backups.glob("*.zip"), key=lambda path: path.stat().st_mtime,
            reverse=True,
        )

    def purge_state_backups_for_closed_tickets(self) -> int:
        """Remove internal snapshots after closure finalization.

        Snapshots contain whole Markdown records and can therefore contain
        Outlook bodies.  Once any ticket is finalized, retaining those ZIPs
        would contradict the explicit permanent-discard policy.  Pendings/
        Closed workbook backups are separate and never contain email data.
        """

        removed = 0
        for path in self.list_backups():
            path.unlink(missing_ok=True)
            removed += 1
        return removed

    @staticmethod
    def _safe_extract(archive: zipfile.ZipFile, destination: Path) -> None:
        root = destination.resolve()
        for member in archive.infolist():
            target = (destination / member.filename).resolve()
            if target != root and root not in target.parents:
                raise StoreError(f"Unsafe backup entry: {member.filename}")
        archive.extractall(destination)

    def restore_backup(self, backup_path: Path) -> None:
        backup_path = backup_path.expanduser().resolve()
        if not backup_path.is_file():
            raise StoreError(f"Backup not found: {backup_path}")
        summary: dict[str, Any] = {"restored_backup": backup_path.name}
        self.ensure_layout()
        with FileLock(self.lock_file):
            rollback = self.create_backup("pre-restore", summary)
            if rollback:
                summary["rollback_backup"] = rollback.name
            transaction_root = (self.root / f".restore-{uuid.uuid4().hex}").resolve()
            transaction_root.mkdir()
            old_current = self.root / f".current-old-{uuid.uuid4().hex}"
            try:
                with zipfile.ZipFile(backup_path, "r") as archive:
                    self._safe_extract(archive, transaction_root)
                restored = transaction_root / "current"
                self.validate_current(restored)
                os.replace(self.current, old_current)
                try:
                    os.replace(restored, self.current)
                except Exception:
                    os.replace(old_current, self.current)
                    raise
                self.append_audit("restore", summary)
                shutil.rmtree(old_current, ignore_errors=True)
            finally:
                shutil.rmtree(transaction_root, ignore_errors=True)
