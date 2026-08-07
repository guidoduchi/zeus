import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TicketDetail } from "../components/TicketDetail";
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
  emailColor: null,
  lastEmailDirection: "received",
  received: 1,
  sent: 0,
  summary: "A compact detail",
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
};

describe("TicketDetail", () => {
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

  it("saves only changed Pendings-owned fields", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));
    const notes = screen.getByLabelText("Notes");
    await user.type(notes, "Web note");
    await user.click(screen.getByRole("button", { name: /save through pendings/i }));
    expect(onSave).toHaveBeenCalledWith("12345678", "revision", { Notes: "Web note" });
  });

  it("uses a calendar date and derives a read-only Spare tag from BOM", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TicketDetail ticket={detail} loading={false} templates={[]} onClose={vi.fn()} onSave={onSave} onGenerateMop={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /work fields/i }));

    const planned = screen.getByLabelText("Planned Date");
    const bom = screen.getByLabelText("BOM");
    const spare = screen.getByLabelText("Spare");
    expect(planned).toHaveAttribute("type", "date");
    expect(planned).toHaveValue("");
    expect(spare).toHaveAttribute("readonly");
    expect(spare).toHaveValue("N");

    await user.type(bom, "BOM-9000");
    expect(spare).toHaveValue("Y");
    await user.clear(bom);
    expect(spare).toHaveValue("N");
    await user.type(bom, "BOM-9000");
    fireEvent.change(planned, { target: { value: "2026-08-21" } });
    await user.click(screen.getByRole("button", { name: /save through pendings/i }));

    expect(onSave).toHaveBeenCalledWith("12345678", "revision", {
      "Planned Date": "2026-08-21",
      BOM: "BOM-9000",
    });
    expect(onSave.mock.calls[0][2]).not.toHaveProperty("Spare");
  });
});
