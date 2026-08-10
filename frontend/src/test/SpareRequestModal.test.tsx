import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpareRequestModal } from "../components/SpareRequestModal";
import type { SparePartSummary } from "../types";
import styles from "../styles.css?raw";

const api = vi.hoisted(() => ({
  getSpareReferenceData: vi.fn(),
  getSpareRequestPrefill: vi.fn(),
  importCustomerFromTicket: vi.fn(),
}));

vi.mock("../api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  ...api,
}));

const part: SparePartSummary = {
  rowId: "39416095:1:1",
  ticketId: "39416095",
  revision: "revision",
  lifecycle: "active",
  done: "N",
  plannedDate: "Unplanned",
  plannedDays: null,
  plannedState: "unplanned",
  plannedColor: "yellow",
  site: "UIO1",
  cloud: "Ecuador Cloud",
  deviceNumber: 1,
  partNumber: 1,
  device: "SW-UIO-01",
  model: "S6730",
  slot: "1/0/1",
  part: "Controller board",
  bom: "02312RCC",
  bomColor: null,
  faultySn: "FAULTY-1",
  newSn: "—",
  summary: "Controller alarm",
  risk: "none",
  hasPart: true,
  submitted: false,
  submittedRequestIds: [],
  readOnly: false,
  source: "current",
};

describe("SpareRequestModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSpareReferenceData.mockResolvedValue({
      schemaVersion: 2,
      organizations: [],
      customers: [],
      sites: [],
      requesters: [],
      boms: [],
      exportSetup: {
        requestReady: true,
        returnReady: true,
        requestMissing: [],
        returnMissing: [],
      },
    });
    api.getSpareRequestPrefill.mockResolvedValue({
      ticketId: "39416095",
      ticketExists: true,
      reportDate: null,
      profile: {},
      lines: [],
      warning: null,
    });
  });

  it("locks a TT inherited from an eligible SR part", async () => {
    render(
      <SpareRequestModal
        initialPart={part}
        onClose={vi.fn()}
        onExport={vi.fn()}
        onExportSetupRequired={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("TT · 8 digits")).toBeDisabled();
    await waitFor(() => expect(api.getSpareRequestPrefill).toHaveBeenCalledWith("39416095"));
  });

  it("keeps a new manual TT editable", () => {
    render(
      <SpareRequestModal
        onClose={vi.fn()}
        onExport={vi.fn()}
        onExportSetupRequired={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("TT · 8 digits")).toBeEnabled();
  });

  it("saves the validated customer currently shown in the form", async () => {
    const user = userEvent.setup();
    api.getSpareRequestPrefill.mockResolvedValue({
      ticketId: "39416095",
      ticketExists: true,
      reportDate: "2026-07-01 10:00:00",
      profile: {
        customerName: "Angel Guerrero",
        customerOrganization: "Consorcio Ecuatoriano de Telecomunicaciones",
        contact: {
          name: "Angel Guerrero",
          email: "angel@example.com",
          phone: "+593980000001",
        },
      },
      lines: [],
      warning: null,
    });
    api.importCustomerFromTicket.mockResolvedValue({});

    render(
      <SpareRequestModal
        initialPart={part}
        onClose={vi.fn()}
        onExport={vi.fn()}
        onExportSetupRequired={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const saveCustomer = await screen.findByRole("button", { name: "Save customer globally" });
    expect(screen.getByLabelText("Original TT report date *")).toHaveValue("2026-07-01");
    expect(screen.getByLabelText("Original TT report date *")).toHaveAttribute("readonly");
    await user.click(saveCustomer);

    expect(api.importCustomerFromTicket).toHaveBeenCalledWith("39416095", {
      customerOrganization: "Consorcio Ecuatoriano de Telecomunicaciones",
      customerName: "Angel Guerrero",
      contact: {
        name: "Angel Guerrero",
        email: "angel@example.com",
        phone: "+593980000001",
      },
    });
  });

  it("defers missing export configuration until the explicit export attempt", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn().mockResolvedValue(undefined);
    const onRegisterManual = vi.fn().mockResolvedValue(undefined);
    const onExportSetupRequired = vi.fn();
    api.getSpareReferenceData.mockResolvedValue({
      schemaVersion: 2,
      organizations: [],
      customers: [],
      sites: [],
      requesters: [{ id: "__current_user__", name: "Nebby Operator", email: "nebby@example.com", phone: "+593991234567", username: "nebby", pinned: true, currentUser: true }],
      boms: [],
      exportSetup: {
        requestReady: false,
        returnReady: false,
        requestMissing: [
          { key: "paths.spare_parts_export_directory", label: "Spare Request export folder" },
          { key: "paths.spare_request_template", label: "Spare Request template" },
        ],
        returnMissing: [],
      },
    });
    api.getSpareRequestPrefill.mockResolvedValue({
      ticketId: "39416095",
      ticketExists: true,
      profile: {
        customerName: "Juan Piguave",
        customerOrganization: "Claro Ecuador",
        siteCode: "UIO1",
        siteAddress: "Av. Example 123",
        cloud: "FusionSphere",
        contact: {
          name: "Juan Piguave",
          email: "juan@example.com",
          phone: "+593981111111",
        },
      },
      reportDate: "2026-07-01 10:00:00",
      lines: [],
      warning: null,
    });
    const modalProps = {
      initialPart: part,
      onClose: vi.fn(),
      onExport,
      onRegisterManual,
      onExportSetupRequired,
      onError: vi.fn(),
    };
    const { rerender } = render(
      <SpareRequestModal
        {...modalProps}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Requester *")).toHaveValue("Nebby Operator"));
    await waitFor(() => expect(screen.getByLabelText("Customer name *")).toHaveValue("Juan Piguave"));
    expect(screen.queryByText("Export configuration required")).not.toBeInTheDocument();
    expect(onExportSetupRequired).not.toHaveBeenCalled();

    const setupButton = screen.getByRole("button", { name: "Export XLSX & create request" });
    expect(setupButton).toBeEnabled();
    expect(setupButton).toHaveClass("export-setup-button");
    await user.click(setupButton);
    expect(onExportSetupRequired).toHaveBeenCalledWith([
      "Spare Request export folder",
      "Spare Request template",
    ]);
    expect(onExport).not.toHaveBeenCalled();

    const manualButton = screen.getByRole("button", { name: "Already sent manually" });
    expect(manualButton).toBeEnabled();
    await user.click(manualButton);
    expect(onRegisterManual).toHaveBeenCalledTimes(1);
    expect(onRegisterManual.mock.calls[0][0]).toMatchObject({
      source: "ticket",
      ticketId: "39416095",
      reportDate: "2026-07-01",
    });

    api.getSpareReferenceData.mockResolvedValue({
      schemaVersion: 2,
      organizations: [],
      customers: [],
      sites: [],
      requesters: [{ id: "__current_user__", name: "Changed default", email: "changed@example.com", phone: "000", username: null, pinned: true, currentUser: true }],
      boms: [],
      exportSetup: { requestReady: true, returnReady: true, requestMissing: [], returnMissing: [] },
    });
    rerender(<SpareRequestModal {...modalProps} configurationRevision={1} suspended />);
    await waitFor(() => expect(api.getSpareReferenceData).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Export Spare Request" })).not.toBeInTheDocument();

    rerender(<SpareRequestModal {...modalProps} configurationRevision={1} />);
    expect(screen.getByLabelText("Requester *")).toHaveValue("Nebby Operator");
    expect(screen.getByLabelText("Customer name *")).toHaveValue("Juan Piguave");

    await user.click(screen.getByRole("button", { name: "Export XLSX & create request" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("autocompletes global data and derives one BOM quantity from newline slots", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn().mockResolvedValue(undefined);
    api.getSpareReferenceData.mockResolvedValue({
      schemaVersion: 2,
      organizations: [{ id: "org-1", name: "Claro Ecuador" }],
      customers: [{ id: "customer-1", organizationId: "org-1", name: "Juan Piguave", email: "juan@example.com", phone: "+593981111111" }],
      sites: [{ id: "site-1", code: "UIO1", name: "Quito DC", address: "Av. Example 123", cloud: "FusionSphere" }],
      requesters: [{ id: "__current_user__", name: "Nebby Operator", email: "nebby@example.com", phone: "+593991234567", username: "nebby", pinned: true, currentUser: true }],
      boms: [{ id: "bom-1", bom: "SERVER-001", description: "Complete replacement server", part: "Server", model: "2288H V5", device: "Server" }],
      exportSetup: { requestReady: true, returnReady: true, requestMissing: [], returnMissing: [] },
    });
    render(
      <SpareRequestModal
        onClose={vi.fn()}
        onExport={onExport}
        onExportSetupRequired={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Requester *")).toHaveValue("Nebby Operator"));
    await user.click(screen.getByLabelText("Customer name *"));
    const customerSuggestions = screen.getByRole("listbox", { name: "Customer name suggestions" });
    expect(customerSuggestions).toHaveClass("themed-autocomplete-menu");
    expect(document.querySelector("datalist")).not.toBeInTheDocument();
    expect(styles).toMatch(/\.themed-autocomplete-menu\s*\{[^}]*max-height:\s*198px[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.form-field\s*\{[^}]*align-content:\s*start/s);
    await user.click(screen.getByRole("option", { name: /Juan Piguave/ }));
    expect(screen.getByLabelText("Customer organization *")).toHaveValue("Claro Ecuador");
    expect(screen.getByLabelText("Customer email *")).toHaveValue("juan@example.com");
    expect(screen.getByLabelText("Customer phone *")).toHaveValue("+593981111111");
    await user.type(screen.getByLabelText("TT · 8 digits"), "39416095");
    await user.type(screen.getByLabelText("Original TT report date *"), "2026-07-01");
    expect(screen.getAllByLabelText("Original TT report date *")).toHaveLength(1);
    await user.click(screen.getByLabelText("Site *"));
    await user.click(screen.getByRole("option", { name: /UIO1/ }));
    expect(screen.getByLabelText("Site address *")).toHaveValue("Av. Example 123");
    await user.click(screen.getByLabelText("BOM *"));
    await user.click(screen.getByRole("option", { name: /SERVER-001/ }));
    await user.type(
      screen.getByLabelText(/^Slots · one per line/),
      "DIMM101{enter}DIMM203{enter}DIMM103",
    );
    await user.type(
      screen.getByLabelText(/^Damaged-device serial evidence · one per line/),
      "CPU-SN-001{enter}MEMORY,SN,002{enter}MEZZ-SN-003",
    );
    await user.type(screen.getByLabelText("Notes"), "Diagnostics completed");
    await user.click(screen.getByRole("button", { name: "Export XLSX & create request" }));

    expect(onExport).toHaveBeenCalledTimes(1);
    const payload = onExport.mock.calls[0][0];
    expect(payload.profile.customerName).toBe("Juan Piguave");
    expect(payload.profile.customerOrganization).toBe("Claro Ecuador");
    expect(payload.reportDate).toBe("2026-07-01");
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({
      bom: "SERVER-001",
      amount: 3,
      slot: "DIMM101\nDIMM203\nDIMM103",
      faultySns: ["CPU-SN-001", "MEMORY,SN,002", "MEZZ-SN-003"],
      notes: "Diagnostics completed",
    });
  });
});
