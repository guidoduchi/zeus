import { useEffect, useMemo, useState } from "react";
import {
  browsePath,
  getDatabaseMaintenance,
  getSettings,
  migrateDataDirectory,
  openPath,
  runDatabaseMaintenance,
  saveSettings,
} from "../api";
import type { DatabaseMaintenanceStatus, Setting, SettingsPayload } from "../types";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";

interface Props {
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

function editValue(value: unknown): string | boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.join(", ");
  return value === null || value === undefined ? "" : String(value);
}

function choiceLabel(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function SettingControl({
  setting,
  value,
  onChange,
  onBrowse,
  onOpen,
}: {
  setting: Setting;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  onBrowse: () => void;
  onOpen: () => void;
}) {
  const path = setting.kind === "directory" || setting.kind === "data_directory" || setting.kind === "outlook_store" || setting.kind === "xlsx_template";
  return (
    <div className={`setting-row ${!setting.editable ? "fixed" : ""}`}>
      <div className="setting-copy">
        <label htmlFor={`setting-${setting.key}`}>{setting.label}</label>
        <p>{setting.description}</p>
        {setting.status?.message && <small className={setting.status.exists === false ? "status-bad" : "status-good"}>{setting.status.message}</small>}
      </div>
      <div className="setting-control">
        {setting.kind === "boolean" ? (
          <label className="switch">
            <input id={`setting-${setting.key}`} type="checkbox" checked={Boolean(value)} disabled={!setting.editable} onChange={(event) => onChange(event.target.checked)} />
            <span />
            <em>{value ? "Enabled" : "Disabled"}</em>
          </label>
        ) : setting.kind === "choice" ? (
          <select id={`setting-${setting.key}`} value={String(value)} disabled={!setting.editable} onChange={(event) => onChange(event.target.value)}>
            {setting.choices.map((choice) => <option value={choice} key={choice}>{choiceLabel(choice)}</option>)}
          </select>
        ) : setting.kind === "locked" ? (
          <input id={`setting-${setting.key}`} value={String(value)} disabled />
        ) : (
          <div className={path ? "path-control" : ""}>
            <input
              id={`setting-${setting.key}`}
              type={setting.kind === "integer" ? "number" : "text"}
              min={setting.minimum ?? undefined}
              value={String(value)}
              disabled={!setting.editable}
              onChange={(event) => onChange(event.target.value)}
              placeholder={setting.nullable ? "Not configured" : undefined}
            />
            {path && <button type="button" onClick={onBrowse}>{setting.kind === "data_directory" ? "Move data…" : "Browse…"}</button>}
            {path && setting.status?.path && <button type="button" className="icon-button" onClick={onOpen} title="Open folder" aria-label={`Open ${setting.label}`}>↗</button>}
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsModal({ onClose, onSaved, onError }: Props) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<DatabaseMaintenanceStatus | null>(null);
  const [checkingDatabase, setCheckingDatabase] = useState(false);
  const [maintainingDatabase, setMaintainingDatabase] = useState(false);
  const [maintenanceConfirmation, setMaintenanceConfirmation] = useState(false);

  useEffect(() => {
    getSettings().then((result) => {
      setPayload(result);
      setDraft(Object.fromEntries(result.settings.map((setting) => [setting.key, editValue(setting.value)])));
    }).catch(onError);
    getDatabaseMaintenance().then(setMaintenance).catch(onError);
  }, [onError]);

  const categories = useMemo(() => {
    const result = new Map<string, Setting[]>();
    for (const setting of payload?.settings || []) {
      const items = result.get(setting.category) || [];
      items.push(setting);
      result.set(setting.category, items);
    }
    return [...result.entries()];
  }, [payload]);

  const updates = useMemo(() => Object.fromEntries(
    (payload?.settings || [])
      .filter((setting) => setting.editable && editValue(setting.value) !== draft[setting.key])
      .map((setting) => [setting.key, draft[setting.key]]),
  ), [draft, payload]);
  const changedCount = Object.keys(updates).length;

  async function save() {
    if (!changedCount) return;
    setSaving(true);
    try {
      const result = await saveSettings(updates);
      setPayload(result);
      setDraft(Object.fromEntries(result.settings.map((setting) => [setting.key, editValue(setting.value)])));
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function browse(setting: Setting) {
    try {
      const result = await browsePath(setting.key);
      if (result.cancelled || !result.path) return;
      if (setting.kind === "data_directory") {
        setMigrationTarget(result.path);
        return;
      }
      setDraft((current) => ({ ...current, [setting.key]: result.path! }));
    } catch (error) {
      setMigrating(false);
      onError(error);
    }
  }

  async function confirmMigration() {
    if (!migrationTarget) return;
    setMigrating(true);
    try {
      await migrateDataDirectory(migrationTarget);
      setMigrationTarget(null);
      window.setTimeout(() => window.location.reload(), 2500);
    } catch (error) {
      setMigrating(false);
      onError(error);
    }
  }

  async function checkDatabase() {
    setCheckingDatabase(true);
    try {
      setMaintenance(await getDatabaseMaintenance());
    } catch (error) {
      onError(error);
    } finally {
      setCheckingDatabase(false);
    }
  }

  async function confirmDatabaseMaintenance() {
    setMaintainingDatabase(true);
    try {
      const result = await runDatabaseMaintenance();
      setMaintenance(result);
      setMaintenanceConfirmation(false);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setMaintainingDatabase(false);
    }
  }

  const maintenanceLabel = maintenance?.status === "current"
    ? "Database is current"
    : maintenance?.status === "upgrade_available"
      ? "Upgrade available"
      : maintenance?.status === "repair_available"
        ? "Markdown repair available"
        : maintenance?.status === "blocked"
          ? "Manual recovery required"
          : maintenance?.status === "busy"
            ? "Check paused during another operation"
            : "Not checked";
  const maintenanceActionLabel = maintenance?.status === "upgrade_available"
    ? "Upgrade & repair"
    : maintenance?.status === "repair_available"
      ? "Repair Markdown"
      : maintenance?.status === "blocked"
        ? "Repair blocked"
        : "No repair needed";

  return <>
    <Modal
      title="Zeus configuration"
      subtitle="Validated controls replace direct JSON editing. Path dialogs open on this Windows computer."
      onClose={onClose}
      wide
      actions={<>
        <span>{changedCount ? `${changedCount} unsaved setting(s)` : "Configuration is current"}</span>
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" className="primary-button" disabled={!changedCount || saving || migrating} onClick={save}>{saving ? "Saving…" : "Save configuration"}</button>
      </>}
    >
      {!payload ? <div className="detail-loading">Reading configuration…</div> : (
        <div className="settings-groups">
          {categories.map(([category, settings]) => (
            <section className="settings-group" key={category}>
              <h3>{category}</h3>
              {settings.map((setting) => (
                <SettingControl
                  setting={setting}
                  value={draft[setting.key] ?? ""}
                  onChange={(value) => setDraft((current) => ({ ...current, [setting.key]: value }))}
                  onBrowse={() => browse(setting)}
                  onOpen={() => openPath(setting.key).catch(onError)}
                  key={setting.key}
                />
              ))}
            </section>
          ))}
          <section className={`settings-group database-maintenance-group status-${maintenance?.status || "unknown"}`}>
            <h3>Database maintenance</h3>
            <div className="database-maintenance-summary">
              <div>
                <strong>{maintenanceLabel}</strong>
                <span>{maintenance ? `Schema ${maintenance.storedSchemaVersion} → ${maintenance.currentSchemaVersion} · ${maintenance.ticketCount} ticket(s) · ${maintenance.spareRequestCount} Active Request(s)` : "Reading embedded Markdown records…"}</span>
              </div>
              <div className="database-maintenance-counts">
                <span>Upgrade <strong>{maintenance?.outdatedTicketCount || 0}</strong></span>
                <span>Repair <strong>{maintenance?.repairableMarkdownCount || 0}</strong></span>
                <span>Review <strong>{maintenance?.reviewCount || 0}</strong></span>
                <span>Blocked <strong>{maintenance?.blockedCount || 0}</strong></span>
              </div>
              <p>Check is read-only. Upgrade & repair creates a full backup, migrates a staging copy, regenerates readable Markdown from valid embedded records, validates the complete store, and replaces the live database only after every check passes.</p>
              {!!maintenance?.reviewRecords.length && <ul className="database-maintenance-list review-list">{maintenance.reviewRecords.slice(0, 6).map((record, index) => <li key={`${record.ticketId || record.path}-${index}`}><strong>{record.ticketId || record.path}</strong><span>{record.message}</span></li>)}</ul>}
              {!!maintenance?.blockedRecords.length && <ul className="database-maintenance-list blocked-list">{maintenance.blockedRecords.slice(0, 6).map((record, index) => <li key={`${record.path}-${index}`}><strong>{record.path}</strong><span>{record.message}</span></li>)}</ul>}
              {maintenance?.changed && <small className="status-good">Maintenance completed. Backup: {maintenance.backup || "created by the transaction"}.</small>}
              <div className="database-maintenance-actions">
                <button type="button" className="secondary-button" disabled={checkingDatabase || maintainingDatabase} onClick={() => void checkDatabase()}>{checkingDatabase ? "Checking…" : "Check integrity"}</button>
                <button type="button" className={maintenance?.status === "blocked" ? "danger-button" : "primary-button"} disabled={!maintenance?.canApply || maintainingDatabase} onClick={() => setMaintenanceConfirmation(true)}>{maintenanceActionLabel}</button>
              </div>
            </div>
          </section>
          <div className="restart-note">{migrating ? "The verified data clone is complete. Zeus is restarting into its new location…" : "Changing the preferred port takes effect the next time Zeus starts. Moving the data folder always performs its own soft restart."}</div>
        </div>
      )}
    </Modal>
    {migrationTarget && <ConfirmationDialog
      title="Move the Zeus data folder?"
      message={`Zeus will clone and verify every mutable record at ${migrationTarget}, perform a soft restart, and remove the old data folder only after the new location starts successfully.`}
      confirmLabel="Verify and move data"
      busy={migrating}
      onCancel={() => setMigrationTarget(null)}
      onConfirm={() => void confirmMigration()}
    />}
    {maintenanceConfirmation && maintenance && <ConfirmationDialog
      title="Upgrade and repair the Zeus database?"
      message={`Zeus will back up the complete current database, upgrade ${maintenance.outdatedTicketCount} ticket record(s), repair ${maintenance.repairableMarkdownCount} readable Markdown file(s), validate the staged copy, and commit it atomically. Embedded records that cannot be decoded are never guessed.`}
      confirmLabel="Back up, upgrade & repair"
      busy={maintainingDatabase}
      onCancel={() => setMaintenanceConfirmation(false)}
      onConfirm={() => void confirmDatabaseMaintenance()}
    />}
  </>;
}
