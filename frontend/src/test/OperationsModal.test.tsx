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
});
