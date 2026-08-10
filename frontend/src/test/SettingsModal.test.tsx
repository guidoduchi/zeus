import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../components/SettingsModal";

const api = vi.hoisted(() => ({
  browsePath: vi.fn(),
  getSettings: vi.fn(),
  migrateDataDirectory: vi.fn(),
  openPath: vi.fn(),
  saveSettings: vi.fn(),
}));

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
    }],
  };
}

describe("SettingsModal data storage", () => {
  beforeEach(() => {
    api.getSettings.mockResolvedValue(settingsPayload());
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
});
