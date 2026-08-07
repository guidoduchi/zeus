import type { DashboardStats } from "../types";

export function StatsBar({ stats }: { stats: DashboardStats | null }) {
  if (!stats) return <div className="stats-bar muted">Reading Markdown records…</div>;
  return (
    <div className="stats-bar" aria-label="Ticket summary">
      <span>Active <strong>{stats.active}</strong></span>
      <span className="stat-separator">|</span>
      <span>Y {stats.doneY}</span>
      <span>N {stats.doneN}</span>
      <span>P {stats.doneP}</span>
      <span>? {stats.doneUnknown}</span>
      <span className="stat-separator">|</span>
      <span>Overdue <strong className={stats.overdue ? "red-text" : ""}>{stats.overdue}</strong></span>
      <span>Unplanned <strong className={stats.unplanned ? "yellow-text" : ""}>{stats.unplanned}</strong></span>
      <span>No email {stats.noEmail}</span>
      <span>Pending closure {stats.pendingClosure}</span>
    </div>
  );
}
