import { useMemo, useState } from "react";
import type {
  UpcomingMaintenanceWindow,
  UpcomingMaintenanceWindowsPayload,
} from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

interface Props {
  payload: UpcomingMaintenanceWindowsPayload | null;
  loading: boolean;
  busy: boolean;
  onRefresh: () => void;
  onSchedule: (date: string, startTime: string | null, ticketIds: string[]) => Promise<void>;
  onUpdate: (
    window: UpcomingMaintenanceWindow,
    date: string,
    startTime: string | null,
    ticketIds: string[],
  ) => Promise<void>;
  onDelete: (window: UpcomingMaintenanceWindow) => Promise<void>;
  onComplete: (
    window: UpcomingMaintenanceWindow,
    outcomes: Record<string, boolean>,
    finishTime: string | null,
  ) => Promise<void>;
}

export function isHalfHourTime(value: string): boolean {
  return value === "" || /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value);
}

function todayText(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function scheduleLabel(date: string, time: string | null): string {
  return `${date}${time ? ` · ${time}` : " · time not set"}`;
}

export function UpcomingWorkspace({
  payload,
  loading,
  busy,
  onRefresh,
  onSchedule,
  onUpdate,
  onDelete,
  onComplete,
}: Props) {
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<UpcomingMaintenanceWindow | null>(null);
  const [deleting, setDeleting] = useState<UpcomingMaintenanceWindow | null>(null);
  const [completion, setCompletion] = useState<UpcomingMaintenanceWindow | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, boolean>>({});
  const [finishTime, setFinishTime] = useState("");

  const candidates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return payload?.candidates || [];
    return (payload?.candidates || []).filter((candidate) => [
      candidate.ticketId,
      candidate.summary,
      candidate.site,
      candidate.cloud,
      candidate.handler,
    ].some((value) => String(value || "").toLocaleLowerCase().includes(query)));
  }, [payload?.candidates, search]);

  function openSchedule() {
    setEditing(null);
    setDate("");
    setStartTime("");
    setSearch("");
    setSelected(new Set());
    setScheduleOpen(true);
  }

  function openEdit(window: UpcomingMaintenanceWindow) {
    setEditing(window);
    setDate(window.date);
    setStartTime(window.startTime || "");
    setSearch("");
    setSelected(new Set(window.members.map((member) => member.ticketId)));
    setScheduleOpen(true);
  }

  function openCompletion(window: UpcomingMaintenanceWindow) {
    setCompletion(window);
    setOutcomes(Object.fromEntries(window.members.map((member) => [member.ticketId, true])));
    setFinishTime("");
  }

  async function schedule() {
    if (!date || !isHalfHourTime(startTime)) return;
    if (editing) await onUpdate(editing, date, startTime || null, [...selected]);
    else await onSchedule(date, startTime || null, [...selected]);
    setScheduleOpen(false);
    setEditing(null);
  }

  async function complete() {
    if (!completion || !isHalfHourTime(finishTime)) return;
    await onComplete(completion, outcomes, finishTime || null);
    setCompletion(null);
  }

  if (!payload) {
    return <section className="upcoming-workspace"><div className="detail-loading"><span>{loading ? "Reading Maintenance Windows…" : "Maintenance Windows could not be loaded."}</span>{!loading && <button type="button" className="secondary-button" onClick={onRefresh}>Try again</button>}</div></section>;
  }

  return <>
    <section className="upcoming-workspace" aria-label="Upcoming Maintenance Windows">
      <header className="upcoming-header">
        <div>
          <span className="eyebrow">MAINTENANCE WINDOW MANAGER</span>
          <h1>Upcoming</h1>
          <p>Schedule linked or unlinked windows while keeping every Service Request’s audited MW history synchronized.</p>
        </div>
        <div className="upcoming-header-actions">
          <button type="button" className="secondary-button" disabled={loading || busy} onClick={onRefresh}>↻ Refresh</button>
          <button type="button" className="primary-button" disabled={busy} onClick={openSchedule}>+ Schedule MW</button>
        </div>
      </header>
      <div className="upcoming-stats">
        <span>Windows <strong>{payload?.stats.windows || 0}</strong></span>
        <span>Linked SRs <strong>{payload?.stats.tickets || 0}</strong></span>
        <span>Awaiting review <strong>{payload?.stats.awaitingReview || 0}</strong></span>
      </div>
      <div className="upcoming-list">
        {!payload?.windows.length && <div className="upcoming-empty"><strong>No Maintenance Windows scheduled.</strong><span>Create a window and attach one or more active Service Requests.</span></div>}
        {payload?.windows.map((window) => <article className={`upcoming-card state-${window.status}`} key={window.windowId}>
          <header>
            <div>
              <span>{window.managed ? window.windowId : "Standalone SR window"}</span>
              <strong>{scheduleLabel(window.date, window.startTime)}</strong>
            </div>
            <div className="upcoming-card-actions">
              <span className={`mw-state mw-state-${window.status}`}>{window.status === "incomplete" ? "Awaiting review" : window.status === "conflict" ? "Conflict" : "Planned"}</span>
              {window.canComplete && <button type="button" className="mw-completed-button" onClick={() => openCompletion(window)}>Review completion</button>}
              <button type="button" className="text-button" aria-label={`Edit ${window.windowId}`} onClick={() => openEdit(window)}>Edit</button>
              <button type="button" className="text-button danger-text" aria-label={`Delete ${window.windowId}`} onClick={() => setDeleting(window)}>Delete</button>
            </div>
          </header>
          <div className="upcoming-members">
            {window.members.map((member) => <div key={member.ticketId}>
              <strong>SR {member.ticketId}</strong>
              <span>{member.summary || "No problem summary"}</span>
              <small>{member.site || "—"} · {member.cloud || "—"} · {member.handler || "—"}</small>
            </div>)}
          </div>
          {!window.members.length && <div className="upcoming-unlinked"><strong>No Service Request linked.</strong><span>Edit this window whenever an active SR should join it.</span></div>}
          {!window.managed && <footer>Scheduled from SR Details. Editing or deleting it here updates that Service Request directly.</footer>}
          {window.status === "conflict" && <footer>Linked SRs no longer agree on date or start time. Zeus has blocked completion to prevent a partial result.</footer>}
        </article>)}
      </div>
      {!!payload?.archived.length && <section className="upcoming-archive">
        <header><strong>Completed shared windows</strong><span>Latest 20 archived cycles</span></header>
        {payload.archived.map((window) => <article key={window.windowId}>
          <div>
            <strong>{scheduleLabel(window.date, window.startTime)}</strong>
            <span>{window.finishTime ? `Finished ${window.finishDate} · ${window.finishTime}` : "Finish time not recorded"}</span>
          </div>
          <div>{window.members.map((member) => <span className={member.outcome === "completed" ? "status-good" : "status-bad"} key={member.ticketId}>SR {member.ticketId} · {member.outcome === "completed" ? "Completed" : "Incomplete"}</span>)}</div>
        </article>)}
      </section>}
    </section>

    {scheduleOpen && <Modal
      title={editing ? `Edit ${editing.windowId}` : "Schedule Maintenance Window"}
      subtitle="A window may remain unlinked, while every selected SR can belong to only one unfinished window. Start time is optional."
      onClose={() => { setScheduleOpen(false); setEditing(null); }}
      wide
      actions={<>
        <span>{selected.size ? `${selected.size} Service Request${selected.size === 1 ? "" : "s"} selected` : "Unlinked Maintenance Window"}</span>
        <button type="button" onClick={() => { setScheduleOpen(false); setEditing(null); }}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || !date || !isHalfHourTime(startTime)} onClick={() => { void schedule().catch(() => undefined); }}>{busy ? "Saving…" : editing ? "Update MW" : "Schedule MW"}</button>
      </>}
    >
      <section className="upcoming-schedule-form">
        <div className="form-grid two">
          <label className="form-field"><span>MW date</span><input type="date" min={editing ? undefined : todayText()} value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label className="form-field"><span>Optional start time</span><input type="time" step={1800} value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
        </div>
        {!isHalfHourTime(startTime) && <p className="inline-warning">Start time must end in :00 or :30.</p>}
        <label className="search-box upcoming-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search active SRs…" /></label>
        <div className="upcoming-candidate-list">
          {!candidates.length && <div className="upcoming-candidate-empty">No matching active Service Requests.</div>}
          {candidates.map((candidate) => {
            const selectable = candidate.available || candidate.currentWindowId === editing?.windowId;
            return <label className={!selectable ? "blocked" : ""} key={candidate.ticketId}>
            <input
              type="checkbox"
              checked={selected.has(candidate.ticketId)}
              disabled={!selectable}
              onChange={(event) => setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(candidate.ticketId); else next.delete(candidate.ticketId);
                return next;
              })}
            />
            <span><strong>SR {candidate.ticketId}</strong><small>{candidate.summary || "No problem summary"}</small></span>
            <em>{selectable ? `${candidate.site || "—"} · ${candidate.cloud || "—"}` : `Already scheduled · ${candidate.currentWindow?.date || "unfinished MW"}`}</em>
          </label>;})}
        </div>
      </section>
    </Modal>}

    {completion && <Modal
      title={`Review ${completion.windowId}`}
      subtitle="Every linked SR defaults to Completed. Change only the SRs whose work remained incomplete."
      onClose={() => setCompletion(null)}
      wide
      actions={<>
        <span>{Object.values(outcomes).filter(Boolean).length} Completed · {Object.values(outcomes).filter((value) => !value).length} Incomplete</span>
        <button type="button" onClick={() => setCompletion(null)}>Cancel</button>
        <button type="button" className="mw-completed-button" disabled={busy || !isHalfHourTime(finishTime)} onClick={() => { void complete().catch(() => undefined); }}>{busy ? "Saving…" : "Confirm reviewed outcomes"}</button>
      </>}
    >
      <section className="upcoming-completion-form">
        <label className="form-field completion-time"><span>Optional finish time</span><input aria-label="Optional finish time" type="time" step={1800} value={finishTime} onChange={(event) => setFinishTime(event.target.value)} /><small>{completion.startTime ? `If it is earlier than ${completion.startTime}, Zeus infers the next day. A recorded window cannot exceed 12 hours.` : "Without a start time, Zeus records the finish on the scheduled date."}</small></label>
        {!isHalfHourTime(finishTime) && <p className="inline-warning">Finish time must end in :00 or :30.</p>}
        <div className="upcoming-review-list">
          {completion.members.map((member) => <label key={member.ticketId}>
            <span><strong>SR {member.ticketId}</strong><small>{member.summary || "No problem summary"}</small></span>
            <select aria-label={`SR ${member.ticketId} outcome`} value={outcomes[member.ticketId] === false ? "incomplete" : "completed"} onChange={(event) => setOutcomes((current) => ({ ...current, [member.ticketId]: event.target.value === "completed" }))}>
              <option value="completed">Completed</option>
              <option value="incomplete">Incomplete</option>
            </select>
          </label>)}
        </div>
      </section>
    </Modal>}

    {deleting && <ConfirmationDialog
      title={`Delete ${deleting.windowId}?`}
      message={deleting.members.length
        ? `This removes the current Maintenance Window from ${deleting.members.length} linked Service Request${deleting.members.length === 1 ? "" : "s"}. Earlier completed or incomplete MW attempts remain archived in each ticket.`
        : "This removes the unlinked Maintenance Window from the manager."}
      confirmLabel="Delete MW"
      tone="danger"
      busy={busy}
      onCancel={() => setDeleting(null)}
      onConfirm={() => { void onDelete(deleting).then(() => setDeleting(null)).catch(() => undefined); }}
    />}
  </>;
}
