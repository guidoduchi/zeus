from __future__ import annotations

import json
import threading
import time
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from ..diagnostics import diagnostic_log_path, record_exception
from ..excel_export import (
    list_pendings_backups,
    preview_pendings_restore,
    publish_operational_workbooks,
    restore_pendings_backup,
)
from ..excel_import import read_closed, validate_closed_against_index
from ..mail import fetch_and_commit_outlook, synchronize_staged_email
from ..mop import generate_mop
from ..reconcile import sync_newest_advanced_search
from ..spare_request_excel import (
    append_archived_item,
    export_initial_request,
    export_return_workbook,
    purge_archived_items,
    purge_spare_archive_backups,
    read_archived_items,
)
from ..spare_request_mail import purge_old_active_email_bodies
from ..spare_requests import (
    ECUADOR_TIMEZONE,
    SpareRequestError,
    create_request_record,
    load_reference_data,
    next_request_id,
    normalize_profile,
    normalize_request_lines,
    normalize_rma,
    normalize_spare_sr,
    normalize_tt,
    request_filename,
    request_history,
    request_subject,
    save_reference_data,
)
from ..startup import StartupResult, reconcile_advanced_and_new_mail, run_startup
from ..store import StoreError, ZeusStore
from ..tickets import empty_email
from ..utils import iso_now, normalize_ticket_id
from .edits import edit_ticket_through_pendings
from .errors import (
    BusyError,
    ConflictError,
    FeatureUnavailableError,
    NotFoundError,
    ValidationError,
)
from .jobs import EventBroker, JobContext, JobManager
from .serialization import (
    DEFAULT_SORT_DIRECTIONS,
    SPARE_PART_DEFAULT_SORT_DIRECTIONS,
    SPARE_REQUEST_DEFAULT_SORT_DIRECTIONS,
    dashboard_payload,
    serialize_spare_request_detail,
    serialize_ticket_detail,
    spare_parts_dashboard_payload,
    spare_request_revision,
    spare_requests_dashboard_payload,
)
from .settings import outlook_candidates, settings_payload, update_settings


class ApplicationService:
    """The single controlled boundary between Zeus core logic and the web UI."""

    JOB_LABELS = {
        "startup": "Starting Zeus",
        "query": "Querying data sources",
        "advanced": "Checking Advanced Search",
        "publish": "Publishing Pendings and Closed",
        "email-fetch": "Fetching Outlook email",
        "email-sync": "Synchronizing staged email",
        "email-rebuild": "Rebuilding Outlook email history",
        "restore": "Restoring a Pendings backup",
        "doctor": "Running diagnostics",
        "mop": "Generating a MOP",
    }

    def __init__(self, store: ZeusStore):
        self.store = store
        self.store.ensure_layout()
        self.broker = EventBroker()
        self.jobs = JobManager(self.broker)
        self._operation_lock = threading.Lock()
        self._revision_lock = threading.Lock()
        self._closed_archive_lock = threading.Lock()
        self._closed_archive_signature: tuple[Any, ...] | None = None
        self._closed_archive_cache: tuple[dict[str, Any], ...] = ()
        self._dataset_revision = 1
        self._started = False
        self._stopping = threading.Event()
        self._schedule_wakeup = threading.Event()
        self._scheduler: threading.Thread | None = None
        self._next_query_at: float | None = None
        self.latest_startup = StartupResult()

    @property
    def dataset_revision(self) -> int:
        with self._revision_lock:
            return self._dataset_revision

    def _touch_data(self, reason: str) -> None:
        with self._revision_lock:
            self._dataset_revision += 1
            revision = self._dataset_revision
        self.broker.publish(
            "dataset",
            {"revision": revision, "reason": reason, "timestamp": iso_now()},
        )

    def start(self) -> dict[str, Any]:
        if self._started:
            active = next(
                (job for job in self.jobs.snapshots() if job["kind"] == "startup"),
                None,
            )
            return active or {"status": "succeeded", "kind": "startup"}
        self._started = True
        startup = self.submit_job("startup", {})
        self._scheduler = threading.Thread(
            target=self._schedule_loop,
            name="zeus-source-scheduler",
            daemon=True,
        )
        self._scheduler.start()
        return startup

    def stop(self) -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._schedule_wakeup.set()
        if self._scheduler is not None:
            self._scheduler.join(timeout=3.0)
        self.jobs.stop(timeout=5.0)

    def _schedule_loop(self) -> None:
        self._reset_schedule()
        while not self._stopping.is_set():
            minutes = int(
                self.store.config.get("advanced_search", {}).get(
                    "poll_interval_minutes", 15
                )
            )
            if minutes == 0:
                self._next_query_at = None
                self._schedule_wakeup.wait(30.0)
                self._schedule_wakeup.clear()
                continue
            if self._next_query_at is None:
                self._next_query_at = time.monotonic() + minutes * 60
            remaining = max(0.0, self._next_query_at - time.monotonic())
            if self._schedule_wakeup.wait(min(remaining, 30.0)):
                self._schedule_wakeup.clear()
                self._reset_schedule()
                continue
            if time.monotonic() >= self._next_query_at:
                self._submit_scheduled_query()
                self._reset_schedule()

    def _submit_scheduled_query(self) -> dict[str, Any]:
        """Use the manual Pendings-first query path for the timer as well."""

        # Merely loading a browser page never reaches this path.
        return self.submit_job("query", {"scheduled": True})

    def _reset_schedule(self) -> None:
        minutes = int(
            self.store.config.get("advanced_search", {}).get(
                "poll_interval_minutes", 15
            )
        )
        self._next_query_at = (
            None if minutes == 0 else time.monotonic() + minutes * 60
        )

    def bootstrap_payload(self) -> dict[str, Any]:
        outlook_path = self.store.config.get("paths", {}).get("outlook_store_path")
        state = self.store.state()
        return {
            "datasetRevision": self.dataset_revision,
            "eventSequence": self.broker.sequence,
            "startup": self.latest_startup.to_dict(),
            "jobs": self.jobs.snapshots(),
            "outlook": {
                "enabled": bool(outlook_path),
                "configuredPathAvailable": bool(
                    outlook_path and Path(str(outlook_path)).is_file()
                ),
                "stagedMessageCount": int(
                    state.get("email_state", {}).get("staged_message_count") or 0
                ),
            },
            "polling": {
                "intervalMinutes": int(
                    self.store.config.get("advanced_search", {}).get(
                        "poll_interval_minutes", 15
                    )
                ),
                "enabled": self._next_query_at is not None,
            },
        }

    def _closed_archive_tickets(self) -> tuple[dict[str, Any], ...]:
        """Read finalized non-email ticket data through a stat-keyed cache."""

        index = self.store.closed_index()
        indexed_ids = tuple(
            sorted((str(value) for value in index.get("ticket_ids", [])), reverse=True)
        )
        directory = self.store.configured_directory("workbook_directory")
        closed_path = directory / "Closed.xlsx" if directory is not None else None
        if closed_path is None or not closed_path.is_file():
            if indexed_ids:
                raise ValidationError(
                    "Closed.xlsx is missing, so Zeus cannot show finalized Spare Parts records",
                    details={"missing": "Closed.xlsx", "closedSRs": len(indexed_ids)},
                )
            with self._closed_archive_lock:
                self._closed_archive_signature = None
                self._closed_archive_cache = ()
            return ()

        stat = closed_path.stat()
        signature = (
            str(closed_path),
            stat.st_mtime_ns,
            stat.st_size,
            indexed_ids,
            index.get("validated_at"),
            index.get("workbook_sha256"),
        )
        with self._closed_archive_lock:
            if signature == self._closed_archive_signature:
                return self._closed_archive_cache
            workbook = read_closed(closed_path)
            validate_closed_against_index(workbook, index)
            tickets: list[dict[str, Any]] = []
            for ticket_id, record in workbook.records.items():
                tickets.append(
                    {
                        "ticket_id": ticket_id,
                        "lifecycle": {
                            "status": "closed",
                            "source": "Closed.xlsx",
                        },
                        "upstream": {
                            "fields": deepcopy(record.get("upstream_fields") or {}),
                            "sr_url": record.get("sr_url"),
                        },
                        "local": deepcopy(record.get("local") or {}),
                        "email": empty_email(ticket_id),
                        "mop": {"latest": None, "versions": 0},
                        "updated_at": None,
                    }
                )
            self._closed_archive_signature = signature
            self._closed_archive_cache = tuple(tickets)
            return self._closed_archive_cache

    def _closed_archive_ticket(self, ticket_id: str) -> dict[str, Any] | None:
        return next(
            (
                ticket
                for ticket in self._closed_archive_tickets()
                if ticket["ticket_id"] == ticket_id
            ),
            None,
        )

    def _closed_workbook_path(self, *, required: bool = False) -> Path | None:
        directory = self.store.configured_directory("workbook_directory")
        path = directory / "Closed.xlsx" if directory is not None else None
        if required and path is None:
            raise FeatureUnavailableError(
                "Configure the workbook folder before archiving Spare Requests"
            )
        return path

    def _spare_template(self, key: str, label: str) -> Path:
        raw = self.store.config.get("paths", {}).get(key)
        path = Path(str(raw)).expanduser().resolve() if raw else None
        if path is None or not path.is_file() or path.suffix.lower() != ".xlsx":
            raise FeatureUnavailableError(f"Configure the local {label} template first")
        return path

    def _spare_export_root(self) -> Path:
        directory = self.store.configured_directory("spare_parts_export_directory")
        if directory is None:
            raise FeatureUnavailableError("Configure the Spare Request export folder first")
        return directory

    def dashboard(
        self,
        *,
        workspace: str = "service-requests",
        sort: str,
        search: str,
        direction: str | None = None,
        view: str = "active",
    ) -> dict[str, Any]:
        workspaces = {
            "service-requests": (
                {"report", "sr", "planned", "email", "age", "severity", "status"},
                DEFAULT_SORT_DIRECTIONS,
                dashboard_payload,
            ),
            "spare-parts": (
                {"sr", "planned", "site", "cloud", "device", "part", "bom"},
                SPARE_PART_DEFAULT_SORT_DIRECTIONS,
                spare_parts_dashboard_payload,
            ),
            "spare-requests": (
                {"tt", "rma", "email", "status", "age", "site", "cloud", "bom"},
                SPARE_REQUEST_DEFAULT_SORT_DIRECTIONS,
                spare_requests_dashboard_payload,
            ),
        }
        definition = workspaces.get(workspace)
        if definition is None:
            raise ValidationError(f"Unsupported Zeus workspace: {workspace}")
        sorts, default_directions, serializer = definition
        if sort not in sorts:
            raise ValidationError(
                f"Unsupported {workspace} sort: {sort}"
            )
        direction = direction or default_directions[sort]
        if direction not in {"asc", "desc"}:
            raise ValidationError(f"Unsupported dashboard sort direction: {direction}")
        arguments: dict[str, Any] = {
            "sort": sort,
            "direction": direction,
            "search": search,
            "dataset_revision": self.dataset_revision,
        }
        if workspace == "spare-parts":
            arguments["closed_tickets"] = self._closed_archive_tickets()
        elif workspace == "spare-requests":
            if view not in {"active", "eligible", "completed"}:
                raise ValidationError(f"Unsupported Spare Requests view: {view}")
            arguments["view"] = view
            arguments["closed_path"] = self._closed_workbook_path()
        return serializer(self.store, **arguments)

    def ticket(self, ticket_id: str) -> dict[str, Any]:
        normalized_ticket_id = normalize_ticket_id(ticket_id)
        try:
            ticket = self.store.read_ticket(normalized_ticket_id)
        except StoreError as exc:
            ticket = self._closed_archive_ticket(normalized_ticket_id)
            if ticket is None:
                raise NotFoundError(f"Ticket {ticket_id} was not found") from exc
            detail = serialize_ticket_detail(
                ticket,
                self.store.config,
                read_only=True,
                source="closed",
            )
            detail["history"] = []
            detail["mops"] = []
            return detail
        detail = serialize_ticket_detail(ticket, self.store.config)
        detail["history"] = self.ticket_history(normalized_ticket_id)
        detail["mops"] = self.list_mops(normalized_ticket_id)
        return detail

    def spare_request(self, request_id: str) -> dict[str, Any]:
        try:
            request = self.store.read_spare_request(request_id)
        except (StoreError, ValueError) as exc:
            raise NotFoundError(f"Spare Request {request_id} was not found") from exc
        return serialize_spare_request_detail(request)

    def spare_reference_data(self) -> dict[str, Any]:
        return load_reference_data(self.store.config_home)

    def save_spare_reference_data(self, value: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing managers")
        try:
            result = save_reference_data(self.store.config_home, value)
        except SpareRequestError as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()
        self.broker.publish("configuration", {"changed": ["spare-request-managers"]})
        return result

    def spare_request_prefill(self, ticket_id: str) -> dict[str, Any]:
        normalized = normalize_ticket_id(ticket_id)
        try:
            ticket = self.store.read_ticket(normalized)
        except StoreError as exc:
            raise NotFoundError(f"Active SR {ticket_id} was not found") from exc
        local = ticket.get("local", {}).get("fields", {})
        upstream = ticket.get("upstream", {}).get("fields", {})

        def first(*names: str) -> Any:
            return next(
                (upstream.get(name) for name in names if upstream.get(name) not in (None, "")),
                None,
            )

        lines: list[dict[str, Any]] = []
        for device_number, device in enumerate(
            ticket.get("local", {}).get("spare_parts", []), start=1
        ):
            for part_number, part in enumerate(device.get("parts") or [], start=1):
                if not part.get("bom"):
                    continue
                lines.append(
                    {
                        "bom": part.get("bom"),
                        "amount": 1,
                        "description": part.get("part") or part.get("bom"),
                        "part": part.get("part"),
                        "model": device.get("model"),
                        "device": device.get("device"),
                        "slot": part.get("slot"),
                        "faultySn": part.get("faulty_sn"),
                        "reportDate": first("Report Date", "ReportDate", "Created Date"),
                        "deviceNumber": device_number,
                        "partNumber": part_number,
                    }
                )
        return {
            "ticketId": normalized,
            "ticketExists": True,
            "profile": {
                "customerName": first("Customer Name", "Customer", "Account Name"),
                "siteCode": local.get("Site"),
                "siteName": first("Site Name"),
                "siteAddress": first("Site Address", "Customer Address", "Address"),
                "cloud": local.get("Cloud"),
                "contact": {
                    "name": first("Customer Contact", "Contact Name", "Contact"),
                    "email": first("Customer Email", "Contact Email"),
                    "phone": first("Customer Phone", "Contact Phone", "Phone"),
                },
            },
            "lines": lines,
            "warning": None if lines else "This SR has no damaged part with a BOM yet.",
        }

    def export_spare_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        exported: Path | None = None
        persisted = False
        try:
            source = str(payload.get("source") or "manual").strip().casefold()
            try:
                tt = normalize_tt(payload.get("ticketId"))
                profile = normalize_profile(payload.get("profile"))
                lines = normalize_request_lines(payload.get("lines"))
            except SpareRequestError as exc:
                raise ValidationError(str(exc)) from exc
            ticket_exists = self.store.ticket_file(tt).is_file()
            if source == "ticket" and not ticket_exists:
                raise ValidationError(f"SR {tt} must be active before exporting from its detail")
            if source not in {"ticket", "manual"}:
                raise ValidationError("Request source must be ticket or manual")
            occupied_request_ids = set(self.store.iter_spare_request_ids())
            closed_path = self._closed_workbook_path()
            if closed_path is not None:
                occupied_request_ids.update(
                    str(row.get("Request ID") or "")
                    for row in read_archived_items(closed_path)
                    if row.get("Request ID")
                )
            requests_directory = self._spare_export_root() / "Requests"
            if requests_directory.is_dir():
                for prior_export in requests_directory.glob("*.xlsx"):
                    suffix = prior_export.stem.rsplit("–", 1)[-1].split("-r", 1)[0]
                    if len(suffix) == 12 and suffix.isdigit():
                        occupied_request_ids.add(suffix)
            request_id = next_request_id(occupied_request_ids)
            subject = request_subject(request_id, tt, lines)
            filename = request_filename(request_id, tt, profile, lines)
            request = create_request_record(
                request_id=request_id,
                tt=tt,
                source=source,
                profile=profile,
                lines=lines,
                export_path=None,
                subject=subject,
            )
            exported = export_initial_request(
                self._spare_template("spare_request_template_path", "Spare Request XLSX"),
                self._spare_export_root(),
                request,
                filename,
            )
            timestamp = request.get("created_at") or iso_now()
            request["export"].update(
                {
                    "request_filename": exported.name,
                    "request_path": str(exported),
                    "subject": subject,
                    "created_at": timestamp,
                    "revisions": [
                        {"filename": exported.name, "path": str(exported), "created_at": timestamp}
                    ],
                }
            )
            request["history"][0]["action"] = "request-created"
            request["history"][0]["summary"]["filename"] = exported.name
            with self.store.transaction(
                "spare-request-export",
                {"request_id": request_id, "tt": tt, "items": len(request["items"])},
            ) as staging:
                self.store.write_spare_request(staging, request)
            persisted = True
            self._touch_data("spare-request-export")
            warnings = []
            if source == "manual" and not ticket_exists:
                warnings.append(
                    f"TT {tt} is not in local Service Requests. The request was exported with that warning recorded."
                )
            return {
                "request": self.spare_request(request_id),
                "filename": exported.name,
                "path": str(exported),
                "subject": subject,
                "warnings": warnings,
            }
        except Exception:
            if exported is not None and not persisted:
                exported.unlink(missing_ok=True)
            raise
        finally:
            self._operation_lock.release()

    def reexport_spare_request(self, request_id: str) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        exported: Path | None = None
        persisted = False
        try:
            request = self.store.read_spare_request(request_id)
            filename = request_filename(
                request["request_id"], request["tt"], request["profile"], request["request_lines"]
            )
            exported = export_initial_request(
                self._spare_template("spare_request_template_path", "Spare Request XLSX"),
                self._spare_export_root(),
                request,
                filename,
            )
            timestamp = iso_now()
            with self.store.transaction(
                "spare-request-reexport", {"request_id": request_id, "filename": exported.name}
            ) as staging:
                updated = self.store.read_spare_request(request_id, staging)
                updated["export"]["request_filename"] = exported.name
                updated["export"]["request_path"] = str(exported)
                updated["export"].setdefault("revisions", []).append(
                    {"filename": exported.name, "path": str(exported), "created_at": timestamp}
                )
                request_history(updated, "request-reexported", {"filename": exported.name})
                self.store.write_spare_request(staging, updated)
            persisted = True
            self._touch_data("spare-request-reexport")
            return {
                "request": self.spare_request(request_id),
                "filename": exported.name,
                "path": str(exported),
                "subject": request.get("export", {}).get("subject"),
            }
        except Exception:
            if exported is not None and not persisted:
                exported.unlink(missing_ok=True)
            raise
        finally:
            self._operation_lock.release()

    @staticmethod
    def _find_request_item(request: dict[str, Any], item_id: str) -> dict[str, Any]:
        item = next(
            (value for value in request.get("items", []) if value.get("item_id") == item_id),
            None,
        )
        if item is None:
            raise ValidationError(f"Item {item_id} does not belong to this request")
        return item

    def edit_spare_request(
        self,
        request_id: str,
        *,
        expected_revision: str,
        changes: dict[str, Any],
        item_updates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            current = self.store.read_spare_request(request_id)
            if not expected_revision or spare_request_revision(current) != expected_revision:
                raise ConflictError("This Spare Request changed. Reload before saving again.")
            note = str(changes.get("note") or "").strip()
            active_requests = list(self.store.iter_spare_requests())
            closed_path = self._closed_workbook_path()
            archived_rmas = {
                str(row.get("RMA"))
                for row in read_archived_items(closed_path)
                if row.get("RMA")
            } if closed_path is not None else set()
            with self.store.transaction(
                "spare-request-edit", {"request_id": request_id}
            ) as staging:
                request = self.store.read_spare_request(request_id, staging)
                if "ticketId" in changes:
                    if not request.get("tt_editable"):
                        raise ValidationError("The TT inherited from a Service Request is immutable")
                    incoming_tt = normalize_tt(changes.get("ticketId"))
                    if incoming_tt != request.get("tt"):
                        if any(item.get("rma") for item in request.get("items", [])) and not note:
                            raise ValidationError("Correcting a TT after RMA assignment requires a note")
                        previous = request.get("tt")
                        request["tt"] = incoming_tt
                        request.setdefault("export", {})["subject"] = request_subject(
                            request["request_id"], incoming_tt, request.get("request_lines", [])
                        )
                        request_history(
                            request,
                            "tt-corrected",
                            {"previous": previous, "current": incoming_tt, "note": note},
                        )
                if "spareSr" in changes:
                    incoming_sr = normalize_spare_sr(changes.get("spareSr"))
                    if request.get("spare_sr") and incoming_sr != request.get("spare_sr") and not note:
                        raise ValidationError("Replacing an assigned Spare SR requires a note")
                    if incoming_sr and any(
                        candidate.get("request_id") != request_id
                        and candidate.get("spare_sr") == incoming_sr
                        for candidate in active_requests
                    ):
                        raise ValidationError(f"Spare SR {incoming_sr} already belongs to another active request")
                    request["spare_sr"] = incoming_sr
                    if incoming_sr:
                        timestamp = iso_now()
                        for item in request.get("items", []):
                            item["attendance_confirmed_at"] = item.get("attendance_confirmed_at") or timestamp
                            item["attendance_source"] = item.get("attendance_source") or "manual"
                for update in item_updates:
                    if not isinstance(update, dict):
                        raise ValidationError("Item updates must be objects")
                    item = self._find_request_item(request, str(update.get("itemId") or ""))
                    if "rma" in update:
                        incoming_rma = normalize_rma(update.get("rma"))
                        if item.get("rma") and incoming_rma != item.get("rma"):
                            raise ValidationError(f"RMA {item['rma']} is immutable")
                        if incoming_rma and any(
                            candidate.get("request_id") != request_id
                            and any(
                                candidate_item.get("rma") == incoming_rma
                                for candidate_item in candidate.get("items", [])
                            )
                            for candidate in active_requests
                        ):
                            raise ValidationError(f"RMA {incoming_rma} already belongs to another active request")
                        if incoming_rma and any(
                            candidate_item is not item and candidate_item.get("rma") == incoming_rma
                            for candidate_item in request.get("items", [])
                        ):
                            raise ValidationError(f"RMA {incoming_rma} already belongs to another item")
                        if incoming_rma and incoming_rma in archived_rmas:
                            raise ValidationError(f"RMA {incoming_rma} already belongs to a completed item")
                        item["rma"] = incoming_rma
                        if incoming_rma:
                            item["attendance_confirmed_at"] = item.get("attendance_confirmed_at") or iso_now()
                            item["attendance_source"] = item.get("attendance_source") or "manual"
                    if "deliveredBom" in update:
                        incoming_bom = str(update.get("deliveredBom") or "").strip() or None
                        if item.get("delivered_bom") and incoming_bom != item.get("delivered_bom"):
                            item.setdefault("conflicts", []).append(
                                {
                                    "field": "delivered_bom",
                                    "existing": item.get("delivered_bom"),
                                    "incoming": incoming_bom,
                                    "message_key": None,
                                    "detected_at": iso_now(),
                                    "resolved_at": None,
                                    "resolution": None,
                                    "note": note or None,
                                }
                            )
                        else:
                            item["delivered_bom"] = incoming_bom
                    if "newSn" in update:
                        incoming_sn = str(update.get("newSn") or "").strip() or None
                        if item.get("new_sn") and incoming_sn != item.get("new_sn"):
                            item.setdefault("conflicts", []).append(
                                {
                                    "field": "new_sn",
                                    "existing": item.get("new_sn"),
                                    "incoming": incoming_sn,
                                    "message_key": None,
                                    "detected_at": iso_now(),
                                    "resolved_at": None,
                                    "resolution": None,
                                    "note": note or None,
                                }
                            )
                        else:
                            item["new_sn"] = incoming_sn
                    if update.get("attended"):
                        item["attendance_confirmed_at"] = item.get("attendance_confirmed_at") or iso_now()
                        item["attendance_source"] = item.get("attendance_source") or "manual"
                    if "dispatchAt" in update:
                        incoming_dispatch = str(update.get("dispatchAt") or "").strip() or None
                        if item.get("dispatch_at") and incoming_dispatch != item.get("dispatch_at"):
                            raise ValidationError("Dispatch time cannot be silently overwritten")
                        item["dispatch_at"] = incoming_dispatch
                        item["dispatch_source"] = "manual" if incoming_dispatch else None
                    if "notes" in update:
                        item["notes"] = str(update.get("notes") or "").strip() or None
                request_history(
                    request,
                    "request-edited",
                    {"fields": sorted(changes), "items": len(item_updates), "note": note or None},
                )
                self.store.write_spare_request(staging, request)
            self._touch_data("spare-request-edit")
            return {"request": self.spare_request(request_id)}
        except SpareRequestError as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()

    def resolve_spare_conflict(
        self,
        request_id: str,
        *,
        item_id: str | None,
        conflict_index: int,
        resolution: str,
        note: str,
    ) -> dict[str, Any]:
        if resolution not in {"keep-existing", "accept-incoming"}:
            raise ValidationError("Choose whether to keep the existing or accept the incoming value")
        if not note.strip():
            raise ValidationError("Conflict resolution requires a note")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            with self.store.transaction(
                "spare-request-conflict-resolution", {"request_id": request_id}
            ) as staging:
                request = self.store.read_spare_request(request_id, staging)
                target = self._find_request_item(request, item_id) if item_id else request
                conflicts = target.get("conflicts", [])
                if conflict_index < 0 or conflict_index >= len(conflicts):
                    raise ValidationError("Conflict was not found")
                conflict = conflicts[conflict_index]
                if conflict.get("resolved_at"):
                    raise ValidationError("Conflict is already resolved")
                field = str(conflict.get("field") or "")
                mutable_fields = {"spare_sr", "delivered_bom", "new_sn"}
                if resolution == "accept-incoming" and field not in mutable_fields:
                    raise ValidationError(
                        f"Incoming {field or 'conflict'} cannot replace an immutable or structural fact"
                    )
                if resolution == "accept-incoming" and field in mutable_fields:
                    key = {
                        "spare_sr": "spare_sr",
                        "delivered_bom": "delivered_bom",
                        "new_sn": "new_sn",
                    }[field]
                    if field == "spare_sr" and any(
                        candidate.get("request_id") != request_id
                        and candidate.get("spare_sr") == conflict.get("incoming")
                        for candidate in self.store.iter_spare_requests()
                    ):
                        raise ValidationError(
                            f"Spare SR {conflict.get('incoming')} already belongs to another active request"
                        )
                    (request if field == "spare_sr" else target)[key] = conflict.get("incoming")
                conflict["resolved_at"] = iso_now()
                conflict["resolution"] = resolution
                conflict["note"] = note.strip()
                request_history(
                    request,
                    "conflict-resolved",
                    {
                        "itemId": item_id,
                        "field": field,
                        "resolution": resolution,
                        "note": note.strip(),
                    },
                )
                self.store.write_spare_request(staging, request)
            self._touch_data("spare-request-conflict-resolution")
            return {"request": self.spare_request(request_id)}
        finally:
            self._operation_lock.release()

    def export_spare_return(self, selections: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(selections, list) or not selections:
            raise ValidationError("Choose at least one RMA for the return workbook")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        result: dict[str, Any] | None = None
        persisted = False
        try:
            requests = list(self.store.iter_spare_requests())
            by_item = {
                item.get("item_id"): (request, item)
                for request in requests
                for item in request.get("items", [])
            }
            prepared: list[tuple[dict[str, Any], dict[str, Any], str]] = []
            for selection in selections:
                item_id = str(selection.get("itemId") or "")
                pair = by_item.get(item_id)
                if pair is None:
                    raise ValidationError(f"Active item {item_id} was not found")
                request, item = pair
                if not item.get("rma"):
                    raise ValidationError(f"Item {item_id} has no RMA")
                condition = str(selection.get("condition") or "Faulty").title()
                prepared.append((request, item, condition))
            result = export_return_workbook(
                self._spare_template("spare_return_template_path", "Faulty Return XLSX"),
                self._spare_export_root(),
                prepared,
            )
            timestamp = iso_now()
            selected = {item.get("item_id"): condition for _, item, condition in prepared}
            with self.store.transaction(
                "spare-return-export",
                {"items": sorted(selected), "filename": result["filename"]},
            ) as staging:
                for request_id in {request["request_id"] for request, _, _ in prepared}:
                    request = self.store.read_spare_request(request_id, staging)
                    affected = []
                    for item in request.get("items", []):
                        condition = selected.get(item.get("item_id"))
                        if condition is None:
                            continue
                        item["return_condition"] = condition
                        item["return_exported_at"] = timestamp
                        item["return_export_filename"] = result["filename"]
                        item["return_batch_id"] = result["filename"]
                        affected.append(item["item_id"])
                    request["export"].setdefault("returns", []).append(
                        {
                            "filename": result["filename"],
                            "path": result["path"],
                            "subject": result["subject"],
                            "created_at": timestamp,
                            "item_ids": affected,
                        }
                    )
                    request_history(
                        request,
                        "return-exported",
                        {"filename": result["filename"], "items": affected},
                    )
                    self.store.write_spare_request(staging, request)
            persisted = True
            self._touch_data("spare-return-export")
            return result
        except Exception:
            if result is not None and not persisted:
                exported_path = str(result.get("path") or "").strip()
                if exported_path:
                    Path(exported_path).unlink(missing_ok=True)
            raise
        finally:
            self._operation_lock.release()

    def archive_spare_items(
        self,
        *,
        item_ids: list[str],
        reason: str,
        note: str,
        manual_override: bool = False,
    ) -> dict[str, Any]:
        normalized_reason = str(reason or "").strip().casefold()
        if normalized_reason not in {"returned", "cancelled"}:
            raise ValidationError("Archive reason must be returned or cancelled")
        clean_ids = {str(value or "").strip() for value in item_ids if str(value or "").strip()}
        if not clean_ids:
            raise ValidationError("Choose at least one item to archive")
        if normalized_reason == "cancelled" and not note.strip():
            raise ValidationError("Cancellation requires a reason note")
        if manual_override and not note.strip():
            raise ValidationError("Manual return confirmation requires a note")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            requests = list(self.store.iter_spare_requests())
            pairs = {
                item.get("item_id"): (request, item)
                for request in requests
                for item in request.get("items", [])
                if item.get("item_id") in clean_ids
            }
            missing = sorted(clean_ids - set(pairs))
            if missing:
                raise ValidationError("Active items were not found: " + ", ".join(missing))
            if normalized_reason == "returned":
                for item_id, (_, item) in pairs.items():
                    if not item.get("warehouse_candidate_at") and not manual_override:
                        raise ValidationError(
                            f"{item_id} has no exact warehouse email candidate. Use manual override with a note if verified independently."
                        )
            closed_path = self._closed_workbook_path(required=True)
            assert closed_path is not None
            archive_results = []
            for request, item in pairs.values():
                archive_results.append(
                    append_archived_item(
                        closed_path,
                        request,
                        item,
                        reason=normalized_reason,
                        note=note.strip() or None,
                    )
                )
            with self.store.transaction(
                "spare-request-archive",
                {
                    "items": sorted(clean_ids),
                    "reason": normalized_reason,
                    "manual_override": manual_override,
                },
            ) as staging:
                for request_id in {request["request_id"] for request, _ in pairs.values()}:
                    request = self.store.read_spare_request(request_id, staging)
                    request["items"] = [
                        item for item in request.get("items", []) if item.get("item_id") not in clean_ids
                    ]
                    if request["items"]:
                        request_history(
                            request,
                            "items-archived",
                            {"items": sorted(clean_ids), "reason": normalized_reason, "note": note.strip() or None},
                        )
                        self.store.write_spare_request(staging, request)
                    else:
                        self.store.delete_spare_request(request_id, staging)
            self.store.purge_state_backups_for_closed_tickets()
            self._touch_data("spare-request-archive")
            return {
                "archived": sorted(clean_ids),
                "reason": normalized_reason,
                "closedPath": str(closed_path),
                "results": archive_results,
            }
        finally:
            self._operation_lock.release()

    def purge_spare_data(self, *, item_ids: list[str] | None = None) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            closed_path = self._closed_workbook_path()
            result = (
                purge_archived_items(closed_path, item_ids=set(item_ids or []))
                if closed_path is not None
                else {"removed": 0, "remaining": 0}
            )
            backups_removed = (
                purge_spare_archive_backups(closed_path, remove_all=True)
                if closed_path is not None and result.get("removed")
                else 0
            )
            result["backupsRemoved"] = backups_removed
            self._touch_data("spare-request-purge")
            return result
        finally:
            self._operation_lock.release()

    def enforce_spare_retention(self) -> dict[str, Any]:
        cutoff = datetime.now(ECUADOR_TIMEZONE) - timedelta(days=180)
        active_removed = 0
        with self.store.transaction(
            "spare-request-retention", {"before": cutoff.isoformat()}, backup=False
        ) as staging:
            active_removed = purge_old_active_email_bodies(
                self.store, staging, before=cutoff
            )
        closed_path = self._closed_workbook_path()
        archived = (
            purge_archived_items(closed_path, archived_before=cutoff)
            if closed_path is not None
            else {"removed": 0, "remaining": 0}
        )
        state_backups_removed = 0
        cutoff_naive = cutoff.replace(tzinfo=None)
        for path in self.store.list_backups():
            modified = datetime.fromtimestamp(path.stat().st_mtime)
            if active_removed or modified < cutoff_naive:
                path.unlink(missing_ok=True)
                state_backups_removed += 1
        archive_backups_removed = (
            purge_spare_archive_backups(
                closed_path,
                before=cutoff,
                remove_all=bool(archived.get("removed")),
            )
            if closed_path is not None
            else 0
        )
        if active_removed or archived.get("removed"):
            self._touch_data("spare-request-retention")
        return {
            "activeEmailBodies": active_removed,
            "archive": archived,
            "stateBackups": state_backups_removed,
            "archiveBackups": archive_backups_removed,
        }

    def edit_ticket(
        self,
        ticket_id: str,
        *,
        changes: dict[str, Any],
        expected_revision: str,
    ) -> dict[str, Any]:
        normalized_ticket_id = normalize_ticket_id(ticket_id)
        if not self.store.ticket_file(normalized_ticket_id).is_file():
            if self._closed_archive_ticket(normalized_ticket_id) is not None:
                raise ValidationError(
                    f"SR {normalized_ticket_id} is finalized and read-only in Closed.xlsx"
                )
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            result = edit_ticket_through_pendings(
                self.store,
                normalized_ticket_id,
                changes,
                expected_revision=expected_revision,
            )
        finally:
            self._operation_lock.release()
        recreated = result.get("pendingsRecreated")
        if isinstance(recreated, dict) and recreated.get("created"):
            notice = str(recreated.get("notice") or "").strip()
            self.latest_startup.warnings = [
                warning
                for warning in self.latest_startup.warnings
                if "Pendings.xlsx was not found" not in warning
            ]
            if notice and notice not in self.latest_startup.notices:
                self.latest_startup.notices.append(notice)
        recreated_workbook = bool(
            isinstance(recreated, dict) and recreated.get("created")
        )
        if result.get("changed") or recreated_workbook:
            self._touch_data(
                "ticket-edit" if result.get("changed") else "pendings-recreation"
            )
        response = {
            "changed": bool(result.get("changed")),
            "changedFields": result.get("changedFields", []),
            # The browser replaces its open detail with this response before
            # the dataset event is processed.  Return the same complete shape
            # as GET /api/tickets/<id>, including history and MOPs, so a
            # successful edit can never leave React with a partial object.
            "ticket": self.ticket(normalized_ticket_id),
        }
        if isinstance(recreated, dict) and recreated.get("created"):
            response["pendingsRecreated"] = recreated
        return response

    def get_settings(self) -> dict[str, Any]:
        return settings_payload(self.store)

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing configuration")
        try:
            result = update_settings(self.store, updates)
        finally:
            self._operation_lock.release()
        self._schedule_wakeup.set()
        self.broker.publish("configuration", {"changed": result.get("changed", [])})
        return result

    def scan_outlook(self, directory: str) -> list[dict[str, Any]]:
        return outlook_candidates(self.store, directory)

    def submit_job(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        factories: dict[str, Callable[[JobContext], Any]] = {
            "startup": lambda context: self._run_startup(context, startup=True),
            "query": lambda context: self._run_startup(context, startup=False),
            "advanced": self._run_advanced,
            "publish": lambda context: self._run_publish(context, payload),
            "email-fetch": lambda context: self._run_email_fetch(context, rebuild=False),
            "email-rebuild": lambda context: self._run_email_fetch(context, rebuild=True),
            "email-sync": self._run_email_sync,
            "restore": lambda context: self._run_restore(context, payload),
            "doctor": self._run_doctor,
            "mop": lambda context: self._run_mop(context, payload),
        }
        function = factories.get(kind)
        if function is None:
            raise ValidationError(f"Unknown Zeus operation: {kind}")
        cancellable = kind in {"startup", "query", "email-fetch", "email-rebuild"}
        return self.jobs.submit(
            kind,
            self.JOB_LABELS[kind],
            function,
            cancellable=cancellable,
        )

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        try:
            return self.jobs.cancel(job_id)
        except KeyError as exc:
            raise NotFoundError(f"Job {job_id} was not found") from exc
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc

    def _exclusive_job(self, context: JobContext, function: Callable[[], Any]) -> Any:
        context.report("waiting", "Waiting for the data store")
        with self._operation_lock:
            context.raise_if_cancelled()
            return function()

    def _run_startup(self, context: JobContext, *, startup: bool) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            context.report("pendings", "Reading Pendings.xlsx")
            result = run_startup(
                self.store,
                recreate_missing_pendings=not startup,
                cancel_event=context.cancel_event,
                progress=context.progress_callback,
            )
            try:
                context.report("retention", "Applying 180-day Spare Request retention")
                retention = self.enforce_spare_retention()
                removed = int(retention.get("activeEmailBodies") or 0) + int(
                    retention.get("archive", {}).get("removed") or 0
                )
                if removed:
                    result.notices.append(
                        f"Spare Request retention purged {removed} record(s) older than 180 days."
                    )
            except Exception as exc:
                result.warnings.append(f"Spare Request retention could not run: {exc}")
            context.report("dashboard", "Updating the dashboard")
            self.latest_startup = result
            self._touch_data("startup" if startup else "manual-query")
            return result.to_dict()

        return self._exclusive_job(context, operation)

    def _run_advanced(self, context: JobContext) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            context.report("advanced-search", "Checking the newest Advanced Search workbook")
            result = reconcile_advanced_and_new_mail(
                self.store,
                cancel_event=context.cancel_event,
                progress=context.progress_callback,
            )
            self.latest_startup.warnings = result.warnings
            self.latest_startup.notices = result.notices
            self._touch_data("advanced-search")
            return result.to_dict()

        return self._exclusive_job(context, operation)

    def _run_publish(self, context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            directory = self.store.configured_directory("workbook_directory")
            if directory is None:
                raise FeatureUnavailableError("Configure the workbook folder before publishing")
            create_missing = bool(payload.get("createMissing", False))
            missing = [
                name
                for name in ("Pendings.xlsx", "Closed.xlsx")
                if not (directory / name).is_file()
            ]
            if missing and not create_missing:
                raise ValidationError(
                    "One or both managed workbooks are missing. Confirm creation explicitly.",
                    details={"missing": missing, "requiresConfirmation": True},
                )
            context.report("validate", "Validating managed workbooks")
            result = publish_operational_workbooks(
                self.store,
                directory,
                create_missing=create_missing,
            )
            self._touch_data("publish")
            return result

        return self._exclusive_job(context, operation)

    def _require_outlook(self) -> None:
        path = self.store.config.get("paths", {}).get("outlook_store_path")
        if not path:
            raise FeatureUnavailableError(
                "Outlook email is disabled. Configure an Outlook store to use this operation."
            )
        if not Path(str(path)).is_file():
            raise FeatureUnavailableError("The configured Outlook store is not available")

    def _run_email_fetch(self, context: JobContext, *, rebuild: bool) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            self._require_outlook()
            context.report("eligibility", "Refreshing ticket eligibility")
            sync_newest_advanced_search(self.store)
            context.report("outlook", "Opening Classic Outlook")
            result = fetch_and_commit_outlook(
                self.store,
                full_scan=True if rebuild else None,
                cancel_event=context.cancel_event,
                progress=context.progress_callback,
            )
            self._touch_data("email-rebuild" if rebuild else "email-fetch")
            return result

        return self._exclusive_job(context, operation)

    def _run_email_sync(self, context: JobContext) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            self._require_outlook()
            context.report("email-sync", "Applying staged email to Markdown records")
            result = synchronize_staged_email(self.store)
            self._touch_data("email-sync")
            return result

        return self._exclusive_job(context, operation)

    def _run_restore(self, context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            name = str(payload.get("backup") or "")
            selected = self._pendings_backup_path(name)
            directory = self.store.configured_directory("workbook_directory")
            if directory is None:
                raise FeatureUnavailableError("Configure the workbook folder before restoring")
            context.report("preview", f"Validating {selected.name}")
            preview = preview_pendings_restore(self.store, selected)
            if not bool(payload.get("confirmed")):
                raise ValidationError(
                    "Restoring a backup requires confirmation",
                    details={"preview": preview, "requiresConfirmation": True},
                )
            result = restore_pendings_backup(self.store, selected, directory)
            self._touch_data("pendings-restore")
            return result

        return self._exclusive_job(context, operation)

    def _pendings_backup_path(self, name: str) -> Path:
        directory = self.store.configured_directory("workbook_directory")
        if directory is None:
            raise FeatureUnavailableError("Configure the workbook folder before restoring")
        available = {path.name: path for path in list_pendings_backups(directory)}
        selected = available.get(name)
        if selected is None:
            raise ValidationError("Choose an available Pendings backup")
        return selected

    def preview_pendings_backup(self, name: str) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before previewing a restore")
        try:
            return preview_pendings_restore(self.store, self._pendings_backup_path(name))
        finally:
            self._operation_lock.release()

    def _run_doctor(self, context: JobContext) -> dict[str, Any]:
        return self._exclusive_job(context, self.doctor)

    def _run_mop(self, context: JobContext, payload: dict[str, Any]) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            ticket_id = normalize_ticket_id(payload.get("ticketId"))
            template = self._validated_template(str(payload.get("template") or ""))
            context.report("mop", f"Rendering {template.name}")
            result = generate_mop(
                self.store,
                ticket_id,
                template,
                allow_missing=bool(payload.get("allowMissing", False)),
            )
            self._touch_data("mop")
            return result

        return self._exclusive_job(context, operation)

    def doctor(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "store": "ok",
            "paths": {},
            "tickets": 0,
            "diagnosticLog": str(diagnostic_log_path(self.store.config_home)),
        }
        try:
            self.store.validate_current(self.store.current)
            result["tickets"] = sum(1 for _ in self.store.iter_ticket_ids())
        except Exception as exc:
            result["store"] = f"error: {exc}"
            record_exception(self.store.config_home, "ZEUS DOCTOR", exc)
        for key in (
            "workbook_directory",
            "advanced_search_directory",
            "outlook_store_path",
            "template_directory",
            "spare_parts_export_directory",
            "spare_request_template_path",
            "spare_return_template_path",
        ):
            path = self.store.configured_directory(key)
            result["paths"][key] = {
                "path": str(path) if path else None,
                "exists": bool(path and path.exists()),
            }
        return result

    def pendings_backups(self) -> list[dict[str, Any]]:
        directory = self.store.configured_directory("workbook_directory")
        if directory is None:
            return []
        return [
            {
                "name": path.name,
                "size": path.stat().st_size,
                "modifiedAt": path.stat().st_mtime,
            }
            for path in list_pendings_backups(directory)[:50]
        ]

    def templates(self) -> list[dict[str, Any]]:
        directory = self.store.configured_directory("template_directory")
        if directory is None or not directory.is_dir():
            return []
        return [
            {"name": path.name, "path": str(path), "size": path.stat().st_size}
            for path in sorted(directory.glob("*.docx"), key=lambda item: item.name.casefold())
        ]

    def _validated_template(self, value: str) -> Path:
        if not value:
            raise ValidationError("Choose a MOP template")
        requested = Path(value).expanduser().resolve()
        directory = self.store.configured_directory("template_directory")
        if directory is None or requested.parent != directory.resolve():
            raise ValidationError("The template must be inside the configured template folder")
        if not requested.is_file() or requested.suffix.lower() != ".docx":
            raise ValidationError("The selected MOP template is not available")
        return requested

    def list_mops(self, ticket_id: str) -> list[dict[str, Any]]:
        try:
            directory = self.store.ticket_dir(normalize_ticket_id(ticket_id)) / "mops"
        except ValueError:
            return []
        if not directory.is_dir():
            return []
        return [
            {
                "name": path.name,
                "size": path.stat().st_size,
                "modifiedAt": path.stat().st_mtime,
            }
            for path in sorted(
                directory.glob("*.docx"),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
        ]

    def ticket_history(self, ticket_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        normalized = normalize_ticket_id(ticket_id)
        path = self.store.audit_file
        if not path.is_file():
            return []
        events: list[dict[str, Any]] = []
        try:
            with path.open("r", encoding="utf-8") as handle:
                lines = handle.readlines()
        except OSError:
            return []
        for line in reversed(lines):
            try:
                event = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            summary_text = json.dumps(event.get("summary", {}), ensure_ascii=False)
            if normalized not in summary_text:
                continue
            events.append(
                {
                    "timestamp": event.get("timestamp"),
                    "action": event.get("action"),
                    "summary": event.get("summary", {}),
                }
            )
            if len(events) >= limit:
                break
        return events
