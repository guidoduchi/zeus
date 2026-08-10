import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelJob,
  exportSpareRequest,
  getBootstrap,
  getDashboard,
  getSpareRequest,
  getTemplates,
  getTicket,
  purgeSpareArchive,
  registerSpareRequest,
  saveUserProfile,
  saveTicket,
  startJob,
} from "./api";
import { BomCatalogModal } from "./components/BomCatalogModal";
import { ColumnChooser } from "./components/ColumnChooser";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { DraftsModal } from "./components/DraftsModal";
import { FilterBar } from "./components/FilterBar";
import { GlobalDataModal } from "./components/GlobalDataModal";
import { JobBanner } from "./components/JobBanner";
import { Modal } from "./components/Modal";
import { NoticeStrip } from "./components/NoticeStrip";
import { OperationsModal } from "./components/OperationsModal";
import { ProfileSetup } from "./components/ProfileSetup";
import { SettingsModal } from "./components/SettingsModal";
import { SparePartsGrid } from "./components/SparePartsGrid";
import { SpareRequestDetail } from "./components/SpareRequestDetail";
import { SpareRequestModal } from "./components/SpareRequestModal";
import { SpareRequestsGrid } from "./components/SpareRequestsGrid";
import { StatsBar } from "./components/StatsBar";
import { TicketDetail } from "./components/TicketDetail";
import { TicketGrid } from "./components/TicketGrid";
import { TopBar } from "./components/TopBar";
import {
  countUnsavedDrafts,
  DRAFTS_CHANGED_EVENT,
  ticketIdsWithDrafts,
  type TicketDraftKind,
} from "./drafts";
import { useColumnPreferences } from "./hooks/useColumnPreferences";
import { isEditingArea, useGlobalCommands } from "./hooks/useGlobalCommands";
import { useRowFilters, type RowFilterBlueprint } from "./hooks/useRowFilters";
import { maintenanceWindowOptionLabel } from "./maintenanceWindow";
import type {
  BootstrapPayload,
  DashboardPayload,
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
      { value: "planned", label: "Planned" },
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
    key: "planning",
    label: "Planning",
    values: (row) => row.plannedState === "unplanned" ? "unplanned" : "planned",
    order: ["planned", "unplanned"],
    optionLabel: (value) => value === "planned" ? "Planned" : "Unplanned",
  },
  {
    key: "mw",
    label: "MW",
    values: (row) => row.done || "N",
    order: ["N", "P", "Y", "?"],
    optionLabel: maintenanceWindowOptionLabel,
  },
  { key: "severity", label: "Severity", values: (row) => row.severity || "—" },
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
    key: "planning",
    label: "Planning",
    values: (row) => row.plannedState === "unplanned" ? "unplanned" : "planned",
    order: ["planned", "unplanned"],
    optionLabel: (value) => value === "planned" ? "Planned" : "Unplanned",
  },
  {
    key: "mw",
    label: "MW",
    values: (row) => row.done || "N",
    order: ["N", "P", "Y", "?"],
    optionLabel: maintenanceWindowOptionLabel,
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
    return saved === "eligible" || saved === "completed" ? saved : "active";
  });
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [ticket, setTicket] = useState<TicketDetailType | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [spareRequest, setSpareRequest] = useState<SpareRequestDetailType | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
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
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([]);
  const [toast, setToast] = useState<{ tone: "error" | "success" | "info"; message: string } | null>(null);
  const [draftCount, setDraftCount] = useState(countUnsavedDrafts);
  const [draftTicketIds, setDraftTicketIds] = useState<Set<string>>(ticketIdsWithDrafts);
  const [ticketInitialTab, setTicketInitialTab] = useState<"overview" | "work" | "spares">("overview");
  const searchRef = useRef<HTMLInputElement>(null);
  const dashboardRequest = useRef(0);
  const ticketDetailRequest = useRef(0);
  const spareRequestDetailRequest = useRef(0);
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
    window.addEventListener(DRAFTS_CHANGED_EVENT, refreshDraftCount);
    window.addEventListener("storage", refreshDraftCount);
    return () => {
      window.removeEventListener(DRAFTS_CHANGED_EVENT, refreshDraftCount);
      window.removeEventListener("storage", refreshDraftCount);
    };
  }, []);

  useEffect(() => {
    function protectDrafts(event: BeforeUnloadEvent) {
      if (!countUnsavedDrafts()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function blockKeyboardReload(event: KeyboardEvent) {
      const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
      if (!reload || !countUnsavedDrafts()) return;
      event.preventDefault();
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
  }, [bootstrap?.instanceId, bootstrap?.onboarding.required, loadBootstrap, loadDashboard, loadSpareRequest, loadTicket, reportError, selectedRequestId, selectedTicketId]);

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
  const chooseSort = useCallback((next: string) => {
    updateWorkspacePreference({
      sort: next,
      direction: workspaceConfig.defaultDirections[next],
    });
  }, [updateWorkspacePreference, workspaceConfig]);
  const cycleSort = useCallback(() => {
    const values = workspaceConfig.sorts.map((option) => option.value);
    const next = values[(values.indexOf(sort) + 1) % values.length];
    chooseSort(next);
  }, [chooseSort, sort, workspaceConfig.sorts]);
  const queryData = useCallback(() => {
    if (!activeJob) void runJob("query");
  }, [activeJob, runJob]);

  const closeDetail = useCallback(() => {
    if (!selectedTicketId && !selectedRequestId) return;
    const rowId = selectedRowId;
    setSelectedTicketId(null);
    setSelectedRequestId(null);
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
  }, [selectedRequestId, selectedRowId, selectedTicketId]);

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
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedRowId(null);
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
    setSelectedRequestId(row.readOnly ? null : row.requestId);
    setSelectedRowId(row.rowId);
  }, []);

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
    setSelectedRowId(null);
    setTicket(null);
    setSpareRequest(null);
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
      message: `Manually sent request registered in Active Requests.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`,
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
    queryDisabled: Boolean(activeJob),
    onSearch: () => searchRef.current?.focus(),
    onSort: cycleSort,
    onOperations: () => setOperationsOpen(true),
    onQuery: queryData,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        keyboardDisabled
        || (!selectedTicketId && !selectedRequestId)
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
  }, [closeDetail, keyboardDisabled, selectedRequestId, selectedTicketId]);

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
      className={`app-shell ${selectedTicketId || selectedRequestId ? "with-detail" : ""}`}
      data-workspace={workspace}
      data-spare-view={workspace === "spare-requests" ? spareView : undefined}
    >
      <TopBar
        version={bootstrap.version || "3.1.5"}
        detailOpen={Boolean(selectedTicketId || selectedRequestId)}
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
        {workspace === "spare-requests" && <div className="spare-view-row"><div className="spare-view-switcher" role="tablist" aria-label="Spare Request view">{(["active", "eligible", "completed"] as SpareRequestView[]).map((view) => <button type="button" role="tab" aria-selected={spareView === view} className={spareView === view ? "active" : ""} onClick={() => chooseSpareView(view)} key={view}>{view === "active" ? "Active Requests" : view === "eligible" ? "Eligible SR Parts" : "Completed"}</button>)}</div></div>}
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
          <button type="button" className="toolbar-button compactable-button" aria-label="Check Advanced Search" title="Check Advanced Search" onClick={queryData} disabled={Boolean(activeJob)}><span className="toolbar-icon" aria-hidden="true">↻</span><span className="toolbar-label">Check Advanced Search</span></button>
          {workspace === "spare-requests" && <>
            <button type="button" className="toolbar-button compactable-button" aria-label="Manual request" title="Manual request" onClick={() => openSpareExport()}><span className="toolbar-icon" aria-hidden="true">+</span><span className="toolbar-label">Manual request</span></button>
            <button type="button" className="toolbar-button compactable-button" aria-label="BOM catalog" title="BOM catalog" onClick={() => setBomCatalogOpen(true)}><span className="toolbar-icon" aria-hidden="true">▤</span><span className="toolbar-label">BOM catalog</span></button>
            {spareView === "completed" && <button type="button" className="toolbar-button compactable-button danger-text" aria-label="Purge selected" title="Purge selected" disabled={!selectedCompletedItem} onClick={() => setPurgeConfirmationOpen(true)}><span className="toolbar-icon" aria-hidden="true">⌫</span><span className="toolbar-label">Purge selected</span></button>}
          </>}
          {dashboard.workspace === "service-requests" ? (
            <FilterBar
              definitions={serviceFilters.definitions}
              selections={serviceFilters.selections}
              activeCount={serviceFilters.activeCount}
              onToggle={serviceFilters.toggle}
              onClear={serviceFilters.clear}
            />
          ) : dashboard.view === "eligible" ? (
            <FilterBar
              definitions={eligiblePartFilters.definitions}
              selections={eligiblePartFilters.selections}
              activeCount={eligiblePartFilters.activeCount}
              onToggle={eligiblePartFilters.toggle}
              onClear={eligiblePartFilters.clear}
            />
          ) : (
            <FilterBar
              definitions={spareRequestFilters.definitions}
              selections={spareRequestFilters.selections}
              activeCount={spareRequestFilters.activeCount}
              onToggle={spareRequestFilters.toggle}
              onClear={spareRequestFilters.clear}
            />
          )}
          <div className="columns-anchor">
            <button type="button" className="toolbar-button compactable-button" aria-label="Fields" title="Fields" aria-expanded={columnsOpen} onClick={() => setColumnsOpen((value) => !value)}><span className="toolbar-icon" aria-hidden="true">⚙</span><span className="toolbar-label">Fields</span></button>
            {columnsOpen && (
              <ColumnChooser
                columns={orderedColumns}
                visibleKeys={visibleKeys}
                onToggle={toggle}
                onMove={move}
                onReset={reset}
                onClose={() => setColumnsOpen(false)}
              />
            )}
          </div>
        </div>
      </section>
      <section className="workspace">
        {dashboard?.workspace === "spare-requests" ? (
          dashboard.view === "eligible" ? <SparePartsGrid
            rows={eligiblePartFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            draftTicketIds={draftTicketIds}
            detailOpen={Boolean(selectedTicketId || selectedRequestId)}
            onHighlight={highlightSparePart}
            onOpen={(row) => { selectSparePart(row); openSpareExport(row.ticketId, row); }}
            onCloseDetail={closeDetail}
          /> : <SpareRequestsGrid
            rows={spareRequestFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            detailOpen={Boolean(selectedTicketId || selectedRequestId)}
            onHighlight={highlightSpareRequest}
            onOpen={selectSpareRequest}
            onCloseDetail={closeDetail}
          />
        ) : (
          <TicketGrid
            tickets={serviceFilters.filteredRows}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            draftTicketIds={draftTicketIds}
            detailOpen={Boolean(selectedTicketId || selectedRequestId)}
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
        />}
      </section>
      <footer className="command-strip">
        <span>↑↓ Select</span>
        <span>←→ Detail tab</span>
        <span>Click/Enter Open · Esc Close</span>
        <span>Ctrl+F Search</span>
        <span>S Sort</span>
        <span>M Operations</span>
        <span>R Check source</span>
        <span className="footer-state">{activeJob ? activeJob.message : <>{draftCount > 0 && <button type="button" className="footer-draft-button" onClick={() => setDraftsOpen(true)}>✎ {draftCount} protected draft{draftCount === 1 ? "" : "s"}</button>}<span>{workspaceConfig.label} · Local database · {bootstrap?.polling.intervalMinutes ?? 15} min Advanced Search check</span></>}</span>
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
