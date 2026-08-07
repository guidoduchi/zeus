import type {
  ApiErrorShape,
  BootstrapPayload,
  DashboardPayload,
  Job,
  SettingsPayload,
  TicketDetail,
} from "./types";

let csrfToken = "";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, payload: ApiErrorShape) {
    super(payload.error?.message || `Zeus request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.error?.code || "request_failed";
    this.details = payload.error?.details || {};
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (options.method && options.method !== "GET") {
    headers.set("X-Zeus-CSRF", csrfToken);
  }
  const response = await fetch(path, { ...options, headers });
  const payload = (await response.json()) as T & ApiErrorShape;
  if (!response.ok) {
    throw new ApiError(response.status, payload);
  }
  return payload;
}

export async function getBootstrap(): Promise<BootstrapPayload> {
  const payload = await request<BootstrapPayload>("/api/bootstrap");
  csrfToken = payload.csrfToken;
  return payload;
}

export function getDashboard(sort: string, search: string): Promise<DashboardPayload> {
  const query = new URLSearchParams({ sort, search });
  return request<DashboardPayload>(`/api/dashboard?${query}`);
}

export function getTicket(ticketId: string): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${ticketId}`);
}

export function saveTicket(
  ticketId: string,
  revision: string,
  changes: Record<string, unknown>,
): Promise<{ changed: boolean; changedFields: string[]; ticket: TicketDetail }> {
  return request(`/api/tickets/${ticketId}/local`, {
    method: "PATCH",
    headers: { "If-Match": revision },
    body: JSON.stringify({ revision, changes }),
  });
}

export function getSettings(): Promise<SettingsPayload> {
  return request<SettingsPayload>("/api/settings");
}

export function saveSettings(updates: Record<string, unknown>): Promise<SettingsPayload> {
  return request<SettingsPayload>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ updates }),
  });
}

export function startJob(kind: string, payload: Record<string, unknown> = {}): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/api/jobs/${kind}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelJob(jobId: string): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/api/jobs/${jobId}/cancel`, {
    method: "POST",
    body: "{}",
  });
}

export function browsePath(setting: string): Promise<{ cancelled: boolean; path: string | null }> {
  return request("/api/dialogs/path", {
    method: "POST",
    body: JSON.stringify({ setting }),
  });
}

export function openPath(setting: string): Promise<{ opened: boolean }> {
  return request("/api/paths/open", {
    method: "POST",
    body: JSON.stringify({ setting }),
  });
}

export function getTemplates(): Promise<{ templates: Array<{ name: string; path: string; size: number }> }> {
  return request("/api/templates");
}

export function getBackups(): Promise<{ backups: Array<{ name: string; size: number; modifiedAt: number }> }> {
  return request("/api/backups/pendings");
}

export function previewBackup(name: string): Promise<{
  preview: {
    applicable_ids: string[];
    changed_ids: string[];
    ignored_closed_or_unknown_ids: string[];
    protected_fields_restored: boolean;
    email_restored: boolean;
  };
}> {
  return request(`/api/backups/pendings/preview?${new URLSearchParams({ name })}`);
}

export function stopZeus(): Promise<{ stopping: boolean }> {
  return request("/api/system/shutdown", { method: "POST", body: "{}" });
}
