import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  cancelJob,
  getBootstrap,
  getDashboard,
  getTemplates,
  getTicket,
  saveTicket,
  startJob,
} from "./api";
import { ColumnChooser } from "./components/ColumnChooser";
import { JobBanner } from "./components/JobBanner";
import { NoticeStrip } from "./components/NoticeStrip";
import { OperationsModal } from "./components/OperationsModal";
import { SettingsModal } from "./components/SettingsModal";
import { SparePartsGrid } from "./components/SparePartsGrid";
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
  TicketDetail as TicketDetailType,
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
  "spare-parts": {
    label: "Spare Parts",
    defaultSort: "sr",
    sorts: [
      { value: "sr", label: "SR" },
      { value: "planned", label: "Planned" },
      { value: "site", label: "Site" },
      { value: "cloud", label: "Cloud" },
      { value: "device", label: "Device" },
      { value: "part", label: "Part" },
      { value: "bom", label: "BOM" },
    ],
    defaultDirections: {
      sr: "desc", planned: "asc", site: "asc", cloud: "asc",
      device: "asc", part: "asc", bom: "asc",
    },
    searchPlaceholder: "Search SR, device, part, BOM, serial, site…",
    columnsStorageKey: "zeus3.spare-parts.columns",
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
  const prefix = workspace === "service-requests" ? "zeus3.dashboard" : "zeus3.spare-parts";
  return `${prefix}.${name}`;
}

function readWorkspace(): WorkspaceKey {
  return readPreference("zeus3.workspace", "service-requests") === "spare-parts"
    ? "spare-parts"
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
    "spare-parts": readWorkspacePreference("spare-parts"),
  }));
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [ticket, setTicket] = useState<TicketDetailType | null>(null);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [theme, setTheme] = useState(() => readPreference("zeus3.theme", "dark"));
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([]);
  const [toast, setToast] = useState<{ tone: "error" | "success" | "info"; message: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dashboardRequest = useRef(0);
  const preference = workspacePreferences[workspace];
  const { search, sort, direction } = preference;
  const workspaceConfig = WORKSPACES[workspace];
  const { orderedColumns, visibleColumns, visibleKeys, toggle, move, reset } = useColumnPreferences(
    dashboard?.columns || [],
    workspaceConfig.columnsStorageKey,
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
  ) => {
    const requestId = ++dashboardRequest.current;
    const result = await getDashboard(currentWorkspace, currentSort, currentDirection, currentSearch);
    if (requestId === dashboardRequest.current) setDashboard(result);
    return result;
  }, [direction, search, sort, workspace]);

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

  useEffect(() => {
    Promise.all([loadBootstrap(), loadDashboard(), getTemplates()])
      .then(([, , templateResult]) => setTemplates(templateResult.templates))
      .catch(reportError);
  }, []); // initial connection only

  useEffect(() => {
    const timer = window.setTimeout(
      () => loadDashboard(workspace, sort, direction, search).catch(reportError),
      140,
    );
    localStorage.setItem("zeus3.workspace", workspace);
    localStorage.setItem(workspacePreferenceKey(workspace, "sort"), sort);
    localStorage.setItem(workspacePreferenceKey(workspace, "direction"), direction);
    localStorage.setItem(workspacePreferenceKey(workspace, "search"), search);
    return () => window.clearTimeout(timer);
  }, [direction, loadDashboard, reportError, search, sort, workspace]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("zeus3.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!bootstrap) return;
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
  }, [bootstrap?.instanceId, loadBootstrap, loadDashboard, loadTicket, reportError, selectedTicketId]);

  useEffect(() => {
    if (!selectedTicketId) {
      setTicket(null);
      return;
    }
    loadTicket(selectedTicketId);
  }, [loadTicket, selectedTicketId]);

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
    setSelectedRowId(null);
  }, []);

  const chooseWorkspace = useCallback((next: WorkspaceKey) => {
    if (next === workspace) return;
    dashboardRequest.current += 1;
    setWorkspace(next);
    setDashboard(null);
    setTicket(null);
    setSelectedTicketId(null);
    setSelectedRowId(null);
    setColumnsOpen(false);
  }, [workspace]);

  const selectServiceRequest = useCallback((ticketId: string) => {
    setSelectedTicketId(ticketId);
    setSelectedRowId(ticketId);
  }, []);

  const selectSparePart = useCallback((row: SparePartSummary) => {
    setSelectedTicketId(row.ticketId);
    setSelectedRowId(row.rowId);
  }, []);

  useGlobalCommands({
    disabled: operationsOpen || settingsOpen,
    queryDisabled: Boolean(activeJob),
    onSearch: () => searchRef.current?.focus(),
    onSort: cycleSort,
    onOperations: () => setOperationsOpen(true),
    onQuery: queryData,
  });

  const warnings = bootstrap?.startup.warnings || [];
  const notices = bootstrap?.startup.notices || [];

  if (!bootstrap && !dashboard) {
    return (
      <main className="boot-screen">
        <span className="boot-bolt">ϟ</span>
        <h1>ZEUS 3</h1>
        <p>Starting the local workstation…</p>
      </main>
    );
  }

  return (
    <main className={`app-shell ${selectedTicketId ? "with-detail" : ""}`} data-workspace={workspace}>
      <TopBar
        version={bootstrap?.version || "3.1.0"}
        detailOpen={Boolean(selectedTicketId)}
        workspace={workspace}
        stagedMessages={bootstrap?.outlook.stagedMessageCount || 0}
        onWorkspaceChange={chooseWorkspace}
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
        {dashboard?.workspace === "spare-parts" ? (
          <SparePartsGrid
            rows={dashboard.spareParts}
            columns={visibleColumns}
            selectedRowId={selectedRowId}
            onSelect={selectSparePart}
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
        <TicketDetail
          ticket={ticket}
          loading={ticketLoading}
          initialTab={workspace === "spare-parts" ? "spares" : "overview"}
          templates={templates}
          onClose={closeDetail}
          onSave={saveLocalFields}
          onGenerateMop={(ticketId, template) => runJob("mop", { ticketId, template })}
        />
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
      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span>{toast.message}</span><button type="button" onClick={() => setToast(null)}>×</button></div>}
    </main>
  );
}
