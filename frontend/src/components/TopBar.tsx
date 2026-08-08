import type { WorkspaceKey } from "../types";

interface Props {
  version: string;
  detailOpen: boolean;
  workspace: WorkspaceKey;
  stagedMessages: number;
  onWorkspaceChange: (workspace: WorkspaceKey) => void;
  onData: () => void;
  onOperations: () => void;
  onSettings: () => void;
  onTheme: () => void;
}

export function TopBar({
  version,
  detailOpen,
  workspace,
  stagedMessages,
  onWorkspaceChange,
  onData,
  onOperations,
  onSettings,
  onTheme,
}: Props) {
  return (
    <header className="top-bar">
      <div className="top-title">
        <span className="bolt" aria-hidden="true">ϟ</span>
        <strong>ZEUS {version || "3.1.5"}</strong>
        <span className="top-separator">|</span>
        <nav className="workspace-switcher" aria-label="Zeus workspace">
          <button
            type="button"
            className={workspace === "service-requests" ? "active" : ""}
            aria-pressed={workspace === "service-requests"}
            onClick={() => onWorkspaceChange("service-requests")}
          >
            Service Requests
          </button>
          <button
            type="button"
            className={workspace === "spare-requests" ? "active" : ""}
            aria-pressed={workspace === "spare-requests"}
            onClick={() => onWorkspaceChange("spare-requests")}
          >
            Spare Requests
          </button>
        </nav>
        {detailOpen && <span className="detail-crumb">/ Detail</span>}
        {stagedMessages > 0 && <span className="staged-pill">Email staged {stagedMessages}</span>}
      </div>
      <div className="top-actions">
        <button type="button" className="command-button" onClick={onData}>Global data</button>
        <button type="button" className="icon-button" onClick={onTheme} title="Toggle theme" aria-label="Toggle theme">◐</button>
        <button type="button" className="icon-button" onClick={onSettings} title="Configuration" aria-label="Configuration">⚙</button>
        <button type="button" className="command-button" onClick={onOperations}>Operations</button>
      </div>
    </header>
  );
}
