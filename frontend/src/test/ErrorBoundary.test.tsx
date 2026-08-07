import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";

function BrokenPanel(): never {
  throw new Error("Incomplete ticket detail");
}

describe("ErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a recoverable interface instead of an empty black page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    const user = userEvent.setup();

    render(
      <ErrorBoundary onReload={reload}>
        <BrokenPanel />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("ZEUS UI RECOVERY");
    expect(screen.getByText("Incomplete ticket detail")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /reload interface/i }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
