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
  return <ConfirmationDialog
    title={`${action === "advance" ? advanceLabel : "Roll back last stage"} for ${rows.length} item(s)?`}
    message={action === "advance"
      ? sharedEmail
        ? "This manually records the request email as sent for every item in the same Spare Request. A later matching email attaches as evidence without advancing twice."
        : "Each selected item advances exactly one lifecycle stage using the confirmation time below."
      : "Each selected item rolls back exactly one stage. Email evidence is retained and suppressed from re-advancing the item."}
    confirmLabel={action === "advance" ? advanceLabel : "Roll back one stage"}
    tone={action === "rollback" ? "danger" : "primary"}
    busy={busy}
    confirmDisabled={(emailBacked && (!secondConfirmation || !note.trim())) || (action === "advance" && !confirmedAt)}
    onCancel={onCancel}
    onConfirm={() => onConfirm(
      secondConfirmation,
      note,
      action === "advance" && confirmedAt ? new Date(confirmedAt).toISOString() : undefined,
    )}
  >
    <ul>{transitions.map((transition, index) => <li key={`${transition}-${index}`}>{transition}</li>)}</ul>
    {action === "advance" && <label className="form-field"><span>Confirmation time</span><input type="datetime-local" value={confirmedAt} onChange={(event) => setConfirmedAt(event.target.value)} /></label>}
    {emailBacked && <div className="email-override-confirmation"><label><input type="checkbox" checked={secondConfirmation} onChange={(event) => setSecondConfirmation(event.target.checked)} /> I explicitly override the email-backed lifecycle effect.</label><label className="form-field"><span>Required audit note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this email-backed stage must be rolled back" /></label></div>}
  </ConfirmationDialog>;
}

export function FaultTagExportDialog({ rows, busy, onCancel, onConfirm }: {
  rows: FaultTagTarget[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (selections: Array<{ itemId: string; condition: "Faulty" | "New" }>, returnSite?: { code: string; address: string; cloud: string }) => void;
}) {
  const [conditions, setConditions] = useState<Record<string, "Faulty" | "New">>(() => Object.fromEntries(rows.map((row) => [row.itemId, "Faulty"])));
  const mixed = useMemo(() => new Set(rows.map((row) => `${row.site}|${row.siteAddress || ""}|${row.cloud}`)).size > 1, [rows]);
  const [site, setSite] = useState({ code: "", address: "", cloud: "" });
  const ready = !mixed || Boolean(site.code.trim() && site.address.trim() && site.cloud.trim());
  return <Modal title="Export new Fault Tag" subtitle="This creates an independent batch document. Exporting it does not change Active Request lifecycle stages." onClose={onCancel} wide actions={<><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button><button type="button" className="primary-button" disabled={busy || !ready} onClick={() => onConfirm(rows.map((row) => ({ itemId: row.itemId, condition: conditions[row.itemId] })), mixed ? site : undefined)}>{busy ? "Exporting…" : "Export Fault Tag"}</button></>}>
    <div className="fault-tag-export-list">{rows.map((row) => <article className={conditions[row.itemId].toLowerCase()} key={row.itemId}><div><strong>{row.rma}</strong><span>TT {row.ticketId} · {row.requestedBom} · {row.site}</span></div><label className="form-field"><span>Return condition</span><select value={conditions[row.itemId]} onChange={(event) => setConditions((current) => ({ ...current, [row.itemId]: event.target.value as "Faulty" | "New" }))}><option value="Faulty">Faulty</option><option value="New">New</option></select></label></article>)}</div>
    {mixed && <section className="local-confirmation"><p>Selected items come from different sites. Enter the actual site receiving this return.</p><div className="form-grid three"><label className="form-field"><span>Site code</span><input value={site.code} onChange={(event) => setSite((current) => ({ ...current, code: event.target.value }))} /></label><label className="form-field"><span>Cloud</span><input value={site.cloud} onChange={(event) => setSite((current) => ({ ...current, cloud: event.target.value }))} /></label><label className="form-field full"><span>Return address</span><input value={site.address} onChange={(event) => setSite((current) => ({ ...current, address: event.target.value }))} /></label></div></section>}
  </Modal>;
}
