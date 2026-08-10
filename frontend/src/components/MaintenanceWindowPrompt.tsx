import type { TicketSummary } from "../types";
import { Modal } from "./Modal";

interface Props {
  ticket: TicketSummary;
  busy: boolean;
  onLater: () => void;
  onOutcome: (successful: boolean) => void;
}

export function MaintenanceWindowPrompt({ ticket, busy, onLater, onOutcome }: Props) {
  const plannedDate = ticket.maintenanceWindow?.date || ticket.plannedDate;
  return (
    <Modal
      title={`How did MW ${ticket.ticketId} go?`}
      subtitle="The scheduled date has passed; Zeus needs the operational outcome."
      dismissible={!busy}
      onClose={onLater}
      actions={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onLater}>Decide later</button>
        <button type="button" className="danger-button" disabled={busy} onClick={() => onOutcome(false)}>No · incomplete</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => onOutcome(true)}>{busy ? "Saving…" : "Yes · complete"}</button>
      </>}
    >
      <section className="mw-outcome-prompt">
        <span>Maintenance Window</span>
        <strong>{plannedDate}</strong>
        <p>Was the intervention completed successfully?</p>
        <small>No marks this attempt incomplete and clears the current date so a new MW can be scheduled. The failed date remains in history.</small>
      </section>
    </Modal>
  );
}
