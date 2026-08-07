from __future__ import annotations

import http.client
import json
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from unittest.mock import patch

from openpyxl import load_workbook

import zeus2.main as main_module
from tests.test_zeus2 import pending_row, write_managed
from zeus2.application.edits import PendingsConflictError, edit_ticket_through_pendings
from zeus2.application.errors import ValidationError
from zeus2.application.jobs import EventBroker, JobManager
from zeus2.application.serialization import dashboard_payload, ticket_revision
from zeus2.application.service import ApplicationService
from zeus2.config import save_config
from zeus2.main import _restart_command
from zeus2.startup import run_startup
from zeus2.store import ZeusStore
from zeus2.tickets import PENDING_COLUMNS
from zeus2.utils import sha256_file
from zeus2.web.runtime import InstanceRegistry, process_creation_marker
from zeus2.web.server import ZeusWebServer


class WebFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.books = self.root / "books"
        self.downloads = self.root / "downloads"
        self.books.mkdir()
        self.downloads.mkdir()
        self.store = ZeusStore(self.home / "data", config_home=self.home)
        self.store.ensure_layout()
        config = self.store.config
        config["paths"]["workbook_directory"] = str(self.books)
        config["paths"]["advanced_search_directory"] = str(self.downloads)
        config["paths"]["outlook_store_path"] = None
        config["advanced_search"]["poll_interval_minutes"] = 0
        save_config(self.home, config)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_pendings_only(self) -> None:
        write_managed(
            self.books / "Pendings.xlsx",
            [
                pending_row(
                    "12345678",
                    summary="Pendings alone builds Zeus",
                    **{"Site": "GYE", "Notes": "Initial note"},
                )
            ],
        )


class PendingsFirstSourceTests(WebFixture):
    def test_pendings_alone_builds_markdown_and_dashboard(self) -> None:
        self.seed_pendings_only()
        result = run_startup(self.store)

        self.assertFalse(result.advanced_search_valid)
        self.assertFalse(
            any("ADVANCED SEARCH WARNING" in warning for warning in result.warnings)
        )
        self.assertTrue(
            any("Advanced Search was skipped" in notice for notice in result.notices)
        )
        self.assertFalse((self.books / "Closed.xlsx").exists())
        ticket = self.store.read_ticket("12345678")
        self.assertEqual(ticket["upstream"]["fields"]["Problem Summary"], "Pendings alone builds Zeus")
        self.assertEqual(ticket["local"]["fields"]["Site"], "GYE")
        dashboard = dashboard_payload(self.store)
        self.assertEqual(dashboard["stats"]["active"], 1)
        self.assertEqual(dashboard["tickets"][0]["ticketId"], "12345678")
        self.assertEqual(dashboard["tickets"][0]["severity"], "Minor")

    def test_browser_edit_writes_pendings_first_then_markdown(self) -> None:
        self.seed_pendings_only()
        run_startup(self.store)
        before = self.store.read_ticket("12345678")

        result = edit_ticket_through_pendings(
            self.store,
            "12345678",
            {"Notes": "Changed from Zeus web", "Done?": "Y"},
            expected_revision=ticket_revision(before),
        )

        self.assertTrue(result["changed"])
        workbook = load_workbook(self.books / "Pendings.xlsx", data_only=False)
        try:
            headers = [cell.value for cell in workbook.active[1]]
            notes_column = headers.index("Notes") + 1
            done_column = headers.index("Done?") + 1
            self.assertEqual(workbook.active.cell(2, notes_column).value, "Changed from Zeus web")
            self.assertEqual(workbook.active.cell(2, done_column).value, "Y")
        finally:
            workbook.close()
        updated = self.store.read_ticket("12345678")
        self.assertEqual(updated["local"]["fields"]["Notes"], "Changed from Zeus web")
        self.assertEqual(updated["local"]["fields"]["Done?"], "Y")
        self.assertTrue((self.books / "Zeus Backups" / "Web edits").is_dir())

    def test_bom_derives_spare_and_calendar_date_in_workbook_and_markdown(self) -> None:
        write_managed(
            self.books / "Pendings.xlsx",
            [
                pending_row(
                    "12345678",
                    summary="Derived work fields",
                    **{"BOM": None, "Spare": "Y"},
                )
            ],
        )
        run_startup(self.store)
        before = self.store.read_ticket("12345678")
        self.assertEqual(before["local"]["fields"]["Spare"], "N")

        result = edit_ticket_through_pendings(
            self.store,
            "12345678",
            {"BOM": "  BOM-9000  ", "Planned Date": "2026-08-21"},
            expected_revision=ticket_revision(before),
        )

        self.assertEqual(result["changedFields"], ["BOM", "Planned Date", "Spare"])
        workbook = load_workbook(self.books / "Pendings.xlsx", data_only=False)
        try:
            headers = [cell.value for cell in workbook.active[1]]
            bom = workbook.active.cell(2, headers.index("BOM") + 1)
            planned = workbook.active.cell(2, headers.index("Planned Date") + 1)
            spare = workbook.active.cell(2, headers.index("Spare") + 1)
            self.assertEqual(bom.value, "BOM-9000")
            self.assertEqual(planned.value.date(), date(2026, 8, 21))
            self.assertEqual(planned.number_format, "yyyy-mm-dd")
            self.assertEqual(spare.value, "Y")
        finally:
            workbook.close()
        updated = self.store.read_ticket("12345678")
        self.assertEqual(updated["local"]["fields"]["Planned Date"], "2026-08-21")
        self.assertEqual(updated["local"]["fields"]["Spare"], "Y")

    def test_spare_cannot_be_supplied_by_a_browser_edit(self) -> None:
        self.seed_pendings_only()
        run_startup(self.store)
        before = self.store.read_ticket("12345678")
        workbook_hash = sha256_file(self.books / "Pendings.xlsx")

        with self.assertRaisesRegex(
            ValidationError,
            "Spare is derived from BOM and cannot be edited directly",
        ):
            edit_ticket_through_pendings(
                self.store,
                "12345678",
                {"Spare": "Y"},
                expected_revision=ticket_revision(before),
            )

        self.assertEqual(sha256_file(self.books / "Pendings.xlsx"), workbook_hash)
        self.assertEqual(self.store.read_ticket("12345678")["local"]["fields"]["Spare"], "N")

    def test_external_excel_change_blocks_web_edit_without_overwrite(self) -> None:
        self.seed_pendings_only()
        run_startup(self.store)
        ticket = self.store.read_ticket("12345678")
        workbook = load_workbook(self.books / "Pendings.xlsx")
        headers = [cell.value for cell in workbook.active[1]]
        workbook.active.cell(2, headers.index("Notes") + 1).value = "Unsynchronized Excel edit"
        workbook.save(self.books / "Pendings.xlsx")
        workbook.close()
        changed_hash = sha256_file(self.books / "Pendings.xlsx")

        with self.assertRaises(PendingsConflictError):
            edit_ticket_through_pendings(
                self.store,
                "12345678",
                {"Notes": "Web value that must not win"},
                expected_revision=ticket_revision(ticket),
            )

        self.assertEqual(sha256_file(self.books / "Pendings.xlsx"), changed_hash)
        self.assertEqual(
            self.store.read_ticket("12345678")["local"]["fields"]["Notes"],
            "Initial note",
        )


class JobManagerTests(unittest.TestCase):
    def test_jobs_are_serialized_and_emit_visible_progress(self) -> None:
        broker = EventBroker()
        manager = JobManager(broker)
        order: list[str] = []

        def first(context: object) -> dict[str, bool]:
            order.append("first-start")
            context.report("query", "Reading Pendings")  # type: ignore[attr-defined]
            time.sleep(0.03)
            order.append("first-end")
            return {"ok": True}

        def second(context: object) -> dict[str, bool]:
            order.append("second")
            return {"ok": True}

        one = manager.submit("query", "Query", first)
        two = manager.submit("doctor", "Doctor", second)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            snapshots = manager.snapshots()
            if all(job["status"] in {"succeeded", "failed"} for job in snapshots):
                break
            time.sleep(0.01)
        events = broker.wait_after(0, timeout=0)
        manager.stop()

        self.assertEqual(order, ["first-start", "first-end", "second"])
        self.assertTrue(any(event["payload"].get("message") == "Reading Pendings" for event in events))
        self.assertEqual(manager.get(one["id"])["status"], "succeeded")
        self.assertEqual(manager.get(two["id"])["status"], "succeeded")


class ApplicationServiceContractTests(WebFixture):
    def test_web_edit_returns_a_complete_immediately_renderable_ticket(self) -> None:
        self.seed_pendings_only()
        run_startup(self.store)
        service = ApplicationService(self.store)
        try:
            before = service.ticket("12345678")
            result = service.edit_ticket(
                "12345678",
                changes={"Notes": "Saved without unmounting React"},
                expected_revision=before["revision"],
            )

            detail = result["ticket"]
            self.assertEqual(detail["localFields"]["Notes"], "Saved without unmounting React")
            self.assertIsInstance(detail["history"], list)
            self.assertIsInstance(detail["mops"], list)
            self.assertIn("email", detail)
            self.assertIn("upstreamFields", detail)
        finally:
            service.stop()

    def test_scheduled_refresh_uses_the_full_pendings_first_query(self) -> None:
        service = ApplicationService(self.store)
        try:
            with patch.object(
                service,
                "submit_job",
                return_value={"kind": "query", "status": "queued"},
            ) as submit:
                result = service._submit_scheduled_query()
            submit.assert_called_once_with("query", {"scheduled": True})
            self.assertEqual(result["kind"], "query")
        finally:
            service.stop()

    def test_pendings_only_query_succeeds_when_advanced_search_is_absent(self) -> None:
        self.seed_pendings_only()
        service = ApplicationService(self.store)
        try:
            job = service.submit_job("query", {})
            deadline = time.monotonic() + 3
            snapshot = service.jobs.get(job["id"])
            while snapshot and snapshot["status"] in {"queued", "running"}:
                if time.monotonic() >= deadline:
                    self.fail("Pendings-only query did not finish")
                time.sleep(0.01)
                snapshot = service.jobs.get(job["id"])

            self.assertIsNotNone(snapshot)
            self.assertEqual(snapshot["status"], "succeeded")
            self.assertTrue(
                any(
                    "Advanced Search was skipped" in notice
                    for notice in snapshot["result"]["notices"]
                )
            )
            self.assertEqual(service.dashboard(sort="report", search="")["stats"]["active"], 1)
        finally:
            service.stop()

    def test_restart_command_handles_python_and_frozen_windows_builds(self) -> None:
        with patch("zeus2.main.sys.executable", "C:/Python/pythonw.exe"):
            self.assertEqual(
                _restart_command(),
                ["C:/Python/pythonw.exe", "-m", "zeus2", "serve"],
            )
        with (
            patch("zeus2.main.sys.executable", "C:/Zeus/zeus.exe"),
            patch.object(main_module.sys, "frozen", True, create=True),
        ):
            self.assertEqual(_restart_command(), ["C:/Zeus/zeus.exe", "serve"])

    def test_every_direct_email_job_fails_closed_when_outlook_is_disabled(self) -> None:
        service = ApplicationService(self.store)
        try:
            for kind in ("email-fetch", "email-sync", "email-rebuild"):
                job = service.submit_job(kind, {})
                deadline = time.monotonic() + 3
                snapshot = service.jobs.get(job["id"])
                while snapshot and snapshot["status"] in {"queued", "running"}:
                    if time.monotonic() >= deadline:
                        self.fail(f"{kind} did not finish")
                    time.sleep(0.01)
                    snapshot = service.jobs.get(job["id"])
                self.assertIsNotNone(snapshot)
                self.assertEqual(snapshot["status"], "failed")
                self.assertIn("Outlook email is disabled", snapshot["message"])
        finally:
            service.stop()


class WebServerTests(WebFixture):
    def setUp(self) -> None:
        super().setUp()
        self.seed_pendings_only()
        run_startup(self.store)
        self.service = ApplicationService(self.store)
        static = Path(__file__).resolve().parents[1] / "zeus2" / "web" / "static"
        self.server = ZeusWebServer(
            ("127.0.0.1", 0),
            self.service,
            static_root=static,
            instance_id="test-instance",
            control_token="control-token",
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = self.server.url

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.service.stop()
        self.server.server_close()
        super().tearDown()

    def read_json(self, path: str) -> tuple[int, dict[str, object], dict[str, str]]:
        try:
            response = urllib.request.urlopen(self.url + path, timeout=3)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read()), dict(response.headers.items())

    def test_browser_refresh_reads_state_without_querying_sources(self) -> None:
        audit_before = self.store.audit_file.read_text(encoding="utf-8")
        status, dashboard, _ = self.read_json("/api/dashboard?sort=report&search=")
        _, index = self.read_json("/api/bootstrap")[:2]
        audit_after = self.store.audit_file.read_text(encoding="utf-8")

        self.assertEqual(status, 200)
        self.assertEqual(dashboard["stats"]["active"], 1)  # type: ignore[index]
        self.assertEqual(index["instanceId"], "test-instance")
        self.assertEqual(audit_before, audit_after)

    def test_ticket_patch_returns_the_complete_detail_contract(self) -> None:
        _, bootstrap, _ = self.read_json("/api/bootstrap")
        _, detail, _ = self.read_json("/api/tickets/12345678")
        body = json.dumps(
            {
                "revision": detail["revision"],
                "changes": {"Notes": "Complete API response"},
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url + "/api/tickets/12345678/local",
            data=body,
            method="PATCH",
            headers={
                "Content-Type": "application/json",
                "If-Match": str(detail["revision"]),
                "X-Zeus-CSRF": str(bootstrap["csrfToken"]),
            },
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = json.loads(response.read())

        edited = payload["ticket"]
        self.assertEqual(edited["localFields"]["Notes"], "Complete API response")
        self.assertIsInstance(edited["history"], list)
        self.assertIsInstance(edited["mops"], list)

    def test_bundled_react_entrypoint_and_hashed_assets_are_served_locally(self) -> None:
        with urllib.request.urlopen(self.url + "/", timeout=3) as response:
            html = response.read().decode("utf-8")
            headers = dict(response.headers.items())
        self.assertIn('<div id="root"></div>', html)
        self.assertEqual(headers["Cache-Control"], "no-store")
        asset_match = re.search(r'src="(/[^"]+\.js)"', html)
        self.assertIsNotNone(asset_match)
        with urllib.request.urlopen(self.url + asset_match.group(1), timeout=3) as response:
            self.assertGreater(len(response.read()), 100_000)
            self.assertIn("immutable", response.headers["Cache-Control"])

    def test_restore_preview_reports_changes_without_mutating_the_ticket(self) -> None:
        backup_directory = self.books / "Zeus Backups"
        backup_directory.mkdir()
        backup = backup_directory / "Pendings_preview.xlsx"
        write_managed(
            backup,
            [
                pending_row(
                    "12345678",
                    summary="Pendings alone builds Zeus",
                    **{"Site": "GYE", "Notes": "Backup note"},
                )
            ],
        )
        before = self.store.read_ticket("12345678")["local"]["fields"]["Notes"]
        status, payload, _ = self.read_json(
            "/api/backups/pendings/preview?name=Pendings_preview.xlsx"
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["preview"]["changed_ids"], ["12345678"])
        self.assertEqual(
            self.store.read_ticket("12345678")["local"]["fields"]["Notes"],
            before,
        )

    def test_csrf_host_and_security_headers_are_enforced(self) -> None:
        status, bootstrap, headers = self.read_json("/api/bootstrap")
        self.assertEqual(status, 200)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertIn("script-src 'self';", headers["Content-Security-Policy"])
        self.assertIn(
            "style-src 'self' 'unsafe-inline';",
            headers["Content-Security-Policy"],
        )

        request = urllib.request.Request(
            self.url + "/api/jobs/query",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(missing.exception.code, 403)

        request.add_header("X-Zeus-CSRF", str(bootstrap["csrfToken"]))
        with urllib.request.urlopen(request, timeout=3) as response:
            self.assertEqual(response.status, 202)

        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request("GET", "/api/health", headers={"Host": "malicious.example"})
        rejected = connection.getresponse()
        self.assertEqual(rejected.status, 422)
        rejected.read()
        connection.close()

    def test_control_token_stops_only_the_registered_server(self) -> None:
        request = urllib.request.Request(
            self.url + "/api/system/shutdown",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json", "X-Zeus-Control": "wrong"},
        )
        with self.assertRaises(urllib.error.HTTPError) as rejected:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(rejected.exception.code, 403)


class InstanceRegistryTests(WebFixture):
    def test_current_process_has_a_stable_birth_marker(self) -> None:
        import os

        marker = process_creation_marker(os.getpid())
        if marker is None and sys.platform != "win32":
            self.skipTest("This container does not expose process birth metadata")
        self.assertIsNotNone(marker)
        self.assertEqual(process_creation_marker(os.getpid()), marker)

    def test_stale_records_are_removed_without_touching_unrelated_processes(self) -> None:
        registry = InstanceRegistry(self.home)
        registry.ensure()
        stale = registry.instances / "stale.json"
        stale.write_text(
            json.dumps(
                {
                    "instanceId": "stale",
                    "pid": 99999999,
                    "processCreationMarker": "not-real",
                    "port": 65534,
                    "url": "http://127.0.0.1:65534",
                    "controlToken": "x",
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(registry.live_instances(), [])
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
