from __future__ import annotations

import re
import unicodedata
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any

from .utils import atomic_write_json, load_json


GLOBAL_DATA_DIRECTORY = "global"
USER_PROFILE_FILENAME = "user_profile.json"
REFERENCE_DATA_FILENAME = "reference_data.json"
BOM_CATALOG_FILENAME = "spare_request_boms.json"
LEGACY_PROFILE_FILENAME = "spare_request_profiles.json"
LEGACY_BOM_FILENAME = "spare_request_boms.json"
PROFILE_SCHEMA_VERSION = 1
REFERENCE_SCHEMA_VERSION = 2
MAX_PROFILE_PICTURE_CHARACTERS = 800_000

EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
PROFILE_PICTURE_PATTERN = re.compile(
    r"^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$",
    re.IGNORECASE,
)


class ReferenceDataError(ValueError):
    pass


def global_data_directory(data_root: Path) -> Path:
    return data_root.expanduser().resolve() / GLOBAL_DATA_DIRECTORY


def user_profile_path(data_root: Path) -> Path:
    return global_data_directory(data_root) / USER_PROFILE_FILENAME


def reference_data_path(data_root: Path) -> Path:
    return global_data_directory(data_root) / REFERENCE_DATA_FILENAME


def bom_catalog_path(data_root: Path) -> Path:
    return global_data_directory(data_root) / BOM_CATALOG_FILENAME


def _optional_text(value: Any, *, maximum: int = 500) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > maximum:
        raise ReferenceDataError(f"Text values cannot exceed {maximum} characters")
    return text


def _required_text(value: Any, label: str, *, maximum: int = 500) -> str:
    text = _optional_text(value, maximum=maximum)
    if text is None:
        raise ReferenceDataError(f"{label} is required")
    return text


def _email(value: Any, label: str, *, required: bool) -> str | None:
    text = _required_text(value, label, maximum=320) if required else _optional_text(value, maximum=320)
    if text is not None and not EMAIL_PATTERN.fullmatch(text):
        raise ReferenceDataError(f"{label} must be a valid email address")
    return text


def _phone(value: Any, label: str, *, required: bool) -> str | None:
    text = _required_text(value, label, maximum=80) if required else _optional_text(value, maximum=80)
    if text is not None and len(re.sub(r"\D", "", text)) < 7:
        raise ReferenceDataError(f"{label} must contain at least seven digits")
    return text


def _identifier(value: Any, label: str) -> str:
    text = _optional_text(value, maximum=100)
    if text is None:
        return uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,99}", text):
        raise ReferenceDataError(f"{label} contains unsupported characters")
    return text


def derive_client_initials(name: Any) -> str:
    """Derive stable filename initials from the customer contact's name."""

    text = _required_text(name, "Customer name", maximum=200)
    normalized = "".join(
        character
        for character in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(character)
    )
    words = re.findall(r"[A-Za-z0-9]+", normalized)
    if not words:
        raise ReferenceDataError("Customer name must contain a letter or digit")
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[-1][0]).upper()


def normalize_user_profile(value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    picture = _optional_text(
        candidate.get("photoDataUrl", candidate.get("photo_data_url")),
        maximum=MAX_PROFILE_PICTURE_CHARACTERS,
    )
    if picture is not None and not PROFILE_PICTURE_PATTERN.fullmatch(picture):
        raise ReferenceDataError("Profile picture must be a PNG, JPEG, or WebP image")
    return {
        "name": _required_text(candidate.get("name"), "Name", maximum=200),
        "email": _email(candidate.get("email"), "Email", required=True),
        "phone": _phone(candidate.get("phone"), "Phone number", required=True),
        "username": _optional_text(candidate.get("username"), maximum=120),
        "photo_data_url": picture,
    }


def serialize_user_profile(profile: dict[str, Any] | None) -> dict[str, Any] | None:
    if profile is None:
        return None
    return {
        "name": profile.get("name"),
        "email": profile.get("email"),
        "phone": profile.get("phone"),
        "username": profile.get("username"),
        "photoDataUrl": profile.get("photo_data_url"),
    }


def load_user_profile(data_root: Path) -> dict[str, Any] | None:
    value = load_json(user_profile_path(data_root), None)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ReferenceDataError("The local user profile is invalid")
    candidate = value.get("profile", value)
    try:
        return normalize_user_profile(candidate)
    except ReferenceDataError as exc:
        raise ReferenceDataError(f"The local user profile is invalid: {exc}") from exc


def user_profile_payload(data_root: Path) -> dict[str, Any]:
    profile = load_user_profile(data_root)
    return {
        "schemaVersion": PROFILE_SCHEMA_VERSION,
        "complete": profile is not None,
        "profile": serialize_user_profile(profile),
    }


def save_user_profile(data_root: Path, value: Any) -> dict[str, Any]:
    profile = normalize_user_profile(value)
    path = user_profile_path(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(
        path,
        {
            "schema_version": PROFILE_SCHEMA_VERSION,
            "profile": profile,
        },
    )
    return user_profile_payload(data_root)


def _normalize_organizations(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ReferenceDataError("Customer organizations must be a list")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    names: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            raise ReferenceDataError(f"Customer organization {index} must be an object")
        identifier = _identifier(raw.get("id"), f"Customer organization {index} ID")
        name = _required_text(raw.get("name"), f"Customer organization {index} name", maximum=300)
        if identifier in ids:
            raise ReferenceDataError(f"Customer organizations contain duplicate ID {identifier}")
        if name.casefold() in names:
            raise ReferenceDataError(f"Customer organization {name} already exists")
        ids.add(identifier)
        names.add(name.casefold())
        result.append({"id": identifier, "name": name})
    return result


def _normalize_customers(values: Any, organization_ids: set[str]) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ReferenceDataError("Customer contacts must be a list")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            raise ReferenceDataError(f"Customer contact {index} must be an object")
        identifier = _identifier(raw.get("id"), f"Customer contact {index} ID")
        organization_id = _required_text(
            raw.get("organizationId", raw.get("organization_id")),
            f"Customer contact {index} organization",
            maximum=100,
        )
        if organization_id not in organization_ids:
            raise ReferenceDataError(
                f"Customer contact {index} references an unknown customer organization"
            )
        if identifier in ids:
            raise ReferenceDataError(f"Customer contacts contain duplicate ID {identifier}")
        ids.add(identifier)
        result.append(
            {
                "id": identifier,
                "organization_id": organization_id,
                "name": _required_text(raw.get("name"), f"Customer contact {index} name", maximum=200),
                "email": _email(raw.get("email"), f"Customer contact {index} email", required=False),
                "phone": _phone(raw.get("phone"), f"Customer contact {index} phone", required=False),
            }
        )
    return result


def _normalize_sites(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ReferenceDataError("Sites must be a list")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            raise ReferenceDataError(f"Site {index} must be an object")
        identifier = _identifier(raw.get("id"), f"Site {index} ID")
        if identifier in ids:
            raise ReferenceDataError(f"Sites contain duplicate ID {identifier}")
        ids.add(identifier)
        code = _required_text(
            raw.get("code", raw.get("siteCode", raw.get("site_code"))),
            f"Site {index} code",
            maximum=40,
        ).upper()
        result.append(
            {
                "id": identifier,
                "code": code,
                "name": _optional_text(raw.get("name", raw.get("siteName", raw.get("site_name"))), maximum=200),
                "address": _required_text(
                    raw.get("address", raw.get("siteAddress", raw.get("site_address"))),
                    f"Site {index} address",
                    maximum=1000,
                ),
                "cloud": _optional_text(raw.get("cloud"), maximum=120),
            }
        )
    return result


def _normalize_requesters(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ReferenceDataError("Requesters must be a list")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            raise ReferenceDataError(f"Requester {index} must be an object")
        identifier = _identifier(raw.get("id"), f"Requester {index} ID")
        if identifier in ids:
            raise ReferenceDataError(f"Requesters contain duplicate ID {identifier}")
        ids.add(identifier)
        result.append(
            {
                "id": identifier,
                "name": _required_text(raw.get("name"), f"Requester {index} name", maximum=200),
                "email": _email(raw.get("email"), f"Requester {index} email", required=True),
                "phone": _phone(raw.get("phone"), f"Requester {index} phone", required=True),
                "username": _optional_text(raw.get("username"), maximum=120),
                "pinned": bool(raw.get("pinned")),
            }
        )
    return result


def _serialize_reference_data(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": REFERENCE_SCHEMA_VERSION,
        "organizations": deepcopy(value.get("organizations") or []),
        "customers": [
            {
                "id": row.get("id"),
                "organizationId": row.get("organization_id"),
                "name": row.get("name"),
                "email": row.get("email"),
                "phone": row.get("phone"),
            }
            for row in value.get("customers") or []
        ],
        "sites": deepcopy(value.get("sites") or []),
        "requesters": deepcopy(value.get("requesters") or []),
    }


def _empty_reference_data() -> dict[str, Any]:
    return {
        "schema_version": REFERENCE_SCHEMA_VERSION,
        "organizations": [],
        "customers": [],
        "sites": [],
        "requesters": [],
    }


def _legacy_optional_text(value: Any, *, maximum: int) -> str | None:
    """Read permissive 3.1.1 JSON fields without blocking the upgrade."""

    if value is None:
        return None
    text = str(value).strip()
    return text[:maximum] or None


def _migrate_legacy_reference_data(config_home: Path) -> dict[str, Any]:
    legacy = load_json(config_home / LEGACY_PROFILE_FILENAME, {})
    if not isinstance(legacy, dict):
        return _empty_reference_data()
    organizations: list[dict[str, Any]] = []
    customers: list[dict[str, Any]] = []
    seen_organizations: dict[str, str] = {}
    for index, raw in enumerate(legacy.get("customers") or [], start=1):
        if not isinstance(raw, dict):
            continue
        organization_name = _legacy_optional_text(
            raw.get("organizationName")
            or raw.get("organization")
            or raw.get("customerOrganization")
            or raw.get("customer_name")
            or raw.get("name"),
            maximum=300,
        )
        if not organization_name:
            continue
        organization_id = seen_organizations.get(organization_name.casefold())
        if organization_id is None:
            organization_id = f"legacy-org-{index}"
            seen_organizations[organization_name.casefold()] = organization_id
            organizations.append({"id": organization_id, "name": organization_name})
        contact = raw.get("contact") if isinstance(raw.get("contact"), dict) else {}
        contact_name = _legacy_optional_text(
            contact.get("name") or raw.get("contactName") or raw.get("contact_name"),
            maximum=200,
        )
        if contact_name:
            try:
                contact_email = _email(
                    contact.get("email") or raw.get("contactEmail"),
                    f"Legacy customer contact {index} email",
                    required=False,
                )
            except ReferenceDataError:
                contact_email = None
            try:
                contact_phone = _phone(
                    contact.get("phone") or raw.get("contactPhone"),
                    f"Legacy customer contact {index} phone",
                    required=False,
                )
            except ReferenceDataError:
                contact_phone = None
            customers.append(
                {
                    "id": f"legacy-contact-{index}",
                    "organization_id": organization_id,
                    "name": contact_name,
                    "email": contact_email,
                    "phone": contact_phone,
                }
            )
    sites: list[dict[str, Any]] = []
    for index, raw in enumerate(legacy.get("sites") or [], start=1):
        if not isinstance(raw, dict):
            continue
        code = _legacy_optional_text(raw.get("siteCode") or raw.get("site_code") or raw.get("code") or raw.get("name"), maximum=40)
        address = _legacy_optional_text(raw.get("siteAddress") or raw.get("site_address") or raw.get("address"), maximum=1000)
        if code and address:
            sites.append(
                {
                    # 3.1.1 accepted any non-empty JSON ID. Generate a safe
                    # local identity so unusual legacy IDs cannot block the
                    # upgrade; no other legacy collection references sites.
                    "id": f"legacy-site-{index}",
                    "code": code.upper(),
                    "name": _legacy_optional_text(raw.get("siteName") or raw.get("site_name") or raw.get("name"), maximum=200),
                    "address": address,
                    "cloud": _legacy_optional_text(raw.get("cloud"), maximum=120),
                }
            )
    requesters: list[dict[str, Any]] = []
    for index, raw in enumerate(legacy.get("requesters") or [], start=1):
        if not isinstance(raw, dict):
            continue
        try:
            requesters.append(
                {
                    "id": f"legacy-requester-{index}",
                    "name": _required_text(raw.get("name"), f"Legacy requester {index} name"),
                    "email": _email(raw.get("email"), f"Legacy requester {index} email", required=True),
                    "phone": _phone(raw.get("phone"), f"Legacy requester {index} phone", required=True),
                    "username": _optional_text(raw.get("username"), maximum=120),
                    "pinned": bool(raw.get("pinned")),
                }
            )
        except ReferenceDataError:
            continue
    return {
        "schema_version": REFERENCE_SCHEMA_VERSION,
        "organizations": organizations,
        "customers": customers,
        "sites": sites,
        "requesters": requesters,
    }


def _migrate_legacy_bom_catalog(config_home: Path) -> list[dict[str, Any]]:
    legacy = load_json(config_home / LEGACY_BOM_FILENAME, {})
    values = legacy.get("boms") if isinstance(legacy, dict) else []
    if not isinstance(values, list):
        return []
    rows: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            continue
        # The 3.1.1 JSON manager documented only ``id`` and ``name`` and its
        # form used id as a BOM fallback. Preserve those rows while upgrading
        # them to the structured catalog.
        bom = _legacy_optional_text(
            raw.get("bom") or raw.get("code") or raw.get("id") or raw.get("name"),
            maximum=120,
        )
        description = _legacy_optional_text(
            raw.get("description") or raw.get("part") or raw.get("name") or bom,
            maximum=1000,
        )
        if not bom or not description or bom.casefold() in seen_codes:
            continue
        seen_codes.add(bom.casefold())
        rows.append(
            {
                "id": f"legacy-bom-{index}",
                "bom": bom,
                "description": description,
                "part": _legacy_optional_text(raw.get("part"), maximum=300) or description,
                "model": _legacy_optional_text(raw.get("model"), maximum=300),
                "device": _legacy_optional_text(raw.get("device"), maximum=300),
            }
        )
    return rows


def ensure_reference_layout(data_root: Path, config_home: Path) -> None:
    directory = global_data_directory(data_root)
    directory.mkdir(parents=True, exist_ok=True)
    references = reference_data_path(data_root)
    if not references.exists():
        atomic_write_json(references, _migrate_legacy_reference_data(config_home))
    boms = bom_catalog_path(data_root)
    if not boms.exists():
        atomic_write_json(
            boms,
            {
                "schema_version": REFERENCE_SCHEMA_VERSION,
                "boms": _migrate_legacy_bom_catalog(config_home),
            },
        )


def load_global_reference_data(data_root: Path) -> dict[str, Any]:
    value = load_json(reference_data_path(data_root), _empty_reference_data())
    if not isinstance(value, dict):
        raise ReferenceDataError("Global reference data is invalid")
    organizations = _normalize_organizations(value.get("organizations", []))
    customers = _normalize_customers(
        value.get("customers", []),
        {row["id"] for row in organizations},
    )
    sites = _normalize_sites(value.get("sites", []))
    requesters = _normalize_requesters(value.get("requesters", []))
    return _serialize_reference_data(
        {
            "organizations": organizations,
            "customers": customers,
            "sites": sites,
            "requesters": requesters,
        }
    )


def save_global_reference_data(data_root: Path, value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    organizations = _normalize_organizations(candidate.get("organizations", []))
    customers = _normalize_customers(
        candidate.get("customers", []),
        {row["id"] for row in organizations},
    )
    sites = _normalize_sites(candidate.get("sites", []))
    requesters = _normalize_requesters(candidate.get("requesters", []))
    path = reference_data_path(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(
        path,
        {
            "schema_version": REFERENCE_SCHEMA_VERSION,
            "organizations": organizations,
            "customers": customers,
            "sites": sites,
            "requesters": requesters,
        },
    )
    return load_global_reference_data(data_root)


def _normalize_boms(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ReferenceDataError("BOM catalog must be a list")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    codes: set[str] = set()
    for index, raw in enumerate(values, start=1):
        if not isinstance(raw, dict):
            raise ReferenceDataError(f"BOM catalog row {index} must be an object")
        identifier = _identifier(raw.get("id"), f"BOM catalog row {index} ID")
        bom = _required_text(raw.get("bom", raw.get("code")), f"BOM catalog row {index} BOM", maximum=120)
        if identifier in ids:
            raise ReferenceDataError(f"BOM catalog contains duplicate ID {identifier}")
        if bom.casefold() in codes:
            raise ReferenceDataError(f"BOM {bom} already exists")
        ids.add(identifier)
        codes.add(bom.casefold())
        description = _required_text(
            raw.get("description") or raw.get("part") or raw.get("name"),
            f"BOM catalog row {index} description",
            maximum=1000,
        )
        result.append(
            {
                "id": identifier,
                "bom": bom,
                "description": description,
                "part": _optional_text(raw.get("part"), maximum=300) or description,
                "model": _optional_text(raw.get("model"), maximum=300),
                "device": _optional_text(raw.get("device"), maximum=300),
            }
        )
    return result


def load_bom_catalog(data_root: Path) -> dict[str, Any]:
    value = load_json(bom_catalog_path(data_root), {"schema_version": REFERENCE_SCHEMA_VERSION, "boms": []})
    if not isinstance(value, dict):
        raise ReferenceDataError("BOM catalog is invalid")
    return {"schemaVersion": REFERENCE_SCHEMA_VERSION, "boms": _normalize_boms(value.get("boms", []))}


def save_bom_catalog(data_root: Path, value: Any) -> dict[str, Any]:
    candidate = value if isinstance(value, dict) else {}
    boms = _normalize_boms(candidate.get("boms", []))
    path = bom_catalog_path(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, {"schema_version": REFERENCE_SCHEMA_VERSION, "boms": boms})
    return load_bom_catalog(data_root)


def combined_reference_data(data_root: Path) -> dict[str, Any]:
    globals_payload = load_global_reference_data(data_root)
    profile = load_user_profile(data_root)
    requesters = list(globals_payload["requesters"])
    if profile is not None:
        requesters.insert(
            0,
            {
                "id": "__current_user__",
                "name": profile["name"],
                "email": profile["email"],
                "phone": profile["phone"],
                "username": profile.get("username"),
                "pinned": True,
                "currentUser": True,
            },
        )
    requesters.sort(
        key=lambda row: (
            not bool(row.get("currentUser")),
            not bool(row.get("pinned")),
            str(row.get("name") or "").casefold(),
        )
    )
    return {
        **globals_payload,
        "profile": serialize_user_profile(profile),
        "requesters": requesters,
        "boms": load_bom_catalog(data_root)["boms"],
    }
