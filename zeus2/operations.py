from __future__ import annotations

from typing import Any

from .store import ZeusStore


class ReadOnlyTicketError(PermissionError):
    """Raised when a caller tries to edit ticket work data in Zeus."""


READ_ONLY_MESSAGE = (
    "Direct extension writes are forbidden. Edit recognized work fields through "
    "the Zeus web panel so the local Markdown database remains authoritative."
)


def update_ticket(
    store: ZeusStore,
    ticket_id: str,
    **changes: Any,
) -> dict[str, Any]:
    raise ReadOnlyTicketError(READ_ONLY_MESSAGE)


def append_note(store: ZeusStore, ticket_id: str, text: str) -> dict[str, Any]:
    raise ReadOnlyTicketError(READ_ONLY_MESSAGE)
