import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OperationsModal } from "../components/OperationsModal";
import type { Job } from "../types";

describe("OperationsModal Outlook progress", () => {
  it("shows exact progress and a readable in-session activity log", async () => {
    const job: Job = {
      id: "outlook-job",
      kind: "email-fetch",
      label: "Fetching Outlook email",
      status: "running",
      cancellable: true,
      createdAt: "2026-08-11T10:00:00Z",
      startedAt: "2026-08-11T10:00:01Z",
      finishedAt: null,
      lastProgressAt: "2026-08-11T10:01:00Z",
      stage: "scan",
      message: "Inbox · 1,200 / 5,000 messages · 23 matched",
      current: 1_200,
      total: 5_000,
      updates: [
        {
          timestamp: "2026-08-11T10:00:02Z",
          stage: "folders",
          message: "Enumerating Outlook folders",
          current: null,
          total: null,
        },
        {
          timestamp: "2026-08-11T10:01:00Z",
          stage: "scan",
          message: "Inbox · 1,200 / 5,000 messages · 23 matched",
          current: 1_200,
          total: 5_000,
        },
      ],
      result: null,
      error: null,
    };

    render(<OperationsModal
      jobs={[job]}
      outlookEnabled
      outlookAvailable
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRun={vi.fn()}
      onCancel={vi.fn()}
      onError={vi.fn()}
    />);

    expect(screen.getByText(/1,200 \/ 5,000 messages · 23 matched/i)).toBeVisible();
    await userEvent.click(screen.getByText(/progress log \(2\)/i));
    expect(screen.getByText("Enumerating Outlook folders")).toBeVisible();
  });

  it("disables every email operation when Zeus has no eligible database record", () => {
    render(<OperationsModal
      jobs={[]}
      outlookEnabled
      outlookAvailable
      outlookTargetsAvailable={false}
      onClose={vi.fn()}
      onSettings={vi.fn()}
      onRun={vi.fn()}
      onCancel={vi.fn()}
      onError={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: /Fetch Outlook email/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Synchronize staged email/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Rebuild email history/i })).toBeDisabled();
    expect(screen.getAllByText(/Add an active Service Request, Spare Request, or Fault Tag/i)).toHaveLength(3);
  });
});
