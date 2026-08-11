import type { PropsWithChildren } from "react";
import { Modal } from "./Modal";

interface Props extends PropsWithChildren {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A Zeus-themed replacement for browser confirm/prompt dialogs. */
export function ConfirmationDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Go back",
  tone = "primary",
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: Props) {
  return (
    <Modal
      title={title}
      subtitle="Zeus needs your confirmation before continuing."
      onClose={onCancel}
      dismissible={!busy}
      actions={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={tone === "danger" ? "danger-button" : "primary-button"} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "Working…" : confirmLabel}</button>
      </>}
    >
      <section className={`local-confirmation ${tone}`}>
        <p>{message}</p>
        {children}
      </section>
    </Modal>
  );
}
