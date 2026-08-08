import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpareRequestModal } from "../components/SpareRequestModal";
import type { SparePartSummary } from "../types";

const api = vi.hoisted(() => ({
  getSpareReferenceData: vi.fn(),
  getSpareRequestPrefill: vi.fn(),
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
  readOnly: false,
  source: "current",
};

describe("SpareRequestModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSpareReferenceData.mockResolvedValue({
      schemaVersion: 1, customers: [], sites: [], requesters: [], boms: [],
    });
    api.getSpareRequestPrefill.mockResolvedValue({
      ticketId: "39416095",
      ticketExists: true,
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
        onError={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("TT · 8 digits")).toBeEnabled();
  });
});
