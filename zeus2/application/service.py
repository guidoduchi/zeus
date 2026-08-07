from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..diagnostics import diagnostic_log_path, record_exception
from ..excel_export import (
    list_pendings_backups,
    preview_pendings_restore,
    publish_operational_workbooks,
    restore_pendings_backup,
)
from ..mail import fetch_and_commit_outlook, synchronize_staged_email
from ..mop import generate_mop
from ..reconcile import sync_newest_advanced_search
from ..startup import StartupResult, reconcile_advanced_and_new_mail, run_startup
from ..store import StoreError, ZeusStore
from ..utils import iso_now, normalize_ticket_id
from .edits import edit_ticket_through_pendings
from .errors import (
    BusyError,
    FeatureUnavailableError,
    NotFoundError,
    ValidationError,
)
from .jobs import EventBroker, JobContext, JobManager
from .serialization import (
    dashboard_payload,
    serialize_ticket_detail,
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

    def dashboard(self, *, sort: str, search: str) -> dict[str, Any]:
        if sort not in {"report", "sr", "planned", "email", "age", "severity", "status"}:
            raise ValidationError(f"Unsupported dashboard sort: {sort}")
        return dashboard_payload(
            self.store,
            sort=sort,
            search=search,
            dataset_revision=self.dataset_revision,
        )

    def ticket(self, ticket_id: str) -> dict[str, Any]:
        try:
            ticket = self.store.read_ticket(normalize_ticket_id(ticket_id))
        except (StoreError, ValueError) as exc:
            raise NotFoundError(f"Ticket {ticket_id} was not found") from exc
        detail = serialize_ticket_detail(ticket, self.store.config)
        detail["history"] = self.ticket_history(ticket_id)
        detail["mops"] = self.list_mops(ticket_id)
        return detail

    def edit_ticket(
        self,
        ticket_id: str,
        *,
        changes: dict[str, Any],
        expected_revision: str,
    ) -> dict[str, Any]:
        if not self._operation_lock.acquire(blocking=False):
            raise BusyError("Another Zeus operation is changing data. Try again when it finishes.")
        try:
            result = edit_ticket_through_pendings(
                self.store,
                normalize_ticket_id(ticket_id),
                changes,
                expected_revision=expected_revision,
            )
        finally:
            self._operation_lock.release()
        if result.get("changed"):
            self._touch_data("ticket-edit")
        return {
            "changed": bool(result.get("changed")),
            "changedFields": result.get("changedFields", []),
            "ticket": serialize_ticket_detail(result["ticket"], self.store.config),
        }

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
