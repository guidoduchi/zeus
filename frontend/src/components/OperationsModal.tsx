import { useState } from "react";
import { stopZeus } from "../api";
import type { Job } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

interface Props {
  jobs: Job[];
  outlookEnabled: boolean;
  outlookAvailable: boolean;
  outlookTargetsAvailable?: boolean;
  onClose: () => void;
  onSettings: () => void;
  onRun: (kind: string, payload?: Record<string, unknown>) => void;
  onCancel: (jobId: string) => void;
  onError: (error: unknown) => void;
}

export function OperationsModal({ jobs, outlookEnabled, outlookAvailable, outlookTargetsAvailable = true, onClose, onSettings, onRun, onCancel, onError }: Props) {
  const [confirmation, setConfirmation] = useState<"publish" | "shutdown" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(() => new Set());
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const outlookReady = outlookEnabled && outlookAvailable && outlookTargetsAvailable;
  const outlookMessage = !outlookEnabled
    ? "Outlook is disabled on this computer."
    : !outlookAvailable
      ? "The configured Outlook store is unavailable."
      : !outlookTargetsAvailable
        ? "Add an active Service Request, Spare Request, or Fault Tag before fetching email."
      : "Scan eligible active tickets.";
  async function confirmAction() {
    if (confirmation === "publish") {
      onRun("publish", { createMissing: true });
      setConfirmation(null);
      return;
    }
    if (confirmation === "shutdown") {
      setStopping(true);
      try { await stopZeus(); } catch (error) { setStopping(false); onError(error); }
    }
  }
  function toggleProgressLog(jobId: string) {
    setExpandedJobs((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  return <>
    <Modal title="Zeus operations" subtitle="The local database is authoritative; workbook output is explicit." onClose={onClose} wide>
      <div className="operations-grid">
        <button type="button" onClick={() => onRun("query")}><strong>Check Advanced Search</strong><span>Discover new source workbooks and reconcile online ticket fields. Exported workbooks are never imported.</span></button>
        <button type="button" onClick={() => setConfirmation("publish")}><strong>Export Pendings & Closed</strong><span>Generate both workbooks from Zeus. Pending closures are deleted from the active database only after a successful export.</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-fetch")}><strong>Fetch Outlook email</strong><span>{outlookMessage}</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-sync")}><strong>Synchronize staged email</strong><span>{outlookReady ? "Apply already fetched messages to the local database." : outlookMessage}</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-rebuild")}><strong>Rebuild email history</strong><span>{outlookReady ? "Full scan and merge; existing totals never decrease." : outlookMessage}</span></button>
        <button type="button" onClick={() => onRun("doctor")}><strong>Run diagnostics</strong><span>Validate the store, paths, and ticket count.</span></button>
        <button type="button" onClick={onSettings}><strong>Configuration</strong><span>Paths, schedules, thresholds, port, and application controls.</span></button>
      </div>
      <section className="activity-section">
        <div className="section-heading"><strong>Activity</strong><span>{jobs.length}</span></div>
        <div className="job-list">
          {jobs.length ? jobs.slice(0, 12).map((job) => {
            const updates = job.updates || [];
            const expanded = expandedJobs.has(job.id);
            const percent = job.current !== null && job.total
              ? Math.max(0, Math.min(100, Math.round((job.current / job.total) * 100)))
              : null;
            return <article className={`job-row status-${job.status}`} key={job.id}>
              <i aria-hidden="true" />
              <div className="job-main">
                <strong>{job.label}</strong>
                <span>{job.message}</span>
                {percent !== null && <div className="job-progress" aria-label={`${percent}% complete`}><span style={{ width: `${percent}%` }} /></div>}
                {updates.length > 0 && <button
                  type="button"
                  className="job-log-toggle"
                  aria-expanded={expanded}
                  onClick={() => toggleProgressLog(job.id)}
                >Progress log ({updates.length})</button>}
                {expanded && <ol className="job-update-list">
                  {updates.map((update, index) => <li key={`${update.timestamp}-${index}`}>
                    <time>{new Date(update.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                    <span>{update.message}</span>
                  </li>)}
                </ol>}
              </div>
              <time>{job.status}</time>
              {job.cancellable && active.some((candidate) => candidate.id === job.id) && <button type="button" className="text-button" onClick={() => onCancel(job.id)}>Cancel</button>}
            </article>;
          }) : <div className="empty-panel">No operations in this session.</div>}
        </div>
      </section>
      <section className="shutdown-row">
        <div><strong>Stop Zeus completely</strong><span>Stops the browser backend; this tab will disconnect.</span></div>
        <button type="button" className="danger-button" onClick={() => setConfirmation("shutdown")}>Shut down Zeus</button>
      </section>
    </Modal>
    {confirmation && <ConfirmationDialog
      title={confirmation === "publish" ? "Export operational workbooks?" : "Stop Zeus completely?"}
      message={confirmation === "publish" ? "Zeus will generate Pendings.xlsx and Closed.xlsx from the local database. Only a successful paired export will finalize and remove tickets already pending closure." : "The local backend will stop and this browser tab will disconnect. Saved database records will remain intact."}
      confirmLabel={confirmation === "publish" ? "Export workbooks" : "Shut down Zeus"}
      tone={confirmation === "shutdown" ? "danger" : "primary"}
      busy={stopping}
      onCancel={() => setConfirmation(null)}
      onConfirm={() => void confirmAction()}
    />}
  </>;
}
