import { useEffect, useRef, type PropsWithChildren, type ReactNode } from "react";

interface Props extends PropsWithChildren {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  actions?: ReactNode;
  dismissible?: boolean;
}

export function Modal({ title, subtitle, onClose, wide, actions, dismissible = true, children }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || !dismissible) return;
      const open = document.querySelectorAll<HTMLDivElement>(".modal-backdrop");
      if (open[open.length - 1] !== backdropRef.current) return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissible, onClose]);

  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && dismissible) onClose();
    }}>
      <section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-button" disabled={!dismissible} title={dismissible ? undefined : "Save or cancel the unsaved changes first"} onClick={onClose} aria-label={`Close ${title}`}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        {actions && <footer className="modal-actions">{actions}</footer>}
      </section>
    </div>
  );
}
