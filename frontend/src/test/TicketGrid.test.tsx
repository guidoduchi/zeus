import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TicketGrid } from "../components/TicketGrid";
import type { ColumnDefinition, TicketSummary } from "../types";
import styles from "../styles.css?raw";

const columns: ColumnDefinition[] = [
  { key: "ticketId", label: "SR", width: 94, default: true },
  { key: "done", label: "MW", width: 128, default: true },
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
    maintenanceWindow: {
      schemaVersion: 1,
      status: "unplanned",
      date: null,
      display: "Unplanned",
      color: "yellow",
      confirmationRequired: false,
      attempts: [],
      reviewRequired: false,
    },
    plannedDate: "Unplanned",
    plannedDays: null,
    plannedState: "unplanned",
    plannedColor: "yellow",
    ticketAgeDays: 10,
    ticketAgeColor: null,
    emailInactivityDays: null,
    emailLabel: "No email",
    emailCount: 7,
    emailColor: "grey",
    lastEmailDirection: null,
    received: 0,
    sent: 0,
    spareBadges: { eligible: 0, active: 0, activeColor: "green", completed: 0 },
    summary: `Ticket ${ticketId}`,
    customerOrganization: "Organization",
    customerContact: `Customer ${ticketId}`,
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
  const onHighlight = vi.fn();
  const onOpen = vi.fn();
  const onCloseDetail = vi.fn();
  render(
    <TicketGrid
      tickets={[ticket("12345678"), ticket("87654321")]}
      columns={columns}
      selectedRowId={selectedRowId}
      detailOpen={false}
      onHighlight={onHighlight}
      onOpen={onOpen}
      onCloseDetail={onCloseDetail}
    />,
  );
  return { onHighlight, onOpen, onCloseDetail };
}

describe("TicketGrid", () => {
  it("uses one click to highlight and double click or Enter to open", async () => {
    const user = userEvent.setup();
    const { onHighlight, onOpen } = renderGrid("12345678");
    await user.click(screen.getByRole("row", { name: /12345678/i }));
    expect(onHighlight).toHaveBeenCalledWith("12345678");
    expect(onOpen).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole("row", { name: /12345678/i }));
    expect(onOpen).toHaveBeenCalledWith("12345678");

    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{ArrowDown}");
    expect(onHighlight).toHaveBeenCalledWith("87654321");
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenLastCalledWith("12345678");
  });

  it("leaves wheel events available for native table scrolling", () => {
    renderGrid("12345678");
    const scroll = screen.getByTestId("dashboard-scroll");
    const wheel = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    scroll.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(scroll).toHaveClass("ticket-scroll");
    expect(styles).toMatch(/\.ticket-scroll\s*\{[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/html, body, #root\s*\{[^}]*overflow:\s*hidden/s);
  });

  it("shows customer contact only while the highlighted SR detail is closed", () => {
    const props = {
      tickets: [ticket("12345678")],
      columns,
      selectedRowId: "12345678",
      onHighlight: vi.fn(),
      onOpen: vi.fn(),
      onCloseDetail: vi.fn(),
    };
    const { rerender } = render(<TicketGrid {...props} detailOpen={false} />);
    expect(screen.getByText("Customer contact: Customer 12345678")).toBeVisible();
    expect(screen.queryByText(/Enter opens/i)).not.toBeInTheDocument();

    rerender(<TicketGrid {...props} detailOpen />);
    expect(screen.queryByText("Customer contact: Customer 12345678")).not.toBeInTheDocument();
  });

  it("does not resize columns and clips dense rows to one line", () => {
    renderGrid();
    expect(styles).not.toMatch(/\.(?:ticket-cell|ticket-row|grid-header)[^{]*\{[^}]*resize:/s);
    expect(styles).toMatch(/\.ticket-cell\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it("uses one configurable semantic typography scale", () => {
    expect(styles).toMatch(/:root\s*\{[^}]*--font-body:\s*11px[^}]*--font-heading:\s*15px/s);
    expect(styles).toMatch(/:root\[data-font-scale="compact"\]\s*\{[^}]*--font-body:\s*10px/s);
    expect(styles).toMatch(/:root\[data-font-scale="large"\]\s*\{[^}]*--font-body:\s*13px/s);
    expect(styles).toMatch(/body\s*\{[^}]*font-size:\s*var\(--font-body\)/s);
    expect(styles).not.toMatch(/font-size:\s*(?:9|10|11|12|13|14|15|16)px/);
  });

  it("keeps the CLI warning colors on their matching facts", () => {
    renderGrid();
    expect(screen.getAllByText("Unplanned")[0]).toHaveClass("tone-yellow");
    expect(screen.queryByRole("columnheader", { name: "Planned" })).not.toBeInTheDocument();
    expect(screen.getAllByText("10")[0]).toHaveClass("tone-none");
    expect(screen.getAllByText("No email")[0].closest('[role="gridcell"]')).toHaveClass("tone-grey");
    expect(screen.getAllByText("Unplanned")[0]).toHaveClass("column-done");
    expect(screen.queryByRole("columnheader", { name: "Emails" })).not.toBeInTheDocument();
  });

  it("shows the real MW date instead of a state word whenever a date is current", () => {
    const dated = ticket("12345678");
    dated.done = "N";
    dated.maintenanceWindow = {
      schemaVersion: 1,
      status: "planned",
      date: "2026-08-21",
      display: "2026-08-21",
      color: null,
      confirmationRequired: false,
      attempts: [{ date: "2026-08-01", outcome: "incomplete", confirmed_at: "2026-08-02T00:00:00Z", source: "manual" }],
      reviewRequired: false,
    };
    render(
      <TicketGrid
        tickets={[dated]}
        columns={columns}
        selectedRowId={null}
        detailOpen={false}
        onHighlight={vi.fn()}
        onOpen={vi.fn()}
        onCloseDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("2026-08-21")).toHaveClass("column-done");
    expect(screen.queryByText("Planned")).not.toBeInTheDocument();
    expect(screen.queryByText("Incomplete")).not.toBeInTheDocument();
  });

  it("shows received and sent triangular badges without a total badge", () => {
    const positive = ticket("12345678");
    positive.received = 4;
    positive.sent = 3;
    const zero = { ...ticket("87654321"), emailCount: 0, received: 0, sent: 0 };
    render(
      <TicketGrid
        tickets={[positive, zero]}
        columns={columns}
        selectedRowId={null}
        detailOpen={false}
        onHighlight={vi.fn()}
        onOpen={vi.fn()}
        onCloseDetail={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("4 received email(s)")).toHaveClass("received");
    expect(screen.getByLabelText("3 sent email(s)")).toHaveClass("sent");
    expect(screen.getAllByLabelText("0 received email(s)")).not.toHaveLength(0);
    expect(screen.queryByLabelText("7 total emails")).not.toBeInTheDocument();
    expect(styles).toMatch(/\.email-direction-badge\.received\s*\{[^}]*color:\s*var\(--green\)/s);
    expect(styles).toMatch(/\.email-direction-badge\.sent\s*\{[^}]*color:\s*var\(--cyan\)/s);
  });

  it("marks protected SR drafts without confusing them with row selection", () => {
    render(
      <TicketGrid
        tickets={[ticket("12345678"), ticket("87654321")]}
        columns={columns}
        selectedRowId="87654321"
        draftTicketIds={new Set(["12345678"])}
        detailOpen={false}
        onHighlight={vi.fn()}
        onOpen={vi.fn()}
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
    const onOpen = vi.fn();
    let rerender: ReturnType<typeof render>["rerender"];
    const onHighlight = vi.fn((ticketId: string) => {
      rerender(<TicketGrid tickets={tickets} columns={columns} selectedRowId={ticketId} detailOpen={false} onHighlight={onHighlight} onOpen={onOpen} onCloseDetail={vi.fn()} />);
    });
    ({ rerender } = render(<TicketGrid tickets={tickets} columns={columns} selectedRowId={null} detailOpen={false} onHighlight={onHighlight} onOpen={onOpen} onCloseDetail={vi.fn()} />));
    const grid = screen.getByRole("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });

    const first = screen.getByRole("row", { name: /12345678/i });
    await waitFor(() => expect(first).toHaveFocus());
    expect(first).toHaveClass("selected");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores Escape without an open detail and never outlines the whole table", async () => {
    const user = userEvent.setup();
    const { onCloseDetail } = renderGrid();
    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{Escape}");
    expect(onCloseDetail).not.toHaveBeenCalled();
    expect(styles).toMatch(/\.ticket-scroll:focus-visible\s*\{[^}]*outline:\s*none/s);
  });
});
