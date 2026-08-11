import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FaultTagExportDialog, SpareLifecycleBulkDialog, type FaultTagTarget, type SpareLifecycleTarget } from "../components/SpareBulkDialogs";

function lifecycleTarget(index: number, overrides: Partial<SpareLifecycleTarget> = {}): SpareLifecycleTarget {
  const requestId = `26081012000${index}`;
  return {
    requestId,
    revision: `revision-${requestId}`,
    itemId: `${requestId}-0001`,
    rma: `C320993782${index}`,
    lifecycleStage: 4,
    lifecycleStageLabel: "Spare replaced",
    nextStageLabel: "Warehouse evidence received",
    rollbackRequiresDoubleConfirmation: false,
    ...overrides,
  };
}

function faultTarget(index: number, overrides: Partial<FaultTagTarget> = {}): FaultTagTarget {
  return {
    itemId: `26081012000${index}-0001`, ticketId: `3941609${index}`,
    rma: `C320993782${index}`, requestedBom: `BOM-${index}`,
    site: "UIO1", cloud: "Ecuador Cloud", ...overrides,
  };
}

describe("Spare bulk dialogs", () => {
  it("requires an explicit override and audit note for email-backed rollback", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <SpareLifecycleBulkDialog
        rows={[lifecycleTarget(1, { rollbackRequiresDoubleConfirmation: true })]}
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

    expect(onConfirm).toHaveBeenCalledWith(true, "Wrong lifecycle match", undefined);
  });

  it("uses the stage-specific manual email confirmation and sends its editable time", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<SpareLifecycleBulkDialog rows={[lifecycleTarget(1, { lifecycleStage: 0, lifecycleStageLabel: "Added to Zeus", nextStageLabel: "Request email sent" })]} action="advance" busy={false} onCancel={vi.fn()} onConfirm={onConfirm} />);
    const input = screen.getByLabelText("Confirmation time");
    await user.clear(input);
    await user.type(input, "2026-08-10T11:30");
    await user.click(screen.getByRole("button", { name: "Confirm request email sent" }));
    expect(onConfirm).toHaveBeenCalledWith(false, "", new Date("2026-08-10T11:30").toISOString());
    expect(screen.getByText(/later matching email attaches as evidence/i)).toBeVisible();
  });

  it("collects per-item conditions and the actual destination for mixed sites", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const first = faultTarget(1);
    const second = faultTarget(2, { site: "GYE1", cloud: "Coastal Cloud" });
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
