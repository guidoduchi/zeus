from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook, load_workbook

from zeus2.application.errors import ValidationError
from zeus2.application.serialization import spare_requests_dashboard_payload
from zeus2.application.service import ApplicationService
from zeus2.config import load_config, save_config
from zeus2.spare_request_excel import (
    FAULTY_TAG_SHEET,
    REQUEST_SHEET,
    RETURN_SHEET,
    export_initial_request,
    export_return_workbook,
)
from zeus2.spare_request_mail import (
    apply_spare_request_messages,
    parse_dispatch_notification,
)
from zeus2.spare_requests import (
    ECUADOR_TIMEZONE,
    SpareRequestError,
    create_request_record,
    item_status,
    normalize_profile,
    normalize_request_lines,
    request_filename,
    request_subject,
)
from zeus2.store import ZeusStore


def profile_input() -> dict:
    return {
        "clientInitials": "CNT",
        "customerName": "Customer Network Team",
        "siteCode": "UIO1",
        "siteName": "Quito",
        "siteAddress": "Av. Example 123",
        "cloud": "Ecuador Cloud",
        "requester": {
            "name": "Zeus User",
            "email": "user@example.com",
            "phone": "+593000000000",
        },
        "contact": {
            "name": "Customer Contact",
            "email": "contact@example.com",
            "phone": "+593111111111",
        },
    }


def lines_input(amount: int = 2) -> list[dict]:
    return [
        {
            "bom": "02312RCC",
            "amount": amount,
            "description": "Controller board",
            "part": "Controller board",
            "model": "S6730",
            "device": "SW-UIO-01",
            "slot": "",
            "faultySn": "FAULTY-1",
            "reportDate": "2026-07-01",
        }
    ]


def request_record(amount: int = 2) -> dict:
    profile = normalize_profile(profile_input())
    lines = normalize_request_lines(lines_input(amount))
    request_id = "260808123456"
    return create_request_record(
        request_id=request_id,
        tt="39416095",
        source="manual",
        profile=profile,
        lines=lines,
        export_path=None,
        subject=request_subject(request_id, "39416095", lines),
        created_at="2026-08-08T12:34:56-05:00",
    )


def create_request_template(path: Path) -> None:
    workbook = Workbook()
    request = workbook.active
    request.title = REQUEST_SHEET
    for row in range(1, 42):
        for column in range(1, 14):
            request.cell(row, column).value = None
    faulty = workbook.create_sheet(FAULTY_TAG_SHEET)
    for row in range(1, 32):
        for column in range(1, 14):
            faulty.cell(row, column).value = None
    workbook.save(path)
    workbook.close()


def create_return_template(path: Path) -> None:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = RETURN_SHEET
    for row in range(1, 16):
        for column in range(1, 10):
            worksheet.cell(row, column).value = None
    workbook.save(path)
    workbook.close()


class SpareRequestDomainTests(unittest.TestCase):
    def test_customer_email_and_phone_are_required_for_new_requests(self) -> None:
        for missing in ("email", "phone"):
            profile = profile_input()
            profile["contact"][missing] = ""
            with self.subTest(missing=missing), self.assertRaisesRegex(
                SpareRequestError,
                f"Customer contact {missing}",
            ):
                normalize_profile(profile)

    def test_request_quantity_rejects_non_whole_json_values(self) -> None:
        for amount in (True, 1.5, "1.5", "1e2"):
            with self.subTest(amount=amount):
                with self.assertRaisesRegex(SpareRequestError, "whole number"):
                    normalize_request_lines(lines_input(amount))

    def test_one_physical_unit_keeps_all_component_serials_in_one_fault_tag(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "request.xlsx"
            create_request_template(template)
            raw_profile = profile_input()
            raw_profile.pop("clientInitials")
            raw_profile["contact"] = {
                "name": "Juan Piguave",
                "email": "juan@example.com",
                "phone": "+593111111111",
            }
            profile = normalize_profile(raw_profile)
            lines = normalize_request_lines(
                [
                    {
                        **lines_input(amount=1)[0],
                        "bom": "SERVER-001",
                        "description": "Complete replacement server",
                        "faultySn": "CPU-SN-001\nMEMORY,SN,002\nMEZZ-SN-003",
                    }
                ]
            )
            request = create_request_record(
                request_id="260808123456",
                tt="39416095",
                source="manual",
                profile=profile,
                lines=lines,
                export_path=None,
                subject=request_subject("260808123456", "39416095", lines),
                created_at="2026-08-08T12:34:56-05:00",
            )

            self.assertEqual(profile["client_initials"], "JP")
            self.assertEqual(len(request["items"]), 1)
            self.assertEqual(
                request["items"][0]["faulty_sns"],
                ["CPU-SN-001", "MEMORY,SN,002", "MEZZ-SN-003"],
            )
            filename = request_filename(
                request["request_id"], request["tt"], profile, lines
            )
            self.assertIn("SP–JP–", filename)
            exported = export_initial_request(template, root / "exports", request, filename)
            workbook = load_workbook(exported, read_only=True, data_only=False)
            try:
                application = workbook[REQUEST_SHEET]
                faulty = workbook[FAULTY_TAG_SHEET]
                self.assertEqual(application["B15"].value, "SERVER-001")
                self.assertEqual(application["C15"].value, 1)
                self.assertEqual(
                    application["F15"].value,
                    "CPU-SN-001\nMEMORY,SN,002\nMEZZ-SN-003",
                )
                self.assertEqual(application["G2"].value, "Customer Network Team")
                self.assertEqual(application["F31"].value, "Juan Piguave")
                self.assertEqual(
                    [faulty[f"F{row}"].value for row in (12, 14, 16)],
                    ["CPU-SN-001\nMEMORY,SN,002\nMEZZ-SN-003", None, None],
                )
                self.assertEqual(
                    [faulty[f"B{row}"].value for row in (12, 14, 16)],
                    ["SERVER-001", None, None],
                )
                self.assertTrue(faulty["F12"].alignment.wrap_text)
            finally:
                workbook.close()

    def test_export_identity_subject_and_quantity_expansion(self) -> None:
        request = request_record(3)
        filename = request_filename(
            request["request_id"], request["tt"], request["profile"], request["request_lines"]
        )
        self.assertEqual(
            filename,
            "SP–CNT–UIO1–Ecuador Cloud–3x02312RCC–39416095–260808123456.xlsx",
        )
        self.assertEqual(len(request["items"]), 3)
        self.assertEqual(
            [item["item_id"] for item in request["items"]],
            ["260808123456-0001", "260808123456-0002", "260808123456-0003"],
        )
        self.assertEqual(
            request["export"]["subject"],
            "[TT 39416095] [SPARE PARTS REQUEST] 260808123456 Controller board for S6730 SW-UIO-01",
        )

    def test_newline_slots_derive_quantity_and_assign_one_slot_per_item(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "request.xlsx"
            create_request_template(template)
            lines = normalize_request_lines(
                [{
                    **lines_input(amount=99)[0],
                    "part": "DIMM",
                    "description": "DIMM",
                    "slot": "DIMM101\nDIMM203\nDIMM103\nDIMM101",
                    "faultySns": "SERVER-SN-01\nMEMORY-SN-02",
                    "notes": "Memory diagnostics completed before this request.",
                }]
            )
            self.assertEqual(lines[0]["amount"], 3)
            self.assertEqual(lines[0]["slots"], ["DIMM101", "DIMM203", "DIMM103"])
            request = create_request_record(
                request_id="260808123456",
                tt="39416095",
                source="manual",
                profile=normalize_profile(profile_input()),
                lines=lines,
                export_path=None,
                subject=request_subject("260808123456", "39416095", lines),
                created_at="2026-08-08T12:34:56-05:00",
            )
            self.assertEqual(len(request["items"]), 3)
            self.assertEqual(
                [item["slot"] for item in request["items"]],
                ["DIMM101", "DIMM203", "DIMM103"],
            )
            self.assertEqual(
                {item["requested_bom"] for item in request["items"]},
                {"02312RCC"},
            )
            self.assertTrue(all(item["notes"] == lines[0]["notes"] for item in request["items"]))
            self.assertTrue(
                all(
                    item["faulty_sns"] == ["SERVER-SN-01", "MEMORY-SN-02"]
                    for item in request["items"]
                )
            )
            exported = export_initial_request(
                template,
                root / "exports",
                request,
                request_filename(request["request_id"], request["tt"], request["profile"], lines),
            )
            workbook = load_workbook(exported, read_only=True)
            try:
                self.assertEqual(workbook.worksheets[0]["C15"].value, 3)
                self.assertEqual(
                    [workbook.worksheets[1][f"B{row}"].value for row in (12, 14, 16)],
                    ["02312RCC"] * 3,
                )
                descriptions = [
                    workbook.worksheets[1][f"D{row}"].value for row in (12, 14, 16)
                ]
                for slot, description in zip(lines[0]["slots"], descriptions, strict=True):
                    self.assertIn(slot, description)
            finally:
                workbook.close()

    def test_export_preserves_neutral_template_sheet_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_template = root / "request.xlsx"
            return_template = root / "return.xlsx"
            create_request_template(request_template)
            create_return_template(return_template)
            request_book = load_workbook(request_template)
            request_book.worksheets[0].title = "Local Request Form"
            request_book.worksheets[1].title = "Local Fault Evidence"
            request_book.save(request_template)
            request_book.close()
            return_book = load_workbook(return_template)
            return_book.worksheets[0].title = "Local Return Form"
            return_book.save(return_template)
            return_book.close()

            request = request_record(1)
            exported = export_initial_request(
                request_template,
                root / "exports",
                request,
                request_filename(request["request_id"], request["tt"], request["profile"], request["request_lines"]),
            )
            check = load_workbook(exported, read_only=True)
            try:
                self.assertEqual(check.sheetnames, ["Local Request Form", "Local Fault Evidence"])
            finally:
                check.close()

            request["spare_sr"] = "SR4956964"
            request["items"][0].update(
                {
                    "rma": "C3209937821",
                    "delivered_bom": "02540255",
                    "new_sn": "NEW-1",
                }
            )
            returned_path = export_return_workbook(
                return_template,
                root / "exports",
                [(request, request["items"][0], "Faulty")],
            )["path"]
            returned = load_workbook(returned_path, read_only=True)
            try:
                self.assertEqual(returned.sheetnames, ["Local Return Form"])
                self.assertEqual(returned.worksheets[0]["I8"].value, "C3209937821")
            finally:
                returned.close()

    def test_request_and_return_exports_preserve_template_sheet_contracts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_template = root / "request.xlsx"
            return_template = root / "return.xlsx"
            create_request_template(request_template)
            create_return_template(return_template)
            request = request_record(7)
            filename = request_filename(
                request["request_id"], request["tt"], request["profile"], request["request_lines"]
            )
            exported = export_initial_request(request_template, root / "exports", request, filename)
            workbook = load_workbook(exported, read_only=True)
            try:
                self.assertEqual(workbook.sheetnames, [REQUEST_SHEET, FAULTY_TAG_SHEET])
                self.assertEqual(workbook[FAULTY_TAG_SHEET]["B24"].value, "02312RCC")
                self.assertEqual(
                    [workbook[FAULTY_TAG_SHEET][f"F{row}"].value for row in range(12, 26, 2)],
                    ["FAULTY-1"] * 7,
                )
            finally:
                workbook.close()

            request["spare_sr"] = "SR4956964"
            for index, item in enumerate(request["items"][:2], start=1):
                item["rma"] = f"C320993782{index}"
                item["delivered_bom"] = "02540255"
                item["new_sn"] = f"NEW-{index}"
            result = export_return_workbook(
                return_template,
                root / "exports",
                [
                    (request, request["items"][0], "Faulty"),
                    (request, request["items"][1], "New"),
                ],
            )
            returned = load_workbook(result["path"], read_only=True)
            try:
                self.assertEqual(returned.sheetnames, [RETURN_SHEET])
                self.assertIsNone(returned[RETURN_SHEET]["C8"].value)
                self.assertEqual(returned[RETURN_SHEET]["C9"].value, "NEW-2")
            finally:
                returned.close()


class SpareRequestMailTests(unittest.TestCase):
    def test_out_of_order_dispatch_and_partial_stock_resolve_per_unit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = load_config(root / "home")
            config["email"].update(
                {
                    "request_confirmation_sender": "request-confirmation@example.test",
                    "dispatch_notification_sender": "dispatch@example.test",
                    "warehouse_sender_domain": "@warehouse.example.test",
                }
            )
            save_config(root / "home", config)
            store = ZeusStore(root / "data", config_home=root / "home")
            store.ensure_layout()
            with store.transaction("seed", {}) as staging:
                store.write_spare_request(staging, request_record(3))
            dispatch = {
                "message_key": "dispatch",
                "timestamp": "2026-08-07T09:00:00-05:00",
                "direction": "received",
                "sender": "Dispatch Service",
                "sender_address": "dispatch@example.test",
                "subject": "Spare Request SR4956964 TT 39416095",
                "body": "",
                "html_body": "<table><tr><th>Order No.</th><th>Line No.</th><th>Item</th><th>QTY</th><th>SN</th></tr><tr><td>C3209937826</td><td>10</td><td>02540255</td><td>1</td><td>NEW-1</td></tr></table>",
            }
            confirmation = {
                "message_key": "confirmation",
                "timestamp": "2026-08-08T10:00:00-05:00",
                "direction": "received",
                "sender": "Request Service",
                "sender_address": "request-confirmation@example.test",
                "subject": "TT 39416095 request 260808123456",
                "body": "TT: 39416095",
                "html_body": "<table><tr><th>SR</th><th>RMA</th><th>ITEM</th><th>ITEM Description</th></tr><tr><td>SR4956964</td><td>C3209937826</td><td>02312RCC</td><td>Controller board</td></tr><tr><td>SR4956964</td><td>C3209937827</td><td>02312RCC</td><td>Controller board</td></tr></table>",
            }
            with store.transaction("mail", {}) as staging:
                result = apply_spare_request_messages(
                    store,
                    staging,
                    [dispatch, confirmation],
                    now=datetime(2026, 8, 8, 12, 0, tzinfo=ECUADOR_TIMEZONE),
                )
            self.assertEqual(result["unmatched_messages"], 0)
            request = store.read_spare_request("260808123456")
            self.assertEqual(request["spare_sr"], "SR4956964")
            self.assertEqual(request["items"][0]["rma"], "C3209937826")
            self.assertEqual(request["items"][0]["delivered_bom"], "02540255")
            self.assertEqual(request["items"][0]["new_sn"], "NEW-1")
            self.assertEqual(item_status(request["items"][0], request), "dispatched")
            self.assertEqual(item_status(request["items"][1], request), "awaiting_dispatch")
            self.assertEqual(item_status(request["items"][2], request), "awaiting_stock")

    def test_dispatch_plain_text_fallback_uses_order_number_as_rma(self) -> None:
        fact = parse_dispatch_notification(
            {
                "subject": "Dispatch delivery",
                "sender_address": "dispatch@example.test",
                "body": "Order No.  Line No.  Item  QTY  SN\nC3209937826  10  02540255  1  NEW-1",
                "html_body": "",
            },
            "dispatch@example.test",
        )
        self.assertIsNotNone(fact)
        assert fact is not None
        self.assertEqual(fact["assignments"][0]["rma"], "C3209937826")
        self.assertEqual(fact["assignments"][0]["line_number"], "10")
        self.assertEqual(fact["assignments"][0]["delivered_bom"], "02540255")
        self.assertIsNone(
            parse_dispatch_notification(
                {
                    "sender_address": "attacker@example.com",
                    "body": "C3209937826  10  02540255  1  NEW-1",
                },
                "dispatch@example.test",
            )
        )


class SpareRequestApplicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.data = self.root / "data"
        self.exports = self.root / "exports"
        self.workbooks = self.root / "workbooks"
        self.workbooks.mkdir()
        self.request_template = self.root / "request.xlsx"
        self.return_template = self.root / "return.xlsx"
        create_request_template(self.request_template)
        create_return_template(self.return_template)
        config = load_config(self.home)
        config["paths"].update(
            {
                "spare_parts_export_directory": str(self.exports),
                "spare_request_template_path": str(self.request_template),
                "spare_return_template_path": str(self.return_template),
                "workbook_directory": str(self.workbooks),
            }
        )
        save_config(self.home, config)
        self.store = ZeusStore(self.data, config_home=self.home)
        self.service = ApplicationService(self.store)

    def tearDown(self) -> None:
        self.service.stop()
        self.temporary.cleanup()

    def test_manual_export_persists_and_reexports_as_revision(self) -> None:
        lines = lines_input(2)
        lines[0].pop("reportDate")
        payload = {
            "source": "manual",
            "ticketId": "39416095",
            "reportDate": "2026-07-01",
            "profile": profile_input(),
            "lines": lines,
        }
        result = self.service.export_spare_request(payload)
        request_id = result["request"]["requestId"]
        self.assertTrue(Path(result["path"]).is_file())
        self.assertEqual(len(result["request"]["items"]), 2)
        self.assertEqual(result["request"]["reportDate"], "2026-07-01")
        self.assertTrue(
            all(
                line["report_date"] == "2026-07-01"
                for line in result["request"]["requestLines"]
            )
        )
        self.assertTrue(result["warnings"])
        revised = self.service.reexport_spare_request(request_id)
        self.assertRegex(revised["filename"], r"-r2\.xlsx$")
        dashboard = spare_requests_dashboard_payload(self.store, view="active")
        self.assertEqual(len(dashboard["spareRequests"]), 2)

    def test_manual_confirmation_owns_only_its_source_part_until_archived(self) -> None:
        ticket = {
            "schema_version": 2,
            "ticket_id": "39416095",
            "lifecycle": {"status": "active"},
            "upstream": {
                "fields": {
                    "SRNo": "39416095",
                    "Report Date": "2026-07-01 10:00:00",
                    "Customer Severity": "Minor",
                    "Problem Summary": "Controller board failure",
                }
            },
            "local": {
                "fields": {"Done?": "N", "Site": "UIO1", "Cloud": "Ecuador Cloud"},
                "spare_parts": [
                    {
                        "device": "SW-UIO-01",
                        "model": "S6730",
                        "faulty_sns": ["FAULTY-1"],
                        "parts": [
                            {
                                "slot": "1/0/1",
                                "part": "Controller board",
                                "bom": "02312RCC",
                                "notes": None,
                                "new_sn": None,
                            }
                        ],
                    }
                ],
            },
            "email": {
                "total_received": 0,
                "total_sent": 0,
                "last_activity_at": None,
                "messages": [],
            },
            "mop": {"latest": None, "versions": 0},
            "updated_at": None,
        }
        self.store.write_ticket_bundle(self.store.current, ticket)
        payload = {
            "source": "ticket",
            "ticketId": "39416095",
            "reportDate": "2026-07-01",
            "profile": profile_input(),
            "lines": [
                {
                    **lines_input(1)[0],
                    "deviceNumber": 1,
                    "partNumber": 1,
                }
            ],
        }

        before = spare_requests_dashboard_payload(self.store, view="eligible")
        self.assertEqual([row["rowId"] for row in before["eligibleParts"]], ["39416095:1:1"])
        registered = self.service.register_spare_request(payload)["request"]

        self.assertEqual(registered["creationMethod"], "manual_confirmation")
        self.assertIsNone(registered["spareSr"])
        self.assertIsNone(registered["items"][0]["rma"])
        self.assertIsNone(registered["export"]["request_filename"])
        self.assertEqual(registered["history"][0]["action"], "request-registered-manually")
        self.assertFalse(self.exports.exists())
        self.assertEqual(
            spare_requests_dashboard_payload(self.store, view="eligible")["eligibleParts"],
            [],
        )
        with self.assertRaisesRegex(ValidationError, "already has an Active Request"):
            self.service.export_spare_request(payload)

        item_id = registered["items"][0]["item_id"]
        self.service.archive_spare_items(
            item_ids=[item_id],
            reason="cancelled",
            note="The externally prepared request was cancelled.",
        )
        released = spare_requests_dashboard_payload(self.store, view="eligible")
        self.assertEqual([row["rowId"] for row in released["eligibleParts"]], ["39416095:1:1"])

    def test_rma_is_immutable_and_return_archive_requires_confirmation(self) -> None:
        result = self.service.export_spare_request(
            {
                "source": "manual",
                "ticketId": "39416095",
                "profile": profile_input(),
                "lines": lines_input(1),
            }
        )
        detail = result["request"]
        item_id = detail["items"][0]["item_id"]
        saved = self.service.edit_spare_request(
            detail["requestId"],
            expected_revision=detail["revision"],
            changes={"spareSr": "SR4956964", "note": "manual confirmation"},
            item_updates=[
                {
                    "itemId": item_id,
                    "rma": "C3209937826",
                    "deliveredBom": "02540255",
                    "newSn": "NEW-1",
                    "dispatchAt": "2026-08-08T12:00",
                    "attended": True,
                }
            ],
        )["request"]
        with self.assertRaisesRegex(ValidationError, "immutable"):
            self.service.edit_spare_request(
                saved["requestId"],
                expected_revision=saved["revision"],
                changes={},
                item_updates=[{"itemId": item_id, "rma": "C3209937827"}],
            )
        with self.assertRaisesRegex(ValidationError, "warehouse email"):
            self.service.archive_spare_items(
                item_ids=[item_id], reason="returned", note="", manual_override=False
            )
        archived = self.service.archive_spare_items(
            item_ids=[item_id],
            reason="returned",
            note="Verified by warehouse call",
            manual_override=True,
        )
        self.assertEqual(archived["archived"], [item_id])
        self.assertFalse(self.store.spare_request_file(saved["requestId"]).exists())
        completed = spare_requests_dashboard_payload(
            self.store,
            view="completed",
            closed_path=self.workbooks / "Closed.xlsx",
        )
        self.assertEqual(completed["spareRequests"][0]["itemId"], item_id)
        another = self.service.export_spare_request(
            {
                "source": "manual",
                "ticketId": "39416096",
                "profile": profile_input(),
                "lines": lines_input(1),
            }
        )["request"]
        with self.assertRaisesRegex(ValidationError, "completed item"):
            self.service.edit_spare_request(
                another["requestId"],
                expected_revision=another["revision"],
                changes={},
                item_updates=[
                    {"itemId": another["items"][0]["item_id"], "rma": "C3209937826"}
                ],
            )
        backup_dir = self.workbooks / "Zeus Backups" / "Spare Requests"
        backup_dir.mkdir(parents=True, exist_ok=True)
        private_backup = backup_dir / "Closed_20260808_120000_000000.xlsx"
        shutil.copy2(self.workbooks / "Closed.xlsx", private_backup)
        purged = self.service.purge_spare_data(item_ids=[item_id])
        self.assertEqual(purged["removed"], 1)
        self.assertEqual(purged["backupsRemoved"], 1)
        self.assertFalse(private_backup.exists())


if __name__ == "__main__":
    unittest.main()
