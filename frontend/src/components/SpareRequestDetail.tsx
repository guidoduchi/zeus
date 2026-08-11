import { useEffect, useState } from "react";
import {
  deleteSpareRequest,
  reexportSpareRequest,
  resolveSpareConflict,
  saveSpareRequest,
} from "../api";
import { isEditingArea } from "../hooks/useGlobalCommands";
import type { SpareRequestDetail as Detail } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";

interface Props {
  request: Detail | null;
  loading: boolean;
  onClose: () => void;
  onChanged: (request: Detail | null) => void;
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
  onLifecycle: (
    itemId: string,
    action: "advance" | "rollback",
    manualFacts?: { spareSr: string; rma: string; note: string },
  ) => void;
  onFaultTag: (itemId: string) => void;
}

interface ItemDraft {
  rma: string;
  deliveredBom: string;
  newSn: string;
  notes: string;
}

interface PendingResolution {
  itemId: string | undefined;
  index: number;
  resolution: "keep-existing" | "accept-incoming";
}

function conflictValue(conflict: Record<string, unknown>, key: string): string {
  const value = conflict[key];
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

const NEXT_ACTION_LABELS: Record<number, string> = {
  0: "Confirm request email sent",
  1: "Confirm SR and RMA",
  2: "Confirm spare dispatched",
  3: "Confirm spare replaced",
  5: "Confirm warehouse return",
};

export function SpareRequestDetail({ request, loading, onClose, onChanged, onRefresh, onError, onNotice, onLifecycle, onFaultTag }: Props) {
  const [tab, setTab] = useState<"items" | "emails" | "history">("items");
  const [ticketId, setTicketId] = useState("");
  const [spareSr, setSpareSr] = useState("");
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [working, setWorking] = useState(false);
  const [pendingResolution, setPendingResolution] = useState<PendingResolution | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!request) return;
    setTicketId(request.ticketId);
    setSpareSr(request.spareSr || "");
    setNote("");
    setDrafts(Object.fromEntries(safeArray(request.items).map((item) => [item.item_id, {
      rma: item.rma || "",
      deliveredBom: item.delivered_bom || "",
      newSn: item.new_sn || "",
      notes: item.notes || "",
    }])));
  }, [request?.requestId, request?.revision]);

  useEffect(() => {
    const tabs = ["items", "emails", "history"] as const;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.repeat
        || event.altKey
        || event.ctrlKey
        || event.metaKey
        || isEditingArea(event.target)
        || document.querySelector(".modal-backdrop")
      ) return;
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      setTab((current) => {
        const index = tabs.indexOf(current);
        return tabs[Math.max(0, Math.min(tabs.length - 1, index + delta))];
      });
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (loading && !request) return <aside className="detail-panel"><div className="detail-loading">Reading Spare Request…</div></aside>;
  if (!request) return null;
  const currentRequest = request;

  function updateItem(itemId: string, patch: Partial<ItemDraft>) {
    setDrafts((current) => ({ ...current, [itemId]: { ...current[itemId], ...patch } }));
  }

  async function save() {
    setWorking(true);
    try {
      const changes: Record<string, unknown> = { note };
      if (ticketId !== currentRequest.ticketId) changes.ticketId = ticketId;
      if (spareSr !== (currentRequest.spareSr || "")) changes.spareSr = spareSr;
      const itemUpdates = safeArray(currentRequest.items).flatMap((item) => {
        const draft = drafts[item.item_id];
        const update: Record<string, unknown> = { itemId: item.item_id };
        if (draft.rma !== (item.rma || "")) update.rma = draft.rma;
        if (draft.deliveredBom !== (item.delivered_bom || "")) update.deliveredBom = draft.deliveredBom;
        if (draft.newSn !== (item.new_sn || "")) update.newSn = draft.newSn;
        if (draft.notes !== (item.notes || "")) update.notes = draft.notes;
        return Object.keys(update).length > 1 ? [update] : [];
      });
      const result = await saveSpareRequest(
        currentRequest.requestId,
        currentRequest.revision,
        changes,
        itemUpdates,
      );
      onChanged(result.request);
      await onRefresh();
      onNotice("Spare Request saved. Existing immutable values were preserved; contradictions became conflicts.");
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  }

  async function reexport() {
    setWorking(true);
    try {
      const result = await reexportSpareRequest(currentRequest.requestId);
      onChanged(result.request);
      await onRefresh();
      onNotice(`Exported ${result.filename}. Subject: ${result.subject}`);
    } catch (error) { onError(error); } finally { setWorking(false); }
  }

  async function removeUnconfirmedRequest() {
    setWorking(true);
    try {
      const result = await deleteSpareRequest(
        currentRequest.requestId,
        currentRequest.revision,
      );
      setDeleteOpen(false);
      onChanged(null);
      await onRefresh();
      onNotice(`Deleted unconfirmed request ${result.deleted}. Its source BOM/slot is eligible again.${result.exportPreserved ? " The exported XLSX was preserved on disk." : ""}`);
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  }

  function beginResolution(itemId: string | undefined, index: number, resolution: "keep-existing" | "accept-incoming") {
    setPendingResolution({ itemId, index, resolution });
    setResolutionNote(note);
  }

  async function resolvePending() {
    if (!pendingResolution || !resolutionNote.trim()) return;
    setWorking(true);
    try {
      const result = await resolveSpareConflict(currentRequest.requestId, {
        itemId: pendingResolution.itemId,
        conflictIndex: pendingResolution.index,
        resolution: pendingResolution.resolution,
        note: resolutionNote.trim(),
      });
      onChanged(result.request);
      await onRefresh();
      onNotice("Conflict resolved with an audit note.");
      setPendingResolution(null);
      setResolutionNote("");
    } catch (error) { onError(error); } finally { setWorking(false); }
  }

  function copySubject(value: string) {
    navigator.clipboard.writeText(value).then(() => onNotice("Email subject copied.")).catch(onError);
  }

  const allConflicts = [
    ...safeArray(request.conflicts).map((conflict, index) => ({ conflict, index, itemId: undefined as string | undefined })),
    ...safeArray(request.items).flatMap((item) => safeArray(item.conflicts).map((conflict, index) => ({ conflict, index, itemId: item.item_id }))),
  ].filter(({ conflict }) => !conflict.resolved_at);

  return <>
    <aside className="detail-panel spare-request-detail" aria-label={`Spare Request ${request.requestId} detail`}>
      <header className="detail-header">
        <div><span className={request.trackingIdProvisional ? "provisional-tracking" : ""}>TRACKING {request.trackingId}</span><h2>TT {request.ticketId} · {request.spareSr || "7-digit SR pending"}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close Spare Request detail">×</button>
      </header>
      <nav className="detail-tabs" aria-label="Spare Request sections">
        <button type="button" className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>Items <small>{safeArray(request.items).length}</small></button>
        <button type="button" className={tab === "emails" ? "active" : ""} onClick={() => setTab("emails")}>Emails <small>{request.email.count}</small></button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History <small>{safeArray(request.history).length}</small></button>
      </nav>
      <div className="detail-scroll">
        {tab === "items" && <div className="tab-content spare-request-items">
          <div className="source-contract">
            <strong>Independent persistent request.</strong>
            <span>Requested BOMs stay separate from delivered substitutions. Every current or previous RMA identity stays reserved to one unit.</span>
            <span className="request-entry-guidance">{request.creationMethod === "zeus_create"
              ? "Created in Zeus at Added to Zeus. You can confirm the sent request manually; later matching email is attached without advancing twice."
              : request.creationMethod === "zeus_export"
                ? "The workbook was exported. Confirm the request email manually after sending it, or let email synchronization detect it."
                : "Legacy evidence is preserved. Review the history before changing manual facts."}</span>
          </div>
          <div className="request-identity-form">
            <label className="form-field"><span>Original TT</span><input value={ticketId} disabled={!request.ttEditable} maxLength={8} onChange={(event) => setTicketId(event.target.value.replace(/\D/g, ""))} /></label>
            <label className="form-field"><span>Tracking ID</span><input className={request.trackingIdProvisional ? "provisional-tracking-input" : ""} value={request.trackingId} readOnly /></label>
            <label className="form-field"><span>Spare SR</span><input value={spareSr} placeholder="SR1234567" onChange={(event) => setSpareSr(event.target.value.toUpperCase())} /></label>
            <button type="button" className="secondary-button field-button" disabled={working} onClick={reexport}>Re-export request XLSX</button>
            <button type="button" className="secondary-button field-button" onClick={() => copySubject(request.export.subject)}>Copy request subject</button>
          </div>
          {allConflicts.length > 0 && <section className="conflict-panel"><header><strong>{allConflicts.length} unresolved conflict(s)</strong><span>Nothing was overwritten</span></header>{allConflicts.map(({ conflict, index, itemId }, position) => { const field = String(conflict.field || ""); const canAccept = ["spare_sr", "delivered_bom", "new_sn"].includes(field); return <article key={`${itemId}-${index}-${position}`}><div><strong>{field || "field"}</strong><span>{itemId || "request"}</span><p>Existing: {conflictValue(conflict, "existing")} · Incoming: {conflictValue(conflict, "incoming")}</p></div><div><button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "keep-existing")}>Keep existing</button>{canAccept && <button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "accept-incoming")}>Accept incoming</button>}</div></article>; })}</section>}
          <div className="request-item-list">
            {safeArray(request.items).map((item) => {
              const draft = drafts[item.item_id];
              if (!draft) return null;
              const spareSrReady = /^(?:SR\s*)?\d{7}$/i.test(spareSr.trim());
              const rmaReady = /^C\d{10}$/i.test(draft.rma.trim());
              const rollbackAvailable = item.lifecycle.stage > 0 && !(
                item.lifecycle.stage === 1
                && safeArray(request.items).some((candidate) => candidate.lifecycle.stage !== 1)
              );
              return <article className="request-item-card" data-lifecycle={item.lifecycleColor} key={item.item_id}>
                <header><strong>Unit {item.ordinal}</strong><span className={`status-chip lifecycle-${item.lifecycleColor}`}>{item.statusLabel}</span><span>{item.dispatchAgeDays === null ? "Timer not started" : `${item.dispatchAgeDays} day(s)`}</span></header>
                <div className="lifecycle-quest">
                  <div className="lifecycle-quest-heading"><strong>Lifecycle · {item.lifecycle.label}</strong><span>{item.lifecycle.source || "Zeus"}</span></div>
                  <ol aria-label={`Unit ${item.ordinal} lifecycle`}>
                    {item.lifecycle.stages.map((stage) => <li className={stage.reached ? "reached" : ""} aria-current={stage.stage === item.lifecycle.stage ? "step" : undefined} title={`${stage.label}${stage.timestamp ? ` · ${stage.timestamp}` : ""}`} key={stage.stage}><i aria-hidden="true">{stage.reached ? "✓" : "·"}</i><span>{stage.label}</span></li>)}
                  </ol>
                </div>
                <div className="item-bom-pair"><div><span>Requested BOM</span><strong>{item.requested_bom}</strong></div><div><span>Delivered / substitute BOM</span><strong>{item.delivered_bom || "—"}</strong></div></div>
                <div className="form-grid four">
                  <label className="form-field"><span>RMA · C + 10 digits</span><input value={draft.rma} maxLength={11} placeholder="C1234567890" onChange={(event) => updateItem(item.item_id, { rma: event.target.value.toUpperCase() })} />{safeArray(item.rma_aliases).length > 0 && <small>Previous: {safeArray(item.rma_aliases).join(", ")}</small>}</label>
                  <label className="form-field"><span>Delivered BOM</span><input value={draft.deliveredBom} onChange={(event) => updateItem(item.item_id, { deliveredBom: event.target.value })} /></label>
                  <label className="form-field"><span>New SN</span><input value={draft.newSn} onChange={(event) => updateItem(item.item_id, { newSn: event.target.value })} /></label>
                  <label className="form-field wide"><span>Item notes</span><input value={draft.notes} onChange={(event) => updateItem(item.item_id, { notes: event.target.value })} /></label>
                </div>
                <footer>
                  <span>{item.rma || "RMA pending"} · {item.new_sn || "New SN pending"}{item.return_condition ? ` · ${item.return_condition}` : ""}</span>
                  {(item.warehouse_confirmed_at || item.warehouse_candidate_at) && <strong className="green-text">Warehouse evidence received · explicit user confirmation still required</strong>}
                  <div className="item-lifecycle-actions">
                    {item.lifecycle.stage === 4
                      ? item.return_export_filename || item.return_condition
                        ? <span>Fault Tag already linked</span>
                        : <button type="button" className="primary-button" disabled={working || !item.rma} onClick={() => onFaultTag(item.item_id)}>Fault Tag</button>
                      : NEXT_ACTION_LABELS[item.lifecycle.stage] && <button
                          type="button"
                          className="primary-button"
                          disabled={working || (item.lifecycle.stage === 1 && !(spareSrReady && rmaReady))}
                          onClick={() => onLifecycle(
                            item.item_id,
                            "advance",
                            item.lifecycle.stage === 1
                              ? { spareSr: spareSr.trim(), rma: draft.rma.trim().toUpperCase(), note: note.trim() }
                              : undefined,
                          )}
                        >{NEXT_ACTION_LABELS[item.lifecycle.stage]}</button>}
                    {item.lifecycle.stage > 0 && <button type="button" className="secondary-button" disabled={working || !rollbackAvailable} title={rollbackAvailable ? "Roll back exactly one stage" : "Roll later-stage sibling items back first"} onClick={() => onLifecycle(item.item_id, "rollback")}>Roll back last stage</button>}
                  </div>
                </footer>
              </article>;
            })}
          </div>
          <section className="archive-controls">
            <label className="form-field full"><span>Audit note</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div><button type="button" className="primary-button" disabled={working} onClick={save}>{working ? "Working…" : "Save manual facts"}</button>{request.canDelete && <button type="button" className="danger-button delete-request-button" disabled={working} onClick={() => setDeleteOpen(true)}>Delete unconfirmed request</button>}</div>
            <small>Use each item’s current action here, or select multiple rows in Active Requests for the same stage-aware bulk action.</small>
          </section>
        </div>}
        {tab === "emails" && <div className="tab-content spare-email-list">{safeArray(request.email.messages).length ? safeArray(request.email.messages).map((message, index) => <article key={String(message.message_key || index)}><header><strong>{String(message.subject || "(no subject)")}</strong><span>{String(message.timestamp || "")}</span></header><small>{String(message.direction || "")} · {String(message.sender || "")}</small><pre>{String(message.latest_reply_body || message.body || "Body purged or unavailable.")}</pre></article>) : <div className="empty-panel">No spare-related email retained for this request.</div>}</div>}
        {tab === "history" && <div className="history-list">{safeArray(request.history).map((event, index) => <article key={`${event.timestamp}-${index}`}><time>{event.timestamp}</time><strong>{event.action}</strong><pre>{JSON.stringify(event.summary, null, 2)}</pre></article>)}</div>}
      </div>
    </aside>
    {pendingResolution && <ConfirmationDialog
      title={pendingResolution.resolution === "keep-existing" ? "Keep the existing value?" : "Accept the incoming value?"}
      message="A resolution note is required so this decision remains auditable in the local request history."
      confirmLabel="Resolve conflict"
      busy={working}
      confirmDisabled={!resolutionNote.trim()}
      onCancel={() => setPendingResolution(null)}
      onConfirm={() => void resolvePending()}
    >
      <label className="form-field"><span>Resolution note *</span><textarea value={resolutionNote} onChange={(event) => setResolutionNote(event.target.value)} autoFocus /></label>
    </ConfirmationDialog>}
    {deleteOpen && <ConfirmationDialog
      title={`Delete unconfirmed request ${request.requestId}?`}
      message="This removes the Active Request and releases its exact BOM/slot record for editing and eligibility. Any XLSX already exported to disk is preserved."
      confirmLabel="Delete active request"
      tone="danger"
      busy={working}
      onCancel={() => setDeleteOpen(false)}
      onConfirm={() => void removeUnconfirmedRequest()}
    />}
  </>;
}
