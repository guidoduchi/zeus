import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  bulkSpareLifecycle,
  cancelJob,
  confirmMaintenanceWindow,
  exportSpareRequest,
  exportSpareReturn,
  getBootstrap,
  getDashboard,
  getFaultTag,
  getSpareRequest,
  getTemplates,
  getTicket,
  purgeSpareArchive,
  registerSpareRequest,
  saveTicketDraftBatch,
  saveUserProfile,
  saveTicket,
  startJob,
} from "./api";
import { BomCatalogModal } from "./components/BomCatalogModal";
import { ColumnChooser } from "./components/ColumnChooser";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { DraftsModal } from "./components/DraftsModal";
import { FilterBar } from "./components/FilterBar";
import { FaultTagDetail } from "./components/FaultTagDetail";
import { FaultTagsGrid } from "./components/FaultTagsGrid";
import { GlobalDataModal } from "./components/GlobalDataModal";
import { JobBanner } from "./components/JobBanner";
import { Modal } from "./components/Modal";
import { MaintenanceWindowPrompt, type MaintenanceWindowDecision } from "./components/MaintenanceWindowPrompt";
import { NoticeStrip } from "./components/NoticeStrip";
import { OperationsModal } from "./components/OperationsModal";
import { ProfileSetup } from "./components/ProfileSetup";
import { SettingsModal } from "./components/SettingsModal";
import { SparePartsGrid } from "./components/SparePartsGrid";
import { SpareRequestDetail } from "./components/SpareRequestDetail";
import { SpareRequestModal } from "./components/SpareRequestModal";
import { SpareRequestsGrid } from "./components/SpareRequestsGrid";
import {
  FaultTagExportDialog,
  SpareLifecycleBulkDialog,
  type FaultTagTarget,
  type SpareLifecycleTarget,
} from "./components/SpareBulkDialogs";
import { StatsBar } from "./components/StatsBar";
import { TicketDetail } from "./components/TicketDetail";
import { TicketGrid } from "./components/TicketGrid";
import { TopBar } from "./components/TopBar";
import {
  countUnsavedDrafts,
  clearDraftUndo,
  DRAFT_UNDO_CHANGED_EVENT,
  DRAFTS_CHANGED_EVENT,
  getDraftUndo,
  hasDraftUndo,
  ticketIdsWithDrafts,
  writeTicketDraft,
  type TicketDraftKind,
} from "./drafts";
import { useColumnPreferences } from "./hooks/useColumnPreferences";
import { isEditingArea, useGlobalCommands } from "./hooks/useGlobalCommands";
import { useRowFilters, type RowFilterBlueprint } from "./hooks/useRowFilters";
import { maintenanceWindowStatusLabel } from "./maintenanceWindow";
import type {
  BootstrapPayload,
  DashboardPayload,
  FaultTagDetail as FaultTagDetailType,
  FaultTagSummary,
  Job,
  SparePartSummary,
  SpareRequestDetail as SpareRequestDetailType,
  SpareRequestItemSummary,
  SpareRequestView,
  TicketSummary,
  TicketDetail as TicketDetailType,
  UserProfile,
  WorkspaceKey,
} from "./types";

type SortDirection = "asc" | "desc";

interface WorkspaceConfiguration {
  label: string;
  defaultSort: string;
  sorts: Array<{ value: string; label: string }>;
  defaultDirections: Record<string, SortDirection>;
  searchPlaceholder: string;
  columnsStorageKey: string;
}

const WORKSPACES: Record<WorkspaceKey, WorkspaceConfiguration> = {
  "service-requests": {
    label: "Service Requests",
    defaultSort: "report",
    sorts: [
      { value: "report", label: "Report" },
      { value: "sr", label: "SR" },
      { value: "planned", label: "MW date" },
      { value: "email", label: "Email" },
      { value: "age", label: "Age" },
      { value: "severity", label: "Severity" },
      { value: "status", label: "Status" },
    ],
    defaultDirections: {
      report: "asc", sr: "desc", planned: "asc", email: "desc",
      age: "desc", severity: "asc", status: "asc",
    },
    searchPlaceholder: "Search SR, summary, handler, site…",
    columnsStorageKey: "zeus3.dashboard.columns",
  },
  "spare-requests": {
    label: "Spare Requests",
    defaultSort: "tt",
    sorts: [
      { value: "tt", label: "TT" },
      { value: "tracking", label: "Tracking ID" },
      { value: "rma", label: "RMA" },
      { value: "email", label: "Email inactivity" },
      { value: "status", label: "Status" },
      { value: "age", label: "Dispatch age" },
      { value: "site", label: "Site" },
      { value: "cloud", label: "Cloud" },
      { value: "bom", label: "BOM" },
    ],
    defaultDirections: {
      tt: "desc", tracking: "desc", rma: "asc", email: "desc", status: "asc",
      age: "desc", site: "asc", cloud: "asc", bom: "asc",
    },
    searchPlaceholder: "Search TT, tracking ID, RMA, BOM, serial, site…",
    columnsStorageKey: "zeus3.spare-requests.columns",
  },
};

const SERVICE_FILTERS: Array<RowFilterBlueprint<TicketSummary>> = [
  {
    key: "mw",
    label: "MW",
    values: (row) => row.maintenanceWindow?.status || (({ N: "unplanned", P: "incomplete", Y: "completed", "?": "no_visibility" } as Record<string, string>)[row.done] || "unplanned"),
    order: ["planned", "incomplete", "unplanned", "no_visibility", "completed"],
    optionLabel: maintenanceWindowStatusLabel,
  },
  { key: "severity", label: "Severity", values: (row) => row.severity || "—" },
  { key: "customer-org", label: "Customer Org.", values: (row) => row.customerOrganization || "—" },
];

const SPARE_REQUEST_FILTERS: Array<RowFilterBlueprint<SpareRequestItemSummary>> = [
  { key: "status", label: "Status", values: (row) => row.statusLabel || row.status },
  {
    key: "dispatch-risk",
    label: "Dispatch risk",
    values: (row) => {
      if (row.dispatchAgeDays === null) return "not-started";
      if (row.dispatchAgeColor === "red") return "overdue";
      if (row.dispatchAgeColor === "yellow") return "warning";
      return "normal";
    },
    order: ["not-started", "normal", "warning", "overdue"],
    optionLabel: (value) => ({
      "not-started": "Not dispatched",
      normal: "Normal",
      warning: "Warning",
      overdue: "Overdue",
    }[value] || value),
  },
  { key: "site", label: "Site", values: (row) => row.site || "—" },
  { key: "cloud", label: "Cloud", values: (row) => row.cloud || "—" },
  {
    key: "rma-state",
    label: "Conflict / RMA",
    values: (row) => [
      row.rma && row.rma !== "—" ? "rma-assigned" : "rma-pending",
      ...(row.conflictCount > 0 ? ["conflict"] : []),
    ],
    order: ["conflict", "rma-pending", "rma-assigned"],
    optionLabel: (value) => ({
      conflict: "Has conflict",
      "rma-pending": "RMA pending",
      "rma-assigned": "RMA assigned",
    }[value] || value),
  },
];

const ELIGIBLE_PART_FILTERS: Array<RowFilterBlueprint<SparePartSummary>> = [
  {
    key: "mw",
    label: "MW",
    values: (row) => row.maintenanceWindow?.status || (({ N: "unplanned", P: "incomplete", Y: "completed", "?": "no_visibility" } as Record<string, string>)[row.done] || "unplanned"),
    order: ["planned", "incomplete", "unplanned", "no_visibility", "completed"],
    optionLabel: maintenanceWindowStatusLabel,
  },
  { key: "site", label: "Site", values: (row) => row.site || "—" },
  { key: "cloud", label: "Cloud", values: (row) => row.cloud || "—" },
];

interface WorkspacePreference {
  search: string;
  sort: string;
  direction: SortDirection;
}

function readPreference(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function workspacePreferenceKey(workspace: WorkspaceKey, name: string): string {
  const prefix = workspace === "service-requests" ? "zeus3.dashboard" : "zeus3.spare-requests";
  return `${prefix}.${name}`;
}

function dashboardCacheKey(
  workspace: WorkspaceKey,
  sort: string,
  direction: SortDirection,
  search: string,
  view: SpareRequestView,
): string {
  return JSON.stringify([workspace, sort, direction, search, view]);
}

function readWorkspace(): WorkspaceKey {
  return ["spare-requests", "spare-parts"].includes(readPreference("zeus3.workspace", "service-requests"))
    ? "spare-requests"
    : "service-requests";
}

function readWorkspacePreference(workspace: WorkspaceKey): WorkspacePreference {
  const config = WORKSPACES[workspace];
  const savedSort = readPreference(workspacePreferenceKey(workspace, "sort"), config.defaultSort);
  const sort = config.sorts.some((option) => option.value === savedSort) ? savedSort : config.defaultSort;
  const defaultDirection = config.defaultDirections[sort];
  const savedDirection = readPreference(workspacePreferenceKey(workspace, "direction"), defaultDirection);
  return {
    search: readPreference(workspacePreferenceKey(workspace, "search"), ""),
    sort,
    direction: savedDirection === "desc" ? "desc" : "asc",
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceKey>(readWorkspace);
  const [workspacePreferences, setWorkspacePreferences] = useState<Record<WorkspaceKey, WorkspacePreference>>(() => ({
    "service-requests": readWorkspacePreference("service-requests"),
    "spare-requests": readWorkspacePreference("spare-requests"),
  }));
  const [spareView, setSpareView] = useState<SpareRequestView>(() => {
    const saved = readPreference("zeus3.spare-requests.view", "active");
    return saved === "eligible" || saved === "fault-tags" || saved === "completed" ? saved : "active";
  });
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [ticket, setTicket] = useState<TicketDetailType | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [spareRequest, setSpareRequest] = useState<SpareRequestDetailType | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [faultTag, setFaultTag] = useState<FaultTagDetailType | null>(null);
  const [selectedFaultTagId, setSelectedFaultTagId] = useState<string | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [theme, setTheme] = useState(() => readPreference("zeus3.theme", "dark"));
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  const [spareExportOpen, setSpareExportOpen] = useState(false);
  const [spareExportAction, setSpareExportAction] = useState<"export" | "manual">("export");
  const [spareEmailReminder, setSpareEmailReminder] = useState<string | null>(null);
  const [globalDataOpen, setGlobalDataOpen] = useState(false);
  const [bomCatalogOpen, setBomCatalogOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [spareExportTicketId, setSpareExportTicketId] = useState<string | undefined>();
  const [spareExportPart, setSpareExportPart] = useState<SparePartSummary | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [purgeConfirmationOpen, setPurgeConfirmationOpen] = useState(false);
  const [selectedSpareItemIds, setSelectedSpareItemIds] = useState<Set<string>>(() => new Set());
  const [spareBulkDialog, setSpareBulkDialog] = useState<"advance" | "rollback" | "fault-tag" | null>(null);
  const [spareLifecycleTargets, setSpareLifecycleTargets] = useState<SpareLifecycleTarget[]>([]);
  const [faultTagTargets, setFaultTagTargets] = useState<FaultTagTarget[]>([]);
  const [spareBulkBusy, setSpareBulkBusy] = useState(false);
  const [dismissedMaintenanceWindows, setDismissedMaintenanceWindows] = useState<Set<string>>(() => new Set());
  const [maintenanceWindowBusy, setMaintenanceWindowBusy] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([]);
  const [toast, setToast] = useState<{ tone: "error" | "success" | "info"; message: string } | null>(null);
  const [draftCount, setDraftCount] = useState(countUnsavedDrafts);
  const [draftUndoAvailable, setDraftUndoAvailable] = useState(hasDraftUndo);
  const [reloadUndoPrompt, setReloadUndoPrompt] = useState(false);
  const [draftTicketIds, setDraftTicketIds] = useState<Set<string>>(ticketIdsWithDrafts);
  const [ticketInitialTab, setTicketInitialTab] = useState<"overview" | "work" | "spares">("overview");
  const searchRef = useRef<HTMLInputElement>(null);
  const dashboardRequest = useRef(0);
  const ticketDetailRequest = useRef(0);
  const spareRequestDetailRequest = useRef(0);
  const faultTagDetailRequest = useRef(0);
  const dashboardCache = useRef(new Map<string, DashboardPayload>());
  const dashboardPrefetches = useRef(new Set<string>());
  const preference = workspacePreferences[workspace];
  const { search, sort, direction } = preference;
  const workspaceConfig = WORKSPACES[workspace];
  const columnsStorageKey = workspace === "spare-requests"
    ? `${workspaceConfig.columnsStorageKey}.${spareView}`
    : workspaceConfig.columnsStorageKey;
  const { orderedColumns, visibleColumns, visibleKeys, toggle, move, reset } = useColumnPreferences(
    dashboard?.columns || [],
    columnsStorageKey,
  );
  const serviceFilters = useRowFilters(
    dashboard?.workspace === "service-requests" ? dashboard.tickets : [],
    SERVICE_FILTERS,
    "zeus3.filters.service-requests",
  );
  const spareRequestFilters = useRowFilters(
    dashboard?.workspace === "spare-requests" ? dashboard.spareRequests : [],
    SPARE_REQUEST_FILTERS,
    "zeus3.filters.spare-requests.requests",
  );
  const eligiblePartFilters = useRowFilters(
    dashboard?.workspace === "spare-requests" ? dashboard.eligibleParts : [],
    ELIGIBLE_PART_FILTERS,
    "zeus3.filters.spare-requests.eligible",
  );

  const updateWorkspacePreference = useCallback((updates: Partial<WorkspacePreference>) => {
    setWorkspacePreferences((current) => ({
      ...current,
      [workspace]: { ...current[workspace], ...updates },
    }));
  }, [workspace]);

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setToast({ tone: "error", message });
  }, []);

  const loadBootstrap = useCallback(async () => {
    const result = await getBootstrap();
    setBootstrap(result);
    setJobs(result.jobs);
    return result;
  }, []);

  const loadDashboard = useCallback(async (
    currentWorkspace = workspace,
    currentSort = sort,
    currentDirection = direction,
    currentSearch = search,
    currentView = spareView,
  ) => {
    const requestId = ++dashboardRequest.current;
    const result = await getDashboard(currentWorkspace, currentSort, currentDirection, currentSearch, currentView);
    dashboardCache.current.set(
      dashboardCacheKey(currentWorkspace, currentSort, currentDirection, currentSearch, currentView),
      result,
    );
    if (requestId === dashboardRequest.current) setDashboard(result);
    return result;
  }, [direction, search, sort, spareView, workspace]);

  const prefetchDashboard = useCallback((
    targetWorkspace: WorkspaceKey,
    targetSort: string,
    targetDirection: SortDirection,
    targetSearch: string,
    targetView: SpareRequestView,
  ) => {
    const key = dashboardCacheKey(
      targetWorkspace,
      targetSort,
      targetDirection,
      targetSearch,
      targetView,
    );
    if (dashboardCache.current.has(key) || dashboardPrefetches.current.has(key)) return;
    dashboardPrefetches.current.add(key);
    getDashboard(targetWorkspace, targetSort, targetDirection, targetSearch, targetView)
      .then((result) => dashboardCache.current.set(key, result))
      .catch(() => undefined)
      .finally(() => dashboardPrefetches.current.delete(key));
  }, []);

  const loadTicket = useCallback(async (ticketId: string) => {
    const requestId = ++ticketDetailRequest.current;
    setTicketLoading(true);
    setTicket((current) => current?.ticketId === ticketId ? current : null);
    try {
      const result = await getTicket(ticketId);
      if (requestId === ticketDetailRequest.current) setTicket(result);
    } catch (error) {
      if (requestId !== ticketDetailRequest.current) return;
      reportError(error);
      setTicket(null);
      setSelectedTicketId(null);
      setSelectedRowId(null);
    } finally {
      if (requestId === ticketDetailRequest.current) setTicketLoading(false);
    }
  }, [reportError]);

  const loadSpareRequest = useCallback(async (requestId: string) => {
    const detailRequestId = ++spareRequestDetailRequest.current;
    setTicketLoading(true);
    setSpareRequest((current) => current?.requestId === requestId ? current : null);
    try {
      const result = await getSpareRequest(requestId);
      if (detailRequestId === spareRequestDetailRequest.current) setSpareRequest(result);
    } catch (error) {
      if (detailRequestId !== spareRequestDetailRequest.current) return;
      reportError(error);
      setSpareRequest(null);
      setSelectedRequestId(null);
      setSelectedRowId(null);
    } finally {
      if (detailRequestId === spareRequestDetailRequest.current) setTicketLoading(false);
    }
  }, [reportError]);

  const loadFaultTag = useCallback(async (faultTagId: string) => {
    const detailRequestId = ++faultTagDetailRequest.current;
    setTicketLoading(true);
    setFaultTag((current) => current?.faultTagId === faultTagId ? current : null);
    try {
      const result = await getFaultTag(faultTagId);
      if (detailRequestId === faultTagDetailRequest.current) setFaultTag(result);
    } catch (error) {
      if (detailRequestId !== faultTagDetailRequest.current) return;
      reportError(error);
      setFaultTag(null);
      setSelectedFaultTagId(null);
      setSelectedRowId(null);
    } finally {
      if (detailRequestId === faultTagDetailRequest.current) setTicketLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    loadBootstrap().catch(reportError);
  }, []); // initial connection only

  useEffect(() => {
    if (!bootstrap || bootstrap.onboarding.required) return;
    getTemplates()
      .then((result) => setTemplates(result.templates))
      .catch(reportError);
  }, [bootstrap?.onboarding.required, bootstrap?.instanceId, reportError]);

  useEffect(() => {
    if (!bootstrap || bootstrap.onboarding.required) return;
    const currentDashboardMatches = dashboard?.workspace === workspace
      && (
        workspace !== "spare-requests"
        || (dashboard.workspace === "spare-requests" && dashboard.view === spareView)
      );
    const timer = window.setTimeout(
      () => loadDashboard(workspace, sort, direction, search, spareView).catch(reportError),
      currentDashboardMatches ? 140 : 0,
    );
    localStorage.setItem("zeus3.workspace", workspace);
    localStorage.setItem(workspacePreferenceKey(workspace, "sort"), sort);
    localStorage.setItem(workspacePreferenceKey(workspace, "direction"), direction);
    localStorage.setItem(workspacePreferenceKey(workspace, "search"), search);
    localStorage.setItem("zeus3.spare-requests.view", spareView);
    return () => window.clearTimeout(timer);
  }, [bootstrap?.onboarding.required, bootstrap?.instanceId, direction, loadDashboard, reportError, search, sort, spareView, workspace]);

  useEffect(() => {
    if (!bootstrap || bootstrap.onboarding.required || !dashboard) return;
    const targetWorkspace: WorkspaceKey = workspace === "service-requests"
      ? "spare-requests"
      : "service-requests";
    const target = workspacePreferences[targetWorkspace];
    prefetchDashboard(
      targetWorkspace,
      target.sort,
      target.direction,
      target.search,
      targetWorkspace === "spare-requests" ? spareView : "active",
    );
  }, [bootstrap, dashboard?.datasetRevision, prefetchDashboard, spareView, workspace, workspacePreferences]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("zeus3.theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.fontScale = bootstrap?.appearance.fontScale || "standard";
  }, [bootstrap?.appearance.fontScale]);

  useEffect(() => {
    const refreshDraftCount = () => {
      setDraftCount(countUnsavedDrafts());
      setDraftTicketIds(ticketIdsWithDrafts());
    };
    const refreshUndo = () => setDraftUndoAvailable(hasDraftUndo());
    window.addEventListener(DRAFTS_CHANGED_EVENT, refreshDraftCount);
    window.addEventListener(DRAFT_UNDO_CHANGED_EVENT, refreshUndo);
    window.addEventListener("storage", refreshDraftCount);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED_EVENT, refreshDraftCount);
      window.removeEventListener(DRAFT_UNDO_CHANGED_EVENT, refreshUndo);
      window.removeEventListener("storage", refreshDraftCount);
    };
  }, []);

  useEffect(() => {
    function protectDrafts(event: BeforeUnloadEvent) {
      if (!countUnsavedDrafts() && !hasDraftUndo()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function blockKeyboardReload(event: KeyboardEvent) {
      const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
      if (!reload || (!countUnsavedDrafts() && !hasDraftUndo())) return;
      event.preventDefault();
      if (hasDraftUndo()) {
        setReloadUndoPrompt(true);
        return;
      }
      setToast({
        tone: "info",
        message: "Reload blocked: save or discard the protected draft first.",
      });
    }
    window.addEventListener("beforeunload", protectDrafts);
    window.addEventListener("keydown", blockKeyboardReload, { capture: true });
    return () => {
      window.removeEventListener("beforeunload", protectDrafts);
      window.removeEventListener("keydown", blockKeyboardReload, { capture: true });
    };
  }, []);

  const undoDraftAction = useCallback(async () => {
    const undo = getDraftUndo();
    if (!undo) return;
    try {
      let tickets: Record<string, TicketDetailType> = {};
      if (undo.action === "save") {
        const result = await saveTicketDraftBatch(undo.inverseEdits);
        tickets = result.tickets;
      }
      for (const record of undo.records) {
        writeTicketDraft(record.ticketId, record.kind, record.draft);
      }
      clearDraftUndo();
      if (selectedTicketId && tickets[selectedTicketId]) {
        setTicket(tickets[selectedTicketId]);
      }
      await loadDashboard();
      setToast({
        tone: "success",
        message: undo.action === "save"
          ? `Undid the last Save for ${undo.ticketCount} SR(s); their protected drafts are back.`
          : `Restored the last discarded drafts for ${undo.ticketCount} SR(s).`,
      });
    } catch (error) {
      reportError(error);
    }
  }, [loadDashboard, reportError, selectedTicketId]);

  useEffect(() => {
    if (!bootstrap || bootstrap.onboarding.required) return;
    const source = new EventSource(`/api/events?after=${bootstrap.eventSequence}`);
    function receive(raw: Event) {
      const event = raw as MessageEvent<string>;
      try {
        const envelope = JSON.parse(event.data) as { type: string; payload: Record<string, unknown> };
        if (envelope.type === "job") {
          const next = envelope.payload as unknown as Job;
          setJobs((current) => [next, ...current.filter((job) => job.id !== next.id)].slice(0, 100));
          if (next.status === "failed") setToast({ tone: "error", message: `${next.label}: ${next.message}` });
        } else if (envelope.type === "dataset") {
          dashboardCache.current.clear();
          loadDashboard().catch(reportError);
          loadBootstrap().catch(reportError);
          if (selectedTicketId) loadTicket(selectedTicketId);
          if (selectedRequestId) loadSpareRequest(selectedRequestId);
          if (selectedFaultTagId) loadFaultTag(selectedFaultTagId);
        } else if (envelope.type === "configuration") {
          loadBootstrap().catch(reportError);
        }
      } catch {
        return;
      }
    }
    source.addEventListener("job", receive);
    source.addEventListener("dataset", receive);
    source.addEventListener("configuration", receive);
    return () => source.close();
  }, [bootstrap?.instanceId, bootstrap?.onboarding.required, loadBootstrap, loadDashboard, loadFaultTag, loadSpareRequest, loadTicket, reportError, selectedFaultTagId, selectedRequestId, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) {
      ticketDetailRequest.current += 1;
      setTicket(null);
      return;
    }
    loadTicket(selectedTicketId);
  }, [loadTicket, selectedTicketId]);

  useEffect(() => {
    if (!selectedRequestId) {
      spareRequestDetailRequest.current += 1;
      setSpareRequest(null);
      return;
    }
    loadSpareRequest(selectedRequestId);
  }, [loadSpareRequest, selectedRequestId]);

  useEffect(() => {
    if (!selectedFaultTagId) {
      faultTagDetailRequest.current += 1;
      setFaultTag(null);
      return;
    }
    loadFaultTag(selectedFaultTagId);
  }, [loadFaultTag, selectedFaultTagId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === "error" ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runJob = useCallback(async (kind: string, payload: Record<string, unknown> = {}) => {
    try {
      const result = await startJob(kind, payload);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      setToast({ tone: "info", message: `${result.job.label} started` });
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const stopJob = useCallback(async (jobId: string) => {
    try {
      const result = await cancelJob(jobId);
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  async function saveLocalFields(ticketId: string, revision: string, changes: Record<string, unknown>) {
    let result: Awaited<ReturnType<typeof saveTicket>>;
    try {
      result = await saveTicket(ticketId, revision, changes);
    } catch (error) {
      if (error instanceof ApiError && error.code.includes("conflict")) {
        setToast({ tone: "error", message: `${error.message} No value was overwritten.` });
        await loadTicket(ticketId);
      } else {
        reportError(error);
      }
      throw error;
    }

    setTicket(result.ticket);
    setToast({
      tone: "success",
      message: `SR ${ticketId} saved to the Zeus database. Pendings.xlsx will reflect it at the next explicit export.`,
    });
    try {
      await loadDashboard();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast({
        tone: "error",
        message: `SR ${ticketId} was saved successfully, but the dashboard reread failed: ${message}.`,
      });
    }
  }

  const activeJob = useMemo(() => jobs.find((job) => ["queued", "running"].includes(job.status)), [jobs]);
  const selectedCompletedItem = useMemo(() => {
    if (dashboard?.workspace !== "spare-requests" || dashboard.view !== "completed") return null;
    return dashboard.spareRequests.find((row) => row.rowId === selectedRowId) || null;
  }, [dashboard, selectedRowId]);
  const selectedEligiblePart = useMemo(() => {
    if (dashboard?.workspace !== "spare-requests" || dashboard.view !== "eligible") return null;
    return dashboard.eligibleParts.find((row) => row.rowId === selectedRowId) || null;
  }, [dashboard, selectedRowId]);
  const selectedActiveSpareItems = useMemo(() => {
    if (dashboard?.workspace !== "spare-requests" || dashboard.view !== "active") return [];
    return dashboard.spareRequests.filter((row) => selectedSpareItemIds.has(row.itemId));
  }, [dashboard, selectedSpareItemIds]);
  const selectedSpareStage = useMemo(() => {
    const stages = new Set(selectedActiveSpareItems.map((row) => row.lifecycleStage));
    return stages.size === 1 ? selectedActiveSpareItems[0]?.lifecycleStage ?? null : null;
  }, [selectedActiveSpareItems]);

  const summaryLifecycleTarget = useCallback((row: SpareRequestItemSummary): SpareLifecycleTarget => ({
    itemId: row.itemId,
    requestId: row.requestId,
    revision: row.revision,
    rma: row.rma,
    lifecycleStage: row.lifecycleStage,
    lifecycleStageLabel: row.lifecycleStageLabel,
    nextStageLabel: row.nextStageLabel || null,
    rollbackRequiresDoubleConfirmation: Boolean(row.rollbackRequiresDoubleConfirmation),
  }), []);

  const expandSharedLifecycleRows = useCallback((
    rows: SpareRequestItemSummary[],
    action: "advance" | "rollback",
  ) => {
    if (dashboard?.workspace !== "spare-requests" || dashboard.view !== "active") return rows;
    const sharedRequestIds = new Set(rows
      .filter((row) => (action === "advance" && row.lifecycleStage === 0) || (action === "rollback" && row.lifecycleStage === 1))
      .map((row) => row.requestId));
    if (!sharedRequestIds.size) return rows;
    const byItem = new Map(rows.map((row) => [row.itemId, row]));
    for (const row of dashboard.spareRequests) {
      if (sharedRequestIds.has(row.requestId)) byItem.set(row.itemId, row);
    }
    return [...byItem.values()];
  }, [dashboard]);

  const openSelectedSpareLifecycle = useCallback((action: "advance" | "rollback") => {
    setSpareLifecycleTargets(
      expandSharedLifecycleRows(selectedActiveSpareItems, action).map(summaryLifecycleTarget),
    );
    setSpareBulkDialog(action);
  }, [expandSharedLifecycleRows, selectedActiveSpareItems, summaryLifecycleTarget]);

  const openSelectedFaultTag = useCallback(() => {
    setFaultTagTargets(selectedActiveSpareItems.map((row) => ({
      itemId: row.itemId,
      ticketId: row.ticketId,
      rma: row.rma,
      requestedBom: row.requestedBom,
      site: row.site,
      siteAddress: row.siteAddress,
      cloud: row.cloud,
    })));
    setSpareBulkDialog("fault-tag");
  }, [selectedActiveSpareItems]);

  const openDetailSpareLifecycle = useCallback((itemId: string, action: "advance" | "rollback") => {
    if (!spareRequest) return;
    const selected = spareRequest.items.find((item) => item.item_id === itemId);
    if (!selected) return;
    const shared = (action === "advance" && selected.lifecycle.stage === 0)
      || (action === "rollback" && selected.lifecycle.stage === 1);
    const items = shared ? spareRequest.items : [selected];
    setSpareLifecycleTargets(items.map((item) => ({
      itemId: item.item_id,
      requestId: spareRequest.requestId,
      revision: spareRequest.revision,
      rma: item.rma || item.item_id,
      lifecycleStage: item.lifecycle.stage,
      lifecycleStageLabel: item.lifecycle.label,
      nextStageLabel: item.lifecycle.stages[item.lifecycle.stage + 1]?.label || null,
      rollbackRequiresDoubleConfirmation: Boolean(item.rollbackRequiresDoubleConfirmation),
    })));
    setSpareBulkDialog(action);
  }, [spareRequest]);

  const openDetailFaultTag = useCallback((itemId: string) => {
    if (!spareRequest) return;
    const item = spareRequest.items.find((value) => value.item_id === itemId);
    if (!item) return;
    setFaultTagTargets([{
      itemId,
      ticketId: spareRequest.ticketId,
      rma: item.rma || itemId,
      requestedBom: item.requested_bom,
      site: spareRequest.profile.site_code,
      siteAddress: spareRequest.profile.site_address,
      cloud: spareRequest.profile.cloud,
    }]);
    setSpareBulkDialog("fault-tag");
  }, [spareRequest]);

  const toggleBulkSpareItem = useCallback((row: SpareRequestItemSummary) => {
    setSelectedSpareItemIds((current) => {
      const next = new Set(current);
      if (next.has(row.itemId)) next.delete(row.itemId);
      else next.add(row.itemId);
      return next;
    });
  }, []);

  async function runBulkSpareLifecycle(
    action: "advance" | "rollback",
    emailOverrideConfirmed: boolean,
    note: string,
    confirmedAt?: string,
  ) {
    setSpareBulkBusy(true);
    try {
      const result = await bulkSpareLifecycle({
        itemIds: spareLifecycleTargets.map((row) => row.itemId),
        action,
        revisions: Object.fromEntries(
          spareLifecycleTargets
            .filter((row) => row.revision)
            .map((row) => [row.requestId, row.revision as string]),
        ),
        emailOverrideConfirmed,
        note,
        confirmedAt,
      });
      setSpareBulkDialog(null);
      setSpareLifecycleTargets([]);
      setSelectedSpareItemIds(new Set());
      if (result.completed.includes(selectedRowId || "")) closeDetail();
      dashboardCache.current.clear();
      await Promise.all([loadDashboard(), loadBootstrap()]);
      if (selectedRequestId && !result.completed.includes(selectedRowId || "")) {
        await loadSpareRequest(selectedRequestId);
      }
      setToast({ tone: "success", message: `${action === "advance" ? "Advanced" : "Rolled back"} ${result.items.length} item(s) one stage.` });
    } catch (error) {
      reportError(error);
    } finally {
      setSpareBulkBusy(false);
    }
  }

  async function createFaultTagFromSelection(
    selections: Array<{ itemId: string; condition: "Faulty" | "New" }>,
    returnSite?: { code: string; address: string; cloud: string },
  ) {
    setSpareBulkBusy(true);
    try {
      const result = await exportSpareReturn(selections, returnSite);
      setSpareBulkDialog(null);
      setFaultTagTargets([]);
      setSelectedSpareItemIds(new Set());
      dashboardCache.current.clear();
      await loadDashboard();
      if (selectedRequestId) await loadSpareRequest(selectedRequestId);
      setToast({ tone: "success", message: `${result.faultTagId} exported. Active Request lifecycle stages were unchanged.` });
    } catch (error) {
      reportError(error);
    } finally {
      setSpareBulkBusy(false);
    }
  }
  const overdueMaintenanceWindows = useMemo(() => {
    const candidates = dashboard?.workspace === "service-requests"
      ? dashboard.tickets
      : bootstrap?.maintenanceWindowsDue || [];
    return candidates.filter((candidate) => {
      const date = candidate.maintenanceWindow?.date;
      return candidate.maintenanceWindow?.confirmationRequired
        && Boolean(date)
        && !draftTicketIds.has(candidate.ticketId)
        && !dismissedMaintenanceWindows.has(`${candidate.ticketId}:${date}`);
    });
  }, [bootstrap?.maintenanceWindowsDue, dashboard, dismissedMaintenanceWindows, draftTicketIds]);

  function dismissMaintenanceWindow(ticket: TicketSummary) {
    const key = `${ticket.ticketId}:${ticket.maintenanceWindow?.date || ticket.plannedDate}`;
    setDismissedMaintenanceWindows((current) => new Set([...current, key]));
  }

  async function recordMaintenanceWindowBatch(decisions: MaintenanceWindowDecision[]) {
    setMaintenanceWindowBusy(true);
    try {
      let saved = 0;
      for (const decision of decisions) {
        if (decision.outcome === "later") {
          dismissMaintenanceWindow(decision.ticket);
          continue;
        }
        const plannedDate = decision.ticket.maintenanceWindow?.date;
        if (!plannedDate) continue;
        let result = await confirmMaintenanceWindow(
          decision.ticket.ticketId,
          decision.ticket.revision,
          plannedDate,
          decision.outcome === "successful",
        );
        if (decision.outcome === "incomplete" && decision.rescheduleDate) {
          result = await saveTicket(
            decision.ticket.ticketId,
            result.ticket.revision,
            { "Planned Date": decision.rescheduleDate, "Done?": "N" },
          );
        }
        dismissMaintenanceWindow(decision.ticket);
        if (selectedTicketId === decision.ticket.ticketId) setTicket(result.ticket);
        saved += 1;
      }
      dashboardCache.current.clear();
      await Promise.all([loadDashboard(), loadBootstrap()]);
      setToast({
        tone: "success",
        message: `Saved ${saved} Maintenance Window outcome${saved === 1 ? "" : "s"}. Failed dates remain in attempt history.`,
      });
    } catch (error) {
      reportError(error);
      if (error instanceof ApiError && error.code.includes("conflict")) {
        await loadDashboard().catch(reportError);
      }
    } finally {
      setMaintenanceWindowBusy(false);
    }
  }
  const chooseSort = useCallback((next: string) => {
    updateWorkspacePreference({
      sort: next,
      direction: workspaceConfig.defaultDirections[next],
    });
  }, [updateWorkspacePreference, workspaceConfig]);
  const queryData = useCallback(() => {
    if (!activeJob) void runJob("query");
  }, [activeJob, runJob]);
  const syncEmail = useCallback(() => {
    if (!activeJob && bootstrap?.outlook.configuredPathAvailable) {
      void runJob("email-fetch", { synchronize: true });
    }
  }, [activeJob, bootstrap?.outlook.configuredPathAvailable, runJob]);

  const closeDetail = useCallback(() => {
    if (!selectedTicketId && !selectedRequestId && !selectedFaultTagId) return;
    const rowId = selectedRowId;
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedFaultTagId(null);
    setTicketInitialTab("overview");
    window.requestAnimationFrame(() => {
      const selectedRow = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]"))
        .find((row) => row.dataset.rowId === rowId);
      if (selectedRow) {
        selectedRow.scrollIntoView({ block: "nearest" });
        selectedRow.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
    });
  }, [selectedFaultTagId, selectedRequestId, selectedRowId, selectedTicketId]);

  const chooseWorkspace = useCallback((next: WorkspaceKey) => {
    if (next === workspace) return;
    dashboardRequest.current += 1;
    const nextPreference = workspacePreferences[next];
    const cached = dashboardCache.current.get(dashboardCacheKey(
      next,
      nextPreference.sort,
      nextPreference.direction,
      nextPreference.search,
      next === "spare-requests" ? spareView : "active",
    ));
    setWorkspace(next);
    setDashboard(cached || null);
    setTicket(null);
    setSpareRequest(null);
    setFaultTag(null);
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedFaultTagId(null);
    setSelectedRowId(null);
    setSelectedSpareItemIds(new Set());
    setColumnsOpen(false);
    setTicketInitialTab(next === "spare-requests" ? "spares" : "overview");
  }, [spareView, workspace, workspacePreferences]);

  const informProtectedTicketMove = useCallback((nextTicketId: string | null) => {
    if (
      selectedTicketId
      && nextTicketId !== selectedTicketId
      && countUnsavedDrafts(selectedTicketId)
    ) {
      setToast({
        tone: "info",
        message: `Unsaved SR ${selectedTicketId} draft kept safely while you moved rows.`,
      });
    }
  }, [selectedTicketId]);

  const selectServiceRequest = useCallback((ticketId: string) => {
    informProtectedTicketMove(ticketId);
    setSelectedRequestId(null);
    setSelectedFaultTagId(null);
    setSelectedTicketId(ticketId);
    setSelectedRowId(ticketId);
  }, [informProtectedTicketMove]);

  const highlightServiceRequest = useCallback((ticketId: string) => {
    setSelectedRowId(ticketId);
    if (!selectedTicketId) return;
    informProtectedTicketMove(ticketId);
    setSelectedRequestId(null);
    setSelectedTicketId(ticketId);
  }, [informProtectedTicketMove, selectedTicketId]);

  const selectSparePart = useCallback((row: SparePartSummary) => {
    informProtectedTicketMove(row.ticketId);
    setSelectedRequestId(null);
    setSelectedFaultTagId(null);
    setSelectedTicketId(row.ticketId);
    setSelectedRowId(row.rowId);
    setTicketInitialTab("spares");
  }, [informProtectedTicketMove]);

  const highlightSparePart = useCallback((row: SparePartSummary) => {
    setSelectedRowId(row.rowId);
    if (!selectedTicketId) return;
    informProtectedTicketMove(row.ticketId);
    setSelectedRequestId(null);
    setSelectedTicketId(row.ticketId);
    setTicketInitialTab("spares");
  }, [informProtectedTicketMove, selectedTicketId]);

  const selectSpareRequest = useCallback((row: SpareRequestItemSummary) => {
    setSelectedTicketId(null);
    setSelectedFaultTagId(null);
    setSelectedRequestId(row.readOnly ? null : row.requestId);
    setSelectedRowId(row.rowId);
  }, []);

  const selectFaultTag = useCallback((row: FaultTagSummary) => {
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedFaultTagId(row.faultTagId);
    setSelectedRowId(row.rowId);
  }, []);

  const highlightFaultTag = useCallback((row: FaultTagSummary) => {
    setSelectedRowId(row.rowId);
    if (selectedFaultTagId) setSelectedFaultTagId(row.faultTagId);
  }, [selectedFaultTagId]);

  const highlightSpareRequest = useCallback((row: SpareRequestItemSummary) => {
    setSelectedRowId(row.rowId);
    if (!selectedRequestId || row.readOnly) return;
    setSelectedTicketId(null);
    setSelectedRequestId(row.requestId);
  }, [selectedRequestId]);

  const chooseSpareView = useCallback((next: SpareRequestView) => {
    if (next === spareView) return;
    dashboardRequest.current += 1;
    const preference = workspacePreferences["spare-requests"];
    const cached = dashboardCache.current.get(dashboardCacheKey(
      "spare-requests",
      preference.sort,
      preference.direction,
      preference.search,
      next,
    ));
    setSpareView(next);
    if (cached) setDashboard(cached);
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedFaultTagId(null);
    setSelectedRowId(null);
    setSelectedSpareItemIds(new Set());
    setTicket(null);
    setSpareRequest(null);
    setFaultTag(null);
  }, [spareView, workspacePreferences]);

  const reviewProtectedDraft = useCallback((ticketId: string, kind: TicketDraftKind) => {
    if (workspace !== "service-requests") {
      dashboardRequest.current += 1;
      const preference = workspacePreferences["service-requests"];
      setWorkspace("service-requests");
      setDashboard(dashboardCache.current.get(dashboardCacheKey(
        "service-requests",
        preference.sort,
        preference.direction,
        preference.search,
        "active",
      )) || null);
    }
    setDraftsOpen(false);
    setTicketInitialTab(kind === "spares" ? "spares" : "work");
    setSelectedRequestId(null);
    setSelectedTicketId(ticketId);
    setSelectedRowId(ticketId);
  }, [workspace, workspacePreferences]);

  const openSpareExport = useCallback((ticketId?: string, part: SparePartSummary | null = null, action: "export" | "manual" = "export") => {
    setSpareExportTicketId(ticketId);
    setSpareExportPart(part);
    setSpareExportAction(action);
    setSpareExportOpen(true);
  }, []);

  const completeOnboarding = useCallback(async (profile: UserProfile) => {
    await saveUserProfile(profile);
    const next = await loadBootstrap();
    if (!next.onboarding.required) {
      const [templateResult] = await Promise.all([
        getTemplates(),
        loadDashboard(workspace, sort, direction, search, spareView),
      ]);
      setTemplates(templateResult.templates);
      setToast({ tone: "success", message: "Profile saved locally. Welcome to Zeus." });
    }
  }, [direction, loadBootstrap, loadDashboard, search, sort, spareView, workspace]);

  const createSpareRequest = useCallback(async (payload: Record<string, unknown>) => {
    const result = await exportSpareRequest(payload);
    setWorkspace("spare-requests");
    setSpareView("active");
    setSelectedTicketId(null);
    setSelectedRequestId(result.request.requestId);
    setSelectedRowId(result.request.items[0]?.item_id || null);
    setSpareRequest(result.request);
    setSpareExportOpen(false);
    try { await navigator.clipboard.writeText(result.subject); } catch { /* The exported file remains complete. */ }
    setToast({ tone: result.warnings.length ? "info" : "success", message: `Exported ${result.filename}. Email subject copied.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}` });
    setSpareEmailReminder(result.filename);
    await loadDashboard("spare-requests", "tt", "desc", "", "active");
  }, [loadDashboard]);

  const registerManualSpareRequest = useCallback(async (payload: Record<string, unknown>) => {
    const result = await registerSpareRequest(payload);
    setWorkspace("spare-requests");
    setSpareView("active");
    setSelectedTicketId(null);
    setSelectedRequestId(result.request.requestId);
    setSelectedRowId(result.request.items[0]?.item_id || null);
    setSpareRequest(result.request);
    setSpareExportOpen(false);
    setToast({
      tone: result.warnings.length ? "info" : "success",
      message: `New request created at Added to Zeus.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`,
    });
    await loadDashboard("spare-requests", "tt", "desc", "", "active");
  }, [loadDashboard]);

  async function purgeSelectedCompleted() {
    if (!selectedCompletedItem) return;
    try {
      const result = await purgeSpareArchive([selectedCompletedItem.itemId]);
      setPurgeConfirmationOpen(false);
      setSelectedRowId(null);
      setToast({ tone: "success", message: `Purged ${result.removed} completed Spare Request item(s) and associated retained email.` });
      await loadDashboard();
    } catch (error) {
      reportError(error);
    }
  }

  const keyboardDisabled = operationsOpen || settingsOpen || spareExportOpen || Boolean(spareEmailReminder) || globalDataOpen || bomCatalogOpen || draftsOpen || purgeConfirmationOpen || Boolean(bootstrap?.onboarding.required);

  useGlobalCommands({
    disabled: keyboardDisabled,
    queryDisabled: Boolean(activeJob) || workspace !== "service-requests",
    syncDisabled: Boolean(activeJob) || !Boolean(bootstrap?.outlook.configuredPathAvailable),
    onSearch: () => searchRef.current?.focus(),
    onSync: syncEmail,
    onOperations: () => setOperationsOpen(true),
    onQuery: queryData,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        keyboardDisabled
        || (!selectedTicketId && !selectedRequestId && !selectedFaultTagId)
        || event.defaultPrevented
        || event.isComposing
        || event.repeat
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.key !== "Escape"
        || document.querySelector(".modal-backdrop")
      ) return;
      event.preventDefault();
      closeDetail();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, keyboardDisabled, selectedFaultTagId, selectedRequestId, selectedTicketId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        keyboardDisabled
        || event.defaultPrevented
        || event.isComposing
        || event.repeat
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || isEditingArea(event.target)
        || (event.target instanceof Element && Boolean(event.target.closest('[role="grid"]')))
      ) return;
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!delta || !dashboard) return;

      function nextIndex(rows: Array<{ rowId: string }>): number {
        if (!rows.length) return -1;
        const current = selectedRowId ? rows.findIndex((row) => row.rowId === selectedRowId) : -1;
        if (current < 0) return delta > 0 ? 0 : rows.length - 1;
        return Math.max(0, Math.min(rows.length - 1, current + delta));
      }

      let nextRowId: string | null = null;
      if (dashboard.workspace === "service-requests") {
        const index = nextIndex(serviceFilters.filteredRows.map((row) => ({ rowId: row.ticketId })));
        const next = serviceFilters.filteredRows[index];
        if (next) {
          nextRowId = next.ticketId;
          highlightServiceRequest(next.ticketId);
        }
      } else if (dashboard.view === "eligible") {
        const index = nextIndex(eligiblePartFilters.filteredRows);
        const next = eligiblePartFilters.filteredRows[index];
        if (next) {
          nextRowId = next.rowId;
          highlightSparePart(next);
        }
      } else if (dashboard.view === "fault-tags") {
        const index = nextIndex(dashboard.faultTags);
        const next = dashboard.faultTags[index];
        if (next) {
          nextRowId = next.rowId;
          highlightFaultTag(next);
        }
      } else {
        const index = nextIndex(spareRequestFilters.filteredRows);
        const next = spareRequestFilters.filteredRows[index];
        if (next) {
          nextRowId = next.rowId;
          highlightSpareRequest(next);
        }
      }
      if (!nextRowId) return;
      event.preventDefault();
      window.requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>(`[data-row-id="${nextRowId}"]`);
        row?.focus({ preventScroll: true });
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    dashboard,
    eligiblePartFilters.filteredRows,
    highlightServiceRequest,
    highlightFaultTag,
    highlightSparePart,
    highlightSpareRequest,
    keyboardDisabled,
    selectedRowId,
    serviceFilters.filteredRows,
    spareRequestFilters.filteredRows,
  ]);

  const warnings = bootstrap?.startup.warnings || [];
  const notices = bootstrap?.startup.notices || [];

  if (!bootstrap) {
    return (
      <main className="boot-screen">
        <span className="boot-bolt">ϟ</span>
        <h1>ZEUS 3</h1>
        <p>Starting the local workstation…</p>
      </main>
    );
  }

  if (bootstrap.onboarding.required) {
    return <>
      <ProfileSetup
        initial={bootstrap.onboarding.profile}
        error={bootstrap.onboarding.error}
        onSave={completeOnboarding}
        onError={reportError}
      />
      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.message}</span><button type="button" onClick={() => setToast(null)}>×</button></div>}
    </>;
  }

  if (!dashboard) {
    return (
      <main className="boot-screen">
        <span className="boot-bolt">ϟ</span>
        <h1>ZEUS 3</h1>
        <p>Opening the local workbench…</p>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${selectedTicketId || selectedRequestId || selectedFaultTagId ? "with-detail" : ""}`}
      data-workspace={workspace}
      data-spare-view={workspace === "spare-requests" ? spareView : undefined}
    >
      <TopBar
        version={bootstrap.version || "3.1.9"}
        detailOpen={Boolean(selectedTicketId || selectedRequestId || selectedFaultTagId)}
        workspace={workspace}
        stagedMessages={bootstrap?.outlook.stagedMessageCount || 0}
        onWorkspaceChange={chooseWorkspace}
        onData={() => setGlobalDataOpen(true)}
        onOperations={() => setOperationsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
      />
      <NoticeStrip
        warnings={warnings}
        notices={notices}
        outlookEnabled={Boolean(bootstrap?.outlook.enabled)}
        outlookAvailable={Boolean(bootstrap?.outlook.configuredPathAvailable)}
        onSettings={() => setSettingsOpen(true)}
      />
      <JobBanner jobs={jobs} onCancel={stopJob} onOpenActivity={() => setOperationsOpen(true)} />
      <StatsBar dashboard={dashboard} />
      <section className="dashboard-toolbar">
        {workspace === "spare-requests" && <div className="spare-view-row"><div className="spare-view-switcher" role="tablist" aria-label="Spare Request view">{(["active", "eligible", "fault-tags", "completed"] as SpareRequestView[]).map((view) => <button type="button" role="tab" aria-selected={spareView === view} className={spareView === view ? "active" : ""} onClick={() => chooseSpareView(view)} key={view}>{view === "active" ? "Active Requests" : view === "eligible" ? "Eligible SR Parts" : view === "fault-tags" ? "Fault Tags" : "Completed"}</button>)}</div></div>}
        <div className="dashboard-controls">
          <label className="search-box">
            <span>⌕</span>
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => updateWorkspacePreference({ search: event.target.value })}
              placeholder={workspaceConfig.searchPlaceholder}
            />
            {search && <button type="button" onClick={() => updateWorkspacePreference({ search: "" })} aria-label="Clear search">×</button>}
          </label>
          {dashboard.workspace === "service-requests" ? (
            <FilterBar definitions={serviceFilters.definitions} selections={serviceFilters.selections} activeCount={serviceFilters.activeCount} onToggle={serviceFilters.toggle} onClear={serviceFilters.clear} />
          ) : dashboard.view === "eligible" ? (
            <FilterBar definitions={eligiblePartFilters.definitions} selections={eligiblePartFilters.selections} activeCount={eligiblePartFilters.activeCount} onToggle={eligiblePartFilters.toggle} onClear={eligiblePartFilters.clear} />
          ) : dashboard.view !== "fault-tags" ? (
            <FilterBar definitions={spareRequestFilters.definitions} selections={spareRequestFilters.selections} activeCount={spareRequestFilters.activeCount} onToggle={spareRequestFilters.toggle} onClear={spareRequestFilters.clear} />
          ) : null}
          <div className="columns-anchor">
            <button type="button" className="toolbar-button compactable-button" aria-label="Fields" title="Fields" aria-expanded={columnsOpen} onClick={() => setColumnsOpen((value) => !value)}><span className="toolbar-icon" aria-hidden="true">⚙</span><span className="toolbar-label">Fields</span></button>
            {columnsOpen && <ColumnChooser columns={orderedColumns} visibleKeys={visibleKeys} onToggle={toggle} onMove={move} onReset={reset} onClose={() => setColumnsOpen(false)} />}
          </div>
          <div className="sort-control" role="group" aria-label="Dashboard sorting">
            <label>Sort
              <select aria-label="Sort field" value={sort} onChange={(event) => chooseSort(event.target.value)}>
                {workspaceConfig.sorts.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <select aria-label="Sort direction" value={direction} onChange={(event) => updateWorkspacePreference({ direction: event.target.value as SortDirection })}>
              <option value="asc">↑ Ascending</option>
              <option value="desc">↓ Descending</option>
            </select>
          </div>
          {workspace === "service-requests" && <button type="button" className="toolbar-button compactable-button" aria-label="Check Advanced Search" title="Check Advanced Search" onClick={queryData} disabled={Boolean(activeJob)}><span className="toolbar-icon" aria-hidden="true">↻</span><span className="toolbar-label">Check Advanced Search</span></button>}
          {workspace === "spare-requests" && <>
            <button type="button" className="toolbar-button compactable-button" aria-label="New Request" title="New Request" onClick={() => openSpareExport()}><span className="toolbar-icon" aria-hidden="true">+</span><span className="toolbar-label">New Request</span></button>
            <button type="button" className="toolbar-button compactable-button" aria-label="BOM catalog" title="BOM catalog" onClick={() => setBomCatalogOpen(true)}><span className="toolbar-icon" aria-hidden="true">▤</span><span className="toolbar-label">BOM catalog</span></button>
            {spareView === "active" && selectedActiveSpareItems.length > 0 && selectedSpareStage !== null && <>
              {[0, 1, 2, 3, 5].includes(selectedSpareStage) && <button type="button" className={`toolbar-button compactable-button stage-action stage-${selectedSpareStage}`} disabled={selectedActiveSpareItems.some((row) => !row.canAdvance)} title="Advance every selected item exactly one stage" onClick={() => openSelectedSpareLifecycle("advance")}><span className="toolbar-icon" aria-hidden="true">✓</span><span className="toolbar-label">{({ 0: "Confirm email sent", 1: "Confirm SR + RMA", 2: "Confirm dispatched", 3: "Confirm replaced", 5: "Confirm return" } as Record<number, string>)[selectedSpareStage]} ({selectedActiveSpareItems.length})</span></button>}
              {selectedSpareStage === 4 && <button type="button" className="toolbar-button compactable-button stage-action stage-fault-tag" disabled={selectedActiveSpareItems.some((row) => Boolean(row.faultTagId))} title="Only Spare replaced items not already in a Fault Tag can be exported" onClick={openSelectedFaultTag}><span className="toolbar-icon" aria-hidden="true">⬒</span><span className="toolbar-label">Export Fault Tag ({selectedActiveSpareItems.length})</span></button>}
              {selectedSpareStage > 0 && <button type="button" className="toolbar-button compactable-button rollback-action" disabled={selectedActiveSpareItems.some((row) => !row.canRollback)} title="Roll back every selected item exactly one stage" onClick={() => openSelectedSpareLifecycle("rollback")}><span className="toolbar-icon" aria-hidden="true">↶</span><span className="toolbar-label">Roll back</span></button>}
            </>}
            {spareView === "completed" && <button type="button" className="toolbar-button compactable-button danger-text" aria-label="Purge selected" title="Purge selected" disabled={!selectedCompletedItem} onClick={() => setPurgeConfirmationOpen(true)}><span className="toolbar-icon" aria-hidden="true">⌫</span><span className="toolbar-label">Purge selected</span></button>}
          </>}
        </div>
      </section>
      <section className="workspace">
        {dashboard?.workspace === "spare-requests" ? (
          dashboard.view === "eligible" ? <SparePartsGrid
            rows={eligiblePartFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            draftTicketIds={draftTicketIds}
            detailOpen={Boolean(selectedTicketId || selectedRequestId || selectedFaultTagId)}
            onHighlight={highlightSparePart}
            onOpen={(row) => { selectSparePart(row); openSpareExport(row.ticketId, row); }}
            onCloseDetail={closeDetail}
          /> : dashboard.view === "fault-tags" ? <FaultTagsGrid
            rows={dashboard.faultTags}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            detailOpen={Boolean(selectedTicketId || selectedRequestId || selectedFaultTagId)}
            onHighlight={highlightFaultTag}
            onOpen={selectFaultTag}
            onCloseDetail={closeDetail}
          /> : <SpareRequestsGrid
            rows={spareRequestFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            detailOpen={Boolean(selectedTicketId || selectedRequestId || selectedFaultTagId)}
            onHighlight={highlightSpareRequest}
            onOpen={selectSpareRequest}
            onCloseDetail={closeDetail}
            bulkSelectedRowIds={spareView === "active" ? selectedSpareItemIds : undefined}
            onToggleBulk={spareView === "active" ? toggleBulkSpareItem : undefined}
          />
        ) : (
          <TicketGrid
            tickets={serviceFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            draftTicketIds={draftTicketIds}
            detailOpen={Boolean(selectedTicketId || selectedRequestId || selectedFaultTagId)}
            onHighlight={highlightServiceRequest}
            onOpen={selectServiceRequest}
            onCloseDetail={closeDetail}
          />
        )}
        {selectedTicketId && <TicketDetail
          ticket={ticket}
          loading={ticketLoading}
          initialTab={workspace === "spare-requests" ? "spares" : ticketInitialTab}
          templates={templates}
          onClose={closeDetail}
          onSave={saveLocalFields}
          onGenerateMop={(ticketId, template) => runJob("mop", { ticketId, template })}
          onExportSpareRequest={(ticketId) => openSpareExport(ticketId, selectedEligiblePart?.ticketId === ticketId ? selectedEligiblePart : null)}
          onRegisterSpareRequest={(ticketId) => openSpareExport(ticketId, selectedEligiblePart?.ticketId === ticketId ? selectedEligiblePart : null, "manual")}
        />}
        {selectedRequestId && <SpareRequestDetail
          request={spareRequest}
          loading={ticketLoading}
          onClose={closeDetail}
          onChanged={(value) => { setSpareRequest(value); if (!value) { setSelectedRequestId(null); setSelectedRowId(null); } }}
          onRefresh={async () => { await loadDashboard(); }}
          onError={reportError}
          onNotice={(message) => setToast({ tone: "success", message })}
          onLifecycle={openDetailSpareLifecycle}
          onFaultTag={openDetailFaultTag}
        />}
        {selectedFaultTagId && <FaultTagDetail
          faultTag={faultTag}
          loading={ticketLoading}
          onClose={closeDetail}
          onChanged={(value) => { setFaultTag(value); if (!value) { setSelectedFaultTagId(null); setSelectedRowId(null); } }}
          onRefresh={async () => { await loadDashboard(); }}
          onError={reportError}
          onNotice={(message) => setToast({ tone: "success", message })}
        />}
      </section>
      <footer className="command-strip">
        <span>↑↓ Select</span>
        <span>←→ Detail tab</span>
        <span>Double-click/Enter Open · Esc Close</span>
        <span>Ctrl+F Search</span>
        <span className={!bootstrap?.outlook.configuredPathAvailable ? "disabled-command" : undefined}>S Fetch + sync email</span>
        <span>M Operations</span>
        {workspace === "service-requests" && <span>R Check source</span>}
        <span className="footer-state">{activeJob ? activeJob.message : <>{draftCount > 0 && <button type="button" className="footer-draft-button" onClick={() => setDraftsOpen(true)}>✎ {draftCount} protected draft{draftCount === 1 ? "" : "s"}</button>}{draftUndoAvailable && <button type="button" className="footer-draft-button undo" onClick={() => void undoDraftAction()}>↶ Undo last draft action</button>}<span>{workspaceConfig.label} · Local database{workspace === "service-requests" ? ` · ${bootstrap?.polling.intervalMinutes ?? 15} min Advanced Search check` : ""}</span></>}</span>
      </footer>
      {operationsOpen && (
        <OperationsModal
          jobs={jobs}
          outlookEnabled={Boolean(bootstrap?.outlook.enabled)}
          outlookAvailable={Boolean(bootstrap?.outlook.configuredPathAvailable)}
          onClose={() => setOperationsOpen(false)}
          onSettings={() => { setOperationsOpen(false); setSettingsOpen(true); }}
          onRun={runJob}
          onCancel={stopJob}
          onError={reportError}
        />
      )}
      {spareExportOpen && <SpareRequestModal initialTicketId={spareExportTicketId} initialPart={spareExportPart} initialAction={spareExportAction} configurationRevision={configurationRevision} suspended={settingsOpen} onClose={() => setSpareExportOpen(false)} onExport={createSpareRequest} onRegisterManual={registerManualSpareRequest} onExportSetupRequired={(missing) => {
        setToast({
          tone: "info",
          message: `Configure ${missing.join(" and ") || "the Spare Request export paths"} before exporting.`,
        });
        setSettingsOpen(true);
      }} onError={reportError} />}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setConfigurationRevision((current) => current + 1);
            loadBootstrap().catch(reportError);
            loadDashboard().catch(reportError);
          }}
          onError={reportError}
        />
      )}
      {globalDataOpen && <GlobalDataModal onClose={() => setGlobalDataOpen(false)} onSaved={() => { loadBootstrap().catch(reportError); setToast({ tone: "success", message: "Global data saved locally." }); }} onError={reportError} />}
      {draftsOpen && <DraftsModal onClose={() => setDraftsOpen(false)} onReview={reviewProtectedDraft} onSaved={(tickets) => { if (selectedTicketId && tickets[selectedTicketId]) setTicket(tickets[selectedTicketId]); loadDashboard().catch(reportError); }} onError={reportError} onNotice={(message) => setToast({ tone: "success", message })} />}
      {bomCatalogOpen && <BomCatalogModal onClose={() => setBomCatalogOpen(false)} onSaved={() => setToast({ tone: "success", message: "BOM catalog saved locally." })} onError={reportError} />}
      {purgeConfirmationOpen && selectedCompletedItem && <ConfirmationDialog title={`Purge ${selectedCompletedItem.itemId}?`} message="This permanently removes the completed item and its retained email from the local archive. This action cannot be undone." confirmLabel="Permanently purge" tone="danger" onCancel={() => setPurgeConfirmationOpen(false)} onConfirm={() => void purgeSelectedCompleted()} />}
      {reloadUndoPrompt && <ConfirmationDialog title="Reload and lose Undo?" message="Reloading now permanently removes the one-time Undo for your last Save or Discard. Existing protected drafts remain in browser storage." confirmLabel="Reload anyway" tone="danger" onCancel={() => setReloadUndoPrompt(false)} onConfirm={() => { clearDraftUndo(); window.location.reload(); }} />}
      {(spareBulkDialog === "advance" || spareBulkDialog === "rollback") && <SpareLifecycleBulkDialog rows={spareLifecycleTargets} action={spareBulkDialog} busy={spareBulkBusy} onCancel={() => { setSpareBulkDialog(null); setSpareLifecycleTargets([]); }} onConfirm={(emailOverrideConfirmed, note, confirmedAt) => void runBulkSpareLifecycle(spareBulkDialog, emailOverrideConfirmed, note, confirmedAt)} />}
      {spareBulkDialog === "fault-tag" && <FaultTagExportDialog rows={faultTagTargets} busy={spareBulkBusy} onCancel={() => { setSpareBulkDialog(null); setFaultTagTargets([]); }} onConfirm={(selections, returnSite) => void createFaultTagFromSelection(selections, returnSite)} />}
      {overdueMaintenanceWindows.length > 0 && !settingsOpen && !operationsOpen && !globalDataOpen && !bomCatalogOpen && !draftsOpen && !spareExportOpen && !purgeConfirmationOpen && !spareEmailReminder && <MaintenanceWindowPrompt
        tickets={overdueMaintenanceWindows}
        busy={maintenanceWindowBusy}
        onClose={() => overdueMaintenanceWindows.forEach(dismissMaintenanceWindow)}
        onSubmit={(decisions) => void recordMaintenanceWindowBatch(decisions)}
      />}
      {spareEmailReminder && !spareExportOpen && <Modal
        title="Spare Request created"
        subtitle="The request is now registered in Active Requests."
        dismissible={false}
        onClose={() => undefined}
        actions={<button type="button" className="primary-button" autoFocus onClick={() => setSpareEmailReminder(null)}>OK</button>}
      >
        <section className="local-confirmation">
          <p><strong>{spareEmailReminder}</strong> was exported successfully. Please do not forget to attach it and send the email.</p>
        </section>
      </Modal>}
      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.message}</span><button type="button" onClick={() => setToast(null)}>×</button></div>}
    </main>
  );
}
