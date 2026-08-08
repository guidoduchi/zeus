import { useEffect, useMemo, useState } from "react";
import { browsePath, getSettings, openPath, saveSettings } from "../api";
import type { Setting, SettingsPayload } from "../types";
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
  const path = setting.kind === "directory" || setting.kind === "outlook_store" || setting.kind === "xlsx_template";
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
            {setting.choices.map((choice) => <option value={choice} key={choice}>{choice}</option>)}
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
            {path && <button type="button" onClick={onBrowse}>Browse…</button>}
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

  useEffect(() => {
    getSettings().then((result) => {
      setPayload(result);
      setDraft(Object.fromEntries(result.settings.map((setting) => [setting.key, editValue(setting.value)])));
    }).catch(onError);
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
      if (!result.cancelled && result.path) setDraft((current) => ({ ...current, [setting.key]: result.path! }));
    } catch (error) {
      onError(error);
    }
  }

  return (
    <Modal
      title="Zeus configuration"
      subtitle="Validated controls replace direct JSON editing. Path dialogs open on this Windows computer."
      onClose={onClose}
      wide
      actions={<>
        <span>{changedCount ? `${changedCount} unsaved setting(s)` : "Configuration is current"}</span>
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" className="primary-button" disabled={!changedCount || saving} onClick={save}>{saving ? "Saving…" : "Save configuration"}</button>
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
          <div className="restart-note">Changing the preferred port takes effect the next time Zeus starts. The current server remains safely bound to its existing local port.</div>
        </div>
      )}
    </Modal>
  );
}
