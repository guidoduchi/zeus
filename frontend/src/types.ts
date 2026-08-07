export type Risk = "none" | "grey" | "yellow" | "red";
export type WorkspaceKey = "service-requests" | "spare-parts";

export interface ColumnDefinition {
  key: string;
  label: string;
  width: number;
  default: boolean;
  flex?: boolean;
}

export interface TicketSummary {
  rowId?: string;
  ticketId: string;
  revision: string;
  lifecycle: string;
  done: string;
  plannedDate: string;
  plannedDays: number | null;
  plannedState: string;
  plannedColor: Risk | null;
  ticketAgeDays: number | null;
  ticketAgeColor: Risk | null;
  emailInactivityDays: number | null;
  emailLabel: string;
  emailCount: number;
  emailColor: Risk | null;
  lastEmailDirection: string | null;
  received: number;
  sent: number;
  summary: string;
  severity: string;
  product: string;
  handler: string;
  status: string;
  resolveBy: string;
  resolveDays: number | null;
  site: string;
  cloud: string;
  model: string;
  device: string;
  risk: Risk;
}

export interface DashboardStats {
  active: number;
  doneY: number;
  doneN: number;
  doneP: number;
  doneUnknown: number;
  overdue: number;
  unplanned: number;
  noEmail: number;
  pendingClosure: number;
}

interface DashboardPayloadBase {
  datasetRevision: number;
  sort: string;
  direction: "asc" | "desc";
  search: string;
  columns: ColumnDefinition[];
}

export interface ServiceRequestsDashboardPayload extends DashboardPayloadBase {
  workspace: "service-requests";
  stats: DashboardStats;
  tickets: TicketSummary[];
}

export interface SparePartSummary {
  rowId: string;
  ticketId: string;
  revision: string;
  lifecycle: string;
  done: string;
  plannedDate: string;
  plannedDays: number | null;
  plannedState: string;
  plannedColor: Risk | null;
  site: string;
  cloud: string;
  deviceNumber: number;
  partNumber: number | null;
  device: string;
  model: string;
  slot: string;
  part: string;
  bom: string;
  bomColor: Risk | null;
  faultySn: string;
  newSn: string;
  summary: string;
  risk: Risk;
  hasPart: boolean;
  readOnly: boolean;
  source: "current" | "closed";
}

export interface SparePartsStats {
  tickets: number;
  currentTickets: number;
  closedTickets: number;
  devices: number;
  parts: number;
  withBom: number;
  missingBom: number;
  newSnRecorded: number;
}

export interface SparePartsDashboardPayload extends DashboardPayloadBase {
  workspace: "spare-parts";
  stats: SparePartsStats;
  spareParts: SparePartSummary[];
}

export type DashboardPayload = ServiceRequestsDashboardPayload | SparePartsDashboardPayload;

export interface EmailMessage {
  messageKey: string | null;
  timestamp: string | null;
  direction: string | null;
  subject: string;
  sender: string | null;
  body: string;
  latestReplyBody: string | null;
  quotedHistoryHidden: boolean;
  quotedHistoryLines: number;
}

export interface SparePart {
  slot: string | null;
  part: string | null;
  bom: string | null;
  faulty_sn: string | null;
  new_sn: string | null;
}

export interface SpareDevice {
  device: string | null;
  model: string | null;
  parts: SparePart[];
}

export interface HistoryEvent {
  timestamp: string | null;
  action: string | null;
  summary: Record<string, unknown>;
}

export interface MopFile {
  name: string;
  size: number;
  modifiedAt: number;
}

export interface TicketDetail extends TicketSummary {
  upstreamFields: Record<string, unknown>;
  localFields: Record<string, unknown>;
  spareParts: SpareDevice[];
  email: {
    totalReceived: number;
    totalSent: number;
    lastActivityAt: string | null;
    lastFetchedAt: string | null;
    lastSynchronizedAt: string | null;
    messages: EmailMessage[];
  };
  mop: Record<string, unknown>;
  lifecycleDetails: Record<string, unknown>;
  updatedAt: string | null;
  history: HistoryEvent[];
  mops: MopFile[];
  readOnly: boolean;
  source: "current" | "closed";
}

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  cancellable: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stage: string;
  message: string;
  current: number | null;
  total: number | null;
  result: unknown;
  error: { type: string; message: string } | null;
}

export interface BootstrapPayload {
  version: string;
  instanceId: string;
  csrfToken: string;
  localUrl: string;
  datasetRevision: number;
  eventSequence: number;
  startup: { warnings: string[]; notices: string[]; operations: Record<string, unknown> };
  jobs: Job[];
  outlook: {
    enabled: boolean;
    configuredPathAvailable: boolean;
    stagedMessageCount: number;
  };
  polling: { intervalMinutes: number; enabled: boolean };
}

export interface Setting {
  key: string;
  label: string;
  category: string;
  kind: string;
  description: string;
  minimum: number | null;
  choices: string[];
  nullable: boolean;
  editable: boolean;
  value: unknown;
  status?: { message?: string; exists?: boolean; path?: string; [key: string]: unknown };
}

export interface SettingsPayload {
  schemaVersion: number;
  settings: Setting[];
  changed?: string[];
}

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}
