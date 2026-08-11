import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceWindowPrompt } from "../components/MaintenanceWindowPrompt";
import type { TicketSummary } from "../types";

const ticket: TicketSummary = {
  ticketId: "12345678",
  revision: "revision",
  lifecycle: "active",
  done: "N",
  maintenanceWindow: {
    schemaVersion: 1,
    status: "planned",
    date: "2026-08-08",
    display: "2026-08-08",
    color: "red",
    confirmationRequired: true,
    attempts: [],
    reviewRequired: false,
  },
  plannedDate: "2026-08-08",
  plannedDays: -2,
  plannedState: "overdue",
  plannedColor: "red",
  ticketAgeDays: 20,
  ticketAgeColor: null,
  emailInactivityDays: null,
  emailLabel: "No email",
  emailCount: 0,
  emailColor: "grey",
  lastEmailDirection: null,
  received: 0,
  sent: 0,
  spareBadges: { pendingDispatch: 0, dispatched: 0, overdue: 0, returned: 0 },
  summary: "MW decision",
  customerOrganization: "Organization",
  customerContact: "Customer",
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
  risk: "red",
};

describe("MaintenanceWindowPrompt", () => {
  it("collects each overdue window in one batch review", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    render(<MaintenanceWindowPrompt tickets={[ticket]} busy={false} onClose={onClose} onSubmit={onSubmit} />);

    expect(screen.getByText("2026-08-08")).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "incomplete");
    await user.type(screen.getByLabelText("Optional new MW date"), "2026-08-22");
    await user.click(screen.getByRole("button", { name: "Save MW review" }));
    expect(onSubmit).toHaveBeenCalledWith([{ ticket, outcome: "incomplete", rescheduleDate: "2026-08-22" }]);
    await user.click(screen.getByRole("button", { name: "Review later" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
