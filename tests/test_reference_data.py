from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from zeus2.config import load_config
from zeus2.reference_data import (
    ReferenceDataError,
    combined_reference_data,
    derive_client_initials,
    load_bom_catalog,
    load_global_reference_data,
    save_bom_catalog,
    save_global_reference_data,
    save_user_profile,
    user_profile_payload,
)
from zeus2.storage_migration import (
    MINIMUM_FREE_BYTES,
    StorageMigrationError,
    finalize_pending_data_migration,
    migration_marker_path,
    prepare_data_migration,
)
from zeus2.store import ZeusStore
from zeus2.utils import atomic_write_json, load_json


PROFILE = {
    "name": "Nebby Operator",
    "email": "nebby@example.com",
    "phone": "+593 99 123 4567",
    "username": "nebby",
    "photoDataUrl": None,
}


class ReferenceDataTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.store = ZeusStore(self.home / "data", config_home=self.home)
        self.store.ensure_layout()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_profile_requires_only_name_email_and_phone_and_becomes_default_requester(self) -> None:
        self.assertFalse(user_profile_payload(self.store.root)["complete"])
        for missing in ("name", "email", "phone"):
            invalid = dict(PROFILE)
            invalid[missing] = ""
            with self.subTest(missing=missing), self.assertRaises(ReferenceDataError):
                save_user_profile(self.store.root, invalid)

        saved = save_user_profile(self.store.root, PROFILE)
        self.assertTrue(saved["complete"])
        self.assertEqual(saved["profile"], PROFILE)
        self.assertNotIn("password", saved["profile"])
        references = combined_reference_data(self.store.root)
        current = references["requesters"][0]
        self.assertEqual(current["id"], "__current_user__")
        self.assertTrue(current["currentUser"])
        self.assertTrue(current["pinned"])
        self.assertEqual(current["email"], PROFILE["email"])

    def test_contacts_require_an_organization_while_sites_remain_independent(self) -> None:
        saved = save_global_reference_data(
            self.store.root,
            {
                "organizations": [{"id": "org-claro", "name": "Claro Ecuador"}],
                "customers": [
                    {
                        "id": "contact-juan",
                        "organizationId": "org-claro",
                        "name": "Juan Piguave",
                        "email": "juan@example.com",
                        "phone": "+593 98 111 1111",
                    }
                ],
                "sites": [
                    {
                        "id": "site-uio",
                        "code": "uio1",
                        "name": "Quito DC",
                        "address": "Av. Example 123",
                        "cloud": "FusionSphere",
                    }
                ],
                "requesters": [
                    {
                        "id": "requester-favorite",
                        "name": "Favorite Engineer",
                        "email": "favorite@example.com",
                        "phone": "+593 97 222 2222",
                        "pinned": True,
                    }
                ],
            },
        )
        self.assertEqual(saved["customers"][0]["organizationId"], "org-claro")
        self.assertEqual(saved["sites"][0]["code"], "UIO1")
        self.assertTrue(saved["requesters"][0]["pinned"])
        with self.assertRaisesRegex(ReferenceDataError, "unknown customer organization"):
            save_global_reference_data(
                self.store.root,
                {
                    **saved,
                    "customers": [
                        {
                            "id": "orphan",
                            "organizationId": "missing-org",
                            "name": "Orphan Contact",
                        }
                    ],
                },
            )

    def test_bom_catalog_is_separate_and_initials_are_derived(self) -> None:
        save_global_reference_data(
            self.store.root,
            {"organizations": [], "customers": [], "sites": [], "requesters": []},
        )
        saved = save_bom_catalog(
            self.store.root,
            {
                "boms": [
                    {
                        "id": "bom-server",
                        "bom": "SERVER-001",
                        "description": "Complete server",
                    }
                ]
            },
        )
        self.assertEqual(saved, load_bom_catalog(self.store.root))
        self.assertNotIn("boms", load_global_reference_data(self.store.root))
        self.assertEqual(derive_client_initials("Juan Piguave"), "JP")
        self.assertEqual(derive_client_initials("Iván Núñez"), "IN")

    def test_legacy_json_manager_rows_upgrade_without_requiring_programmer_cleanup(self) -> None:
        legacy_home = self.root / "legacy-home"
        atomic_write_json(
            legacy_home / "spare_request_profiles.json",
            {
                "schema_version": 1,
                "customers": [
                    {
                        "id": "primary customer",
                        "name": "Claro Ecuador",
                        "clientInitials": "CE",
                    }
                ],
                "sites": [
                    {
                        "id": "Quito site",
                        "name": "UIO1",
                        "address": "Av. Example 123",
                        "cloud": "FusionSphere",
                    }
                ],
                "requesters": [
                    {
                        "id": "favorite requester",
                        "name": "Spare Engineer",
                        "email": "spares@example.com",
                        "phone": "+593 99 222 2222",
                    }
                ],
            },
        )
        atomic_write_json(
            legacy_home / "spare_request_boms.json",
            {
                "schema_version": 1,
                "boms": [{"id": "server BOM", "name": "Complete server"}],
            },
        )
        upgraded = ZeusStore(legacy_home / "data", config_home=legacy_home)
        upgraded.ensure_layout()

        references = load_global_reference_data(upgraded.root)
        self.assertEqual(references["organizations"][0]["name"], "Claro Ecuador")
        self.assertEqual(references["sites"][0]["code"], "UIO1")
        self.assertEqual(references["requesters"][0]["name"], "Spare Engineer")
        self.assertEqual(load_bom_catalog(upgraded.root)["boms"][0]["bom"], "server BOM")


class StorageMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.store = ZeusStore(self.home / "data", config_home=self.home)
        self.store.ensure_layout()
        save_user_profile(self.store.root, PROFILE)
        (self.store.root / "migration-proof.txt").write_text(
            "verified data", encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_verified_clone_is_selected_then_original_is_deleted_after_restart(self) -> None:
        source = self.store.root
        destination = self.root / "other-drive" / "zeus-data"
        prepared = prepare_data_migration(self.store, destination)
        self.assertTrue(prepared["restartRequired"])
        self.assertTrue(source.is_dir())
        self.assertEqual(
            (destination / "migration-proof.txt").read_text(encoding="utf-8"),
            "verified data",
        )

        selected, notices = finalize_pending_data_migration(
            self.home, load_config(self.home)
        )
        self.assertEqual(selected, destination.resolve())
        self.assertFalse(source.exists())
        self.assertFalse(migration_marker_path(self.home).exists())
        self.assertTrue(any("removed the verified original" in item for item in notices))

    def test_insufficient_destination_space_never_changes_the_pointer(self) -> None:
        destination = self.root / "small-drive" / "zeus-data"
        with patch(
            "zeus2.storage_migration.free_bytes",
            return_value=MINIMUM_FREE_BYTES - 1,
        ):
            with self.assertRaisesRegex(StorageMigrationError, "20 MiB reserve"):
                prepare_data_migration(self.store, destination)
        self.assertFalse(destination.exists())
        self.assertIsNone(load_config(self.home)["paths"]["data_directory"])

    def test_changed_clone_rolls_back_to_the_untouched_original(self) -> None:
        source = self.store.root
        destination = self.root / "other-drive" / "zeus-data"
        prepare_data_migration(self.store, destination)
        (destination / "migration-proof.txt").write_text("changed", encoding="utf-8")

        selected, notices = finalize_pending_data_migration(
            self.home, load_config(self.home)
        )
        self.assertEqual(selected, source)
        self.assertTrue(source.is_dir())
        self.assertFalse(destination.exists())
        self.assertIsNone(load_config(self.home)["paths"]["data_directory"])
        self.assertTrue(any("kept the original" in item for item in notices))

    def test_failed_old_copy_cleanup_is_retried_without_rolling_back(self) -> None:
        source = self.store.root
        destination = self.root / "other-drive" / "zeus-data"
        prepare_data_migration(self.store, destination)
        with patch("zeus2.storage_migration.shutil.rmtree", side_effect=OSError("busy")):
            selected, notices = finalize_pending_data_migration(
                self.home, load_config(self.home)
            )
        self.assertEqual(selected, destination.resolve())
        self.assertTrue(source.is_dir())
        self.assertEqual(
            load_json(migration_marker_path(self.home), {})["state"],
            "cleanup_pending",
        )
        self.assertTrue(any("retry" in item for item in notices))

        (destination / "written-after-handoff.txt").write_text(
            "new authoritative data", encoding="utf-8"
        )
        selected, _ = finalize_pending_data_migration(self.home, load_config(self.home))
        self.assertEqual(selected, destination.resolve())
        self.assertFalse(source.exists())
        self.assertTrue(destination.is_dir())
        self.assertEqual(
            (destination / "written-after-handoff.txt").read_text(encoding="utf-8"),
            "new authoritative data",
        )


if __name__ == "__main__":
    unittest.main()
