import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearTicketDraft,
  readTicketDraft,
  writeTicketDraft,
} from "../drafts";
import { isEditingArea } from "../hooks/useGlobalCommands";
import {
  analyzeTicketDraft,
  changedWorkFields,
  cleanSpareParts,
  emptyPart,
  requestedQuantity,
  spareDraft,
  workFieldValues,
  type DraftDevice,
  type DraftPart,
  type WorkDraft,
} from "../ticketDraftModel";
import type { EmailMessage, SpareDevice, TicketDetail as TicketDetailType } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { maintenanceWindowLabel } from "../maintenanceWindow";
import { Modal } from "./Modal";

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
  onConfirmMaintenanceWindow?: (ticketId: string, revision: string, plannedDate: string, finishTime?: string | null) => Promise<void>;
  onOpenUpcoming?: () => void;
  onGenerateMop: (ticketId: string, template: string) => void;
  onRegisterSpareRequest?: (ticketId: string) => void;
  showHistory?: boolean;
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function localDateText(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextDeviceNumber(devices: DraftDevice[]): number {
  return Math.max(0, ...devices.map((device) => device.device_number)) + 1;
}

function emptyDevice(deviceNumber: number): DraftDevice {
  return {
    device_number: deviceNumber,
    device: "",
    model: "",
    notes: "",
    faulty_sns: "",
    next_part_number: 1,
    active_request_ids: [],
    has_submitted_parts: false,
    parts: [],
  };
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

function WorkTab({ ticket, onSave, onConfirmMaintenanceWindow, onOpenUpcoming }: Pick<Props, "ticket" | "onSave" | "onConfirmMaintenanceWindow" | "onOpenUpcoming"> & { ticket: TicketDetailType }) {
  const [draft, setDraft] = useState<WorkDraft>(() => workFieldValues(ticket));
  const [draftRevision, setDraftRevision] = useState(ticket.revision);
  const [baseValue, setBaseValue] = useState<Record<string, string>>(() => workFieldValues(ticket));
  const [stale, setStale] = useState(false);
  const [devices, setDevices] = useState<DraftDevice[]>(() => spareDraft(ticket.spareParts));
  const [deviceDraftRevision, setDeviceDraftRevision] = useState(ticket.revision);
  const [deviceBaseValue, setDeviceBaseValue] = useState<SpareDevice[]>(() => cleanSpareParts(ticket.spareParts));
  const [deviceStale, setDeviceStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ kind: "discard" | "remove-device"; deviceNumber?: number } | null>(null);
  const [deviceBatch, setDeviceBatch] = useState({ names: "", model: "", notes: "" });
  const [completionOpen, setCompletionOpen] = useState(false);
  const [finishTime, setFinishTime] = useState("");

  useEffect(() => {
    if (saving) return;
    const current = workFieldValues(ticket);
    const stored = readTicketDraft<WorkDraft>(ticket.ticketId, "work");
    if (!stored || !stored.value || typeof stored.value !== "object") {
      setDraft(current);
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      return;
    }
    const analysis = analyzeTicketDraft(ticket, "work", stored);
    if (!analysis) {
      clearTicketDraft(ticket.ticketId, "work");
      setDraft(current);
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDraft(rebased.value);
    if (analysis.conflictFields.length) {
      setDraftRevision(stored.revision);
      setBaseValue(stored.baseValue);
      setStale(true);
    } else {
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      if (stored.revision !== ticket.revision) writeTicketDraft(ticket.ticketId, "work", rebased);
    }
  }, [saving, ticket.ticketId, ticket.revision]);

  useEffect(() => {
    if (saving) return;
    const current = cleanSpareParts(ticket.spareParts);
    const stored = readTicketDraft<DraftDevice[], SpareDevice[]>(ticket.ticketId, "spares");
    if (!stored || !Array.isArray(stored.value) || !Array.isArray(stored.baseValue)) {
      setDevices(spareDraft(ticket.spareParts));
      setDeviceDraftRevision(ticket.revision);
      setDeviceBaseValue(current);
      setDeviceStale(false);
      return;
    }
    const analysis = analyzeTicketDraft(ticket, "spares", stored);
    if (!analysis) {
      clearTicketDraft(ticket.ticketId, "spares");
      setDevices(spareDraft(ticket.spareParts));
      setDeviceDraftRevision(ticket.revision);
      setDeviceBaseValue(current);
      setDeviceStale(false);
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDevices(rebased.value);
    if (analysis.conflictFields.length) {
      setDeviceDraftRevision(stored.revision);
      setDeviceBaseValue(stored.baseValue);
      setDeviceStale(true);
    } else {
      setDeviceDraftRevision(ticket.revision);
      setDeviceBaseValue(current);
      setDeviceStale(false);
      if (stored.revision !== ticket.revision) writeTicketDraft(ticket.ticketId, "spares", rebased);
    }
  }, [saving, ticket.ticketId, ticket.revision]);

  const changes = useMemo(() => changedWorkFields(ticket, draft), [draft, ticket]);
  const cleanedDevices = useMemo(() => cleanSpareParts(devices), [devices]);
  const devicesChanged = JSON.stringify(cleanedDevices) !== JSON.stringify(cleanSpareParts(ticket.spareParts));
  const changedCount = Object.keys(changes).length + (devicesChanged ? 1 : 0);
  const maintenanceWindowChanged = "Planned Date" in changes || "Done?" in changes || "Maintenance Window Start Time" in changes;
  const currentMaintenanceWindow = ticket.maintenanceWindow;
  const maintenanceWindowManaged = Boolean(currentMaintenanceWindow?.managedInUpcoming);
  const canCompleteMaintenanceWindow = Boolean(
    currentMaintenanceWindow?.confirmationRequired
    && currentMaintenanceWindow.date
    && !maintenanceWindowChanged
    && !stale
    && !maintenanceWindowManaged,
  );
  const canStartNewMaintenanceWindow = Boolean(
    currentMaintenanceWindow?.status === "completed"
    && !maintenanceWindowChanged
    && !stale,
  );

  function setFields(values: Record<string, string>) {
    setDraft((current) => {
      const next = { ...current, ...values };
      if (Object.keys(changedWorkFields(ticket, next)).length) {
        writeTicketDraft(ticket.ticketId, "work", {
          revision: draftRevision,
          baseValue,
          value: next,
        });
      } else {
        clearTicketDraft(ticket.ticketId, "work");
      }
      return next;
    });
  }

  function setField(field: string, value: string) {
    setFields({ [field]: value });
  }

  function updateDevices(update: (current: DraftDevice[]) => DraftDevice[]) {
    setDevices((current) => {
      const next = update(current);
      if (JSON.stringify(cleanSpareParts(next)) !== JSON.stringify(cleanSpareParts(ticket.spareParts))) {
        writeTicketDraft(ticket.ticketId, "spares", {
          revision: deviceDraftRevision,
          baseValue: deviceBaseValue,
          value: next,
        });
      } else {
        clearTicketDraft(ticket.ticketId, "spares");
      }
      return next;
    });
  }

  function discardDraft() {
    const current = workFieldValues(ticket);
    clearTicketDraft(ticket.ticketId, "work");
    setDraft(current);
    setDraftRevision(ticket.revision);
    setBaseValue(current);
    setStale(false);
    clearTicketDraft(ticket.ticketId, "spares");
    setDevices(spareDraft(ticket.spareParts));
    setDeviceDraftRevision(ticket.revision);
    setDeviceBaseValue(cleanSpareParts(ticket.spareParts));
    setDeviceStale(false);
  }

  function restoreDraft() {
    const stored = readTicketDraft<WorkDraft>(ticket.ticketId, "work");
    if (!stored) return;
    const analysis = analyzeTicketDraft(ticket, "work", stored);
    if (!analysis) {
      discardDraft();
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDraft(rebased.value);
    setDraftRevision(ticket.revision);
    setBaseValue(workFieldValues(ticket));
    setStale(false);
    writeTicketDraft(ticket.ticketId, "work", rebased);
    setRestoreOpen(false);
  }

  function restoreDeviceDraft() {
    const stored = readTicketDraft<DraftDevice[], SpareDevice[]>(ticket.ticketId, "spares");
    if (!stored) return;
    const analysis = analyzeTicketDraft(ticket, "spares", stored);
    if (!analysis) {
      clearTicketDraft(ticket.ticketId, "spares");
      setDevices(spareDraft(ticket.spareParts));
      setDeviceStale(false);
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDevices(rebased.value);
    setDeviceDraftRevision(ticket.revision);
    setDeviceBaseValue(cleanSpareParts(ticket.spareParts));
    setDeviceStale(false);
    writeTicketDraft(ticket.ticketId, "spares", rebased);
  }

  async function save() {
    if (!changedCount || stale || deviceStale) return;
    setSaving(true);
    try {
      await onSave(ticket.ticketId, draftRevision, {
        ...changes,
        ...(devicesChanged ? { "Spare Parts": cleanedDevices } : {}),
      });
      clearTicketDraft(ticket.ticketId, "work");
      clearTicketDraft(ticket.ticketId, "spares");
    } catch {
      // App owns the conflict/error toast and reloads the authoritative value.
    } finally {
      setSaving(false);
    }
  }

  async function completeMaintenanceWindow() {
    const plannedDate = currentMaintenanceWindow?.date;
    if (!canCompleteMaintenanceWindow || !plannedDate || !onConfirmMaintenanceWindow) return;
    setSaving(true);
    try {
      await onConfirmMaintenanceWindow(ticket.ticketId, ticket.revision, plannedDate, finishTime || null);
      setCompletionOpen(false);
      setFinishTime("");
    } finally {
      setSaving(false);
    }
  }

  async function startNewMaintenanceWindow() {
    if (!canStartNewMaintenanceWindow) return;
    setSaving(true);
    try {
      await onSave(ticket.ticketId, ticket.revision, {
        "Planned Date": null,
        "Done?": "N",
      });
    } finally {
      setSaving(false);
    }
  }

  function addDeviceBatch() {
    const names = [...new Set(deviceBatch.names.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    if (!names.length) return;
    updateDevices((current) => {
      let nextNumber = nextDeviceNumber(current);
      const added = names.map((name) => ({
        ...emptyDevice(nextNumber++),
        device: name,
        model: deviceBatch.model,
        notes: deviceBatch.notes,
      }));
      return [...current, ...added];
    });
    setDeviceBatch({ names: "", model: "", notes: "" });
  }

  const maintenanceWindowCode = draft["Done?"] || "N";
  const maintenanceWindowDate = draft["Planned Date"] || "";
  const maintenanceWindowStartTime = draft["Maintenance Window Start Time"] || "";
  const maintenanceWindowCompleted = maintenanceWindowCode === "Y";
  const maintenanceWindowInvisible = maintenanceWindowCode === "?";
  const maintenanceWindowState = maintenanceWindowCompleted
    ? "Completed"
    : maintenanceWindowInvisible
      ? "No visibility"
      : maintenanceWindowDate
        ? maintenanceWindowDate < localDateText() ? "Incomplete" : "Planned"
        : "Unplanned";

  return <>
    <div className="bounded-edit-tab">
      <div className="edit-tab-scroll">
        <div className="tab-content work-tab">
          <div className="source-contract">
            <strong>{ticket.readOnly ? "Finalized SR archive." : "Zeus is authoritative."}</strong>
            <span>{ticket.readOnly ? "These values are preserved from Closed.xlsx and cannot be changed from the site." : "Save writes these validated work fields directly to the local database. Workbooks change only when you export them."}</span>
          </div>
          {stale && <div className="inline-warning">The same database work fields changed after this draft began. Restore the protected changes over the latest values for review, or discard this draft. Restoring does not save.</div>}
          {deviceStale && <div className="inline-warning">The affected-device record changed after this draft began. Restore the protected device changes over the latest values for review, or discard the draft.</div>}
          <div className="work-form">
            <section className="maintenance-window-editor full" aria-label="Maintenance Window (MW)">
              <div className="section-heading">
                <strong>Maintenance Window (MW)</strong>
                <span className={`mw-state mw-state-${maintenanceWindowState.toLowerCase().replace(" ", "-")}`}>{maintenanceWindowState}</span>
              </div>
              <div className="mw-control-row">
                <label className="form-field mw-date-field">
                  <span>MW date</span>
                  <input
                    type="date"
                    value={maintenanceWindowDate}
                    disabled={ticket.readOnly || maintenanceWindowCompleted || maintenanceWindowManaged}
                    onChange={(event) => setFields({
                      "Planned Date": event.target.value,
                      "Done?": "N",
                      ...(event.target.value ? {} : { "Maintenance Window Start Time": "" }),
                    })}
                  />
                </label>
                <label className="form-field mw-time-field">
                  <span>Optional start time</span>
                  <input
                    type="time"
                    step={1800}
                    value={maintenanceWindowStartTime}
                    disabled={ticket.readOnly || maintenanceWindowCompleted || maintenanceWindowManaged || !maintenanceWindowDate}
                    onChange={(event) => setField("Maintenance Window Start Time", event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className={`mw-visibility-toggle${maintenanceWindowInvisible ? " active" : ""}`}
                  aria-label="MW visibility unknown"
                  aria-pressed={maintenanceWindowInvisible}
                  title="Toggle when the Maintenance Window date is not visible to you"
                  disabled={ticket.readOnly || maintenanceWindowCompleted || maintenanceWindowManaged}
                  onClick={() => setFields(maintenanceWindowInvisible
                    ? { "Done?": "N", "Planned Date": "", "Maintenance Window Start Time": "" }
                    : { "Done?": "?", "Planned Date": "", "Maintenance Window Start Time": "" })}
                ><strong>?</strong><span>No visibility</span></button>
              </div>
              <p className="mw-editor-help">No date is Unplanned. Today or a future date is Planned. Optional times must end in :00 or :30. After the date passes, Zeus marks it Incomplete until you confirm Completed.</p>
              {maintenanceWindowManaged && <div className="mw-managed-note"><span>This SR belongs to shared window <strong>{currentMaintenanceWindow?.windowId}</strong>. Its schedule and completion are controlled from Upcoming.</span>{onOpenUpcoming && <button type="button" className="secondary-button" onClick={onOpenUpcoming}>Open Upcoming</button>}</div>}
              {!!ticket.maintenanceWindow?.attempts.length && <div className="mw-attempt-history">
                <strong>Archived MW cycles</strong>
                {ticket.maintenanceWindow.attempts.map((attempt, index) => <span key={`${attempt.date}-${attempt.outcome}-${index}`}>{attempt.date}{attempt.start_time ? ` · ${attempt.start_time}` : ""} · {attempt.outcome === "completed" ? "Completed" : "Incomplete"}{attempt.finish_time ? ` at ${attempt.finish_date} ${attempt.finish_time}` : ""}</span>)}
              </div>}
            </section>
            <section className="site-information-section full" aria-label="Site information">
              <div className="section-heading"><strong>Site information</strong><span>Service location and cross-reference</span></div>
              <div className="site-information-grid">
                <label className="form-field"><span>Site</span><input value={draft.Site || ""} disabled={ticket.readOnly} onChange={(event) => setField("Site", event.target.value)} placeholder="—" /></label>
                <label className="form-field"><span>Cloud</span><input value={draft.Cloud || ""} disabled={ticket.readOnly} onChange={(event) => setField("Cloud", event.target.value)} placeholder="—" /></label>
                <label className="form-field"><span>Related SR</span><input value={draft.RelatedSR || ""} disabled={ticket.readOnly} onChange={(event) => setField("RelatedSR", event.target.value)} placeholder="—" /></label>
                <label className="form-field compact-notes-field"><span>Notes</span><textarea rows={2} value={draft.Notes || ""} disabled={ticket.readOnly} onChange={(event) => setField("Notes", event.target.value)} /></label>
              </div>
            </section>
          </div>
          <section className="affected-devices-section">
            <header className="section-heading">
              <strong>Affected / intervened devices</strong>
              <span>Device work does not require a spare part.</span>
            </header>
            {!ticket.readOnly && <div className="device-batch-entry">
              <label className="form-field full"><span>Device names · one per line</span><textarea rows={3} value={deviceBatch.names} onChange={(event) => setDeviceBatch((current) => ({ ...current, names: event.target.value }))} placeholder={"router-01\nrouter-02\nrouter-03"} /></label>
              <label className="form-field"><span>Shared model</span><input value={deviceBatch.model} onChange={(event) => setDeviceBatch((current) => ({ ...current, model: event.target.value }))} /></label>
              <label className="form-field"><span>Shared intervention notes</span><input value={deviceBatch.notes} onChange={(event) => setDeviceBatch((current) => ({ ...current, notes: event.target.value }))} /></label>
              <button type="button" className="secondary-button" disabled={!deviceBatch.names.trim()} onClick={addDeviceBatch}>Add independent device cards</button>
            </div>}
            {!devices.length && <div className="empty-spares"><strong>No affected devices registered.</strong><span>Add the equipment being investigated or intervened; a BOM is optional.</span></div>}
            <div className="affected-device-list">
              {devices.map((device, deviceIndex) => {
                const spareInvolved = device.parts.length > 0 || device.has_submitted_parts || device.active_request_ids.length > 0;
                const removalBlocked = device.parts.length > 0 || device.active_request_ids.length > 0;
                return <article className="affected-device" key={device.device_number}>
                  <header>
                    <strong>Device {deviceIndex + 1}</strong>
                    {spareInvolved && <span className="spare-involved-tag">Spare parts involved</span>}
                    {!ticket.readOnly && <button
                      type="button"
                      className="text-button danger-text"
                      disabled={removalBlocked}
                      title={removalBlocked ? "Remove its BOM records in Spare Parts first; Active Request ownership must also be cleared." : "Remove this affected device from both views"}
                      onClick={() => setConfirmAction({ kind: "remove-device", deviceNumber: device.device_number })}
                    >Remove device</button>}
                  </header>
                  <div className="device-fields">
                    <label className="form-field"><span>Device</span><input value={device.device} disabled={ticket.readOnly} onChange={(event) => updateDevices((current) => current.map((candidate) => candidate.device_number === device.device_number ? { ...candidate, device: event.target.value } : candidate))} placeholder="Hostname or equipment ID" /></label>
                    <label className="form-field"><span>Model</span><input value={device.model} disabled={ticket.readOnly} onChange={(event) => updateDevices((current) => current.map((candidate) => candidate.device_number === device.device_number ? { ...candidate, model: event.target.value } : candidate))} placeholder="Equipment model" /></label>
                    <label className="form-field full"><span>Intervention notes</span><textarea rows={3} value={device.notes} disabled={ticket.readOnly} onChange={(event) => updateDevices((current) => current.map((candidate) => candidate.device_number === device.device_number ? { ...candidate, notes: event.target.value } : candidate))} placeholder="Checks, intervention scope, or device-specific context." /></label>
                  </div>
                </article>;
              })}
            </div>
          </section>
        </div>
      </div>
      <div className="inline-actions edit-actions">
        <span>{ticket.readOnly ? "Closed SR · read-only archive" : changedCount ? `${changedCount} unsaved field(s) · draft protected` : "No unsaved changes"}</span>
        {!ticket.readOnly && (
          <div className="inline-actions">
            {changedCount > 0 && <button type="button" className="text-button danger-text" disabled={saving} onClick={() => setConfirmAction({ kind: "discard" })}>Discard draft</button>}
            {stale && <button type="button" className="secondary-button" disabled={saving} onClick={() => setRestoreOpen(true)}>Restore work changes</button>}
            {deviceStale && <button type="button" className="secondary-button" disabled={saving} onClick={restoreDeviceDraft}>Restore device changes</button>}
            {canCompleteMaintenanceWindow && onConfirmMaintenanceWindow && <button type="button" className="mw-completed-button" disabled={saving || deviceStale} onClick={() => { setFinishTime(""); setCompletionOpen(true); }}>Completed</button>}
            {canStartNewMaintenanceWindow && <button type="button" className="secondary-button mw-new-button" disabled={saving || deviceStale} onClick={() => void startNewMaintenanceWindow()}>New MW</button>}
            <button type="button" className="primary-button" disabled={!changedCount || saving || stale || deviceStale} onClick={save}>
              {saving ? "Saving…" : "Save to Zeus"}
            </button>
          </div>
        )}
      </div>
    </div>
    {restoreOpen && <ConfirmationDialog title={`Restore protected SR ${ticket.ticketId} changes?`} message="The protected Work Fields will be reapplied over the latest Zeus values for review. This action does not save anything to the database." confirmLabel="Restore for review" onCancel={() => setRestoreOpen(false)} onConfirm={restoreDraft} />}
    {confirmAction?.kind === "discard" && <ConfirmationDialog title={`Discard SR ${ticket.ticketId} draft?`} message="This removes the protected Work Fields and affected-device changes from this browser. Zeus database values remain unchanged." confirmLabel="Discard draft" tone="danger" onCancel={() => setConfirmAction(null)} onConfirm={() => { discardDraft(); setConfirmAction(null); }} />}
    {confirmAction?.kind === "remove-device" && <ConfirmationDialog title="Remove affected device?" message="This removes the device card and its device-specific data from the protected draft. The change reaches Zeus only after Save to Zeus." confirmLabel="Remove device" tone="danger" onCancel={() => setConfirmAction(null)} onConfirm={() => { const deviceNumber = confirmAction.deviceNumber; updateDevices((current) => current.filter((candidate) => candidate.device_number !== deviceNumber)); setConfirmAction(null); }} />}
    {completionOpen && <Modal
      title={`Complete SR ${ticket.ticketId} Maintenance Window?`}
      subtitle="The finish time is optional and remains part of the archived MW cycle."
      onClose={() => setCompletionOpen(false)}
      actions={<>
        <button type="button" onClick={() => setCompletionOpen(false)}>Cancel</button>
        <button type="button" className="mw-completed-button" disabled={saving || (finishTime !== "" && !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(finishTime))} onClick={() => { void completeMaintenanceWindow().catch(() => undefined); }}>{saving ? "Saving…" : "Confirm Completed"}</button>
      </>}
    >
      <section className="local-confirmation">
        <p>Zeus will archive the current cycle as Completed. If the finish clock time is earlier than {maintenanceWindowStartTime || "the optional start time"}, it belongs to the next calendar day; a recorded MW cannot exceed 12 hours.</p>
        <label className="form-field"><span>Optional finish time</span><input type="time" step={1800} value={finishTime} onChange={(event) => setFinishTime(event.target.value)} /></label>
        {finishTime !== "" && !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(finishTime) && <small className="status-bad">Finish time must end in :00 or :30.</small>}
      </section>
    </Modal>}
  </>;
}

function SparePartEditor({
  deviceIndex,
  part,
  readOnly,
  onUpdate,
  onRemove,
}: {
  deviceIndex: number;
  part: DraftPart;
  readOnly: boolean;
  onUpdate: (field: "slot" | "part" | "bom" | "notes", value: string) => void;
  onRemove: () => void;
}) {
  const locked = part.submitted;
  return <section className={`spare-part ${locked ? "submitted-part" : "new-part"}`}>
    <header>
      <strong>{locked ? "Submitted" : "New"} part {part.part_number}</strong>
      {locked && <span className="submitted-part-tag">Locked · already submitted</span>}
      {!readOnly && <button type="button" className="text-button danger-text" onClick={onRemove}>{locked ? "Delete submitted part" : "Remove part"}</button>}
    </header>
    <div className="part-fields">
      <label className="form-field full slot-list-field">
        <span>Slots · one per line</span>
        <textarea aria-label={`Device ${deviceIndex + 1} part ${part.part_number} Slots`} value={part.slot} disabled={readOnly || locked} onChange={(event) => onUpdate("slot", event.target.value)} placeholder={"DIMM101\nDIMM203\nDIMM103"} />
        <small>{requestedQuantity(part.slot)} requested unit{requestedQuantity(part.slot) === 1 ? "" : "s"} for this BOM</small>
      </label>
      <label className="form-field">
        <span>Part</span>
        <input aria-label={`Device ${deviceIndex + 1} part ${part.part_number} Part`} value={part.part} disabled={readOnly || locked} onChange={(event) => onUpdate("part", event.target.value)} placeholder="DIMM" />
      </label>
      <label className="form-field">
        <span>BOM (part number)</span>
        <input aria-label={`Device ${deviceIndex + 1} part ${part.part_number} BOM (part number)`} value={part.bom} disabled={readOnly || locked} onChange={(event) => onUpdate("bom", event.target.value)} placeholder="—" />
      </label>
      <label className="form-field full">
        <span>Notes</span>
        <textarea aria-label={`Device ${deviceIndex + 1} part ${part.part_number} Notes`} value={part.notes} disabled={readOnly || locked} onChange={(event) => onUpdate("notes", event.target.value)} placeholder="Why this BOM is requested, checks already performed, or anything easy to forget." />
      </label>
    </div>
    {locked && <footer>This exact BOM/slot record has already been submitted. Delete it and add a new record for another replacement.</footer>}
  </section>;
}

function SparePartsTab({ ticket, onSave, onRegisterSpareRequest }: Pick<Props, "ticket" | "onSave" | "onRegisterSpareRequest"> & { ticket: TicketDetailType }) {
  const [devices, setDevices] = useState<DraftDevice[]>(() => spareDraft(ticket.spareParts));
  const [draftRevision, setDraftRevision] = useState(ticket.revision);
  const [baseValue, setBaseValue] = useState<SpareDevice[]>(() => cleanSpareParts(ticket.spareParts));
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<
    | { kind: "discard" }
    | { kind: "device"; deviceNumber: number }
    | { kind: "part"; deviceNumber: number; partNumber: number }
    | null
  >(null);
  useEffect(() => {
    if (saving) return;
    const current = cleanSpareParts(ticket.spareParts);
    const stored = readTicketDraft<DraftDevice[], SpareDevice[]>(ticket.ticketId, "spares");
    if (!stored || !Array.isArray(stored.value) || !Array.isArray(stored.baseValue)) {
      setDevices(spareDraft(ticket.spareParts));
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      return;
    }
    const analysis = analyzeTicketDraft(ticket, "spares", stored);
    if (!analysis) {
      clearTicketDraft(ticket.ticketId, "spares");
      setDevices(spareDraft(ticket.spareParts));
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDevices(rebased.value);
    if (analysis.conflictFields.length) {
      setDraftRevision(stored.revision);
      setBaseValue(stored.baseValue);
      setStale(true);
    } else {
      setDraftRevision(ticket.revision);
      setBaseValue(current);
      setStale(false);
      if (stored.revision !== ticket.revision) writeTicketDraft(ticket.ticketId, "spares", rebased);
    }
  }, [saving, ticket.ticketId, ticket.revision]);

  const cleaned = useMemo(() => cleanSpareParts(devices), [devices]);
  const changed = JSON.stringify(cleaned) !== JSON.stringify(cleanSpareParts(ticket.spareParts));
  const partCount = cleaned.reduce((total, device) => total + device.parts.length, 0);
  const eligiblePartCount = devices.reduce(
    (total, device) => total + device.parts.filter(
      (part) => !part.submitted && Boolean(part.bom.trim()),
    ).length,
    0,
  );
  const requestedUnits = cleaned.reduce(
    (total, device) => total + device.parts.reduce(
      (subtotal, part) => subtotal + requestedQuantity(part.slot),
      0,
    ),
    0,
  );

  function updateDevices(update: (current: DraftDevice[]) => DraftDevice[]) {
    setDevices((current) => {
      const next = update(current);
      if (JSON.stringify(cleanSpareParts(next)) !== JSON.stringify(cleanSpareParts(ticket.spareParts))) {
        writeTicketDraft(ticket.ticketId, "spares", {
          revision: draftRevision,
          baseValue,
          value: next,
        });
      } else {
        clearTicketDraft(ticket.ticketId, "spares");
      }
      return next;
    });
  }

  function updateDevice(index: number, field: "device" | "model" | "faulty_sns", value: string) {
    updateDevices((current) => current.map((device, position) => (
      position === index ? { ...device, [field]: value } : device
    )));
  }

  function updatePart(deviceIndex: number, partNumber: number, field: "slot" | "part" | "bom" | "notes", value: string) {
    updateDevices((current) => current.map((device, position) => position !== deviceIndex ? device : ({
      ...device,
      parts: device.parts.map((part) => part.part_number === partNumber ? { ...part, [field]: value } : part),
    })));
  }

  function discardDraft() {
    const current = cleanSpareParts(ticket.spareParts);
    clearTicketDraft(ticket.ticketId, "spares");
    setDevices(spareDraft(ticket.spareParts));
    setDraftRevision(ticket.revision);
    setBaseValue(current);
    setStale(false);
  }

  function restoreDraft() {
    const stored = readTicketDraft<DraftDevice[], SpareDevice[]>(ticket.ticketId, "spares");
    if (!stored) return;
    const analysis = analyzeTicketDraft(ticket, "spares", stored);
    if (!analysis) {
      discardDraft();
      return;
    }
    const rebased = analysis.rebased as typeof stored;
    setDevices(rebased.value);
    setDraftRevision(ticket.revision);
    setBaseValue(cleanSpareParts(ticket.spareParts));
    setStale(false);
    writeTicketDraft(ticket.ticketId, "spares", rebased);
    setRestoreOpen(false);
  }

  async function save() {
    if (!changed || stale) return;
    setSaving(true);
    try {
      await onSave(ticket.ticketId, draftRevision, { "Spare Parts": cleaned });
      clearTicketDraft(ticket.ticketId, "spares");
    } catch {
      // App owns conflict/error feedback and authoritative reloads.
    } finally {
      setSaving(false);
    }
  }

  return <>
    <div className="bounded-edit-tab">
      <div className="edit-tab-scroll">
        <div className="tab-content spare-parts-tab">
          <div className="source-contract">
            <strong>{ticket.readOnly ? `SR ${ticket.ticketId} is finalized.` : "Zeus stores the authoritative Spare Parts record."}</strong>
            <span>{ticket.readOnly ? "Its devices and parts remain assigned to this SR through the validated Closed.xlsx archive." : "Record the damaged device and its faulty serial evidence first. Each requested BOM can then cover one or several newline-separated slots."}</span>
          </div>
          {stale && <div className="inline-warning">The database Spare Parts record changed after this draft began. Restore the protected record over the latest value for review, or discard it. Restoring does not save.</div>}
          {!devices.length && (
            <div className="empty-spares">
              <strong>This ticket has no spare-parts record.</strong>
              <span>Affected devices are shared with Work Fields; add a BOM only when replacement hardware is required.</span>
            </div>
          )}
          <div className="spare-device-list">
            {devices.map((device, deviceIndex) => {
              const submitted = device.parts.filter((part) => part.submitted);
              const editable = device.parts.filter((part) => !part.submitted);
              const removalBlocked = device.parts.length > 0 || device.active_request_ids.length > 0;
              return <article className="spare-device" key={`device-${device.device_number}`}>
                <header>
                  <strong>Affected device {deviceIndex + 1}</strong>
                  {!ticket.readOnly && <button type="button" className="text-button danger-text" disabled={removalBlocked} title={removalBlocked ? "Delete this device's part records first. An Active Request must be deleted or completed before removing its device." : "Remove this device from Spare Parts and Work Fields"} onClick={() => setDeleteConfirmation({ kind: "device", deviceNumber: device.device_number })}>Remove device</button>}
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
                  <label className="form-field full faulty-serials-field">
                    <span>Faulty serial numbers · one per line</span>
                    <textarea aria-label={`Device ${deviceIndex + 1} faulty serial numbers`} value={device.faulty_sns} disabled={ticket.readOnly} onChange={(event) => updateDevice(deviceIndex, "faulty_sns", event.target.value)} placeholder={"CPU-SN-001\nMEMORY-SN-002\nMEZZ-SN-003"} />
                    <small>Diagnostic evidence for this device; these serials do not multiply the requested BOM.</small>
                  </label>
                </div>
                {submitted.length > 0 && <section className="submitted-parts-group">
                  <header><strong>Submitted parts</strong><span>Delete allowed · editing locked</span></header>
                  <div className="part-list">{submitted.map((part) => <SparePartEditor key={part.part_number} deviceIndex={deviceIndex} part={part} readOnly={ticket.readOnly} onUpdate={(field, value) => updatePart(deviceIndex, part.part_number, field, value)} onRemove={() => setDeleteConfirmation({ kind: "part", deviceNumber: device.device_number, partNumber: part.part_number })} />)}</div>
                </section>}
                <section className="new-parts-group">
                  <header><strong>New eligible parts</strong><span>{editable.length} unsent BOM record(s)</span></header>
                  <div className="part-list">{editable.map((part) => <SparePartEditor key={part.part_number} deviceIndex={deviceIndex} part={part} readOnly={ticket.readOnly} onUpdate={(field, value) => updatePart(deviceIndex, part.part_number, field, value)} onRemove={() => setDeleteConfirmation({ kind: "part", deviceNumber: device.device_number, partNumber: part.part_number })} />)}</div>
                </section>
                {!ticket.readOnly && <button type="button" className="secondary-button add-part" onClick={() => updateDevices((current) => current.map((candidate) => candidate.device_number === device.device_number ? ({ ...candidate, next_part_number: candidate.next_part_number + 1, parts: [...candidate.parts, emptyPart(candidate.next_part_number)] }) : candidate))}>+ Add new spare part</button>}
              </article>;
            })}
          </div>
          {!ticket.readOnly && <button type="button" className="secondary-button add-device" onClick={() => updateDevices((current) => [...current, emptyDevice(nextDeviceNumber(current))])}>+ Add affected device</button>}
        </div>
      </div>
      <div className="inline-actions edit-actions">
        <span>{ticket.readOnly ? `${cleaned.length} device(s), ${partCount} BOM group(s), ${requestedUnits} unit(s) · closed SR archive` : changed ? `${cleaned.length} device(s), ${partCount} BOM group(s), ${requestedUnits} unit(s) · unsaved draft protected` : `${cleaned.length} device(s), ${partCount} BOM group(s), ${requestedUnits} unit(s)`}</span>
        {!ticket.readOnly && <div className="inline-actions">{changed && <button type="button" className="text-button danger-text" disabled={saving} onClick={() => setDeleteConfirmation({ kind: "discard" })}>Discard draft</button>}{stale && <button type="button" className="secondary-button" disabled={saving} onClick={() => setRestoreOpen(true)}>Restore changes</button>}{onRegisterSpareRequest && <button type="button" className="create-button" disabled={!eligiblePartCount || changed} title={changed ? "Save Spare Parts before creating the request" : eligiblePartCount ? "Open request creation, where you can Create or Export" : "Add a new unsent BOM/slot record first"} onClick={() => onRegisterSpareRequest(ticket.ticketId)}>Create Request</button>}<button type="button" className="primary-button" disabled={!changed || saving || stale} onClick={save}>{saving ? "Saving…" : "Save to Zeus"}</button></div>}
      </div>
    </div>
    {restoreOpen && <ConfirmationDialog title={`Restore protected SR ${ticket.ticketId} Spare Parts?`} message="The protected device, serial, slot, BOM, and notes changes will be reapplied over the latest Zeus record for review. This action does not save to the database." confirmLabel="Restore for review" onCancel={() => setRestoreOpen(false)} onConfirm={restoreDraft} />}
    {deleteConfirmation?.kind === "discard" && <ConfirmationDialog title={`Discard SR ${ticket.ticketId} Spare Parts draft?`} message="This removes the protected device, serial, slot, BOM, and notes changes from this browser. Zeus database values remain unchanged." confirmLabel="Discard draft" tone="danger" onCancel={() => setDeleteConfirmation(null)} onConfirm={() => { discardDraft(); setDeleteConfirmation(null); }} />}
    {deleteConfirmation?.kind === "device" && <ConfirmationDialog title="Remove affected device?" message="This removes the device and its data from the protected Spare Parts draft. The database changes only after Save to Zeus." confirmLabel="Remove device" tone="danger" onCancel={() => setDeleteConfirmation(null)} onConfirm={() => { const deviceNumber = deleteConfirmation.deviceNumber; updateDevices((current) => current.filter((candidate) => candidate.device_number !== deviceNumber)); setDeleteConfirmation(null); }} />}
    {deleteConfirmation?.kind === "part" && <ConfirmationDialog title="Remove spare-part record?" message="This removes the part, slot, BOM, serial linkage, and notes in this box from the protected draft. The database changes only after Save to Zeus." confirmLabel="Remove part" tone="danger" onCancel={() => setDeleteConfirmation(null)} onConfirm={() => { const { deviceNumber, partNumber } = deleteConfirmation; updateDevices((current) => current.map((candidate) => candidate.device_number !== deviceNumber ? candidate : ({ ...candidate, parts: candidate.parts.filter((entry) => entry.part_number !== partNumber) }))); setDeleteConfirmation(null); }} />}
  </>;
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

export function TicketDetail({ ticket, loading, initialTab = "overview", templates, onClose, onSave, onConfirmMaintenanceWindow, onOpenUpcoming, onGenerateMop, onRegisterSpareRequest, showHistory = false }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const tabOrder = useMemo<Tab[]>(
    () => showHistory
      ? ["overview", "work", "spares", "emails", "mops", "history"]
      : ["overview", "work", "spares", "emails", "mops"],
    [showHistory],
  );
  useEffect(() => setTab(initialTab === "history" && !showHistory ? "overview" : initialTab), [initialTab, showHistory]);
  useEffect(() => {
    if (!showHistory && tab === "history") setTab("overview");
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
      let nextTab: Tab | null = null;
      setTab((current) => {
        const index = tabOrder.indexOf(current);
        nextTab = tabOrder[Math.max(0, Math.min(tabOrder.length - 1, index + delta))];
        return nextTab;
      });
      window.requestAnimationFrame(() => {
        if (nextTab) tabRefs.current.get(nextTab)?.focus({ preventScroll: true });
      });
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabOrder]);
  if (loading && !ticket) return <aside className="detail-panel"><div className="detail-loading">Reading ticket…</div></aside>;
  if (!ticket) return null;
  const tabs: Array<[Tab, string, number | null]> = [
    ["overview", "Overview", null],
    ["work", "Work fields", null],
    ["spares", "Spare Parts", ticket.spareParts.reduce((total, device) => total + device.parts.length, 0)],
    ["emails", "Emails", ticket.emailCount],
    ["mops", "MOPs", ticket.mops.length],
    ...(showHistory ? [["history", "History", ticket.history.length] as [Tab, string, number]] : []),
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
          <button type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)} key={key} ref={(element) => { if (element) tabRefs.current.set(key, element); else tabRefs.current.delete(key); }}>
            {label}{count !== null && <small>{count}</small>}
          </button>
        ))}
      </nav>
      <div className={`detail-scroll${tab === "emails" ? " email-detail-scroll" : ""}${tab === "work" || tab === "spares" ? " bounded-edit-scroll" : ""}`}>
        {tab === "overview" && (
          <div className="tab-content">
            <div className="fact-grid">
              <div><span>Lifecycle</span><strong>{ticket.lifecycle}</strong></div>
              <div><span>Maintenance Window</span><strong>{ticket.maintenanceWindow?.display || maintenanceWindowLabel(ticket.done)}</strong></div>
              <div><span>Ticket age</span><strong>{ticket.ticketAgeDays ?? "—"} days</strong></div>
              <div><span>Resolve by</span><strong>{ticket.resolveBy}</strong></div>
              <div><span>Email inactivity</span><strong>{ticket.emailLabel}</strong></div>
            </div>
            <div className="section-heading"><strong>Advanced Search fields</strong><span>read-only</span></div>
            <FieldList fields={ticket.upstreamFields} />
          </div>
        )}
        {tab === "work" && <WorkTab ticket={ticket} onSave={onSave} onConfirmMaintenanceWindow={onConfirmMaintenanceWindow} onOpenUpcoming={onOpenUpcoming} />}
        {tab === "spares" && <SparePartsTab ticket={ticket} onSave={onSave} onRegisterSpareRequest={onRegisterSpareRequest} />}
        {tab === "emails" && <EmailsTab messages={ticket.email.messages} />}
        {tab === "mops" && <MopsTab ticket={ticket} templates={templates} onGenerateMop={onGenerateMop} />}
        {showHistory && tab === "history" && (
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
