import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapPayload,
  ServiceRequestsDashboardPayload,
  SpareRequestDetail,
  SpareRequestItemSummary,
  SpareRequestsDashboardPayload,
  TicketDetail,
  TicketSummary,
} from "../types";

const apiMocks = vi.hoisted(() => ({
  cancelJob: vi.fn(),
  exportSpareRequest: vi.fn(),
  getBootstrap: vi.fn(),
  getDashboard: vi.fn(),
  getSpareRequest: vi.fn(),
  getTemplates: vi.fn(),
  getTicket: vi.fn(),
  purgeSpareArchive: vi.fn(),
  saveTicket: vi.fn(),
  saveUserProfile: vi.fn(),
  startJob: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  ...apiMocks,
}));

import App from "../App";

const bootstrap: BootstrapPayload = {
  version: "3.1.5",
  instanceId: "selection-focus-test",
  csrfToken: "test-token",
  localUrl: "http://127.0.0.1:8765",
  datasetRevision: 1,
  eventSequence: 0,
  startup: { warnings: [], notices: [], operations: {} },
  jobs: [],
  onboarding: { required: false, profile: null, error: null },
  storage: {
    currentPath: "C:\\Zeus",
    dataBytes: 0,
    freeBytes: 1_000_000,
    minimumFreeBytes: 1,
    lowSpace: false,
    migrationPending: false,
  },
  spareRequestExport: {
    requestReady: true,
    returnReady: true,
    requestMissing: [],
    returnMissing: [],
  },
  outlook: { enabled: false, configuredPathAvailable: false, stagedMessageCount: 0 },
  polling: { intervalMinutes: 15, enabled: true },
  appearance: { fontScale: "standard" },
};

function serviceSummary(ticketId: string): TicketSummary {
  return {
    ticketId,
    revision: `revision-${ticketId}`,
    lifecycle: "active",
    done: "N",
    plannedDate: "Unplanned",
    plannedDays: null,
    plannedState: "unplanned",
    plannedColor: "yellow",
    ticketAgeDays: 10,
    ticketAgeColor: null,
    emailInactivityDays: null,
    emailLabel: "No email",
    emailCount: 0,
    emailColor: "grey",
    lastEmailDirection: null,
    received: 0,
    sent: 0,
    summary: `Ticket ${ticketId}`,
    customerContact: `Customer ${ticketId}`,
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
    risk: "yellow",
  };
}

function serviceDetail(ticketId: string): TicketDetail {
  return {
    ...serviceSummary(ticketId),
    upstreamFields: { "Problem Summary": `Ticket ${ticketId}` },
    localFields: {
      "Planned Date": "",
      Site: "GYE",
      Cloud: "Cloud",
      RelatedSR: "",
      "Done?": "N",
      Notes: "",
    },
    spareParts: [],
    email: {
      totalReceived: 0,
      totalSent: 0,
      lastActivityAt: null,
      lastFetchedAt: null,
      lastSynchronizedAt: null,
      messages: [],
    },
    mop: {},
    lifecycleDetails: {},
    updatedAt: null,
    history: [],
    mops: [],
    readOnly: false,
    source: "current",
  };
}

function spareSummary(index: number): SpareRequestItemSummary {
  const requestId = `26080812345${index}`;
  return {
    rowId: `${requestId}-0001`,
    requestId,
    itemId: `${requestId}-0001`,
    ticketId: `3941609${index}`,
    rma: `C320993782${index}`,
    spareSr: `SR495696${index}`,
    status: "awaiting_dispatch",
    statusLabel: "Awaiting dispatch",
    lifecycleColor: "grey",
    dispatchAgeDays: index,
    dispatchAgeColor: null,
    emailInactivityDays: null,
    emailLabel: "No email",
    emailColor: "grey",
    emailCount: 0,
    requestedBom: `BOM-${index}`,
    deliveredBom: "",
    part: "Controller board",
    model: "S6730",
    device: `SW-${index}`,
    slot: `1/0/${index}`,
    faultySn: `FAULTY-${index}`,
    newSn: "",
    site: "UIO",
    cloud: "Cloud",
    conflictCount: 0,
    risk: "none",
    readOnly: false,
    source: "active",
  };
}

function spareDetail(row: SpareRequestItemSummary): SpareRequestDetail {
  return {
    requestId: row.requestId,
    revision: `revision-${row.requestId}`,
    ticketId: row.ticketId,
    ttEditable: false,
    source: "ticket",
    spareSr: row.spareSr,
    status: row.status,
    profile: {
      client_initials: "ZT",
      customer_name: "Customer",
      customer_organization: "Organization",
      site_code: row.site,
      site_name: row.site,
      site_address: "Address",
      cloud: row.cloud,
      requester: { name: "Requester", email: null, phone: null },
      contact: { name: "Contact", email: null, phone: null },
    },
    requestLines: [{
      bom: row.requestedBom,
      amount: 1,
      description: row.part,
      part: row.part,
      model: row.model,
      device: row.device,
      slot: row.slot,
      slots: [row.slot],
      faulty_sn: row.faultySn,
      faulty_sns: [row.faultySn],
      notes: null,
      report_date: null,
      source_device_number: 1,
      source_part_number: 1,
    }],
    items: [{
      item_id: row.itemId,
      ordinal: 1,
      requested_bom: row.requestedBom,
      requested_description: row.part,
      part: row.part,
      model: row.model,
      device: row.device,
      slot: row.slot,
      faulty_sn: row.faultySn,
      faulty_sns: [row.faultySn],
      rma: row.rma,
      delivered_bom: null,
      new_sn: null,
      dispatch_at: null,
      attendance_confirmed_at: null,
      return_condition: null,
      return_export_filename: null,
      warehouse_candidate_at: null,
      rt: null,
      conflicts: [],
      status: row.status,
      statusLabel: row.statusLabel,
      lifecycleColor: row.lifecycleColor,
      dispatchAgeDays: row.dispatchAgeDays,
      dispatchAgeColor: row.dispatchAgeColor,
      notes: null,
    }],
    export: {
      request_filename: null,
      request_path: null,
      subject: `Spare request ${row.ticketId}`,
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
    createdAt: "2026-08-08T12:00:00",
    updatedAt: "2026-08-08T12:00:00",
  };
}

const serviceRows = ["20000001", "20000002", "20000003"].map(serviceSummary);
const spareRows = [1, 2, 3].map(spareSummary);

const serviceDashboard: ServiceRequestsDashboardPayload = {
  workspace: "service-requests",
  datasetRevision: 1,
  sort: "report",
  direction: "asc",
  search: "",
  columns: [
    { key: "ticketId", label: "SR", width: 94, default: true },
    { key: "summary", label: "Summary", width: 360, default: true, flex: true },
  ],
  stats: {
    active: 3,
    doneY: 0,
    doneN: 3,
    doneP: 0,
    doneUnknown: 0,
    overdue: 0,
    unplanned: 3,
    noEmail: 3,
    pendingClosure: 0,
  },
  tickets: serviceRows,
};

const spareDashboard: SpareRequestsDashboardPayload = {
  workspace: "spare-requests",
  view: "active",
  datasetRevision: 1,
  sort: "tt",
  direction: "desc",
  search: "",
  columns: [
    { key: "ticketId", label: "TT", width: 94, default: true },
    { key: "rma", label: "RMA", width: 132, default: true },
  ],
  stats: {
    activeRequests: 3,
    activeItems: 3,
    awaitingStock: 0,
    awaitingDispatch: 3,
    dispatched: 0,
    warehouseCandidates: 0,
    conflicts: 0,
    eligibleParts: 0,
    completedItems: 0,
  },
  spareRequests: spareRows,
  eligibleParts: [],
};

class FakeEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  apiMocks.getBootstrap.mockResolvedValue(bootstrap);
  apiMocks.getTemplates.mockResolvedValue({ templates: [] });
  apiMocks.getDashboard.mockImplementation(async (workspace: string) => (
    workspace === "spare-requests" ? spareDashboard : serviceDashboard
  ));
  apiMocks.getTicket.mockImplementation(async (ticketId: string) => serviceDetail(ticketId));
  apiMocks.getSpareRequest.mockImplementation(async (requestId: string) => {
    const row = spareRows.find((candidate) => candidate.requestId === requestId);
    if (!row) throw new Error(`Unknown request ${requestId}`);
    return spareDetail(row);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-font-scale");
});

describe("workspace selection and detail focus", () => {
  it("applies the persisted interface text-size preset", async () => {
    apiMocks.getBootstrap.mockResolvedValue({ ...bootstrap, appearance: { fontScale: "large" } });
    render(<App />);

    await screen.findByRole("row", { name: /20000001/ });
    expect(document.documentElement).toHaveAttribute("data-font-scale", "large");
  });

  it("closes an SR detail, moves the row cursor without opening, and activates only on Enter", async () => {
    const user = userEvent.setup();
    render(<App />);

    const second = await screen.findByRole("row", { name: /20000002/ });
    expect(screen.getByLabelText("Service Requests summary")).toHaveTextContent("Done 0");
    expect(screen.getByLabelText("Service Requests summary")).toHaveTextContent("Pending 3");
    expect(screen.getByLabelText("Service Requests summary")).toHaveTextContent("Uncompleted 0");
    expect(screen.getByLabelText("Service Requests summary")).toHaveTextContent("N/A 0");
    await user.click(second);
    const detail = await screen.findByRole("complementary", { name: "SR 20000002 detail" });
    await user.click(screen.getByRole("button", { name: "Work fields" }));
    await user.click(screen.getByLabelText("Notes"));
    expect(detail).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "SR 20000002 detail" })).not.toBeInTheDocument());
    expect(second).toHaveClass("selected");
    expect(second).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(second).toHaveFocus());

    window.dispatchEvent(new Event("blur"));
    expect(second).toHaveClass("selected");

    apiMocks.getTicket.mockClear();
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "SR 20000002 detail" });
    expect(apiMocks.getTicket).toHaveBeenCalledWith("20000002");
    expect(apiMocks.getTicket).not.toHaveBeenCalledWith("20000001");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(second).toHaveFocus());
    apiMocks.getTicket.mockClear();
    await user.keyboard("{ArrowDown}");
    const third = screen.getByRole("row", { name: /20000003/ });
    await waitFor(() => expect(third).toHaveFocus());
    expect(third).toHaveClass("selected");
    expect(screen.queryByRole("complementary", { name: "SR 20000003 detail" })).not.toBeInTheDocument();
    expect(apiMocks.getTicket).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "SR 20000003 detail" });
    expect(apiMocks.getTicket).toHaveBeenCalledWith("20000003");
  });

  it("applies the same highlight-versus-open behavior to Spare Requests", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("row", { name: /20000001/ });
    await user.click(screen.getByRole("button", { name: "Spare Requests" }));
    const second = await screen.findByRole("row", { name: /C3209937822/ });
    await user.click(second);
    await screen.findByRole("complementary", { name: `Spare Request ${spareRows[1].requestId} detail` });
    await user.click(screen.getByLabelText("Spare SR"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: `Spare Request ${spareRows[1].requestId} detail` })).not.toBeInTheDocument());
    expect(second).toHaveClass("selected");
    expect(second).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(second).toHaveFocus());

    apiMocks.getSpareRequest.mockClear();
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: `Spare Request ${spareRows[1].requestId} detail` });
    expect(apiMocks.getSpareRequest).toHaveBeenCalledWith(spareRows[1].requestId);
    expect(apiMocks.getSpareRequest).not.toHaveBeenCalledWith(spareRows[0].requestId);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(second).toHaveFocus());
    apiMocks.getSpareRequest.mockClear();
    await user.keyboard("{ArrowDown}");
    const third = screen.getByRole("row", { name: /C3209937823/ });
    await waitFor(() => expect(third).toHaveFocus());
    expect(third).toHaveClass("selected");
    expect(screen.queryByRole("complementary", { name: `Spare Request ${spareRows[2].requestId} detail` })).not.toBeInTheDocument();
    expect(apiMocks.getSpareRequest).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: `Spare Request ${spareRows[2].requestId} detail` });
    expect(apiMocks.getSpareRequest).toHaveBeenCalledWith(spareRows[2].requestId);
  });
});
