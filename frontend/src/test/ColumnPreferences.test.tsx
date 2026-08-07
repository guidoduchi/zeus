import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useColumnPreferences } from "../hooks/useColumnPreferences";
import type { ColumnDefinition } from "../types";

const definitions: ColumnDefinition[] = [
  { key: "ticketId", label: "SR", width: 94, default: true },
  { key: "severity", label: "Severity", width: 92, default: true },
  { key: "summary", label: "Summary", width: 360, default: true },
  { key: "handler", label: "Handler", width: 180, default: false },
];

describe("dashboard field preferences", () => {
  it("toggles and reorders fields in local storage while SR stays visible", () => {
    const { result } = renderHook(() => useColumnPreferences(definitions));
    act(() => result.current.toggle("handler"));
    act(() => result.current.move("handler", -1));
    act(() => result.current.toggle("ticketId"));

    expect(result.current.visibleKeys).toContain("handler");
    expect(result.current.visibleKeys).toContain("ticketId");
    expect(result.current.orderedColumns.map((column) => column.key)).toEqual([
      "ticketId", "severity", "handler", "summary",
    ]);
    expect(JSON.parse(localStorage.getItem("zeus3.dashboard.columns") || "{}").visible).toContain("handler");
  });
});
