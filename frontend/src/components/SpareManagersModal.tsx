import { useEffect, useState } from "react";
import { getSpareReferenceData, saveSpareReferenceData } from "../api";
import type { SpareReferenceData } from "../types";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

const EMPTY: SpareReferenceData = { schemaVersion: 1, customers: [], sites: [], requesters: [], boms: [] };

export function SpareManagersModal({ onClose, onSaved, onError }: Props) {
  const [value, setValue] = useState<SpareReferenceData>(EMPTY);
  const [active, setActive] = useState<"customers" | "sites" | "requesters" | "boms">("customers");
  const [draft, setDraft] = useState("[]");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSpareReferenceData().then((result) => {
      setValue(result);
      setDraft(JSON.stringify(result.customers, null, 2));
    }).catch(onError).finally(() => setLoading(false));
  }, []);

  function choose(next: typeof active) {
    try {
      const parsed = JSON.parse(draft);
      if (!Array.isArray(parsed)) throw new Error("Manager rows must be a JSON array.");
      const updated = { ...value, [active]: parsed };
      setValue(updated);
      setActive(next);
      setDraft(JSON.stringify(updated[next], null, 2));
    } catch (error) {
      onError(error);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const parsed = JSON.parse(draft);
      if (!Array.isArray(parsed)) throw new Error("Manager rows must be a JSON array.");
      await saveSpareReferenceData({ ...value, [active]: parsed });
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Spare Request managers"
      subtitle="Customer, site, requester, and BOM presets stay on this workstation and ship empty. Every row requires a unique id."
      onClose={onClose}
      wide
      actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || saving} onClick={save}>{saving ? "Saving…" : "Save local managers"}</button></>}
    >
      <div className="manager-layout">
        <nav aria-label="Manager collection">
          {(["customers", "sites", "requesters", "boms"] as const).map((key) => <button type="button" className={active === key ? "active" : ""} onClick={() => choose(key)} key={key}>{key === "boms" ? "BOM catalog" : key[0].toUpperCase() + key.slice(1)} <small>{value[key].length}</small></button>)}
        </nav>
        <label className="form-field full manager-editor">
          <span>{active} · JSON rows</span>
          <textarea spellCheck={false} value={draft} disabled={loading} onChange={(event) => setDraft(event.target.value)} />
          <small>Example: {`[{ "id": "primary", "name": "…" }]`}. Additional fields are preserved for future prefills.</small>
        </label>
      </div>
    </Modal>
  );
}
