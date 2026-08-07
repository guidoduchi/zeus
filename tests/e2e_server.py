from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

from tests.test_zeus2 import pending_row, write_managed
from zeus2.config import save_config
from zeus2.main import main
from zeus2.store import ZeusStore


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
