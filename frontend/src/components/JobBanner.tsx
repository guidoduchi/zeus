import type { Job } from "../types";

interface Props {
  jobs: Job[];
  onCancel: (jobId: string) => void;
  onOpenActivity: () => void;
}

export function JobBanner({ jobs, onCancel, onOpenActivity }: Props) {
  const active = jobs.find((job) => job.status === "running") || jobs.find((job) => job.status === "queued");
  if (!active) return null;
  const percent = active.current !== null && active.total
    ? Math.max(0, Math.min(100, Math.round((active.current / active.total) * 100)))
    : null;
  return (
    <section className="job-banner" aria-live="polite">
      <span className="pulse" aria-hidden="true" />
      <strong>{active.label}</strong>
      <span className="job-stage">{active.message}</span>
      {percent !== null ? (
        <div className="job-progress" aria-label={`${percent}% complete`}>
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : <span className="working-track" aria-hidden="true"><span /></span>}
      {active.cancellable && (
        <button type="button" className="text-button" onClick={() => onCancel(active.id)}>Cancel</button>
      )}
      <button type="button" className="text-button" onClick={onOpenActivity}>Activity</button>
    </section>
  );
}
