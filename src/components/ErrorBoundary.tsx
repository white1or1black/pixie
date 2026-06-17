import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Root error boundary. Without this, any error thrown during render tears down
 * the whole React tree and the production webview shows a blank page with no
 * clue why. In dev React surfaces/keeps going past many such errors, which is
 * why "blank screen, only in production" happens. Catching here localizes the
 * failure and prints the real error so it can be diagnosed.
 *
 * Note: error boundaries catch render/lifecycle errors — exactly the kind that
 * blank the screen — not errors thrown inside event handlers.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("Pixie render error:", error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // Deliberately inline-styled and CSS-variable-free: if the crash came from
    // a broken stylesheet, the fallback must still render legibly.
    return (
      <div
        style={{
          minHeight: "100vh",
          padding: "32px",
          boxSizing: "border-box",
          background: "#160d0d",
          color: "#fca5a5",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: "13px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "16px", color: "#fecaca" }}>
          Something went wrong
        </h2>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Pixie hit a render error. Reloading usually restores the app; if it
          keeps happening, please share the message below.
        </p>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "rgba(0,0,0,0.3)",
            padding: "12px",
            borderRadius: "8px",
            color: "#fda4af",
          }}
        >
          {error.message || String(error)}
        </pre>
        {error.stack && (
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: "11px",
              opacity: 0.55,
              maxHeight: "40vh",
              overflow: "auto",
            }}
          >
            {error.stack}
          </pre>
        )}
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: "6px 12px",
              borderRadius: "8px",
              border: "1px solid #7f1d1d",
              background: "transparent",
              color: "#fca5a5",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "6px 12px",
              borderRadius: "8px",
              border: "none",
              background: "#dc2626",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
