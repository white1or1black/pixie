import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

interface TerminalProps {
  id: string;
  cwd: string;
}

export default function Terminal({ id, cwd }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
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

    // Send user input to PTY
    term.onData((data) => {
      invoke("pty_write", { id, data }).catch(() => {});
    });

    return () => {
      resizeObserver.disconnect();
      invoke("pty_kill", { id }).catch(() => {});
      if (unlisten) unlisten();
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