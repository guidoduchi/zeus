import { useEffect, useMemo, useState } from "react";
import type { EmailMessage, SpareDevice, SparePart, TicketDetail as TicketDetailType } from "../types";

type Tab = "overview" | "work" | "spares" | "emails" | "mops" | "history";

interface TemplateOption {
  name: string;
  path: string;
}

interface Props {
  ticket: TicketDetailType | null;
  loading: boolean;
  initialTab?: Tab;
  templates: TemplateOption[];
  onClose: () => void;
  onSave: (ticketId: string, revision: string, changes: Record<string, unknown>) => Promise<void>;
  onGenerateMop: (ticketId: string, template: string) => void;
}

const WORK_FIELDS = [
  "Planned Date",
  "Site",
  "Cloud",
  "RelatedSR",
  "Done?",
  "Notes",
];

function draftValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (field === "Planned Date") {
    const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || "";
  }
  return String(value);
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function FieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <dl className="field-list">
      {Object.entries(fields).map(([key, value]) => (
        <div className="field-row" key={key}>
          <dt>{key}</dt>
          <dd>{display(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function WorkTab({ ticket, onSave }: Pick<Props, "ticket" | "onSave"> & { ticket: TicketDetailType }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(Object.fromEntries(
      WORK_FIELDS.map((field) => [field, draftValue(field, ticket.localFields[field])]),
    ));
  }, [ticket]);

  const changes = useMemo(() => Object.fromEntries(
    WORK_FIELDS
      .filter((field) => draftValue(field, ticket.localFields[field]) !== String(draft[field] ?? ""))
      .map((field) => [field, draft[field] === "" ? null : draft[field]]),
  ), [draft, ticket.localFields]);
  const changedCount = Object.keys(changes).length;

  function setField(field: string, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    if (!changedCount) return;
    setSaving(true);
    try {
      await onSave(ticket.ticketId, ticket.revision, changes);
    } catch {
      // App owns the conflict/error toast and reloads the authoritative value.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bounded-edit-tab">
      <div className="edit-tab-scroll">
        <div className="tab-content work-tab">
          <div className="source-contract">
            <strong>{ticket.readOnly ? "Finalized SR archive." : "Pendings remains authoritative."}</strong>
            <span>{ticket.readOnly ? "These values are preserved from Closed.xlsx and cannot be changed from the site." : "Save writes the validated workbook first, then imports the same values into Markdown."}</span>
          </div>
          <div className="work-form">
            {WORK_FIELDS.map((field) => {
              if (field === "Notes") {
                return (
                  <label className="form-field full" key={field}>
                    <span>{field}</span>
                    <textarea rows={7} value={draft[field] || ""} disabled={ticket.readOnly} onChange={(event) => setField(field, event.target.value)} />
                  </label>
                );
              }
              if (field === "Planned Date") {
                return (
                  <label className="form-field" key={field}>
                    <span>{field}</span>
                    <input type="date" value={draft[field] || ""} disabled={ticket.readOnly} onChange={(event) => setField(field, event.target.value)} />
                  </label>
                );
              }
              if (field === "Done?") {
                return (
                  <label className="form-field" key={field}>
                    <span>{field}</span>
                    <select value={draft[field] || "N"} disabled={ticket.readOnly} onChange={(event) => setField(field, event.target.value)}>
                      <option value="N">N — Not completed</option>
                      <option value="Y">Y — Completed</option>
                      <option value="P">P — Attempted, issue pending</option>
                      <option value="?">? — Outside visibility</option>
                    </select>
                  </label>
                );
              }
              return (
                <label className="form-field" key={field}>
                  <span>{field}</span>
                  <input value={draft[field] || ""} disabled={ticket.readOnly} onChange={(event) => setField(field, event.target.value)} placeholder="—" />
                </label>
              );
            })}
          </div>
        </div>
      </div>
      <div className="inline-actions edit-actions">
        <span>{ticket.readOnly ? "Closed SR · read-only archive" : changedCount ? `${changedCount} unsaved field(s)` : "No unsaved changes"}</span>
        {!ticket.readOnly && (
          <button type="button" className="primary-button" disabled={!changedCount || saving} onClick={save}>
            {saving ? "Saving…" : "Save through Pendings"}
          </button>
        )}
      </div>
    </div>
  );
}

type DraftPart = Record<keyof SparePart, string>;
interface DraftDevice {
  device: string;
  model: string;
  parts: DraftPart[];
}

function emptyPart(): DraftPart {
  return { slot: "", part: "", bom: "", faulty_sn: "", new_sn: "" };
}

function spareDraft(value: SpareDevice[]): DraftDevice[] {
  return value.map((device) => ({
    device: device.device || "",
    model: device.model || "",
    parts: device.parts.map((part) => ({
      slot: part.slot || "",
      part: part.part || "",
      bom: part.bom || "",
      faulty_sn: part.faulty_sn || "",
      new_sn: part.new_sn || "",
    })),
  }));
}

function cleanSpareParts(value: DraftDevice[] | SpareDevice[]): SpareDevice[] {
  return value.flatMap((device) => {
    const parts = device.parts.flatMap((part) => {
      const cleaned: SparePart = {
        slot: String(part.slot || "").trim() || null,
        part: String(part.part || "").trim() || null,
        bom: String(part.bom || "").trim() || null,
        faulty_sn: String(part.faulty_sn || "").trim() || null,
        new_sn: String(part.new_sn || "").trim() || null,
      };
      return Object.values(cleaned).some(Boolean) ? [cleaned] : [];
    });
    const cleaned: SpareDevice = {
      device: String(device.device || "").trim() || null,
      model: String(device.model || "").trim() || null,
      parts,
    };
    return cleaned.device || cleaned.model || cleaned.parts.length ? [cleaned] : [];
  });
}

function SparePartsTab({ ticket, onSave }: Pick<Props, "ticket" | "onSave"> & { ticket: TicketDetailType }) {
  const [devices, setDevices] = useState<DraftDevice[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDevices(spareDraft(ticket.spareParts)), [ticket]);

  const cleaned = useMemo(() => cleanSpareParts(devices), [devices]);
  const changed = JSON.stringify(cleaned) !== JSON.stringify(cleanSpareParts(ticket.spareParts));
  const partCount = cleaned.reduce((total, device) => total + device.parts.length, 0);

  function updateDevice(index: number, field: "device" | "model", value: string) {
    setDevices((current) => current.map((device, position) => (
      position === index ? { ...device, [field]: value } : device
    )));
  }

  function updatePart(deviceIndex: number, partIndex: number, field: keyof SparePart, value: string) {
    setDevices((current) => current.map((device, position) => position !== deviceIndex ? device : ({
      ...device,
      parts: device.parts.map((part, candidate) => candidate === partIndex ? { ...part, [field]: value } : part),
    })));
  }

  async function save() {
    if (!changed) return;
    setSaving(true);
    try {
      await onSave(ticket.ticketId, ticket.revision, { "Spare Parts": cleaned });
    } catch {
      // App owns conflict/error feedback and authoritative reloads.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bounded-edit-tab">
      <div className="edit-tab-scroll">
        <div className="tab-content spare-parts-tab">
          <div className="source-contract">
            <strong>{ticket.readOnly ? `SR ${ticket.ticketId} is finalized.` : "The Spare Parts worksheet remains authoritative."}</strong>
            <span>{ticket.readOnly ? "Its devices and parts remain assigned to this SR through the validated Closed.xlsx archive." : "Each damaged device can contain multiple parts. Compatibility columns and the export-only Spare tag are generated automatically."}</span>
          </div>
          {!devices.length && (
            <div className="empty-spares">
              <strong>This ticket has no spare-parts record.</strong>
              <span>Add a device only when hardware replacement work is required.</span>
            </div>
          )}
          <div className="spare-device-list">
            {devices.map((device, deviceIndex) => (
              <article className="spare-device" key={`device-${deviceIndex}`}>
                <header>
                  <strong>Damaged device {deviceIndex + 1}</strong>
                  {!ticket.readOnly && <button type="button" className="text-button danger-text" onClick={() => setDevices((current) => current.filter((_, index) => index !== deviceIndex))}>Remove device</button>}
                </header>
                <div className="device-fields">
                  <label className="form-field">
                    <span>Device</span>
                    <input aria-label={`Device ${deviceIndex + 1} name`} value={device.device} disabled={ticket.readOnly} onChange={(event) => updateDevice(deviceIndex, "device", event.target.value)} placeholder="Hostname or equipment ID" />
                  </label>
                  <label className="form-field">
                    <span>Model</span>
                    <input aria-label={`Device ${deviceIndex + 1} model`} value={device.model} disabled={ticket.readOnly} onChange={(event) => updateDevice(deviceIndex, "model", event.target.value)} placeholder="Equipment model" />
                  </label>
                </div>
                <div className="part-list">
                  {device.parts.map((part, partIndex) => (
                    <section className="spare-part" key={`part-${partIndex}`}>
                      <header>
                        <strong>Part {partIndex + 1}</strong>
                        {!ticket.readOnly && <button type="button" className="text-button danger-text" onClick={() => setDevices((current) => current.map((candidate, index) => index !== deviceIndex ? candidate : ({ ...candidate, parts: candidate.parts.filter((_, position) => position !== partIndex) })))}>Remove part</button>}
                      </header>
                      <div className="part-fields">
                        {([
                          ["slot", "Slot"],
                          ["part", "Part"],
                          ["bom", "BOM (part number)"],
                          ["faulty_sn", "Faulty SN"],
                          ["new_sn", "New SN"],
                        ] as Array<[keyof SparePart, string]>).map(([field, label]) => (
                          <label className="form-field" key={field}>
                            <span>{label}</span>
                            <input aria-label={`Device ${deviceIndex + 1} part ${partIndex + 1} ${label}`} value={part[field]} disabled={ticket.readOnly} onChange={(event) => updatePart(deviceIndex, partIndex, field, event.target.value)} placeholder="—" />
                          </label>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                {!ticket.readOnly && <button type="button" className="secondary-button add-part" onClick={() => setDevices((current) => current.map((candidate, index) => index === deviceIndex ? ({ ...candidate, parts: [...candidate.parts, emptyPart()] }) : candidate))}>+ Add damaged part</button>}
              </article>
            ))}
          </div>
          {!ticket.readOnly && <button type="button" className="secondary-button add-device" onClick={() => setDevices((current) => [...current, { device: "", model: "", parts: [emptyPart()] }])}>+ Add damaged device</button>}
        </div>
      </div>
      <div className="inline-actions edit-actions">
        <span>{ticket.readOnly ? `${cleaned.length} device(s), ${partCount} part(s) · closed SR archive` : changed ? `${cleaned.length} device(s), ${partCount} part(s) · unsaved` : `${cleaned.length} device(s), ${partCount} part(s)`}</span>
        {!ticket.readOnly && (
          <button type="button" className="primary-button" disabled={!changed || saving} onClick={save}>
            {saving ? "Saving…" : "Save through Pendings"}
          </button>
        )}
      </div>
    </div>
  );
}

function EmailsTab({ messages }: { messages: EmailMessage[] }) {
  const [selected, setSelected] = useState(0);
  const [fullThread, setFullThread] = useState(false);
  useEffect(() => {
    setSelected(0);
    setFullThread(false);
  }, [messages]);
  if (!messages.length) return <div className="empty-panel">No retained email replies.</div>;
  const message = messages[Math.min(selected, messages.length - 1)];
  const body = fullThread ? message.body : (message.latestReplyBody ?? message.body);
  return (
    <div className="email-layout">
      <div className="email-list" role="listbox" aria-label="Retained email replies">
        {messages.map((candidate, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === selected}
            className={index === selected ? "selected" : ""}
            key={candidate.messageKey || `${candidate.timestamp}-${index}`}
            onClick={() => { setSelected(index); setFullThread(false); }}
          >
            <span>{candidate.timestamp || "Unknown time"}</span>
            <strong>{candidate.direction || "unknown"}</strong>
            <em>{candidate.subject}</em>
          </button>
        ))}
      </div>
      <article className="email-reader">
        <header>
          <div>
            <strong>{message.subject}</strong>
            <span>{message.sender || "Unknown sender"} · {message.direction || "unknown"}</span>
          </div>
          {message.quotedHistoryHidden && (
            <button type="button" className="text-button" onClick={() => setFullThread((value) => !value)}>
              {fullThread ? "Compact reply" : "Full thread"}
            </button>
          )}
        </header>
        <pre>{body || (message.quotedHistoryHidden ? "No new text in this reply." : "Body unavailable.")}</pre>
        {message.quotedHistoryHidden && !fullThread && (
          <small>Earlier reply history hidden{message.quotedHistoryLines ? ` (${message.quotedHistoryLines} lines)` : ""}.</small>
        )}
      </article>
    </div>
  );
}

function MopsTab({ ticket, templates, onGenerateMop }: { ticket: TicketDetailType; templates: TemplateOption[]; onGenerateMop: Props["onGenerateMop"] }) {
  const [template, setTemplate] = useState(templates[0]?.path || "");
  useEffect(() => setTemplate(templates[0]?.path || ""), [templates]);
  return (
    <div className="tab-content">
      <div className="mop-generator">
        <label className="form-field full">
          <span>MOP template</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value)}>
            <option value="">Choose a configured Word template</option>
            {templates.map((option) => <option value={option.path} key={option.path}>{option.name}</option>)}
          </select>
        </label>
        <button type="button" className="primary-button" disabled={!template || ticket.readOnly} onClick={() => onGenerateMop(ticket.ticketId, template)}>Generate next version</button>
      </div>
      <div className="section-heading"><strong>Generated MOPs</strong><span>{ticket.mops.length}</span></div>
      <div className="file-list">
        {ticket.mops.length ? ticket.mops.map((file) => (
          <a href={`/api/tickets/${ticket.ticketId}/mops/${encodeURIComponent(file.name)}`} key={file.name}>
            <span>{file.name}</span><small>{Math.max(1, Math.round(file.size / 1024))} kB</small>
          </a>
        )) : <div className="empty-panel">No MOP has been generated for this ticket.</div>}
      </div>
    </div>
  );
}

export function TicketDetail({ ticket, loading, initialTab = "overview", templates, onClose, onSave, onGenerateMop }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab, ticket?.ticketId]);
  if (loading && !ticket) return <aside className="detail-panel"><div className="detail-loading">Reading ticket…</div></aside>;
  if (!ticket) return null;
  const tabs: Array<[Tab, string, number | null]> = [
    ["overview", "Overview", null],
    ["work", "Work fields", null],
    ["spares", "Spare Parts", ticket.spareParts.reduce((total, device) => total + device.parts.length, 0)],
    ["emails", "Emails", ticket.emailCount],
    ["mops", "MOPs", ticket.mops.length],
    ["history", "History", ticket.history.length],
  ];
  return (
    <aside className="detail-panel" aria-label={`SR ${ticket.ticketId} detail`}>
      <header className="detail-header">
        <div>
          <span>SR {ticket.ticketId}{ticket.readOnly && <small className="archive-badge">Closed · read-only</small>}</span>
          <h2>{ticket.summary || "No problem summary"}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close ticket detail">×</button>
      </header>
      <nav className="detail-tabs" aria-label="Ticket sections">
        {tabs.map(([key, label, count]) => (
          <button type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)} key={key}>
            {label}{count !== null && <small>{count}</small>}
          </button>
        ))}
      </nav>
      <div className={`detail-scroll${tab === "emails" ? " email-detail-scroll" : ""}${tab === "work" || tab === "spares" ? " bounded-edit-scroll" : ""}`}>
        {tab === "overview" && (
          <div className="tab-content">
            <div className="fact-grid">
              <div><span>Lifecycle</span><strong>{ticket.lifecycle}</strong></div>
              <div><span>Done?</span><strong>{ticket.done}</strong></div>
              <div><span>Planned</span><strong>{ticket.plannedDate}</strong></div>
              <div><span>Ticket age</span><strong>{ticket.ticketAgeDays ?? "—"} days</strong></div>
              <div><span>Resolve by</span><strong>{ticket.resolveBy}</strong></div>
              <div><span>Email inactivity</span><strong>{ticket.emailLabel}</strong></div>
            </div>
            <div className="section-heading"><strong>Advanced Search fields</strong><span>read-only</span></div>
            <FieldList fields={ticket.upstreamFields} />
          </div>
        )}
        {tab === "work" && <WorkTab ticket={ticket} onSave={onSave} />}
        {tab === "spares" && <SparePartsTab ticket={ticket} onSave={onSave} />}
        {tab === "emails" && <EmailsTab messages={ticket.email.messages} />}
        {tab === "mops" && <MopsTab ticket={ticket} templates={templates} onGenerateMop={onGenerateMop} />}
        {tab === "history" && (
          <div className="history-list">
            {ticket.history.length ? ticket.history.map((event, index) => (
              <article key={`${event.timestamp}-${index}`}>
                <time>{event.timestamp || "Unknown time"}</time>
                <strong>{event.action || "event"}</strong>
                <pre>{JSON.stringify(event.summary, null, 2)}</pre>
              </article>
            )) : <div className="empty-panel">No ticket-specific audit events found.</div>}
          </div>
        )}
      </div>
    </aside>
  );
}
