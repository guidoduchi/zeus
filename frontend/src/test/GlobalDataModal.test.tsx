import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalDataModal } from "../components/GlobalDataModal";

const api = vi.hoisted(() => ({
  getGlobalReferenceData: vi.fn(),
  getUserProfile: vi.fn(),
  importCustomerFromTicket: vi.fn(),
  saveGlobalReferenceData: vi.fn(),
  saveUserProfile: vi.fn(),
}));

vi.mock("../api", () => api);

describe("GlobalDataModal", () => {
  beforeEach(() => {
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
  });

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
    expect(onClose).toHaveBeenCalledOnce();
  });
});
