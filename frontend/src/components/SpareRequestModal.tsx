import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  getSpareReferenceData,
  getSpareRequestPrefill,
  importCustomerFromTicket,
} from "../api";
import type {
  RequesterProfile,
  SparePartSummary,
  SpareReferenceData,
} from "../types";
import { requestedQuantity } from "../ticketDraftModel";
import { AutocompleteField } from "./AutocompleteField";
import { Modal } from "./Modal";
import { ConfirmationDialog } from "./ConfirmationDialog";

interface LineDraft {
  bom: string;
  amount: string;
  description: string;
  part: string;
  model: string;
  device: string;
  slot: string;
  faultySn: string;
  notes: string;
  deviceNumber?: number;
  partNumber?: number | null;
}

interface Props {
  initialTicketId?: string;
  initialPart?: SparePartSummary | null;
  initialAction?: "export" | "manual";
  configurationRevision?: number;
  suspended?: boolean;
  onClose: () => void;
  onExport: (payload: Record<string, unknown>) => Promise<void>;
  onRegisterManual?: (payload: Record<string, unknown>) => Promise<void>;
  onExportSetupRequired: (missing: string[]) => void;
  onError: (error: unknown) => void;
}

const EMPTY_LINE: LineDraft = {
  bom: "", amount: "1", description: "", part: "", model: "", device: "",
  slot: "", faultySn: "", notes: "",
};

function normalized(value: unknown): string {
  return String(value || "").trim().toLocaleLowerCase();
}

export function SpareRequestModal({ initialTicketId, initialPart, initialAction = "export", configurationRevision = 0, suspended = false, onClose, onExport, onRegisterManual, onExportSetupRequired, onError }: Props) {
  const inheritedTicket = Boolean(initialTicketId || initialPart);
  const [ticketId, setTicketId] = useState(initialTicketId || initialPart?.ticketId || "");
  const [source, setSource] = useState<"ticket" | "manual">(inheritedTicket ? "ticket" : "manual");
  const [ttLocked, setTtLocked] = useState(inheritedTicket);
  const [reportDate, setReportDate] = useState("");
  const [profile, setProfile] = useState({
    customerName: "", customerOrganization: "",
    siteCode: initialPart?.site === "—" ? "" : initialPart?.site || "",
    siteName: "", siteAddress: "", cloud: initialPart?.cloud === "—" ? "" : initialPart?.cloud || "",
    requesterName: "", requesterEmail: "", requesterPhone: "",
    contactEmail: "", contactPhone: "",
  });
  const [lines, setLines] = useState<LineDraft[]>(initialPart ? [{
    bom: initialPart.bom === "—" ? "" : initialPart.bom,
    amount: String(requestedQuantity(initialPart.slot === "—" ? "" : initialPart.slot)),
    description: initialPart.part === "—" ? initialPart.bom : initialPart.part,
    part: initialPart.part === "—" ? "" : initialPart.part,
    model: initialPart.model === "—" ? "" : initialPart.model,
    device: initialPart.device === "—" ? "" : initialPart.device,
    slot: initialPart.slot === "—" ? "" : initialPart.slot,
    faultySn: initialPart.faultySn === "—" ? "" : initialPart.faultySn,
    notes: "",
    deviceNumber: initialPart.deviceNumber,
    partNumber: initialPart.partNumber,
  }] : [{ ...EMPTY_LINE }]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingAction, setSavingAction] = useState<"export" | "manual" | null>(null);
  const [importing, setImporting] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [references, setReferences] = useState<SpareReferenceData | null>(null);
  const [globalSaveConfirmation, setGlobalSaveConfirmation] = useState(false);

  const requestReady = Boolean(references?.exportSetup.requestReady);
  const canAttemptExport = useMemo(() => (
    Boolean(references)
    && /^\d{8}$/.test(ticketId)
    && Boolean(profile.customerName.trim() && profile.customerOrganization.trim())
    && Boolean(profile.contactEmail.trim() && profile.contactPhone.trim())
    && Boolean(profile.siteCode.trim() && profile.siteAddress.trim() && profile.cloud.trim())
    && Boolean(profile.requesterName.trim())
    && Boolean(reportDate)
    && lines.length > 0
    && lines.every((line) => line.bom.trim() && line.description.trim() && Number(line.amount) >= 1)
  ), [lines, profile, references, reportDate, ticketId]);

  const customerOptions = useMemo(() => references?.customers.map((row) => ({
    key: row.id,
    value: row.name,
    detail: references.organizations.find((organization) => organization.id === row.organizationId)?.name || "Customer contact",
  })) || [], [references]);
  const organizationOptions = useMemo(() => references?.organizations.map((row) => ({
    key: row.id,
    value: row.name,
  })) || [], [references]);
  const siteOptions = useMemo(() => references?.sites.map((row) => ({
    key: row.id,
    value: row.code,
    detail: [row.name, row.address].filter(Boolean).join(" · "),
    searchText: row.name,
  })) || [], [references]);
  const requesterOptions = useMemo(() => references?.requesters.map((row) => ({
    key: row.id,
    value: row.name,
    detail: [row.email, row.phone].filter(Boolean).join(" · "),
  })) || [], [references]);
  const bomOptions = useMemo(() => references?.boms.map((row) => ({
    key: row.id,
    value: row.bom,
    detail: row.description,
    searchText: [row.part, row.model, row.device].filter(Boolean).join(" "),
  })) || [], [references]);

  useEffect(() => {
    getSpareReferenceData().then((result) => {
      setReferences(result);
      const preferred = result.requesters.find((row) => row.currentUser)
        || result.requesters.find((row) => row.pinned)
        || result.requesters[0];
      if (preferred) applyRequester(preferred, false);
    }).catch(onError);
  }, [configurationRevision, onError]);

  useEffect(() => {
    if (!inheritedTicket) return;
    void loadTicket(!initialPart);
  }, []);

  function updateProfile(key: keyof typeof profile, value: string) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  function applyRequester(row: RequesterProfile, overwrite = true) {
    setProfile((current) => ({
      ...current,
      requesterName: overwrite ? row.name || current.requesterName : current.requesterName || row.name,
      requesterEmail: overwrite ? row.email || current.requesterEmail : current.requesterEmail || row.email,
      requesterPhone: overwrite ? row.phone || current.requesterPhone : current.requesterPhone || row.phone,
    }));
  }

  function chooseCustomer(value: string) {
    const customer = references?.customers.find((row) => normalized(row.name) === normalized(value));
    if (!customer) {
      updateProfile("customerName", value);
      return;
    }
    const organization = references?.organizations.find((row) => row.id === customer.organizationId);
    setProfile((current) => ({
      ...current,
      customerName: customer.name,
      customerOrganization: organization?.name || current.customerOrganization,
      contactEmail: customer.email || "",
      contactPhone: customer.phone || "",
    }));
  }

  function chooseCustomerById(id: string) {
    const customer = references?.customers.find((row) => row.id === id);
    if (!customer) return;
    const organization = references?.organizations.find((row) => row.id === customer.organizationId);
    setProfile((current) => ({
      ...current,
      customerName: customer.name,
      customerOrganization: organization?.name || current.customerOrganization,
      contactEmail: customer.email || "",
      contactPhone: customer.phone || "",
    }));
  }

  function chooseSite(value: string) {
    const site = references?.sites.find((row) => (
      normalized(row.code) === normalized(value) || normalized(row.name) === normalized(value)
    ));
    if (!site) {
      updateProfile("siteCode", value.toUpperCase());
      return;
    }
    setProfile((current) => ({
      ...current,
      siteCode: site.code,
      siteName: site.name || "",
      siteAddress: site.address,
      cloud: site.cloud || current.cloud,
    }));
  }

  function chooseRequester(value: string) {
    const requester = references?.requesters.find((row) => normalized(row.name) === normalized(value));
    if (requester) applyRequester(requester);
    else updateProfile("requesterName", value);
  }

  function updateLine(index: number, key: keyof LineDraft, value: string) {
    setLines((current) => current.map((line, position) => {
      if (position !== index) return line;
      if (key === "slot") return { ...line, slot: value, amount: String(requestedQuantity(value)) };
      return { ...line, [key]: value };
    }));
  }

  function chooseBom(index: number, value: string) {
    const bom = references?.boms.find((row) => normalized(row.bom) === normalized(value));
    if (!bom) {
      updateLine(index, "bom", value);
      return;
    }
    setLines((current) => current.map((line, position) => position !== index ? line : ({
      ...line,
      bom: bom.bom,
      description: bom.description || line.description,
      part: bom.part || line.part,
      model: bom.model || line.model,
      device: bom.device || line.device,
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
        customerOrganization: String(incoming.customerOrganization || current.customerOrganization || ""),
        customerName: String(incoming.customerName || contact.name || current.customerName || ""),
        siteCode: String(incoming.siteCode || current.siteCode || ""),
        siteName: String(incoming.siteName || current.siteName || ""),
        siteAddress: String(incoming.siteAddress || current.siteAddress || ""),
        cloud: String(incoming.cloud || current.cloud || ""),
        contactEmail: String(contact.email || current.contactEmail || ""),
        contactPhone: String(contact.phone || current.contactPhone || ""),
      }));
      setReportDate(String(result.reportDate || "").slice(0, 10));
      if (replaceLines && result.lines.length) {
        setLines(result.lines.map((raw) => ({
          bom: String(raw.bom || ""), amount: String(raw.amount || 1),
          description: String(raw.description || raw.part || raw.bom || ""),
          part: String(raw.part || ""), model: String(raw.model || ""),
          device: String(raw.device || ""), slot: String(raw.slot || ""),
          faultySn: String(raw.faultySn || ""),
          notes: String(raw.notes || ""),
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

  async function importCustomer() {
    setImporting(true);
    try {
      await importCustomerFromTicket(ticketId, {
        customerOrganization: profile.customerOrganization,
        customerName: profile.customerName,
        contact: {
          name: profile.customerName,
          email: profile.contactEmail,
          phone: profile.contactPhone,
        },
      });
      setReferences(await getSpareReferenceData());
      setWarning(null);
      setGlobalSaveConfirmation(true);
    } catch (error) {
      onError(error);
    } finally {
      setImporting(false);
    }
  }

  function requestPayload(): Record<string, unknown> {
    return {
      source,
      ticketId,
      reportDate,
      profile: {
        customerOrganization: profile.customerOrganization,
        customerName: profile.customerName,
        siteCode: profile.siteCode,
        siteName: profile.siteName,
        siteAddress: profile.siteAddress,
        cloud: profile.cloud,
        requester: { name: profile.requesterName, email: profile.requesterEmail, phone: profile.requesterPhone },
        contact: { name: profile.customerName, email: profile.contactEmail, phone: profile.contactPhone },
      },
      lines: lines.map((line) => ({
        ...line,
        amount: Number(line.amount || 1),
        faultySns: line.faultySn.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      })),
    };
  }

  async function submit(action: "export" | "manual") {
    if (!references || saving) return;
    if (action === "export" && !requestReady) {
      onExportSetupRequired(references?.exportSetup.requestMissing.map((item) => item.label) || []);
      return;
    }
    if (!canAttemptExport || (action === "manual" && !onRegisterManual)) return;
    setSaving(true);
    setSavingAction(action);
    try {
      const payload = requestPayload();
      if (action === "manual") await onRegisterManual!(payload);
      else await onExport(payload);
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  if (suspended) return null;

  const setupRequired = Boolean(references && !requestReady);

  return <Modal title="New Request" subtitle="Create a stage-zero request in Zeus, or create it and export the request workbook in one action." onClose={onClose} wide actions={<>
    <span className="modal-action-note">{source === "ticket" ? "TT inherited from active SR" : "Manual TT · warning allowed"}</span>
    <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
    {onRegisterManual && <button
      type="button"
      className="create-button manual-registration-button"
      disabled={!references || saving || !canAttemptExport}
      title="Create this request at Added to Zeus without exporting an XLSX"
      autoFocus={initialAction === "manual"}
      onClick={() => void submit("manual")}
    >{savingAction === "manual" ? "Creating…" : "Create"}</button>}
    <button
      type="button"
      className={setupRequired ? "danger-button export-setup-button" : "primary-button"}
      disabled={!references || saving || (!setupRequired && !canAttemptExport)}
      title={setupRequired ? `Configure ${references?.exportSetup.requestMissing.map((item) => item.label).join(" and ") || "the Spare Request export paths"}` : undefined}
      onClick={() => void submit("export")}
    >{savingAction === "export" ? "Exporting…" : "Export"}</button>
  </>}>
    <div className="spare-request-form">
      <section className="form-section">
        <div className="section-heading"><strong>Customer and ticket</strong><span>{source}</span></div>
        <div className="form-grid three">
          <AutocompleteField label="Customer name" required value={profile.customerName} options={customerOptions} onChange={chooseCustomer} onSelect={(option) => chooseCustomerById(option.key)} autoFocus={initialAction !== "manual"} />
          <AutocompleteField label="Customer organization" required value={profile.customerOrganization} options={organizationOptions} onChange={(value) => updateProfile("customerOrganization", value)} />
          <label className="form-field"><span>TT · 8 digits</span><input value={ticketId} disabled={ttLocked} maxLength={8} onChange={(event) => { setTicketId(event.target.value.replace(/\D/g, "")); setSource("manual"); setReportDate(""); }} /></label>
          <label className="form-field"><span>Customer email *</span><input type="email" required value={profile.contactEmail} onChange={(event) => updateProfile("contactEmail", event.target.value)} /></label>
          <label className="form-field"><span>Customer phone *</span><input type="tel" required value={profile.contactPhone} onChange={(event) => updateProfile("contactPhone", event.target.value)} /></label>
          <label className="form-field"><span>Original TT report date *</span><input type="date" required value={reportDate} readOnly={source === "ticket" && Boolean(reportDate)} onChange={(event) => setReportDate(event.target.value)} /></label>
          <button type="button" className="secondary-button field-button" disabled={loading || !/^\d{8}$/.test(ticketId)} onClick={() => void loadTicket(true)}>{loading ? "Loading…" : "Load active SR"}</button>
          {source === "ticket" && profile.customerName && profile.customerOrganization && <button type="button" className="secondary-button field-button global-save-button" disabled={importing || !profile.contactEmail.trim() || !profile.contactPhone.trim()} title={!profile.contactEmail.trim() || !profile.contactPhone.trim() ? "Customer email and phone are required before saving globally" : undefined} onClick={() => void importCustomer()}><span aria-hidden="true">◆</span>{importing ? "Importing…" : "Save customer globally"}</button>}
        </div>
        {warning && <p className="inline-warning">{warning}</p>}
      </section>
      <section className="form-section">
        <div className="section-heading"><strong>Site and requester</strong><span>autocomplete from Global data</span></div>
        <div className="form-grid three">
          <AutocompleteField label="Site" required value={profile.siteCode} options={siteOptions} onChange={chooseSite} />
          <label className="form-field"><span>Cloud *</span><input value={profile.cloud} onChange={(event) => updateProfile("cloud", event.target.value)} /></label>
          <AutocompleteField label="Requester" required value={profile.requesterName} options={requesterOptions} onChange={chooseRequester} />
          <label className="form-field full"><span>Site address *</span><input value={profile.siteAddress} onChange={(event) => updateProfile("siteAddress", event.target.value)} /></label>
          <label className="form-field"><span>Requester email</span><input value={profile.requesterEmail} onChange={(event) => updateProfile("requesterEmail", event.target.value)} /></label>
          <label className="form-field"><span>Requester phone</span><input value={profile.requesterPhone} onChange={(event) => updateProfile("requesterPhone", event.target.value)} /></label>
        </div>
      </section>
      <section className="form-section">
        <div className="section-heading"><strong>Requested BOM groups</strong><span>{lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)} requested unit(s)</span></div>
        <div className="request-line-list">{lines.map((line, index) => <article className="request-line" key={index}>
          <header><strong>BOM group {index + 1}</strong>{lines.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setLines((current) => current.filter((_, position) => position !== index))}>Remove</button>}</header>
          <div className="form-grid four">
            <AutocompleteField label="BOM" required value={line.bom} options={bomOptions} onChange={(value) => chooseBom(index, value)} />
            <label className="form-field wide"><span>Description / part *</span><input value={line.description} onChange={(event) => updateLine(index, "description", event.target.value)} /></label>
            <label className="form-field"><span>{line.slot.trim() ? "Quantity · from slots" : "Quantity multiplier *"}</span><input type="number" min="1" max="1000" value={line.amount} readOnly={Boolean(line.slot.trim())} onChange={(event) => updateLine(index, "amount", event.target.value)} />{line.slot.trim() && <small>Automatically derived from {requestedQuantity(line.slot)} unique slot line(s).</small>}</label>
            {(["model", "device"] as const).map((key) => <label className="form-field" key={key}><span>{key[0].toUpperCase() + key.slice(1)}</span><input value={line[key]} onChange={(event) => updateLine(index, key, event.target.value)} /></label>)}
            <label className="form-field full slot-list-field"><span>Slots · one per line</span><textarea value={line.slot} onChange={(event) => updateLine(index, "slot", event.target.value)} placeholder={"DIMM101\nDIMM203\nDIMM103"} /><small>Each unique slot becomes one requested physical unit for this BOM.</small></label>
            <label className="form-field full faulty-serials-field"><span>Damaged-device serial evidence · one per line</span><textarea value={line.faultySn} onChange={(event) => updateLine(index, "faultySn", event.target.value)} placeholder={"CPU-SN-001\nMEMORY-SN-002\nMEZZ-SN-003"} /><small>The complete evidence list stays attached to every physical unit without changing quantity.</small></label>
            <label className="form-field full"><span>Notes</span><textarea value={line.notes} onChange={(event) => updateLine(index, "notes", event.target.value)} placeholder="Why this BOM is requested, tests already performed, or anything easy to forget." /></label>
          </div>
        </article>)}</div>
        <button type="button" className="secondary-button" onClick={() => setLines((current) => [...current, { ...EMPTY_LINE }])}>+ Add another BOM</button>
      </section>
    </div>
    {globalSaveConfirmation && <ConfirmationDialog title="Customer saved to Global Data" message="This organization and customer contact are now reusable. Manage them anytime from Global Data in the top bar." confirmLabel="Got it" cancelLabel="Close" onCancel={() => setGlobalSaveConfirmation(false)} onConfirm={() => setGlobalSaveConfirmation(false)} />}
  </Modal>;
}
