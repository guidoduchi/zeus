import { useEffect, useMemo, useState } from "react";
import type { EmailMessage, TicketDetail as TicketDetailType } from "../types";

type Tab = "overview" | "work" | "emails" | "mops" | "history";

interface TemplateOption {
  name: string;
  path: string;
}

interface Props {
  ticket: TicketDetailType | null;
  loading: boolean;
  templates: TemplateOption[];
  onClose: () => void;
  onSave: (ticketId: string, revision: string, changes: Record<string, unknown>) => Promise<void>;
  onGenerateMop: (ticketId: string, template: string) => void;
}

const LOCAL_FIELDS = [
  "Planned Date",
  "Site",
  "Cloud",
  "Model",
  "Device",
  "Slot",
  "Part",
  "BOM",
  "Old SN",
  "New SN",
  "RelatedSR",
  "Spare",
  "Done?",
  "Notes",
];

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
    setDraft(Object.fromEntries(LOCAL_FIELDS.map((field) => [field, String(ticket.localFields[field] ?? "")] )));
  }, [ticket]);

  const changes = useMemo(() => Object.fromEntries(
    LOCAL_FIELDS
      .filter((field) => String(ticket.localFields[field] ?? "") !== String(draft[field] ?? ""))
      .map((field) => [field, draft[field] === "" ? null : draft[field]]),
  ), [draft, ticket.localFields]);
  const changedCount = Object.keys(changes).length;

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
    <div className="tab-content work-tab">
      <div className="source-contract">
        <strong>Pendings remains authoritative.</strong>
        <span>Save writes the validated workbook first, then imports the same values into Markdown.</span>
      </div>
      <div className="work-form">
        {LOCAL_FIELDS.map((field) => {
          if (field === "Notes") {
            return (
              <label className="form-field full" key={field}>
                <span>{field}</span>
                <textarea rows={7} value={draft[field] || ""} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />
              </label>
            );
          }
          if (field === "Done?") {
            return (
              <label className="form-field" key={field}>
                <span>{field}</span>
                <select value={draft[field] || "N"} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}>
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
              <input value={draft[field] || ""} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} placeholder="—" />
            </label>
          );
        })}
      </div>
      <div className="inline-actions sticky-actions">
        <span>{changedCount ? `${changedCount} unsaved field(s)` : "No unsaved changes"}</span>
        <button type="button" className="primary-button" disabled={!changedCount || saving} onClick={save}>
          {saving ? "Saving…" : "Save through Pendings"}
        </button>
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
        <button type="button" className="primary-button" disabled={!template} onClick={() => onGenerateMop(ticket.ticketId, template)}>Generate next version</button>
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

export function TicketDetail({ ticket, loading, templates, onClose, onSave, onGenerateMop }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => setTab("overview"), [ticket?.ticketId]);
  if (loading && !ticket) return <aside className="detail-panel"><div className="detail-loading">Reading ticket…</div></aside>;
  if (!ticket) return null;
  const tabs: Array<[Tab, string, number | null]> = [
    ["overview", "Overview", null],
    ["work", "Work fields", null],
    ["emails", "Emails", ticket.email.messages.length],
    ["mops", "MOPs", ticket.mops.length],
    ["history", "History", ticket.history.length],
  ];
  return (
    <aside className="detail-panel" aria-label={`SR ${ticket.ticketId} detail`}>
      <header className="detail-header">
        <div>
          <span>SR {ticket.ticketId}</span>
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
      <div className="detail-scroll">
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
