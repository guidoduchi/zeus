import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpcomingWorkspace } from "../components/UpcomingWorkspace";
import type { UpcomingMaintenanceWindowsPayload } from "../types";

const payload: UpcomingMaintenanceWindowsPayload = {
  datasetRevision: 12,
  stats: { windows: 1, tickets: 2, awaitingReview: 1 },
  windows: [{
    windowId: "MW-260811120000-ABCD",
    revision: "window-revision",
    date: "2000-01-01",
    startTime: "23:30",
    status: "incomplete",
    managed: true,
    canComplete: true,
    members: [
      { ticketId: "12345678", summary: "First member", site: "GYE", cloud: "Cloud A", severity: "Minor", handler: "Alice" },
      { ticketId: "87654321", summary: "Second member", site: "UIO", cloud: "Cloud B", severity: "Major", handler: "Bob" },
    ],
  }],
  archived: [],
  candidates: [
    { ticketId: "12345678", summary: "First member", site: "GYE", cloud: "Cloud A", severity: "Minor", handler: "Alice", available: false, currentWindowId: "MW-260811120000-ABCD", currentWindow: null },
    { ticketId: "23456789", summary: "Available member", site: "CUE", cloud: "Cloud C", severity: "Minor", handler: "Carol", available: true, currentWindowId: null, currentWindow: null },
  ],
};

describe("UpcomingWorkspace", () => {
  it("schedules available SRs with an optional half-hour start time", async () => {
    const user = userEvent.setup();
    const onSchedule = vi.fn().mockResolvedValue(undefined);
    render(<UpcomingWorkspace payload={payload} loading={false} busy={false} onRefresh={vi.fn()} onSchedule={onSchedule} onComplete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "+ Schedule MW" }));
    expect(screen.getByRole("checkbox", { name: /SR 12345678/ })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /SR 23456789/ }));
    fireEvent.change(screen.getByLabelText("MW date"), { target: { value: "2099-08-20" } });
    fireEvent.change(screen.getByLabelText("Optional start time"), { target: { value: "22:30" } });
    await user.click(screen.getByRole("button", { name: "Schedule MW" }));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledWith("2099-08-20", "22:30", ["23456789"]));
  });

  it("defaults every linked SR to Completed and submits the reviewed exceptions", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(<UpcomingWorkspace payload={payload} loading={false} busy={false} onRefresh={vi.fn()} onSchedule={vi.fn()} onComplete={onComplete} />);

    await user.click(screen.getByRole("button", { name: "Review completion" }));
    const first = screen.getByRole("combobox", { name: "SR 12345678 outcome" });
    const second = screen.getByRole("combobox", { name: "SR 87654321 outcome" });
    expect(first).toHaveValue("completed");
    expect(second).toHaveValue("completed");
    await user.selectOptions(second, "incomplete");
    fireEvent.change(screen.getByLabelText("Optional finish time"), { target: { value: "00:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm reviewed outcomes" }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(
      payload.windows[0],
      { "12345678": true, "87654321": false },
      "00:30",
    ));
  });
});
