import { useEffect, useMemo, useState } from "react";
import {
  getDashboard,
  getGlobalReferenceData,
  getSpareRequestPrefill,
  getUserProfile,
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
import { ConfirmationDialog } from "./ConfirmationDialog";
import { Modal } from "./Modal";
import { EMPTY_USER_PROFILE, ProfileFields } from "./ProfileSetup";

type CollectionKey = "organizations" | "customers" | "sites" | "requesters";
type Tab = "profile" | CollectionKey;
type PendingConfirmation =
  | { kind: "discard" }
  | { kind: "delete"; key: CollectionKey; id: string; label: string };

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

const MANAGER_DESCRIPTIONS: Record<Tab, { title: string; body: string }> = {
  profile: {
    title: "Your local Zeus identity.",
    body: "Name, email, and phone are required. This profile is also the default requester for every Spare Request.",
  },
  organizations: {
    title: "Customer organizations group customer contacts.",
    body: "Every customer contact belongs to one organization, which Zeus uses when preparing Spare Request records and exports.",
  },
  customers: {
    title: "Customer contacts receive and coordinate spare-part requests.",
    body: "Choose an existing SR to autocomplete its contact and organization, or maintain the contact manually.",
  },
  sites: {
    title: "Sites identify spare-part dispatch and return locations.",
    body: "The site code, address, and default cloud autocomplete Spare Request exports while remaining independent from customer organizations.",
  },
  requesters: {
    title: "Requesters are the people who submit Spare Requests.",
    body: "Your profile is always the default requester. Add other people here and pin frequent requesters so they appear first.",
  },
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
  const [savedData, setSavedData] = useState<GlobalReferenceData>(EMPTY_DATA);
  const [savedProfile, setSavedProfile] = useState<UserProfile>(EMPTY_USER_PROFILE);
  const [selected, setSelected] = useState<Record<CollectionKey, string | null>>({
    organizations: null,
    customers: null,
    sites: null,
    requesters: null,
  });
  const [importTt, setImportTt] = useState("");
  const [ticketSuggestions, setTicketSuggestions] = useState<Array<{ ticketId: string; summary: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    Promise.all([getGlobalReferenceData(), getUserProfile()])
      .then(([references, user]) => {
        setData(references);
        setSavedData(references);
        const nextProfile = user.profile || EMPTY_USER_PROFILE;
        setProfile(nextProfile);
        setSavedProfile(nextProfile);
        setSelected((current) => ({ ...current, requesters: "__current_user__" }));
      })
      .catch(onError)
      .finally(() => setLoading(false));
  }, [onError]);

  useEffect(() => {
    if (active !== "customers") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getDashboard("service-requests", "sr", "desc", importTt, "active")
        .then((result) => {
          if (!cancelled && result.workspace === "service-requests") {
            setTicketSuggestions(result.tickets.slice(0, 30).map((ticket) => ({
              ticketId: ticket.ticketId,
              summary: ticket.summary,
            })));
          }
        })
        .catch((error) => { if (!cancelled) onError(error); });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, importTt, onError]);

  const currentRequester = useMemo<RequesterProfile | null>(() => {
    if (!profile.name || !profile.email || !profile.phone) return null;
    return {
      id: "__current_user__",
      name: profile.name,
      email: profile.email,
      phone: profile.phone,
      username: profile.username,
      pinned: true,
      currentUser: true,
    };
  }, [profile]);

  const activeRows = active === "profile"
    ? []
    : active === "requesters" && currentRequester
      ? [currentRequester, ...data.requesters]
      : data[active];
  const activeId = active === "profile" ? null : selected[active];
  const activeRow = active === "profile"
    ? null
    : activeRows.find((row) => row.id === activeId) || null;
  const counts = useMemo(() => ({
    organizations: data.organizations.length,
    customers: data.customers.length,
    sites: data.sites.length,
    requesters: data.requesters.length + (currentRequester ? 1 : 0),
  }), [currentRequester, data]);
  const dirty = useMemo(
    () => JSON.stringify(data) !== JSON.stringify(savedData)
      || JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [data, profile, savedData, savedProfile],
  );

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

  function chooseTab(tab: Tab) {
    setActive(tab);
    if (tab === "profile" || selected[tab]) return;
    const rows = tab === "requesters" && currentRequester
      ? [currentRequester, ...data.requesters]
      : data[tab];
    if (rows[0]) setSelected((current) => ({ ...current, [tab]: rows[0].id }));
  }

  function updateRow(key: CollectionKey, id: string, changes: Record<string, unknown>) {
    if (id === "__current_user__") return;
    updateCollection(
      key,
      data[key].map((row) => row.id === id ? { ...row, ...changes } : row) as never,
    );
  }

  function removeRow(key: CollectionKey, id: string) {
    if (id === "__current_user__") return;
    if (key === "organizations" && data.customers.some((customer) => customer.organizationId === id)) {
      onError(new Error("Move or delete that organization's customer contacts first."));
      return;
    }
    const row = data[key].find((candidate) => candidate.id === id);
    setConfirmation({
      kind: "delete",
      key,
      id,
      label: labelFor(key, (row || {}) as unknown as Record<string, unknown>),
    });
  }

  async function importCustomer() {
    if (!/^\d{8}$/.test(importTt)) return;
    try {
      const result = await getSpareRequestPrefill(importTt);
      const importedProfile = result.profile || {};
      const contact = importedProfile.contact && typeof importedProfile.contact === "object"
        ? importedProfile.contact as Record<string, unknown>
        : {};
      const organizationName = String(importedProfile.customerOrganization || "").trim();
      const contactName = String(contact.name || importedProfile.customerName || "").trim();
      if (!organizationName || !contactName) {
        throw new Error(`SR ${importTt} does not contain both a customer organization and customer contact.`);
      }
      const existingOrganization = data.organizations.find((row) => row.name.trim().toLocaleLowerCase() === organizationName.toLocaleLowerCase());
      const organization = existingOrganization || { id: newId("org"), name: organizationName };
      const existingCustomer = data.customers.find((row) => row.organizationId === organization.id && row.name.trim().toLocaleLowerCase() === contactName.toLocaleLowerCase());
      const customer: CustomerContact = existingCustomer
        ? {
          ...existingCustomer,
          email: String(contact.email || existingCustomer.email || "").trim() || null,
          phone: String(contact.phone || existingCustomer.phone || "").trim() || null,
        }
        : {
          id: newId("customer"),
          organizationId: organization.id,
          name: contactName,
          email: String(contact.email || "").trim() || null,
          phone: String(contact.phone || "").trim() || null,
        };
      setData((current) => ({
        ...current,
        organizations: existingOrganization ? current.organizations : [...current.organizations, organization],
        customers: existingCustomer
          ? current.customers.map((row) => row.id === customer.id ? customer : row)
          : [...current.customers, customer],
      }));
      setSelected((current) => ({ ...current, customers: customer.id }));
      setActive("customers");
      setImportTt("");
    } catch (error) {
      onError(error);
    }
  }

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      const savedUser = await saveUserProfile(profile);
      const saved = await saveGlobalReferenceData(data);
      setData(saved);
      setSavedData(saved);
      const nextProfile = savedUser.profile || profile;
      setProfile(nextProfile);
      setSavedProfile(nextProfile);
      onSaved();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty) {
      setConfirmation({ kind: "discard" });
      return;
    }
    onClose();
  }

  function confirmPending() {
    if (!confirmation) return;
    if (confirmation.kind === "discard") {
      setConfirmation(null);
      onClose();
      return;
    }
    updateCollection(
      confirmation.key,
      data[confirmation.key].filter((row) => row.id !== confirmation.id) as never,
    );
    setSelected((current) => ({ ...current, [confirmation.key]: null }));
    setConfirmation(null);
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
    if (row.currentUser) {
      return <div className="current-requester-card">
        <div className="source-contract"><strong>Default requester from My profile.</strong><span>This derived requester is always available and pinned first. Edit its details in My profile.</span></div>
        <div className="form-grid two">
          <label className="form-field full"><span>Requester name</span><input value={row.name} disabled /></label>
          <label className="form-field"><span>Email</span><input value={row.email} disabled /></label>
          <label className="form-field"><span>Phone</span><input value={row.phone} disabled /></label>
          <label className="form-field"><span>Username</span><input value={row.username || ""} disabled /></label>
        </div>
        <button type="button" className="secondary-button" onClick={() => setActive("profile")}>Edit My profile</button>
      </div>;
    }
    return <div className="form-grid two">
      <label className="form-field full"><span>Requester name *</span><input value={row.name} onChange={(event) => updateRow(active, row.id, { name: event.target.value })} /></label>
      <label className="form-field"><span>Email *</span><input type="email" value={row.email} onChange={(event) => updateRow(active, row.id, { email: event.target.value })} /></label>
      <label className="form-field"><span>Phone *</span><input type="tel" value={row.phone} onChange={(event) => updateRow(active, row.id, { phone: event.target.value })} /></label>
      <label className="form-field"><span>Username</span><input value={row.username || ""} onChange={(event) => updateRow(active, row.id, { username: event.target.value })} /></label>
      <label className="check-field"><input type="checkbox" checked={row.pinned} onChange={(event) => updateRow(active, row.id, { pinned: event.target.checked })} /><span>Pin as favorite requester</span></label>
    </div>;
  }

  const categoryLabels: Record<Tab, string> = {
    profile: "My profile",
    organizations: "Customer organizations",
    customers: "Customer contacts",
    sites: "Sites",
    requesters: "Requesters",
  };
  const categoryCounts: Record<Tab, number> = {
    profile: 1,
    ...counts,
  };

  return <>
    <Modal
      title="Global data"
      subtitle="Your profile, customer organizations, customer contacts, sites, and requesters are available throughout Zeus and stay on this workstation."
      onClose={onClose}
      dismissible={!dirty}
      wide
      actions={<><span>{dirty ? "Unsaved Global data changes are protected" : "All Global data is saved"}</span><button type="button" className="secondary-button" disabled={saving} onClick={cancel}>{dirty ? "Cancel changes" : "Close"}</button><button type="button" className="primary-button" disabled={loading || saving || !dirty} onClick={save}>{saving ? "Saving…" : "Save global data"}</button></>}
    >
      {loading ? <div className="detail-loading">Reading local global data…</div> : <div className="global-data-workspace">
        <nav className="operations-grid global-category-grid" aria-label="Global data collection">
          {(["profile", "organizations", "customers", "sites", "requesters"] as Tab[]).map((tab) => (
            <button type="button" aria-label={categoryLabels[tab]} className={active === tab ? "active" : ""} onClick={() => chooseTab(tab)} key={tab}>
              <strong>{categoryLabels[tab]}</strong>
              <span>{MANAGER_DESCRIPTIONS[tab].body}</span>
              <small>{categoryCounts[tab]} {categoryCounts[tab] === 1 ? "record" : "records"}</small>
            </button>
          ))}
        </nav>
        <section className="manager-workspace">
          <div className="source-contract manager-description"><strong>{MANAGER_DESCRIPTIONS[active].title}</strong><span>{MANAGER_DESCRIPTIONS[active].body}</span></div>
          {active === "customers" && <div className="manager-import"><input list="zeus-global-sr-options" inputMode="numeric" maxLength={8} value={importTt} onChange={(event) => setImportTt(event.target.value.replace(/\D/g, ""))} placeholder="Search or choose an SR" aria-label="Service Request to import" /><datalist id="zeus-global-sr-options">{ticketSuggestions.map((ticket) => <option value={ticket.ticketId} label={ticket.summary} key={ticket.ticketId} />)}</datalist><button type="button" className="secondary-button" disabled={!/^\d{8}$/.test(importTt)} onClick={() => void importCustomer()}>Import customer from SR</button></div>}
          {active !== "profile" && <div className="manager-records">
            <div className="manager-list"><button type="button" className="primary-button" onClick={() => addRow(active)}>+ Add {({ organizations: "organization", customers: "contact", sites: "site", requesters: "requester" })[active]}</button>{activeRows.map((row) => <button type="button" className={row.id === activeId ? "selected" : ""} onClick={() => setSelected((current) => ({ ...current, [active]: row.id }))} key={row.id}><span>{labelFor(active, row as unknown as Record<string, unknown>)}</span>{active === "requesters" && Boolean((row as RequesterProfile).pinned) && <em>★</em>}</button>)}</div>
            <div className="manager-form"><header><strong>{activeRow ? labelFor(active, activeRow as unknown as Record<string, unknown>) : "Editor"}</strong>{activeRow && activeRow.id !== "__current_user__" && <button type="button" className="text-button danger-text" onClick={() => removeRow(active, activeRow.id)}>Delete</button>}</header>{editor()}</div>
          </div>}
          {active === "profile" && editor()}
        </section>
      </div>}
    </Modal>
    {confirmation && <ConfirmationDialog
      title={confirmation.kind === "discard" ? "Discard unsaved Global data?" : `Delete ${confirmation.label}?`}
      message={confirmation.kind === "discard" ? "Every Global data change made since the last save will be discarded. Your last saved local data will remain unchanged." : "This record will be removed from the current unsaved edit set. Save Global data afterward to commit the deletion."}
      confirmLabel={confirmation.kind === "discard" ? "Discard changes" : "Delete record"}
      tone="danger"
      onCancel={() => setConfirmation(null)}
      onConfirm={confirmPending}
    />}
  </>;
}
