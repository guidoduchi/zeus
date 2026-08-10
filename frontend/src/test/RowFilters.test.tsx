import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRowFilters, type RowFilterBlueprint } from "../hooks/useRowFilters";

interface Row {
  id: string;
  status: string;
  site: string;
}

const rows: Row[] = [
  { id: "one", status: "new", site: "GYE" },
  { id: "two", status: "waiting", site: "GYE" },
  { id: "three", status: "done", site: "UIO" },
];

const blueprints: Array<RowFilterBlueprint<Row>> = [
  { key: "status", label: "Status", values: (row) => row.status },
  { key: "site", label: "Site", values: (row) => row.site },
];

describe("useRowFilters", () => {
  it("uses OR inside one category and AND across categories", () => {
    const { result } = renderHook(() => useRowFilters(rows, blueprints, "filters.contract"));

    act(() => result.current.toggle("status", "new"));
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["one"]);
    act(() => result.current.toggle("status", "waiting"));
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["one", "two"]);
    act(() => result.current.toggle("site", "GYE"));
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["one", "two"]);
    act(() => result.current.toggle("site", "UIO"));
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["one", "two"]);
    act(() => result.current.toggle("status", "new"));
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["two"]);
  });

  it("persists selections without discarding temporarily absent options", () => {
    localStorage.setItem("filters.persisted", JSON.stringify({ status: ["waiting"] }));
    const { result, rerender } = renderHook(
      ({ visibleRows }) => useRowFilters(visibleRows, blueprints, "filters.persisted"),
      { initialProps: { visibleRows: rows } },
    );
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["two"]);

    rerender({ visibleRows: rows.filter((row) => row.status !== "waiting") });
    expect(result.current.filteredRows).toEqual([]);
    expect(result.current.definitions[0].options).toContainEqual({
      value: "waiting",
      label: "waiting",
      count: 0,
    });
  });

  it("migrates the old Planning and MW filters into one structured MW filter", () => {
    const mwRows = [
      { id: "planned", mw: "planned" },
      { id: "unplanned", mw: "unplanned" },
      { id: "incomplete", mw: "incomplete" },
    ];
    const mwBlueprints: Array<RowFilterBlueprint<(typeof mwRows)[number]>> = [{
      key: "mw",
      label: "MW",
      values: (row) => row.mw,
    }];
    localStorage.setItem("filters.mw-migration", JSON.stringify({
      planning: ["planned"],
      mw: ["N"],
    }));

    const { result } = renderHook(() => useRowFilters(
      mwRows,
      mwBlueprints,
      "filters.mw-migration",
    ));

    expect(result.current.selections).toEqual({ mw: ["planned"] });
    expect(result.current.filteredRows.map((row) => row.id)).toEqual(["planned"]);
    expect(result.current.activeCount).toBe(1);
  });
});
