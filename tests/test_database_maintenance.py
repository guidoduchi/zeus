from __future__ import annotations

import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from zeus2.application.edits import (
    confirm_maintenance_window_in_database,
    edit_ticket_in_database,
)
from zeus2.application.service import ApplicationService
from zeus2.application.serialization import serialize_ticket_summary, ticket_revision
from zeus2.database_maintenance import inspect_database, maintain_database
from zeus2.maintenance_windows import (
    legacy_projection,
    maintenance_window_summary,
    normalize_maintenance_window,
)
from zeus2.store import StoreError, ZeusStore, render_ticket_markdown
from zeus2.tickets import new_ticket
from zeus2.utils import atomic_write_json, atomic_write_text, local_today, sha256_file


def upstream(ticket_id: str) -> dict[str, object]:
    return {
        "SRNo": ticket_id,
        "Problem Summary": "Maintenance Window migration",
        "Report Date": "2026-08-01",
        "Customer Contact": "Customer",
        "Customer Severity": "Minor",
        "Product": "Product",
        "Current Handler": "Handler",
        "Status": "Working",
        "ResolveBy": None,
        "Resolve By Suspend": None,
    }


class DatabaseMaintenanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ZeusStore(self.root / "data", config_home=self.root / "home")
        self.store.ensure_layout()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_legacy_ticket(
        self,
        ticket_id: str,
        *,
        planned_date: str | None,
        done: str,
    ) -> None:
        ticket = new_ticket(ticket_id, upstream(ticket_id), {})
        ticket["local"].pop("schema_version", None)
        ticket["local"].pop("maintenance_window", None)
        ticket["local"]["fields"]["Planned Date"] = planned_date
        ticket["local"]["fields"]["Done?"] = done
        path = self.store.ticket_file(ticket_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, render_ticket_markdown(ticket))
        state = self.store.state()
        state.pop("database_schema_version", None)
        atomic_write_json(self.store.current / "state.json", state)

    def test_preview_is_read_only_and_atomic_upgrade_preserves_failed_attempt(self) -> None:
        failed_date = (local_today() - timedelta(days=2)).isoformat()
        self.seed_legacy_ticket("12345678", planned_date=failed_date, done="P")
        before = sha256_file(self.store.ticket_file("12345678"))

        preview = inspect_database(self.store)

        self.assertEqual(preview["status"], "upgrade_available")
        self.assertEqual(preview["outdatedTicketIds"], ["12345678"])
        self.assertEqual(sha256_file(self.store.ticket_file("12345678")), before)

        result = maintain_database(self.store, confirmed=True)
        upgraded = self.store.read_ticket("12345678")
        window = upgraded["local"]["maintenance_window"]
        self.assertTrue(result["changed"])
        self.assertTrue(result["backup"])
        self.assertTrue((self.store.backups / result["backup"]).is_file())
        self.assertEqual(result["status"], "current")
        self.assertEqual(upgraded["local"]["schema_version"], 2)
        self.assertEqual(window["status"], "incomplete")
        self.assertIsNone(window["date"])
        self.assertEqual(window["attempts"][0]["date"], failed_date)
        self.assertEqual(window["attempts"][0]["outcome"], "incomplete")

    def test_repair_regenerates_readable_markdown_from_valid_embedded_record(self) -> None:
        ticket = new_ticket("12345678", upstream("12345678"), {})
        self.store.write_ticket_bundle(self.store.current, ticket)
        path = self.store.ticket_file("12345678")
        original_record = self.store.read_ticket("12345678")
        atomic_write_text(
            path,
            path.read_text(encoding="utf-8") + "\nMANUALLY CHANGED\n",
        )

        preview = inspect_database(self.store)
        self.assertEqual(preview["status"], "repair_available")
        self.assertEqual(preview["repairableMarkdownCount"], 1)

        maintain_database(self.store, confirmed=True)

        self.assertNotIn("MANUALLY CHANGED", path.read_text(encoding="utf-8"))
        self.assertEqual(self.store.read_ticket("12345678"), original_record)

    def test_invalid_embedded_marker_blocks_repair_without_writing(self) -> None:
        ticket = new_ticket("12345678", upstream("12345678"), {})
        self.store.write_ticket_bundle(self.store.current, ticket)
        path = self.store.ticket_file("12345678")
        lines = path.read_text(encoding="utf-8").splitlines()
        lines[0] = "<!-- ZEUS_RECORD_V2:corrupt -->"
        atomic_write_text(path, "\n".join(lines) + "\n")
        before = sha256_file(path)

        preview = inspect_database(self.store)
        self.assertEqual(preview["status"], "blocked")
        self.assertEqual(preview["blockedCount"], 1)
        with self.assertRaisesRegex(StoreError, "Restore a known-good backup"):
            maintain_database(self.store, confirmed=True)
        self.assertEqual(sha256_file(path), before)
        self.assertEqual(list(self.store.backups.glob("*.zip")), [])

    def test_invalid_database_version_marker_is_reported_as_blocked(self) -> None:
        state = self.store.state()
        state["database_schema_version"] = "manually-corrupted"
        atomic_write_json(self.store.current / "state.json", state)

        preview = inspect_database(self.store)

        self.assertEqual(preview["status"], "blocked")
        self.assertFalse(preview["canApply"])
        self.assertTrue(any(
            "whole number" in record["message"]
            for record in preview["blockedRecords"]
        ))

    def test_invalid_structured_attempt_blocks_lossy_repair(self) -> None:
        ticket = new_ticket("12345678", upstream("12345678"), {})
        ticket["local"]["maintenance_window"]["attempts"] = [
            {"date": "not-a-date", "outcome": "incomplete"}
        ]
        path = self.store.ticket_file("12345678")
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, render_ticket_markdown(ticket))

        preview = inspect_database(self.store)

        self.assertEqual(preview["status"], "blocked")
        self.assertTrue(any(
            "attempt 1 date is invalid" in record["message"]
            for record in preview["blockedRecords"]
        ))

    def test_migration_preserves_no_visibility_and_flags_completed_without_date(self) -> None:
        self.seed_legacy_ticket("12345678", planned_date=None, done="?")
        self.seed_legacy_ticket("87654321", planned_date=None, done="Y")

        preview = inspect_database(self.store)
        self.assertEqual(preview["reviewCount"], 1)
        self.assertEqual(preview["reviewRecords"][0]["ticketId"], "87654321")
        maintain_database(self.store, confirmed=True)

        invisible = self.store.read_ticket("12345678")["local"]["maintenance_window"]
        completed = self.store.read_ticket("87654321")["local"]["maintenance_window"]
        self.assertEqual(invisible["status"], "no_visibility")
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["review_required"])


class MaintenanceWindowLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = ZeusStore(self.root / "data", config_home=self.root / "home")
        self.store.ensure_layout()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def seed_planned(self, ticket_id: str = "12345678") -> str:
        planned = (local_today() - timedelta(days=1)).isoformat()
        ticket = new_ticket(
            ticket_id,
            upstream(ticket_id),
            {},
            local={"fields": {"Planned Date": planned, "Done?": "N"}},
        )
        self.store.write_ticket_bundle(self.store.current, ticket)
        return planned

    def test_a_current_date_overrides_every_undated_structured_state(self) -> None:
        planned = (local_today() + timedelta(days=3)).isoformat()
        for status in ("unplanned", "incomplete", "no_visibility"):
            with self.subTest(status=status):
                window = normalize_maintenance_window(
                    {
                        "schema_version": 1,
                        "status": status,
                        "date": planned,
                        "attempts": [],
                        "review_required": False,
                    }
                )
                local = {
                    "schema_version": 2,
                    "maintenance_window": window,
                    "fields": legacy_projection(window),
                }
                summary = maintenance_window_summary(local)
                self.assertEqual(summary["status"], "planned")
                self.assertEqual(summary["display"], planned)

    def test_failed_prompt_keeps_history_and_new_date_becomes_the_display(self) -> None:
        failed_date = self.seed_planned()
        before = self.store.read_ticket("12345678")
        summary = serialize_ticket_summary(before, self.store.config)
        self.assertEqual(summary["maintenanceWindow"]["display"], failed_date)
        self.assertTrue(summary["maintenanceWindow"]["confirmationRequired"])

        confirm_maintenance_window_in_database(
            self.store,
            "12345678",
            planned_date=failed_date,
            successful=False,
            expected_revision=ticket_revision(before),
        )
        failed = self.store.read_ticket("12345678")
        self.assertEqual(failed["local"]["maintenance_window"]["status"], "incomplete")
        self.assertIsNone(failed["local"]["fields"]["Planned Date"])

        next_date = (local_today() + timedelta(days=4)).isoformat()
        edit_ticket_in_database(
            self.store,
            "12345678",
            {"Planned Date": next_date},
            expected_revision=ticket_revision(failed),
        )
        rescheduled = self.store.read_ticket("12345678")
        window = rescheduled["local"]["maintenance_window"]
        self.assertEqual(window["status"], "planned")
        self.assertEqual(window["date"], next_date)
        self.assertEqual(window["attempts"][0]["date"], failed_date)
        self.assertEqual(
            serialize_ticket_summary(rescheduled, self.store.config)["maintenanceWindow"]["display"],
            next_date,
        )

    def test_successful_prompt_completes_and_preserves_the_successful_date(self) -> None:
        planned = self.seed_planned()
        before = self.store.read_ticket("12345678")
        confirm_maintenance_window_in_database(
            self.store,
            "12345678",
            planned_date=planned,
            successful=True,
            expected_revision=ticket_revision(before),
        )

        completed = self.store.read_ticket("12345678")
        window = completed["local"]["maintenance_window"]
        summary = serialize_ticket_summary(completed, self.store.config)
        self.assertEqual(window["status"], "completed")
        self.assertEqual(window["date"], planned)
        self.assertEqual(window["attempts"][-1]["outcome"], "completed")
        self.assertEqual(summary["maintenanceWindow"]["display"], "Complete")
        self.assertFalse(summary["maintenanceWindow"]["confirmationRequired"])
        self.assertEqual(summary["plannedState"], "unplanned")

    def test_bootstrap_surfaces_overdue_prompts_from_any_saved_workspace(self) -> None:
        planned = self.seed_planned()
        service = ApplicationService(self.store)
        try:
            payload = service.bootstrap_payload()
        finally:
            service.stop()

        self.assertEqual(len(payload["maintenanceWindowsDue"]), 1)
        due = payload["maintenanceWindowsDue"][0]
        self.assertEqual(due["ticketId"], "12345678")
        self.assertEqual(due["maintenanceWindow"]["display"], planned)

    def test_bootstrap_defers_database_scan_while_an_operation_owns_the_store(self) -> None:
        service = ApplicationService(self.store)
        service._operation_lock.acquire()
        try:
            payload = service.bootstrap_payload()
        finally:
            service._operation_lock.release()
            service.stop()

        self.assertEqual(payload["databaseMaintenance"]["status"], "busy")
        self.assertEqual(payload["maintenanceWindowsDue"], [])


if __name__ == "__main__":
    unittest.main()
