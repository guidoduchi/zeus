import type {
  ApiErrorShape,
  BootstrapPayload,
  DashboardPayload,
  BomCatalogPayload,
  GlobalReferenceData,
  Job,
  SpareReferenceData,
  SpareRequestDetail,
  SpareRequestPrefill,
  SpareRequestView,
  SettingsPayload,
  TicketDetail,
  UserProfile,
  UserProfilePayload,
  WorkspaceKey,
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

export function getUserProfile(): Promise<UserProfilePayload> {
  return request<UserProfilePayload>("/api/profile");
}

export function saveUserProfile(profile: UserProfile): Promise<UserProfilePayload> {
  return request<UserProfilePayload>("/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ profile }),
  });
}

export function getGlobalReferenceData(): Promise<GlobalReferenceData> {
  return request<GlobalReferenceData>("/api/global-data");
}

export function saveGlobalReferenceData(value: GlobalReferenceData): Promise<GlobalReferenceData> {
  return request<GlobalReferenceData>("/api/global-data", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export function importCustomerFromTicket(ticketId: string, profile?: Record<string, unknown>): Promise<{
  data: GlobalReferenceData;
  organizationId: string;
  customerId: string;
  createdOrganization: boolean;
  createdCustomer: boolean;
}> {
  return request("/api/global-data/import-customer", {
    method: "POST",
    body: JSON.stringify({ ticketId, ...(profile ? { profile } : {}) }),
  });
}

export function getBomCatalog(): Promise<BomCatalogPayload> {
  return request<BomCatalogPayload>("/api/spare-requests/bom-catalog");
}

export function saveBomCatalog(value: BomCatalogPayload): Promise<BomCatalogPayload> {
  return request<BomCatalogPayload>("/api/spare-requests/bom-catalog", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export function getDashboard(
  workspace: WorkspaceKey,
  sort: string,
  direction: "asc" | "desc",
  search: string,
  view: SpareRequestView = "active",
): Promise<DashboardPayload> {
  const query = new URLSearchParams({ workspace, sort, direction, search, view });
  return request<DashboardPayload>(`/api/dashboard?${query}`);
}

export function getSpareRequest(requestId: string): Promise<SpareRequestDetail> {
  return request<SpareRequestDetail>(`/api/spare-requests/${requestId}`);
}

export function getSpareRequestPrefill(ticketId: string): Promise<SpareRequestPrefill> {
  return request<SpareRequestPrefill>(`/api/spare-requests/prefill/${ticketId}`);
}

export function getSpareReferenceData(): Promise<SpareReferenceData> {
  return request<SpareReferenceData>("/api/spare-requests/reference-data");
}

export function saveSpareReferenceData(value: SpareReferenceData): Promise<SpareReferenceData> {
  return request<SpareReferenceData>("/api/spare-requests/reference-data", {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

export function exportSpareRequest(payload: Record<string, unknown>): Promise<{
  request: SpareRequestDetail;
  filename: string;
  path: string;
  subject: string;
  warnings: string[];
}> {
  return request("/api/spare-requests/export", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function registerSpareRequest(payload: Record<string, unknown>): Promise<{
  request: SpareRequestDetail;
  subject: string;
  warnings: string[];
}> {
  return request("/api/spare-requests/register-manual", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function reexportSpareRequest(requestId: string): Promise<{
  request: SpareRequestDetail;
  filename: string;
  path: string;
  subject: string;
}> {
  return request(`/api/spare-requests/${requestId}/re-export`, {
    method: "POST",
    body: "{}",
  });
}

export function saveSpareRequest(
  requestId: string,
  revision: string,
  changes: Record<string, unknown>,
  itemUpdates: Array<Record<string, unknown>>,
): Promise<{ request: SpareRequestDetail }> {
  return request(`/api/spare-requests/${requestId}`, {
    method: "PATCH",
    headers: { "If-Match": revision },
    body: JSON.stringify({ revision, changes, itemUpdates }),
  });
}

export function exportSpareReturn(selections: Array<{ itemId: string; condition: "Faulty" | "New" }>): Promise<{
  filename: string;
  path: string;
  subject: string;
  warnings: string[];
}> {
  return request("/api/spare-requests/returns/export", {
    method: "POST",
    body: JSON.stringify({ selections }),
  });
}

export function archiveSpareItems(payload: {
  itemIds: string[];
  reason: "returned" | "cancelled";
  note: string;
  manualOverride?: boolean;
}): Promise<{ archived: string[]; reason: string; closedPath: string }> {
  return request("/api/spare-requests/archive", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function resolveSpareConflict(
  requestId: string,
  payload: { itemId?: string; conflictIndex: number; resolution: "keep-existing" | "accept-incoming"; note: string },
): Promise<{ request: SpareRequestDetail }> {
  return request(`/api/spare-requests/${requestId}/conflicts/resolve`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function purgeSpareArchive(itemIds: string[]): Promise<{ removed: number; remaining: number }> {
  return request("/api/spare-requests/purge", {
    method: "POST",
    body: JSON.stringify({ itemIds }),
  });
}

export function getTicket(ticketId: string): Promise<TicketDetail> {
  return request<TicketDetail>(`/api/tickets/${ticketId}`);
}

export function saveTicket(
  ticketId: string,
  revision: string,
  changes: Record<string, unknown>,
): Promise<{
  changed: boolean;
  changedFields: string[];
  ticket: TicketDetail;
}> {
  return request(`/api/tickets/${ticketId}/local`, {
    method: "PATCH",
    headers: { "If-Match": revision },
    body: JSON.stringify({ revision, changes }),
  });
}

export function saveTicketDraftBatch(edits: Array<{
  ticketId: string;
  revision: string;
  changes: Record<string, unknown>;
}>): Promise<{
  changed: boolean;
  ticketIds: string[];
  results: Array<{ ticketId: string; changed: boolean; changedFields: string[]; revision: string }>;
  tickets: Record<string, TicketDetail>;
}> {
  return request("/api/tickets/bulk-local", {
    method: "PATCH",
    body: JSON.stringify({ edits }),
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

export function migrateDataDirectory(destination: string): Promise<{
  restartRequired: boolean;
  oldPath: string;
  newPath: string;
  bytesCopied: number;
  freeBytesAfterCopy: number;
}> {
  return request("/api/storage/migrate", {
    method: "POST",
    body: JSON.stringify({ destination }),
  });
}

export function restartZeus(): Promise<{ restarting: boolean }> {
  return request("/api/system/restart", { method: "POST", body: "{}" });
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
