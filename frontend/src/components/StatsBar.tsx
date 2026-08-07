import type { DashboardPayload } from "../types";

export function StatsBar({ dashboard }: { dashboard: DashboardPayload | null }) {
  if (!dashboard) return <div className="stats-bar muted">Reading Markdown records…</div>;
  if (dashboard.workspace === "spare-parts") {
    const stats = dashboard.stats;
    return (
      <div className="stats-bar" aria-label="Spare Parts summary">
        <span>Tickets <strong>{stats.tickets}</strong></span>
        <span>Current <strong>{stats.currentTickets}</strong></span>
        <span>Closed <strong>{stats.closedTickets}</strong></span>
        <span className="stat-separator">|</span>
        <span>Devices <strong>{stats.devices}</strong></span>
        <span>Parts <strong>{stats.parts}</strong></span>
        <span className="stat-separator">|</span>
        <span>With BOM <strong>{stats.withBom}</strong></span>
        <span>Missing BOM <strong className={stats.missingBom ? "yellow-text" : ""}>{stats.missingBom}</strong></span>
        <span>New SN recorded <strong>{stats.newSnRecorded}</strong></span>
      </div>
    );
  }
  const stats = dashboard.stats;
  return (
    <div className="stats-bar" aria-label="Service Requests summary">
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
