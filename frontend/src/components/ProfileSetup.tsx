import { useMemo, useState } from "react";
import type { UserProfile } from "../types";

export const EMPTY_USER_PROFILE: UserProfile = {
  name: "",
  email: "",
  phone: "",
  username: "",
  photoDataUrl: null,
};

function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Zeus could not read that image."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function compactProfilePicture(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  const source = await fileDataUrl(file);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onerror = () => reject(new Error("That profile picture could not be decoded."));
    element.onload = () => resolve(element);
    element.src = source;
  });
  const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare profile pictures.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.86);
}

export function ProfileFields({
  value,
  onChange,
  onError,
}: {
  value: UserProfile;
  onChange: (value: UserProfile) => void;
  onError: (error: unknown) => void;
}) {
  function update(key: keyof UserProfile, next: string | null) {
    onChange({ ...value, [key]: next });
  }

  async function choosePicture(file: File | undefined) {
    if (!file) return;
    try {
      update("photoDataUrl", await compactProfilePicture(file));
    } catch (error) {
      onError(error);
    }
  }

  return (
    <div className="profile-editor">
      <div className="profile-picture-column">
        <div className="profile-picture" aria-label="Profile picture preview">
          {value.photoDataUrl ? <img src={value.photoDataUrl} alt="Local profile" /> : <span>{value.name.trim().slice(0, 1).toUpperCase() || "ϟ"}</span>}
        </div>
        <label className="secondary-button file-button">
          Choose picture
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void choosePicture(event.target.files?.[0])} />
        </label>
        {value.photoDataUrl && <button type="button" className="text-button danger-text" onClick={() => update("photoDataUrl", null)}>Remove picture</button>}
        <small>Optional · resized locally to fit within 256 px.</small>
      </div>
      <div className="form-grid two profile-fields">
        <label className="form-field full"><span>Name *</span><input autoComplete="name" value={value.name} onChange={(event) => update("name", event.target.value)} /></label>
        <label className="form-field"><span>Email *</span><input type="email" autoComplete="email" value={value.email} onChange={(event) => update("email", event.target.value)} /></label>
        <label className="form-field"><span>Phone number *</span><input type="tel" autoComplete="tel" value={value.phone} onChange={(event) => update("phone", event.target.value)} /></label>
        <label className="form-field full"><span>Username</span><input autoComplete="username" value={value.username || ""} onChange={(event) => update("username", event.target.value)} placeholder="Optional" /></label>
      </div>
    </div>
  );
}

export function ProfileSetup({
  initial,
  error,
  onSave,
  onError,
}: {
  initial?: UserProfile | null;
  error?: string | null;
  onSave: (value: UserProfile) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [value, setValue] = useState<UserProfile>(initial || EMPTY_USER_PROFILE);
  const [saving, setSaving] = useState(false);
  const ready = useMemo(
    () => Boolean(value.name.trim() && value.email.trim() && value.phone.trim()),
    [value],
  );

  async function save() {
    if (!ready) return;
    setSaving(true);
    try {
      await onSave(value);
    } catch (saveError) {
      onError(saveError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="onboarding-screen">
      <section className="onboarding-card" aria-labelledby="profile-setup-title">
        <div className="onboarding-brand"><span>ϟ</span><div><strong>ZEUS 3</strong><small>LOCAL WORKSTATION</small></div></div>
        <div className="onboarding-copy">
          <p className="eyebrow">FIRST-RUN SETUP</p>
          <h1 id="profile-setup-title">Who is operating Zeus?</h1>
          <p>This contact is stored only on this computer and becomes the default requester for Spare Requests. There is no account, password, or sign-in.</p>
        </div>
        {error && <p className="inline-warning">{error}</p>}
        <ProfileFields value={value} onChange={setValue} onError={onError} />
        <footer className="onboarding-actions">
          <span>Name, email, and phone number are required.</span>
          <button type="button" className="primary-button" disabled={!ready || saving} onClick={save}>{saving ? "Saving locally…" : "Save profile & start Zeus"}</button>
        </footer>
      </section>
    </main>
  );
}
