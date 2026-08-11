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
  spareBadges: { pendingDispatch: 0, dispatched: 0, overdue: 0, returned: 0 },
  summary: "A compact detail",
  customerOrganization: "Customer Org",
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

    expect(screen.getByRole("button", { name: /add affected device/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Spare Parts/ })).toHaveClass("active");
  });

  it("offers one request-creation entry point for saved Spare Parts", async () => {
    const user = userEvent.setup();
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
        onRegisterSpareRequest={onRegisterSpareRequest}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create Request" }));
    expect(onRegisterSpareRequest).toHaveBeenCalledWith("12345678");
    expect(screen.queryByRole("button", { name: "Export Request" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Request" })).toHaveClass("create-button");
    expect(styles).toMatch(/\.edit-actions, \.edit-actions > \.inline-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  });

  it("presents one Maintenance Window editor with date-first semantics", async () => {
    const user = userEvent.setup();
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);

    expect(screen.getByText("Maintenance Window")).toBeVisible();
    expect(screen.getByText("Unplanned")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    expect(screen.getByLabelText("MW date")).toHaveValue("");
    expect(screen.getByLabelText("Optional start time")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("MW date"), { target: { value: "2099-08-20" } });
    expect(screen.getByLabelText("Optional start time")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Optional start time"), { target: { value: "22:30" } });
    expect(screen.getByLabelText("Optional start time")).toHaveValue("22:30");
    const visibility = screen.getByRole("button", { name: "MW is visible" });
    expect(visibility).toHaveAttribute("aria-pressed", "false");
    expect(visibility.querySelector(".mw-visibility-icon")).not.toBeNull();
    expect(visibility.querySelector(".mw-visibility-slash")).toBeNull();
    await user.click(visibility);
    expect(visibility).toHaveAttribute("aria-pressed", "true");
    expect(visibility).toHaveAccessibleName("MW is not visible");
    expect(visibility.querySelector(".mw-visibility-slash")).not.toBeNull();
    expect(styles).toMatch(/\.maintenance-window-editor > \.section-heading\s*\{[^}]*padding:\s*8px 12px 6px/s);
    expect(styles).toMatch(/\.mw-visibility-toggle\s*\{[^}]*width:\s*34px[^}]*height:\s*31px/s);
    const mw = screen.getByRole("region", { name: "Maintenance Window (MW)" });
    const site = screen.getByRole("region", { name: "Site information" });
    const devices = screen.getByText("Affected / intervened devices").closest("section")!;
    expect(mw.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(site.compareDocumentPosition(devices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Notes")).toHaveAttribute("rows", "2");
  });

  it("confirms an overdue MW from the fixed action row and starts a new archived cycle", async () => {
    const user = userEvent.setup();
    const onConfirmMaintenanceWindow = vi.fn().mockResolvedValue(undefined);
    const onSave = vi.fn().mockResolvedValue(undefined);
    const overdue: TicketDetailType = {
      ...detail,
      done: "N",
      maintenanceWindow: {
        schemaVersion: 1,
        status: "incomplete",
        date: "2000-01-01",
        display: "2000-01-01",
        color: "red",
        confirmationRequired: true,
        attempts: [],
        reviewRequired: false,
      },
      localFields: { ...detail.localFields, "Done?": "N", "Planned Date": "2000-01-01" },
    };
    const view = render(<TicketDetail ticket={overdue} loading={false} initialTab="work" templates={[]} onClose={vi.fn()} onSave={onSave} onConfirmMaintenanceWindow={onConfirmMaintenanceWindow} onGenerateMop={vi.fn()} />);

    expect(screen.getByText("Incomplete")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Completed" }));
    expect(screen.getByRole("dialog", { name: /complete sr 12345678 maintenance window/i })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Optional finish time"), { target: { value: "00:30" } });
    await user.click(screen.getByRole("button", { name: "Confirm Completed" }));
    expect(onConfirmMaintenanceWindow).toHaveBeenCalledWith("12345678", "revision", "2000-01-01", "00:30");

    const completed: TicketDetailType = {
      ...overdue,
      revision: "revision-completed",
      done: "Y",
      maintenanceWindow: { ...overdue.maintenanceWindow!, status: "completed", display: "Complete", color: "green", confirmationRequired: false },
      localFields: { ...overdue.localFields, "Done?": "Y" },
    };
    view.rerender(<TicketDetail ticket={completed} loading={false} initialTab="work" templates={[]} onClose={vi.fn()} onSave={onSave} onConfirmMaintenanceWindow={onConfirmMaintenanceWindow} onGenerateMop={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "New MW" }));
    expect(onSave).toHaveBeenCalledWith("12345678", "revision-completed", { "Planned Date": null, "Done?": "N" });
  });

  it("routes a shared MW to Upcoming instead of allowing a partial SR edit", async () => {
    const user = userEvent.setup();
    const onOpenUpcoming = vi.fn();
    const shared: TicketDetailType = {
      ...detail,
      maintenanceWindow: {
        schemaVersion: 1,
        status: "incomplete",
        date: "2000-01-01",
        startTime: "23:30",
        windowId: "MW-260811120000-ABCD",
        managedInUpcoming: true,
        display: "2000-01-01",
        color: "red",
        confirmationRequired: true,
        attempts: [],
        reviewRequired: false,
      },
      localFields: { ...detail.localFields, "Done?": "N", "Planned Date": "2000-01-01" },
    };
    render(<TicketDetail ticket={shared} loading={false} initialTab="work" templates={[]} onClose={vi.fn()} onSave={vi.fn()} onConfirmMaintenanceWindow={vi.fn()} onOpenUpcoming={onOpenUpcoming} onGenerateMop={vi.fn()} />);

    expect(screen.getByLabelText("MW date")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Completed" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open Upcoming" }));
    expect(onOpenUpcoming).toHaveBeenCalledTimes(1);
  });

  it("keeps raw detail History hidden unless the developer setting enables it", () => {
    const props = { ticket: detail, loading: false, templates: [], onClose: vi.fn(), onSave: vi.fn(), onGenerateMop: vi.fn() };
    const view = render(<TicketDetail {...props} />);
    expect(screen.queryByRole("button", { name: /History/ })).not.toBeInTheDocument();
    view.rerender(<TicketDetail {...props} showHistory />);
    expect(screen.getByRole("button", { name: /History/ })).toBeVisible();
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

  it("distinguishes sent and received email rows with restrained directional accents", async () => {
    const user = userEvent.setup();
    const sent = {
      ...detail.email.messages[0],
      messageKey: "message-2",
      timestamp: "2026-08-04",
      direction: "sent",
      subject: "Sent follow-up",
    };
    const withDirections: TicketDetailType = {
      ...detail,
      email: { ...detail.email, messages: [detail.email.messages[0], sent] },
    };
    render(<TicketDetail ticket={withDirections} loading={false} templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /emails/i }));

    expect(screen.getByRole("option", { name: /received/i })).toHaveClass("direction-received");
    expect(screen.getByRole("option", { name: /sent follow-up/i })).toHaveClass("direction-sent");
    expect(styles).toMatch(/\.email-list button\.direction-received\s*\{[^}]*inset 3px 0 var\(--green\)/s);
    expect(styles).toMatch(/\.email-list button\.direction-sent\s*\{[^}]*inset 3px 0 var\(--cyan\)/s);
    expect(styles).toMatch(/\.email-list button\.direction-received:not\(\.selected\):not\(:hover\)\s*\{[^}]*linear-gradient/s);
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
    expect(screen.queryByRole("button", { name: /Restore (work )?changes/ })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: /Restore (work )?changes/ })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Restore work changes" }));
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

    const planned = screen.getByLabelText("MW date");
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

  it("turns an incomplete MW back into a dated plan without losing its shown history", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const incomplete: TicketDetailType = {
      ...detail,
      done: "P",
      maintenanceWindow: {
        schemaVersion: 1,
        status: "incomplete",
        date: null,
        display: "Incomplete",
        color: "yellow",
        confirmationRequired: false,
        attempts: [{ date: "2026-08-08", outcome: "incomplete", confirmed_at: "2026-08-09T00:00:00Z", source: "manual" }],
        reviewRequired: false,
      },
      localFields: { ...detail.localFields, "Done?": "P", "Planned Date": null },
    };
    render(<TicketDetail ticket={incomplete} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} initialTab="work" />);

    expect(screen.getByText("Unplanned")).toBeVisible();
    expect(screen.getByText("2026-08-08 · Incomplete")).toBeVisible();
    fireEvent.change(screen.getByLabelText("MW date"), { target: { value: "2026-08-21" } });
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Planned Date": "2026-08-21",
      "Done?": "N",
    });
  });

  it("edits multiple devices and multiple damaged parts as one hierarchy", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /spare parts/i }));

    expect(screen.queryByLabelText("Spare")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add affected device/i }));
    await user.type(screen.getByLabelText("Device 1 name"), "server-a");
    await user.type(screen.getByLabelText("Device 1 model"), "2288H V5");
    await user.type(screen.getByLabelText("Device 1 faulty serial numbers"), "OLD-1{enter}OLD-2");
    await user.click(screen.getByRole("button", { name: /add new spare part/i }));
    await user.type(screen.getByLabelText("Device 1 part 1 Slots"), "DIMM101{enter}DIMM203{enter}DIMM103");
    await user.type(screen.getByLabelText("Device 1 part 1 Part"), "Disk");
    await user.type(screen.getByLabelText("Device 1 part 1 BOM (part number)"), "BOM-1");
    await user.type(screen.getByLabelText("Device 1 part 1 Notes"), "Diagnostics completed");
    await user.click(screen.getByRole("button", { name: /add new spare part/i }));
    await user.type(screen.getByLabelText("Device 1 part 2 Slots"), "Slot 2");
    await user.type(screen.getByLabelText("Device 1 part 2 BOM (part number)"), "BOM-2");
    await user.click(screen.getByRole("button", { name: /add affected device/i }));
    await user.type(screen.getByLabelText("Device 2 name"), "server-b");
    await user.click(screen.getAllByRole("button", { name: /add new spare part/i })[1]);
    await user.type(screen.getByLabelText("Device 2 part 1 Part"), "Memory");
    await user.type(screen.getByLabelText("Device 2 part 1 BOM (part number)"), "BOM-3");
    expect(screen.queryByLabelText(/New SN/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Spare Parts": [
        {
          device_number: 1,
          device: "server-a",
          model: "2288H V5",
          notes: null,
          faulty_sns: ["OLD-1", "OLD-2"],
          next_part_number: 3,
          parts: [
            { part_number: 1, slot: "DIMM101\nDIMM203\nDIMM103", part: "Disk", bom: "BOM-1", notes: "Diagnostics completed", new_sn: null, submitted_request_ids: [] },
            { part_number: 2, slot: "Slot 2", part: null, bom: "BOM-2", notes: null, new_sn: null, submitted_request_ids: [] },
          ],
        },
        {
          device_number: 2,
          device: "server-b",
          model: null,
          notes: null,
          faulty_sns: [],
          next_part_number: 2,
          parts: [{ part_number: 1, slot: null, part: "Memory", bom: "BOM-3", notes: null, new_sn: null, submitted_request_ids: [] }],
        },
      ],
    });
  });

  it("registers an affected device in Work Fields without fabricating a spare part", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} initialTab="work" templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);

    await user.type(screen.getByLabelText(/Device names · one per line/), "server-no-bom");
    await user.type(screen.getByLabelText("Shared model"), "FusionServer");
    await user.type(screen.getByLabelText("Shared intervention notes"), "Firmware checks only");
    await user.click(screen.getByRole("button", { name: "Add independent device cards" }));
    expect(screen.queryByText("Spare parts involved")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/BOM/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save to zeus/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Spare Parts": [{
        device_number: 1,
        device: "server-no-bom",
        model: "FusionServer",
        notes: "Firmware checks only",
        faulty_sns: [],
        next_part_number: 1,
        parts: [],
      }],
    });
  });

  it("shares one affected-device draft between Work Fields and Spare Parts", async () => {
    const user = userEvent.setup();
    render(<TicketDetail ticket={detail} loading={false} initialTab="work" templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);

    await user.type(screen.getByLabelText(/Device names · one per line/), "shared-server");
    await user.type(screen.getByLabelText("Shared model"), "2288H V5");
    await user.click(screen.getByRole("button", { name: "Add independent device cards" }));
    await user.click(screen.getByRole("button", { name: /^Spare Parts/ }));

    expect(screen.getByLabelText("Device 1 name")).toHaveValue("shared-server");
    expect(screen.getByLabelText("Device 1 model")).toHaveValue("2288H V5");
    expect(screen.queryByLabelText("Device 1 part 1 BOM (part number)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /add new spare part/i }));
    await user.type(screen.getByLabelText("Device 1 part 1 BOM (part number)"), "BOM-SHARED");
    await user.click(screen.getByRole("button", { name: /work fields/i }));

    expect(screen.getByLabelText("Device")).toHaveValue("shared-server");
    expect(screen.getByText("Spare parts involved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove device" })).toBeDisabled();
  });

  it("separates submitted parts, locks their fields, and permits a new record", async () => {
    const user = userEvent.setup();
    const submitted: TicketDetailType = {
      ...detail,
      spareParts: [{
        device_number: 1,
        device: "server-a",
        model: "2288H V5",
        notes: null,
        faulty_sns: ["FAULTY-1"],
        next_part_number: 2,
        active_request_ids: ["260810123456"],
        has_submitted_parts: true,
        parts: [{
          part_number: 1,
          slot: "Slot 1",
          part: "Disk",
          bom: "BOM-1",
          notes: null,
          new_sn: null,
          submitted_request_ids: ["260810123456"],
          submitted: true,
          active_request_ids: ["260810123456"],
        }],
      }],
    };
    render(<TicketDetail ticket={submitted} loading={false} initialTab="spares" templates={[]} onClose={vi.fn()} onSave={vi.fn()} onGenerateMop={vi.fn()} />);

    expect(screen.getByText("Submitted parts")).toBeVisible();
    expect(screen.getByLabelText("Device 1 part 1 BOM (part number)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete submitted part" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /add new spare part/i }));
    expect(screen.getByText("New part 2")).toBeVisible();
    expect(screen.getByLabelText("Device 1 part 2 BOM (part number)")).toBeEnabled();
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
      showHistory: true,
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
