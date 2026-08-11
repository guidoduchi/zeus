import { useMemo, useState } from "react";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

export interface SpareLifecycleTarget {
  itemId: string;
  requestId: string;
  revision: string | null;
  rma: string;
  lifecycleStage: number;
  lifecycleStageLabel: string;
  nextStageLabel: string | null;
  rollbackRequiresDoubleConfirmation: boolean;
  manualFacts?: { spareSr: string; rma: string; note: string };
}

export interface FaultTagTarget {
  itemId: string;
  ticketId: string;
  rma: string;
  requestedBom: string;
  site: string;
  siteAddress?: string;
  cloud: string;
}

const ADVANCE_LABELS: Record<number, string> = {
  0: "Confirm request email sent",
  1: "Confirm SR and RMA",
  2: "Confirm spare dispatched",
  3: "Confirm spare replaced",
  5: "Confirm warehouse return",
};

function localDatetimeNow(): string {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return now.toISOString().slice(0, 16);
}

export function SpareLifecycleBulkDialog({ rows, action, busy, onCancel, onConfirm }: {
  rows: SpareLifecycleTarget[];
  action: "advance" | "rollback";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (emailOverrideConfirmed: boolean, note: string, confirmedAt?: string) => void;
}) {
  const emailBacked = action === "rollback" && rows.some((row) => row.rollbackRequiresDoubleConfirmation);
  const [secondConfirmation, setSecondConfirmation] = useState(false);
  const [note, setNote] = useState("");
  const [confirmedAt, setConfirmedAt] = useState(localDatetimeNow);
  const stages = new Set(rows.map((row) => row.lifecycleStage));
  const stage = stages.size === 1 ? rows[0]?.lifecycleStage : -1;
  const advanceLabel = ADVANCE_LABELS[stage] || "Confirm next stage";
  const transitions = rows.map((row) => action === "advance"
    ? `${row.rma || row.itemId} → ${row.nextStageLabel || "Complete"}`
    : `${row.rma || row.itemId} ← ${row.lifecycleStageLabel}`
  );
  const sharedEmail = action === "advance" && stage === 0;
  const recordsCurrentTime = action === "advance" && stage === 2;
  return <ConfirmationDialog
    title={`${action === "advance" ? advanceLabel : "Roll back last stage"} for ${rows.length} item(s)?`}
    message={action === "advance"
      ? sharedEmail
        ? "This manually records the request email as sent for every item in the same Spare Request. A later matching email attaches as evidence without advancing twice."
        : recordsCurrentTime
          ? "Each selected item advances exactly one lifecycle stage. Zeus records the current Ecuador time automatically."
          : "Each selected item advances exactly one lifecycle stage using the confirmation time below."
      : "Each selected item rolls back exactly one stage. Email evidence is retained and suppressed from re-advancing the item."}
    confirmLabel={action === "advance" ? advanceLabel : "Roll back one stage"}
    tone={action === "rollback" ? "danger" : "primary"}
    busy={busy}
    confirmDisabled={(emailBacked && (!secondConfirmation || !note.trim())) || (action === "advance" && !recordsCurrentTime && !confirmedAt)}
    onCancel={onCancel}
    onConfirm={() => onConfirm(
      secondConfirmation,
      note,
      action === "advance" && !recordsCurrentTime && confirmedAt ? new Date(confirmedAt).toISOString() : undefined,
    )}
  >
    <ul>{transitions.map((transition, index) => <li key={`${transition}-${index}`}>{transition}</li>)}</ul>
    {action === "advance" && !recordsCurrentTime && <label className="form-field"><span>Confirmation time</span><input type="datetime-local" value={confirmedAt} onChange={(event) => setConfirmedAt(event.target.value)} /></label>}
    {emailBacked && <div className="email-override-confirmation"><label><input type="checkbox" checked={secondConfirmation} onChange={(event) => setSecondConfirmation(event.target.checked)} /> I explicitly override the email-backed lifecycle effect.</label><label className="form-field"><span>Required audit note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this email-backed stage must be rolled back" /></label></div>}
  </ConfirmationDialog>;
}

export function FaultTagDialog({ rows, busy, onCancel, onConfirm }: {
  rows: FaultTagTarget[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (
    mode: "export" | "manual-sent",
    selections: Array<{ itemId: string; condition: "Faulty" | "New" }>,
    returnSite?: { code: string; address: string; cloud: string },
  ) => void;
}) {
  const [mode, setMode] = useState<"export" | "manual-sent" | null>(null);
  const [conditions, setConditions] = useState<Record<string, "Faulty" | "New">>(() => Object.fromEntries(rows.map((row) => [row.itemId, "Faulty"])));
  const mixed = useMemo(() => new Set(rows.map((row) => `${row.site}|${row.siteAddress || ""}|${row.cloud}`)).size > 1, [rows]);
  const [site, setSite] = useState({ code: "", address: "", cloud: "" });
  const ready = Boolean(mode) && (!mixed || Boolean(site.code.trim() && site.address.trim() && site.cloud.trim()));
  const confirmLabel = mode === "manual-sent" ? "Record as manually sent" : "Generate and export";
  return <Modal title="Fault Tag" subtitle="Choose how this return document was handled. Either path waits for matching warehouse email evidence before final confirmation." onClose={onCancel} wide actions={<><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className={mode === "manual-sent" ? "create-button" : "primary-button"} disabled={busy || !ready} onClick={() => mode && onConfirm(mode, rows.map((row) => ({ itemId: row.itemId, condition: conditions[row.itemId] })), mixed ? site : undefined)}>{busy ? "Working…" : confirmLabel}</button></>}>
    <div className="fault-tag-mode-picker" role="group" aria-label="Fault Tag handling">
      <button type="button" className={mode === "export" ? "active export" : "export"} aria-label="Generate and export Fault Tag option" aria-pressed={mode === "export"} onClick={() => setMode("export")}><strong>Generate and export</strong><span>Create a new Fault Tag workbook with an internal ID.</span></button>
      <button type="button" className={mode === "manual-sent" ? "active manual" : "manual"} aria-label="Already sent manually option" aria-pressed={mode === "manual-sent"} onClick={() => setMode("manual-sent")}><strong>Already sent manually</strong><span>Create an internal ID, mark it sent, and wait for the warehouse reply.</span></button>
    </div>
    <div className="fault-tag-export-list">{rows.map((row) => <article className={conditions[row.itemId].toLowerCase()} key={row.itemId}><div><strong>{row.rma}</strong><span>TT {row.ticketId} · {row.requestedBom} · {row.site}</span></div><label className="form-field"><span>Return condition</span><select value={conditions[row.itemId]} onChange={(event) => setConditions((current) => ({ ...current, [row.itemId]: event.target.value as "Faulty" | "New" }))}><option value="Faulty">Faulty</option><option value="New">New</option></select></label></article>)}</div>
    {mixed && <section className="local-confirmation"><p>Selected items come from different sites. Enter the actual site receiving this return.</p><div className="form-grid three"><label className="form-field"><span>Site code</span><input value={site.code} onChange={(event) => setSite((current) => ({ ...current, code: event.target.value }))} /></label><label className="form-field"><span>Cloud</span><input value={site.cloud} onChange={(event) => setSite((current) => ({ ...current, cloud: event.target.value }))} /></label><label className="form-field full"><span>Return address</span><input value={site.address} onChange={(event) => setSite((current) => ({ ...current, address: event.target.value }))} /></label></div></section>}
  </Modal>;
}
