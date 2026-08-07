import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "../components/TopBar";

describe("TopBar workspace switcher", () => {
  it("switches between first-class Service Requests and Spare Parts views", async () => {
    const user = userEvent.setup();
    const onWorkspaceChange = vi.fn();
    render(
      <TopBar
        version="3.1.0"
        detailOpen={false}
        workspace="service-requests"
        stagedMessages={0}
        onWorkspaceChange={onWorkspaceChange}
        onOperations={vi.fn()}
        onSettings={vi.fn()}
        onTheme={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Service Requests" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Spare Parts" }));
    expect(onWorkspaceChange).toHaveBeenCalledWith("spare-parts");
  });
});
