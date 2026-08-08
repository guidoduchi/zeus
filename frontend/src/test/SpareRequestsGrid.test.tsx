import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpareRequestsGrid } from "../components/SpareRequestsGrid";
import type { ColumnDefinition, SpareRequestItemSummary } from "../types";

const columns: ColumnDefinition[] = [
  { key: "ticketId", label: "TT", width: 94, default: true },
  { key: "rma", label: "RMA", width: 132, default: true },
  { key: "statusLabel", label: "Status", width: 170, default: true },
  { key: "dispatchAgeDays", label: "Days", width: 62, default: true },
];

function row(overrides: Partial<SpareRequestItemSummary> = {}): SpareRequestItemSummary {
  return {
    rowId: "260808123456-0001",
    requestId: "260808123456",
    itemId: "260808123456-0001",
    ticketId: "39416095",
    rma: "C3209937826",
    spareSr: "SR4956964",
    status: "awaiting_dispatch",
    statusLabel: "Awaiting dispatch",
    lifecycleColor: "grey",
    dispatchAgeDays: 16,
    dispatchAgeColor: "yellow",
    emailInactivityDays: 2,
    emailLabel: "2d inactive",
    emailColor: null,
    emailCount: 3,
    requestedBom: "02312RCC",
    deliveredBom: "02540255",
    part: "Controller board",
    model: "S6730",
    device: "SW-UIO-01",
    slot: "1/0/1",
    faultySn: "FAULTY-1",
    newSn: "NEW-1",
    site: "UIO1",
    cloud: "Ecuador Cloud",
    conflictCount: 0,
    risk: "yellow",
    readOnly: false,
    source: "active",
    ...overrides,
  };
}

describe("SpareRequestsGrid", () => {
  it("keeps lifecycle status color separate from dispatch aging and selects a unit item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const requestItem = row();
    render(
      <SpareRequestsGrid
        rows={[requestItem]}
        columns={columns}
        selectedRowId={null}
        onSelect={onSelect}
        onCloseDetail={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("columnheader")[0]).toHaveTextContent("TT");
    expect(screen.getByText("Awaiting dispatch")).toHaveClass("tone-grey");
    expect(screen.getByText("16")).toHaveClass("tone-yellow");
    await user.click(screen.getByRole("row", { name: /C3209937826/ }));
    expect(onSelect).toHaveBeenCalledWith(requestItem);
  });

  it("marks completed archive rows as read-only", () => {
    render(
      <SpareRequestsGrid
        rows={[row({ readOnly: true, source: "closed", status: "returned", statusLabel: "Returned" })]}
        columns={columns}
        selectedRowId={null}
        onSelect={vi.fn()}
        onCloseDetail={vi.fn()}
      />,
    );

    expect(screen.getByRole("row", { name: /Returned/ })).toHaveAttribute("data-read-only", "true");
  });
});
