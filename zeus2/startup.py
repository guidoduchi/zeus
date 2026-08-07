from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Event
from typing import Any

from .excel_export import recover_pendings_restore, recover_publication
from .excel_import import WorkbookValidationError
from .mail import (
    MailFetchCancelled,
    MailSyncError,
    fetch_and_commit_outlook,
    interval_due,
    synchronize_staged_email,
)
from .reconcile import (
    ReconciliationError,
    import_pendings,
    initialize_closed_index,
    record_pendings_error,
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
    return store.configured_directory("outlook_store_path") is not None


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
    except MailSyncError as exc:
        result.warnings.append(f"New-ticket email history failed: {exc}")


def reconcile_advanced_and_new_mail(
    store: ZeusStore,
    *,
    fetch_new: bool = True,
    cancel_event: Event | None = None,
    progress: Any = None,
) -> StartupResult:
    result = StartupResult()
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
            f"refreshed: {exc}"
        )
    return result


def run_startup(
    store: ZeusStore,
    *,
    cancel_event: Event | None = None,
    progress: Any = None,
) -> StartupResult:
    """Run the locked startup sequence without publishing either workbook."""

    store.ensure_layout()
    result = StartupResult()
    workbook_directory, pending_path, closed_path = _workbook_paths(store)

    if workbook_directory is None:
        result.warnings.append(
            "PENDINGS WARNING — workbook directory is not configured; local fields were not imported."
        )
    else:
        try:
            restored = recover_pendings_restore(store, workbook_directory)
            if restored:
                result.operations["pendings_restore_recovery"] = restored
            recovered = recover_publication(store, workbook_directory)
            if recovered:
                result.operations["publication_recovery"] = recovered
        except Exception as exc:
            result.warnings.append(f"PUBLICATION RECOVERY WARNING — {exc}")

        try:
            assert pending_path is not None
            result.operations["pendings_import"] = import_pendings(store, pending_path)
        except (WorkbookValidationError, ReconciliationError, OSError) as exc:
            message = str(exc)
            result.warnings.append(
                "PENDINGS WARNING — the Markdown database was preserved and no local "
                f"fields were imported: {message}"
            )
            try:
                record_pendings_error(store, message)
            except Exception:
                pass

        if closed_path is not None and closed_path.exists():
            try:
                result.operations["closed_index"] = initialize_closed_index(
                    store, closed_path
                )
            except (WorkbookValidationError, OSError) as exc:
                result.warnings.append(f"CLOSED WARNING — {exc}")

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
        fetch_due = interval_due(
            int(config.get("fetch_interval_days", 7)),
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
            except MailSyncError as exc:
                result.warnings.append(f"EMAIL FETCH WARNING — {exc}")
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
            if interval_due(
                int(config.get("sync_interval_days", 7)),
                refreshed_state.get("last_successful_email_sync_at"),
            ):
                try:
                    result.operations["email_sync"] = synchronize_staged_email(store)
                except MailSyncError as exc:
                    result.warnings.append(f"EMAIL SYNC WARNING — {exc}")
    elif result.advanced_search_valid and not _email_ready(store):
        result.notices.append("Email fetching is disabled until an Outlook store path is configured.")

    email_state = store.state().get("email_state", {})
    result.email_updates_pending = int(email_state.get("staged_message_count") or 0) > 0
    return result
