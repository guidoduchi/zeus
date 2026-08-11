import { useMemo, useState } from "react";
import type { SpareRequestItemSummary } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

export function SpareLifecycleBulkDialog({ rows, action, busy, onCancel, onConfirm }: {
  rows: SpareRequestItemSummary[];
  action: "advance" | "rollback";
  busy: boolean;
  onCancel: () => void;
  onConfirm: (emailOverrideConfirmed: boolean, note: string) => void;
}) {
  const emailBacked = action === "rollback" && rows.some((row) => row.rollbackRequiresDoubleConfirmation);
  const [secondConfirmation, setSecondConfirmation] = useState(false);
  const [note, setNote] = useState("");
  const transitions = rows.map((row) => action === "advance"
    ? `${row.rma} → ${row.nextStageLabel || "Complete"}`
    : `${row.rma} ← ${row.lifecycleStageLabel}`
  );
  return <ConfirmationDialog
    title={`${action === "advance" ? "Confirm next stage" : "Roll back last stage"} for ${rows.length} item(s)?`}
    message={action === "advance" ? "Each selected item advances exactly one lifecycle stage. Request-email and warehouse-evidence stages require matching email and cannot be advanced manually." : "Each selected item rolls back exactly one stage. Email evidence is retained."}
    confirmLabel={action === "advance" ? "Confirm next stage" : "Roll back one stage"}
    tone={action === "rollback" ? "danger" : "primary"}
    busy={busy}
    confirmDisabled={emailBacked && (!secondConfirmation || !note.trim())}
    onCancel={onCancel}
    onConfirm={() => onConfirm(secondConfirmation, note)}
  >
    <ul>{transitions.map((transition) => <li key={transition}>{transition}</li>)}</ul>
    {emailBacked && <div className="email-override-confirmation"><label><input type="checkbox" checked={secondConfirmation} onChange={(event) => setSecondConfirmation(event.target.checked)} /> I explicitly override the email-backed lifecycle effect.</label><label className="form-field"><span>Required audit note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this email-backed stage must be rolled back" /></label></div>}
  </ConfirmationDialog>;
}

export function FaultTagExportDialog({ rows, busy, onCancel, onConfirm }: {
  rows: SpareRequestItemSummary[];
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
