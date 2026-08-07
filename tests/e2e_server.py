from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

from openpyxl import Workbook

# Playwright starts this file directly from ``frontend/``.  Put the checkout at
# the front of sys.path so the fixture always exercises this branch, even when
# another Zeus build is installed in the runner environment.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from zeus2.config import save_config
from zeus2.main import main
from zeus2.startup import run_startup
from zeus2.store import ZeusStore
from zeus2.tickets import LOCAL_COLUMNS, PENDING_COLUMNS


def pending_row(ticket_id: str, **values: object) -> dict[str, object]:
    """Build an independent Pendings fixture for the installed-app browser test."""

    summary = values.pop("summary", None)
    row: dict[str, object] = {
        "SRNo": ticket_id,
        "Problem Summary": summary or f"Ticket {ticket_id}",
        "Report Date": "2026-07-01 10:00:00",
        "Customer Contact": "Customer",
        "Customer Severity": values.pop("severity", "Minor"),
        "Product": "Product",
        "Current Handler": "Handler A",
        "Status": "L1-Work in Progress",
        "ResolveBy": "2026-08-20 10:00:00",
        "Resolve By Suspend": "2026-08-25 10:00:00",
        **{column: None for column in LOCAL_COLUMNS},
        "Done?": "N",
    }
    row.update(values)
    return row


def write_managed(path: Path, rows: list[dict[str, object]]) -> None:
    """Write the minimal valid workbook consumed by the browser fixture."""

    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Pendings"
    worksheet.append(list(PENDING_COLUMNS))
    for row in rows:
        worksheet.append([row.get(column) for column in PENDING_COLUMNS])
    workbook.save(path)
    workbook.close()


def prepare_fixture(root: Path) -> Path:
    home = root / "home"
    workbooks = root / "workbooks"
    downloads = root / "downloads"
    workbooks.mkdir()
    downloads.mkdir()
    store = ZeusStore(home / "data", config_home=home)
    store.ensure_layout()
    config = store.config
    config["paths"]["workbook_directory"] = str(workbooks)
    config["paths"]["advanced_search_directory"] = str(downloads)
    config["paths"]["outlook_store_path"] = None
    config["advanced_search"]["poll_interval_minutes"] = 0
    save_config(home, config)

    severities = ("Critical", "Major", "Minor", "Minor")
    rows = [
        pending_row(
            str(39400000 + index),
            summary=f"Ecuador | Claro | Filtered network incident {index:02d}",
            report_date=f"2026-07-{max(1, 31 - index):02d} 10:00:00",
            severity=severities[index % len(severities)],
            **{
                "Planned Date": "Unplanned",
                "Site": "GYE" if index % 2 else "UIO",
                "Cloud": "FusionSphere",
                "Model": "2288H V5",
                "Notes": "Awaiting field confirmation",
                "Done?": "N",
            },
        )
        for index in range(1, 35)
    ]
    write_managed(workbooks / "Pendings.xlsx", rows)
    run_startup(store)
    legacy = store.read_ticket("39400001")
    quoted_lines = "\n".join(
        f"Quoted historical line {index:03d}: prior diagnostic context"
        for index in range(1, 241)
    )
    raw_body = (
        "Newest field response: the DIMM alarm is clear.\n\n"
        "Regards/Saludos cordiales,\n\n"
        "De: Previous Engineer <previous@example.com>\n"
        "Enviado el: lunes, 27 de julio de 2026 18:30\n"
        "Para: Cloud Support <cloud@example.com>\n"
        "CC: Operations <operations@example.com>\n"
        "Asunto: RE: [SR 39400001] DIMM MCE error\n\n"
        f"{quoted_lines}"
    )
    legacy["email"].update(
        {
            "total_received": 1,
            "last_activity_at": "2026-07-27T18:30:14Z",
            "last_direction": "received",
            # Intentionally omit the compact-reply metadata.  This reproduces
            # retained Zeus records created before the web workstation.
            "messages": [
                {
                    "message_key": "legacy-browser-reply-chain",
                    "timestamp": "2026-07-27T18:30:14Z",
                    "direction": "received",
                    "subject": "RE: [SR 39400001] DIMM MCE error",
                    "sender": "field.engineer@example.com",
                    "body": raw_body,
                }
            ],
        }
    )
    store.write_ticket_bundle(store.current, legacy)
    return home


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="zeus3-e2e-") as temporary:
        os.environ["ZEUS_HOME"] = str(prepare_fixture(Path(temporary)))
        raise SystemExit(
            main(
                [
                    "serve",
                    "--port",
                    str(args.port),
                    "--no-browser",
                    "--no-tray",
                    "--console",
                ]
            )
        )
