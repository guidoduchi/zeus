from __future__ import annotations

from typing import Any


class ApplicationError(RuntimeError):
    """A safe, user-facing application error."""

    status_code = 400
    code = "application_error"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.details = details or {}


class NotFoundError(ApplicationError):
    status_code = 404
    code = "not_found"


class ConflictError(ApplicationError):
    status_code = 409
    code = "conflict"


class BusyError(ApplicationError):
    status_code = 423
    code = "busy"


class SetupRequiredError(ApplicationError):
    status_code = 428
    code = "setup_required"


class ValidationError(ApplicationError):
    status_code = 422
    code = "validation_error"


class FeatureUnavailableError(ApplicationError):
    status_code = 503
    code = "feature_unavailable"
