import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketDetail } from "../components/TicketDetail";
import { countUnsavedDrafts, writeTicketDraft } from "../drafts";
import type { TicketDetail as TicketDetailType } from "../types";
import styles from "../styles.css?raw";

const detail: TicketDetailType = {
  ticketId: "12345678",
  revision: "revision",
  lifecycle: "active",
  done: "N",
  plannedDate: "Unplanned",
  plannedDays: null,
  plannedState: "unplanned",
  plannedColor: "yellow",
  ticketAgeDays: 10,
  ticketAgeColor: null,
  emailInactivityDays: 2,
  emailLabel: "2 days",
  emailCount: 1,
  emailColor: null,
  lastEmailDirection: "received",
  received: 1,
  sent: 0,
  summary: "A compact detail",
  customerContact: "Customer Contact",
  severity: "Minor",
  product: "Product",
  handler: "Handler",
  status: "Working",
  resolveBy: "2026-08-20",
  resolveDays: 13,
  site: "GYE",
  cloud: "Cloud",
  model: "Model",
  device: "Device",
  risk: "none",
  upstreamFields: { "Problem Summary": "A compact detail", "Customer Severity": "Minor" },
  localFields: { "Planned Date": null, Site: "GYE", Cloud: null, Model: null, Device: null, Slot: null, Part: null, BOM: null, "Old SN": null, "New SN": null, RelatedSR: null, Notes: "", Spare: null, "Done?": "N" },
  spareParts: [],
  email: {
    totalReceived: 1,
    totalSent: 0,
    lastActivityAt: "2026-08-05",
    lastFetchedAt: "2026-08-06",
    lastSynchronizedAt: "2026-08-06",
    messages: [{
      messageKey: "message-1",
      timestamp: "2026-08-05",
      direction: "received",
      subject: "<script>alert('subject')</script>",
      sender: "sender@example.invalid",
      body: "<img src=x onerror=alert(1)> full history",
      latestReplyBody: "<b>new reply</b>",
      quotedHistoryHidden: true,
      quotedHistoryLines: 10,
    }],
  },
  mop: { latest: null, versions: 0 },
  lifecycleDetails: { status: "active" },
  updatedAt: "2026-08-06",
  history: [],
  mops: [],
  readOnly: false,
  source: "current",
};

describe("TicketDetail", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());
  it("opens directly in the Spare Parts editor from that management view", () => {
    render(
      <TicketDetail
        ticket={detail}
        loading={false}
        initialTab="spares"
        templates={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onGenerateMop={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /add damaged device/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Spare Parts/ })).toHaveClass("active");
  });

  it("offers manual registration beside export for saved Spare Parts", async () => {
    const user = userEvent.setup();
    const onExportSpareRequest = vi.fn();
    const onRegisterSpareRequest = vi.fn();
    const withPart: TicketDetailType = {
      ...detail,
      spareParts: [{
        device: "server-a",
        model: "2288H V5",
        faulty_sns: ["FAULTY-1"],
        parts: [{ slot: "Slot 1", part: "Disk", bom: "BOM-1", notes: null, new_sn: null }],
      }],
    };
    render(
      <TicketDetail
        ticket={withPart}
        loading={false}
        initialTab="spares"
        templates={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onGenerateMop={vi.fn()}
        onExportSpareRequest={onExportSpareRequest}
        onRegisterSpareRequest={onRegisterSpareRequest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Already sent manually" }));
    expect(onRegisterSpareRequest).toHaveBeenCalledWith("12345678");
    expect(screen.getByRole("button", { name: "Export Spare Request" })).toBeEnabled();
    expect(styles).toMatch(/\.edit-actions, \.edit-actions > \.inline-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  });

  it("presents Maintenance Window codes with their operational meanings", async () => {
    const user = userEvent.setup();
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);

    expect(screen.getByText("Maintenance Window")).toBeVisible();
    expect(screen.getByText("Pending")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    const mw = screen.getByLabelText("Maintenance Window (MW)");
    expect(mw).toHaveValue("N");
    expect(screen.getByRole("option", { name: "Y — Done" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "N — Pending" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /P — Uncompleted.*follow-up pending/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "? — N/A" })).toBeInTheDocument();
  });

  it("renders email content as escaped plain text and toggles full history", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /emails/i }));
    expect(container.querySelector(".detail-scroll")).toHaveClass("email-detail-scroll");
    expect(styles).toMatch(/\.detail-scroll\.email-detail-scroll\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.email-layout\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.email-reader\s*\{[^}]*overflow:\s*hidden/s);
    expect(screen.getByText("<b>new reply</b>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: /full thread/i }));
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> full history/)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("saves only changed database-owned fields", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    const notes = screen.getByLabelText("Notes");
    await user.type(notes, "Web note");
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));
    expect(onSave).toHaveBeenCalledWith("12345678", "revision", { Notes: "Web note" });
  });

  it("does not reinterpret its own successful save as a stale protected draft", async () => {
    const user = userEvent.setup();
    const saved = {
      ...detail,
      revision: "revision-after-save",
      localFields: { ...detail.localFields, Notes: "Race-safe note" },
    };
    const props = {
      loading: false,
      templates: [],
      onClose: vi.fn(),
      onGenerateMop: vi.fn(),
    };
    let rerender: ReturnType<typeof render>["rerender"];
    const onSave = vi.fn(async () => {
      rerender(<TicketDetail ticket={saved} onSave={onSave} {...props} />);
    });
    ({ rerender } = render(<TicketDetail ticket={detail} onSave={onSave} {...props} />));
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    await user.type(screen.getByLabelText("Notes"), "Race-safe note");
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    await waitFor(() => expect(screen.getByText("No unsaved changes")).toBeVisible());
    expect(screen.queryByRole("button", { name: "Restore changes" })).not.toBeInTheDocument();
    expect(countUnsavedDrafts()).toBe(0);
  });

  it("clears a legacy stuck draft when Zeus already contains every protected value", async () => {
    const current = {
      ...detail,
      revision: "revision-after-earlier-save",
      localFields: { ...detail.localFields, Notes: "Already saved note" },
    };
    const baseValue = {
      "Planned Date": "", Site: "GYE", Cloud: "", RelatedSR: "", "Done?": "N", Notes: "",
    };
    writeTicketDraft(detail.ticketId, "work", {
      revision: "revision-before-earlier-save",
      baseValue,
      value: { ...baseValue, Notes: "Already saved note" },
    });

    render(<TicketDetail ticket={current} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} initialTab="work" />);

    await waitFor(() => expect(screen.getByText("No unsaved changes")).toBeVisible());
    expect(screen.queryByRole("button", { name: "Restore changes" })).not.toBeInTheDocument();
    expect(countUnsavedDrafts()).toBe(0);
  });

  it("labels genuine overlapping conflicts as restore-before-save", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("Native browser confirmations are forbidden");
    });
    const current = {
      ...detail,
      revision: "new-revision",
      localFields: { ...detail.localFields, Notes: "Database note" },
    };
    const baseValue = {
      "Planned Date": "", Site: "GYE", Cloud: "", RelatedSR: "", "Done?": "N", Notes: "Old note",
    };
    writeTicketDraft(detail.ticketId, "work", {
      revision: "old-revision",
      baseValue,
      value: { ...baseValue, Notes: "Protected note" },
    });
    const user = userEvent.setup();
    render(<TicketDetail ticket={current} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} initialTab="work" />);

    expect(await screen.findByText(/same database work fields changed/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save to Zeus" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Restore changes" }));
    expect(screen.getByRole("dialog", { name: "Restore protected SR 12345678 changes?" })).toBeVisible();
    expect(nativeConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restore for review" }));
    expect(screen.queryByText(/same database work fields changed/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to Zeus" })).toBeEnabled();
    expect(screen.getByLabelText("Notes")).toHaveValue("Protected note");
  });

  it("uses a calendar date without exposing the export-only Spare field", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));

    const planned = screen.getByLabelText("Planned Date");
    expect(planned).toHaveAttribute("type", "date");
    expect(planned).toHaveValue("");
    expect(screen.queryByLabelText("Spare")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("BOM")).not.toBeInTheDocument();
    fireEvent.change(planned, { target: { value: "2026-08-21" } });
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Planned Date": "2026-08-21",
    });
    expect(onSave.mock.calls[0][2]).not.toHaveProperty("Spare");
  });

  it("edits multiple devices and multiple damaged parts as one hierarchy", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /spare parts/i }));

    expect(screen.queryByLabelText("Spare")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add damaged device/i }));
    await user.type(screen.getByLabelText("Device 1 name"), "server-a");
    await user.type(screen.getByLabelText("Device 1 model"), "2288H V5");
    await user.type(screen.getByLabelText("Device 1 faulty serial numbers"), "OLD-1{enter}OLD-2");
    await user.type(screen.getByLabelText("Device 1 part 1 Slots"), "DIMM101{enter}DIMM203{enter}DIMM103");
    await user.type(screen.getByLabelText("Device 1 part 1 Part"), "Disk");
    await user.type(screen.getByLabelText("Device 1 part 1 BOM (part number)"), "BOM-1");
    await user.type(screen.getByLabelText("Device 1 part 1 Notes"), "Diagnostics completed");
    await user.click(screen.getByRole("button", { name: /add damaged part/i }));
    await user.type(screen.getByLabelText("Device 1 part 2 Slots"), "Slot 2");
    await user.type(screen.getByLabelText("Device 1 part 2 BOM (part number)"), "BOM-2");
    await user.click(screen.getByRole("button", { name: /add damaged device/i }));
    await user.type(screen.getByLabelText("Device 2 name"), "server-b");
    await user.type(screen.getByLabelText("Device 2 part 1 Part"), "Memory");
    await user.type(screen.getByLabelText("Device 2 part 1 BOM (part number)"), "BOM-3");
    expect(screen.queryByLabelText(/New SN/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Spare Parts": [
        {
          device: "server-a",
          model: "2288H V5",
          faulty_sns: ["OLD-1", "OLD-2"],
          parts: [
            { slot: "DIMM101\nDIMM203\nDIMM103", part: "Disk", bom: "BOM-1", notes: "Diagnostics completed", new_sn: null },
            { slot: "Slot 2", part: null, bom: "BOM-2", notes: null, new_sn: null },
          ],
        },
        {
          device: "server-b",
          model: null,
          faulty_sns: [],
          parts: [{ slot: null, part: "Memory", bom: "BOM-3", notes: null, new_sn: null }],
        },
      ],
    });
  });

  it("keeps edit actions in a fixed row outside the scrolling fields", async () => {
    const user = userEvent.setup();
    const { container } = render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    expect(container.querySelector(".detail-scroll")).toHaveClass("bounded-edit-scroll");
    expect(container.querySelector(".edit-actions")?.parentElement).toHaveClass("bounded-edit-tab");
    expect(styles).toMatch(/\.bounded-edit-tab\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto[^}]*overflow:\s*hidden/s);
    expect(styles).toMatch(/\.detail-scroll\.bounded-edit-scroll\s*\{[^}]*overflow:\s*hidden/s);
    expect(styles).not.toMatch(/\.sticky-actions/);
  });

  it("protects a Work Fields draft while moving between sorted rows", async () => {
    const user = userEvent.setup();
    const second = {
      ...detail,
      ticketId: "87654321",
      revision: "revision-2",
      summary: "Second row",
      localFields: { ...detail.localFields, Notes: "Second note" },
    };
    const props = {
      loading: false,
      templates: [],
      onClose: vi.fn(),
      onSave: vi.fn(),
      onGenerateMop: vi.fn(),
    };
    const { rerender } = render(<TicketDetail ticket={detail} {...props} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    await user.type(screen.getByLabelText("Notes"), "Protected note");

    rerender(<TicketDetail ticket={second} {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveValue("Second note"));
    expect(screen.getByRole("button", { name: /work fields/i })).toHaveClass("active");

    rerender(<TicketDetail ticket={detail} {...props} />);
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveValue("Protected note"));
    expect(screen.getByText(/unsaved field\(s\) · draft protected/i)).toBeVisible();
  });

  it("restores protected drafts after a remount and bounds detail-tab arrows", async () => {
    const user = userEvent.setup();
    const props = {
      ticket: detail,
      loading: false,
      templates: [],
      onClose: vi.fn(),
      onSave: vi.fn(),
      onGenerateMop: vi.fn(),
    };
    const first = render(<TicketDetail {...props} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /work fields/i })).toHaveClass("active");
    await waitFor(() => expect(screen.getByRole("button", { name: /work fields/i })).toHaveFocus());
    await user.type(screen.getByLabelText("Notes"), "Reload-safe note");
    fireEvent.keyDown(screen.getByLabelText("Notes"), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /work fields/i })).toHaveClass("active");
    first.unmount();

    render(<TicketDetail {...props} initialTab="work" />);
    expect(screen.getByLabelText("Notes")).toHaveValue("Reload-safe note");
    await user.click(screen.getByRole("button", { name: /history/i }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /history/i })).toHaveClass("active");
    await waitFor(() => expect(screen.getByRole("button", { name: /history/i })).toHaveFocus());
  });

  it("shows finalized spare parts under their SR without edit controls", () => {
    const archived: TicketDetailType = {
      ...detail,
      lifecycle: "closed",
      readOnly: true,
      source: "closed",
      spareParts: [{
        device: "server-closed",
        model: "2288H V5",
        parts: [{
          slot: "Slot 3",
          part: "Disk",
          bom: "BOM-CLOSED",
          faulty_sn: "FAULTY-CLOSED",
          new_sn: null,
        }],
      }],
    };
    render(
      <TicketDetail
        ticket={archived}
        loading={false}
        initialTab="spares"
        templates={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onGenerateMop={vi.fn()}
      />,
    );

    expect(screen.getByText("Closed · read-only")).toBeVisible();
    expect(screen.getByText(/remain assigned to this SR/i)).toBeVisible();
    expect(screen.getByLabelText("Device 1 part 1 BOM (part number)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save to Zeus/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add damaged part/ })).not.toBeInTheDocument();
  });
});
