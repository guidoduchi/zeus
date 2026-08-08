import { useEffect, useMemo, useState } from "react";
import {
  getGlobalReferenceData,
  getUserProfile,
  importCustomerFromTicket,
  saveGlobalReferenceData,
  saveUserProfile,
} from "../api";
import type {
  CustomerContact,
  CustomerOrganization,
  GlobalReferenceData,
  ManagedSite,
  RequesterProfile,
  UserProfile,
} from "../types";
import { Modal } from "./Modal";
import { EMPTY_USER_PROFILE, ProfileFields } from "./ProfileSetup";

type CollectionKey = "organizations" | "customers" | "sites" | "requesters";
type Tab = "profile" | CollectionKey;

interface Props {
  onClose: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
}

const EMPTY_DATA: GlobalReferenceData = {
  schemaVersion: 2,
  organizations: [],
  customers: [],
  sites: [],
  requesters: [],
};

function newId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replaceAll("-", "")
    : `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function labelFor(tab: CollectionKey, row: Record<string, unknown>): string {
  if (tab === "sites") return String(row.code || row.name || "New site");
  return String(row.name || "New record");
}

export function GlobalDataModal({ onClose, onSaved, onError }: Props) {
  const [active, setActive] = useState<Tab>("profile");
  const [data, setData] = useState<GlobalReferenceData>(EMPTY_DATA);
  const [profile, setProfile] = useState<UserProfile>(EMPTY_USER_PROFILE);
  const [selected, setSelected] = useState<Record<CollectionKey, string | null>>({
    organizations: null,
    customers: null,
    sites: null,
    requesters: null,
  });
  const [importTt, setImportTt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([getGlobalReferenceData(), getUserProfile()])
      .then(([references, user]) => {
        setData(references);
        setProfile(user.profile || EMPTY_USER_PROFILE);
      })
      .catch(onError)
      .finally(() => setLoading(false));
  }, [onError]);

  const activeRows = active === "profile" ? [] : data[active];
  const activeId = active === "profile" ? null : selected[active];
  const activeRow = active === "profile"
    ? null
    : activeRows.find((row) => row.id === activeId) || null;
  const counts = useMemo(() => ({
    organizations: data.organizations.length,
    customers: data.customers.length,
    sites: data.sites.length,
    requesters: data.requesters.length,
  }), [data]);

  function updateCollection<K extends CollectionKey>(key: K, rows: GlobalReferenceData[K]) {
    setData((current) => ({ ...current, [key]: rows }));
  }

  function addRow(key: CollectionKey) {
    let row: CustomerOrganization | CustomerContact | ManagedSite | RequesterProfile;
    if (key === "organizations") row = { id: newId("org"), name: "" };
    else if (key === "customers") row = { id: newId("customer"), organizationId: data.organizations[0]?.id || "", name: "", email: null, phone: null };
    else if (key === "sites") row = { id: newId("site"), code: "", name: null, address: "", cloud: null };
    else row = { id: newId("requester"), name: "", email: "", phone: "", username: null, pinned: false };
    updateCollection(key, [...data[key], row] as never);
    setSelected((current) => ({ ...current, [key]: row.id }));
  }

  function updateRow(key: CollectionKey, id: string, changes: Record<string, unknown>) {
    updateCollection(
      key,
      data[key].map((row) => row.id === id ? { ...row, ...changes } : row) as never,
    );
  }

  function removeRow(key: CollectionKey, id: string) {
    if (key === "organizations" && data.customers.some((customer) => customer.organizationId === id)) {
      onError(new Error("Move or delete that organization's customer contacts first."));
      return;
    }
    if (!window.confirm(`Delete this ${key === "customers" ? "customer contact" : key.slice(0, -1)}?`)) return;
    updateCollection(key, data[key].filter((row) => row.id !== id) as never);
    setSelected((current) => ({ ...current, [key]: null }));
  }

  async function importCustomer() {
    if (!/^\d{8}$/.test(importTt)) return;
    try {
      const result = await importCustomerFromTicket(importTt);
      setData(result.data);
      setSelected((current) => ({ ...current, customers: result.customerId }));
      setActive("customers");
      setImportTt("");
    } catch (error) {
      onError(error);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await saveUserProfile(profile);
      const saved = await saveGlobalReferenceData(data);
      setData(saved);
      onSaved();
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  function editor() {
    if (active === "profile") {
      return <ProfileFields value={profile} onChange={setProfile} onError={onError} />;
    }
    if (!activeRow) {
      return <div className="manager-empty"><strong>No record selected</strong><span>Choose a record or add a new one.</span></div>;
    }
    if (active === "organizations") {
      const row = activeRow as CustomerOrganization;
      return <div className="form-grid two"><label className="form-field full"><span>Customer organization *</span><input value={row.name} onChange={(event) => updateRow(active, row.id, { name: event.target.value })} placeholder="Consorcio Ecuatoriano de Telecomunicaciones" /></label></div>;
    }
    if (active === "customers") {
      const row = activeRow as CustomerContact;
      return <div className="form-grid two">
        <label className="form-field full"><span>Customer organization *</span><select value={row.organizationId} onChange={(event) => updateRow(active, row.id, { organizationId: event.target.value })}><option value="">Choose organization…</option>{data.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
        <label className="form-field full"><span>Customer name *</span><input value={row.name} onChange={(event) => updateRow(active, row.id, { name: event.target.value })} /></label>
        <label className="form-field"><span>Email</span><input type="email" value={row.email || ""} onChange={(event) => updateRow(active, row.id, { email: event.target.value })} /></label>
        <label className="form-field"><span>Phone</span><input type="tel" value={row.phone || ""} onChange={(event) => updateRow(active, row.id, { phone: event.target.value })} /></label>
      </div>;
    }
    if (active === "sites") {
      const row = activeRow as ManagedSite;
      return <div className="form-grid two">
        <label className="form-field"><span>Site code *</span><input value={row.code} onChange={(event) => updateRow(active, row.id, { code: event.target.value.toUpperCase() })} placeholder="GYE" /></label>
        <label className="form-field"><span>Site name</span><input value={row.name || ""} onChange={(event) => updateRow(active, row.id, { name: event.target.value })} /></label>
        <label className="form-field full"><span>Address *</span><textarea value={row.address} onChange={(event) => updateRow(active, row.id, { address: event.target.value })} /></label>
        <label className="form-field full"><span>Default cloud</span><input value={row.cloud || ""} onChange={(event) => updateRow(active, row.id, { cloud: event.target.value })} /></label>
      </div>;
    }
    const row = activeRow as RequesterProfile;
    return <div className="form-grid two">
      <label className="form-field full"><span>Requester name *</span><input value={row.name} onChange={(event) => updateRow(active, row.id, { name: event.target.value })} /></label>
      <label className="form-field"><span>Email *</span><input type="email" value={row.email} onChange={(event) => updateRow(active, row.id, { email: event.target.value })} /></label>
      <label className="form-field"><span>Phone *</span><input type="tel" value={row.phone} onChange={(event) => updateRow(active, row.id, { phone: event.target.value })} /></label>
      <label className="form-field"><span>Username</span><input value={row.username || ""} onChange={(event) => updateRow(active, row.id, { username: event.target.value })} /></label>
      <label className="check-field"><input type="checkbox" checked={row.pinned} onChange={(event) => updateRow(active, row.id, { pinned: event.target.checked })} /><span>Pin as favorite requester</span></label>
    </div>;
  }

  return (
    <Modal
      title="Global data"
      subtitle="Your profile, customer organizations, customer contacts, sites, and requesters are available throughout Zeus and stay on this workstation."
      onClose={onClose}
      wide
      actions={<><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={loading || saving} onClick={save}>{saving ? "Saving…" : "Save global data"}</button></>}
    >
      {loading ? <div className="detail-loading">Reading local global data…</div> : <div className="manager-layout global-manager-layout">
        <nav aria-label="Global data collection">
          <button type="button" className={active === "profile" ? "active" : ""} onClick={() => setActive("profile")}>My profile <small>1</small></button>
          {(["organizations", "customers", "sites", "requesters"] as CollectionKey[]).map((key) => <button type="button" className={active === key ? "active" : ""} onClick={() => setActive(key)} key={key}>{({ organizations: "Customer orgs", customers: "Customer contacts", sites: "Sites", requesters: "Requesters" })[key]} <small>{counts[key]}</small></button>)}
        </nav>
        <section className="manager-workspace">
          {active === "customers" && <div className="manager-import"><input inputMode="numeric" maxLength={8} value={importTt} onChange={(event) => setImportTt(event.target.value.replace(/\D/g, ""))} placeholder="TT · 8 digits" /><button type="button" className="secondary-button" disabled={!/^\d{8}$/.test(importTt)} onClick={() => void importCustomer()}>Import customer from SR</button></div>}
          {active !== "profile" && <div className="manager-records">
            <div className="manager-list"><button type="button" className="primary-button" onClick={() => addRow(active)}>+ Add</button>{activeRows.map((row) => <button type="button" className={row.id === activeId ? "selected" : ""} onClick={() => setSelected((current) => ({ ...current, [active]: row.id }))} key={row.id}><span>{labelFor(active, row as unknown as Record<string, unknown>)}</span>{active === "requesters" && Boolean((row as RequesterProfile).pinned) && <em>★</em>}</button>)}</div>
            <div className="manager-form"><header><strong>{activeRow ? labelFor(active, activeRow as unknown as Record<string, unknown>) : "Editor"}</strong>{activeRow && <button type="button" className="text-button danger-text" onClick={() => removeRow(active, activeRow.id)}>Delete</button>}</header>{editor()}</div>
          </div>}
          {active === "profile" && editor()}
        </section>
      </div>}
    </Modal>
  );
}
