import { useEffect, useState } from "react";
import { getBackups, previewBackup, stopZeus } from "../api";
import type { Job } from "../types";
import { Modal } from "./Modal";

interface Props {
  jobs: Job[];
  outlookEnabled: boolean;
  outlookAvailable: boolean;
  onClose: () => void;
  onSettings: () => void;
  onRun: (kind: string, payload?: Record<string, unknown>) => void;
  onCancel: (jobId: string) => void;
  onError: (error: unknown) => void;
}

export function OperationsModal({ jobs, outlookEnabled, outlookAvailable, onClose, onSettings, onRun, onCancel, onError }: Props) {
  const [backups, setBackups] = useState<Array<{ name: string }>>([]);
  const [selectedBackup, setSelectedBackup] = useState("");
  const [restorePreview, setRestorePreview] = useState<Awaited<ReturnType<typeof previewBackup>>["preview"] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    getBackups().then((result) => {
      setBackups(result.backups);
      setSelectedBackup(result.backups[0]?.name || "");
    }).catch(onError);
  }, [onError]);
  const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const outlookReady = outlookEnabled && outlookAvailable;
  const outlookMessage = !outlookEnabled
    ? "Outlook is disabled on this computer."
    : !outlookAvailable
      ? "The configured Outlook store is unavailable."
      : "Scan eligible active tickets.";
  return (
    <Modal title="Zeus operations" subtitle="Every mutation is serialized, recoverable, and visible here." onClose={onClose} wide>
      <div className="operations-grid">
        <button type="button" onClick={() => onRun("query")}><strong>Query data now</strong><span>Import Pendings, validate Closed if present, check Advanced Search, and run due optional email work.</span></button>
        <button type="button" onClick={() => onRun("advanced")}><strong>Check Advanced Search</strong><span>Run the same query used by the configurable background frequency.</span></button>
        <button type="button" onClick={() => {
          if (window.confirm("Publish Pendings and Closed now? Missing managed workbooks may be created; invalid existing workbooks are never overwritten.")) {
            onRun("publish", { createMissing: true });
          }
        }}><strong>Publish workbooks</strong><span>Generate Pendings and append final closures to Closed after validation.</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-fetch")}><strong>Fetch Outlook email</strong><span>{outlookMessage}</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-sync")}><strong>Synchronize staged email</strong><span>{outlookReady ? "Apply already fetched messages to Markdown." : outlookMessage}</span></button>
        <button type="button" disabled={!outlookReady} onClick={() => onRun("email-rebuild")}><strong>Rebuild email history</strong><span>{outlookReady ? "Full scan and merge; existing totals never decrease." : outlookMessage}</span></button>
        <button type="button" onClick={() => onRun("doctor")}><strong>Run diagnostics</strong><span>Validate the store, paths, and ticket count.</span></button>
        <button type="button" onClick={onSettings}><strong>Configuration</strong><span>Paths, schedules, thresholds, port, and application controls.</span></button>
      </div>
      <section className="restore-row">
        <div>
          <strong>Restore local fields from Pendings backup</strong>
          <span>{restorePreview
            ? `Preview: ${restorePreview.changed_ids.length} changed, ${restorePreview.applicable_ids.length} applicable, ${restorePreview.ignored_closed_or_unknown_ids.length} ignored. Protected fields and email remain untouched.`
            : "Preview the selected backup. Protected online fields and email remain untouched."}</span>
        </div>
        <select value={selectedBackup} onChange={(event) => { setSelectedBackup(event.target.value); setRestorePreview(null); }}>
          <option value="">No backup selected</option>
          {backups.map((backup) => <option value={backup.name} key={backup.name}>{backup.name}</option>)}
        </select>
        <button type="button" disabled={!selectedBackup || previewLoading} onClick={async () => {
          if (!restorePreview) {
            setPreviewLoading(true);
            try {
              const result = await previewBackup(selectedBackup);
              setRestorePreview(result.preview);
            } catch (error) {
              onError(error);
            } finally {
              setPreviewLoading(false);
            }
            return;
          }
          if (window.confirm(`Restore ${restorePreview.changed_ids.length} changed ticket(s) from ${selectedBackup}?`)) {
            onRun("restore", { backup: selectedBackup, confirmed: true });
            setRestorePreview(null);
          }
        }}>{previewLoading ? "Validating…" : restorePreview ? "Restore" : "Preview"}</button>
      </section>
      <section className="activity-section">
        <div className="section-heading"><strong>Activity</strong><span>{jobs.length}</span></div>
        <div className="job-list">
          {jobs.length ? jobs.slice(0, 12).map((job) => (
            <article className={`job-row status-${job.status}`} key={job.id}>
              <i aria-hidden="true" />
              <div><strong>{job.label}</strong><span>{job.message}</span></div>
              <time>{job.status}</time>
              {job.cancellable && active.some((candidate) => candidate.id === job.id) && <button type="button" className="text-button" onClick={() => onCancel(job.id)}>Cancel</button>}
            </article>
          )) : <div className="empty-panel">No operations in this session.</div>}
        </div>
      </section>
      <section className="shutdown-row">
        <div><strong>Stop Zeus completely</strong><span>Stops the browser backend; this tab will disconnect.</span></div>
        <button type="button" className="danger-button" onClick={async () => {
          if (!window.confirm("Stop Zeus now?")) return;
          try { await stopZeus(); } catch (error) { onError(error); }
        }}>Shut down Zeus</button>
      </section>
    </Modal>
  );
}
