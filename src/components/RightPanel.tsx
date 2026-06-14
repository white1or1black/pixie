import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { FileEntry } from "../types";
import Terminal from "./Terminal";

interface RightPanelProps {
  workspacePath: string;
  onClose: () => void;
}

type Tab = "files" | "preview" | "git" | "browser" | "terminal";

function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "";
  return name.slice(dot + 1).toLowerCase();
}

const PREVIEW_EXTENSIONS = new Set([
  "txt", "md", "markdown", "html", "htm", "css", "js", "jsx", "ts", "tsx",
  "json", "yaml", "yml", "toml", "xml", "svg", "csv", "log", "env",
  "rs", "py", "go", "java", "c", "cpp", "h", "hpp", "rb", "php",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "vue", "svelte",
  "ini", "cfg", "conf", "gitignore", "dockerfile", "makefile",
  "lock", "editorconfig",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "rs", "py", "go", "java", "c", "cpp", "h", "hpp",
  "rb", "php", "css", "scss", "less", "json", "yaml", "yml", "toml", "xml",
  "sql", "graphql", "sh", "bash", "zsh", "fish", "vue", "svelte",
]);

const MIN_WIDTH = 200;
const DEFAULT_WIDTH = 320;

function languageFromExt(ext: string): string {
  const map: Record<string, string> = {
    js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
    rs: "rust", py: "python", rb: "ruby", go: "go", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", php: "php",
    css: "css", scss: "scss", less: "less", html: "html", htm: "html",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    sql: "sql", graphql: "graphql", sh: "bash", bash: "bash",
    zsh: "bash", fish: "fish", vue: "vue", svelte: "svelte",
  };
  return map[ext] ?? ext;
}

export default function RightPanel({ workspacePath, onClose }: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("files");
  const [currentPath, setCurrentPath] = useState(workspacePath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const isResizing = useRef(false);

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

  // Browser state
  const [browserUrl, setBrowserUrl] = useState("http://localhost:5173");
  const [iframeUrl, setIframeUrl] = useState("http://localhost:5173");

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<FileEntry[]>("list_directory", { path });
      setEntries(result);
    } catch { setEntries([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadDirectory(currentPath); }, [currentPath, loadDirectory]);

  // Load git data when git tab is active
  useEffect(() => {
    if (tab !== "git") return;
    setGitLoading(true);
    Promise.all([
      invoke<string>("git_status", { path: workspacePath }).catch(() => "Not a git repository"),
      invoke<string>("git_log", { path: workspacePath, count: 30 }).catch(() => ""),
    ]).then(([status, log]) => {
      setGitStatus(status);
      setGitLog(log);
      setGitLoading(false);
    });
  }, [tab, workspacePath]);

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
        {/* Header + Tabs */}
        <div className="shrink-0 border-b border-[var(--border-color)]">
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex gap-1">
              {([
                ["files", "📁", "Files"],
                ["preview", "📄", "Preview"],
                ["git", "🔀", "Git"],
                ["browser", "🌐", "Browser"],
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
            <button onClick={onClose}
              className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </button>
          </div>
        </div>

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
                      <img src={`file://${previewFile.path}`} alt={previewFile.name}
                        className="max-w-full max-h-full object-contain rounded" />
                    </div>
                  ) : ext === "md" || ext === "markdown" ? (
                    <div className="p-4 prose prose-sm prose-invert max-w-none">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code({ className, children, ...props }) {
                            const match = /language-(\w+)/.exec(className || "");
                            const codeStr = String(children).replace(/\n$/, "");
                            if (match) {
                              return (
                                <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div"
                                  customStyle={{ margin: 0, borderRadius: "0.5rem", fontSize: "0.75rem" }}>
                                  {codeStr}
                                </SyntaxHighlighter>
                              );
                            }
                            return <code className="bg-[var(--bg-tertiary)] px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
                          },
                        }}
                      >
                        {previewContent ?? ""}
                      </ReactMarkdown>
                    </div>
                  ) : CODE_EXTENSIONS.has(ext) ? (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={languageFromExt(ext)}
                      showLineNumbers
                      wrapLines
                      customStyle={{ margin: 0, borderRadius: 0, fontSize: "0.75rem", flex: 1 }}
                    >
                      {previewContent ?? ""}
                    </SyntaxHighlighter>
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
                {/* Git Status */}
                <div className="border-b border-[var(--border-color)] shrink-0">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-secondary)]">Status</div>
                  <pre className="px-3 pb-2 text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                    {gitStatus || "Clean working tree"}
                  </pre>
                </div>
                {/* Git Log */}
                <div className="flex-1 overflow-y-auto">
                  <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-secondary)] sticky top-0 bg-[var(--bg-secondary)]">History</div>
                  {gitLog ? (
                    gitLog.split("\n").filter(Boolean).map((line) => {
                      const hash = line.match(/^[\*\s\|\\\/]*([a-f0-9]{7,})/)?.[1];
                      return (
                        <div key={line}
                          onClick={() => hash && viewCommitDiff(hash)}
                          className={`px-3 py-1 text-xs font-mono cursor-pointer transition-colors truncate ${
                            selectedCommit === hash
                              ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                              : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                          }`}>
                          {line}
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-xs text-[var(--text-secondary)] px-3 py-2">No commits</p>
                  )}
                </div>
                {/* Diff */}
                {gitDiff && (
                  <div className="border-t border-[var(--border-color)] max-h-[40%] overflow-auto shrink-0">
                    <div className="flex items-center justify-between px-3 py-1.5 sticky top-0 bg-[var(--bg-secondary)]">
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
                    <SyntaxHighlighter style={oneDark} language="diff" showLineNumbers={false}
                      customStyle={{ margin: 0, borderRadius: 0, fontSize: "0.7rem" }}>
                      {gitDiff}
                    </SyntaxHighlighter>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* === BROWSER TAB === */}
        {tab === "browser" && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] shrink-0">
              <input
                type="text"
                value={browserUrl}
                onChange={(e) => setBrowserUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setIframeUrl(browserUrl)}
                placeholder="Enter URL..."
                className="flex-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)] transition-colors font-mono"
              />
              <button
                onClick={() => setIframeUrl(browserUrl)}
                className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shrink-0"
              >
                Go
              </button>
            </div>
            <iframe
              src={iframeUrl}
              className="flex-1 border-0 bg-white"
              title="Browser"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}

        {/* === TERMINAL TAB === */}
        {tab === "terminal" && (
          <Terminal id="main" cwd={workspacePath} />
        )}

      </div>
    </div>
  );
}