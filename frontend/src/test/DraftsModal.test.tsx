import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsModal } from "../components/DraftsModal";
import { countUnsavedDrafts, writeTicketDraft } from "../drafts";
import type { TicketDetail } from "../types";

const api = vi.hoisted(() => ({
  getTicket: vi.fn(),
  saveTicketDraftBatch: vi.fn(),
}));

vi.mock("../api", () => api);

function ticket(ticketId: string, notes = "", revision = `revision-${ticketId}`): TicketDetail {
  return {
    ticketId,
    revision,
    summary: `Summary ${ticketId}`,
    localFields: {
      "Planned Date": null,
      Site: "GYE",
      Cloud: null,
      RelatedSR: null,
      "Done?": "N",
      Notes: notes,
    },
    spareParts: [],
    readOnly: false,
  } as unknown as TicketDetail;
}

function protectWorkDraft(value: TicketDetail, notes: string) {
  const baseValue = {
    "Planned Date": "",
    Site: "GYE",
    Cloud: "",
    RelatedSR: "",
    "Done?": "N",
    Notes: String(value.localFields.Notes || ""),
  };
  writeTicketDraft(value.ticketId, "work", {
    revision: value.revision,
    baseValue,
    value: { ...baseValue, Notes: notes },
  });
}

describe("DraftsModal", () => {
  beforeEach(() => {
    localStorage.clear();
    api.getTicket.mockReset();
    api.saveTicketDraftBatch.mockReset();
  });

  it("lists selected SRs and saves them in one confirmed batch", async () => {
    const first = ticket("12345678");
    const second = ticket("87654321");
    protectWorkDraft(first, "First protected note");
    protectWorkDraft(second, "Second protected note");
    api.getTicket.mockImplementation(async (ticketId: string) => ticketId === first.ticketId ? first : second);
    api.saveTicketDraftBatch.mockResolvedValue({
      changed: true,
      ticketIds: [first.ticketId, second.ticketId],
      results: [],
      tickets: { [first.ticketId]: first, [second.ticketId]: second },
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<DraftsModal onClose={vi.fn()} onReview={vi.fn()} onSaved={onSaved} onError={vi.fn()} onNotice={vi.fn()} />);

    expect(await screen.findByText("SR 12345678")).toBeVisible();
    expect(screen.getByText("SR 87654321")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save selected to Zeus" }));
    expect(screen.getByText("Save 2 selected SRs to Zeus?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm save to Zeus" }));

    await waitFor(() => expect(api.saveTicketDraftBatch).toHaveBeenCalledTimes(1));
    expect(api.saveTicketDraftBatch.mock.calls[0][0]).toEqual([
      expect.objectContaining({ ticketId: "12345678", changes: { Notes: "First protected note" } }),
      expect.objectContaining({ ticketId: "87654321", changes: { Notes: "Second protected note" } }),
    ]);
    await waitFor(() => expect(countUnsavedDrafts()).toBe(0));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("requires explicit restoration when the same database field changed", async () => {
    const current = ticket("12345678", "Database note", "new-revision");
    writeTicketDraft(current.ticketId, "work", {
      revision: "old-revision",
      baseValue: {
        "Planned Date": "", Site: "GYE", Cloud: "", RelatedSR: "", "Done?": "N", Notes: "Old note",
      },
      value: {
        "Planned Date": "", Site: "GYE", Cloud: "", RelatedSR: "", "Done?": "N", Notes: "Protected note",
      },
    });
    api.getTicket.mockResolvedValue(current);
    const user = userEvent.setup();
    render(<DraftsModal onClose={vi.fn()} onReview={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />);

    expect(await screen.findByText(/Restore required · Notes/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save selected to Zeus" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Restore selected changes" }));
    expect(screen.getByText("Restore 1 selected draft?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm restore" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save selected to Zeus" })).toBeEnabled());
    expect(screen.getByText("Ready to save")).toBeVisible();
    expect(countUnsavedDrafts()).toBe(1);
  });
});
