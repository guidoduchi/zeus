import { useEffect, useMemo, useState } from "react";
import { ApiError, getSpareReferenceData, getSpareRequestPrefill } from "../api";
import type { SparePartSummary, SpareReferenceData } from "../types";
import { Modal } from "./Modal";

interface LineDraft {
  bom: string;
  amount: string;
  description: string;
  part: string;
  model: string;
  device: string;
  slot: string;
  faultySn: string;
  reportDate: string;
  deviceNumber?: number;
  partNumber?: number | null;
}

interface Props {
  initialTicketId?: string;
  initialPart?: SparePartSummary | null;
  onClose: () => void;
  onExport: (payload: Record<string, unknown>) => Promise<void>;
  onError: (error: unknown) => void;
}

const EMPTY_LINE: LineDraft = {
  bom: "", amount: "1", description: "", part: "", model: "", device: "",
  slot: "", faultySn: "", reportDate: "",
};

export function SpareRequestModal({ initialTicketId, initialPart, onClose, onExport, onError }: Props) {
  const inheritedTicket = Boolean(initialTicketId || initialPart);
  const [ticketId, setTicketId] = useState(initialTicketId || initialPart?.ticketId || "");
  const [source, setSource] = useState<"ticket" | "manual">(initialTicketId || initialPart ? "ticket" : "manual");
  const [ttLocked, setTtLocked] = useState(inheritedTicket);
  const [profile, setProfile] = useState({
    clientInitials: "", customerName: "", siteCode: initialPart?.site === "—" ? "" : initialPart?.site || "",
    siteName: "", siteAddress: "", cloud: initialPart?.cloud === "—" ? "" : initialPart?.cloud || "",
    requesterName: "", requesterEmail: "", requesterPhone: "",
    contactName: "", contactEmail: "", contactPhone: "",
  });
  const [lines, setLines] = useState<LineDraft[]>(initialPart ? [{
    bom: initialPart.bom === "—" ? "" : initialPart.bom,
    amount: "1",
    description: initialPart.part === "—" ? initialPart.bom : initialPart.part,
    part: initialPart.part === "—" ? "" : initialPart.part,
    model: initialPart.model === "—" ? "" : initialPart.model,
    device: initialPart.device === "—" ? "" : initialPart.device,
    slot: initialPart.slot === "—" ? "" : initialPart.slot,
    faultySn: initialPart.faultySn === "—" ? "" : initialPart.faultySn,
    reportDate: "",
    deviceNumber: initialPart.deviceNumber,
    partNumber: initialPart.partNumber,
  }] : [{ ...EMPTY_LINE }]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [references, setReferences] = useState<SpareReferenceData | null>(null);

  const canExport = useMemo(() => /^\d{8}$/.test(ticketId) && lines.some((line) => line.bom.trim()), [lines, ticketId]);

  useEffect(() => {
    if (!initialTicketId && !initialPart) return;
    void loadTicket(!initialPart);
  }, []);

  useEffect(() => {
    getSpareReferenceData().then(setReferences).catch(() => undefined);
  }, []);

  function presetValue(row: Record<string, unknown>, ...keys: string[]): string {
    const value = keys.map((key) => row[key]).find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
    return String(value || "");
  }

  function applyProfilePreset(kind: "customers" | "sites" | "requesters", id: string) {
    const row = references?.[kind].find((candidate) => String(candidate.id) === id);
    if (!row) return;
    if (kind === "customers") {
      setProfile((current) => ({
        ...current,
        clientInitials: presetValue(row, "clientInitials", "client_initials", "initials") || current.clientInitials,
        customerName: presetValue(row, "customerName", "customer_name", "name") || current.customerName,
      }));
    } else if (kind === "sites") {
      const contact = (row.contact || {}) as Record<string, unknown>;
      setProfile((current) => ({
        ...current,
        siteCode: presetValue(row, "siteCode", "site_code", "code", "name") || current.siteCode,
        siteName: presetValue(row, "siteName", "site_name", "name") || current.siteName,
        siteAddress: presetValue(row, "siteAddress", "site_address", "address") || current.siteAddress,
        cloud: presetValue(row, "cloud") || current.cloud,
        contactName: presetValue(contact, "name") || presetValue(row, "contactName", "contact_name") || current.contactName,
        contactEmail: presetValue(contact, "email") || presetValue(row, "contactEmail", "contact_email") || current.contactEmail,
        contactPhone: presetValue(contact, "phone") || presetValue(row, "contactPhone", "contact_phone") || current.contactPhone,
      }));
    } else {
      setProfile((current) => ({
        ...current,
        requesterName: presetValue(row, "name", "requesterName", "requester_name") || current.requesterName,
        requesterEmail: presetValue(row, "email") || current.requesterEmail,
        requesterPhone: presetValue(row, "phone") || current.requesterPhone,
      }));
    }
  }

  function applyBomPreset(index: number, id: string) {
    const row = references?.boms.find((candidate) => String(candidate.id) === id);
    if (!row) return;
    setLines((current) => current.map((line, position) => position !== index ? line : ({
      ...line,
      bom: presetValue(row, "bom", "code", "id") || line.bom,
      description: presetValue(row, "description", "part", "name") || line.description,
      part: presetValue(row, "part", "name") || line.part,
      model: presetValue(row, "model") || line.model,
    })));
  }

  async function loadTicket(replaceLines = true) {
    if (!/^\d{8}$/.test(ticketId)) {
      setWarning("TT must contain exactly eight digits.");
      return;
    }
    setLoading(true);
    try {
      const result = await getSpareRequestPrefill(ticketId);
      const incoming = result.profile as Record<string, unknown>;
      const contact = (incoming.contact || {}) as Record<string, unknown>;
      setProfile((current) => ({
        ...current,
        customerName: String(incoming.customerName || current.customerName || ""),
        siteCode: String(incoming.siteCode || current.siteCode || ""),
        siteName: String(incoming.siteName || current.siteName || ""),
        siteAddress: String(incoming.siteAddress || current.siteAddress || ""),
        cloud: String(incoming.cloud || current.cloud || ""),
        contactName: String(contact.name || current.contactName || ""),
        contactEmail: String(contact.email || current.contactEmail || ""),
        contactPhone: String(contact.phone || current.contactPhone || ""),
      }));
      if (replaceLines && result.lines.length) {
        setLines(result.lines.map((raw) => ({
          bom: String(raw.bom || ""), amount: String(raw.amount || 1),
          description: String(raw.description || raw.part || raw.bom || ""),
          part: String(raw.part || ""), model: String(raw.model || ""),
          device: String(raw.device || ""), slot: String(raw.slot || ""),
          faultySn: String(raw.faultySn || ""), reportDate: String(raw.reportDate || "").slice(0, 10),
          deviceNumber: Number(raw.deviceNumber || 0) || undefined,
          partNumber: Number(raw.partNumber || 0) || null,
        })));
      }
      setSource("ticket");
      setTtLocked(true);
      setWarning(result.warning);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && !inheritedTicket) {
        setSource("manual");
        setTtLocked(false);
        setWarning(`TT ${ticketId} is not in local Service Requests. You may continue as a manual request.`);
      } else if (error instanceof ApiError && error.status === 404) {
        setWarning(`TT ${ticketId} is no longer active. Close this form and create a manual request if that is intentional.`);
      } else {
        setWarning("Zeus could not verify this TT against local Service Requests.");
        onError(error);
      }
    } finally {
      setLoading(false);
    }
  }

  function updateProfile(key: keyof typeof profile, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  function updateLine(index: number, key: keyof LineDraft, value: string) {
    setLines((current) => current.map((line, position) => position === index ? { ...line, [key]: value } : line));
  }

  async function submit() {
    if (!canExport) return;
    setSaving(true);
    try {
      await onExport({
        source,
        ticketId,
        profile: {
          clientInitials: profile.clientInitials,
          customerName: profile.customerName,
          siteCode: profile.siteCode,
          siteName: profile.siteName,
          siteAddress: profile.siteAddress,
          cloud: profile.cloud,
          requester: { name: profile.requesterName, email: profile.requesterEmail, phone: profile.requesterPhone },
          contact: { name: profile.contactName, email: profile.contactEmail, phone: profile.contactPhone },
        },
        lines: lines.map((line) => ({ ...line, amount: Number(line.amount || 1) })),
      });
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Export Spare Request"
      subtitle="The Ecuador timestamp ID is allocated when the XLSX is written; quantity expands into individual unit items."
      onClose={onClose}
      wide
      actions={<>
        <span className="modal-action-note">{source === "ticket" ? "TT inherited from active SR" : "Manual TT · warning allowed"}</span>
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={!canExport || saving} onClick={submit}>{saving ? "Exporting…" : "Export XLSX & create request"}</button>
      </>}
    >
      <div className="spare-request-form">
        <section className="form-section">
          <div className="section-heading"><strong>Ticket and customer</strong><span>{source}</span></div>
          {references && (references.customers.length > 0 || references.sites.length > 0) && <div className="preset-row"><label className="form-field"><span>Customer preset</span><select defaultValue="" onChange={(event) => applyProfilePreset("customers", event.target.value)}><option value="">Choose…</option>{references.customers.map((row) => <option value={String(row.id)} key={String(row.id)}>{String(row.name || row.customerName || row.id)}</option>)}</select></label><label className="form-field"><span>Site preset</span><select defaultValue="" onChange={(event) => applyProfilePreset("sites", event.target.value)}><option value="">Choose…</option>{references.sites.map((row) => <option value={String(row.id)} key={String(row.id)}>{String(row.name || row.siteCode || row.id)}</option>)}</select></label></div>}
          <div className="form-grid three">
            <label className="form-field"><span>TT · 8 digits</span><input value={ticketId} disabled={ttLocked} maxLength={8} onChange={(event) => { setTicketId(event.target.value.replace(/\D/g, "")); setSource("manual"); }} /></label>
            <button type="button" className="secondary-button field-button" disabled={loading || !/^\d{8}$/.test(ticketId)} onClick={() => loadTicket(true)}>{loading ? "Loading…" : "Load active SR"}</button>
            <label className="form-field"><span>Client initials</span><input value={profile.clientInitials} maxLength={8} onChange={(event) => updateProfile("clientInitials", event.target.value.toUpperCase())} placeholder="Customer, not requester" /></label>
            <label className="form-field"><span>Customer name</span><input value={profile.customerName} onChange={(event) => updateProfile("customerName", event.target.value)} /></label>
            <label className="form-field"><span>Site code</span><input value={profile.siteCode} onChange={(event) => updateProfile("siteCode", event.target.value.toUpperCase())} /></label>
            <label className="form-field"><span>Cloud</span><input value={profile.cloud} onChange={(event) => updateProfile("cloud", event.target.value)} /></label>
            <label className="form-field full"><span>Site address</span><input value={profile.siteAddress} onChange={(event) => updateProfile("siteAddress", event.target.value)} /></label>
          </div>
          {warning && <p className="inline-warning">{warning}</p>}
        </section>
        <section className="form-section">
          <div className="section-heading"><strong>Requester and customer contact</strong><span>stored locally</span></div>
          {references?.requesters.length ? <div className="preset-row"><label className="form-field"><span>Requester preset</span><select defaultValue="" onChange={(event) => applyProfilePreset("requesters", event.target.value)}><option value="">Choose…</option>{references.requesters.map((row) => <option value={String(row.id)} key={String(row.id)}>{String(row.name || row.id)}</option>)}</select></label></div> : null}
          <div className="form-grid three">
            {(["requesterName", "requesterEmail", "requesterPhone", "contactName", "contactEmail", "contactPhone"] as const).map((key) => (
              <label className="form-field" key={key}><span>{({ requesterName: "Requester name", requesterEmail: "Requester email", requesterPhone: "Requester phone", contactName: "Customer contact", contactEmail: "Contact email", contactPhone: "Contact phone" })[key]}</span><input value={profile[key]} onChange={(event) => updateProfile(key, event.target.value)} /></label>
            ))}
          </div>
        </section>
        <section className="form-section">
          <div className="section-heading"><strong>Requested BOM groups</strong><span>{lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)} unit(s)</span></div>
          <div className="request-line-list">
            {lines.map((line, index) => (
              <article className="request-line" key={index}>
                <header><strong>Group {index + 1}</strong>{lines.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>Remove</button>}</header>
                <div className="form-grid four">
                  {references?.boms.length ? <label className="form-field"><span>BOM catalog preset</span><select defaultValue="" onChange={(event) => applyBomPreset(index, event.target.value)}><option value="">Choose…</option>{references.boms.map((row) => <option value={String(row.id)} key={String(row.id)}>{String(row.bom || row.code || row.name || row.id)}</option>)}</select></label> : null}
                  <label className="form-field"><span>BOM</span><input value={line.bom} onChange={(event) => updateLine(index, "bom", event.target.value)} /></label>
                  <label className="form-field"><span>Quantity</span><input type="number" min="1" max="1000" value={line.amount} onChange={(event) => updateLine(index, "amount", event.target.value)} /></label>
                  <label className="form-field wide"><span>Description / part</span><input value={line.description} onChange={(event) => updateLine(index, "description", event.target.value)} /></label>
                  {(["model", "device", "slot", "faultySn"] as const).map((key) => <label className="form-field" key={key}><span>{key === "faultySn" ? "Faulty SN (optional)" : key[0].toUpperCase() + key.slice(1)}</span><input value={line[key]} onChange={(event) => updateLine(index, key, event.target.value)} /></label>)}
                  <label className="form-field"><span>Original TT report date</span><input type="date" value={line.reportDate} onChange={(event) => updateLine(index, "reportDate", event.target.value)} /></label>
                </div>
              </article>
            ))}
          </div>
          <button type="button" className="secondary-button" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>+ Add BOM group</button>
        </section>
      </div>
    </Modal>
  );
}
