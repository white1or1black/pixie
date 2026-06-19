import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

interface TerminalProps {
  id: string;
  cwd: string;
  onExit?: (id: string) => void;
}

export default function Terminal({ id, cwd, onExit }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // True once the backend reported the child process exited. Used by cleanup to
  // avoid calling `pty_kill` on an already-dead session (the reader thread has
  // ended and the map entry may already be gone, so a kill call would error).
  const exitedRef = useRef(false);
  // Keep the latest onExit without adding it to the effect deps — an inline
  // parent callback would otherwise retrigger the effect (and respawn the PTY)
  // on every RightPanel render. Read via ref at the call site instead.
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    // Reset on each (re)spawn — a remount with a new id starts a fresh process.
    exitedRef.current = false;
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
        black: "#32344a",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#ad8ee6",
        cyan: "#449dab",
        white: "#787c99",
        brightBlack: "#444b6a",
        brightRed: "#ff7a93",
        brightGreen: "#b9f27c",
        brightYellow: "#ff9e64",
        brightBlue: "#7da6ff",
        brightMagenta: "#bb9af7",
        brightCyan: "#0db9d7",
        brightWhite: "#acb0d0",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    fitRef.current = fitAddon;

    // Fit on mount and resize
    const fit = () => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    };
    fit();

    const resizeObserver = new ResizeObserver(() => {
      fit();
      // Notify Rust of resize
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        invoke("pty_resize", { id, rows: dims.rows, cols: dims.cols }).catch(() => {});
      }
    });
    resizeObserver.observe(container);

    termRef.current = term;

    // Spawn PTY
    invoke("pty_spawn", { id, cwd, rows: term.rows, cols: term.cols }).catch((e) => {
      term.write(`\r\nFailed to spawn PTY: ${e}\r\n`);
    });

    // Listen for PTY output
    let unlisten: UnlistenFn | null = null;
    listen<{ id: string; data: string }>("pty-output", (event) => {
      if (event.payload.id === id) {
        term.write(event.payload.data);
      }
    }).then((fn) => { unlisten = fn; });

    // Listen for process exit so the parent can respawn / show an overlay.
    let unlistenExit: UnlistenFn | null = null;
    listen<{ id: string }>("pty-exit", (event) => {
      if (event.payload.id === id && !exitedRef.current) {
        exitedRef.current = true;
        onExitRef.current?.(id);
      }
    }).then((fn) => { unlistenExit = fn; });

    // Send user input to PTY
    term.onData((data) => {
      invoke("pty_write", { id, data }).catch(() => {});
    });

    return () => {
      resizeObserver.disconnect();
      // Only kill if the process is still alive — if it exited on its own the
      // backend reader thread has ended and the session may already be gone.
      if (!exitedRef.current) {
        invoke("pty_kill", { id }).catch(() => {});
      }
      if (unlisten) unlisten();
      if (unlistenExit) unlistenExit();
      term.dispose();
    };
  }, [id, cwd]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0"
      style={{ backgroundColor: "#1a1b26" }}
    />
  );
}