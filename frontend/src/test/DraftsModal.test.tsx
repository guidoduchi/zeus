import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsModal } from "../components/DraftsModal";
import { clearDraftUndo, countUnsavedDrafts, getDraftUndo, writeTicketDraft } from "../drafts";
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
    clearDraftUndo();
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
    await user.click(screen.getByRole("button", { name: "Save Selected" }));
    expect(screen.getByText("Save 2 selected SRs to Zeus?")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm save to Zeus" }));

    await waitFor(() => expect(api.saveTicketDraftBatch).toHaveBeenCalledTimes(1));
    expect(api.saveTicketDraftBatch.mock.calls[0][0]).toEqual([
      expect.objectContaining({ ticketId: "12345678", changes: { Notes: "First protected note" } }),
      expect.objectContaining({ ticketId: "87654321", changes: { Notes: "Second protected note" } }),
    ]);
    await waitFor(() => expect(countUnsavedDrafts()).toBe(0));
    expect(getDraftUndo()).toEqual(expect.objectContaining({
      action: "save",
      ticketCount: 2,
      records: expect.arrayContaining([
        expect.objectContaining({ ticketId: "12345678", kind: "work" }),
        expect.objectContaining({ ticketId: "87654321", kind: "work" }),
      ]),
    }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("keeps the last discarded selection available for one-level undo", async () => {
    const current = ticket("12345678");
    protectWorkDraft(current, "Protected note");
    api.getTicket.mockResolvedValue(current);
    const user = userEvent.setup();
    render(<DraftsModal onClose={vi.fn()} onReview={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />);

    expect(await screen.findByText("SR 12345678")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Discard selected" }));
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));

    await waitFor(() => expect(countUnsavedDrafts()).toBe(0));
    expect(getDraftUndo()).toEqual(expect.objectContaining({
      action: "discard",
      ticketCount: 1,
      inverseEdits: [],
      records: [expect.objectContaining({ ticketId: "12345678", kind: "work" })],
    }));
  });

  it("requires review when the same database field changed", async () => {
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
    const onReview = vi.fn();
    render(<DraftsModal onClose={vi.fn()} onReview={onReview} onSaved={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />);

    expect(await screen.findByText(/Review required · Notes/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Selected" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledWith("12345678", "work");
    expect(countUnsavedDrafts()).toBe(1);
  });
});
