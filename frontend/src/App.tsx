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
import { StatsBar } from "./components/StatsBar";
import { TicketDetail } from "./components/TicketDetail";
import { TicketGrid } from "./components/TicketGrid";
import { TopBar } from "./components/TopBar";
import { useColumnPreferences } from "./hooks/useColumnPreferences";
import { useGlobalCommands } from "./hooks/useGlobalCommands";
import type { BootstrapPayload, DashboardPayload, Job, TicketDetail as TicketDetailType } from "./types";

const SORTS = ["report", "sr", "planned", "email", "age", "severity", "status"] as const;
type SortMode = typeof SORTS[number];
type SortDirection = "asc" | "desc";

const DEFAULT_DIRECTIONS: Record<SortMode, SortDirection> = {
  report: "asc",
  sr: "desc",
  planned: "asc",
  email: "desc",
  age: "desc",
  severity: "asc",
  status: "asc",
};

function readPreference(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function readSort(): SortMode {
  const saved = readPreference("zeus3.dashboard.sort", "report");
  return SORTS.includes(saved as SortMode) ? saved as SortMode : "report";
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [ticket, setTicket] = useState<TicketDetailType | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>(readSort);
  const [direction, setDirection] = useState<SortDirection>(() => {
    const saved = readPreference("zeus3.dashboard.direction", DEFAULT_DIRECTIONS[sort]);
    return saved === "desc" ? "desc" : "asc";
  });
  const [theme, setTheme] = useState(() => readPreference("zeus3.theme", "dark"));
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; path: string }>>([]);
  const [toast, setToast] = useState<{ tone: "error" | "success" | "info"; message: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dashboardRequest = useRef(0);
  const { orderedColumns, visibleColumns, visibleKeys, toggle, move, reset } = useColumnPreferences(dashboard?.columns || []);

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
    currentSort = sort,
    currentDirection = direction,
    currentSearch = search,
  ) => {
    const requestId = ++dashboardRequest.current;
    const result = await getDashboard(currentSort, currentDirection, currentSearch);
    if (requestId === dashboardRequest.current) setDashboard(result);
    return result;
  }, [direction, search, sort]);

  const loadTicket = useCallback(async (ticketId: string) => {
    setTicketLoading(true);
    try {
      const result = await getTicket(ticketId);
      setTicket(result);
    } catch (error) {
      reportError(error);
      setTicket(null);
      setSelectedId(null);
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
    const timer = window.setTimeout(() => loadDashboard(sort, direction, search).catch(reportError), 140);
    localStorage.setItem("zeus3.dashboard.sort", sort);
    localStorage.setItem("zeus3.dashboard.direction", direction);
    return () => window.clearTimeout(timer);
  }, [direction, loadDashboard, reportError, search, sort]);

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
          if (selectedId) loadTicket(selectedId);
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
  }, [bootstrap?.instanceId, loadBootstrap, loadDashboard, loadTicket, reportError, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setTicket(null);
      return;
    }
    loadTicket(selectedId);
  }, [loadTicket, selectedId]);

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
  const chooseSort = useCallback((next: SortMode) => {
    setSort(next);
    setDirection(DEFAULT_DIRECTIONS[next]);
  }, []);
  const cycleSort = useCallback(() => {
    const next = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
    chooseSort(next);
  }, [chooseSort, sort]);
  const queryData = useCallback(() => {
    if (!activeJob) void runJob("query");
  }, [activeJob, runJob]);

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
    <main className={`app-shell ${selectedId ? "with-detail" : ""}`}>
      <TopBar
        version={bootstrap?.version || "3.0.0"}
        detailOpen={Boolean(selectedId)}
        stagedMessages={bootstrap?.outlook.stagedMessageCount || 0}
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
      <StatsBar stats={dashboard?.stats || null} />
      <section className="dashboard-toolbar">
        <label className="search-box">
          <span>⌕</span>
          <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SR, summary, handler, site…" />
          {search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search">×</button>}
        </label>
        <div className="sort-control" role="group" aria-label="Dashboard sorting">
          <label>Sort
          <select aria-label="Sort field" value={sort} onChange={(event) => chooseSort(event.target.value as SortMode)}>
            {SORTS.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
          </label>
          <select aria-label="Sort direction" value={direction} onChange={(event) => setDirection(event.target.value as SortDirection)}>
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
        <TicketGrid
          tickets={dashboard?.tickets || []}
          columns={visibleColumns}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCloseDetail={() => setSelectedId(null)}
        />
        <TicketDetail
          ticket={ticket}
          loading={ticketLoading}
          templates={templates}
          onClose={() => setSelectedId(null)}
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
        <span className="footer-state">{activeJob ? activeJob.message : `Local · ${bootstrap?.polling.intervalMinutes ?? 15} min query`}</span>
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
