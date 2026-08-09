import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SparePartsGrid } from "../components/SparePartsGrid";
import type { ColumnDefinition, SparePartSummary } from "../types";

const columns: ColumnDefinition[] = [
  { key: "ticketId", label: "SR", width: 94, default: true },
  { key: "device", label: "Device", width: 165, default: true },
  { key: "part", label: "Part", width: 150, default: true },
  { key: "bom", label: "BOM", width: 150, default: true },
];

function row(rowId: string, bom: string, part: string): SparePartSummary {
  return {
    rowId,
    ticketId: "12345678",
    revision: "revision",
    lifecycle: "active",
    done: "N",
    plannedDate: "2026-08-21",
    plannedDays: 14,
    plannedState: "future",
    plannedColor: null,
    site: "GYE",
    cloud: "FusionSphere",
    deviceNumber: 1,
    partNumber: Number(rowId.split(":")[2]),
    device: "server-a",
    model: "2288H V5",
    slot: "Slot 1",
    part,
    bom,
    bomColor: bom === "—" ? "yellow" : null,
    faultySn: "FAULTY-1",
    newSn: "—",
    summary: "Disk replacement",
    risk: "none",
    hasPart: true,
    readOnly: false,
    source: "current",
  };
}

describe("SparePartsGrid", () => {
  it("manages each damaged part as a selectable row under its parent SR", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    const onOpen = vi.fn();
    const rows = [
      row("12345678:1:1", "BOM-1", "Disk"),
      row("12345678:1:2", "—", "Backplane"),
    ];
    render(
      <SparePartsGrid
        rows={rows}
        columns={columns}
        selectedRowId={rows[0].rowId}
        detailOpen={false}
        onHighlight={onHighlight}
        onOpen={onOpen}
        onCloseDetail={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("row", { name: /Backplane/i }));
    expect(onOpen).toHaveBeenCalledWith(rows[1]);
    expect(screen.getByText("—", { selector: ".column-bom" })).toHaveClass("tone-yellow");

    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{ArrowDown}");
    expect(onHighlight).toHaveBeenCalledWith(rows[1]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
