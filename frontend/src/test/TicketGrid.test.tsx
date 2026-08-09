import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TicketGrid } from "../components/TicketGrid";
import type { ColumnDefinition, TicketSummary } from "../types";
import styles from "../styles.css?raw";

const columns: ColumnDefinition[] = [
  { key: "ticketId", label: "SR", width: 94, default: true },
  { key: "plannedDate", label: "Planned", width: 116, default: true },
  { key: "ticketAgeDays", label: "Age", width: 62, default: true },
  { key: "emailLabel", label: "Last Email", width: 154, default: true },
  { key: "severity", label: "Severity", width: 92, default: true },
  { key: "summary", label: "Summary", width: 360, default: true, flex: true },
];

function ticket(ticketId: string): TicketSummary {
  return {
    ticketId,
    revision: `revision-${ticketId}`,
    lifecycle: "active",
    done: "N",
    plannedDate: "Unplanned",
    plannedDays: null,
    plannedState: "unplanned",
    plannedColor: "yellow",
    ticketAgeDays: 10,
    ticketAgeColor: null,
    emailInactivityDays: null,
    emailLabel: "No email [7]",
    emailCount: 7,
    emailColor: "grey",
    lastEmailDirection: null,
    received: 0,
    sent: 0,
    summary: `Ticket ${ticketId}`,
    severity: "Minor",
    product: "Product",
    handler: "Handler",
    status: "Working",
    resolveBy: "No deadline",
    resolveDays: null,
    site: "GYE",
    cloud: "Cloud",
    model: "Model",
    device: "Device",
    risk: "yellow",
  };
}

function renderGrid(selectedRowId: string | null = null) {
  const onSelect = vi.fn();
  render(
    <TicketGrid
      tickets={[ticket("12345678"), ticket("87654321")]}
      columns={columns}
      selectedRowId={selectedRowId}
      onSelect={onSelect}
      onCloseDetail={vi.fn()}
    />,
  );
  return onSelect;
}

describe("TicketGrid", () => {
  it("clicks and Enter select real rows", async () => {
    const user = userEvent.setup();
    const onSelect = renderGrid();
    await user.click(screen.getByRole("row", { name: /12345678/i }));
    expect(onSelect).toHaveBeenCalledWith("12345678");

    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("87654321");
  });

  it("keeps wheel scrolling native to the dashboard list", () => {
    renderGrid("12345678");
    const scroll = screen.getByTestId("dashboard-scroll");
    const wheel = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    scroll.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(scroll).toHaveClass("ticket-scroll");
    expect(styles).toMatch(/\.ticket-scroll\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/html, body, #root\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("does not resize columns and clips dense rows to one line", () => {
    renderGrid();
    expect(styles).not.toMatch(/\.(?:ticket-cell|ticket-row|grid-header)[^{]*\{[^}]*resize:/s);
    expect(styles).toMatch(/\.ticket-cell\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it("keeps the CLI warning colors on their matching facts", () => {
    renderGrid();
    expect(screen.getAllByText("Unplanned")[0]).toHaveClass("tone-yellow");
    expect(screen.getAllByText("10")[0]).toHaveClass("tone-none");
    expect(screen.getAllByText("No email [7]")[0]).toHaveClass("tone-grey");
    expect(screen.queryByRole("columnheader", { name: "Emails" })).not.toBeInTheDocument();
  });

  it("marks protected SR drafts without confusing them with row selection", () => {
    render(
      <TicketGrid
        tickets={[ticket("12345678"), ticket("87654321")]}
        columns={columns}
        selectedRowId="87654321"
        draftTicketIds={new Set(["12345678"])}
        onSelect={vi.fn()}
        onCloseDetail={vi.fn()}
      />,
    );

    const draftRow = screen.getByRole("row", { name: /12345678.*Protected draft/i });
    expect(draftRow).toHaveClass("draft-protected");
    expect(draftRow).not.toHaveClass("selected");
    expect(screen.getByRole("row", { name: /87654321/i })).toHaveClass("selected");
  });

  it("moves keyboard focus with the newly selected row", async () => {
    const tickets = [ticket("12345678"), ticket("87654321")];
    let rerender: ReturnType<typeof render>["rerender"];
    const onSelect = vi.fn((ticketId: string) => {
      rerender(<TicketGrid tickets={tickets} columns={columns} selectedRowId={ticketId} onSelect={onSelect} onCloseDetail={vi.fn()} />);
    });
    ({ rerender } = render(<TicketGrid tickets={tickets} columns={columns} selectedRowId={null} onSelect={onSelect} onCloseDetail={vi.fn()} />));
    const grid = screen.getByRole("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });

    const second = screen.getByRole("row", { name: /87654321/i });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveClass("selected");
  });
});
