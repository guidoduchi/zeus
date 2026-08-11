from __future__ import annotations

import copy
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .utils import atomic_write_json, load_json


CONFIG_FILENAME = "zeus_config.json"
DATA_DIRECTORY_NAME = "data"
OUTLOOK_STORE_SUFFIXES = {".ost", ".pst"}

# Every option the specification identifies as user-configurable lives here.
# Runtime markers (processed filenames, hashes and successful operation times)
# live in current/state.json and are never accepted from this file.
DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": 10,
    "paths": {
        # ``None`` keeps the mutable database under ``%LOCALAPPDATA%\\Zeus\\data``.
        # A configured value is only written by the verified migration workflow;
        # the generic settings editor must never repoint it directly.
        "data_directory": None,
        "workbook_directory": None,
        "advanced_search_directory": None,
        "outlook_store_path": None,
        "template_directory": None,
        "spare_parts_export_directory": None,
        "spare_request_template_path": None,
        "spare_return_template_path": None,
    },
    "advanced_search": {
        "glob": "Advanced Search*.xlsx",
        "poll_interval_minutes": 15,
    },
    "email": {
        "fetch_interval_minutes": 60,
        "sync_mode": "after_fetch",  # scheduled | after_fetch
        "sync_interval_minutes": 60,
        "retained_message_count": 7,
        "incremental_overlap_days": 7,
        "fetch_new_ticket_history_automatically": True,
        # Organization-specific senders stay in local configuration rather
        # than being embedded in the distributable application.
        "request_confirmation_sender": None,
        "dispatch_notification_sender": None,
        "warehouse_sender_domain": None,
    },
    "aging": {
        "calendar_days": True,
        "communication_yellow_days": 3,
        "communication_red_days": 7,
        "ticket_age_yellow_days": 14,
        "ticket_age_red_days": 30,
        "planned_due_soon_days": 2,
        "resolve_due_soon_days": 3,
        "resolve_suspend_status_contains": ["suspend"],
        "spare_dispatch_red_days": 20,
    },
    "excel": {
        "portal_url_template": None,
        "backup_retention_count": 10,
    },
    "web": {
        "port": 8765,
        "open_browser": True,
        "system_tray": True,
        "font_scale": "standard",
        "show_detail_history": False,
    },
}


@dataclass(frozen=True)
class SettingSpec:
    """One user-facing configuration item.

    JSON paths remain an implementation detail.  The interactive application
    renders these labels and applies the declared type/constraints instead of
    asking a user to edit arbitrary dotted keys.
    """

    key: str
    label: str
    category: str
    kind: str
    description: str
    minimum: int | None = None
    choices: tuple[str, ...] = ()
    nullable: bool = False
    editable: bool = True


SETTING_SPECS: tuple[SettingSpec, ...] = (
    SettingSpec(
        "paths.data_directory",
        "Zeus data folder",
        "Application storage",
        "data_directory",
        "Mutable Markdown database, backups, audit history, profile, and local managers. Use Move data to change it safely.",
        editable=False,
    ),
    SettingSpec(
        "paths.workbook_directory",
        "Workbook folder",
        "Paths",
        "directory",
        "Folder containing Pendings.xlsx and Closed.xlsx.",
    ),
    SettingSpec(
        "paths.advanced_search_directory",
        "Advanced Search folder",
        "Paths",
        "directory",
        "Folder Zeus scans for Advanced Search workbooks.",
    ),
    SettingSpec(
        "paths.outlook_store_path",
        "Outlook mailbox store",
        "Paths",
        "outlook_store",
        "Selected classic Outlook .ost/.pst store; may be disabled.",
        nullable=True,
    ),
    SettingSpec(
        "paths.template_directory",
        "MOP template folder",
        "Paths",
        "directory",
        "Optional default folder for MOP templates.",
        nullable=True,
    ),
    SettingSpec(
        "paths.spare_parts_export_directory",
        "Spare Request export folder",
        "Paths",
        "directory",
        "Root destination; Zeus creates Requests and Returns subfolders and never imports from them.",
        nullable=True,
    ),
    SettingSpec(
        "paths.spare_request_template_path",
        "Spare Request XLSX template",
        "Paths",
        "xlsx_template",
        "Local two-sheet request template. Worksheet names are preserved from the selected file.",
        nullable=True,
    ),
    SettingSpec(
        "paths.spare_return_template_path",
        "Faulty Return XLSX template",
        "Paths",
        "xlsx_template",
        "Local one-sheet Fault Tag return template. The file remains outside the installation and repository.",
        nullable=True,
    ),
    SettingSpec(
        "advanced_search.glob",
        "Advanced Search filename pattern",
        "Advanced Search",
        "text",
        "Filename pattern used while scanning the download folder.",
    ),
    SettingSpec(
        "advanced_search.poll_interval_minutes",
        "Data query interval",
        "Data sources",
        "integer",
        "Minutes between Advanced Search checks while Zeus is open; 0 disables scheduled checks.",
        minimum=0,
    ),
    SettingSpec(
        "email.fetch_interval_minutes",
        "Email fetch interval",
        "Email",
        "integer",
        "Minutes between Outlook fetches while Zeus is open; -1 startup only, 0 manual only.",
        minimum=-1,
    ),
    SettingSpec(
        "email.sync_mode",
        "Email synchronization mode",
        "Email",
        "choice",
        "Synchronize on its schedule or immediately after each fetch.",
        choices=("scheduled", "after_fetch"),
    ),
    SettingSpec(
        "email.sync_interval_minutes",
        "Email synchronization interval",
        "Email",
        "integer",
        "Minutes between staged-email syncs when it is independent; linked mode inherits the fetch interval.",
        minimum=-1,
    ),
    SettingSpec(
        "email.retained_message_count",
        "Retained email bodies",
        "Email",
        "integer",
        "Newest sent/received message bodies retained per ticket.",
        minimum=0,
    ),
    SettingSpec(
        "email.incremental_overlap_days",
        "Incremental email overlap",
        "Email",
        "integer",
        "Days rescanned on incremental fetches before deduplication.",
        minimum=0,
    ),
    SettingSpec(
        "email.fetch_new_ticket_history_automatically",
        "Fetch new-ticket email history",
        "Email",
        "boolean",
        "Fetch and synchronize history when a new ticket is discovered.",
    ),
    SettingSpec(
        "email.request_confirmation_sender",
        "Request-confirmation sender",
        "Email",
        "text",
        "Exact trusted email address used for Spare SR and RMA assignment messages.",
        nullable=True,
    ),
    SettingSpec(
        "email.dispatch_notification_sender",
        "Dispatch-notification sender",
        "Email",
        "text",
        "Exact trusted email address used for delivered BOM and new-serial messages.",
        nullable=True,
    ),
    SettingSpec(
        "email.warehouse_sender_domain",
        "Warehouse sender domain",
        "Email",
        "text",
        "Trusted email domain for return/warehouse messages, for example @warehouse.example.",
        nullable=True,
    ),
    SettingSpec(
        "aging.calendar_days",
        "Aging basis",
        "Aging",
        "locked",
        "Zeus uses calendar days.",
        editable=False,
    ),
    SettingSpec(
        "aging.communication_yellow_days",
        "Communication warning",
        "Aging",
        "integer",
        "Days without email before communication becomes yellow.",
        minimum=0,
    ),
    SettingSpec(
        "aging.communication_red_days",
        "Communication critical",
        "Aging",
        "integer",
        "Days without email before communication becomes red.",
        minimum=0,
    ),
    SettingSpec(
        "aging.ticket_age_yellow_days",
        "Ticket-age warning",
        "Aging",
        "integer",
        "Ticket age in days before it becomes yellow.",
        minimum=0,
    ),
    SettingSpec(
        "aging.ticket_age_red_days",
        "Ticket-age critical",
        "Aging",
        "integer",
        "Ticket age in days before it becomes red.",
        minimum=0,
    ),
    SettingSpec(
        "aging.planned_due_soon_days",
        "Planned-date warning window",
        "Aging",
        "integer",
        "Days before Planned Date when it becomes yellow.",
        minimum=0,
    ),
    SettingSpec(
        "aging.resolve_due_soon_days",
        "ResolveBy warning window",
        "Aging",
        "integer",
        "Days before ResolveBy when it becomes yellow.",
        minimum=0,
    ),
    SettingSpec(
        "aging.spare_dispatch_red_days",
        "Spare dispatch overdue threshold",
        "Aging",
        "integer",
        "Displayed dispatch age when an unresolved active spare turns red; 20 means red on day 20.",
        minimum=0,
    ),
    SettingSpec(
        "aging.resolve_suspend_status_contains",
        "Suspended-status terms",
        "Aging",
        "string_list",
        "Comma-separated status fragments that suppress ResolveBy urgency.",
    ),
    SettingSpec(
        "excel.portal_url_template",
        "Ticket portal URL template",
        "Excel",
        "text",
        "Optional hyperlink template; use {ticket_id} for the SR number.",
        nullable=True,
    ),
    SettingSpec(
        "excel.backup_retention_count",
        "Workbook backup retention",
        "Excel",
        "integer",
        "Number of paired workbook backups Zeus retains.",
        minimum=1,
    ),
    SettingSpec(
        "web.port",
        "Local web port",
        "Application",
        "integer",
        "Preferred localhost port. Zeus selects another local port if it is occupied.",
        minimum=1024,
    ),
    SettingSpec(
        "web.open_browser",
        "Open browser on launch",
        "Application",
        "boolean",
        "Open Zeus in the default browser after its local server is ready.",
    ),
    SettingSpec(
        "web.system_tray",
        "System-tray controller",
        "Application",
        "boolean",
        "Keep Open, Logs, Restart, and Exit controls in the Windows notification area.",
    ),
    SettingSpec(
        "web.font_scale",
        "Interface text size",
        "Appearance",
        "choice",
        "Use one consistent typography scale throughout Zeus.",
        choices=("compact", "standard", "large"),
    ),
    SettingSpec(
        "web.show_detail_history",
        "Show raw detail history",
        "Developer options",
        "boolean",
        "Expose the raw History tab in Service Request and Active Request details. Off by default for ordinary users.",
    ),
)

SETTING_SPEC_BY_KEY = {spec.key: spec for spec in SETTING_SPECS}


def application_home() -> Path:
    """Return the writable Zeus application-data directory.

    Production Windows installs use ``%LOCALAPPDATA%\\Zeus``.  Explicit
    environment overrides keep portable diagnostics and automated tests
    possible without changing the production contract.
    """

    override = os.environ.get("ZEUS_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            return (Path(local) / "Zeus").resolve()
        return (Path.home() / "AppData" / "Local" / "Zeus").resolve()
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return (Path(xdg) / "Zeus").expanduser().resolve()
    return (Path.home() / ".local" / "share" / "Zeus").resolve()


def default_data_dir(home: Path | None = None) -> Path:
    override = os.environ.get("ZEUS_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return ((home or application_home()) / DATA_DIRECTORY_NAME).resolve()


def config_path(home: Path) -> Path:
    return home.expanduser().resolve() / CONFIG_FILENAME


def deep_merge(defaults: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(defaults)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def get_dotted(config: dict[str, Any], dotted_key: str) -> Any:
    cursor: Any = config
    for part in dotted_key.split("."):
        if not isinstance(cursor, dict) or part not in cursor:
            raise KeyError(dotted_key)
        cursor = cursor[part]
    return cursor


def _looks_like_outlook_store(value: Any) -> bool:
    return bool(value) and Path(str(value).strip().strip('"')).suffix.lower() in OUTLOOK_STORE_SUFFIXES


def _migrate_legacy_keys(saved: dict[str, Any]) -> dict[str, Any]:
    migrated = copy.deepcopy(saved)
    try:
        saved_schema = int(migrated.get("schema_version") or 1)
    except (TypeError, ValueError):
        saved_schema = 1
    paths = migrated.setdefault("paths", {})
    if not isinstance(paths, dict):
        paths = {}
        migrated["paths"] = paths
    if not paths.get("workbook_directory") and migrated.get("base_dir"):
        paths["workbook_directory"] = migrated["base_dir"]
    if not paths.get("advanced_search_directory"):
        legacy = paths.get("update_directory") or migrated.get("updatefile_dir")
        if legacy:
            paths["advanced_search_directory"] = legacy
    # The original raw dotted-key editor accepted ``outlook_store_path`` at
    # the document root.  Runtime code reads only ``paths.outlook_store_path``,
    # producing the exact split shown in the field report.  Prefer the root
    # value only when it is an actual store filename and the nested value is
    # missing or still points to a containing directory.
    accidental_root_store = migrated.pop("outlook_store_path", None)
    if _looks_like_outlook_store(accidental_root_store) and not _looks_like_outlook_store(
        paths.get("outlook_store_path")
    ):
        paths["outlook_store_path"] = accidental_root_store
    legacy_mail = migrated.get("mail")
    if isinstance(legacy_mail, dict):
        # Preserve recognized values from preview builds without accepting
        # their metadata-only/privacy model.
        email = migrated.setdefault("email", {})
        if "historical_days" in legacy_mail and "incremental_overlap_days" not in email:
            email["incremental_overlap_days"] = legacy_mail["historical_days"]
    email = migrated.setdefault("email", {})
    if not isinstance(email, dict):
        email = {}
        migrated["email"] = email
    old_fetch = email.pop("fetch_interval_days", None)
    old_sync = email.pop("sync_interval_days", None)
    if "fetch_interval_minutes" not in email and old_fetch is not None:
        try:
            old_fetch_value = int(old_fetch)
        except (TypeError, ValueError):
            old_fetch_value = 7
        email["fetch_interval_minutes"] = (
            old_fetch_value
            if old_fetch_value in {-1, 0}
            else 60 if saved_schema <= 9 and old_fetch_value == 7
            else old_fetch_value * 1440
        )
    if "sync_interval_minutes" not in email and old_sync is not None:
        try:
            old_sync_value = int(old_sync)
        except (TypeError, ValueError):
            old_sync_value = 7
        email["sync_interval_minutes"] = (
            old_sync_value
            if old_sync_value in {-1, 0}
            else 60 if saved_schema <= 9 and old_sync_value == 7
            else old_sync_value * 1440
        )
    if (
        saved_schema <= 9
        and old_fetch == 7
        and old_sync == 7
        and email.get("sync_mode") == "scheduled"
    ):
        # 3.1.7 makes the ordinary one-hour fetch+sync operation the default.
        # Preserve deliberately customized schedules, but migrate the former
        # untouched seven-day defaults into linked mode.
        email["sync_mode"] = "after_fetch"
    migrated.pop("base_dir", None)
    migrated.pop("updatefile_dir", None)
    migrated.pop("mail", None)
    paths.pop("update_directory", None)
    migrated["schema_version"] = 10
    return migrated


def _assert_known_structure(
    candidate: dict[str, Any],
    template: dict[str, Any] = DEFAULT_CONFIG,
    *,
    prefix: str = "",
) -> None:
    for key, value in candidate.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if key not in template:
            raise ValueError(f"Unknown configuration setting: {dotted}")
        expected = template[key]
        if isinstance(expected, dict):
            if not isinstance(value, dict):
                raise ValueError(f"Configuration section {dotted} must be an object")
            _assert_known_structure(value, expected, prefix=dotted)


def _require_integer(config: dict[str, Any], key: str) -> int:
    value = get_dotted(config, key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{key} must be an integer")
    return value


def _validate(config: dict[str, Any], *, validate_paths: bool = False) -> None:
    _assert_known_structure(config)
    paths = config.get("paths", {})
    for key, value in paths.items():
        if value is not None and not isinstance(value, str):
            raise ValueError(f"paths.{key} must be a path string or null")
    if validate_paths and paths.get("outlook_store_path"):
        prepare_outlook_store_path(paths["outlook_store_path"])

    advanced = config.get("advanced_search", {})
    glob = advanced.get("glob")
    if not isinstance(glob, str) or not glob.strip():
        raise ValueError("advanced_search.glob must be a non-blank string")
    poll = _require_integer(config, "advanced_search.poll_interval_minutes")
    if poll < 0:
        raise ValueError("advanced_search.poll_interval_minutes cannot be negative")

    email = config.get("email", {})
    for key in ("fetch_interval_minutes", "sync_interval_minutes"):
        value = _require_integer(config, f"email.{key}")
        if value < -1:
            raise ValueError(f"email.{key} must be -1, 0, or a positive integer")
    retained = _require_integer(config, "email.retained_message_count")
    if retained < 0:
        raise ValueError("email.retained_message_count cannot be negative")
    overlap = _require_integer(config, "email.incremental_overlap_days")
    if overlap < 0:
        raise ValueError("email.incremental_overlap_days cannot be negative")
    if email.get("sync_mode") not in {"scheduled", "after_fetch"}:
        raise ValueError("email.sync_mode must be 'scheduled' or 'after_fetch'")
    if not isinstance(email.get("fetch_new_ticket_history_automatically"), bool):
        raise ValueError("email.fetch_new_ticket_history_automatically must be true or false")
    for key in (
        "request_confirmation_sender",
        "dispatch_notification_sender",
        "warehouse_sender_domain",
    ):
        value = email.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError(f"email.{key} must be text or null")

    aging = config.get("aging", {})
    if aging.get("calendar_days") is not True:
        raise ValueError("aging.calendar_days is fixed to true in Zeus")
    for key in (
        "communication_yellow_days",
        "communication_red_days",
        "ticket_age_yellow_days",
        "ticket_age_red_days",
        "planned_due_soon_days",
        "resolve_due_soon_days",
        "spare_dispatch_red_days",
    ):
        if _require_integer(config, f"aging.{key}") < 0:
            raise ValueError(f"aging.{key} cannot be negative")
    if aging["communication_yellow_days"] > aging["communication_red_days"]:
        raise ValueError("communication yellow threshold cannot exceed red")
    if aging["ticket_age_yellow_days"] > aging["ticket_age_red_days"]:
        raise ValueError("ticket-age yellow threshold cannot exceed red")
    suspend_terms = aging.get("resolve_suspend_status_contains")
    if not isinstance(suspend_terms, list) or any(
        not isinstance(value, str) or not value.strip() for value in suspend_terms
    ):
        raise ValueError("aging.resolve_suspend_status_contains must contain text values")

    portal = config.get("excel", {}).get("portal_url_template")
    if portal is not None and not isinstance(portal, str):
        raise ValueError("excel.portal_url_template must be text or null")
    retention = _require_integer(config, "excel.backup_retention_count")
    if retention < 1:
        raise ValueError("excel.backup_retention_count must be at least 1")

    port = _require_integer(config, "web.port")
    if not 1024 <= port <= 65535:
        raise ValueError("web.port must be between 1024 and 65535")
    for key in ("open_browser", "system_tray", "show_detail_history"):
        if not isinstance(config.get("web", {}).get(key), bool):
            raise ValueError(f"web.{key} must be true or false")
    if config.get("web", {}).get("font_scale") not in {"compact", "standard", "large"}:
        raise ValueError("web.font_scale must be 'compact', 'standard', or 'large'")


def load_config(home: Path) -> dict[str, Any]:
    path = config_path(home)
    saved = load_json(path, {})
    if not isinstance(saved, dict):
        raise ValueError(f"Invalid configuration file: {path}")
    migrated = _migrate_legacy_keys(saved)
    _assert_known_structure(migrated)
    config = deep_merge(DEFAULT_CONFIG, migrated)
    config["schema_version"] = 10
    if config.get("email", {}).get("sync_mode") == "after_fetch":
        config["email"]["sync_interval_minutes"] = config["email"][
            "fetch_interval_minutes"
        ]
    _validate(config)
    return config


def save_config(home: Path, config: dict[str, Any]) -> Path:
    resolved_home = home.expanduser().resolve()
    resolved_home.mkdir(parents=True, exist_ok=True)
    # Loading may repair legacy aliases, but saving must reject typos and
    # unknown root keys instead of silently consuming them as migrations.
    _assert_known_structure(config)
    migrated = _migrate_legacy_keys(config)
    _assert_known_structure(migrated)
    prepared = deep_merge(DEFAULT_CONFIG, migrated)
    prepared["schema_version"] = 10
    if prepared.get("email", {}).get("sync_mode") == "after_fetch":
        prepared["email"]["sync_interval_minutes"] = prepared["email"][
            "fetch_interval_minutes"
        ]
    _validate(prepared, validate_paths=True)
    path = config_path(resolved_home)
    atomic_write_json(path, prepared)
    return path


def ensure_config(home: Path) -> dict[str, Any]:
    path = config_path(home)
    config = load_config(home)
    saved = load_json(path, None) if path.exists() else None
    if saved != config:
        # A legacy directory-valued Outlook setting must remain loadable so
        # first-run repair can scan it.  Every other successful migration is
        # immediately rewritten to the canonical schema.
        try:
            save_config(home, config)
        except ValueError:
            if not paths_need_outlook_repair(config):
                raise
    return config


def paths_need_outlook_repair(config: dict[str, Any]) -> bool:
    value = config.get("paths", {}).get("outlook_store_path")
    if not value:
        return False
    try:
        prepare_outlook_store_path(value)
    except ValueError:
        return True
    return False


def resolve_path_setting(home: Path, value: Any) -> Path | None:
    if value is None or not str(value).strip():
        return None
    path = Path(str(value).strip().strip('"')).expanduser()
    if not path.is_absolute():
        path = home / path
    return path.resolve()


def prepare_outlook_store_path(value: Any, *, base: Path | None = None) -> Path:
    """Normalize a user-supplied classic Outlook store file path.

    Outlook exposes stores through ``Store.FilePath``.  A containing folder is
    therefore not a usable identity even when it contains only one mailbox.
    File existence is deliberately not required here: Outlook may expose a
    valid open store whose filesystem permissions prevent a separate probe.
    """

    raw = str(value or "").strip().strip('"')
    if not raw:
        raise ValueError("Outlook store path is blank")
    path = Path(raw).expanduser()
    if path.exists() and path.is_dir():
        raise ValueError(
            f"Outlook store path points to a folder: {path}. "
            "Select the exact .ost or .pst file instead."
        )
    if path.suffix.lower() not in OUTLOOK_STORE_SUFFIXES:
        raise ValueError(
            f"Outlook store path must name an .ost or .pst file, not: {path}"
        )
    if not path.is_absolute():
        path = (base or Path.cwd()) / path
    return path.resolve()


def scan_outlook_store_files(value: Any, *, base: Path | None = None) -> list[Path]:
    """Return selectable store files in one user-supplied directory."""

    raw = str(value or "").strip().strip('"')
    if not raw:
        raise ValueError("Outlook store folder is blank")
    directory = Path(raw).expanduser()
    if not directory.is_absolute():
        directory = (base or Path.cwd()) / directory
    directory = directory.resolve()
    if not directory.is_dir():
        raise ValueError(f"Outlook store folder does not exist: {directory}")
    try:
        candidates = [
            path.resolve()
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in OUTLOOK_STORE_SUFFIXES
        ]
    except OSError as exc:
        raise ValueError(f"Cannot scan Outlook store folder {directory}: {exc}") from exc
    return sorted(candidates, key=lambda path: (path.name.casefold(), str(path).casefold()))


def set_dotted(config: dict[str, Any], dotted_key: str, value: Any) -> None:
    spec = SETTING_SPEC_BY_KEY.get(dotted_key)
    if spec is None:
        raise ValueError(f"Unknown configuration setting: {dotted_key or '(blank)'}")
    if not spec.editable:
        raise ValueError(f"{dotted_key} is fixed in Zeus")
    parts = dotted_key.split(".")
    cursor: dict[str, Any] = config
    for part in parts[:-1]:
        child = cursor.get(part)
        if not isinstance(child, dict):
            raise ValueError(f"{part!r} is not a configuration object")
        cursor = child
    cursor[parts[-1]] = value


def coerce_setting_value(
    dotted_key: str,
    value: Any,
    *,
    base: Path | None = None,
) -> Any:
    """Convert one user value according to its declared setting type."""

    spec = SETTING_SPEC_BY_KEY.get(dotted_key)
    if spec is None:
        raise ValueError(f"Unknown configuration setting: {dotted_key or '(blank)'}")
    if not spec.editable:
        raise ValueError(f"{dotted_key} is fixed in Zeus")
    text = str(value or "").strip()
    if spec.nullable and text.lower() in {"", "-", "none", "null"}:
        return None
    if spec.kind == "outlook_store":
        return str(prepare_outlook_store_path(value, base=base))
    if spec.kind == "directory":
        if not text:
            raise ValueError(f"{spec.label} cannot be blank")
        path = Path(text.strip('"')).expanduser()
        if not path.is_absolute():
            path = (base or Path.cwd()) / path
        return str(path.resolve())
    if spec.kind == "xlsx_template":
        if not text:
            raise ValueError(f"{spec.label} cannot be blank")
        path = Path(text.strip('"')).expanduser()
        if not path.is_absolute():
            path = (base or Path.cwd()) / path
        path = path.resolve()
        if path.suffix.lower() != ".xlsx":
            raise ValueError(f"{spec.label} must be an .xlsx file")
        return str(path)
    if spec.kind == "integer":
        try:
            parsed = int(text)
        except ValueError as exc:
            raise ValueError(f"{spec.label} must be a whole number") from exc
        if spec.minimum is not None and parsed < spec.minimum:
            raise ValueError(f"{spec.label} must be at least {spec.minimum}")
        return parsed
    if spec.kind == "boolean":
        lowered = text.casefold()
        if lowered in {"true", "yes", "y", "on", "1", "enabled"}:
            return True
        if lowered in {"false", "no", "n", "off", "0", "disabled"}:
            return False
        raise ValueError(f"{spec.label} must be enabled or disabled")
    if spec.kind == "choice":
        if text not in spec.choices:
            raise ValueError(f"{spec.label} must be one of: {', '.join(spec.choices)}")
        return text
    if spec.kind == "string_list":
        return [part.strip() for part in text.split(",") if part.strip()]
    if spec.kind == "text":
        if not text and not spec.nullable:
            raise ValueError(f"{spec.label} cannot be blank")
        return text or None
    raise ValueError(f"Unsupported configuration type for {dotted_key}")


def parse_config_value(text: str) -> Any:
    stripped = text.strip()
    lowered = stripped.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if lowered in {"null", "none", ""}:
        return None
    try:
        return int(stripped)
    except ValueError:
        pass
    try:
        return float(stripped)
    except ValueError:
        return stripped
