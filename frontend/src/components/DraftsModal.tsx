import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeActiveRequestDraft,
  clearActiveRequestDraft,
  listActiveRequestDrafts,
} from "../activeRequestDrafts";
import { getSpareRequest, getTicket, saveTicketDraftBatch } from "../api";
import {
  clearTicketDraft,
  listTicketDrafts,
  setDraftUndo,
  type TicketDraftKind,
  type TicketDraftRecord,
} from "../drafts";
import { analyzeTicketDraft, displayDraftField, WORK_FIELDS, type DraftAnalysis } from "../ticketDraftModel";
import type { SpareRequestDetail, TicketDetail } from "../types";
import { Modal } from "./Modal";

type Action = "save" | "discard";

interface DraftGroup {
  ticketId: string;
  ticket: TicketDetail | null;
  records: TicketDraftRecord[];
  analyses: DraftAnalysis[];
  fields: string[];
  conflicts: string[];
  updatedAt: string | null;
  unavailable: string | null;
}

interface ActiveDraftGroup {
  requestId: string;
  request: SpareRequestDetail | null;
  fields: string[];
  conflicts: string[];
  updatedAt: string | null;
  unavailable: string | null;
}

interface Props {
  onClose: () => void;
  onReview: (ticketId: string, kind: TicketDraftKind) => void;
  onReviewActiveRequest: (requestId: string) => void;
  onSaved: (tickets: Record<string, TicketDetail>) => void;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
}

function newestTimestamp(records: TicketDraftRecord[]): string | null {
  const values = records
    .map((record) => record.draft.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return values.at(-1) || null;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Earlier session";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Earlier session" : parsed.toLocaleString();
}

function rawDraftFields(records: TicketDraftRecord[]): string[] {
  return [...new Set(records.flatMap((record) => {
    if (record.kind === "spares") return ["Spare Parts"];
    const value = record.draft.value as Record<string, unknown>;
    const base = record.draft.baseValue as Record<string, unknown>;
    return WORK_FIELDS
      .filter((field) => JSON.stringify(value?.[field]) !== JSON.stringify(base?.[field]))
      .map(displayDraftField);
  }))];
}

function actionCopy(action: Action, count: number): { title: string; body: string; confirm: string } {
  if (action === "save") return {
    title: `Save ${count} selected SR${count === 1 ? "" : "s"} to Zeus?`,
    body: "Zeus will validate every current revision and commit all selected records in one database transaction.",
    confirm: "Confirm save to Zeus",
  };
  return {
    title: `Discard ${count} selected draft${count === 1 ? "" : "s"}?`,
    body: "Only the selected browser drafts will be removed. Existing Zeus database values will remain unchanged.",
    confirm: "Confirm discard",
  };
}

export function DraftsModal({ onClose, onReview, onReviewActiveRequest, onSaved, onError, onNotice }: Props) {
  const [groups, setGroups] = useState<DraftGroup[]>([]);
  const [activeGroups, setActiveGroups] = useState<ActiveDraftGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const initializedSelection = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const records = listTicketDrafts();
      const activeRecords = listActiveRequestDrafts();
      const ticketIds = [...new Set(records.map((record) => record.ticketId))];
      const [tickets, activeRequests] = await Promise.all([
        Promise.allSettled(ticketIds.map((ticketId) => getTicket(ticketId))),
        Promise.allSettled(activeRecords.map((record) => getSpareRequest(record.requestId))),
      ]);
      const ticketMap = new Map(ticketIds.map((ticketId, index) => [ticketId, tickets[index]]));
      const next: DraftGroup[] = [];
      for (const ticketId of ticketIds) {
        const ticketRecords = records.filter((record) => record.ticketId === ticketId);
        const outcome = ticketMap.get(ticketId);
        if (!outcome || outcome.status === "rejected" || outcome.value.readOnly) {
          next.push({
            ticketId,
            ticket: outcome?.status === "fulfilled" ? outcome.value : null,
            records: ticketRecords,
            analyses: [],
            fields: rawDraftFields(ticketRecords),
            conflicts: [],
            updatedAt: newestTimestamp(ticketRecords),
            unavailable: outcome?.status === "fulfilled"
              ? "SR is finalized and read-only · discard only"
              : "SR is unavailable · discard only",
          });
          continue;
        }
        const ticket = outcome.value;
        const validRecords: TicketDraftRecord[] = [];
        const analyses: DraftAnalysis[] = [];
        for (const record of ticketRecords) {
          const analysis = analyzeTicketDraft(ticket, record.kind, record.draft);
          if (!analysis || !Object.keys(analysis.changes).length) {
            clearTicketDraft(record.ticketId, record.kind);
            continue;
          }
          validRecords.push(record);
          analyses.push(analysis);
        }
        if (!validRecords.length) continue;
        next.push({
          ticketId,
          ticket,
          records: validRecords,
          analyses,
          fields: [...new Set(analyses.flatMap((analysis) => analysis.changedFields.map(displayDraftField)))],
          conflicts: [...new Set(analyses.flatMap((analysis) => analysis.conflictFields.map(displayDraftField)))],
          updatedAt: newestTimestamp(validRecords),
          unavailable: null,
        });
      }
      setGroups(next);
      const nextActive: ActiveDraftGroup[] = [];
      for (const [index, record] of activeRecords.entries()) {
        const outcome = activeRequests[index];
        if (!outcome || outcome.status === "rejected") {
          nextActive.push({
            requestId: record.requestId,
            request: null,
            fields: ["Manual facts"],
            conflicts: [],
            updatedAt: record.draft.updatedAt || null,
            unavailable: "Active Request is unavailable · draft retained",
          });
          continue;
        }
        const analysis = analyzeActiveRequestDraft(outcome.value, record.draft);
        if (!analysis || !analysis.fields.length) {
          clearActiveRequestDraft(record.requestId);
          continue;
        }
        nextActive.push({
          requestId: record.requestId,
          request: outcome.value,
          fields: analysis.fields,
          conflicts: analysis.conflictFields,
          updatedAt: record.draft.updatedAt || null,
          unavailable: null,
        });
      }
      setActiveGroups(nextActive);
      setSelected((current) => {
        if (!initializedSelection.current) {
          initializedSelection.current = true;
          return new Set(next.map((group) => group.ticketId));
        }
        return new Set(next.filter((group) => current.has(group.ticketId)).map((group) => group.ticketId));
      });
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedGroups = useMemo(
    () => groups.filter((group) => selected.has(group.ticketId)),
    [groups, selected],
  );
  const selectedHasConflict = selectedGroups.some((group) => group.conflicts.length > 0);
  const selectedHasUnavailable = selectedGroups.some((group) => Boolean(group.unavailable));
  const copy = pendingAction ? actionCopy(pendingAction, selectedGroups.length) : null;

  function toggle(ticketId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ticketId)) next.delete(ticketId);
      else next.add(ticketId);
      return next;
    });
  }

  async function currentAnalyses(group: DraftGroup): Promise<{ ticket: TicketDetail; analyses: DraftAnalysis[] }> {
    if (group.unavailable) throw new Error(`SR ${group.ticketId} is unavailable; deselect it or discard its draft.`);
    const ticket = await getTicket(group.ticketId);
    const analyses = group.records.flatMap((record) => {
      const analysis = analyzeTicketDraft(ticket, record.kind, record.draft);
      return analysis ? [analysis] : [];
    });
    return { ticket, analyses };
  }

  async function execute() {
    if (!pendingAction || !selectedGroups.length) return;
    setWorking(true);
    try {
      if (pendingAction === "discard") {
        setDraftUndo({
          action: "discard",
          records: selectedGroups.flatMap((group) => group.records),
          inverseEdits: [],
          ticketCount: selectedGroups.length,
        });
        for (const group of selectedGroups) {
          for (const record of group.records) clearTicketDraft(record.ticketId, record.kind);
        }
        onNotice(`Discarded protected drafts for ${selectedGroups.length} SR(s).`);
      } else {
        const refreshed = await Promise.all(selectedGroups.map(currentAnalyses));
        const conflicts = refreshed.flatMap((item) => item.analyses.flatMap((analysis) => analysis.conflictFields));
        if (conflicts.length) {
          throw new Error("One or more selected SRs changed again. Review those drafts before saving; no SR was updated.");
        }
        const edits = refreshed.map((item) => ({
          ticketId: item.ticket.ticketId,
          revision: item.ticket.revision,
          changes: Object.assign({}, ...item.analyses.map((analysis) => analysis.changes)),
        }));
        const result = await saveTicketDraftBatch(edits);
        setDraftUndo({
          action: "save",
          records: selectedGroups.flatMap((group) => group.records),
          inverseEdits: refreshed.map((item) => ({
            ticketId: item.ticket.ticketId,
            revision: result.tickets[item.ticket.ticketId].revision,
            changes: Object.assign({}, ...item.analyses.map((analysis) => (
              analysis.kind === "spares"
                ? { "Spare Parts": item.ticket.spareParts }
                : Object.fromEntries(analysis.changedFields.map((field) => [
                  field,
                  item.ticket.localFields[field] ?? null,
                ]))
            ))),
          })),
          ticketCount: selectedGroups.length,
        });
        for (const group of selectedGroups) {
          for (const record of group.records) clearTicketDraft(record.ticketId, record.kind);
        }
        onSaved(result.tickets);
        onNotice(`Saved ${selectedGroups.length} selected SR(s) to the Zeus database in one transaction.`);
      }
      setPendingAction(null);
      await refresh();
    } catch (error) {
      setPendingAction(null);
      onError(error);
      await refresh();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      title="Protected drafts"
      subtitle="Review browser-protected Service Request and Active Request changes without losing track of their record."
      onClose={onClose}
      wide
      actions={<>
        <span>{selected.size} of {groups.length} SR(s) selected · {activeGroups.length} Active Request draft(s)</span>
        <button type="button" className="secondary-button" disabled={working} onClick={onClose}>Close</button>
        <button type="button" className="text-button danger-text" disabled={!selectedGroups.length || working} onClick={() => setPendingAction("discard")}>Discard selected</button>
        <button type="button" className="primary-button" disabled={!selectedGroups.length || selectedHasConflict || selectedHasUnavailable || working} title={selectedHasUnavailable ? "Deselect or discard unavailable SR drafts" : selectedHasConflict ? "Review conflicting drafts before saving" : ""} onClick={() => setPendingAction("save")}>Save Selected</button>
      </>}
    >
      {pendingAction && copy && (
        <section className={`draft-confirmation draft-confirmation-${pendingAction}`} role="alertdialog" aria-label={copy.title}>
          <strong>{copy.title}</strong>
          <p>{copy.body}</p>
          <ul>{selectedGroups.map((group) => <li key={group.ticketId}><span>SR {group.ticketId}</span><small>{group.fields.join(", ")}</small></li>)}</ul>
          <div>
            <button type="button" className="secondary-button" disabled={working} onClick={() => setPendingAction(null)}>Go back</button>
            <button type="button" className={pendingAction === "discard" ? "danger-button" : "primary-button"} disabled={working} onClick={() => void execute()}>{working ? "Working…" : copy.confirm}</button>
          </div>
        </section>
      )}
      <div className="source-contract">
        <strong>Drafts are local safety copies, not database saves.</strong>
        <span>Service Request drafts can be saved here in one all-or-nothing batch. Review an Active Request draft to validate and save its lifecycle facts from that request; its last field edit can be undone there.</span>
      </div>
      {loading ? <div className="detail-loading">Checking protected drafts…</div> : groups.length || activeGroups.length ? <>
        {!!groups.length && <div className="draft-manager-list">
          <header>
            <label><input type="checkbox" checked={selected.size === groups.length} onChange={(event) => setSelected(event.target.checked ? new Set(groups.map((group) => group.ticketId)) : new Set())} /> <span>Select all</span></label>
            <span>Pending fields</span>
            <span>Status</span>
            <span>Last protected</span>
          </header>
          {groups.map((group) => (
            <article className={group.conflicts.length ? "has-conflict" : ""} key={group.ticketId}>
              <label>
                <input type="checkbox" checked={selected.has(group.ticketId)} onChange={() => toggle(group.ticketId)} />
                <span><strong>SR {group.ticketId}</strong><small>{group.ticket?.summary || "Record unavailable"}</small></span>
              </label>
              <span>{group.fields.join(", ")}</span>
              <span>{group.unavailable ? <em>{group.unavailable}</em> : group.conflicts.length ? <em>Review required · {group.conflicts.join(", ")}</em> : "Ready to save"}</span>
              <span>{formatTimestamp(group.updatedAt)}<button type="button" className="text-button" disabled={Boolean(group.unavailable)} onClick={() => onReview(group.ticketId, group.records[0].kind)}>Review</button></span>
            </article>
          ))}
        </div>}
        {!!activeGroups.length && <div className="draft-manager-list active-request-draft-list">
          <header>
            <span>Active Request</span>
            <span>Pending fields</span>
            <span>Status</span>
            <span>Last protected</span>
          </header>
          {activeGroups.map((group) => (
            <article className={group.conflicts.length ? "has-conflict" : ""} key={group.requestId}>
              <label><span><strong>Request {group.requestId}</strong><small>{group.request ? `TT ${group.request.ticketId} · ${group.request.spareSr || "Spare SR pending"}` : "Record unavailable"}</small></span></label>
              <span>{group.fields.join(", ")}</span>
              <span>{group.unavailable ? <em>{group.unavailable}</em> : group.conflicts.length ? <em>Review required · {group.conflicts.join(", ")}</em> : "Ready for request-level save"}</span>
              <span>{formatTimestamp(group.updatedAt)}<button type="button" className="text-button" disabled={Boolean(group.unavailable)} onClick={() => onReviewActiveRequest(group.requestId)}>Review</button></span>
            </article>
          ))}
        </div>}
      </> : <div className="manager-empty"><strong>No protected drafts</strong><span>Every local editor is synchronized with Zeus.</span></div>}
    </Modal>
  );
}
