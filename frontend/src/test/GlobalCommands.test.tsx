import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGlobalCommands } from "../hooks/useGlobalCommands";

function Harness({ queryDisabled = false }: { queryDisabled?: boolean }) {
  useGlobalCommands({
    queryDisabled,
    onSearch: handlers.search,
    onSort: handlers.sort,
    onOperations: handlers.operations,
    onQuery: handlers.query,
  });
  return <><input aria-label="Editable field" /><button type="button">Outside editing area</button></>;
}

const handlers = {
  search: vi.fn(),
  sort: vi.fn(),
  operations: vi.fn(),
  query: vi.fn(),
};

describe("global Zeus commands", () => {
  it("runs S, M, R, and Ctrl+F anywhere outside an editing area", () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Outside editing area" }).focus();

    fireEvent.keyDown(window, { key: "s" });
    fireEvent.keyDown(window, { key: "M" });
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });

    expect(handlers.sort).toHaveBeenCalledOnce();
    expect(handlers.operations).toHaveBeenCalledOnce();
    expect(handlers.query).toHaveBeenCalledOnce();
    expect(handlers.search).toHaveBeenCalledOnce();
  });

  it("does not turn text entry into commands and respects a busy query", () => {
    render(<Harness queryDisabled />);
    const input = screen.getByRole("textbox", { name: "Editable field" });

    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(input, { key: "m" });
    fireEvent.keyDown(input, { key: "r" });
    expect(handlers.sort).not.toHaveBeenCalled();
    expect(handlers.operations).not.toHaveBeenCalled();
    expect(handlers.query).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "r" });
    expect(handlers.query).not.toHaveBeenCalled();
  });
});
