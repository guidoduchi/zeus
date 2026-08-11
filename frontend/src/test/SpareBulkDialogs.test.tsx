import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FaultTagExportDialog, SpareLifecycleBulkDialog } from "../components/SpareBulkDialogs";
import type { SpareRequestItemSummary } from "../types";

function row(index: number, overrides: Partial<SpareRequestItemSummary> = {}): SpareRequestItemSummary {
  const requestId = `26081012000${index}`;
  return {
    rowId: `${requestId}-0001`,
    requestId,
    revision: `revision-${requestId}`,
    itemId: `${requestId}-0001`,
    ticketId: `3941609${index}`,
    rma: `C320993782${index}`,
    spareSr: `SR495696${index}`,
    trackingId: `SR495696${index}`,
    trackingIdProvisional: false,
    lifecycleStage: 4,
    lifecycleStageLabel: "Spare replaced",
    lifecycleStageSource: "email",
    status: "awaiting_return",
    statusLabel: "Awaiting return",
    lifecycleColor: "green",
    dispatchAgeDays: 1,
    dispatchAgeColor: null,
    emailInactivityDays: 1,
    emailLabel: "1 day",
    emailColor: null,
    emailCount: 1,
    received: 1,
    sent: 0,
    requestedBom: `BOM-${index}`,
    deliveredBom: `DELIVERED-${index}`,
    part: "Controller board",
    model: "S6730",
    device: `SW-${index}`,
    slot: `1/0/${index}`,
    faultySn: `FAULTY-${index}`,
    newSn: `NEW-${index}`,
    returnCondition: null,
    faultTagIds: [],
    faultTagId: null,
    site: "UIO1",
    cloud: "Ecuador Cloud",
    conflictCount: 0,
    risk: "none",
    readOnly: false,
    source: "active",
    canAdvance: true,
    canRollback: true,
    nextStageLabel: "Warehouse evidence received",
    rollbackRequiresDoubleConfirmation: false,
    ...overrides,
  };
}

describe("Spare bulk dialogs", () => {
  it("requires an explicit override and audit note for email-backed rollback", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SpareLifecycleBulkDialog
        rows={[row(1, { rollbackRequiresDoubleConfirmation: true })]}
        action="rollback"
        busy={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Roll back one stage" });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /explicitly override/ }));
    await user.type(screen.getByRole("textbox", { name: "Required audit note" }), "Wrong lifecycle match");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith(true, "Wrong lifecycle match");
  });

  it("collects per-item conditions and the actual destination for mixed sites", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const first = row(1);
    const second = row(2, { site: "GYE1", cloud: "Coastal Cloud" });
    render(
      <FaultTagExportDialog
        rows={[first, second]}
        busy={false}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const exportButton = screen.getByRole("button", { name: "Export Fault Tag" });
    expect(exportButton).toBeDisabled();
    const conditions = screen.getAllByRole("combobox", { name: "Return condition" });
    await user.selectOptions(conditions[1], "New");
    await user.type(screen.getByRole("textbox", { name: "Site code" }), "CUE1");
    await user.type(screen.getByRole("textbox", { name: "Cloud" }), "Andes Cloud");
    await user.type(screen.getByRole("textbox", { name: "Return address" }), "Av. Return 123");
    expect(exportButton).toBeEnabled();
    await user.click(exportButton);

    expect(onConfirm).toHaveBeenCalledWith(
      [
        { itemId: first.itemId, condition: "Faulty" },
        { itemId: second.itemId, condition: "New" },
      ],
      { code: "CUE1", cloud: "Andes Cloud", address: "Av. Return 123" },
    );
  });
});
