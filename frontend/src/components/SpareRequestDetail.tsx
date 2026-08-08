import { useEffect, useMemo, useState } from "react";
import {
  archiveSpareItems,
  exportSpareReturn,
  getSpareRequest,
  reexportSpareRequest,
  resolveSpareConflict,
  saveSpareRequest,
} from "../api";
import { isEditingArea } from "../hooks/useGlobalCommands";
import type { SpareRequestDetail as Detail, SpareRequestItem } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";

interface Props {
  request: Detail | null;
  loading: boolean;
  onClose: () => void;
  onChanged: (request: Detail | null) => void;
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
}

interface ItemDraft {
  rma: string;
  deliveredBom: string;
  newSn: string;
  dispatchAt: string;
  notes: string;
  attended: boolean;
  selected: boolean;
  condition: "Faulty" | "New";
}

interface PendingResolution {
  itemId: string | undefined;
  index: number;
  resolution: "keep-existing" | "accept-incoming";
}

function datetimeInput(value: string | null): string {
  return value ? value.slice(0, 16) : "";
}

function conflictValue(conflict: Record<string, unknown>, key: string): string {
  const value = conflict[key];
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function SpareRequestDetail({ request, loading, onClose, onChanged, onRefresh, onError, onNotice }: Props) {
  const [tab, setTab] = useState<"items" | "emails" | "history">("items");
  const [ticketId, setTicketId] = useState("");
  const [spareSr, setSpareSr] = useState("");
  const [note, setNote] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [archiveReason, setArchiveReason] = useState<"returned" | "cancelled">("returned");
  const [manualOverride, setManualOverride] = useState(false);
  const [working, setWorking] = useState(false);
  const [pendingResolution, setPendingResolution] = useState<PendingResolution | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");

  useEffect(() => {
    if (!request) return;
    setTicketId(request.ticketId);
    setSpareSr(request.spareSr || "");
    setNote("");
    setDrafts(Object.fromEntries(request.items.map((item) => [item.item_id, {
      rma: item.rma || "",
      deliveredBom: item.delivered_bom || "",
      newSn: item.new_sn || "",
      dispatchAt: datetimeInput(item.dispatch_at),
      notes: item.notes || "",
      attended: Boolean(item.rma || request.spareSr),
      selected: false,
      condition: item.return_condition === "New" ? "New" : "Faulty",
    }])));
  }, [request?.revision]);

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

  const selected = useMemo(() => Object.entries(drafts).filter(([, value]) => value.selected).map(([key]) => key), [drafts]);

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
      const itemUpdates = currentRequest.items.flatMap((item) => {
        const draft = drafts[item.item_id];
        const update: Record<string, unknown> = { itemId: item.item_id };
        if (draft.rma !== (item.rma || "")) update.rma = draft.rma;
        if (draft.deliveredBom !== (item.delivered_bom || "")) update.deliveredBom = draft.deliveredBom;
        if (draft.newSn !== (item.new_sn || "")) update.newSn = draft.newSn;
        if (draft.dispatchAt !== datetimeInput(item.dispatch_at)) update.dispatchAt = draft.dispatchAt;
        if (draft.notes !== (item.notes || "")) update.notes = draft.notes;
        if (draft.attended && !item.attendance_confirmed_at) update.attended = true;
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

  async function exportReturn() {
    setWorking(true);
    try {
      const result = await exportSpareReturn(selected.map((itemId) => ({ itemId, condition: drafts[itemId].condition })));
      onChanged(await getSpareRequest(currentRequest.requestId));
      await onRefresh();
      onNotice(`Exported ${result.filename}. ${result.subject}${result.warnings.length ? ` · ${result.warnings.join(" ")}` : ""}`);
    } catch (error) { onError(error); } finally { setWorking(false); }
  }

  async function archive() {
    setWorking(true);
    try {
      const result = await archiveSpareItems({ itemIds: selected, reason: archiveReason, note, manualOverride });
      onChanged(null);
      await onRefresh();
      onNotice(`${result.archived.length} item(s) archived as ${result.reason} in Closed.xlsx.`);
    } catch (error) { onError(error); } finally { setWorking(false); }
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
    ...request.conflicts.map((conflict, index) => ({ conflict, index, itemId: undefined as string | undefined })),
    ...request.items.flatMap((item) => item.conflicts.map((conflict, index) => ({ conflict, index, itemId: item.item_id }))),
  ].filter(({ conflict }) => !conflict.resolved_at);

  return <>
    <aside className="detail-panel spare-request-detail" aria-label={`Spare Request ${request.requestId} detail`}>
      <header className="detail-header">
        <div><span>REQUEST {request.requestId}</span><h2>TT {request.ticketId} · {request.spareSr || "Spare SR pending"}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close Spare Request detail">×</button>
      </header>
      <nav className="detail-tabs" aria-label="Spare Request sections">
        <button type="button" className={tab === "items" ? "active" : ""} onClick={() => setTab("items")}>Items <small>{request.items.length}</small></button>
        <button type="button" className={tab === "emails" ? "active" : ""} onClick={() => setTab("emails")}>Emails <small>{request.email.count}</small></button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History <small>{request.history.length}</small></button>
      </nav>
      <div className="detail-scroll">
        {tab === "items" && <div className="tab-content spare-request-items">
          <div className="source-contract"><strong>Independent persistent request.</strong><span>Requested BOMs stay separate from delivered substitutions. One RMA belongs to one unit item and is immutable.</span></div>
          <div className="request-identity-form">
            <label className="form-field"><span>Original TT</span><input value={ticketId} disabled={!request.ttEditable} maxLength={8} onChange={(event) => setTicketId(event.target.value.replace(/\D/g, ""))} /></label>
            <label className="form-field"><span>Spare SR</span><input value={spareSr} placeholder="SR1234567" onChange={(event) => setSpareSr(event.target.value.toUpperCase())} /></label>
            <button type="button" className="secondary-button field-button" disabled={working} onClick={reexport}>Re-export request XLSX</button>
            <button type="button" className="secondary-button field-button" onClick={() => copySubject(request.export.subject)}>Copy request subject</button>
          </div>
          {allConflicts.length > 0 && <section className="conflict-panel"><header><strong>{allConflicts.length} unresolved conflict(s)</strong><span>Nothing was overwritten</span></header>{allConflicts.map(({ conflict, index, itemId }, position) => { const field = String(conflict.field || ""); const canAccept = ["spare_sr", "delivered_bom", "new_sn"].includes(field); return <article key={`${itemId}-${index}-${position}`}><div><strong>{field || "field"}</strong><span>{itemId || "request"}</span><p>Existing: {conflictValue(conflict, "existing")} · Incoming: {conflictValue(conflict, "incoming")}</p></div><div><button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "keep-existing")}>Keep existing</button>{canAccept && <button type="button" className="secondary-button" onClick={() => beginResolution(itemId, index, "accept-incoming")}>Accept incoming</button>}</div></article>; })}</section>}
          <div className="request-item-list">
            {request.items.map((item: SpareRequestItem) => {
              const draft = drafts[item.item_id];
              if (!draft) return null;
              return <article className="request-item-card" data-lifecycle={item.lifecycleColor} key={item.item_id}>
                <header><label className="item-selector"><input type="checkbox" checked={draft.selected} onChange={(event) => updateItem(item.item_id, { selected: event.target.checked })} /><strong>Unit {item.ordinal}</strong></label><span className={`status-chip lifecycle-${item.lifecycleColor}`}>{item.statusLabel}</span><span>{item.dispatchAgeDays === null ? "Timer not started" : `${item.dispatchAgeDays} day(s)`}</span></header>
                <div className="item-bom-pair"><div><span>Requested BOM</span><strong>{item.requested_bom}</strong></div><div><span>Delivered / substitute BOM</span><strong>{item.delivered_bom || "—"}</strong></div></div>
                <div className="form-grid four">
                  <label className="form-field"><span>RMA · immutable once set</span><input value={draft.rma} maxLength={11} placeholder="C1234567890" onChange={(event) => updateItem(item.item_id, { rma: event.target.value.toUpperCase() })} /></label>
                  <label className="form-field"><span>Delivered BOM</span><input value={draft.deliveredBom} onChange={(event) => updateItem(item.item_id, { deliveredBom: event.target.value })} /></label>
                  <label className="form-field"><span>New SN</span><input value={draft.newSn} onChange={(event) => updateItem(item.item_id, { newSn: event.target.value })} /></label>
                  <label className="form-field"><span>Manual dispatch time</span><input type="datetime-local" value={draft.dispatchAt} onChange={(event) => updateItem(item.item_id, { dispatchAt: event.target.value })} /></label>
                  <label className="check-field"><input type="checkbox" checked={draft.attended} onChange={(event) => updateItem(item.item_id, { attended: event.target.checked })} /><span>Manually attended</span></label>
                  <label className="form-field"><span>Return condition</span><select value={draft.condition} onChange={(event) => updateItem(item.item_id, { condition: event.target.value as "Faulty" | "New" })}><option>Faulty</option><option>New</option></select></label>
                  <label className="form-field wide"><span>Item notes</span><input value={draft.notes} onChange={(event) => updateItem(item.item_id, { notes: event.target.value })} /></label>
                </div>
                <footer><span>{item.rma || "RMA pending"} · {item.new_sn || "New SN pending"}</span>{item.warehouse_candidate_at && <strong className="green-text">Exact warehouse candidate found · user confirmation required</strong>}</footer>
              </article>;
            })}
          </div>
          <section className="archive-controls">
            <label className="form-field full"><span>Audit / cancellation / override note</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div><button type="button" className="primary-button" disabled={working} onClick={save}>{working ? "Working…" : "Save manual facts"}</button><button type="button" className="secondary-button" disabled={!selected.length || working} onClick={exportReturn}>Export return XLSX</button><select value={archiveReason} onChange={(event) => setArchiveReason(event.target.value as "returned" | "cancelled")}><option value="returned">Returned</option><option value="cancelled">Cancelled</option></select><label className="check-field"><input type="checkbox" checked={manualOverride} onChange={(event) => setManualOverride(event.target.checked)} /><span>Manual warehouse override</span></label><button type="button" className="danger-button" disabled={!selected.length || working} onClick={archive}>Confirm & archive selected</button></div>
          </section>
        </div>}
        {tab === "emails" && <div className="tab-content spare-email-list">{request.email.messages.length ? request.email.messages.map((message, index) => <article key={String(message.message_key || index)}><header><strong>{String(message.subject || "(no subject)")}</strong><span>{String(message.timestamp || "")}</span></header><small>{String(message.direction || "")} · {String(message.sender || "")}</small><pre>{String(message.latest_reply_body || message.body || "Body purged or unavailable.")}</pre></article>) : <div className="empty-panel">No spare-related email retained for this request.</div>}</div>}
        {tab === "history" && <div className="history-list">{request.history.map((event, index) => <article key={`${event.timestamp}-${index}`}><time>{event.timestamp}</time><strong>{event.action}</strong><pre>{JSON.stringify(event.summary, null, 2)}</pre></article>)}</div>}
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
  </>;
}
