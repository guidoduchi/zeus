import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalDataModal } from "../components/GlobalDataModal";

const api = vi.hoisted(() => ({
  getDashboard: vi.fn(),
  getGlobalReferenceData: vi.fn(),
  getSpareRequestPrefill: vi.fn(),
  getUserProfile: vi.fn(),
  saveGlobalReferenceData: vi.fn(),
  saveUserProfile: vi.fn(),
}));

vi.mock("../api", () => api);

describe("GlobalDataModal", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    api.getGlobalReferenceData.mockResolvedValue({
      schemaVersion: 2,
      organizations: [{ id: "org-1", name: "Claro Ecuador" }],
      customers: [],
      sites: [],
      requesters: [],
    });
    api.getUserProfile.mockResolvedValue({
      schemaVersion: 1,
      complete: true,
      profile: {
        name: "Nebby Operator",
        email: "nebby@example.com",
        phone: "+593991234567",
        username: "nebby",
        photoDataUrl: null,
      },
    });
    api.saveUserProfile.mockResolvedValue({ complete: true });
    api.saveGlobalReferenceData.mockImplementation(async (value) => value);
    api.getDashboard.mockResolvedValue({
      workspace: "service-requests",
      tickets: [{ ticketId: "39366148", summary: "Customer contact source" }],
    });
    api.getSpareRequestPrefill.mockResolvedValue({
      ticketId: "39366148",
      ticketExists: true,
      profile: {
        customerOrganization: "CNT Ecuador",
        customerName: "María Cliente",
        contact: { name: "María Cliente", email: "maria@example.com", phone: "+593980000000" },
      },
      lines: [],
      warning: null,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses ordinary forms for organization-owned contacts and pinned requesters", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <GlobalDataModal
        onClose={onClose}
        onSaved={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /Customer contacts/ }));
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.selectOptions(screen.getByLabelText("Customer organization *"), "org-1");
    await user.type(screen.getByLabelText("Customer name *"), "Juan Piguave");

    await user.click(screen.getByRole("button", { name: /Requesters/ }));
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await user.type(screen.getByLabelText("Requester name *"), "Favorite Engineer");
    await user.type(screen.getByLabelText("Email *"), "favorite@example.com");
    await user.type(screen.getByLabelText("Phone *"), "+593982222222");
    await user.click(screen.getByRole("checkbox", { name: "Pin as favorite requester" }));
    await user.click(screen.getByRole("button", { name: "Save global data" }));

    await waitFor(() => expect(api.saveGlobalReferenceData).toHaveBeenCalledTimes(1));
    const saved = api.saveGlobalReferenceData.mock.calls[0][0];
    expect(saved.customers[0]).toMatchObject({
      organizationId: "org-1",
      name: "Juan Piguave",
    });
    expect(saved.requesters[0]).toMatchObject({
      name: "Favorite Engineer",
      pinned: true,
    });
    expect(api.saveUserProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Nebby Operator" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save global data" })).toBeDisabled();
    expect(screen.getByText(/All Global data is saved/i)).toBeVisible();
  });

  it("shows the profile as the default requester and explains each manager", async () => {
    const user = userEvent.setup();
    render(<GlobalDataModal onClose={vi.fn()} onSaved={vi.fn()} onError={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Requesters/ }));
    expect(screen.getByText("Default requester from My profile.")).toBeVisible();
    expect(screen.getByDisplayValue("Nebby Operator")).toBeDisabled();
    expect(screen.getByText(/profile is always the default requester/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Sites/ }));
    expect(screen.getByText("Sites identify spare-part dispatch and return locations.")).toBeVisible();
  });

  it("autocompletes SR customer imports and protects unsaved modal changes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<GlobalDataModal onClose={onClose} onSaved={vi.fn()} onError={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /Customer contacts/ }));
    const ticketInput = screen.getByLabelText("Service Request to import");
    await user.type(ticketInput, "3936");
    await waitFor(() => expect(api.getDashboard).toHaveBeenLastCalledWith("service-requests", "sr", "desc", "3936", "active"));
    expect(document.querySelector('option[value="39366148"]')).not.toBeNull();

    await user.clear(ticketInput);
    await user.type(ticketInput, "39366148");
    await user.click(screen.getByRole("button", { name: "Import customer from SR" }));
    expect(await screen.findByDisplayValue("María Cliente")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save global data" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close Global data" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(window.confirm).toHaveBeenCalled();
  });
});
