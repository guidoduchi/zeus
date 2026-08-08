import { useEffect, useState } from "react";
import { getBomCatalog, saveBomCatalog } from "../api";
import type { BomCatalogEntry, BomCatalogPayload } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

function newId(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `bom-${suffix}`;
}

export function BomCatalogModal({ onClose, onSaved, onError }: Props) {
  const [value, setValue] = useState<BomCatalogPayload>({ schemaVersion: 2, boms: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const row = value.boms.find((candidate) => candidate.id === selected) || null;

  useEffect(() => {
    getBomCatalog().then((result) => {
      setValue(result);
      setSelected(result.boms[0]?.id || null);
    }).catch(onError).finally(() => setLoading(false));
  }, [onError]);

  function update(changes: Partial<BomCatalogEntry>) {
    if (!row) return;
    setValue((current) => ({ ...current, boms: current.boms.map((candidate) => candidate.id === row.id ? { ...candidate, ...changes } : candidate) }));
  }

  function add() {
    const next: BomCatalogEntry = { id: newId(), bom: "", description: "", part: null, model: null, device: null };
    setValue((current) => ({ ...current, boms: [...current.boms, next] }));
    setSelected(next.id);
  }

  function remove() {
    if (!row) return;
    setValue((current) => ({ ...current, boms: current.boms.filter((candidate) => candidate.id !== row.id) }));
    setSelected(null);
    setDeleteOpen(false);
  }

  async function save() {
    setSaving(true);
    try {
      setValue(await saveBomCatalog(value));
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  return <><Modal title="BOM catalog" subtitle="Reusable Spare Request BOM descriptions stay local. Add one BOM per catalog record; quantities are chosen during export." onClose={onClose} wide actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || saving} onClick={save}>{saving ? "Saving…" : "Save BOM catalog"}</button></>}>
    {loading ? <div className="detail-loading">Reading BOM catalog…</div> : <div className="manager-records bom-manager">
      <div className="manager-list"><button type="button" className="primary-button" onClick={add}>+ Add BOM</button>{value.boms.map((entry) => <button type="button" className={entry.id === selected ? "selected" : ""} onClick={() => setSelected(entry.id)} key={entry.id}><span>{entry.bom || "New BOM"}</span></button>)}</div>
      <div className="manager-form"><header><strong>{row?.bom || "BOM editor"}</strong>{row && <button type="button" className="text-button danger-text" onClick={() => setDeleteOpen(true)}>Delete</button>}</header>{row ? <div className="form-grid two">
        <label className="form-field"><span>BOM *</span><input value={row.bom} onChange={(event) => update({ bom: event.target.value })} /></label>
        <label className="form-field"><span>Part</span><input value={row.part || ""} onChange={(event) => update({ part: event.target.value })} /></label>
        <label className="form-field full"><span>Description *</span><input value={row.description} onChange={(event) => update({ description: event.target.value })} /></label>
        <label className="form-field"><span>Model</span><input value={row.model || ""} onChange={(event) => update({ model: event.target.value })} /></label>
        <label className="form-field"><span>Device</span><input value={row.device || ""} onChange={(event) => update({ device: event.target.value })} /></label>
      </div> : <div className="manager-empty"><strong>No BOM selected</strong><span>Add or choose a BOM to edit it.</span></div>}</div>
    </div>}
  </Modal>{deleteOpen && row && <ConfirmationDialog title={`Delete BOM ${row.bom || "record"}?`} message="The BOM will be removed from this unsaved catalog edit. Save the catalog afterward to commit the deletion." confirmLabel="Delete BOM" tone="danger" onCancel={() => setDeleteOpen(false)} onConfirm={remove} />}</>;
}
