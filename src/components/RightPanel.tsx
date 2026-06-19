import { memo, useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { FileEntry, PreviewTarget, DiffViewMode } from "../types";
import { getExtension, PREVIEW_EXTENSIONS, IMAGE_EXTENSIONS, basename } from "../preview";
import { languageFromExt } from "../lib/languages";
import { useDragRegion } from "../hooks/useDragRegion";
import DiffViewer from "./DiffViewer";
import Terminal from "./Terminal";

interface RightPanelProps {
  workspacePath: string;
  previewTarget: PreviewTarget | null;
}

type Tab = "files" | "preview" | "git" | "terminal";

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "rs", "py", "go", "java", "c", "cpp", "h", "hpp",
  "rb", "php", "css", "scss", "less", "json", "yaml", "yml", "toml", "xml",
  "sql", "graphql", "sh", "bash", "zsh", "fish", "vue", "svelte",
]);

const MIN_WIDTH = 200;
const DEFAULT_WIDTH = 320;
const DEFAULT_CHANGES_HEIGHT = 260;
const MIN_CHANGES_HEIGHT = 120;
const MIN_HISTORY_HEIGHT = 120;

// Hoisted to module scope for stable identity across renders — a prerequisite
// for the memo()d highlighters below to skip re-tokenizing large content when
// the panel re-renders for an unrelated reason (e.g. dragging the resize
// handle, which flips `width` state ~60×/s, or re-selecting a git commit).
const PREVIEW_CODE_STYLE: CSSProperties = { margin: 0, borderRadius: 0, fontSize: "0.75rem", flex: 1 };
const MD_CODE_STYLE: CSSProperties = { margin: 0, borderRadius: "0.5rem", fontSize: "0.75rem" };
const REMARK_PLUGINS = [remarkGfm];

interface CodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  customStyle?: CSSProperties;
}

// Prism tokenizes the entire string on every render — expensive for a large
// file or diff. Memoize so re-renders that leave code/language unchanged
// (resize drag, commit selection, tab re-entry) skip re-tokenizing.
const CodeBlock = memo(function CodeBlock({
  code,
  language,
  showLineNumbers,
  wrapLines,
  customStyle,
}: CodeBlockProps) {
  return (
    <SyntaxHighlighter
      style={oneDark}
      language={language}
      showLineNumbers={showLineNumbers}
      wrapLines={wrapLines}
      customStyle={customStyle}
    >
      {code}
    </SyntaxHighlighter>
  );
});

// Memoize the whole markdown render so resize-drag (which re-renders the
// panel) doesn't re-parse markdown and re-tokenize every fenced code block.
// Only re-runs when the file content actually changes.
const MarkdownView = memo(function MarkdownView({ content }: { content: string }) {
  return (
    <div className="p-4 prose prose-sm prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const codeStr = String(children).replace(/\n$/, "");
            if (match) {
              return (
                <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div"
                  customStyle={MD_CODE_STYLE}>
                  {codeStr}
                </SyntaxHighlighter>
              );
            }
            return <code className="bg-[var(--bg-tertiary)] px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// Unified/split toggle shared by the Changes and commit-diff viewers.
function DiffModeToggle({ mode, onChange }: { mode: DiffViewMode; onChange: (m: DiffViewMode) => void }) {
  return (
    <div className="flex items-center rounded bg-[var(--bg-tertiary)] p-0.5">
      {(["unified", "split"] as DiffViewMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-1.5 py-0.5 rounded text-[10px] capitalize transition-colors ${
            mode === m ? "bg-[var(--accent)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function RightPanelImpl({ workspacePath, previewTarget }: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("files");
  const [currentPath, setCurrentPath] = useState(workspacePath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const isResizing = useRef(false);
  const handleDragRegion = useDragRegion();

  // Preview state
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Git state
  const [gitStatus, setGitStatus] = useState("");
  const [gitLog, setGitLog] = useState("");
  const [gitLoading, setGitLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState("");
  // Uncommitted working-tree diff (`git diff HEAD`), rendered at the top of the git tab.
  const [gitWorkingDiff, setGitWorkingDiff] = useState("");
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified");
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [changesHeight, setChangesHeight] = useState(DEFAULT_CHANGES_HEIGHT);
  const gitSplitRef = useRef<HTMLDivElement | null>(null);
  const isResizingChanges = useRef(false);
  const didInitChangesHeight = useRef(false);

  // Workspaces whose terminal has been opened at least once. Each gets a
  // permanently-mounted Terminal (its own PTY) so scrollback and any running
  // process survive tab switches, panel close/reopen, and workspace switches.
  const [terminalWs, setTerminalWs] = useState<string[]>([]);

  // Lazily mount a persistent terminal the first time the terminal tab is opened
  // in a workspace; it then stays alive for the whole session.
  if (tab === "terminal" && workspacePath && !terminalWs.includes(workspacePath)) {
    setTerminalWs((prev) => [...prev, workspacePath]);
  }

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<FileEntry[]>("list_directory", { path });
      setEntries(result);
    } catch { setEntries([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadDirectory(currentPath); }, [currentPath, loadDirectory]);

  // Load git data (status, log, and the uncommitted working-tree diff) when the
  // git tab is active. Exposed as `loadGit` so the Changes header can refresh on
  // demand — the working tree changes as the user works.
  const loadGit = useCallback(async () => {
    setGitLoading(true);
    const [status, log, workingDiff] = await Promise.all([
      invoke<string>("git_status", { path: workspacePath }).catch(() => "Not a git repository"),
      invoke<string>("git_log", { path: workspacePath, count: 30 }).catch(() => ""),
      invoke<string>("git_diff", { path: workspacePath, commit: "HEAD" }).catch(() => ""),
    ]);
    setGitStatus(status);
    setGitLog(log);
    setGitWorkingDiff(workingDiff);
    setGitLoading(false);
  }, [workspacePath]);

  useEffect(() => {
    if (tab !== "git") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate: fetch git data when the tab becomes active
    loadGit();
  }, [tab, loadGit]);

  // Untracked files aren't covered by `git diff HEAD`; surface them separately.
  const untracked = useMemo(
    () =>
      gitStatus
        .split("\n")
        .filter((l) => l.startsWith("?? "))
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    [gitStatus],
  );

  const openPreview = useCallback(async (entry: FileEntry) => {
    const ext = getExtension(entry.name);
    setPreviewFile(entry);
    if (IMAGE_EXTENSIONS.has(ext)) {
      setPreviewContent(null);
      setTab("preview");
      return;
    }
    if (!PREVIEW_EXTENSIONS.has(ext) && ext !== "") {
      setPreviewContent(null);
      setTab("preview");
      return;
    }
    setPreviewLoading(true);
    setPreviewContent(null);
    try {
      const content = await invoke<string>("read_file_content", { path: entry.path });
      setPreviewContent(content);
      setTab("preview");
    } catch (e) {
      setPreviewContent(`Failed to read file: ${e}`);
    } finally { setPreviewLoading(false); }
  }, []);

  // React to an externally-requested file preview target (a file path clicked
  // in a chat message). URLs never reach here — they are handed off to the
  // system browser instead. Keyed on `previewTarget` (which carries a nonce)
  // so the same target can be re-opened.
  useEffect(() => {
    if (!previewTarget || previewTarget.kind !== "file") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate: drive panel state from an external prop
    openPreview({ name: basename(previewTarget.path), path: previewTarget.path, is_dir: false, size: 0 });
  }, [previewTarget, openPreview]);

  // The panel no longer remounts on workspace switch (so per-workspace terminals
  // persist), so reset the workspace-scoped views when the workspace changes.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- legitimate: reset workspace-scoped views on workspace change, since the panel stays mounted */
    setCurrentPath(workspacePath);
    setHistory([]);
    setPreviewFile(null);
    setPreviewContent(null);
    setSelectedCommit(null);
    setGitDiff("");
    setGitWorkingDiff("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspacePath]);

  const viewCommitDiff = async (commit: string) => {
    setSelectedCommit(commit);
    try {
      const diff = await invoke<string>("git_diff", { path: workspacePath, commit });
      setGitDiff(diff);
    } catch { setGitDiff("Failed to load diff"); }
  };

  // --- Resize logic ---
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const maxWidth = window.innerWidth * 0.9;
      setWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, window.innerWidth - e.clientX)));
    };
    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Drag handle between Changes and History in the Git tab.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingChanges.current) return;
      const el = gitSplitRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dividerH = 6;
      const available = rect.height - dividerH;
      const next = e.clientY - rect.top;
      const maxChanges = Math.max(MIN_CHANGES_HEIGHT, available - MIN_HISTORY_HEIGHT);
      const clamped = Math.min(maxChanges, Math.max(MIN_CHANGES_HEIGHT, next));
      setChangesHeight(clamped);
    };
    const handleMouseUp = () => {
      isResizingChanges.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const startChangesResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingChanges.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  // Initialize/clamp the split the first time the Git tab is shown so the
  // default doesn't leave an oversized empty area on tall windows.
  useEffect(() => {
    if (tab !== "git") return;
    const el = gitSplitRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const cur = gitSplitRef.current;
      if (!cur) return;
      const rect = cur.getBoundingClientRect();
      const dividerH = 6;
      const available = rect.height - dividerH;
      const maxChanges = Math.max(MIN_CHANGES_HEIGHT, available - MIN_HISTORY_HEIGHT);
      setChangesHeight((prev) => {
        const base = didInitChangesHeight.current ? prev : Math.round(available * 0.5);
        const next = Math.min(maxChanges, Math.max(MIN_CHANGES_HEIGHT, base));
        didInitChangesHeight.current = true;
        return next;
      });
    });
  }, [tab]);

  const navigateTo = (path: string) => {
    setHistory((prev) => [...prev, currentPath]);
    setCurrentPath(path);
  };
  const goBack = () => {
    if (history.length === 0) return;
    setCurrentPath(history[history.length - 1]);
    setHistory((prev) => prev.slice(0, -1));
  };
  const goUp = () => {
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    setHistory((prev) => [...prev, currentPath]);
    setCurrentPath(parent);
  };

  const segments = currentPath.split("/").filter(Boolean);
  const ext = previewFile ? getExtension(previewFile.name) : "";

  return (
    <div className="flex h-full" style={{ width, minWidth: MIN_WIDTH, maxWidth: "90vw" }}>
      <div onMouseDown={startResize}
        className="w-1 hover:w-1.5 cursor-col-resize bg-transparent hover:bg-[var(--accent)]/50 active:bg-[var(--accent)] transition-all shrink-0" />

      <div className="flex-1 flex flex-col bg-[var(--bg-secondary)] border-l border-[var(--border-color)] min-w-0">
        {/* Header + Tabs. No in-panel close button — the header toolbar toggles
            the whole panel, so an X here would be redundant. */}
        <div className="shrink-0 border-b border-[var(--border-color)]">
          <div className="flex items-center px-4 py-2">
            <div className="flex gap-1">
              {([
                ["files", "📁", "Files"],
                ["preview", "📄", "Preview"],
                ["git", "🔀", "Git"],
                ["terminal", "⬛", "Terminal"],
              ] as [Tab, string, string][]).map(([t, icon, name]) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  title={name}
                  className={`flex items-center justify-center w-8 h-8 rounded-lg text-base transition-colors ${
                    tab === t
                      ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
            <div className="flex-1 h-8" onMouseDown={handleDragRegion} />
          </div>
        </div>

        {/* Tab content area. `relative` lets the persistent terminal layer overlay
            it without disturbing the files/preview/git layouts. */}
        <div className="flex-1 flex flex-col relative min-h-0">

        {/* === FILES TAB === */}
        {tab === "files" && (
          <>
            <div className="px-3 py-1.5 border-b border-[var(--border-color)] flex items-center gap-0.5 overflow-x-auto text-[11px] shrink-0">
              <button onClick={goBack} disabled={history.length === 0}
                className="shrink-0 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] disabled:opacity-30 transition-colors">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button onClick={goUp} className="shrink-0 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 9V3l7 6H3z" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </button>
              <span className="text-[var(--text-secondary)] mx-0.5">/</span>
              {segments.map((seg, i) => (
                <span key={i} className="flex items-center gap-0 shrink-0">
                  <button onClick={() => {
                    const targetPath = "/" + segments.slice(0, i + 1).join("/");
                    setHistory((prev) => [...prev, currentPath]);
                    setCurrentPath(targetPath);
                  }} className="text-[var(--accent)] hover:underline truncate max-w-[100px]">{seg}</button>
                  {i < segments.length - 1 && <span className="text-[var(--text-secondary)] mx-0.5">/</span>}
                </span>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {loading && entries.length === 0 && (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {!loading && entries.length === 0 && (
                <p className="text-xs text-[var(--text-secondary)] text-center py-12">Empty directory</p>
              )}
              {entries.map((entry) => {
                const e = getExtension(entry.name);
                const canPreview = !entry.is_dir && (PREVIEW_EXTENSIONS.has(e) || IMAGE_EXTENSIONS.has(e));
                return (
                  <div key={entry.path}
                    onClick={() => {
                      if (entry.is_dir) navigateTo(entry.path);
                      else if (canPreview) openPreview(entry);
                    }}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors ${
                      entry.is_dir || canPreview ? "cursor-pointer hover:bg-[var(--bg-tertiary)]" : "cursor-default"
                    }`}>
                    <span className="text-base shrink-0">{entry.is_dir ? "📁" : "📄"}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-[var(--text-primary)] truncate">{entry.name}</p>
                    </div>
                    {entry.is_dir
                      ? <span className="text-[10px] text-[var(--text-secondary)] shrink-0">dir</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] shrink-0 font-mono">{e || "--"}</span>
                    }
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* === PREVIEW TAB === */}
        {tab === "preview" && (
          <div className="flex-1 flex flex-col min-h-0">
            {!previewFile ? (
              <p className="text-xs text-[var(--text-secondary)] text-center py-12 px-4">
                Select a file in the Files tab to preview it here
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] shrink-0">
                  <button onClick={() => setTab("files")}
                    className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors shrink-0">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <span className="text-xs text-[var(--text-primary)] truncate">{previewFile.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] shrink-0">{ext || "text"}</span>
                </div>
                <div className="flex-1 overflow-auto">
                  {previewLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : IMAGE_EXTENSIONS.has(ext) ? (
                    <div className="p-4 flex items-center justify-center">
                      <img src={convertFileSrc(previewFile.path)} alt={previewFile.name}
                        className="max-w-full max-h-full object-contain rounded" />
                    </div>
                  ) : ext === "md" || ext === "markdown" ? (
                    <MarkdownView content={previewContent ?? ""} />
                  ) : CODE_EXTENSIONS.has(ext) ? (
                    <CodeBlock
                      code={previewContent ?? ""}
                      language={languageFromExt(ext)}
                      showLineNumbers
                      wrapLines
                      customStyle={PREVIEW_CODE_STYLE}
                    />
                  ) : ext === "html" || ext === "htm" ? (
                    <iframe srcDoc={previewContent ?? ""}
                      className="w-full h-full border-0 bg-white" sandbox="allow-scripts" />
                  ) : (
                    <pre className="p-3 text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap break-all leading-relaxed select-text">
                      {previewContent}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* === GIT TAB === */}
        {tab === "git" && (
          <div className="flex-1 flex flex-col min-h-0">
            {gitLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <>
                <div ref={gitSplitRef} className="flex-1 flex flex-col min-h-0">
                  {/* Working-tree (uncommitted) changes — the "new changes", rendered
                      in the same DiffViewer as commit diffs. */}
                  <div
                    className="border-b border-[var(--border-color)] flex flex-col min-h-0"
                    style={changesCollapsed ? undefined : { height: changesHeight }}
                  >
                    <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
                      <button
                        onClick={() => setChangesCollapsed((c) => !c)}
                        className="flex items-center gap-1.5"
                      >
                        <span
                          className="text-[10px] text-[var(--text-secondary)]"
                          style={{ transform: changesCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}
                        >
                          ▾
                        </span>
                        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Changes</span>
                      </button>
                      <div className="flex items-center gap-2">
                        <DiffModeToggle mode={diffViewMode} onChange={setDiffViewMode} />
                        <button
                          onClick={loadGit}
                          title="Refresh"
                          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 12a9 9 0 1 1-3-6.7" />
                            <path d="M21 3v6h-6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {!changesCollapsed && (
                      <div className="flex-1 overflow-auto min-h-0">
                        {gitWorkingDiff ? (
                          <DiffViewer diff={gitWorkingDiff} viewMode={diffViewMode} />
                        ) : (
                          <p className="px-3 pb-2 text-xs text-[var(--text-secondary)]">No uncommitted changes</p>
                        )}
                        {untracked.length > 0 && (
                          <div className="border-t border-[var(--border-color)]">
                            <div className="px-3 py-1 text-[10px] text-[var(--text-secondary)]">Untracked</div>
                            {untracked.map((f, i) => (
                              <div key={i} className="px-3 py-0.5 text-[11px] font-mono text-[var(--text-secondary)] truncate">
                                + {f}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Drag handle: resize Changes vs History */}
                  {!changesCollapsed && (
                    <div
                      onMouseDown={startChangesResize}
                      className="h-1.5 cursor-row-resize bg-transparent hover:bg-[var(--accent)]/30 active:bg-[var(--accent)]/40 transition-colors shrink-0"
                      title="Drag to resize"
                    />
                  )}

                  {/* Git Log */}
                  <div className="flex-1 overflow-y-auto min-h-0">
                    <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-secondary)] sticky top-0 bg-[var(--bg-secondary)]">
                      History
                    </div>
                    {gitLog ? (
                      gitLog.split("\n").filter(Boolean).map((line) => {
                        const hash = line.match(/^[\*\s\|\\\/]*([a-f0-9]{7,})/)?.[1];
                        return (
                          <div
                            key={line}
                            onClick={() => hash && viewCommitDiff(hash)}
                            className={`px-3 py-1 text-xs font-mono cursor-pointer transition-colors truncate ${
                              selectedCommit === hash
                                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                                : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                            }`}
                          >
                            {line}
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-xs text-[var(--text-secondary)] px-3 py-2">No commits</p>
                    )}
                  </div>
                </div>
                {/* Diff */}
                {gitDiff && (
                  <div className="border-t border-[var(--border-color)] max-h-[55%] overflow-auto shrink-0 flex flex-col">
                    <div className="flex items-center justify-between px-3 py-1.5 sticky top-0 z-10 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
                      <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                        Diff {selectedCommit?.slice(0, 7)}
                      </span>
                      <button onClick={() => { setSelectedCommit(null); setGitDiff(""); }}
                        className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                    </div>
                    <DiffViewer diff={gitDiff} viewMode={diffViewMode} />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* === TERMINAL TAB === */}
        {/* Persistent per-workspace terminals. Each is mounted once (the first
            time the terminal tab is opened in that workspace) and kept alive for
            the session, so scrollback and any running process survive tab
            switches, panel close/reopen, and workspace switches. Only the active
            workspace's terminal is shown, and only while the terminal tab is on. */}
        {terminalWs.map((ws) => (
          <div
            key={ws}
            className="absolute inset-0 flex flex-col"
            style={{ display: tab === "terminal" && ws === workspacePath ? "flex" : "none" }}
          >
            <Terminal id={`term-${ws}`} cwd={ws} />
          </div>
        ))}

        </div>
      </div>
    </div>
  );
}

// Memoize so typing in the composer (which lives in the same AppShell that
// renders this panel) doesn't re-render the panel — and thus doesn't re-run
// Prism over a large file preview or git diff — on every keystroke. Both props
// (workspacePath, previewTarget) are stable across keystrokes, so a shallow
// memo skips it. Mirrors the memo on MessageBubble for the same reason.
const RightPanel = memo(RightPanelImpl);

export default RightPanel;