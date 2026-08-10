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
  summary: "MW decision",
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
  it("offers explicit later, incomplete, and complete outcomes", async () => {
    const user = userEvent.setup();
    const onLater = vi.fn();
    const onOutcome = vi.fn();
    render(<MaintenanceWindowPrompt ticket={ticket} busy={false} onLater={onLater} onOutcome={onOutcome} />);

    expect(screen.getByText("2026-08-08")).toBeVisible();
    expect(screen.getByText(/clears the current date.*failed date remains in history/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "No · incomplete" }));
    expect(onOutcome).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Yes · complete" }));
    expect(onOutcome).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Decide later" }));
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
