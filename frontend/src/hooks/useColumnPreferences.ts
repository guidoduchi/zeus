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

function readStored(definitions: ColumnDefinition[]): StoredPreferences {
  const fallback = defaults(definitions);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
    const known = new Set(definitions.map((column) => column.key));
    const order = storedOrder.filter((key) => known.has(key));
    for (const key of fallback.order) {
      if (!order.includes(key)) order.push(key);
    }
    const visible = storedVisible.filter((key) => known.has(key));
    if (!visible.length) visible.push(...fallback.visible);
    if (known.has("ticketId") && !visible.includes("ticketId")) visible.unshift("ticketId");
    return { order, visible };
  } catch {
    return fallback;
  }
}

export function useColumnPreferences(definitions: ColumnDefinition[]) {
  const [preferences, setPreferences] = useState<StoredPreferences>(() => readStored(definitions));

  useEffect(() => {
    if (!definitions.length) return;
    setPreferences((current) => {
      const known = new Set(definitions.map((column) => column.key));
      const order = current.order.filter((key) => known.has(key));
      for (const column of definitions) {
        if (!order.includes(column.key)) order.push(column.key);
      }
      const visible = current.visible.filter((key) => known.has(key));
      if (!visible.length) visible.push(...defaults(definitions).visible);
      if (known.has("ticketId") && !visible.includes("ticketId")) visible.unshift("ticketId");
      return { order, visible };
    });
  }, [definitions]);

  useEffect(() => {
    if (definitions.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [definitions.length, preferences]);

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
    setPreferences((current) => {
      const index = current.order.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.order.length) return current;
      const order = [...current.order];
      [order[index], order[target]] = [order[target], order[index]];
      return { ...current, order };
    });
  }, []);

  const reset = useCallback(() => setPreferences(defaults(definitions)), [definitions]);

  return { orderedColumns: ordered, visibleColumns, visibleKeys: preferences.visible, toggle, move, reset };
}
