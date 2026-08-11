export type Risk = "none" | "grey" | "yellow" | "red";
export type WorkspaceKey = "service-requests" | "spare-requests";
export type SpareRequestView = "active" | "eligible" | "fault-tags" | "completed";

export interface ColumnDefinition {
  key: string;
  label: string;
  width: number;
  default: boolean;
  flex?: boolean;
}

export type MaintenanceWindowStatus = "planned" | "unplanned" | "incomplete" | "completed" | "no_visibility";

export interface MaintenanceWindowAttempt {
  date: string;
  outcome: "completed" | "incomplete";
  confirmed_at: string | null;
  source: string;
}

export interface MaintenanceWindowSummary {
  schemaVersion: number;
  status: MaintenanceWindowStatus;
  date: string | null;
  display: string;
  color: Risk | "green" | null;
  confirmationRequired: boolean;
  attempts: MaintenanceWindowAttempt[];
  reviewRequired: boolean;
}

export interface TicketSummary {
  rowId?: string;
  ticketId: string;
  revision: string;
  lifecycle: string;
  done: string;
  maintenanceWindow?: MaintenanceWindowSummary;
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
  spareBadges: {
    pendingDispatch: number;
    dispatched: number;
    overdue: number;
    returned: number;
  };
  summary: string;
  customerOrganization: string;
  customerContact: string;
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
  mwPlanned?: number;
  mwUnplanned?: number;
  mwIncomplete?: number;
  mwCompleted?: number;
  mwNoVisibility?: number;
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
  maintenanceWindow?: MaintenanceWindowSummary;
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
  submitted: boolean;
  submittedRequestIds: string[];
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

export interface SpareRequestItemSummary {
  rowId: string;
  requestId: string;
  revision: string | null;
  itemId: string;
  ticketId: string;
  rma: string;
  spareSr: string;
  trackingId: string;
  trackingIdProvisional: boolean;
  lifecycleStage: number;
  lifecycleStageLabel: string;
  lifecycleStageSource: string | null;
  status: string;
  statusLabel: string;
  lifecycleColor: "black" | "grey" | "green";
  dispatchAgeDays: number | null;
  dispatchAgeColor: Risk | null;
  emailInactivityDays: number | null;
  emailLabel: string;
  emailColor: Risk | null;
  emailCount: number;
  received: number;
  sent: number;
  requestedBom: string;
  deliveredBom: string;
  part: string;
  model: string;
  device: string;
  slot: string;
  faultySn: string;
  newSn: string;
  returnCondition: "Faulty" | "New" | null;
  faultTagIds: string[];
  faultTagId: string | null;
  site: string;
  siteAddress?: string;
  cloud: string;
  conflictCount: number;
  risk: Risk;
  readOnly: boolean;
  source: "active" | "closed";
  archivedAt?: string | null;
  archiveReason?: string | null;
  notes?: string | null;
  canAdvance?: boolean;
  canRollback?: boolean;
  nextStageLabel?: string | null;
  rollbackRequiresDoubleConfirmation?: boolean;
}

export interface FaultTagSummary {
  rowId: string;
  faultTagId: string;
  status: string;
  statusLabel: string;
  memberCount: number;
  coveredCount: number;
  confirmedCount: number;
  returnSite: string;
  rmas: string;
  locked: boolean;
  createdAt: string | null;
}

export interface FaultTagDetail {
  faultTagId: string;
  status: string;
  returnSite: { code: string; name: string | null; address: string; cloud: string };
  mixedSourceSites: boolean;
  members: Array<{
    itemId: string;
    requestId: string;
    ticketId: string;
    spareSr: string;
    rma: string;
    condition: "Faulty" | "New";
    sourceSite: string | null;
    requestedBom: string | null;
    newSn: string | null;
    warehouseEvidenceAt: string | null;
    userConfirmedAt: string | null;
  }>;
  export: { filename: string | null; path: string | null; subject: string; revisions: Array<Record<string, unknown>> };
  email: { sent_at: string | null; message_key: string | null; subject: string | null };
  lockedAt: string | null;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpareRequestStats {
  activeRequests: number;
  activeItems: number;
  awaitingStock: number;
  awaitingDispatch: number;
  dispatched: number;
  warehouseCandidates: number;
  conflicts: number;
  eligibleParts: number;
  completedItems: number;
}

export interface SpareRequestsDashboardPayload extends DashboardPayloadBase {
  workspace: "spare-requests";
  view: SpareRequestView;
  stats: SpareRequestStats;
  spareRequests: SpareRequestItemSummary[];
  eligibleParts: SparePartSummary[];
  faultTags: FaultTagSummary[];
}

export type DashboardPayload = ServiceRequestsDashboardPayload | SpareRequestsDashboardPayload;

export interface SpareRequestContact {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface SpareRequestProfile {
  client_initials: string;
  customer_name: string;
  customer_organization: string;
  site_code: string;
  site_name: string | null;
  site_address: string;
  cloud: string;
  requester: SpareRequestContact;
  contact: SpareRequestContact;
}

export interface SpareRequestLine {
  bom: string;
  amount: number;
  description: string;
  part: string | null;
  model: string | null;
  device: string | null;
  slot: string | null;
  slots: string[];
  faulty_sn: string | null;
  faulty_sns: string[];
  notes?: string | null;
  report_date: string | null;
  source_device_number: number | null;
  source_part_number: number | null;
}

export interface SpareRequestItem {
  item_id: string;
  ordinal: number;
  requested_bom: string;
  requested_description: string;
  part: string | null;
  model: string | null;
  device: string | null;
  slot: string | null;
  faulty_sn: string | null;
  faulty_sns: string[];
  rma: string | null;
  rma_aliases: string[];
  delivered_bom: string | null;
  new_sn: string | null;
  dispatch_at: string | null;
  attendance_confirmed_at: string | null;
  return_condition: string | null;
  return_export_filename: string | null;
  warehouse_candidate_at: string | null;
  warehouse_confirmed_at?: string | null;
  warehouse_confirmation_source?: string | null;
  rt: string | null;
  conflicts: Array<Record<string, unknown>>;
  status: string;
  statusLabel: string;
  lifecycleColor: "black" | "grey" | "green";
  dispatchAgeDays: number | null;
  dispatchAgeColor: Risk | null;
  notes: string | null;
  lifecycle: SpareLifecycle;
  rollbackRequiresDoubleConfirmation?: boolean;
}

export interface SpareLifecycleStage {
  stage: number;
  label: string;
  reached: boolean;
  timestamp: string | null;
  source: string | null;
}

export interface SpareLifecycle {
  stage: number;
  label: string;
  timestamp: string | null;
  source: string | null;
  stages: SpareLifecycleStage[];
}

export interface SpareRequestDetail {
  requestId: string;
  revision: string;
  ticketId: string;
  reportDate: string | null;
  ttEditable: boolean;
  source: "ticket" | "manual" | "recovered";
  creationMethod: "zeus_export" | "zeus_create" | "legacy_manual_sent" | "manual_confirmation" | "legacy";
  spareSr: string | null;
  trackingId: string;
  trackingIdProvisional: boolean;
  requestSentAt: string | null;
  canDelete: boolean;
  status: string;
  profile: SpareRequestProfile;
  requestLines: SpareRequestLine[];
  items: SpareRequestItem[];
  export: {
    request_filename: string | null;
    request_path: string | null;
    subject: string;
    revisions: Array<{ filename: string; path: string; created_at: string }>;
    returns: Array<Record<string, unknown>>;
  };
  email: {
    total_received: number;
    total_sent: number;
    last_activity_at: string | null;
    messages: Array<Record<string, unknown>>;
    inactivityDays: number | null;
    label: string;
    count: number;
  };
  conflicts: Array<Record<string, unknown>>;
  conflictCount: number;
  history: HistoryEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  name: string;
  email: string;
  phone: string;
  username: string | null;
  photoDataUrl: string | null;
}

export interface UserProfilePayload {
  schemaVersion: number;
  complete: boolean;
  profile: UserProfile | null;
  startup?: Record<string, unknown>;
}

export interface CustomerOrganization {
  id: string;
  name: string;
}

export interface CustomerContact {
  id: string;
  organizationId: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface ManagedSite {
  id: string;
  code: string;
  name: string | null;
  address: string;
  cloud: string | null;
}

export interface RequesterProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  username: string | null;
  pinned: boolean;
  currentUser?: boolean;
}

export interface GlobalReferenceData {
  schemaVersion: number;
  profile?: UserProfile | null;
  organizations: CustomerOrganization[];
  customers: CustomerContact[];
  sites: ManagedSite[];
  requesters: RequesterProfile[];
}

export interface BomCatalogEntry {
  id: string;
  bom: string;
  description: string;
  part: string | null;
  model: string | null;
  device: string | null;
}

export interface BomCatalogPayload {
  schemaVersion: number;
  boms: BomCatalogEntry[];
}

export interface SpareExportSetup {
  requestReady: boolean;
  returnReady: boolean;
  requestMissing: Array<{ key: string; label: string }>;
  returnMissing: Array<{ key: string; label: string }>;
}

export interface SpareReferenceData extends GlobalReferenceData {
  schemaVersion: number;
  boms: BomCatalogEntry[];
  exportSetup: SpareExportSetup;
}

export interface SpareRequestPrefill {
  ticketId: string;
  ticketExists: boolean;
  reportDate: string | null;
  profile: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  warning: string | null;
}

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
  part_number?: number;
  slot: string | null;
  part: string | null;
  bom: string | null;
  notes?: string | null;
  /** Upgrade-only fields retained from 3.1.4 records and drafts. */
  faulty_sn?: string | null;
  new_sn?: string | null;
  submitted_request_ids?: string[];
  submitted?: boolean;
  active_request_ids?: string[];
}

export interface SpareDevice {
  device_number?: number;
  device: string | null;
  model: string | null;
  notes?: string | null;
  faulty_sns?: string[];
  next_part_number?: number;
  active_request_ids?: string[];
  has_submitted_parts?: boolean;
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
  onboarding: {
    required: boolean;
    profile: UserProfile | null;
    error: string | null;
  };
  storage: {
    currentPath: string;
    dataBytes: number;
    freeBytes: number;
    minimumFreeBytes: number;
    lowSpace: boolean;
    migrationPending: boolean;
  };
  databaseMaintenance?: DatabaseMaintenanceStatus;
  maintenanceWindowsDue?: TicketSummary[];
  spareRequestExport: SpareExportSetup;
  outlook: {
    enabled: boolean;
    configuredPathAvailable: boolean;
    stagedMessageCount: number;
  };
  polling: { intervalMinutes: number; enabled: boolean };
  emailSchedule?: {
    fetchIntervalMinutes: number;
    syncMode: "scheduled" | "after_fetch";
    syncIntervalMinutes: number;
    fetchScheduled: boolean;
    syncScheduled: boolean;
  };
  appearance: { fontScale: "compact" | "standard" | "large" };
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

export interface DatabaseMaintenanceRecord {
  path?: string;
  ticketId?: string;
  message: string;
}

export interface DatabaseMaintenanceStatus {
  status: "current" | "upgrade_available" | "repair_available" | "blocked" | "busy";
  currentSchemaVersion: number;
  storedSchemaVersion: number;
  ticketCount: number;
  spareRequestCount: number;
  outdatedTicketCount: number;
  outdatedTicketIds: string[];
  repairableMarkdownCount: number;
  repairableMarkdown: string[];
  reviewCount: number;
  reviewRecords: DatabaseMaintenanceRecord[];
  blockedCount: number;
  blockedRecords: DatabaseMaintenanceRecord[];
  canApply: boolean;
  backupRequired: boolean;
  changed?: boolean;
  backup?: string | null;
  upgradedTickets?: number;
  message?: string;
  repairedMarkdown?: number;
}

export interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}
