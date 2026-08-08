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
  saveUserProfile,
  saveTicket,
  startJob,
} from "./api";
import { BomCatalogModal } from "./components/BomCatalogModal";
import { ColumnChooser } from "./components/ColumnChooser";
import { GlobalDataModal } from "./components/GlobalDataModal";
import { JobBanner } from "./components/JobBanner";
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
import { useColumnPreferences } from "./hooks/useColumnPreferences";
import { useGlobalCommands } from "./hooks/useGlobalCommands";
import type {
  BootstrapPayload,
  DashboardPayload,
  Job,
  SparePartSummary,
  SpareRequestDetail as SpareRequestDetailType,
  SpareRequestItemSummary,
  SpareRequestView,
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
      { value: "rma", label: "RMA" },
      { value: "email", label: "Email inactivity" },
      { value: "status", label: "Status" },
      { value: "age", label: "Dispatch age" },
      { value: "site", label: "Site" },
      { value: "cloud", label: "Cloud" },
      { value: "bom", label: "BOM" },
    ],
    defaultDirections: {
      tt: "desc", rma: "asc", email: "desc", status: "asc",
      age: "desc", site: "asc", cloud: "asc", bom: "asc",
    },
    searchPlaceholder: "Search TT, RMA, Spare SR, BOM, serial, site…",
    columnsStorageKey: "zeus3.spare-requests.columns",
  },
};

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
  const [spareExportOpen, setSpareExportOpen] = useState(false);
  const [globalDataOpen, setGlobalDataOpen] = useState(false);
  const [bomCatalogOpen, setBomCatalogOpen] = useState(false);
  const [spareExportTicketId, setSpareExportTicketId] = useState<string | undefined>();
  const [spareExportPart, setSpareExportPart] = useState<SparePartSummary | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([]);
  const [toast, setToast] = useState<{ tone: "error" | "success" | "info"; message: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dashboardRequest = useRef(0);
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
    if (requestId === dashboardRequest.current) setDashboard(result);
    return result;
  }, [direction, search, sort, spareView, workspace]);

  const loadTicket = useCallback(async (ticketId: string) => {
    setTicketLoading(true);
    try {
      const result = await getTicket(ticketId);
      setTicket(result);
    } catch (error) {
      reportError(error);
      setTicket(null);
      setSelectedTicketId(null);
      setSelectedRowId(null);
    } finally {
      setTicketLoading(false);
    }
  }, [reportError]);

  const loadSpareRequest = useCallback(async (requestId: string) => {
    setTicketLoading(true);
    try {
      setSpareRequest(await getSpareRequest(requestId));
    } catch (error) {
      reportError(error);
      setSpareRequest(null);
      setSelectedRequestId(null);
      setSelectedRowId(null);
    } finally {
      setTicketLoading(false);
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
    const timer = window.setTimeout(
      () => loadDashboard(workspace, sort, direction, search, spareView).catch(reportError),
      140,
    );
    localStorage.setItem("zeus3.workspace", workspace);
    localStorage.setItem(workspacePreferenceKey(workspace, "sort"), sort);
    localStorage.setItem(workspacePreferenceKey(workspace, "direction"), direction);
    localStorage.setItem(workspacePreferenceKey(workspace, "search"), search);
    localStorage.setItem("zeus3.spare-requests.view", spareView);
    return () => window.clearTimeout(timer);
  }, [bootstrap?.onboarding.required, bootstrap?.instanceId, direction, loadDashboard, reportError, search, sort, spareView, workspace]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("zeus3.theme", theme);
  }, [theme]);

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
      setTicket(null);
      return;
    }
    loadTicket(selectedTicketId);
  }, [loadTicket, selectedTicketId]);

  useEffect(() => {
    if (!selectedRequestId) {
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
    const recreated = result.pendingsRecreated;
    setToast({
      tone: "success",
      message: recreated?.created
        ? `Pendings.xlsx was missing, so Zeus recreated it from ${recreated.rows} Markdown ticket record(s), then saved SR ${ticketId} through the new workbook. No backup was restored.`
        : `SR ${ticketId} saved through Pendings.xlsx; the dashboard was updated from that workbook edit.`,
    });
    try {
      await loadDashboard();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast({
        tone: "error",
        message: `SR ${ticketId} was saved successfully, but the dashboard reread failed: ${message}. Reloading the page is safe.`,
      });
    }
  }

  const activeJob = useMemo(() => jobs.find((job) => ["queued", "running"].includes(job.status)), [jobs]);
  const selectedCompletedItem = useMemo(() => {
    if (dashboard?.workspace !== "spare-requests" || dashboard.view !== "completed") return null;
    return dashboard.spareRequests.find((row) => row.rowId === selectedRowId) || null;
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
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedRowId(null);
  }, []);

  const chooseWorkspace = useCallback((next: WorkspaceKey) => {
    if (next === workspace) return;
    dashboardRequest.current += 1;
    setWorkspace(next);
    setDashboard(null);
    setTicket(null);
    setSpareRequest(null);
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedRowId(null);
    setColumnsOpen(false);
  }, [workspace]);

  const selectServiceRequest = useCallback((ticketId: string) => {
    setSelectedRequestId(null);
    setSelectedTicketId(ticketId);
    setSelectedRowId(ticketId);
  }, []);

  const selectSparePart = useCallback((row: SparePartSummary) => {
    setSelectedRequestId(null);
    setSelectedTicketId(row.ticketId);
    setSelectedRowId(row.rowId);
  }, []);

  const selectSpareRequest = useCallback((row: SpareRequestItemSummary) => {
    setSelectedTicketId(null);
    setSelectedRequestId(row.readOnly ? null : row.requestId);
    setSelectedRowId(row.rowId);
  }, []);

  const chooseSpareView = useCallback((next: SpareRequestView) => {
    if (next === spareView) return;
    dashboardRequest.current += 1;
    setSpareView(next);
    setSelectedTicketId(null);
    setSelectedRequestId(null);
    setSelectedRowId(null);
    setTicket(null);
    setSpareRequest(null);
  }, [spareView]);

  const openSpareExport = useCallback((ticketId?: string, part: SparePartSummary | null = null) => {
    if (bootstrap && !bootstrap.spareRequestExport.requestReady) {
      const missing = bootstrap.spareRequestExport.requestMissing
        .map((item) => item.label)
        .join(" and ");
      setToast({
        tone: "info",
        message: `Configure ${missing || "the Spare Request export paths"} before exporting.`,
      });
      setSettingsOpen(true);
      return;
    }
    setSpareExportTicketId(ticketId);
    setSpareExportPart(part);
    setSpareExportOpen(true);
  }, [bootstrap]);

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
    try { await navigator.clipboard.writeText(result.subject); } catch { /* The exported file remains complete. */ }
    setToast({ tone: result.warnings.length ? "info" : "success", message: `Exported ${result.filename}. Email subject copied.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}` });
    await loadDashboard("spare-requests", "tt", "desc", "", "active");
  }, [loadDashboard]);

  async function purgeSelectedCompleted() {
    if (!selectedCompletedItem) return;
    if (!window.confirm(`Permanently purge completed item ${selectedCompletedItem.itemId}? This cannot be undone.`)) return;
    try {
      const result = await purgeSpareArchive([selectedCompletedItem.itemId]);
      setSelectedRowId(null);
      setToast({ tone: "success", message: `Purged ${result.removed} completed Spare Request item(s) and associated retained email.` });
      await loadDashboard();
    } catch (error) {
      reportError(error);
    }
  }

  useGlobalCommands({
    disabled: operationsOpen || settingsOpen || spareExportOpen || globalDataOpen || bomCatalogOpen || Boolean(bootstrap?.onboarding.required),
    queryDisabled: Boolean(activeJob),
    onSearch: () => searchRef.current?.focus(),
    onSort: cycleSort,
    onOperations: () => setOperationsOpen(true),
    onQuery: queryData,
  });

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
    <main className={`app-shell ${selectedTicketId || selectedRequestId ? "with-detail" : ""}`} data-workspace={workspace}>
      <TopBar
        version={bootstrap.version || "3.1.2"}
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
        {workspace === "spare-requests" && <div className="spare-view-switcher" role="tablist" aria-label="Spare Request view">{(["active", "eligible", "completed"] as SpareRequestView[]).map((view) => <button type="button" role="tab" aria-selected={spareView === view} className={spareView === view ? "active" : ""} onClick={() => chooseSpareView(view)} key={view}>{view === "active" ? "Active Requests" : view === "eligible" ? "Eligible SR Parts" : "Completed"}</button>)}</div>}
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
        <button type="button" className="toolbar-button" onClick={queryData} disabled={Boolean(activeJob)}>↻ Query data</button>
        {workspace === "spare-requests" && <><button type="button" className="toolbar-button" onClick={() => openSpareExport()}>+ Manual request</button><button type="button" className="toolbar-button" onClick={() => setBomCatalogOpen(true)}>BOM catalog</button>{spareView === "completed" && <button type="button" className="toolbar-button danger-text" disabled={!selectedCompletedItem} onClick={purgeSelectedCompleted}>Purge selected</button>}</>}
        <div className="columns-anchor">
          <button type="button" className="toolbar-button" onClick={() => setColumnsOpen((value) => !value)}>⚙ Fields</button>
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
      </section>
      <section className="workspace">
        {dashboard?.workspace === "spare-requests" ? (
          dashboard.view === "eligible" ? <SparePartsGrid
            rows={dashboard.eligibleParts}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            onSelect={(row) => { selectSparePart(row); openSpareExport(row.ticketId, row); }}
            onCloseDetail={closeDetail}
          /> : <SpareRequestsGrid
            rows={dashboard.spareRequests}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            onSelect={selectSpareRequest}
            onCloseDetail={closeDetail}
          />
        ) : (
          <TicketGrid
            tickets={dashboard?.workspace === "service-requests" ? dashboard.tickets : []}
            columns={visibleColumns}
            selectedId={selectedTicketId}
            onSelect={selectServiceRequest}
            onCloseDetail={closeDetail}
          />
        )}
        {selectedTicketId && <TicketDetail
          ticket={ticket}
          loading={ticketLoading}
          initialTab={workspace === "spare-requests" ? "spares" : "overview"}
          templates={templates}
          onClose={closeDetail}
          onSave={saveLocalFields}
          onGenerateMop={(ticketId, template) => runJob("mop", { ticketId, template })}
          onExportSpareRequest={(ticketId) => openSpareExport(ticketId)}
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
        <span>Wheel Scroll List</span>
        <span>Click/Enter Open</span>
        <span>Ctrl+F Search</span>
        <span>S Sort</span>
        <span>M Operations</span>
        <span>R Query</span>
        <span className="footer-state">{activeJob ? activeJob.message : `${workspaceConfig.label} · Local · ${bootstrap?.polling.intervalMinutes ?? 15} min query`}</span>
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
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { loadBootstrap().catch(reportError); loadDashboard().catch(reportError); }}
          onError={reportError}
        />
      )}
      {spareExportOpen && <SpareRequestModal initialTicketId={spareExportTicketId} initialPart={spareExportPart} onClose={() => setSpareExportOpen(false)} onExport={createSpareRequest} onOpenSettings={() => { setSpareExportOpen(false); setSettingsOpen(true); }} onError={reportError} />}
      {globalDataOpen && <GlobalDataModal onClose={() => setGlobalDataOpen(false)} onSaved={() => { loadBootstrap().catch(reportError); setToast({ tone: "success", message: "Global data saved locally." }); }} onError={reportError} />}
      {bomCatalogOpen && <BomCatalogModal onClose={() => setBomCatalogOpen(false)} onSaved={() => setToast({ tone: "success", message: "BOM catalog saved locally." })} onError={reportError} />}
      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.message}</span><button type="button" onClick={() => setToast(null)}>×</button></div>}
    </main>
  );
}
