import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpareRequestDetail as Detail } from "../types";

const apiMocks = vi.hoisted(() => ({
  advanceSpareRequestStage: vi.fn(),
  archiveSpareItems: vi.fn(),
  deleteSpareRequest: vi.fn(),
  exportSpareReturn: vi.fn(),
  getSpareRequest: vi.fn(),
  reexportSpareRequest: vi.fn(),
  resolveSpareConflict: vi.fn(),
  saveSpareRequest: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

import { SpareRequestDetail } from "../components/SpareRequestDetail";

const labels = [
  "Added to Zeus",
  "Request email sent",
  "SR and RMA confirmed",
  "Spare parts dispatched",
  "Spare replaced",
  "Warehouse evidence received",
  "Complete",
];

function detail(stage = 0, confirmed = false): Detail {
  const requestId = "260810123456";
  const itemId = `${requestId}-0001`;
  const spareSr = confirmed ? "SR4956964" : null;
  return {
    requestId,
    revision: `revision-${stage}-${confirmed}`,
    ticketId: "39416095",
    reportDate: "2026-07-01",
    ttEditable: false,
    source: "ticket",
    creationMethod: "zeus_export",
    spareSr,
    trackingId: spareSr || requestId,
    trackingIdProvisional: !spareSr,
    requestSentAt: stage >= 1 ? "2026-08-10T12:01:00-05:00" : null,
    canDelete: stage < 2,
    status: stage >= 2 ? "awaiting_dispatch" : "awaiting_confirmation",
    profile: {
      client_initials: "CNT",
      customer_name: "Customer Network Team",
      customer_organization: "Customer Network Team",
      site_code: "UIO1",
      site_name: "Quito",
      site_address: "Address",
      cloud: "Ecuador Cloud",
      requester: { name: "Zeus User", email: "user@example.com", phone: null },
      contact: { name: "Customer Contact", email: "contact@example.com", phone: "+593" },
    },
    requestLines: [{
      bom: "02312RCC",
      amount: 1,
      description: "Controller board",
      part: "Controller board",
      model: "S6730",
      device: "SW-UIO-01",
      slot: "1/0/1",
      slots: ["1/0/1"],
      faulty_sn: "FAULTY-1",
      faulty_sns: ["FAULTY-1"],
      report_date: "2026-07-01",
      source_device_number: 1,
      source_part_number: 1,
    }],
    items: [{
      item_id: itemId,
      ordinal: 1,
      requested_bom: "02312RCC",
      requested_description: "Controller board",
      part: "Controller board",
      model: "S6730",
      device: "SW-UIO-01",
      slot: "1/0/1",
      faulty_sn: "FAULTY-1",
      faulty_sns: ["FAULTY-1"],
      rma: confirmed ? "C3209937826" : null,
      rma_aliases: [],
      delivered_bom: null,
      new_sn: null,
      dispatch_at: null,
      attendance_confirmed_at: confirmed ? "2026-08-10T12:02:00-05:00" : null,
      return_condition: null,
      return_export_filename: null,
      warehouse_candidate_at: null,
      rt: null,
      conflicts: [],
      status: stage >= 2 ? "awaiting_dispatch" : "awaiting_confirmation",
      statusLabel: stage >= 2 ? "Awaiting dispatch" : "Awaiting confirmation",
      lifecycleColor: stage >= 2 ? "grey" : "black",
      dispatchAgeDays: null,
      dispatchAgeColor: null,
      notes: null,
      lifecycle: {
        stage,
        label: labels[stage],
        timestamp: "2026-08-10T12:00:00-05:00",
        source: stage ? "manual" : "zeus",
        stages: labels.map((label, index) => ({
          stage: index,
          label,
          reached: index <= stage,
          timestamp: index <= stage ? "2026-08-10T12:00:00-05:00" : null,
          source: index <= stage ? (index ? "manual" : "zeus") : null,
        })),
      },
    }],
    export: {
      request_filename: "request.xlsx",
      request_path: "C:\\Exports\\request.xlsx",
      subject: `[TT 39416095] [SPARE PARTS REQUEST] ${requestId}`,
      revisions: [],
      returns: [],
    },
    email: {
      total_received: 0,
      total_sent: 0,
      last_activity_at: null,
      messages: [],
      inactivityDays: null,
      label: "No email",
      count: 0,
    },
    conflicts: [],
    conflictCount: 0,
    history: [],
    createdAt: "2026-08-10T12:00:00-05:00",
    updatedAt: "2026-08-10T12:00:00-05:00",
  };
}

function props(request: Detail) {
  return {
    request,
    loading: false,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onNotice: vi.fn(),
    onLifecycle: vi.fn(),
    onFaultTag: vi.fn(),
  };
}

describe("SpareRequestDetail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the provisional tracking ID in red with all seven lifecycle stages", () => {
    const request = detail();
    render(<SpareRequestDetail {...props(request)} />);

    expect(screen.getByText(`TRACKING ${request.requestId}`)).toHaveClass("provisional-tracking");
    expect(screen.getByLabelText("Tracking ID")).toHaveClass("provisional-tracking-input");
    const lifecycle = screen.getByRole("list", { name: "Unit 1 lifecycle" });
    expect(within(lifecycle).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByText("Lifecycle · Added to Zeus")).toBeVisible();
    expect(screen.queryByText(/Stage \d|S\d/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm request email sent" })).toBeEnabled();
  });

  it("opens an Added to Zeus record created before detail collections existed", async () => {
    const user = userEvent.setup();
    const request = detail();
    request.creationMethod = "zeus_create";
    request.export.request_filename = null;
    request.export.request_path = null;
    delete (request.items[0] as { rma_aliases?: string[] }).rma_aliases;
    delete (request.email as { messages?: Array<Record<string, unknown>> }).messages;

    render(<SpareRequestDetail {...props(request)} />);

    expect(screen.getByText("Lifecycle · Added to Zeus")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm request email sent" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Emails/ }));
    expect(screen.getByText("No spare-related email retained for this request.")).toBeVisible();
  });

  it("enables SR and RMA confirmation from valid visible drafts without a separate save", async () => {
    const user = userEvent.setup();
    const request = detail(1);
    const handlers = props(request);
    render(<SpareRequestDetail {...handlers} />);

    await user.type(screen.getByLabelText("Spare SR"), "SR4956964");
    expect(screen.getByRole("button", { name: "Confirm SR and RMA" })).toBeDisabled();
    await user.type(screen.getByLabelText(/RMA · C \+ 10 digits/), "C3209937826");
    const confirm = screen.getByRole("button", { name: "Confirm SR and RMA" });
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(apiMocks.saveSpareRequest).not.toHaveBeenCalled();
    expect(handlers.onLifecycle).toHaveBeenCalledWith(
      request.items[0].item_id,
      "advance",
      { spareSr: "SR4956964", rma: "C3209937826", note: "" },
    );
  });

  it("offers Fault Tag export only at Spare replaced and keeps rollback contextual", async () => {
    const user = userEvent.setup();
    const request = detail(4, true);
    const handlers = props(request);
    render(<SpareRequestDetail {...handlers} />);
    expect(screen.queryByRole("button", { name: /Confirm spare/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fault Tag" }));
    expect(handlers.onFaultTag).toHaveBeenCalledWith(request.items[0].item_id);
    await user.click(screen.getByRole("button", { name: "Roll back last stage" }));
    expect(handlers.onLifecycle).toHaveBeenCalledWith(request.items[0].item_id, "rollback");
  });

  it("deletes an unconfirmed active request only after the explicit confirmation", async () => {
    const user = userEvent.setup();
    const request = detail();
    apiMocks.deleteSpareRequest.mockResolvedValue({
      deleted: request.requestId,
      exportPreserved: request.export.request_path,
    });
    const handlers = props(request);
    render(<SpareRequestDetail {...handlers} />);

    await user.click(screen.getByRole("button", { name: "Delete unconfirmed request" }));
    expect(screen.getByRole("dialog", { name: `Delete unconfirmed request ${request.requestId}?` })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete active request" }));

    await waitFor(() => expect(apiMocks.deleteSpareRequest).toHaveBeenCalledWith(request.requestId, request.revision));
    expect(handlers.onChanged).toHaveBeenCalledWith(null);
    expect(handlers.onNotice).toHaveBeenCalledWith(expect.stringContaining("exported XLSX was preserved"));
  });
});
