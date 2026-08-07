interface Props {
  version: string;
  detailOpen: boolean;
  stagedMessages: number;
  onOperations: () => void;
  onSettings: () => void;
  onTheme: () => void;
}

export function TopBar({
  version,
  detailOpen,
  stagedMessages,
  onOperations,
  onSettings,
  onTheme,
}: Props) {
  return (
    <header className="top-bar">
      <div className="top-title">
        <span className="bolt" aria-hidden="true">ϟ</span>
        <strong>ZEUS {version || "3.0.0"}</strong>
        <span className="top-separator">|</span>
        <span>{detailOpen ? "Dashboard / Detail" : "Dashboard"}</span>
        {stagedMessages > 0 && <span className="staged-pill">Email staged {stagedMessages}</span>}
      </div>
      <div className="top-actions">
        <button type="button" className="icon-button" onClick={onTheme} title="Toggle theme" aria-label="Toggle theme">◐</button>
        <button type="button" className="icon-button" onClick={onSettings} title="Configuration" aria-label="Configuration">⚙</button>
        <button type="button" className="command-button" onClick={onOperations}>Operations</button>
      </div>
    </header>
  );
}
