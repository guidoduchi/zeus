import { useMemo, useState } from "react";
import type { TicketSummary } from "../types";
import { Modal } from "./Modal";

export type MaintenanceWindowDecision = {
  ticket: TicketSummary;
  outcome: "successful" | "incomplete" | "later";
  rescheduleDate: string;
};

interface Props {
  tickets: TicketSummary[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (decisions: MaintenanceWindowDecision[]) => void;
}

export function MaintenanceWindowPrompt({ tickets, busy, onClose, onSubmit }: Props) {
  const [values, setValues] = useState<Record<string, { outcome: MaintenanceWindowDecision["outcome"]; rescheduleDate: string }>>(() => Object.fromEntries(
    tickets.map((ticket) => [ticket.ticketId, { outcome: "later", rescheduleDate: "" }]),
  ));
  const decisions = useMemo(() => tickets.map((ticket) => ({
    ticket,
    outcome: values[ticket.ticketId]?.outcome || "later",
    rescheduleDate: values[ticket.ticketId]?.rescheduleDate || "",
  })), [tickets, values]);

  return (
    <Modal
      title={`Review ${tickets.length} overdue Maintenance Window${tickets.length === 1 ? "" : "s"}`}
      subtitle="Record each outcome once. Failed dates stay in attempt history; an optional new date becomes the dashboard date."
      dismissible={!busy}
      onClose={onClose}
      wide
      actions={<>
        <span>{decisions.filter((decision) => decision.outcome !== "later").length} decision(s) ready</span>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Review later</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onSubmit(decisions)}>{busy ? "Saving…" : "Save MW review"}</button>
      </>}
    >
      <div className="mw-batch-review">
        {decisions.map((decision) => {
          const plannedDate = decision.ticket.maintenanceWindow?.date || decision.ticket.plannedDate;
          return <article key={decision.ticket.ticketId}>
            <div><strong>SR {decision.ticket.ticketId}</strong><span>{plannedDate}</span><small>{decision.ticket.summary}</small></div>
            <label className="form-field"><span>Outcome</span><select value={decision.outcome} disabled={busy} onChange={(event) => setValues((current) => ({ ...current, [decision.ticket.ticketId]: { ...current[decision.ticket.ticketId], outcome: event.target.value as MaintenanceWindowDecision["outcome"] } }))}><option value="later">Unresolved · decide later</option><option value="successful">Successful</option><option value="incomplete">Incomplete / postponed</option></select></label>
            <label className="form-field"><span>Optional new MW date</span><input type="date" value={decision.rescheduleDate} disabled={busy || decision.outcome !== "incomplete"} onChange={(event) => setValues((current) => ({ ...current, [decision.ticket.ticketId]: { ...current[decision.ticket.ticketId], rescheduleDate: event.target.value } }))} /></label>
          </article>;
        })}
      </div>
    </Modal>
  );
}
