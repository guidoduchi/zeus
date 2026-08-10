import type { DashboardPayload } from "../types";

export function StatsBar({ dashboard }: { dashboard: DashboardPayload | null }) {
  if (!dashboard) return <div className="stats-bar muted">Reading Zeus database records…</div>;
  if (dashboard.workspace === "spare-requests") {
    const stats = dashboard.stats;
    return (
      <div className="stats-bar" aria-label="Spare Requests summary">
        <span>Active requests <strong>{stats.activeRequests}</strong></span>
        <span>Unit items <strong>{stats.activeItems}</strong></span>
        <span className="stat-separator">|</span>
        <span>Awaiting stock <strong>{stats.awaitingStock}</strong></span>
        <span>Awaiting dispatch <strong>{stats.awaitingDispatch}</strong></span>
        <span>Dispatched <strong>{stats.dispatched}</strong></span>
        <span className="stat-separator">|</span>
        <span>Warehouse confirmed <strong className={stats.warehouseCandidates ? "green-text" : ""}>{stats.warehouseCandidates}</strong></span>
        <span>Conflicts <strong className={stats.conflicts ? "red-text" : ""}>{stats.conflicts}</strong></span>
        <span>Eligible <strong>{stats.eligibleParts}</strong></span>
        <span>Completed <strong>{stats.completedItems}</strong></span>
      </div>
    );
  }
  const stats = dashboard.stats;
  return (
    <div className="stats-bar" aria-label="Service Requests summary">
      <span>Active <strong>{stats.active}</strong></span>
      <span className="stat-separator">|</span>
      <span>Complete {stats.mwCompleted ?? stats.doneY}</span>
      <span>Scheduled {stats.mwPlanned ?? 0}</span>
      <span>Incomplete {stats.mwIncomplete ?? stats.doneP}</span>
      <span>No visibility {stats.mwNoVisibility ?? stats.doneUnknown}</span>
      <span className="stat-separator">|</span>
      <span>Overdue <strong className={stats.overdue ? "red-text" : ""}>{stats.overdue}</strong></span>
      <span>Unplanned <strong className={stats.unplanned ? "yellow-text" : ""}>{stats.mwUnplanned ?? stats.unplanned}</strong></span>
      <span>No email {stats.noEmail}</span>
      <span>Pending closure {stats.pendingClosure}</span>
    </div>
  );
}
