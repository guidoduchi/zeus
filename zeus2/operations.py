from __future__ import annotations

from typing import Any

from .store import ZeusStore


class ReadOnlyTicketError(PermissionError):
    """Raised when a caller tries to edit ticket work data in Zeus."""


READ_ONLY_MESSAGE = (
    "Direct Markdown ticket edits are forbidden. Edit recognized local fields "
    "through the Zeus web panel or in Pendings.xlsx; both paths keep Pendings authoritative."
)


def update_ticket(
    store: ZeusStore,
    ticket_id: str,
    **changes: Any,
) -> dict[str, Any]:
    raise ReadOnlyTicketError(READ_ONLY_MESSAGE)


def append_note(store: ZeusStore, ticket_id: str, text: str) -> dict[str, Any]:
    raise ReadOnlyTicketError(READ_ONLY_MESSAGE)
