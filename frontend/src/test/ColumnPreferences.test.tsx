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

  it("preserves saved visibility while the dashboard schema loads", () => {
    localStorage.setItem("zeus3.dashboard.columns", JSON.stringify({
      order: ["ticketId", "severity", "summary", "handler"],
      visible: ["ticketId", "summary"],
    }));
    const { result, rerender } = renderHook(
      ({ columns }) => useColumnPreferences(columns),
      { initialProps: { columns: [] as ColumnDefinition[] } },
    );

    rerender({ columns: definitions });

    expect(result.current.visibleKeys).toEqual(["ticketId", "summary"]);
    expect(result.current.visibleColumns.map((column) => column.key)).toEqual(["ticketId", "summary"]);
  });

  it("shows a newly introduced default column without unhiding older choices", () => {
    localStorage.setItem("zeus3.dashboard.columns", JSON.stringify({
      order: ["ticketId", "severity", "summary", "handler"],
      visible: ["ticketId", "summary"],
    }));
    const nextDefinitions: ColumnDefinition[] = [
      ...definitions,
      { key: "emailCount", label: "Emails", width: 68, default: true },
    ];
    const { result } = renderHook(() => useColumnPreferences(nextDefinitions));

    expect(result.current.visibleKeys).toContain("emailCount");
    expect(result.current.visibleKeys).not.toContain("severity");
  });

  it("merges saved MW and Planned preferences into the unified MW column", () => {
    const spareKey = "zeus3.spare-parts.columns";
    localStorage.setItem(spareKey, JSON.stringify({
      order: ["ticketId", "risk", "plannedDate", "site", "done"],
      visible: ["ticketId", "plannedDate", "site"],
    }));
    const mergedDefinitions: ColumnDefinition[] = [
      { key: "ticketId", label: "SR", width: 94, default: true },
      { key: "risk", label: "", width: 18, default: true },
      { key: "done", label: "MW", width: 128, default: true },
      { key: "site", label: "Site", width: 110, default: true },
    ];
    const { result } = renderHook(
      () => useColumnPreferences(mergedDefinitions, spareKey),
    );

    expect(result.current.orderedColumns.map((column) => column.key)).toEqual([
      "ticketId", "risk", "done", "site",
    ]);
    expect(result.current.visibleKeys).toContain("done");
    expect(result.current.visibleKeys).not.toContain("plannedDate");
  });

  it("keeps Spare Parts field choices separate from Service Requests", () => {
    const spareKey = "zeus3.spare-parts.columns";
    const { result } = renderHook(() => useColumnPreferences(definitions, spareKey));
    act(() => result.current.toggle("handler"));

    expect(JSON.parse(localStorage.getItem(spareKey) || "{}").visible).toContain("handler");
    expect(localStorage.getItem("zeus3.dashboard.columns")).toBeNull();
  });

  it("repairs saved layouts and keeps SR pinned as the first column", () => {
    const spareKey = "zeus3.spare-parts.columns";
    localStorage.setItem(spareKey, JSON.stringify({
      order: ["severity", "summary", "ticketId", "handler"],
      visible: ["severity", "summary"],
    }));
    const { result } = renderHook(() => useColumnPreferences(definitions, spareKey));

    expect(result.current.orderedColumns[0].key).toBe("ticketId");
    expect(result.current.visibleKeys).toContain("ticketId");
    act(() => result.current.move("severity", -1));
    act(() => result.current.move("ticketId", 1));
    expect(result.current.orderedColumns[0].key).toBe("ticketId");
  });

  it("moves Spare Parts immediately after Last Email once without resetting choices", () => {
    const key = "zeus3.dashboard.columns.migration";
    localStorage.setItem(key, JSON.stringify({
      order: ["ticketId", "severity", "spareBadges", "summary", "emailLabel", "handler"],
      visible: ["ticketId", "spareBadges", "emailLabel", "handler"],
    }));
    const migratedDefinitions: ColumnDefinition[] = [
      ...definitions.slice(0, 2),
      { key: "emailLabel", label: "Last Email", width: 154, default: true },
      { key: "spareBadges", label: "Spare Parts", width: 132, default: true },
      ...definitions.slice(2),
    ];
    const { result } = renderHook(() => useColumnPreferences(migratedDefinitions, key));
    const order = result.current.orderedColumns.map((column) => column.key);
    expect(order.indexOf("spareBadges")).toBe(order.indexOf("emailLabel") + 1);
    expect(result.current.visibleKeys).toEqual(expect.arrayContaining(["ticketId", "spareBadges", "emailLabel", "handler"]));
    expect(JSON.parse(localStorage.getItem(key) || "{}").layoutVersion).toBe(2);
  });
});
