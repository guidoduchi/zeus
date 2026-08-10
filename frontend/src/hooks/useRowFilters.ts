import { useCallback, useEffect, useMemo, useState } from "react";

export interface RowFilterBlueprint<Row> {
  key: string;
  label: string;
  values: (row: Row) => string | string[] | null | undefined;
  optionLabel?: (value: string) => string;
  order?: string[];
}

export interface RowFilterOption {
  value: string;
  label: string;
  count: number;
}

export interface RowFilterDefinition {
  key: string;
  label: string;
  options: RowFilterOption[];
}

type Selections = Record<string, string[]>;

const MAINTENANCE_WINDOW_STATES = new Set([
  "planned", "unplanned", "incomplete", "completed", "no_visibility",
]);

function migrateLegacyMaintenanceWindowSelections(selections: Selections): Selections {
  const planning = selections.planning || [];
  const maintenance = selections.mw || [];
  const hasLegacyCodes = maintenance.some((value) => ["N", "P", "Y", "?"].includes(value));
  if (!planning.length && !hasLegacyCodes) return selections;

  const planningMode = planning.length === 1 ? planning[0] : null;
  const mapped = new Set(
    maintenance.filter((value) => MAINTENANCE_WINDOW_STATES.has(value)),
  );
  for (const code of maintenance) {
    if (code === "N") {
      if (planningMode !== "unplanned") mapped.add("planned");
      if (planningMode !== "planned") mapped.add("unplanned");
    } else if (code === "P") {
      mapped.add("incomplete");
    } else if (code === "Y") {
      mapped.add("completed");
    } else if (code === "?") {
      if (planningMode !== "unplanned") mapped.add("planned");
      if (planningMode !== "planned") mapped.add("no_visibility");
    }
  }
  const migrated = { ...selections };
  delete migrated.planning;
  if (mapped.size) migrated.mw = [...mapped];
  else delete migrated.mw;
  return migrated;
}

function normalizedValues(value: string | string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function readSelections(storageKey: string): Selections {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return migrateLegacyMaintenanceWindowSelections(Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => (
        Array.isArray(value)
          ? [[key, value.map(String).map((item) => item.trim()).filter(Boolean)]]
          : []
      )),
    ));
  } catch {
    return {};
  }
}

export function useRowFilters<Row>(
  rows: Row[],
  blueprints: Array<RowFilterBlueprint<Row>>,
  storageKey: string,
) {
  const [selections, setSelections] = useState<Selections>(() => readSelections(storageKey));

  useEffect(() => setSelections(readSelections(storageKey)), [storageKey]);

  const definitions = useMemo<RowFilterDefinition[]>(() => blueprints.map((blueprint) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const value of normalizedValues(blueprint.values(row))) {
        counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    const preferred = new Map((blueprint.order || []).map((value, index) => [value, index]));
    const values = new Set([...counts.keys(), ...(selections[blueprint.key] || [])]);
    const options = [...values].map((value) => ({
      value,
      count: counts.get(value) || 0,
      label: blueprint.optionLabel?.(value) || value,
    })).sort((left, right) => {
      const leftOrder = preferred.get(left.value);
      const rightOrder = preferred.get(right.value);
      if (leftOrder !== undefined || rightOrder !== undefined) {
        return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
      }
      return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
    });
    return { key: blueprint.key, label: blueprint.label, options };
  }), [blueprints, rows, selections]);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(selections)); } catch { /* local preferences are optional */ }
  }, [selections, storageKey]);

  const filteredRows = useMemo(() => rows.filter((row) => blueprints.every((blueprint) => {
    const selected = selections[blueprint.key] || [];
    if (!selected.length) return true;
    const actual = new Set(normalizedValues(blueprint.values(row)));
    return selected.some((value) => actual.has(value));
  })), [blueprints, rows, selections]);

  const toggle = useCallback((key: string, value: string) => {
    setSelections((current) => {
      const selected = current[key] || [];
      const nextValues = selected.includes(value)
        ? selected.filter((candidate) => candidate !== value)
        : [...selected, value];
      const next = { ...current };
      if (nextValues.length) next[key] = nextValues;
      else delete next[key];
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelections({}), []);
  const activeCount = Object.values(selections).reduce((total, values) => total + values.length, 0);

  return { definitions, selections, filteredRows, activeCount, toggle, clear };
}
