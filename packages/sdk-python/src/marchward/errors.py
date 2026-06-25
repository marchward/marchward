"""Marchward SDK exceptions."""

from __future__ import annotations


class MarchwardError(Exception):
    """Base class for all Marchward SDK errors."""


class MarchwardAuthError(MarchwardError):
    """Raised on a 401 — the API key is missing, invalid, or revoked."""


class MarchwardAPIError(MarchwardError):
    """Raised on an unexpected API response (5xx, malformed body, etc.)."""

    def __init__(self, message: str, *, status: int | None = None, body: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
