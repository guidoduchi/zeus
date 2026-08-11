from __future__ import annotations

import json
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from ..diagnostics import diagnostic_log_path, record_exception
from ..database_maintenance import (
    CURRENT_DATABASE_SCHEMA_VERSION,
    inspect_database,
    maintain_database,
)
from ..excel_export import (
    list_pendings_backups,
    preview_pendings_restore,
    publish_operational_workbooks,
    restore_pendings_backup,
)
from ..excel_import import read_closed, validate_closed_against_index
from ..fault_tags import (
    FaultTagError,
    create_fault_tag_record,
    fault_tag_history,
    fault_tag_status,
    next_fault_tag_id,
    normalize_return_site,
)
from ..mail import MailFetchCancelled, fetch_and_commit_outlook, synchronize_staged_email
from ..mop import generate_mop
from ..reference_data import (
    ReferenceDataError,
    combined_reference_data,
    load_bom_catalog,
    load_global_reference_data,
    load_user_profile,
    save_bom_catalog,
    save_global_reference_data,
    save_user_profile,
    serialize_user_profile,
    user_profile_payload,
)
from ..spare_request_excel import (
    append_archived_item,
    archived_rma_values,
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
    active_source_part_keys,
    create_request_record,
    LIFECYCLE_STAGE_LABELS,
    lifecycle_stage,
    lifecycle_effect_suppressed,
    next_request_id,
    normalize_profile,
    normalize_report_date,
    normalize_request_lines,
    normalize_rma,
    normalize_rma_aliases,
    normalize_spare_sr,
    normalize_tt,
    request_filename,
    request_history,
    request_subject,
    source_part_key,
)
from ..storage_migration import (
    StorageMigrationError,
    prepare_data_migration,
    storage_status,
)
from ..startup import StartupResult, reconcile_advanced_and_new_mail, run_startup
from ..store import StoreError, ZeusStore
from ..tickets import empty_email, newline_values, normalize_local
from ..utils import iso_now, local_today, normalize_ticket_id, parse_datetime
from .edits import (
    confirm_maintenance_window_in_database,
    edit_ticket_in_database,
    edit_tickets_in_database,
)
from .errors import (
    BusyError,
    ConflictError,
    FeatureUnavailableError,
    NotFoundError,
    SetupRequiredError,
    ValidationError,
)
from .jobs import EventBroker, JobCancelled, JobContext, JobManager
from .serialization import (
    DEFAULT_SORT_DIRECTIONS,
    SPARE_PART_DEFAULT_SORT_DIRECTIONS,
    SPARE_REQUEST_DEFAULT_SORT_DIRECTIONS,
    dashboard_payload,
    serialize_spare_request_detail,
    serialize_ticket_summary,
    serialize_ticket_detail,
    spare_parts_dashboard_payload,
    spare_request_revision,
    spare_requests_dashboard_payload,
)
from .settings import outlook_candidates, settings_payload, update_settings
from .upcoming import (
    complete_upcoming_window,
    schedule_upcoming_window,
    upcoming_payload,
)


class ApplicationService:
    """The single controlled boundary between Zeus core logic and the web UI."""

    JOB_LABELS = {
        "startup": "Starting Zeus",
        "query": "Checking Advanced Search",
        "advanced": "Checking Advanced Search",
        "publish": "Publishing Pendings and Closed",
        "email-fetch": "Fetching Outlook email",
        "email-sync": "Synchronizing staged email",
        "email-rebuild": "Rebuilding Outlook email history",
        "restore": "Restoring database work fields from a legacy backup",
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
        self._dashboard_cache_lock = threading.Lock()
        self._dashboard_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
        self._closed_archive_lock = threading.Lock()
        self._closed_archive_signature: tuple[Any, ...] | None = None
        self._closed_archive_cache: tuple[dict[str, Any], ...] = ()
        self._dataset_revision = 1
        self._started = False
        self._stopping = threading.Event()
        self._schedule_wakeup = threading.Event()
        self._scheduler: threading.Thread | None = None
        self._next_query_at: float | None = None
        self._next_email_fetch_at: float | None = None
        self._next_email_sync_at: float | None = None
        self._migration_pending = False
        self.latest_startup = StartupResult()

    @property
    def dataset_revision(self) -> int:
        with self._revision_lock:
            return self._dataset_revision

    def _touch_data(self, reason: str) -> None:
        with self._revision_lock:
            self._dataset_revision += 1
            revision = self._dataset_revision
        with self._dashboard_cache_lock:
            self._dashboard_cache.clear()
        self.broker.publish(
            "dataset",
            {"revision": revision, "reason": reason, "timestamp": iso_now()},
        )

    def start(self) -> dict[str, Any]:
        if not self.profile_complete():
            self.latest_startup = StartupResult(
                notices=["Complete the required local contact profile to start Zeus operations."]
            )
            return {"status": "blocked", "kind": "startup", "reason": "profile_required"}
        capacity = storage_status(self.store)
        if capacity["lowSpace"]:
            self.latest_startup = StartupResult(
                warnings=[
                    "Zeus paused background operations because its data drive has less "
                    "than 20 MiB free. Move the data folder from Configuration."
                ]
            )
            return {"status": "blocked", "kind": "startup", "reason": "low_storage"}
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
            deadlines = [
                deadline
                for deadline in (
                    self._next_query_at,
                    self._next_email_fetch_at,
                    self._next_email_sync_at,
                )
                if deadline is not None
            ]
            remaining = (
                max(0.0, min(deadlines) - time.monotonic()) if deadlines else 30.0
            )
            if self._schedule_wakeup.wait(min(remaining, 30.0)):
                self._schedule_wakeup.clear()
                self._reset_schedule()
                continue
            now = time.monotonic()
            if self._next_query_at is not None and now >= self._next_query_at:
                self._submit_scheduled_query()
                self._next_query_at = self._next_deadline(
                    int(
                        self.store.config.get("advanced_search", {}).get(
                            "poll_interval_minutes", 15
                        )
                    )
                )
            if (
                self._next_email_fetch_at is not None
                and now >= self._next_email_fetch_at
            ):
                self.submit_job("email-fetch", {"scheduled": True})
                self._next_email_fetch_at = self._next_deadline(
                    int(
                        self.store.config.get("email", {}).get(
                            "fetch_interval_minutes", 60
                        )
                    )
                )
            if (
                self._next_email_sync_at is not None
                and now >= self._next_email_sync_at
            ):
                self.submit_job("email-sync", {"scheduled": True})
                self._next_email_sync_at = self._next_deadline(
                    int(
                        self.store.config.get("email", {}).get(
                            "sync_interval_minutes", 60
                        )
                    )
                )

    def _submit_scheduled_query(self) -> dict[str, Any]:
        """Use the same Advanced Search-only query path for the timer."""

        # Merely loading a browser page never reaches this path.
        if self._migration_pending:
            return {
                "status": "blocked",
                "kind": "query",
                "reason": "data_migration",
            }
        return self.submit_job("query", {"scheduled": True})

    def _reset_schedule(self) -> None:
        config = self.store.config
        self._next_query_at = self._next_deadline(
            int(
                config.get("advanced_search", {}).get(
                    "poll_interval_minutes", 15
                )
            ),
            startup_only=False,
        )
        email = config.get("email", {})
        outlook_path = config.get("paths", {}).get("outlook_store_path")
        email_available = bool(
            outlook_path and Path(str(outlook_path)).is_file()
        )
        self._next_email_fetch_at = (
            self._next_deadline(int(email.get("fetch_interval_minutes", 60)))
            if email_available
            else None
        )
        self._next_email_sync_at = (
            self._next_deadline(int(email.get("sync_interval_minutes", 60)))
            if email_available and email.get("sync_mode") == "scheduled"
            else None
        )

    @staticmethod
    def _next_deadline(
        minutes: int, *, startup_only: bool = True
    ) -> float | None:
        # Email's -1 value means startup only. Advanced Search has no -1
        # setting, but treating any non-positive value as unscheduled makes the
        # timer robust to a manually repaired configuration file.
        if minutes <= 0 or (startup_only and minutes == -1):
            return None
        return time.monotonic() + minutes * 60

    def bootstrap_payload(self) -> dict[str, Any]:
        outlook_path = self.store.config.get("paths", {}).get("outlook_store_path")
        try:
            profile = user_profile_payload(self.store.root)
            profile_error = None
        except ReferenceDataError as exc:
            profile = {"schemaVersion": 1, "complete": False, "profile": None}
            profile_error = str(exc)
        startup = self.latest_startup.to_dict()
        startup["notices"] = [
            *list(getattr(self.store, "storage_notices", [])),
            *startup.get("notices", []),
        ]
        capacity = storage_status(self.store)
        state: dict[str, Any] = {}
        maintenance_windows_due: list[dict[str, Any]] = []
        if not self._operation_lock.acquire(blocking=False):
            database_maintenance = {
                "status": "busy",
                "currentSchemaVersion": CURRENT_DATABASE_SCHEMA_VERSION,
                "storedSchemaVersion": int(
                    state.get("database_schema_version") or 2
                ),
                "ticketCount": 0,
                "spareRequestCount": 0,
                "outdatedTicketCount": 0,
                "outdatedTicketIds": [],
                "repairableMarkdownCount": 0,
                "repairableMarkdown": [],
                "reviewCount": 0,
                "reviewRecords": [],
                "blockedCount": 0,
                "blockedRecords": [],
                "canApply": False,
                "backupRequired": True,
                "message": "Database inspection will resume after the current operation.",
            }
        else:
            try:
                try:
                    state = self.store.state()
                    database_maintenance = inspect_database(self.store)
                except Exception as exc:
                    database_maintenance = {
                        "status": "blocked",
                        "currentSchemaVersion": CURRENT_DATABASE_SCHEMA_VERSION,
                        "storedSchemaVersion": int(
                            state.get("database_schema_version") or 2
                        ),
                        "ticketCount": 0,
                        "spareRequestCount": 0,
                        "outdatedTicketCount": 0,
                        "outdatedTicketIds": [],
                        "repairableMarkdownCount": 0,
                        "repairableMarkdown": [],
                        "reviewCount": 0,
                        "reviewRecords": [],
                        "blockedCount": 1,
                        "blockedRecords": [
                            {"path": "database", "message": str(exc)}
                        ],
                        "canApply": False,
                        "backupRequired": True,
                    }
                try:
                    for ticket in self.store.iter_tickets():
                        summary = serialize_ticket_summary(ticket, self.store.config)
                        if summary.get("maintenanceWindow", {}).get(
                            "confirmationRequired"
                        ):
                            maintenance_windows_due.append(summary)
                except Exception:
                    # The maintenance status above owns database-corruption reporting;
                    # bootstrap must still open Configuration so recovery remains possible.
                    maintenance_windows_due = []
            finally:
                self._operation_lock.release()
        if database_maintenance.get("status") == "upgrade_available":
            startup["notices"] = [
                "A Zeus database format upgrade is available in Configuration → Database maintenance.",
                *startup.get("notices", []),
            ]
        elif database_maintenance.get("status") == "repair_available":
            startup["notices"] = [
                "Readable Markdown repair is available in Configuration → Database maintenance.",
                *startup.get("notices", []),
            ]
        elif database_maintenance.get("status") == "blocked":
            startup["warnings"] = [
                "Database maintenance found a record that cannot be safely repaired automatically.",
                *startup.get("warnings", []),
            ]
        return {
            "datasetRevision": self.dataset_revision,
            "eventSequence": self.broker.sequence,
            "startup": startup,
            "jobs": self.jobs.snapshots(),
            "onboarding": {
                "required": not bool(profile.get("complete")),
                "profile": profile.get("profile"),
                "error": profile_error,
            },
            "storage": capacity,
            "databaseMaintenance": database_maintenance,
            "maintenanceWindowsDue": maintenance_windows_due,
            "spareRequestExport": self.spare_export_setup(),
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
            "emailSchedule": {
                "fetchIntervalMinutes": int(
                    self.store.config.get("email", {}).get(
                        "fetch_interval_minutes", 60
                    )
                ),
                "syncMode": str(
                    self.store.config.get("email", {}).get(
                        "sync_mode", "after_fetch"
                    )
                ),
                "syncIntervalMinutes": int(
                    self.store.config.get("email", {}).get(
                        "sync_interval_minutes", 60
                    )
                ),
                "fetchScheduled": self._next_email_fetch_at is not None,
                "syncScheduled": self._next_email_sync_at is not None,
            },
            "appearance": {
                "fontScale": str(
                    self.store.config.get("web", {}).get("font_scale") or "standard"
                ),
                "showDetailHistory": bool(
                    self.store.config.get("web", {}).get("show_detail_history", False)
                ),
            },
        }

    def profile_complete(self) -> bool:
        try:
            return load_user_profile(self.store.root) is not None
        except ReferenceDataError:
            return False

    def require_setup(self) -> None:
        if not self.profile_complete():
            raise SetupRequiredError(
                "Complete your local contact profile before using Zeus"
            )
        if self._migration_pending:
            raise BusyError("Zeus is restarting to finish the data-folder migration")

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

    def spare_export_setup(self) -> dict[str, Any]:
        paths = self.store.config.get("paths", {})
        request_missing: list[dict[str, str]] = []
        return_missing: list[dict[str, str]] = []
        export_root = self.store.configured_directory("spare_parts_export_directory")
        if export_root is None or not export_root.is_dir():
            item = {
                "key": "paths.spare_parts_export_directory",
                "label": "Spare Request export folder",
            }
            request_missing.append(item)
            return_missing.append(item)
        for key, label, target in (
            ("spare_request_template_path", "Spare Request XLSX template", request_missing),
            ("spare_return_template_path", "Faulty Return XLSX template", return_missing),
        ):
            raw = paths.get(key)
            path = Path(str(raw)).expanduser().resolve() if raw else None
            if path is None or not path.is_file() or path.suffix.lower() != ".xlsx":
                target.append({"key": f"paths.{key}", "label": label})
        return {
            "requestReady": not request_missing,
            "returnReady": not return_missing,
            "requestMissing": request_missing,
            "returnMissing": return_missing,
        }

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
        if workspace == "spare-requests" and view not in {
            "active",
            "eligible",
            "completed",
            "fault-tags",
        }:
            raise ValidationError(f"Unsupported Spare Requests view: {view}")
        revision = self.dataset_revision
        cache_key = (
            revision,
            local_today().isoformat(),
            workspace,
            sort,
            direction,
            search,
            view,
        )
        with self._dashboard_cache_lock:
            cached = self._dashboard_cache.get(cache_key)
        if cached is not None:
            return deepcopy(cached)
        arguments: dict[str, Any] = {
            "sort": sort,
            "direction": direction,
            "search": search,
            "dataset_revision": revision,
        }
        if workspace == "spare-parts":
            arguments["closed_tickets"] = self._closed_archive_tickets()
        elif workspace == "spare-requests":
            arguments["view"] = view
            arguments["closed_path"] = self._closed_workbook_path()
        result = serializer(self.store, **arguments)
        with self._dashboard_cache_lock:
            if len(self._dashboard_cache) >= 64:
                self._dashboard_cache.pop(next(iter(self._dashboard_cache)))
            self._dashboard_cache[cache_key] = deepcopy(result)
        return result

    def upcoming_maintenance_windows(self) -> dict[str, Any]:
        return upcoming_payload(self.store, dataset_revision=self.dataset_revision)

    def schedule_upcoming_maintenance_window(
        self,
        *,
        planned_date: Any,
        start_time: Any,
        ticket_ids: Any,
    ) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            window_id = schedule_upcoming_window(
                self.store,
                planned_date=planned_date,
                start_time=start_time,
                ticket_ids=ticket_ids,
            )
        finally:
            self._operation_lock.release()
        self._touch_data("upcoming-maintenance-window-schedule")
        return {
            "windowId": window_id,
            "upcoming": self.upcoming_maintenance_windows(),
        }

    def complete_upcoming_maintenance_window(
        self,
        window_id: str,
        *,
        expected_revision: str,
        outcomes: Any,
        finish_time: Any = None,
    ) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            ticket_ids = complete_upcoming_window(
                self.store,
                window_id,
                expected_revision=expected_revision,
                outcomes=outcomes,
                finish_time=finish_time,
            )
        finally:
            self._operation_lock.release()
        self._touch_data("upcoming-maintenance-window-completion")
        return {
            "windowId": window_id,
            "ticketIds": ticket_ids,
            "upcoming": self.upcoming_maintenance_windows(),
        }

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
        detail = serialize_ticket_detail(
            ticket,
            self.store.config,
            active_requests=self.store.iter_spare_requests(),
        )
        detail["history"] = self.ticket_history(normalized_ticket_id)
        detail["mops"] = self.list_mops(normalized_ticket_id)
        return detail

    def spare_request(self, request_id: str) -> dict[str, Any]:
        try:
            request = self.store.read_spare_request(request_id)
        except (StoreError, ValueError) as exc:
            raise NotFoundError(f"Spare Request {request_id} was not found") from exc
        return serialize_spare_request_detail(request, self.store.config)

    def user_profile(self) -> dict[str, Any]:
        try:
            return user_profile_payload(self.store.root)
        except ReferenceDataError as exc:
            raise ValidationError(str(exc)) from exc

    def save_user_profile(self, value: dict[str, Any]) -> dict[str, Any]:
        if self._migration_pending:
            raise BusyError("Zeus is restarting to finish the data-folder migration")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing your profile")
        try:
            was_complete = self.profile_complete()
            result = save_user_profile(self.store.root, value)
            self.store.append_audit(
                "user-profile-update",
                {"created": not was_complete, "fields": ["name", "email", "phone", "username", "photo"]},
            )
        except (OSError, ReferenceDataError) as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()
        self.broker.publish("configuration", {"changed": ["user-profile"]})
        if not was_complete:
            result["startup"] = self.start()
        return result

    def global_reference_data(self) -> dict[str, Any]:
        try:
            result = load_global_reference_data(self.store.root)
            result["profile"] = serialize_user_profile(load_user_profile(self.store.root))
            return result
        except ReferenceDataError as exc:
            raise ValidationError(str(exc)) from exc

    def save_global_reference_data(self, value: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing global data")
        try:
            result = save_global_reference_data(self.store.root, value)
            self.store.append_audit(
                "global-reference-data-update",
                {
                    "organizations": len(result["organizations"]),
                    "customers": len(result["customers"]),
                    "sites": len(result["sites"]),
                    "requesters": len(result["requesters"]),
                },
            )
        except (OSError, ReferenceDataError) as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()
        self.broker.publish("configuration", {"changed": ["global-reference-data"]})
        return result

    def bom_catalog(self) -> dict[str, Any]:
        try:
            return load_bom_catalog(self.store.root)
        except ReferenceDataError as exc:
            raise ValidationError(str(exc)) from exc

    def save_bom_catalog(self, value: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing the BOM catalog")
        try:
            result = save_bom_catalog(self.store.root, value)
            self.store.append_audit("bom-catalog-update", {"rows": len(result["boms"])})
        except (OSError, ReferenceDataError) as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()
        self.broker.publish("configuration", {"changed": ["bom-catalog"]})
        return result

    def spare_reference_data(self) -> dict[str, Any]:
        try:
            result = combined_reference_data(self.store.root)
        except ReferenceDataError as exc:
            raise ValidationError(str(exc)) from exc
        result["exportSetup"] = self.spare_export_setup()
        return result

    def save_spare_reference_data(self, value: dict[str, Any]) -> dict[str, Any]:
        """Compatibility boundary for 3.1.1 clients using one manager payload."""

        globals_value = {
            "organizations": value.get("organizations", []),
            "customers": value.get("customers", []),
            "sites": value.get("sites", []),
            "requesters": value.get("requesters", []),
        }
        self.save_global_reference_data(globals_value)
        self.save_bom_catalog({"boms": value.get("boms", [])})
        return self.spare_reference_data()

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

        report_date = first("Report Date", "ReportDate", "Created Date")

        lines: list[dict[str, Any]] = []
        occupied = active_source_part_keys(self.store.iter_spare_requests())
        for device_index, device in enumerate(
            ticket.get("local", {}).get("spare_parts", []), start=1
        ):
            device_number = int(device.get("device_number") or device_index)
            for part_index, part in enumerate(device.get("parts") or [], start=1):
                part_number = int(part.get("part_number") or part_index)
                if not part.get("bom"):
                    continue
                if part.get("submitted_request_ids") or (
                    normalized,
                    device_number,
                    part_number,
                ) in occupied:
                    continue
                slots = newline_values(part.get("slot"))
                lines.append(
                    {
                        "bom": part.get("bom"),
                        "amount": max(1, len(slots)),
                        "description": part.get("part") or part.get("bom"),
                        "part": part.get("part"),
                        "model": device.get("model"),
                        "device": device.get("device"),
                        "slot": "\n".join(slots) or None,
                        "slots": slots,
                        "faultySn": "\n".join(device.get("faulty_sns") or []) or None,
                        "notes": part.get("notes"),
                        "deviceNumber": device_number,
                        "partNumber": part_number,
                    }
                )
        return {
            "ticketId": normalized,
            "ticketExists": True,
            "reportDate": report_date,
            "profile": {
                "customerOrganization": first(
                    "Customer Organization",
                    "Customer Org",
                    "Customer Org.",
                    "Customer Name",
                    "Customer",
                    "Account Name",
                ),
                "customerName": first(
                    "Customer Contact",
                    "Contact Name",
                    "Contact Person",
                    "Contact",
                ),
                "siteCode": local.get("Site"),
                "siteName": first("Site Name"),
                "siteAddress": first("Site Address", "Customer Address", "Address"),
                "cloud": local.get("Cloud"),
                "contact": {
                    "name": first(
                        "Customer Contact",
                        "Contact Name",
                        "Contact Person",
                        "Contact",
                    ),
                    "email": first("Customer Email", "Contact Email"),
                    "phone": first("Customer Phone", "Contact Phone", "Phone"),
                },
            },
            "lines": lines,
            "warning": None if lines else "This SR has no damaged part with a BOM yet.",
        }

    def import_customer_from_ticket(
        self,
        ticket_id: str,
        profile_override: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        prefill = self.spare_request_prefill(ticket_id)
        profile = profile_override if profile_override is not None else prefill.get("profile", {})
        organization_name = str(profile.get("customerOrganization") or "").strip()
        contact = profile.get("contact") if isinstance(profile.get("contact"), dict) else {}
        contact_name = str(contact.get("name") or profile.get("customerName") or "").strip()
        if not organization_name or not contact_name:
            raise ValidationError(
                "This SR does not contain both a customer organization and customer contact"
            )
        contact_email = str(contact.get("email") or "").strip()
        contact_phone = str(contact.get("phone") or "").strip()
        if not contact_email or not contact_phone:
            raise ValidationError("Customer email and phone are required before saving globally")
        data = self.global_reference_data()
        organizations = list(data.get("organizations") or [])
        customers = list(data.get("customers") or [])
        organization = next(
            (
                row
                for row in organizations
                if str(row.get("name") or "").strip().casefold()
                == organization_name.casefold()
            ),
            None,
        )
        created_organization = organization is None
        if organization is None:
            organization = {"id": f"org-{uuid.uuid4().hex}", "name": organization_name}
            organizations.append(organization)
        organization_id = str(organization["id"])
        customer = next(
            (
                row
                for row in customers
                if str(row.get("organizationId") or "") == organization_id
                and str(row.get("name") or "").strip().casefold() == contact_name.casefold()
            ),
            None,
        )
        created_customer = customer is None
        if customer is None:
            customer = {
                "id": f"customer-{uuid.uuid4().hex}",
                "organizationId": organization_id,
                "name": contact_name,
                "email": contact_email,
                "phone": contact_phone,
            }
            customers.append(customer)
        else:
            customer["email"] = contact_email
            customer["phone"] = contact_phone
        saved = self.save_global_reference_data(
            {
                "organizations": organizations,
                "customers": customers,
                "sites": data.get("sites", []),
                "requesters": data.get("requesters", []),
            }
        )
        return {
            "data": saved,
            "organizationId": organization_id,
            "customerId": customer["id"],
            "createdOrganization": created_organization,
            "createdCustomer": created_customer,
        }

    def _prepare_new_spare_request(
        self,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        source = str(payload.get("source") or "manual").strip().casefold()
        try:
            tt = normalize_tt(payload.get("ticketId"))
            profile = normalize_profile(payload.get("profile"))
            raw_lines = payload.get("lines")
            raw_report_date = payload.get("reportDate")
            if not raw_report_date and isinstance(raw_lines, list):
                legacy_dates = {
                    normalize_report_date(
                        raw.get("reportDate") or raw.get("report_date"),
                        required=True,
                    )
                    for raw in raw_lines
                    if isinstance(raw, dict)
                    and (raw.get("reportDate") or raw.get("report_date"))
                }
                if len(legacy_dates) > 1:
                    raise SpareRequestError(
                        "Every BOM in one TT must use the same original report date"
                    )
                raw_report_date = next(iter(legacy_dates), None)
            report_date = normalize_report_date(raw_report_date, required=True)
            prepared_lines = (
                [
                    {**raw, "reportDate": report_date}
                    if isinstance(raw, dict)
                    else raw
                    for raw in raw_lines
                ]
                if isinstance(raw_lines, list)
                else raw_lines
            )
            lines = normalize_request_lines(prepared_lines)
        except SpareRequestError as exc:
            raise ValidationError(str(exc)) from exc
        ticket_exists = self.store.ticket_file(tt).is_file()
        if source == "ticket" and not ticket_exists:
            raise ValidationError(
                f"SR {tt} must be active before creating a request from its detail"
            )
        if source not in {"ticket", "manual"}:
            raise ValidationError("Request source must be ticket or manual")
        return {
            "source": source,
            "tt": tt,
            "profile": profile,
            "lines": lines,
            "ticket_exists": ticket_exists,
        }

    def _occupied_spare_request_ids(
        self,
        *,
        export_root: Path | None = None,
    ) -> set[str]:
        occupied = set(self.store.iter_spare_request_ids())
        closed_path = self._closed_workbook_path()
        if closed_path is not None:
            occupied.update(
                str(row.get("Request ID") or "")
                for row in read_archived_items(closed_path)
                if row.get("Request ID")
            )
        requests_directory = (
            export_root / "Requests" if export_root is not None else None
        )
        if requests_directory is not None and requests_directory.is_dir():
            for prior_export in requests_directory.glob("*.xlsx"):
                suffix = prior_export.stem.rsplit("–", 1)[-1].split("-r", 1)[0]
                if len(suffix) == 12 and suffix.isdigit():
                    occupied.add(suffix)
        return occupied

    def _ensure_source_parts_available(
        self,
        tt: str,
        lines: list[dict[str, Any]],
    ) -> None:
        requested = {
            key
            for line in lines
            if (key := source_part_key(tt, line)) is not None
        }
        occupied = active_source_part_keys(self.store.iter_spare_requests())
        try:
            ticket = self.store.read_ticket(tt)
        except StoreError:
            ticket = None
        if ticket is not None:
            local = normalize_local(ticket.get("local"))
            for device_index, device in enumerate(local.get("spare_parts", []), start=1):
                device_number = int(device.get("device_number") or device_index)
                for part_index, part in enumerate(device.get("parts") or [], start=1):
                    if part.get("submitted_request_ids"):
                        occupied.add(
                            (
                                tt,
                                device_number,
                                int(part.get("part_number") or part_index),
                            )
                        )
        conflicts = sorted(requested & occupied)
        if not conflicts:
            return
        positions = ", ".join(
            f"device {device_number}, part {part_number}"
            for _, device_number, part_number in conflicts
        )
        raise ValidationError(
            f"TT {tt} already submitted {positions}. Add a new BOM/slot record for another replacement."
        )

    def _mark_source_parts(
        self,
        staging: Path,
        *,
        tt: str,
        lines: list[dict[str, Any]],
        request_id: str,
        submitted: bool,
    ) -> None:
        """Add or remove the permanent request marker on exact source records."""

        try:
            ticket = self.store.read_ticket(tt, staging)
        except StoreError:
            return
        local = normalize_local(ticket.get("local"))
        requested = {
            key for line in lines if (key := source_part_key(tt, line)) is not None
        }
        changed = False
        for device_index, device in enumerate(local.get("spare_parts", []), start=1):
            device_number = int(device.get("device_number") or device_index)
            for part_index, part in enumerate(device.get("parts") or [], start=1):
                key = (
                    tt,
                    device_number,
                    int(part.get("part_number") or part_index),
                )
                if key not in requested:
                    continue
                current = set(part.get("submitted_request_ids") or [])
                updated = current | {request_id} if submitted else current - {request_id}
                if updated != current:
                    part["submitted_request_ids"] = sorted(updated)
                    changed = True
        if changed:
            ticket["local"] = local
            self.store.write_ticket_bundle(staging, ticket)

    def export_spare_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        exported: Path | None = None
        persisted = False
        try:
            prepared = self._prepare_new_spare_request(payload)
            source = prepared["source"]
            tt = prepared["tt"]
            profile = prepared["profile"]
            lines = prepared["lines"]
            ticket_exists = prepared["ticket_exists"]
            self._ensure_source_parts_available(tt, lines)
            export_root = self._spare_export_root()
            occupied_request_ids = self._occupied_spare_request_ids(
                export_root=export_root
            )
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
            request["creation_method"] = "zeus_export"
            exported = export_initial_request(
                self._spare_template("spare_request_template_path", "Spare Request XLSX"),
                export_root,
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
                self._mark_source_parts(
                    staging,
                    tt=tt,
                    lines=lines,
                    request_id=request_id,
                    submitted=True,
                )
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

    def register_spare_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a tracked request without claiming that an email was sent."""

        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            prepared = self._prepare_new_spare_request(payload)
            source = prepared["source"]
            tt = prepared["tt"]
            profile = prepared["profile"]
            lines = prepared["lines"]
            ticket_exists = prepared["ticket_exists"]
            self._ensure_source_parts_available(tt, lines)
            request_id = next_request_id(
                self._occupied_spare_request_ids(
                    export_root=self.store.configured_directory(
                        "spare_parts_export_directory"
                    )
                )
            )
            subject = request_subject(request_id, tt, lines)
            request = create_request_record(
                request_id=request_id,
                tt=tt,
                source=source,
                profile=profile,
                lines=lines,
                export_path=None,
                subject=subject,
            )
            request["creation_method"] = "zeus_create"
            request["history"][0]["action"] = "request-created"
            request["history"][0]["summary"]["exported"] = False
            with self.store.transaction(
                "spare-request-create",
                {"request_id": request_id, "tt": tt, "items": len(request["items"])},
            ) as staging:
                self.store.write_spare_request(staging, request)
                self._mark_source_parts(
                    staging,
                    tt=tt,
                    lines=lines,
                    request_id=request_id,
                    submitted=True,
                )
            self._touch_data("spare-request-create")
            warnings = []
            if source == "manual" and not ticket_exists:
                warnings.append(
                    f"TT {tt} is not in local Service Requests. The new request was created with that warning recorded."
                )
            return {
                "request": self.spare_request(request_id),
                "subject": subject,
                "warnings": warnings,
            }
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

    def advance_spare_request_stage(
        self,
        request_id: str,
        *,
        item_id: str,
        target_stage: int,
        expected_revision: str,
    ) -> dict[str, Any]:
        current = self.store.read_spare_request(request_id)
        if not expected_revision or spare_request_revision(current) != expected_revision:
            raise ConflictError("This Spare Request changed. Reload before advancing it.")
        item = self._find_request_item(current, item_id)
        reached = lifecycle_stage(item, current)
        if target_stage != reached + 1:
            raise ValidationError(f"Advance one lifecycle stage at a time from {reached}")
        result = self.bulk_spare_lifecycle(
            item_ids=[item_id], action="advance", expected_revisions={request_id: expected_revision}
        )
        if self.store.spare_request_file(request_id).is_file():
            result["request"] = self.spare_request(request_id)
        else:
            result["request"] = None
        return result

    @staticmethod
    def _remove_stage_suppressions(target: dict[str, Any], stage: int) -> None:
        target["lifecycle_suppressions"] = [
            entry
            for entry in target.get("lifecycle_suppressions", [])
            if not isinstance(entry, dict) or int(entry.get("stage") or -1) != stage
        ]

    @staticmethod
    def _suppress_stage(
        target: dict[str, Any], *, stage: int, message_key: Any, note: str
    ) -> None:
        key = str(message_key or "")
        if not key:
            raise ValidationError("Email-backed rollback is missing its message identity")
        if not lifecycle_effect_suppressed(target, stage, key):
            target.setdefault("lifecycle_suppressions", []).append(
                {
                    "stage": stage,
                    "message_key": key,
                    "suppressed_at": iso_now(),
                    "note": note,
                }
            )

    def bulk_spare_lifecycle(
        self,
        *,
        item_ids: list[str],
        action: str,
        expected_revisions: dict[str, str] | None = None,
        email_override_confirmed: bool = False,
        note: str = "",
        confirmed_at: str | None = None,
    ) -> dict[str, Any]:
        normalized_action = str(action or "").strip().casefold()
        if normalized_action not in {"advance", "rollback"}:
            raise ValidationError("Lifecycle action must be advance or rollback")
        clean_ids = list(dict.fromkeys(str(value or "").strip() for value in item_ids))
        clean_ids = [value for value in clean_ids if value]
        if not clean_ids:
            raise ValidationError("Choose at least one active item")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            requests = list(self.store.iter_spare_requests())
            all_pairs = {
                str(item.get("item_id")): (request, item)
                for request in requests
                for item in request.get("items", [])
                if item.get("item_id")
            }
            missing = sorted(set(clean_ids) - set(all_pairs))
            if missing:
                raise ValidationError("Active items were not found: " + ", ".join(missing))
            for request_id, revision in (expected_revisions or {}).items():
                request = next(
                    (value for value in requests if value.get("request_id") == request_id),
                    None,
                )
                if request is None or spare_request_revision(request) != revision:
                    raise ConflictError("A selected Spare Request changed. Reload and try again.")

            timestamp = iso_now()
            if normalized_action == "advance" and confirmed_at:
                parsed_confirmation = parse_datetime(confirmed_at)
                if parsed_confirmation is None:
                    raise ValidationError("Manual confirmation time is invalid")
                if parsed_confirmation.tzinfo is None:
                    parsed_confirmation = parsed_confirmation.replace(
                        tzinfo=ECUADOR_TIMEZONE
                    )
                else:
                    parsed_confirmation = parsed_confirmation.astimezone(
                        ECUADOR_TIMEZONE
                    )
                if parsed_confirmation > datetime.now(ECUADOR_TIMEZONE) + timedelta(
                    minutes=5
                ):
                    raise ValidationError("Manual confirmation time cannot be in the future")
                timestamp = parsed_confirmation.isoformat(timespec="seconds")
            selected_ids = set(clean_ids)
            for request in requests:
                request_items = list(request.get("items") or [])
                request_item_ids = {
                    str(item.get("item_id") or "")
                    for item in request_items
                    if item.get("item_id")
                }
                selected_request_ids = request_item_ids & selected_ids
                if not selected_request_ids:
                    continue
                stages_by_item = {
                    str(item.get("item_id") or ""): lifecycle_stage(item, request)
                    for item in request_items
                    if item.get("item_id")
                }
                shared_stage_change = (
                    normalized_action == "advance"
                    and any(
                        stages_by_item[item_id] == 0
                        for item_id in selected_request_ids
                    )
                ) or (
                    normalized_action == "rollback"
                    and any(
                        stages_by_item[item_id] == 1
                        for item_id in selected_request_ids
                    )
                )
                if (
                    normalized_action == "rollback"
                    and shared_stage_change
                    and any(stage != 1 for stage in stages_by_item.values())
                ):
                    raise ValidationError(
                        "Roll every later-stage item back to Request email sent before "
                        f"rolling back the shared email stage in request {request.get('request_id')}"
                    )
                if shared_stage_change:
                    selected_ids.update(request_item_ids)
            clean_ids = list(
                dict.fromkeys(
                    [
                        *clean_ids,
                        *(
                            str(item.get("item_id"))
                            for request in requests
                            for item in request.get("items", [])
                            if item.get("item_id") in selected_ids
                        ),
                    ]
                )
            )
            pairs = {item_id: all_pairs[item_id] for item_id in clean_ids}
            plans: list[dict[str, Any]] = []
            planned_shared_requests: set[str] = set()
            for item_id in clean_ids:
                request, item = pairs[item_id]
                stage = lifecycle_stage(item, request)
                target = stage + 1 if normalized_action == "advance" else stage
                if normalized_action == "advance" and target >= len(LIFECYCLE_STAGE_LABELS):
                    raise ValidationError(f"{item_id} is already complete")
                if normalized_action == "rollback" and stage == 0:
                    raise ValidationError(f"{item_id} is already at the first lifecycle stage")
                if normalized_action == "advance" and target == 2 and not (
                    request.get("spare_sr") and item.get("rma")
                ):
                    raise ValidationError(
                        f"{item_id} needs both the seven-digit Spare SR and its RMA first"
                    )
                if normalized_action == "advance" and target == 5:
                    raise ValidationError(
                        f"{item_id} needs matching warehouse email evidence; this stage cannot be confirmed manually"
                    )
                if normalized_action == "rollback":
                    source = {
                        1: request.get("request_sent_source"),
                        2: item.get("attendance_source"),
                        3: item.get("dispatch_source"),
                        4: item.get("replacement_confirmation_source"),
                        5: item.get("warehouse_confirmation_source"),
                        6: item.get("completion_confirmation_source"),
                    }.get(stage)
                    message_key = {
                        1: request.get("request_sent_message_key"),
                        2: item.get("attendance_message_key"),
                        3: item.get("dispatch_message_key"),
                        5: item.get("warehouse_message_key"),
                    }.get(stage)
                    email_backed = str(source or "").casefold().startswith(
                        "email"
                    ) or bool(message_key)
                    if email_backed and (not email_override_confirmed or not note.strip()):
                        raise ValidationError(
                            "Rolling back an email-backed stage requires the second confirmation and an audit note"
                        )
                    if stage == 1 and request["request_id"] in planned_shared_requests:
                        continue
                    plans.append(
                        {
                            "item_id": item_id,
                            "request_id": request["request_id"],
                            "stage": stage,
                            "email_backed": email_backed,
                            "source": source,
                            "message_key": message_key,
                            "shared_item_ids": (
                                sorted(
                                    str(value.get("item_id"))
                                    for value in request.get("items", [])
                                    if value.get("item_id")
                                )
                                if stage == 1
                                else []
                            ),
                        }
                    )
                else:
                    if target == 1 and request["request_id"] in planned_shared_requests:
                        continue
                    plans.append(
                        {
                            "item_id": item_id,
                            "request_id": request["request_id"],
                            "stage": target,
                            "shared_item_ids": (
                                sorted(
                                    str(value.get("item_id"))
                                    for value in request.get("items", [])
                                    if value.get("item_id")
                                )
                                if target == 1
                                else []
                            ),
                        }
                    )
                if (normalized_action == "advance" and target == 1) or (
                    normalized_action == "rollback" and stage == 1
                ):
                    planned_shared_requests.add(str(request["request_id"]))

            completed_ids: set[str] = set()
            closed_path = None
            if normalized_action == "advance" and any(plan["stage"] == 6 for plan in plans):
                closed_path = self._closed_workbook_path(required=True)
                assert closed_path is not None
                for plan in plans:
                    if plan["stage"] != 6:
                        continue
                    request, item = pairs[plan["item_id"]]
                    append_archived_item(
                        closed_path,
                        request,
                        {**item, "completion_confirmed_at": timestamp},
                        reason="returned",
                        note=note.strip() or "Warehouse evidence confirmed by user",
                    )
                    completed_ids.add(plan["item_id"])

            with self.store.transaction(
                f"spare-lifecycle-{normalized_action}",
                {
                    "items": clean_ids,
                    "email_override": email_override_confirmed,
                    "note": note.strip() or None,
                },
            ) as staging:
                staged_requests = {
                    request_id: self.store.read_spare_request(request_id, staging)
                    for request_id in {plan["request_id"] for plan in plans}
                }
                for plan in plans:
                    request = staged_requests[plan["request_id"]]
                    item = self._find_request_item(request, plan["item_id"])
                    stage = int(plan["stage"])
                    if normalized_action == "advance":
                        target = request if stage == 1 else item
                        self._remove_stage_suppressions(target, stage)
                        if stage == 1:
                            request["request_sent_at"] = timestamp
                            request["request_sent_source"] = "manual"
                            request["request_sent_message_key"] = None
                        elif stage == 2:
                            item["attendance_confirmed_at"] = timestamp
                            item["attendance_source"] = "manual"
                            item["attendance_message_key"] = None
                        elif stage == 3:
                            item["dispatch_at"] = timestamp
                            item["dispatch_source"] = "manual"
                            item["dispatch_message_key"] = None
                        elif stage == 4:
                            item["replacement_confirmed_at"] = timestamp
                            item["replacement_confirmation_source"] = "manual"
                        elif stage == 6:
                            item["completion_confirmed_at"] = timestamp
                            item["completion_confirmation_source"] = "manual"
                    else:
                        clear_manual_fact = not plan["email_backed"] or not str(
                            plan.get("source") or ""
                        ).casefold().startswith("email")
                        if plan["email_backed"]:
                            staged_target = request if stage == 1 else item
                            self._suppress_stage(
                                staged_target,
                                stage=stage,
                                message_key=plan["message_key"],
                                note=note.strip(),
                            )
                        if clear_manual_fact and stage == 1:
                            request["request_sent_at"] = None
                            request["request_sent_source"] = None
                            request["request_sent_message_key"] = None
                        elif clear_manual_fact and stage == 2:
                            item["attendance_confirmed_at"] = None
                            item["attendance_source"] = None
                            item["attendance_message_key"] = None
                        elif clear_manual_fact and stage == 3:
                            item["dispatch_at"] = None
                            item["dispatch_source"] = None
                            item["dispatch_message_key"] = None
                        elif clear_manual_fact and stage == 4:
                            item["replacement_confirmed_at"] = None
                            item["replacement_confirmation_source"] = None
                        elif clear_manual_fact and stage == 5:
                            item["warehouse_candidate_at"] = None
                            item["warehouse_confirmation_source"] = None
                        elif clear_manual_fact and stage == 6:
                            item["completion_confirmed_at"] = None
                            item["completion_confirmation_source"] = None
                    request_history(
                        request,
                        f"lifecycle-stage-{normalized_action}",
                        {
                            "itemId": plan["item_id"],
                            "items": plan.get("shared_item_ids") or [plan["item_id"]],
                            "stage": stage,
                            "label": LIFECYCLE_STAGE_LABELS[stage],
                            "emailOverride": bool(plan.get("email_backed")),
                            "confirmedAt": timestamp if normalized_action == "advance" else None,
                            "note": note.strip() or None,
                        },
                    )

                affected_tags = list(self.store.iter_fault_tags(staging))
                for record in affected_tags:
                    changed = False
                    for member in record.get("members", []):
                        if member.get("item_id") in completed_ids:
                            member["user_confirmed_at"] = timestamp
                            changed = True
                    if changed:
                        fault_tag_history(
                            record,
                            "members-user-confirmed",
                            {"items": sorted(completed_ids)},
                        )
                        self.store.write_fault_tag(staging, record)

                for request_id, request in staged_requests.items():
                    request["items"] = [
                        item
                        for item in request.get("items", [])
                        if item.get("item_id") not in completed_ids
                    ]
                    if request["items"]:
                        self.store.write_spare_request(staging, request)
                    else:
                        self.store.delete_spare_request(request_id, staging)
                for record in affected_tags:
                    if record.get("fault_tag_id") in set(
                        self.store.iter_fault_tag_ids(staging)
                    ) and fault_tag_status(record) == "completed":
                        self.store.archive_fault_tag(record["fault_tag_id"], staging)

            if completed_ids:
                self.store.purge_state_backups_for_closed_tickets()
            self._touch_data(f"spare-lifecycle-{normalized_action}")
            return {
                "action": normalized_action,
                "items": clean_ids,
                "completed": sorted(completed_ids),
                "closedPath": str(closed_path) if closed_path else None,
            }
        finally:
            self._operation_lock.release()

    def delete_unconfirmed_spare_request(
        self,
        request_id: str,
        *,
        expected_revision: str,
    ) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            request = self.store.read_spare_request(request_id)
            if not expected_revision or spare_request_revision(request) != expected_revision:
                raise ConflictError("This Spare Request changed. Reload before deleting it.")
            if request.get("spare_sr") or any(
                item.get("rma") or item.get("attendance_confirmed_at")
                for item in request.get("items", [])
            ):
                raise ValidationError(
                    "A confirmed Spare Request cannot be deleted. Complete or cancel its items instead."
                )
            with self.store.transaction(
                "spare-request-delete-unconfirmed",
                {"request_id": request_id, "tt": request.get("tt")},
            ) as staging:
                staged = self.store.read_spare_request(request_id, staging)
                if spare_request_revision(staged) != expected_revision:
                    raise ConflictError("This Spare Request changed. Reload before deleting it.")
                self._mark_source_parts(
                    staging,
                    tt=str(staged.get("tt") or ""),
                    lines=[
                        *list(staged.get("request_lines") or []),
                        *list(staged.get("items") or []),
                    ],
                    request_id=request_id,
                    submitted=False,
                )
                self.store.delete_spare_request(request_id, staging)
            self._touch_data("spare-request-delete-unconfirmed")
            return {
                "deleted": request_id,
                "exportPreserved": request.get("export", {}).get("request_path"),
            }
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
            archived_rmas = set().union(
                *(
                    archived_rma_values(row)
                    for row in read_archived_items(closed_path)
                )
            ) if closed_path is not None else set()
            active_rma_owners: dict[str, set[str]] = {}
            for candidate in active_requests:
                for candidate_item in candidate.get("items", []):
                    candidate_item_id = str(candidate_item.get("item_id") or "")
                    identities = [
                        candidate_item.get("rma"),
                        *list(candidate_item.get("rma_aliases") or []),
                    ]
                    for identity in identities:
                        if identity:
                            active_rma_owners.setdefault(str(identity), set()).add(
                                candidate_item_id
                            )
            fault_tag_rma_owners: dict[str, set[str]] = {}
            for completed in (False, True):
                for record in self.store.iter_fault_tags(completed=completed):
                    for member in record.get("members", []):
                        identity = str(member.get("rma") or "")
                        if identity:
                            fault_tag_rma_owners.setdefault(identity, set()).add(
                                str(member.get("item_id") or "")
                            )
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
                for update in item_updates:
                    if not isinstance(update, dict):
                        raise ValidationError("Item updates must be objects")
                    item = self._find_request_item(request, str(update.get("itemId") or ""))
                    if "rma" in update:
                        incoming_rma = normalize_rma(update.get("rma"))
                        item_id = str(item.get("item_id") or "")
                        previous_rma = normalize_rma(item.get("rma"))
                        if previous_rma and not incoming_rma:
                            raise ValidationError(
                                "An assigned RMA can be corrected but not cleared"
                            )
                        if previous_rma and incoming_rma != previous_rma and not note:
                            raise ValidationError(
                                "Correcting an assigned RMA requires an audit note"
                            )
                        if incoming_rma and any(
                            owner != item_id
                            for owner in active_rma_owners.get(incoming_rma, set())
                        ):
                            raise ValidationError(
                                f"RMA {incoming_rma} already belongs to another active item or historical alias"
                            )
                        if incoming_rma and incoming_rma in archived_rmas:
                            raise ValidationError(
                                f"RMA {incoming_rma} already belongs to a completed item or historical alias"
                            )
                        if incoming_rma and any(
                            owner != item_id
                            for owner in fault_tag_rma_owners.get(incoming_rma, set())
                        ):
                            raise ValidationError(
                                f"RMA {incoming_rma} already belongs to another Fault Tag item"
                            )
                        if previous_rma and incoming_rma != previous_rma:
                            for fault_tag_id in list(item.get("fault_tag_ids") or []):
                                record = self.store.read_fault_tag(
                                    str(fault_tag_id), staging, completed=False
                                )
                                member = next(
                                    (
                                        value
                                        for value in record.get("members", [])
                                        if value.get("item_id") == item_id
                                    ),
                                    None,
                                )
                                if member is None:
                                    raise ValidationError(
                                        f"Fault Tag {fault_tag_id} no longer contains {item_id}"
                                    )
                                if (
                                    record.get("locked_at")
                                    or record.get("email", {}).get("sent_at")
                                    or member.get("warehouse_evidence_at")
                                ):
                                    raise ValidationError(
                                        f"Delete Fault Tag {fault_tag_id} before correcting RMA {previous_rma}; sent-email or warehouse evidence already exists"
                                    )
                                member["rma"] = incoming_rma
                                if isinstance(member.get("item_snapshot"), dict):
                                    member["item_snapshot"]["rma"] = incoming_rma
                                    member["item_snapshot"]["rma_aliases"] = (
                                        normalize_rma_aliases(
                                            [
                                                *list(item.get("rma_aliases") or []),
                                                previous_rma,
                                            ],
                                            current=incoming_rma,
                                        )
                                    )
                                record.setdefault("export", {})[
                                    "needs_reexport"
                                ] = True
                                fault_tag_history(
                                    record,
                                    "member-rma-corrected",
                                    {
                                        "item": item_id,
                                        "previous": previous_rma,
                                        "current": incoming_rma,
                                    },
                                )
                                self.store.write_fault_tag(staging, record)
                            aliases = normalize_rma_aliases(
                                [*list(item.get("rma_aliases") or []), previous_rma],
                                current=incoming_rma,
                            )
                            item["rma_aliases"] = aliases
                            request_history(
                                request,
                                "rma-corrected",
                                {
                                    "itemId": item_id,
                                    "previous": previous_rma,
                                    "current": incoming_rma,
                                    "note": note,
                                },
                            )
                        item["rma"] = incoming_rma
                        if incoming_rma:
                            active_rma_owners.setdefault(incoming_rma, set()).add(
                                item_id
                            )
                        for alias in item.get("rma_aliases", []):
                            active_rma_owners.setdefault(str(alias), set()).add(
                                item_id
                            )
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

    @staticmethod
    def _serialize_fault_tag(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "faultTagId": record.get("fault_tag_id"),
            "status": fault_tag_status(record),
            "returnSite": deepcopy(record.get("return_site") or {}),
            "mixedSourceSites": bool(record.get("mixed_source_sites")),
            "members": [
                {
                    "itemId": member.get("item_id"),
                    "requestId": member.get("request_id"),
                    "ticketId": member.get("tt"),
                    "spareSr": member.get("spare_sr"),
                    "rma": member.get("rma"),
                    "condition": member.get("condition"),
                    "sourceSite": member.get("source_site"),
                    "requestedBom": member.get("requested_bom"),
                    "newSn": member.get("new_sn"),
                    "warehouseEvidenceAt": member.get("warehouse_evidence_at"),
                    "userConfirmedAt": member.get("user_confirmed_at"),
                }
                for member in record.get("members", [])
            ],
            "export": deepcopy(record.get("export") or {}),
            "email": deepcopy(record.get("email") or {}),
            "lockedAt": record.get("locked_at"),
            "locked": bool(record.get("locked_at")),
            "lockedSource": record.get("locked_source"),
            "createdAt": record.get("created_at"),
            "updatedAt": record.get("updated_at"),
        }

    def fault_tag(self, fault_tag_id: str) -> dict[str, Any]:
        try:
            return self._serialize_fault_tag(self.store.read_fault_tag(fault_tag_id))
        except StoreError as exc:
            raise NotFoundError(str(exc)) from exc

    def _prepare_fault_tag_selection(
        self,
        selections: list[dict[str, Any]],
        return_site: dict[str, Any] | None,
    ) -> tuple[
        list[tuple[dict[str, Any], dict[str, Any], str]],
        dict[str, str | None],
    ]:
        requests = list(self.store.iter_spare_requests())
        by_item = {
            item.get("item_id"): (request, item)
            for request in requests
            for item in request.get("items", [])
        }
        prepared: list[tuple[dict[str, Any], dict[str, Any], str]] = []
        active_members = {
            str(member.get("item_id"))
            for record in self.store.iter_fault_tags()
            for member in record.get("members", [])
        }
        for selection in selections:
            item_id = str(selection.get("itemId") or "")
            pair = by_item.get(item_id)
            if pair is None:
                raise ValidationError(f"Active item {item_id} was not found")
            request, item = pair
            if not item.get("rma"):
                raise ValidationError(f"Item {item_id} has no RMA")
            condition = str(selection.get("condition") or "Faulty").title()
            if condition not in {"Faulty", "New"}:
                raise ValidationError("Return condition must be Faulty or New")
            if lifecycle_stage(item, request) != 4:
                raise ValidationError(
                    f"{item_id} must be at Spare replaced before choosing its return condition"
                )
            if item_id in active_members:
                raise ValidationError(
                    f"{item_id} already belongs to an active Fault Tag; additions require a new Fault Tag"
                )
            prepared.append((request, item, condition))
        source_sites = {
            (
                str(request.get("profile", {}).get("site_code") or "").strip(),
                str(request.get("profile", {}).get("site_address") or "").strip(),
                str(request.get("profile", {}).get("cloud") or "").strip(),
            )
            for request, _, _ in prepared
        }
        if len(source_sites) > 1 and not return_site:
            raise ValidationError(
                "Selected items come from different sites. Choose the actual return site."
            )
        if return_site:
            actual_site = normalize_return_site(return_site)
        else:
            site_code, site_address, cloud = next(iter(source_sites))
            first_profile = prepared[0][0].get("profile", {})
            actual_site = normalize_return_site(
                {
                    "code": site_code,
                    "name": first_profile.get("site_name"),
                    "address": site_address,
                    "cloud": cloud,
                }
            )
        return prepared, actual_site

    @staticmethod
    def _fault_tag_members(
        prepared: list[tuple[dict[str, Any], dict[str, Any], str]],
    ) -> list[dict[str, Any]]:
        return [
            {
                "item_id": item.get("item_id"),
                "request_id": request.get("request_id"),
                "tt": request.get("tt"),
                "spare_sr": request.get("spare_sr"),
                "rma": item.get("rma"),
                "condition": condition,
                "source_site": request.get("profile", {}).get("site_code"),
                "requested_bom": item.get("requested_bom"),
                "new_sn": item.get("new_sn"),
                # Re-export after a member completes needs only the immutable
                # workbook facts, not a full copy of the multi-item request.
                "request_snapshot": {
                    "request_id": request.get("request_id"),
                    "tt": request.get("tt"),
                    "spare_sr": request.get("spare_sr"),
                    "profile": deepcopy(request.get("profile") or {}),
                },
                "item_snapshot": {
                    key: deepcopy(item.get(key))
                    for key in (
                        "item_id",
                        "rma",
                        "requested_bom",
                        "delivered_bom",
                        "requested_description",
                        "part",
                        "model",
                        "device",
                        "slot",
                        "new_sn",
                        "report_date",
                    )
                },
            }
            for request, item, condition in prepared
        ]

    def _persist_new_fault_tag(
        self,
        record: dict[str, Any],
        prepared: list[tuple[dict[str, Any], dict[str, Any], str]],
        *,
        transaction_action: str,
        request_history_action: str,
    ) -> None:
        fault_tag_id = str(record.get("fault_tag_id") or "")
        selected = {
            str(item.get("item_id")): condition for _, item, condition in prepared
        }
        filename = record.get("export", {}).get("filename")
        with self.store.transaction(
            transaction_action,
            {
                "fault_tag_id": fault_tag_id,
                "items": sorted(selected),
                "filename": filename,
                "sent_source": record.get("locked_source"),
            },
        ) as staging:
            self.store.write_fault_tag(staging, record)
            for request_id in {request["request_id"] for request, _, _ in prepared}:
                request = self.store.read_spare_request(request_id, staging)
                affected = []
                for item in request.get("items", []):
                    condition = selected.get(item.get("item_id"))
                    if condition is None:
                        continue
                    item["return_condition"] = condition
                    if fault_tag_id not in item.setdefault("fault_tag_ids", []):
                        item["fault_tag_ids"].append(fault_tag_id)
                    affected.append(item["item_id"])
                summary: dict[str, Any] = {
                    "faultTagId": fault_tag_id,
                    "items": affected,
                }
                if filename:
                    summary["filename"] = filename
                if record.get("locked_source"):
                    summary["sentSource"] = record.get("locked_source")
                request_history(request, request_history_action, summary)
                self.store.write_spare_request(staging, request)

    def export_spare_return(
        self,
        selections: list[dict[str, Any]],
        *,
        return_site: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(selections, list) or not selections:
            raise ValidationError("Choose at least one RMA for the return workbook")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        result: dict[str, Any] | None = None
        persisted = False
        try:
            prepared, actual_site = self._prepare_fault_tag_selection(
                selections, return_site
            )
            fault_tag_id = next_fault_tag_id(
                [
                    *self.store.iter_fault_tag_ids(),
                    *self.store.iter_fault_tag_ids(completed=True),
                ]
            )
            result = export_return_workbook(
                self._spare_template("spare_return_template_path", "Faulty Return XLSX"),
                self._spare_export_root(),
                prepared,
                fault_tag_id=fault_tag_id,
                return_site=actual_site,
            )
            timestamp = iso_now()
            record = create_fault_tag_record(
                fault_tag_id=fault_tag_id,
                members=self._fault_tag_members(prepared),
                return_site=actual_site,
                export={
                    "filename": result["filename"],
                    "path": result["path"],
                    "subject": result["subject"],
                    "revisions": [
                        {
                            "filename": result["filename"],
                            "path": result["path"],
                            "created_at": timestamp,
                        }
                    ],
                },
                created_at=timestamp,
            )
            self._persist_new_fault_tag(
                record,
                prepared,
                transaction_action="fault-tag-create",
                request_history_action="fault-tag-linked",
            )
            persisted = True
            self._touch_data("fault-tag-create")
            return {
                **result,
                "faultTagId": fault_tag_id,
                "faultTag": self.fault_tag(fault_tag_id),
            }
        except (FaultTagError, SpareRequestError) as exc:
            if result is not None and not persisted:
                exported_path = str(result.get("path") or "").strip()
                if exported_path:
                    Path(exported_path).unlink(missing_ok=True)
            raise ValidationError(str(exc)) from exc
        except Exception:
            if result is not None and not persisted:
                exported_path = str(result.get("path") or "").strip()
                if exported_path:
                    Path(exported_path).unlink(missing_ok=True)
            raise
        finally:
            self._operation_lock.release()

    def register_sent_fault_tag(
        self,
        selections: list[dict[str, Any]],
        *,
        return_site: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(selections, list) or not selections:
            raise ValidationError("Choose at least one RMA for the manually sent Fault Tag")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            prepared, actual_site = self._prepare_fault_tag_selection(
                selections, return_site
            )
            fault_tag_id = next_fault_tag_id(
                [
                    *self.store.iter_fault_tag_ids(),
                    *self.store.iter_fault_tag_ids(completed=True),
                ]
            )
            timestamp = iso_now()
            record = create_fault_tag_record(
                fault_tag_id=fault_tag_id,
                members=self._fault_tag_members(prepared),
                return_site=actual_site,
                export={
                    "filename": None,
                    "path": None,
                    "subject": f"Fault Tag {fault_tag_id}",
                    "revisions": [],
                },
                created_at=timestamp,
            )
            record["email"].update(
                {
                    "sent_at": timestamp,
                    "message_key": None,
                    "subject": None,
                }
            )
            record["locked_at"] = timestamp
            record["locked_source"] = "manual"
            record["history"][0] = {
                "timestamp": timestamp,
                "action": "fault-tag-manually-sent",
                "summary": {
                    "items": sorted(
                        str(item.get("item_id")) for _, item, _ in prepared
                    ),
                    "return_site": actual_site["code"],
                    "sent_at": timestamp,
                },
            }
            self._persist_new_fault_tag(
                record,
                prepared,
                transaction_action="fault-tag-register-sent",
                request_history_action="fault-tag-manually-sent",
            )
            self._touch_data("fault-tag-register-sent")
            return {
                "faultTagId": fault_tag_id,
                "faultTag": self.fault_tag(fault_tag_id),
            }
        except (FaultTagError, SpareRequestError) as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()

    def reexport_fault_tag(self, fault_tag_id: str) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        result: dict[str, Any] | None = None
        persisted = False
        try:
            record = self.store.read_fault_tag(fault_tag_id, completed=False)
            requests = {request["request_id"]: request for request in self.store.iter_spare_requests()}
            selections: list[tuple[dict[str, Any], dict[str, Any], str]] = []
            for member in record.get("members", []):
                request = requests.get(member.get("request_id"))
                if request is None and isinstance(member.get("request_snapshot"), dict):
                    request = deepcopy(member["request_snapshot"])
                if request is None:
                    raise ValidationError(
                        "This legacy Fault Tag has no reusable request snapshot"
                    )
                item = next(
                    (
                        value
                        for value in request.get("items", [])
                        if value.get("item_id") == member.get("item_id")
                    ),
                    None,
                )
                if item is None and isinstance(member.get("item_snapshot"), dict):
                    item = deepcopy(member["item_snapshot"])
                if item is None:
                    raise ValidationError(
                        "This legacy Fault Tag has no reusable item snapshot"
                    )
                selections.append((request, item, str(member.get("condition"))))
            result = export_return_workbook(
                self._spare_template("spare_return_template_path", "Faulty Return XLSX"),
                self._spare_export_root(),
                selections,
                fault_tag_id=str(record.get("fault_tag_id")),
                return_site=record.get("return_site"),
            )
            timestamp = iso_now()
            with self.store.transaction(
                "fault-tag-reexport",
                {"fault_tag_id": fault_tag_id, "filename": result["filename"]},
            ) as staging:
                updated = self.store.read_fault_tag(fault_tag_id, staging, completed=False)
                updated.setdefault("export", {}).update(
                    {
                        "filename": result["filename"],
                        "path": result["path"],
                        "subject": result["subject"],
                        "needs_reexport": False,
                    }
                )
                updated["export"].setdefault("revisions", []).append(
                    {
                        "filename": result["filename"],
                        "path": result["path"],
                        "created_at": timestamp,
                    }
                )
                fault_tag_history(
                    updated, "fault-tag-reexported", {"filename": result["filename"]}
                )
                self.store.write_fault_tag(staging, updated)
            persisted = True
            self._touch_data("fault-tag-reexport")
            return {**result, "faultTag": self.fault_tag(fault_tag_id)}
        except Exception:
            if result is not None and not persisted and result.get("path"):
                Path(str(result["path"])).unlink(missing_ok=True)
            raise
        finally:
            self._operation_lock.release()

    def delete_fault_tag(self, fault_tag_id: str) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data")
        try:
            record = self.store.read_fault_tag(fault_tag_id, completed=False)
            member_ids = {str(member.get("item_id")) for member in record.get("members", [])}
            released_ids: set[str] = set()
            with self.store.transaction(
                "fault-tag-delete",
                {
                    "fault_tag_id": fault_tag_id,
                    "items": sorted(member_ids),
                    "was_locked": bool(record.get("locked_at")),
                },
            ) as staging:
                for request_id in {
                    str(member.get("request_id")) for member in record.get("members", [])
                }:
                    if not self.store.spare_request_file(request_id, staging).is_file():
                        continue
                    request = self.store.read_spare_request(request_id, staging)
                    affected = []
                    for item in request.get("items", []):
                        if item.get("item_id") not in member_ids:
                            continue
                        item["fault_tag_ids"] = [
                            value
                            for value in item.get("fault_tag_ids", [])
                            if value != fault_tag_id
                        ]
                        item["return_condition"] = None
                        affected.append(item.get("item_id"))
                        released_ids.add(str(item.get("item_id")))
                    request_history(
                        request,
                        "fault-tag-unlinked-after-delete",
                        {"faultTagId": fault_tag_id, "items": affected},
                    )
                    self.store.write_spare_request(staging, request)
                self.store.delete_fault_tag(fault_tag_id, staging)
            self._touch_data("fault-tag-delete")
            return {
                "deleted": fault_tag_id,
                "itemsReleased": sorted(released_ids),
                "lifecycleChanged": False,
            }
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
        if normalized_reason == "returned":
            if manual_override:
                raise ValidationError(
                    "Manual override cannot replace warehouse email evidence"
                )
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
            not_ready = sorted(
                item_id
                for item_id, (request, item) in pairs.items()
                if lifecycle_stage(item, request) != 5
            )
            if not_ready:
                raise ValidationError(
                    "Warehouse email evidence plus explicit user confirmation is required for: "
                    + ", ".join(not_ready)
                )
            completed = self.bulk_spare_lifecycle(
                item_ids=sorted(clean_ids),
                action="advance",
                note=note.strip(),
            )
            return {
                "archived": completed["completed"],
                "reason": "returned",
                "closedPath": completed["closedPath"],
                "results": [],
            }
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
            linked_tags = {
                str(record.get("fault_tag_id")): sorted(
                    clean_ids
                    & {
                        str(member.get("item_id") or "")
                        for member in record.get("members", [])
                    }
                )
                for record in self.store.iter_fault_tags()
                if clean_ids
                & {
                    str(member.get("item_id") or "")
                    for member in record.get("members", [])
                }
            }
            if linked_tags:
                raise ValidationError(
                    "Delete the active Fault Tag before cancelling its member item(s): "
                    + ", ".join(sorted(linked_tags))
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
                    self._mark_source_parts(
                        staging,
                        tt=str(request.get("tt") or ""),
                        lines=[
                            *list(request.get("request_lines") or []),
                            *list(request.get("items") or []),
                        ],
                        request_id=request_id,
                        submitted=True,
                    )
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
            result = edit_ticket_in_database(
                self.store,
                normalized_ticket_id,
                changes,
                expected_revision=expected_revision,
            )
        finally:
            self._operation_lock.release()
        if result.get("changed"):
            self._touch_data("ticket-edit")
        response = {
            "changed": bool(result.get("changed")),
            "changedFields": result.get("changedFields", []),
            # The browser replaces its open detail with this response before
            # the dataset event is processed.  Return the same complete shape
            # as GET /api/tickets/<id>, including history and MOPs, so a
            # successful edit can never leave React with a partial object.
            "ticket": self.ticket(normalized_ticket_id),
        }
        return response

    def confirm_maintenance_window(
        self,
        ticket_id: str,
        *,
        planned_date: str,
        successful: bool,
        expected_revision: str,
        finish_time: str | None = None,
    ) -> dict[str, Any]:
        normalized_ticket_id = normalize_ticket_id(ticket_id)
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            result = confirm_maintenance_window_in_database(
                self.store,
                normalized_ticket_id,
                planned_date=planned_date,
                successful=successful,
                expected_revision=expected_revision,
                finish_time=finish_time,
            )
        finally:
            self._operation_lock.release()
        self._touch_data("maintenance-window-confirmation")
        return {
            "changed": True,
            "changedFields": result.get("changedFields", []),
            "ticket": self.ticket(normalized_ticket_id),
        }

    def edit_tickets(
        self,
        edits: list[dict[str, Any]],
    ) -> dict[str, Any]:
        normalized: list[dict[str, Any]] = []
        for raw in edits:
            if not isinstance(raw, dict):
                raise ValidationError("Every protected draft update must be an object")
            try:
                ticket_id = normalize_ticket_id(raw.get("ticketId"))
            except ValueError as exc:
                raise ValidationError("Every protected draft update requires an eight-digit SR") from exc
            if not self.store.ticket_file(ticket_id).is_file():
                if self._closed_archive_ticket(ticket_id) is not None:
                    raise ValidationError(
                        f"SR {ticket_id} is finalized and its protected draft cannot be saved"
                    )
                raise NotFoundError(f"SR {ticket_id} was not found")
            normalized.append({**raw, "ticketId": ticket_id})
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            result = edit_tickets_in_database(self.store, normalized)
        finally:
            self._operation_lock.release()
        if result.get("changed"):
            self._touch_data("ticket-batch-edit")
        result["tickets"] = {
            ticket_id: self.ticket(ticket_id)
            for ticket_id in (entry["ticketId"] for entry in result.get("results", []))
        }
        return result

    def get_settings(self) -> dict[str, Any]:
        return settings_payload(self.store)

    def save_settings(self, updates: dict[str, Any]) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before changing configuration")
        try:
            result = update_settings(self.store, updates)
        finally:
            self._operation_lock.release()
        with self._dashboard_cache_lock:
            self._dashboard_cache.clear()
        self._schedule_wakeup.set()
        self.broker.publish("configuration", {"changed": result.get("changed", [])})
        return result

    def database_maintenance_status(self) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before checking the database")
        try:
            return inspect_database(self.store)
        finally:
            self._operation_lock.release()

    def run_database_maintenance(self, *, confirmed: bool) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before maintaining the database")
        try:
            try:
                result = maintain_database(self.store, confirmed=confirmed)
            except StoreError as exc:
                raise ValidationError(str(exc)) from exc
        finally:
            self._operation_lock.release()
        if result.get("changed"):
            self._touch_data("database-maintenance")
        return result

    def migrate_data_directory(self, destination: str) -> dict[str, Any]:
        target = str(destination or "").strip().strip('"')
        if not target:
            raise ValidationError("Choose an empty destination folder")
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Wait for the current Zeus operation before moving the data folder")
        migration_prepared = False
        try:
            # Recheck after owning the mutation boundary so a job cannot be
            # queued between the first observation and the verified clone.
            running = [
                job
                for job in self.jobs.snapshots()
                if job.get("status") in {"queued", "running"}
            ]
            if running:
                raise BusyError(
                    "Wait for active Zeus operations before moving the data folder"
                )
            self._migration_pending = True
            result = prepare_data_migration(self.store, Path(target))
            migration_prepared = True
            return result
        except BusyError:
            raise
        except (OSError, StorageMigrationError, ValueError) as exc:
            raise ValidationError(str(exc)) from exc
        finally:
            if not migration_prepared:
                self._migration_pending = False
            self._operation_lock.release()

    def scan_outlook(self, directory: str) -> list[dict[str, Any]]:
        return outlook_candidates(self.store, directory)

    def submit_job(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        factories: dict[str, Callable[[JobContext], Any]] = {
            "startup": lambda context: self._run_startup(context, startup=True),
            "query": lambda context: self._run_startup(context, startup=False),
            "advanced": self._run_advanced,
            "publish": lambda context: self._run_publish(context, payload),
            "email-fetch": lambda context: self._run_email_fetch(
                context,
                rebuild=False,
                synchronize=(
                    bool(payload.get("synchronize"))
                    if "synchronize" in payload
                    else None
                ),
            ),
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
            context.report("advanced-search", "Checking the newest Advanced Search workbook")
            if startup:
                result = run_startup(
                    self.store,
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
            else:
                # A manual or scheduled query has one job in 3.1.3: discover
                # and reconcile the newest Advanced Search workbook. Email,
                # retention, and workbook output have their own operations.
                result = reconcile_advanced_and_new_mail(
                    self.store,
                    fetch_new=False,
                    cancel_event=context.cancel_event,
                    progress=context.progress_callback,
                )
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
                fetch_new=False,
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
            context.report("export", "Generating Pendings.xlsx and Closed.xlsx from Zeus")
            result = publish_operational_workbooks(
                self.store,
                directory,
                create_missing=True,
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

    def _run_email_fetch(
        self,
        context: JobContext,
        *,
        rebuild: bool,
        synchronize: bool | None = None,
    ) -> dict[str, Any]:
        def operation() -> dict[str, Any]:
            self._require_outlook()
            # Direct email fetches intentionally use the last successfully
            # committed ticket database. Advanced Search is an independent
            # operation and must never block Outlook because one workbook has
            # a new or invalid column.
            context.report("eligibility", "Reading committed ticket eligibility")
            context.report("outlook", "Opening Classic Outlook")
            try:
                result = fetch_and_commit_outlook(
                    self.store,
                    full_scan=True if rebuild else None,
                    synchronize=synchronize,
                    cancel_event=context.cancel_event,
                    progress=context.progress_callback,
                )
            except MailFetchCancelled as exc:
                raise JobCancelled(str(exc)) from exc
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
            context.report("preview", f"Validating legacy backup {selected.name}")
            preview = preview_pendings_restore(self.store, selected)
            if not bool(payload.get("confirmed")):
                raise ValidationError(
                    "Restoring a backup requires confirmation",
                    details={"preview": preview, "requiresConfirmation": True},
                )
            result = restore_pendings_backup(self.store, selected, directory)
            self._touch_data("legacy-backup-database-restore")
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
            "databaseMaintenance": None,
        }
        try:
            self.store.validate_current(self.store.current)
            result["tickets"] = sum(1 for _ in self.store.iter_ticket_ids())
        except Exception as exc:
            result["store"] = f"error: {exc}"
            record_exception(self.store.config_home, "ZEUS DOCTOR", exc)
        try:
            result["databaseMaintenance"] = inspect_database(self.store)
        except Exception as exc:
            result["databaseMaintenance"] = {"status": "blocked", "message": str(exc)}
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
