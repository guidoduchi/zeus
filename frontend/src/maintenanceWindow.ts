const MAINTENANCE_WINDOW_LABELS: Record<string, string> = {
  Y: "Done",
  N: "Pending",
  P: "Uncompleted",
  "?": "N/A",
};

export function maintenanceWindowLabel(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase();
  return MAINTENANCE_WINDOW_LABELS[code] || String(value || "N/A");
}

export function maintenanceWindowOptionLabel(value: string): string {
  const label = maintenanceWindowLabel(value);
  return value === "P"
    ? `${value} — ${label} (carried out; follow-up pending)`
    : `${value} — ${label}`;
}
