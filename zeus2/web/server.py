from __future__ import annotations

import hmac
import mimetypes
import re
import secrets
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlsplit

from ..application.errors import ApplicationError, NotFoundError, ValidationError
from ..application.service import ApplicationService
from ..config import SETTING_SPEC_BY_KEY
from ..diagnostics import record_exception
from ..store import StoreError
from ..utils import json_dumps
from ..version import __version__
from .dialogs import choose_directory, choose_file, open_folder


MAX_JSON_BODY = 1_000_000
TICKET_ROUTE = re.compile(r"^/api/tickets/(\d{8})$")
TICKET_LOCAL_ROUTE = re.compile(r"^/api/tickets/(\d{8})/local$")
JOB_CANCEL_ROUTE = re.compile(r"^/api/jobs/([a-f0-9]{32})/cancel$")
MOP_DOWNLOAD_ROUTE = re.compile(r"^/api/tickets/(\d{8})/mops/([^/]+)$")
SPARE_REQUEST_ROUTE = re.compile(r"^/api/spare-requests/(\d{12})$")
SPARE_REQUEST_PREFILL_ROUTE = re.compile(r"^/api/spare-requests/prefill/(\d{8})$")
SPARE_REQUEST_REEXPORT_ROUTE = re.compile(r"^/api/spare-requests/(\d{12})/re-export$")
SPARE_REQUEST_RESOLVE_ROUTE = re.compile(r"^/api/spare-requests/(\d{12})/conflicts/resolve$")


class ZeusWebServer(ThreadingHTTPServer):
    """A local-only HTTP server carrying one ApplicationService instance."""

    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        address: tuple[str, int],
        service: ApplicationService,
        *,
        static_root: Path,
        instance_id: str,
        control_token: str | None = None,
        shutdown_callback: Callable[[], None] | None = None,
        restart_callback: Callable[[], None] | None = None,
    ):
        host, _ = address
        if host != "127.0.0.1":
            raise ValueError("Zeus must bind only to 127.0.0.1")
        self.service = service
        self.static_root = static_root.expanduser().resolve()
        self.instance_id = instance_id
        self.csrf_token = secrets.token_urlsafe(32)
        self.control_token = control_token or secrets.token_urlsafe(48)
        self.shutdown_callback = shutdown_callback
        self.restart_callback = restart_callback
        self._shutdown_requested = threading.Event()
        super().__init__(address, ZeusRequestHandler)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    def request_shutdown(self) -> None:
        if self._shutdown_requested.is_set():
            return
        self._shutdown_requested.set()

        def stop() -> None:
            if self.shutdown_callback is not None:
                try:
                    self.shutdown_callback()
                except Exception as exc:
                    record_exception(
                        self.service.store.config_home,
                        "ZEUS WEB SHUTDOWN",
                        exc,
                    )
            self.shutdown()

        threading.Thread(target=stop, name="zeus-http-shutdown", daemon=True).start()

    def request_restart(self) -> None:
        if self.restart_callback is not None:
            self.restart_callback()
        else:
            self.request_shutdown()


class ZeusRequestHandler(BaseHTTPRequestHandler):
    server: ZeusWebServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_HEAD(self) -> None:
        if not self._host_allowed():
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"code": "invalid_host", "message": "Invalid Host header"}})
            return
        path = urlsplit(self.path).path
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, self._health(), head_only=True)
            return
        self._send_static(path, head_only=True)

    def do_GET(self) -> None:
        self._dispatch(self._get)

    def do_POST(self) -> None:
        self._dispatch(self._post)

    def do_PATCH(self) -> None:
        self._dispatch(self._patch)

    def _dispatch(self, handler: Callable[[], None]) -> None:
        try:
            if not self._host_allowed():
                raise ValidationError("Invalid Host header")
            handler()
        except ApplicationError as exc:
            self._send_json(
                exc.status_code,
                {
                    "error": {
                        "code": exc.code,
                        "message": str(exc),
                        "details": exc.details,
                    }
                },
            )
        except (StoreError, ValueError) as exc:
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": {"code": "invalid_request", "message": str(exc), "details": {}}},
            )
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return
        except Exception as exc:
            log_path = record_exception(
                self.server.service.store.config_home,
                "ZEUS WEB REQUEST",
                exc,
            )
            self._send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": {
                        "code": "internal_error",
                        "message": "Zeus could not complete the request",
                        "details": {"diagnosticLog": str(log_path) if log_path else None},
                    }
                },
            )

    def _get(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, self._health())
            return
        if path == "/api/bootstrap":
            payload = self.server.service.bootstrap_payload()
            payload.update(
                {
                    "version": __version__,
                    "instanceId": self.server.instance_id,
                    "csrfToken": self.server.csrf_token,
                    "localUrl": self.server.url,
                }
            )
            self._send_json(HTTPStatus.OK, payload)
            return
        if path == "/api/profile":
            self._send_json(HTTPStatus.OK, self.server.service.user_profile())
            return
        if not path.startswith("/api/"):
            self._send_static(path)
            return
        self.server.service.require_setup()
        if path == "/api/global-data":
            self._send_json(HTTPStatus.OK, self.server.service.global_reference_data())
            return
        if path == "/api/spare-requests/bom-catalog":
            self._send_json(HTTPStatus.OK, self.server.service.bom_catalog())
            return
        if path == "/api/dashboard":
            workspace = query.get("workspace", ["service-requests"])[0]
            default_sort = "tt" if workspace == "spare-requests" else "sr" if workspace == "spare-parts" else "report"
            sort = query.get("sort", [default_sort])[0]
            direction = query.get("direction", [None])[0]
            search = query.get("search", [""])[0]
            view = query.get("view", ["active"])[0]
            self._send_json(
                HTTPStatus.OK,
                self.server.service.dashboard(
                    workspace=workspace,
                    sort=sort,
                    direction=direction,
                    search=search,
                    view=view,
                ),
            )
            return
        if path == "/api/spare-requests/reference-data":
            self._send_json(HTTPStatus.OK, self.server.service.spare_reference_data())
            return
        prefill_match = SPARE_REQUEST_PREFILL_ROUTE.fullmatch(path)
        if prefill_match:
            self._send_json(
                HTTPStatus.OK,
                self.server.service.spare_request_prefill(prefill_match.group(1)),
            )
            return
        spare_request_match = SPARE_REQUEST_ROUTE.fullmatch(path)
        if spare_request_match:
            self._send_json(
                HTTPStatus.OK,
                self.server.service.spare_request(spare_request_match.group(1)),
            )
            return
        ticket_match = TICKET_ROUTE.fullmatch(path)
        if ticket_match:
            self._send_json(HTTPStatus.OK, self.server.service.ticket(ticket_match.group(1)))
            return
        if path == "/api/settings":
            self._send_json(HTTPStatus.OK, self.server.service.get_settings())
            return
        if path == "/api/jobs":
            self._send_json(HTTPStatus.OK, {"jobs": self.server.service.jobs.snapshots()})
            return
        if path == "/api/backups/pendings":
            self._send_json(HTTPStatus.OK, {"backups": self.server.service.pendings_backups()})
            return
        if path == "/api/backups/pendings/preview":
            name = query.get("name", [""])[0]
            self._send_json(
                HTTPStatus.OK,
                {"preview": self.server.service.preview_pendings_backup(name)},
            )
            return
        if path == "/api/templates":
            self._send_json(HTTPStatus.OK, {"templates": self.server.service.templates()})
            return
        if path == "/api/events":
            self._send_events(query)
            return
        mop_match = MOP_DOWNLOAD_ROUTE.fullmatch(path)
        if mop_match:
            self._send_mop(mop_match.group(1), unquote(mop_match.group(2)))
            return
        if path.startswith("/api/"):
            raise NotFoundError("API endpoint not found")
        self._send_static(path)

    def _post(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/system/shutdown" and self._control_authorized():
            self._send_json(HTTPStatus.ACCEPTED, {"stopping": True})
            self.server.request_shutdown()
            return
        self._require_browser_mutation()
        payload = self._read_json()
        if path == "/api/system/shutdown":
            self._send_json(HTTPStatus.ACCEPTED, {"stopping": True})
            self.server.request_shutdown()
            return
        if path == "/api/system/restart":
            self._send_json(HTTPStatus.ACCEPTED, {"restarting": True})
            threading.Timer(0.15, self.server.request_restart).start()
            return
        self.server.service.require_setup()
        if path.startswith("/api/jobs/"):
            cancel_match = JOB_CANCEL_ROUTE.fullmatch(path)
            if cancel_match:
                self._send_json(
                    HTTPStatus.ACCEPTED,
                    {"job": self.server.service.cancel_job(cancel_match.group(1))},
                )
                return
            kind = path.removeprefix("/api/jobs/")
            if not kind or "/" in kind:
                raise NotFoundError("Job endpoint not found")
            self._send_json(
                HTTPStatus.ACCEPTED,
                {"job": self.server.service.submit_job(kind, payload)},
            )
            return
        if path == "/api/storage/migrate":
            result = self.server.service.migrate_data_directory(
                str(payload.get("destination") or "")
            )
            self._send_json(HTTPStatus.CREATED, result)
            threading.Timer(0.2, self.server.request_restart).start()
            return
        if path == "/api/global-data/import-customer":
            self._send_json(
                HTTPStatus.OK,
                self.server.service.import_customer_from_ticket(
                    str(payload.get("ticketId") or "")
                ),
            )
            return
        if path == "/api/dialogs/path":
            self._path_dialog(payload)
            return
        if path == "/api/paths/open":
            self._open_configured_path(payload)
            return
        if path == "/api/outlook/candidates":
            directory = str(payload.get("directory") or "")
            if not directory:
                raise ValidationError("Choose a folder containing Outlook stores")
            self._send_json(
                HTTPStatus.OK,
                {"candidates": self.server.service.scan_outlook(directory)},
            )
            return
        if path == "/api/spare-requests/export":
            self._send_json(
                HTTPStatus.CREATED,
                self.server.service.export_spare_request(payload),
            )
            return
        reexport_match = SPARE_REQUEST_REEXPORT_ROUTE.fullmatch(path)
        if reexport_match:
            self._send_json(
                HTTPStatus.OK,
                self.server.service.reexport_spare_request(reexport_match.group(1)),
            )
            return
        resolve_match = SPARE_REQUEST_RESOLVE_ROUTE.fullmatch(path)
        if resolve_match:
            self._send_json(
                HTTPStatus.OK,
                self.server.service.resolve_spare_conflict(
                    resolve_match.group(1),
                    item_id=(str(payload.get("itemId")) if payload.get("itemId") else None),
                    conflict_index=int(payload.get("conflictIndex", -1)),
                    resolution=str(payload.get("resolution") or ""),
                    note=str(payload.get("note") or ""),
                ),
            )
            return
        if path == "/api/spare-requests/returns/export":
            selections = payload.get("selections")
            if not isinstance(selections, list):
                raise ValidationError("Return selections must be a list")
            self._send_json(
                HTTPStatus.CREATED,
                self.server.service.export_spare_return(selections),
            )
            return
        if path == "/api/spare-requests/archive":
            item_ids = payload.get("itemIds")
            if not isinstance(item_ids, list):
                raise ValidationError("Archive item IDs must be a list")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.archive_spare_items(
                    item_ids=item_ids,
                    reason=str(payload.get("reason") or ""),
                    note=str(payload.get("note") or ""),
                    manual_override=bool(payload.get("manualOverride")),
                ),
            )
            return
        if path == "/api/spare-requests/purge":
            item_ids = payload.get("itemIds")
            if item_ids is not None and not isinstance(item_ids, list):
                raise ValidationError("Purge item IDs must be a list")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.purge_spare_data(item_ids=item_ids),
            )
            return
        raise NotFoundError("API endpoint not found")

    def _patch(self) -> None:
        self._require_browser_mutation()
        path = urlsplit(self.path).path
        payload = self._read_json()
        if path == "/api/profile":
            value = payload.get("profile")
            if not isinstance(value, dict):
                raise ValidationError("Profile data must be an object")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.save_user_profile(value),
            )
            return
        self.server.service.require_setup()
        if path == "/api/global-data":
            value = payload.get("value")
            if not isinstance(value, dict):
                raise ValidationError("Global manager data must be an object")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.save_global_reference_data(value),
            )
            return
        if path == "/api/spare-requests/bom-catalog":
            value = payload.get("value")
            if not isinstance(value, dict):
                raise ValidationError("BOM catalog data must be an object")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.save_bom_catalog(value),
            )
            return
        ticket_match = TICKET_LOCAL_ROUTE.fullmatch(path)
        if ticket_match:
            changes = payload.get("changes")
            if not isinstance(changes, dict):
                raise ValidationError("Ticket changes must be an object")
            expected_revision = str(
                self.headers.get("If-Match") or payload.get("revision") or ""
            ).strip('"')
            self._send_json(
                HTTPStatus.OK,
                self.server.service.edit_ticket(
                    ticket_match.group(1),
                    changes=changes,
                    expected_revision=expected_revision,
                ),
            )
            return
        if path == "/api/settings":
            updates = payload.get("updates")
            if not isinstance(updates, dict):
                raise ValidationError("Configuration updates must be an object")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.save_settings(updates),
            )
            return
        spare_request_match = SPARE_REQUEST_ROUTE.fullmatch(path)
        if spare_request_match:
            changes = payload.get("changes") or {}
            item_updates = payload.get("itemUpdates") or []
            if not isinstance(changes, dict) or not isinstance(item_updates, list):
                raise ValidationError("Spare Request changes are invalid")
            expected_revision = str(
                self.headers.get("If-Match") or payload.get("revision") or ""
            ).strip('"')
            self._send_json(
                HTTPStatus.OK,
                self.server.service.edit_spare_request(
                    spare_request_match.group(1),
                    expected_revision=expected_revision,
                    changes=changes,
                    item_updates=item_updates,
                ),
            )
            return
        if path == "/api/spare-requests/reference-data":
            value = payload.get("value")
            if not isinstance(value, dict):
                raise ValidationError("Manager data must be an object")
            self._send_json(
                HTTPStatus.OK,
                self.server.service.save_spare_reference_data(value),
            )
            return
        raise NotFoundError("API endpoint not found")

    def _health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "zeus",
            "version": __version__,
            "instanceId": self.server.instance_id,
        }

    def _host_allowed(self) -> bool:
        host = self.headers.get("Host", "")
        allowed = {
            f"127.0.0.1:{self.server.server_port}",
            f"localhost:{self.server.server_port}",
        }
        return host in allowed

    def _control_authorized(self) -> bool:
        supplied = self.headers.get("X-Zeus-Control", "")
        return bool(supplied) and hmac.compare_digest(supplied, self.server.control_token)

    def _require_browser_mutation(self) -> None:
        supplied = self.headers.get("X-Zeus-CSRF", "")
        if not supplied or not hmac.compare_digest(supplied, self.server.csrf_token):
            error = ApplicationError("The Zeus security token is missing or expired")
            error.status_code = HTTPStatus.FORBIDDEN
            error.code = "csrf_failed"
            raise error
        origin = self.headers.get("Origin")
        if origin and origin not in {self.server.url, self.server.url.replace("127.0.0.1", "localhost")}:
            error = ApplicationError("Cross-origin requests are not allowed")
            error.status_code = HTTPStatus.FORBIDDEN
            error.code = "origin_rejected"
            raise error

    def _read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise ValidationError("Invalid Content-Length") from exc
        if length < 0 or length > MAX_JSON_BODY:
            raise ValidationError("Request body is too large")
        if length == 0:
            return {}
        if self.headers.get_content_type() != "application/json":
            raise ValidationError("Zeus API requests must use application/json")
        raw = self.rfile.read(length)
        try:
            import json

            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValidationError("Request body is not valid JSON") from exc
        if not isinstance(value, dict):
            raise ValidationError("Request body must be a JSON object")
        return value

    def _path_dialog(self, payload: dict[str, Any]) -> None:
        key = str(payload.get("setting") or "")
        spec = SETTING_SPEC_BY_KEY.get(key)
        if spec is None or spec.kind not in {"directory", "data_directory", "outlook_store", "xlsx_template"}:
            raise ValidationError("Choose a path setting that supports Browse")
        current = self.server.service.store.config
        parts = key.split(".")
        value: Any = current
        for part in parts:
            value = value.get(part) if isinstance(value, dict) else None
        initial = self.server.service.store.root if spec.kind == "data_directory" else Path(str(value)).expanduser() if value else None
        if initial and initial.is_file():
            initial = initial.parent
        if spec.kind == "outlook_store":
            selected = choose_file(
                initial=initial,
                title="Choose a Classic Outlook store",
                filetypes=(("Outlook stores", "*.ost *.pst"), ("All files", "*.*")),
            )
        elif spec.kind == "xlsx_template":
            selected = choose_file(
                initial=initial,
                title=spec.label,
                filetypes=(("Excel workbooks", "*.xlsx"), ("All files", "*.*")),
            )
        else:
            selected = choose_directory(initial=initial, title=spec.label)
        self._send_json(
            HTTPStatus.OK,
            {"cancelled": selected is None, "path": str(selected) if selected else None},
        )

    def _open_configured_path(self, payload: dict[str, Any]) -> None:
        key = str(payload.get("setting") or "")
        spec = SETTING_SPEC_BY_KEY.get(key)
        if spec is None or not key.startswith("paths."):
            raise ValidationError("Unknown path setting")
        short_key = key.split(".", 1)[1]
        path = (
            self.server.service.store.root
            if short_key == "data_directory"
            else self.server.service.store.configured_directory(short_key)
        )
        if path is None:
            raise ValidationError(f"{spec.label} is not configured")
        if path.is_file():
            path = path.parent
        open_folder(path)
        self._send_json(HTTPStatus.OK, {"opened": True})

    def _send_events(self, query: dict[str, list[str]]) -> None:
        raw = self.headers.get("Last-Event-ID") or query.get("after", ["0"])[0]
        try:
            after = max(0, int(raw))
        except ValueError:
            after = 0
        events = self.server.service.broker.wait_after(after, timeout=20.0)
        chunks: list[str] = []
        if events:
            for event in events:
                chunks.extend(
                    [
                        f"id: {event['sequence']}\n",
                        f"event: {event['type']}\n",
                        f"data: {json_dumps(event, indent=None)}\n\n",
                    ]
                )
        else:
            chunks.append(": heartbeat\n\n")
        body = "".join(chunks).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self._security_headers(cache=False)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int | HTTPStatus, payload: Any, *, head_only: bool = False) -> None:
        body = (json_dumps(payload, indent=None) + "\n").encode("utf-8")
        self.send_response(int(status))
        self._security_headers(cache=False)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _security_headers(self, *, cache: bool) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable" if cache else "no-store",
        )

    def _send_static(self, request_path: str, *, head_only: bool = False) -> None:
        relative = request_path.lstrip("/") or "index.html"
        candidate = (self.server.static_root / relative).resolve()
        root = self.server.static_root
        if candidate != root and root not in candidate.parents:
            raise NotFoundError("Asset not found")
        if not candidate.is_file():
            candidate = root / "index.html"
        if not candidate.is_file():
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": {
                        "code": "frontend_missing",
                        "message": "The Zeus web interface has not been built",
                        "details": {},
                    }
                },
                head_only=head_only,
            )
            return
        body = candidate.read_bytes()
        content_type, _ = mimetypes.guess_type(candidate.name)
        self.send_response(HTTPStatus.OK)
        self._security_headers(cache=candidate.name != "index.html")
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_mop(self, ticket_id: str, filename: str) -> None:
        if Path(filename).name != filename or not filename.lower().endswith(".docx"):
            raise NotFoundError("MOP file not found")
        directory = self.server.service.store.ticket_dir(ticket_id) / "mops"
        path = (directory / filename).resolve()
        if path.parent != directory.resolve() or not path.is_file():
            raise NotFoundError("MOP file not found")
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self._security_headers(cache=False)
        self.send_header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
