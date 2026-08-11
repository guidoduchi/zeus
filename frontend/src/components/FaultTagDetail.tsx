import { useState } from "react";
import { deleteFaultTag, reexportFaultTag } from "../api";
import type { FaultTagDetail as FaultTagDetailType } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";

interface Props {
  faultTag: FaultTagDetailType | null;
  loading: boolean;
  onClose: () => void;
  onChanged: (value: FaultTagDetailType | null) => void;
  onRefresh: () => Promise<void>;
  onError: (error: unknown) => void;
  onNotice: (message: string) => void;
}

export function FaultTagDetail({ faultTag, loading, onClose, onChanged, onRefresh, onError, onNotice }: Props) {
  const [working, setWorking] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (loading || !faultTag) {
    return <aside className="detail-panel"><div className="detail-loading">Loading Fault Tag…</div></aside>;
  }
  const currentFaultTag = faultTag;

  async function reexport() {
    setWorking(true);
    try {
      const result = await reexportFaultTag(currentFaultTag.faultTagId);
      onChanged(result.faultTag);
      onNotice(`${currentFaultTag.faultTagId} re-exported as ${result.filename}.`);
      await onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    setWorking(true);
    try {
      const result = await deleteFaultTag(currentFaultTag.faultTagId);
      setDeleteOpen(false);
      onChanged(null);
      onNotice(`${result.deleted} deleted. ${result.itemsReleased.length} item(s) are available for a new Fault Tag; lifecycle stages were unchanged.`);
      await onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setWorking(false);
    }
  }

  return (
    <aside className="detail-panel fault-tag-detail">
      <header className="detail-header">
        <div><span>Fault Tag batch</span><h2>{faultTag.faultTagId}</h2></div>
        <button type="button" className="icon-button" aria-label="Close Fault Tag detail" onClick={onClose}>×</button>
      </header>
      <div className="detail-tabs"><span className="detail-tab active">{faultTag.status.replaceAll("_", " ")}</span></div>
      <div className="detail-scroll">
        <section className="source-contract">
          <strong>{faultTag.locked ? "Membership locked by detected sent email" : "Membership fixed for this batch"}</strong>
          <span>Re-export keeps this ID and membership. Deleting releases the items without changing their Active Request lifecycle.</span>
        </section>
        <section className="detail-section">
          <header><strong>Return site</strong></header>
          <dl className="fact-list"><div><dt>Site</dt><dd>{faultTag.returnSite.code}</dd></div><div><dt>Cloud</dt><dd>{faultTag.returnSite.cloud}</dd></div><div><dt>Address</dt><dd>{faultTag.returnSite.address}</dd></div></dl>
        </section>
        <section className="detail-section">
          <header><strong>Members</strong><span>{faultTag.members.length}</span></header>
          <div className="fault-tag-members">{faultTag.members.map((member) => <article className={member.condition === "Faulty" ? "faulty" : "new"} key={member.itemId}><strong>{member.rma}</strong><span>TT {member.ticketId} · {member.spareSr} · {member.condition}</span><small>{member.warehouseEvidenceAt ? "Warehouse evidence received" : "Waiting for warehouse evidence"}{member.userConfirmedAt ? " · User confirmed" : ""}</small></article>)}</div>
        </section>
        <div className="detail-actions"><button type="button" className="secondary-button" disabled={working} onClick={() => void reexport()}>Re-export same ID</button><button type="button" className="danger-button" disabled={working} onClick={() => setDeleteOpen(true)}>Delete Fault Tag</button></div>
      </div>
      {deleteOpen && <ConfirmationDialog title={`Delete ${faultTag.faultTagId}?`} message="The exported XLSX stays on disk and linked email remains on the Active Request, but this Fault Tag record is deleted and its items become available for a new Fault Tag. Active Request lifecycle stages do not change." confirmLabel="Delete Fault Tag" tone="danger" onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()} />}
    </aside>
  );
}
