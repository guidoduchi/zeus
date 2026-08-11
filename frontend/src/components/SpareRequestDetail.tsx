import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeRequestDraftChanges,
  activeRequestDraftValue,
  analyzeActiveRequestDraft,
  clearActiveRequestDraft,
  clearActiveRequestDraftUndo,
  discardActiveRequestDraft,
  hasActiveRequestDraftUndo,
  readActiveRequestDraft,
  undoActiveRequestDraft,
  writeActiveRequestDraft,
  type ActiveRequestDraftValue,
  type StoredActiveRequestDraft,
} from "../activeRequestDrafts";
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
  showHistory?: boolean;
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

const EMPTY_DRAFT: ActiveRequestDraftValue = {
  ticketId: "",
  spareSr: "",
  note: "",
  items: {},
};

export function SpareRequestDetail({ request, loading, onClose, onChanged, onRefresh, onError, onNotice, onLifecycle, onFaultTag, showHistory = false }: Props) {
  const [tab, setTab] = useState<"items" | "emails" | "history">("items");
  const [draft, setDraft] = useState<ActiveRequestDraftValue>(EMPTY_DRAFT);
  const [draftRevision, setDraftRevision] = useState("");
  const [baseValue, setBaseValue] = useState<ActiveRequestDraftValue>(EMPTY_DRAFT);
  const [staleFields, setStaleFields] = useState<string[]>([]);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [working, setWorking] = useState(false);
  const [pendingResolution, setPendingResolution] = useState<PendingResolution | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const editSession = useRef<{ key: string; before: StoredActiveRequestDraft | null } | null>(null);

  const detailTabs = useMemo<Array<"items" | "emails" | "history">>(
    () => showHistory ? ["items", "emails", "history"] : ["items", "emails"],
    [showHistory],
  );

  useEffect(() => {
    if (!request || working) return;
    editSession.current = null;
    const current = activeRequestDraftValue(request);
    const stored = readActiveRequestDraft(request.requestId);
    if (!stored) {
      setDraft(current);
      setDraftRevision(request.revision);
      setBaseValue(current);
      setStaleFields([]);
      setUndoAvailable(hasActiveRequestDraftUndo(request.requestId));
      return;
    }
    const analysis = analyzeActiveRequestDraft(request, stored);
    if (!analysis) {
      clearActiveRequestDraft(request.requestId);
      setDraft(current);
      setDraftRevision(request.revision);
      setBaseValue(current);
      setStaleFields([]);
      setUndoAvailable(false);
      return;
    }
    setDraft(analysis.rebased.value);
    if (analysis.conflictFields.length) {
      setDraftRevision(stored.revision);
      setBaseValue(stored.baseValue);
      setStaleFields(analysis.conflictFields);
    } else {
      setDraftRevision(request.revision);
      setBaseValue(current);
      setStaleFields([]);
      if (stored.revision !== request.revision) {
        clearActiveRequestDraftUndo(request.requestId);
        writeActiveRequestDraft(request.requestId, analysis.rebased);
      }
    }
    setUndoAvailable(hasActiveRequestDraftUndo(request.requestId));
  }, [request?.requestId, request?.revision, working]);

  useEffect(() => {
    if (!showHistory && tab === "history") setTab("items");
  }, [showHistory, tab]);

  useEffect(() => {
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
        const index = detailTabs.indexOf(current);
        return detailTabs[Math.max(0, Math.min(detailTabs.length - 1, index + delta))];
      });
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailTabs]);

  if (loading && !request) return <aside className="detail-panel"><div className="detail-loading">Reading Spare Request…</div></aside>;
  if (!request) return null;
  const currentRequest = request;
  const pendingChanges = activeRequestDraftChanges(currentRequest, draft);
  const changedCount = pendingChanges.fields.length;

  function beginDraftAction(key: string) {
    editSession.current = { key, before: readActiveRequestDraft(currentRequest.requestId) };
  }

  function endDraftAction(key: string) {
    if (editSession.current?.key === key) editSession.current = null;
  }

  function updateDraft(key: string, update: (current: ActiveRequestDraftValue) => ActiveRequestDraftValue) {
    setDraft((current) => {
      const next = update(structuredClone(current));
      const changes = activeRequestDraftChanges(currentRequest, next);
      const before = editSession.current?.key === key
        ? editSession.current.before
        : readActiveRequestDraft(currentRequest.requestId);
      if (changes.fields.length) {
        writeActiveRequestDraft(currentRequest.requestId, {
          revision: draftRevision,
          baseValue,
          value: next,
        }, { undoBase: before });
      } else {
        clearActiveRequestDraft(currentRequest.requestId, { keepUndo: true });
      }
      setUndoAvailable(true);
      return next;
    });
  }

  function updateRequestField(field: "ticketId" | "spareSr" | "note", value: string) {
    updateDraft(`request:${field}`, (current) => ({ ...current, [field]: value }));
  }

  function updateItem(itemId: string, field: "rma" | "deliveredBom" | "newSn" | "notes", value: string) {
    updateDraft(`item:${itemId}:${field}`, (current) => ({
      ...current,
      items: {
        ...current.items,
        [itemId]: { ...current.items[itemId], [field]: value },
      },
    }));
  }

  function discardDraft() {
    const current = activeRequestDraftValue(currentRequest);
    const canUndo = discardActiveRequestDraft(currentRequest.requestId);
    editSession.current = null;
    setDraft(current);
    setDraftRevision(currentRequest.revision);
    setBaseValue(current);
    setStaleFields([]);
    setUndoAvailable(canUndo);
  }

  function undoLastDraftAction() {
    const restored = undoActiveRequestDraft(currentRequest.requestId);
    if (!restored) {
      const current = activeRequestDraftValue(currentRequest);
      setDraft(current);
      setDraftRevision(currentRequest.revision);
      setBaseValue(current);
      setStaleFields([]);
    } else {
      const analysis = analyzeActiveRequestDraft(currentRequest, restored);
      if (!analysis) {
        clearActiveRequestDraft(currentRequest.requestId);
        const current = activeRequestDraftValue(currentRequest);
        setDraft(current);
        setDraftRevision(currentRequest.revision);
        setBaseValue(current);
        setStaleFields([]);
      } else {
        setDraft(analysis.rebased.value);
        setDraftRevision(analysis.conflictFields.length ? restored.revision : currentRequest.revision);
        setBaseValue(analysis.conflictFields.length ? restored.baseValue : activeRequestDraftValue(currentRequest));
        setStaleFields(analysis.conflictFields);
      }
    }
    editSession.current = null;
    setUndoAvailable(false);
  }

  async function save() {
    if (!changedCount || staleFields.length) return;
    setWorking(true);
    try {
      const result = await saveSpareRequest(
        currentRequest.requestId,
        currentRequest.revision,
        pendingChanges.changes,
        pendingChanges.itemUpdates,
      );
      clearActiveRequestDraft(currentRequest.requestId);
      editSession.current = null;
      setUndoAvailable(false);
      onChanged(result.request);
      await onRefresh();
      onNotice("Active Request draft saved. Existing immutable values were preserved; contradictions became conflicts.");
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
      clearActiveRequestDraft(currentRequest.requestId);
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
    setResolutionNote(draft.note);
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
        {showHistory && <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History <small>{safeArray(request.history).length}</small></button>}
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
                : "Legacy evidence is preserved. Raw audit history remains available through the optional developer view."}</span>
          </div>
          {staleFields.length > 0 && <div className="inline-warning">Zeus changed {staleFields.join(", ")} after this protected draft began. Undo or discard the draft, then re-enter those values over the latest request.</div>}
          <div className="request-identity-form">
            <label className="form-field"><span>Original TT</span><input value={draft.ticketId} disabled={!request.ttEditable} maxLength={8} onFocus={() => beginDraftAction("request:ticketId")} onBlur={() => endDraftAction("request:ticketId")} onChange={(event) => updateRequestField("ticketId", event.target.value.replace(/\D/g, ""))} /></label>
            <label className="form-field"><span>Tracking ID</span><input className={request.trackingIdProvisional ? "provisional-tracking-input" : ""} value={request.trackingId} readOnly /></label>
            <label className="form-field"><span>Spare SR</span><input value={draft.spareSr} placeholder="SR1234567" onFocus={() => beginDraftAction("request:spareSr")} onBlur={() => endDraftAction("request:spareSr")} onChange={(event) => updateRequestField("spareSr", event.target.value.toUpperCase())} /></label>
            <button type="button" className="secondary-button field-button" disabled={working} onClick={reexport}>Re-export request XLSX</button>
            <button type="button" className="secondary-button field-button" onClick={() => copySubject(request.export.subject)}>Copy request subject</button>
          </div>
          {allConflicts.length > 0 && <section className="conflict-panel"><header><strong>{allConflicts.length} unresolved conflict(s)</strong><span>Nothing was overwritten</span></header>{allConflicts.map(({ conflict, index, itemId }, position) => { const field = String(conflict.field || ""); const canAccept = ["spare_sr", "delivered_bom", "new_sn"].includes(field); return <article key={`${itemId}-${index}-${position}`}><div><strong>{field || "field"}</strong><span>{itemId || "request"}</span><p>Existing: {conflictValue(conflict, "existing")} · Incoming: {conflictValue(conflict, "incoming")}</p></div><div><button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "keep-existing")}>Keep existing</button>{canAccept && <button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "accept-incoming")}>Accept incoming</button>}</div></article>; })}</section>}
          <div className="request-item-list">
            {safeArray(request.items).map((item) => {
              const itemDraft = draft.items[item.item_id];
              if (!itemDraft) return null;
              const spareSrReady = /^(?:SR\s*)?\d{7}$/i.test(draft.spareSr.trim());
              const rmaReady = /^C\d{10}$/i.test(itemDraft.rma.trim());
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
                  <label className="form-field"><span>RMA · C + 10 digits</span><input value={itemDraft.rma} maxLength={11} placeholder="C1234567890" onFocus={() => beginDraftAction(`item:${item.item_id}:rma`)} onBlur={() => endDraftAction(`item:${item.item_id}:rma`)} onChange={(event) => updateItem(item.item_id, "rma", event.target.value.toUpperCase())} />{safeArray(item.rma_aliases).length > 0 && <small>Previous: {safeArray(item.rma_aliases).join(", ")}</small>}</label>
                  <label className="form-field"><span>Delivered BOM</span><input value={itemDraft.deliveredBom} onFocus={() => beginDraftAction(`item:${item.item_id}:deliveredBom`)} onBlur={() => endDraftAction(`item:${item.item_id}:deliveredBom`)} onChange={(event) => updateItem(item.item_id, "deliveredBom", event.target.value)} /></label>
                  <label className="form-field"><span>New SN</span><input value={itemDraft.newSn} onFocus={() => beginDraftAction(`item:${item.item_id}:newSn`)} onBlur={() => endDraftAction(`item:${item.item_id}:newSn`)} onChange={(event) => updateItem(item.item_id, "newSn", event.target.value)} /></label>
                  <label className="form-field wide"><span>Item notes</span><input value={itemDraft.notes} onFocus={() => beginDraftAction(`item:${item.item_id}:notes`)} onBlur={() => endDraftAction(`item:${item.item_id}:notes`)} onChange={(event) => updateItem(item.item_id, "notes", event.target.value)} /></label>
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
                              ? { spareSr: draft.spareSr.trim(), rma: itemDraft.rma.trim().toUpperCase(), note: draft.note.trim() }
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
            <label className="form-field full"><span>Audit note</span><textarea rows={3} value={draft.note} onFocus={() => beginDraftAction("request:note")} onBlur={() => endDraftAction("request:note")} onChange={(event) => updateRequestField("note", event.target.value)} /></label>
            <div>
              {undoAvailable && <button type="button" className="secondary-button" disabled={working} onClick={undoLastDraftAction}>Undo last draft action</button>}
              {changedCount > 0 && <button type="button" className="text-button danger-text" disabled={working} onClick={discardDraft}>Discard draft</button>}
              <button type="button" className="primary-button" disabled={working || !changedCount || staleFields.length > 0} onClick={save}>{working ? "Working…" : "Save manual facts"}</button>
              {request.canDelete && <button type="button" className="danger-button delete-request-button" disabled={working} onClick={() => setDeleteOpen(true)}>Delete unconfirmed request</button>}
            </div>
            <small>{changedCount ? `${changedCount} changed field${changedCount === 1 ? "" : "s"} · Active Request draft protected in this browser.` : "No unsaved manual facts."} Use each item’s current action here, or select multiple rows in Active Requests for the same stage-aware bulk action.</small>
          </section>
        </div>}
        {tab === "emails" && <div className="tab-content spare-email-list">{safeArray(request.email.messages).length ? safeArray(request.email.messages).map((message, index) => <article key={String(message.message_key || index)}><header><strong>{String(message.subject || "(no subject)")}</strong><span>{String(message.timestamp || "")}</span></header><small>{String(message.direction || "")} · {String(message.sender || "")}</small><pre>{String(message.latest_reply_body || message.body || "Body purged or unavailable.")}</pre></article>) : <div className="empty-panel">No spare-related email retained for this request.</div>}</div>}
        {showHistory && tab === "history" && <div className="history-list">{safeArray(request.history).map((event, index) => <article key={`${event.timestamp}-${index}`}><time>{event.timestamp}</time><strong>{event.action}</strong><pre>{JSON.stringify(event.summary, null, 2)}</pre></article>)}</div>}
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
