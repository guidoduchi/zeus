import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDefinition } from "../types";

const STORAGE_KEY = "zeus3.dashboard.columns";

interface StoredPreferences {
  order: string[];
  visible: string[];
}

function defaults(definitions: ColumnDefinition[]): StoredPreferences {
  return {
    order: definitions.map((column) => column.key),
    visible: definitions.filter((column) => column.default).map((column) => column.key),
  };
}

function mergeLegacyMaintenanceWindowColumns(
  preferences: StoredPreferences,
  definitions: ColumnDefinition[],
): StoredPreferences {
  const known = new Set(definitions.map((column) => column.key));
  if (!known.has("done") || known.has("plannedDate")) return preferences;
  const aliases = new Set(["done", "plannedDate"]);
  const merge = (values: string[], include: boolean) => {
    const firstAlias = values.findIndex((key) => aliases.has(key));
    const merged = values.filter((key) => !aliases.has(key));
    if (include) {
      const insertion = firstAlias < 0
        ? merged.length
        : values.slice(0, firstAlias).filter((key) => !aliases.has(key)).length;
      merged.splice(insertion, 0, "done");
    }
    return merged;
  };
  return {
    order: merge(preferences.order, preferences.order.some((key) => aliases.has(key))),
    visible: merge(preferences.visible, preferences.visible.some((key) => aliases.has(key))),
  };
}

function readStored(definitions: ColumnDefinition[], storageKey: string): StoredPreferences {
  const fallback = defaults(definitions);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
    const storedOrder = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is string => typeof key === "string")
      : [];
    const storedVisible = Array.isArray(parsed.visible)
      ? parsed.visible.filter((key): key is string => typeof key === "string")
      : [];
    // App bootstrap renders once before the dashboard schema arrives. Preserve
    // the raw known-later keys through that render so a reload cannot replace a
    // user's saved choices with defaults.
    if (!definitions.length) return { order: storedOrder, visible: storedVisible };
    const migrated = mergeLegacyMaintenanceWindowColumns(
      { order: storedOrder, visible: storedVisible },
      definitions,
    );
    const known = new Set(definitions.map((column) => column.key));
    const previouslyKnown = new Set(migrated.order);
    const order = migrated.order.filter((key) => known.has(key));
    for (const key of fallback.order) {
      if (!order.includes(key)) order.push(key);
    }
    if (known.has("ticketId")) {
      const ticketIndex = order.indexOf("ticketId");
      if (ticketIndex >= 0) order.splice(ticketIndex, 1);
      order.unshift("ticketId");
    }
    const visible = migrated.visible.filter((key) => known.has(key));
    if (!visible.length) visible.push(...fallback.visible);
    for (const column of definitions) {
      if (column.default && !previouslyKnown.has(column.key) && !visible.includes(column.key)) {
        visible.push(column.key);
      }
    }
    if (known.has("ticketId") && !visible.includes("ticketId")) visible.unshift("ticketId");
    return { order, visible };
  } catch {
    return fallback;
  }
}

export function useColumnPreferences(definitions: ColumnDefinition[], storageKey = STORAGE_KEY) {
  const [preferences, setPreferences] = useState<StoredPreferences>(() => readStored(definitions, storageKey));

  useEffect(() => {
    setPreferences(readStored(definitions, storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!definitions.length) return;
    setPreferences((current) => {
      const migrated = mergeLegacyMaintenanceWindowColumns(current, definitions);
      const known = new Set(definitions.map((column) => column.key));
      const previouslyKnown = new Set(migrated.order);
      const order = migrated.order.filter((key) => known.has(key));
      for (const column of definitions) {
        if (!order.includes(column.key)) order.push(column.key);
      }
      if (known.has("ticketId")) {
        const ticketIndex = order.indexOf("ticketId");
        if (ticketIndex >= 0) order.splice(ticketIndex, 1);
        order.unshift("ticketId");
      }
      const visible = migrated.visible.filter((key) => known.has(key));
      if (!visible.length) visible.push(...defaults(definitions).visible);
      for (const column of definitions) {
        if (column.default && !previouslyKnown.has(column.key) && !visible.includes(column.key)) {
          visible.push(column.key);
        }
      }
      if (known.has("ticketId") && !visible.includes("ticketId")) visible.unshift("ticketId");
      return { order, visible };
    });
  }, [definitions]);

  useEffect(() => {
    if (definitions.length) localStorage.setItem(storageKey, JSON.stringify(preferences));
  }, [definitions.length, preferences, storageKey]);

  const ordered = useMemo(() => {
    const byKey = new Map(definitions.map((column) => [column.key, column]));
    return preferences.order.map((key) => byKey.get(key)).filter(Boolean) as ColumnDefinition[];
  }, [definitions, preferences.order]);

  const visibleColumns = useMemo(
    () => ordered.filter((column) => preferences.visible.includes(column.key)),
    [ordered, preferences.visible],
  );

  const toggle = useCallback((key: string) => {
    if (key === "ticketId") return;
    setPreferences((current) => ({
      ...current,
      visible: current.visible.includes(key)
        ? current.visible.filter((candidate) => candidate !== key)
        : [...current.visible, key],
    }));
  }, []);

  const move = useCallback((key: string, direction: -1 | 1) => {
    if (key === "ticketId") return;
    setPreferences((current) => {
      const index = current.order.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      if (current.order[target] === "ticketId") return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  }, []);

  const reset = useCallback(() => setPreferences(defaults(definitions)), [definitions]);

  return { orderedColumns: ordered, visibleColumns, visibleKeys: preferences.visible, toggle, move, reset };
}
