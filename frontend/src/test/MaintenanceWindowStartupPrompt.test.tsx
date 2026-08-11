import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceWindowStartupPrompt } from "../components/MaintenanceWindowStartupPrompt";
import type { TicketSummary, UpcomingMaintenanceWindow } from "../types";

function ticket(ticketId: string, windowId?: string): TicketSummary {
  return {
    ticketId,
    revision: `revision-${ticketId}`,
    lifecycle: "active",
    done: "N",
    maintenanceWindow: {
      schemaVersion: 1,
      status: "incomplete",
      date: "2026-08-10",
      startTime: "23:30",
      windowId: windowId || null,
      managedInUpcoming: Boolean(windowId),
      display: "2026-08-10 · 23:30",
      color: "red",
      confirmationRequired: true,
      attempts: [],
      reviewRequired: false,
    },
    plannedDate: "2026-08-10",
    plannedDays: -1,
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
    summary: `MW ${ticketId}`,
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
}

describe("MaintenanceWindowStartupPrompt", () => {
  it("reviews standalone and shared overdue windows without silently completing either", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const sharedId = "MW-260811120000-ABCD";
    const standalone = ticket("12345678");
    const sharedOne = ticket("22345678", sharedId);
    const sharedTwo = ticket("32345678", sharedId);
    const sharedWindow: UpcomingMaintenanceWindow = {
      windowId: sharedId,
      revision: "shared-revision",
      date: "2026-08-10",
      startTime: "23:30",
      status: "incomplete",
      managed: true,
      kind: "shared",
      canComplete: true,
      members: [
        { ticketId: "22345678", summary: "First", site: "GYE", cloud: "Cloud", severity: "Minor", handler: "Handler" },
        { ticketId: "32345678", summary: "Second", site: "UIO", cloud: "Cloud", severity: "Major", handler: "Handler" },
      ],
    };

    render(<MaintenanceWindowStartupPrompt tickets={[standalone, sharedOne, sharedTwo]} sharedWindows={[sharedWindow]} busy={false} onClose={vi.fn()} onSubmit={onSubmit} />);

    const save = screen.getByRole("button", { name: "Save MW review" });
    expect(save).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "SR 12345678 outcome" }), "completed");
    fireEvent.change(screen.getByLabelText("SR 12345678 optional finish time"), { target: { value: "00:30" } });
    await user.selectOptions(screen.getByRole("combobox", { name: `${sharedId} decision` }), "now");
    expect(screen.getByRole("combobox", { name: "SR 22345678 shared MW outcome" })).toHaveValue("completed");
    await user.selectOptions(screen.getByRole("combobox", { name: "SR 32345678 shared MW outcome" }), "incomplete");
    await user.click(save);

    expect(onSubmit).toHaveBeenCalledWith([
      { kind: "standalone", ticket: standalone, outcome: "completed", finishTime: "00:30" },
      { kind: "shared", window: sharedWindow, reviewNow: true, outcomes: { "22345678": true, "32345678": false }, finishTime: "" },
    ]);
  });

  it("can defer the whole startup review without writing outcomes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MaintenanceWindowStartupPrompt tickets={[ticket("12345678")]} sharedWindows={[]} busy={false} onClose={onClose} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Review later" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
