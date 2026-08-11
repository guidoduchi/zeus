import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../components/SettingsModal";

const api = vi.hoisted(() => ({
  browsePath: vi.fn(),
  getDatabaseMaintenance: vi.fn(),
  getSettings: vi.fn(),
  migrateDataDirectory: vi.fn(),
  openPath: vi.fn(),
  runDatabaseMaintenance: vi.fn(),
  saveSettings: vi.fn(),
}));

function maintenanceStatus(status: "current" | "upgrade_available" = "current") {
  return {
    status,
    currentSchemaVersion: 3,
    storedSchemaVersion: status === "current" ? 3 : 2,
    ticketCount: 4,
    spareRequestCount: 1,
    outdatedTicketCount: status === "current" ? 0 : 4,
    outdatedTicketIds: status === "current" ? [] : ["12345678", "22345678", "32345678", "42345678"],
    repairableMarkdownCount: 0,
    repairableMarkdown: [],
    reviewCount: 0,
    reviewRecords: [],
    blockedCount: 0,
    blockedRecords: [],
    canApply: status !== "current",
    backupRequired: true,
  };
}

vi.mock("../api", () => api);

function settingsPayload(fontScale = "standard") {
  return {
    schemaVersion: 9,
    settings: [{
      key: "paths.data_directory",
      label: "Zeus data folder",
      category: "Application storage",
      kind: "data_directory",
      description: "Mutable Zeus data.",
      minimum: null,
      choices: [],
      nullable: false,
      editable: false,
      value: "C:\\Users\\Nebby\\AppData\\Local\\Zeus\\data",
      status: { exists: true, path: "C:\\Users\\Nebby\\AppData\\Local\\Zeus\\data", message: "1024 MiB available" },
    }, {
      key: "web.font_scale",
      label: "Interface text size",
      category: "Appearance",
      kind: "choice",
      description: "Use one consistent typography scale throughout Zeus.",
      minimum: null,
      choices: ["compact", "standard", "large"],
      nullable: false,
      editable: true,
      value: fontScale,
    }, {
      key: "web.show_detail_history",
      label: "Show raw detail history",
      category: "Developer options",
      kind: "boolean",
      description: "Expose raw detail History tabs.",
      minimum: null,
      choices: [],
      nullable: false,
      editable: true,
      value: false,
    }],
  };
}

describe("SettingsModal data storage", () => {
  beforeEach(() => {
    api.getSettings.mockResolvedValue(settingsPayload());
    api.getDatabaseMaintenance.mockResolvedValue(maintenanceStatus());
    api.runDatabaseMaintenance.mockResolvedValue({ ...maintenanceStatus(), changed: true, backup: "maintenance.zip" });
    api.saveSettings.mockImplementation(async (updates) => settingsPayload(String(updates["web.font_scale"] || "standard")));
    api.browsePath.mockResolvedValue({ cancelled: false, path: "D:\\ZeusData" });
    api.migrateDataDirectory.mockResolvedValue({
      restartRequired: true,
      oldPath: "C:\\Users\\Nebby\\AppData\\Local\\Zeus\\data",
      newPath: "D:\\ZeusData",
      bytesCopied: 1024,
      freeBytesAfterCopy: 100_000_000,
    });
  });

  it("keeps the root read-only and uses the verified move workflow", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("Native browser confirmations are forbidden");
    });
    const realSetTimeout = window.setTimeout.bind(window);
    const timeout = vi.spyOn(window, "setTimeout").mockImplementation((handler, delay, ...arguments_) => (
      delay === 2500 ? 0 : realSetTimeout(handler, delay, ...arguments_)
    ));
    render(<SettingsModal onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);

    const path = await screen.findByLabelText("Zeus data folder");
    expect(path).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move data…" }));

    expect(screen.getByRole("dialog", { name: "Move the Zeus data folder?" })).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Verify and move data" }));
    await waitFor(() => expect(api.migrateDataDirectory).toHaveBeenCalledWith("D:\\ZeusData"));
    expect(screen.getByText(/verified data clone is complete/i)).toBeVisible();
    timeout.mockRestore();
    confirm.mockRestore();
  });

  it("persists Compact, Standard, and Large as validated interface presets", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);

    const scale = await screen.findByLabelText("Interface text size");
    expect(scale).toHaveValue("standard");
    expect(screen.getByRole("option", { name: "Compact" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Standard" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Large" })).toBeVisible();

    await user.selectOptions(scale, "large");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ "web.font_scale": "large" }));
    expect(scale).toHaveValue("large");
  });

  it("keeps raw detail History off by default and exposes a developer toggle", async () => {
    const user = userEvent.setup();
    render(<SettingsModal onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);

    const toggle = await screen.findByLabelText("Show raw detail history");
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ "web.show_detail_history": true }));
  });

  it("previews and explicitly confirms a backup-backed database upgrade", async () => {
    const user = userEvent.setup();
    api.getDatabaseMaintenance.mockResolvedValue(maintenanceStatus("upgrade_available"));
    api.runDatabaseMaintenance.mockResolvedValue({
      ...maintenanceStatus(),
      changed: true,
      backup: "20260810-database-maintenance.zip",
    });
    render(<SettingsModal onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);

    expect(await screen.findByText("Upgrade available")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upgrade & repair" }));
    expect(screen.getByRole("dialog", { name: "Upgrade and repair the Zeus database?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back up, upgrade & repair" }));

    await waitFor(() => expect(api.runDatabaseMaintenance).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Database is current")).toBeVisible();
    expect(screen.getByText(/20260810-database-maintenance\.zip/)).toBeVisible();
  });
});
