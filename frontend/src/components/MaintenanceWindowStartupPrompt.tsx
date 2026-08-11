import { useMemo, useState } from "react";
import type { TicketSummary, UpcomingMaintenanceWindow } from "../types";
import { Modal } from "./Modal";

type StandaloneOutcome = "completed" | "incomplete" | "later";

export type MaintenanceWindowStartupDecision =
  | {
      kind: "standalone";
      ticket: TicketSummary;
      outcome: StandaloneOutcome;
      finishTime: string;
    }
  | {
      kind: "shared";
      window: UpcomingMaintenanceWindow;
      reviewNow: boolean;
      outcomes: Record<string, boolean>;
      finishTime: string;
    };

interface Props {
  tickets: TicketSummary[];
  sharedWindows: UpcomingMaintenanceWindow[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (decisions: MaintenanceWindowStartupDecision[]) => void;
}

function halfHourTime(value: string): boolean {
  return value === "" || /^(?:[01]\d|2[0-3]):(?:00|30)$/.test(value);
}

export function MaintenanceWindowStartupPrompt({
  tickets,
  sharedWindows,
  busy,
  onClose,
  onSubmit,
}: Props) {
  const standaloneTickets = useMemo(
    () => tickets.filter((ticket) => !ticket.maintenanceWindow?.managedInUpcoming),
    [tickets],
  );
  const dueSharedIds = useMemo(
    () => new Set(tickets.map((ticket) => ticket.maintenanceWindow?.windowId).filter(Boolean)),
    [tickets],
  );
  const dueSharedWindows = useMemo(
    () => sharedWindows.filter((window) => dueSharedIds.has(window.windowId)),
    [dueSharedIds, sharedWindows],
  );
  const [standaloneValues, setStandaloneValues] = useState<Record<string, { outcome: StandaloneOutcome; finishTime: string }>>(
    () => Object.fromEntries(standaloneTickets.map((ticket) => [ticket.ticketId, { outcome: "later", finishTime: "" }])),
  );
  const [sharedValues, setSharedValues] = useState<Record<string, { reviewNow: boolean; outcomes: Record<string, boolean>; finishTime: string }>>(
    () => Object.fromEntries(dueSharedWindows.map((window) => [window.windowId, {
      reviewNow: false,
      outcomes: Object.fromEntries(window.members.map((member) => [member.ticketId, true])),
      finishTime: "",
    }])),
  );

  const decisions = useMemo<MaintenanceWindowStartupDecision[]>(() => [
    ...standaloneTickets.map((ticket) => ({
      kind: "standalone" as const,
      ticket,
      outcome: standaloneValues[ticket.ticketId]?.outcome || "later",
      finishTime: standaloneValues[ticket.ticketId]?.finishTime || "",
    })),
    ...dueSharedWindows.map((window) => ({
      kind: "shared" as const,
      window,
      reviewNow: sharedValues[window.windowId]?.reviewNow || false,
      outcomes: sharedValues[window.windowId]?.outcomes || Object.fromEntries(window.members.map((member) => [member.ticketId, true])),
      finishTime: sharedValues[window.windowId]?.finishTime || "",
    })),
  ], [dueSharedWindows, sharedValues, standaloneTickets, standaloneValues]);

  const ready = decisions.filter((decision) => decision.kind === "shared" ? decision.reviewNow : decision.outcome !== "later");
  const invalidFinishTime = ready.some((decision) => !halfHourTime(decision.finishTime));
  const windowCount = standaloneTickets.length + dueSharedWindows.length;

  return <Modal
    title={`Review ${windowCount} Maintenance Window${windowCount === 1 ? "" : "s"}`}
    subtitle="Their scheduled days have passed. Record what happened now, or defer the review until the next Zeus startup."
    dismissible={!busy}
    onClose={onClose}
    wide
    actions={<>
      <span>{ready.length} window{ready.length === 1 ? "" : "s"} ready</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Review later</button>
      <button type="button" className="mw-completed-button" disabled={busy || !ready.length || invalidFinishTime} onClick={() => onSubmit(decisions)}>{busy ? "Saving…" : "Save MW review"}</button>
    </>}
  >
    <div className="mw-startup-review">
      {standaloneTickets.map((ticket) => {
        const value = standaloneValues[ticket.ticketId] || { outcome: "later", finishTime: "" };
        const date = ticket.maintenanceWindow?.date || ticket.plannedDate;
        return <article className="standalone" key={ticket.ticketId}>
          <header><strong>SR {ticket.ticketId}</strong><span>{date}{ticket.maintenanceWindow?.startTime ? ` · ${ticket.maintenanceWindow.startTime}` : ""}</span><small>{ticket.summary || "No problem summary"}</small></header>
          <label className="form-field"><span>Outcome</span><select aria-label={`SR ${ticket.ticketId} outcome`} value={value.outcome} disabled={busy} onChange={(event) => setStandaloneValues((current) => ({ ...current, [ticket.ticketId]: { ...value, outcome: event.target.value as StandaloneOutcome } }))}><option value="later">Review later</option><option value="completed">Completed</option><option value="incomplete">Incomplete</option></select></label>
          <label className="form-field"><span>Optional finish time</span><input aria-label={`SR ${ticket.ticketId} optional finish time`} type="time" step={1800} value={value.finishTime} disabled={busy || value.outcome === "later"} onChange={(event) => setStandaloneValues((current) => ({ ...current, [ticket.ticketId]: { ...value, finishTime: event.target.value } }))} /></label>
          {!halfHourTime(value.finishTime) && value.outcome !== "later" && <small className="status-bad">Finish time must end in :00 or :30.</small>}
        </article>;
      })}
      {dueSharedWindows.map((window) => {
        const value = sharedValues[window.windowId] || {
          reviewNow: false,
          outcomes: Object.fromEntries(window.members.map((member) => [member.ticketId, true])),
          finishTime: "",
        };
        return <article className="shared" key={window.windowId}>
          <header><strong>{window.windowId}</strong><span>{window.date}{window.startTime ? ` · ${window.startTime}` : ""}</span><small>{window.members.length} linked Service Request{window.members.length === 1 ? "" : "s"}</small></header>
          <label className="form-field"><span>Decision</span><select aria-label={`${window.windowId} decision`} value={value.reviewNow ? "now" : "later"} disabled={busy} onChange={(event) => setSharedValues((current) => ({ ...current, [window.windowId]: { ...value, reviewNow: event.target.value === "now" } }))}><option value="later">Review later</option><option value="now">Review now</option></select></label>
          <label className="form-field"><span>Optional finish time</span><input aria-label={`${window.windowId} optional finish time`} type="time" step={1800} value={value.finishTime} disabled={busy || !value.reviewNow} onChange={(event) => setSharedValues((current) => ({ ...current, [window.windowId]: { ...value, finishTime: event.target.value } }))} /></label>
          {value.reviewNow && <div className="mw-startup-members">
            {window.members.map((member) => <label key={member.ticketId}>
              <span><strong>SR {member.ticketId}</strong><small>{member.summary || "No problem summary"}</small></span>
              <select aria-label={`SR ${member.ticketId} shared MW outcome`} value={value.outcomes[member.ticketId] === false ? "incomplete" : "completed"} onChange={(event) => setSharedValues((current) => ({ ...current, [window.windowId]: { ...value, outcomes: { ...value.outcomes, [member.ticketId]: event.target.value === "completed" } } }))}><option value="completed">Completed</option><option value="incomplete">Incomplete</option></select>
            </label>)}
          </div>}
          {!halfHourTime(value.finishTime) && value.reviewNow && <small className="status-bad">Finish time must end in :00 or :30.</small>}
        </article>;
      })}
    </div>
  </Modal>;
}
