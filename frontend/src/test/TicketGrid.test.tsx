import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TicketGrid } from "../components/TicketGrid";
import type { ColumnDefinition, TicketSummary } from "../types";
import styles from "../styles.css?raw";

const columns: ColumnDefinition[] = [
  { key: "ticketId", label: "SR", width: 94, default: true },
  { key: "plannedDate", label: "Planned", width: 116, default: true },
  { key: "ticketAgeDays", label: "Age", width: 62, default: true },
  { key: "emailLabel", label: "Email", width: 142, default: true },
  { key: "emailCount", label: "Emails", width: 68, default: true },
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
    emailLabel: "No email found",
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

function renderGrid(selectedId: string | null = null) {
  const onSelect = vi.fn();
  render(
    <TicketGrid
      tickets={[ticket("12345678"), ticket("87654321")]}
      columns={columns}
      selectedId={selectedId}
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
    expect(screen.getAllByText("No email found")[0]).toHaveClass("tone-grey");
    expect(screen.getAllByText("7")[0]).toHaveClass("tone-none");
  });
});
