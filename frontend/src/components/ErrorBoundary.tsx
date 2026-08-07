import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onReload?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Zeus interface render failure", error, info.componentStack);
  }

  reload = () => {
    if (this.props.onReload) this.props.onReload();
    else window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="recovery-screen" role="alert">
        <span className="boot-bolt" aria-hidden="true">ϟ</span>
        <p className="recovery-label">ZEUS UI RECOVERY</p>
        <h1>The interface hit an unexpected display error.</h1>
        <p>
          Reloading only rereads Zeus's current Markdown state. It does not repeat
          the last Pendings save or source query.
        </p>
        <pre>{this.state.error.message || this.state.error.name}</pre>
        <button type="button" className="primary-button" onClick={this.reload}>
          Reload interface
        </button>
      </main>
    );
  }
}
