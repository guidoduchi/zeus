const MAINTENANCE_WINDOW_LABELS: Record<string, string> = {
  Y: "Complete",
  N: "Unplanned",
  P: "Incomplete",
  "?": "No visibility",
};

export function maintenanceWindowLabel(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  return MAINTENANCE_WINDOW_LABELS[code] || String(value || "Unplanned");
}

export function maintenanceWindowStatusLabel(value: string): string {
  return ({
    planned: "Planned",
    unplanned: "Unplanned",
    incomplete: "Incomplete",
    completed: "Complete",
    no_visibility: "No visibility",
  } as Record<string, string>)[value] || value;
}
