from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Event
from typing import Any

from .diagnostics import record_exception
from .excel_export import (
    recover_pendings_recreation,
    recover_pendings_restore,
    recover_publication,
)
from .excel_import import WorkbookValidationError
from .mail import (
    MailFetchCancelled,
    fetch_and_commit_outlook,
    interval_due_minutes,
    synchronize_staged_email,
)
from .reconcile import (
    ReconciliationError,
    sync_newest_advanced_search,
)
from .store import ZeusStore


@dataclass
class StartupResult:
    warnings: list[str] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    operations: dict[str, Any] = field(default_factory=dict)
    advanced_search_valid: bool = False
    email_updates_pending: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _workbook_paths(store: ZeusStore) -> tuple[Path | None, Path | None, Path | None]:
    directory = store.configured_directory("workbook_directory")
    if directory is None:
        return None, None, None
    return directory, directory / "Pendings.xlsx", directory / "Closed.xlsx"


def _email_ready(store: ZeusStore) -> bool:
    path = store.configured_directory("outlook_store_path")
    return bool(path and path.is_file())


def _record_email_warning(
    store: ZeusStore,
    result: StartupResult,
    label: str,
    error: BaseException,
) -> None:
    log_path = getattr(error, "diagnostic_log_path", None)
    if log_path is None:
        log_path = record_exception(store.config_home, label, error)
    details = f" Diagnostic log: {log_path}" if log_path is not None else ""
    result.warnings.append(f"{label} — {error}.{details}")


def _fetch_new_tickets(
    store: ZeusStore,
    ticket_ids: list[str],
    result: StartupResult,
    *,
    cancel_event: Event | None,
    progress: Any,
) -> None:
    if not ticket_ids:
        return
    enabled = bool(
        store.config.get("email", {}).get(
            "fetch_new_ticket_history_automatically", True
        )
    )
    if not enabled:
        result.notices.append(
            f"Email history for {len(ticket_ids)} new ticket(s) was deferred by configuration."
        )
        return
    if not _email_ready(store):
        result.notices.append(
            "New-ticket email history was skipped because no Outlook store is configured."
        )
        return
    try:
        result.operations["new_ticket_email"] = fetch_and_commit_outlook(
            store,
            ticket_ids=ticket_ids,
            full_scan=True,
            synchronize=True,
            update_global_timers=False,
            cancel_event=cancel_event,
            progress=progress,
        )
    except MailFetchCancelled:
        result.notices.append("New-ticket email history fetch was cancelled; nothing was committed.")
    except Exception as exc:
        _record_email_warning(
            store,
            result,
            "NEW-TICKET EMAIL WARNING",
            exc,
        )


def reconcile_advanced_and_new_mail(
    store: ZeusStore,
    *,
    fetch_new: bool = True,
    cancel_event: Event | None = None,
    progress: Any = None,
) -> StartupResult:
    result = StartupResult()
    directory = store.configured_directory("advanced_search_directory")
    if directory is None:
        result.notices.append(
            "Advanced Search was skipped because its directory is not configured. "
            "The local Zeus database was left unchanged."
        )
        return result
    if directory.is_dir():
        pattern = store.config.get("advanced_search", {}).get(
            "glob", "Advanced Search*.xlsx"
        )
        available = any(
            path.is_file() and not path.name.startswith("~$")
            for path in directory.glob(str(pattern))
        )
        if not available:
            result.notices.append(
                "Advanced Search was skipped because no matching workbook is "
                "currently available. The local Zeus database was left unchanged."
            )
            return result
    try:
        advanced = sync_newest_advanced_search(store)
        result.operations["advanced_search"] = advanced
        result.advanced_search_valid = True
        if fetch_new:
            _fetch_new_tickets(
                store,
                list(advanced.get("added_ids", [])),
                result,
                cancel_event=cancel_event,
                progress=progress,
            )
    except (WorkbookValidationError, ReconciliationError, OSError) as exc:
        result.warnings.append(
            "ADVANCED SEARCH WARNING — online fields and email eligibility were not "
            f"refreshed: {exc}. No values from that workbook were applied."
        )
    return result


def run_startup(
    store: ZeusStore,
    *,
    recreate_missing_pendings: bool = False,
    cancel_event: Event | None = None,
    progress: Any = None,
) -> StartupResult:
    """Recover interrupted exports, then reconcile external read-only sources.

    ``recreate_missing_pendings`` is retained only for call compatibility with
    Zeus 3.1.2. Pendings.xlsx and Closed.xlsx are output artifacts now and are
    never imported or created by startup/query operations.
    """

    store.ensure_layout()
    result = StartupResult()
    workbook_directory, _, _ = _workbook_paths(store)

    if workbook_directory is not None:
        try:
            # Finish journals created by an older release before adopting the
            # database-first contract. No ordinary workbook import follows.
            restored = recover_pendings_restore(store, workbook_directory)
            if restored:
                result.operations["pendings_restore_recovery"] = restored
            recovered = recover_publication(store, workbook_directory)
            if recovered:
                result.operations["publication_recovery"] = recovered
            recreated = recover_pendings_recreation(store, workbook_directory)
            if recreated:
                result.operations["pendings_recreation_recovery"] = recreated
                if recreated.get("created") and recreated.get("notice"):
                    result.notices.append(str(recreated["notice"]))
        except Exception as exc:
            result.warnings.append(f"PUBLICATION RECOVERY WARNING — {exc}")

    advanced_result = reconcile_advanced_and_new_mail(
        store, fetch_new=False, cancel_event=cancel_event, progress=progress
    )
    result.operations.update(advanced_result.operations)
    result.warnings.extend(advanced_result.warnings)
    result.notices.extend(advanced_result.notices)
    result.advanced_search_valid = advanced_result.advanced_search_valid

    if result.advanced_search_valid and _email_ready(store):
        config = store.config.get("email", {})
        state = store.state().get("email_state", {})
        new_ticket_ids = list(
            result.operations.get("advanced_search", {}).get("added_ids", [])
        )
        fetch_due = interval_due_minutes(
            int(config.get("fetch_interval_minutes", 60)),
            state.get("last_successful_full_email_fetch_at"),
        )
        fetch_succeeded = False
        if fetch_due:
            try:
                result.operations["email_fetch"] = fetch_and_commit_outlook(
                    store,
                    full_scan=None,
                    synchronize=config.get("sync_mode") == "after_fetch",
                    cancel_event=cancel_event,
                    progress=progress,
                )
                fetch_succeeded = True
            except MailFetchCancelled:
                result.notices.append(
                    "Automatic email fetch was cancelled; the dashboard opened and no fetch timestamp changed."
                )
            except Exception as exc:
                _record_email_warning(store, result, "EMAIL FETCH WARNING", exc)
        elif new_ticket_ids:
            _fetch_new_tickets(
                store,
                new_ticket_ids,
                result,
                cancel_event=cancel_event,
                progress=progress,
            )

        if (
            fetch_succeeded
            and new_ticket_ids
            and config.get("sync_mode") == "scheduled"
            and bool(config.get("fetch_new_ticket_history_automatically", True))
        ):
            # The global fetch already scanned these messages; synchronize only
            # the new tickets now without moving the seven-day global timer.
            result.operations["new_ticket_email_sync"] = synchronize_staged_email(
                store, ticket_ids=new_ticket_ids, update_global_timer=False
            )

        # Independent synchronization may apply an older successful stage even
        # when today's newer fetch was cancelled or failed.
        if config.get("sync_mode") == "scheduled":
            refreshed_state = store.state().get("email_state", {})
            if interval_due_minutes(
                int(config.get("sync_interval_minutes", 60)),
                refreshed_state.get("last_successful_email_sync_at"),
            ):
                try:
                    result.operations["email_sync"] = synchronize_staged_email(store)
                except Exception as exc:
                    _record_email_warning(store, result, "EMAIL SYNC WARNING", exc)
    elif result.advanced_search_valid and not _email_ready(store):
        configured = store.config.get("paths", {}).get("outlook_store_path")
        if configured:
            result.notices.append(
                "Email tasks were skipped because the configured Outlook store is unavailable."
            )
        else:
            result.notices.append(
                "Email fetching is disabled until an Outlook store path is configured."
            )

    email_state = store.state().get("email_state", {})
    result.email_updates_pending = int(email_state.get("staged_message_count") or 0) > 0
    return result
