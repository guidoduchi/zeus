import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfileSetup } from "../components/ProfileSetup";

describe("ProfileSetup", () => {
  it("requires local contact details without asking for a login or password", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProfileSetup onSave={onSave} onError={vi.fn()} />);

    const save = screen.getByRole("button", { name: "Save profile & start Zeus" });
    expect(save).toBeDisabled();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Name *"), "Nebby Operator");
    await user.type(screen.getByLabelText("Email *"), "nebby@example.com");
    await user.type(screen.getByLabelText("Phone number *"), "+593 99 123 4567");
    expect(save).toBeEnabled();
    await user.click(save);

    expect(onSave).toHaveBeenCalledWith({
      name: "Nebby Operator",
      email: "nebby@example.com",
      phone: "+593 99 123 4567",
      username: "",
      photoDataUrl: null,
    });
  });
});
