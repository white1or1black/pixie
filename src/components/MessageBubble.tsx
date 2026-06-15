import { useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Message, MessageUsage, PreviewRequest, ToolStep } from "../types";
import { isPreviewableFile } from "../preview";

interface MessageBubbleProps {
  message: Message;
  onOpenPreview: (t: PreviewRequest) => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button onClick={handleCopy} className="copy-code-btn">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Inline `<code>` that opens a file path or URL in the right preview when it's
 *  something we can preview; otherwise renders as plain inert code. */
function OpenableCode({
  value,
  kind,
  onOpenPreview,
}: {
  value: string;
  kind: "file" | "url";
  onOpenPreview: (t: PreviewRequest) => void;
}) {
  if (!value || (kind === "file" && !isPreviewableFile(value))) {
    return <code>{value}</code>;
  }
  return (
    <code
      title="Open in preview"
      onClick={(e) => {
        e.stopPropagation();
        onOpenPreview(kind === "url" ? { kind: "url", url: value } : { kind: "file", path: value });
      }}
      className="cursor-pointer hover:underline"
      style={{ color: "var(--accent)" }}
    >
      {value}
    </code>
  );
}

// ---------------------------------------------------------------------------
// Tool activity rendering (live progress of what Claude is doing)
// ---------------------------------------------------------------------------

/** Short emoji icon per tool family. */
function iconForTool(name: string): string {
  const n = name.toLowerCase();
  if (n === "bash") return "⚡";
  if (n === "read") return "📖";
  if (n === "edit" || n === "multiedit") return "✏️";
  if (n === "write") return "📝";
  if (n === "glob") return "🔍";
  if (n === "grep") return "🔎";
  if (n === "task" || n === "agent") return "🤖";
  if (n === "webfetch" || n === "websearch") return "🌐";
  if (n === "notebookedit") return "📓";
  return "🛠️";
}

/** Truncate a long string to `max` chars (whitespace-collapsed), adding an ellipsis when cut. */
function truncateText(s: string, max: number): string {
  const single = s.replace(/\s+/g, " ").trim();
  return single.length > max ? single.slice(0, max) + " …" : single;
}

/** Colored status pill for the Task* todo tools (pending / in_progress / completed / deleted). */
function taskStatusChip(status: string): ReactNode {
  const cls =
    status === "in_progress"
      ? "task-status--running"
      : status === "completed"
        ? "task-status--done"
        : status === "deleted"
          ? "task-status--deleted"
          : "task-status--pending";
  return <span className={`task-status ${cls}`}>{status.replace("_", " ")}</span>;
}

/**
 * Human description of a tool step, split into a "purpose" (what it is doing)
 * and an optional "target" (the file / command / pattern it acts on). The Bash
 * tool ships an explicit `description`; we surface that as the purpose so the
 * transcript reads as a reasoning trace rather than a bare command.
 */
function describeTool(step: ToolStep): { label: string; target?: string; open?: { kind: "file" | "url"; value: string } } {
  const input = (step.input ?? null) as Record<string, unknown> | null;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = input?.[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  const fileOpen = (v?: string) => (v ? { kind: "file" as const, value: v } : undefined);
  const urlOpen = (v?: string) => (v ? { kind: "url" as const, value: v } : undefined);
  const n = step.name.toLowerCase();
  const purpose = pick("description", "reason");

  switch (n) {
    case "bash":         return { label: purpose ?? "Run command",       target: pick("command") };
    case "read":         return { label: "Read file",                    target: pick("file_path"), open: fileOpen(pick("file_path")) };
    case "edit":         return { label: "Edit file",                    target: pick("file_path"), open: fileOpen(pick("file_path")) };
    case "multiedit":    return { label: "Edit file",                    target: pick("file_path"), open: fileOpen(pick("file_path")) };
    case "write":        return { label: "Write file",                   target: pick("file_path"), open: fileOpen(pick("file_path")) };
    case "notebookedit": return { label: "Edit notebook",                target: pick("notebook_path"), open: fileOpen(pick("notebook_path")) };
    case "glob":         return { label: "Find files",                   target: pick("pattern") };
    case "grep":         return { label: "Search code",                  target: pick("pattern") };
    case "task":
    case "agent":        return { label: purpose ?? "Delegate to agent", target: pick("description", "prompt") };
    case "webfetch":     return { label: "Fetch URL",                    target: pick("url"), open: urlOpen(pick("url")) };
    case "websearch":    return { label: "Web search",                   target: pick("query") };
    case "taskcreate":   return { label: "Create task",                  target: pick("subject") };
    case "taskupdate": {
      const st = pick("status");
      const verb =
        st === "in_progress" ? "Start task"
        : st === "completed" ? "Complete task"
        : st === "deleted" ? "Delete task"
        : st === "pending" ? "Reset task"
        : "Update task";
      return { label: verb, target: pick("subject") };
    }
    case "taskget":      return { label: "Read task" };
    case "tasklist":     return { label: "List tasks" };
    case "taskoutput":   return { label: "Read task output" };
    case "taskstop":     return { label: "Stop task" };
    default:             return { label: step.name };
  }
}

function ToolField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="tool-field">
      <span className="tool-field-label">{label}</span>
      <span className="tool-field-value">{value}</span>
    </div>
  );
}

type DiffLine = { type: "ctx" | "add" | "del"; text: string };

/** Lightweight LCS line diff between two strings. Falls back to plain
 *  remove/add blocks when the inputs are too large for the O(n·m) table. */
function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  if (a.length > 200 || b.length > 200) {
    return [
      ...a.map((text) => ({ type: "del" as const, text })),
      ...b.map((text) => ({ type: "add" as const, text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function DiffBlock({ diff, title }: { diff: DiffLine[]; title: string }) {
  return (
    <div className="tool-diff-section">
      <div className="tool-diff-title">{title}</div>
      <pre className="tool-diff">
        {diff.map((d, i) => (
          <span key={i} className={`diff-line diff-line--${d.type}`}>
            <span className="diff-marker">{d.type === "add" ? "+" : d.type === "del" ? "-" : " "}</span>
            <span className="diff-text">{d.text || " "}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Added/removed line counts for an Edit/MultiEdit/Write step, for the header badge. */
function diffStats(step: ToolStep): { added: number; removed: number } | null {
  const input = (step.input ?? null) as Record<string, unknown> | null;
  if (!input) return null;
  const n = step.name.toLowerCase();
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);

  if (n === "edit") {
    const o = str("old_string");
    const nw = str("new_string");
    if (o == null || nw == null) return null;
    const d = lineDiff(o, nw);
    return {
      added: d.filter((x) => x.type === "add").length,
      removed: d.filter((x) => x.type === "del").length,
    };
  }
  if (n === "multiedit") {
    const edits = input.edits;
    if (!Array.isArray(edits)) return null;
    let added = 0;
    let removed = 0;
    for (const e of edits) {
      if (e && typeof e === "object") {
        const ee = e as Record<string, unknown>;
        if (typeof ee.old_string === "string" && typeof ee.new_string === "string") {
          const d = lineDiff(ee.old_string, ee.new_string);
          added += d.filter((x) => x.type === "add").length;
          removed += d.filter((x) => x.type === "del").length;
        }
      }
    }
    return { added, removed };
  }
  if (n === "write") {
    const c = str("content");
    if (c == null) return null;
    return { added: c.split("\n").length, removed: 0 };
  }
  return null;
}

/**
 * Structured preview of a tool's INPUT, shown while the step is running so the
 * user can watch what it is about to do (command, target file, search pattern…).
 */
function renderToolInput(step: ToolStep, onOpenPreview: (t: PreviewRequest) => void): ReactNode {
  const input = (step.input ?? null) as Record<string, unknown> | null;
  if (!input) return <span className="tool-field-empty">starting…</span>;

  const n = step.name.toLowerCase();
  const str = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return undefined;
  };
  const num = (k: string): number | undefined =>
    typeof input[k] === "number" ? (input[k] as number) : undefined;

  const rows: ReactNode[] = [];
  const push = (label: string, value: ReactNode) =>
    rows.push(<ToolField key={label} label={label} value={value} />);

  if (n === "bash") {
    push("command", <code>{str("command")}</code>);
  } else if (n === "read") {
    push("file", <OpenableCode value={str("file_path") ?? ""} kind="file" onOpenPreview={onOpenPreview} />);
    if (num("offset") != null) push("offset", String(num("offset")));
    if (num("limit") != null) push("limit", String(num("limit")));
  } else if (n === "edit") {
    push("file", <OpenableCode value={str("file_path") ?? ""} kind="file" onOpenPreview={onOpenPreview} />);
    const oldS = str("old_string");
    const newS = str("new_string");
    if (oldS != null && newS != null) {
      rows.push(<DiffBlock key="changes" diff={lineDiff(oldS, newS)} title="changes" />);
    } else if (newS != null) {
      push("new", truncateText(newS, 200));
    }
  } else if (n === "multiedit") {
    push("file", <OpenableCode value={str("file_path") ?? ""} kind="file" onOpenPreview={onOpenPreview} />);
    const edits = input.edits;
    if (Array.isArray(edits)) {
      edits.forEach((e, idx) => {
        if (e && typeof e === "object") {
          const ee = e as Record<string, unknown>;
          if (typeof ee.old_string === "string" && typeof ee.new_string === "string") {
            rows.push(
              <DiffBlock
                key={`change-${idx}`}
                diff={lineDiff(ee.old_string, ee.new_string)}
                title={edits.length > 1 ? `change ${idx + 1}` : "changes"}
              />,
            );
          }
        }
      });
    }
  } else if (n === "write") {
    push("file", <OpenableCode value={str("file_path") ?? ""} kind="file" onOpenPreview={onOpenPreview} />);
    const content = str("content");
    if (content) {
      const lines = content.split("\n");
      const cap = 200;
      const shown: DiffLine[] = lines.slice(0, cap).map((text) => ({ type: "add", text }));
      const diff: DiffLine[] =
        lines.length > cap
          ? [...shown, { type: "ctx", text: `… (${lines.length - cap} more lines not shown)` }]
          : shown;
      rows.push(<DiffBlock key="content" diff={diff} title="content" />);
    }
  } else if (n === "notebookedit") {
    push("notebook", <code>{str("notebook_path")}</code>);
  } else if (n === "glob") {
    push("pattern", <code>{str("pattern")}</code>);
    if (str("path")) push("path", <code>{str("path")}</code>);
  } else if (n === "grep") {
    push("pattern", <code>{str("pattern")}</code>);
    if (str("path")) push("path", <code>{str("path")}</code>);
    if (str("glob")) push("glob", <code>{str("glob")}</code>);
  } else if (n === "task" || n === "agent") {
    if (str("subagent_type")) push("agent", <code>{str("subagent_type")}</code>);
    if (str("description")) push("task", str("description"));
    const prompt = str("prompt");
    if (prompt) push("prompt", truncateText(prompt, 160));
  } else if (n === "webfetch") {
    push("url", <OpenableCode value={str("url") ?? ""} kind="url" onOpenPreview={onOpenPreview} />);
    if (str("prompt")) push("prompt", str("prompt"));
  } else if (n === "websearch") {
    push("query", <code>{str("query")}</code>);
  } else if (n === "taskcreate") {
    if (str("subject")) push("task", str("subject"));
    if (str("activeForm")) push("doing", str("activeForm"));
    if (str("description")) push("detail", truncateText(str("description")!, 160));
  } else if (n === "taskupdate") {
    const st = str("status");
    if (st) push("status", taskStatusChip(st));
    if (str("activeForm")) push("doing", str("activeForm"));
    if (str("subject")) push("rename to", str("subject"));
    if (str("owner")) push("owner", <code>{str("owner")}</code>);
    const tid = str("taskId") ?? str("task_id");
    if (tid) push("id", <code>{tid.slice(0, 8)}</code>);
  } else if (n === "taskget" || n === "taskoutput" || n === "taskstop") {
    const tid = str("taskId") ?? str("task_id");
    if (tid) push("id", <code>{tid.slice(0, 8)}</code>);
  } else {
    return <pre className="tool-detail">{JSON.stringify(input, null, 2)}</pre>;
  }

  return <div className="tool-fields">{rows}</div>;
}

function ToolStepCard({ step, onOpenPreview }: { step: ToolStep; onOpenPreview: (t: PreviewRequest) => void }) {
  // Convention: a running step is expanded (watch it work); once it has a
  // result it auto-collapses to keep the transcript readable. The user can
  // still click any card to expand/collapse manually.
  const [open, setOpen] = useState(step.status === "running");
  const prevStatus = useRef(step.status);
  useEffect(() => {
    if (step.status === prevStatus.current) return;
    prevStatus.current = step.status;
    setOpen(step.status === "running");
  }, [step.status]);

  const { label, target, open: openable } = describeTool(step);
  const diffStat = useMemo(() => diffStats(step), [step.name, step.input]);
  const isRunning = step.status === "running";
  const hasResult = Boolean(step.result);
  const lname = step.name.toLowerCase();
  // Edit/Write steps are most useful as a diff of their input (old→new), shown
  // both while running and after completion; other tools show input while
  // running and their result text once done.
  const isEditLike = lname === "edit" || lname === "multiedit" || lname === "write";
  const showInput = isRunning || (isEditLike && step.input != null);
  const taskStatusRaw =
    lname === "taskupdate" &&
    step.input != null &&
    typeof (step.input as Record<string, unknown>).status === "string"
      ? ((step.input as Record<string, unknown>).status as string)
      : undefined;
  const hasBody = isRunning || hasResult;

  const body = showInput ? (
    renderToolInput(step, onOpenPreview)
  ) : (
    <pre className={`tool-detail${step.status === "error" ? " tool-detail--error" : ""}`}>
      {step.result}
    </pre>
  );

  return (
    <div
      className={`tool-step tool-step--${step.status}${open && hasBody ? " tool-step--open" : ""}`}
    >
      <button
        className="tool-step-header"
        onClick={() => hasBody && setOpen((o) => !o)}
        type="button"
        aria-expanded={open}
      >
        <span className="tool-icon">{iconForTool(step.name)}</span>
        <span className="tool-purpose">{label}</span>
        {target && (
          openable && (openable.kind === "url" || isPreviewableFile(openable.value)) ? (
            <span
              className="tool-target"
              title="Open in preview"
              style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPreview(
                  openable.kind === "url"
                    ? { kind: "url", url: openable.value }
                    : { kind: "file", path: openable.value }
                );
              }}
            >
              {target}
            </span>
          ) : (
            <span className="tool-target" title={target}>{target}</span>
          )
        )}
        {diffStat && (diffStat.added > 0 || diffStat.removed > 0) && (
          <span
            className="tool-diff-stat"
            title={`${diffStat.added} added · ${diffStat.removed} removed`}
          >
            {diffStat.added > 0 && <span className="tool-diff-stat-add">+{diffStat.added}</span>}
            {diffStat.removed > 0 && <span className="tool-diff-stat-del">-{diffStat.removed}</span>}
          </span>
        )}
        {taskStatusRaw && taskStatusChip(taskStatusRaw)}
        <span className="tool-status">
          {isRunning && <span className="tool-spinner" aria-label="running" />}
          {step.status === "done" && <span className="tool-check" title="done">✓</span>}
          {step.status === "error" && <span className="tool-x" title="error">✕</span>}
        </span>
        {hasBody && <span className="tool-chevron">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasBody && body}
    </div>
  );
}

function ToolActivity({ tools, onOpenPreview }: { tools: ToolStep[]; onOpenPreview: (t: PreviewRequest) => void }) {
  if (!tools || tools.length === 0) return null;
  const running = tools.filter((t) => t.status === "running").length;
  const done = tools.filter((t) => t.status === "done").length;
  const errored = tools.filter((t) => t.status === "error").length;
  return (
    <div className="tool-activity">
      <div className="tool-activity-summary">
        {running > 0 ? (
          <span className="tool-summary-running">
            <span className="tool-spinner" /> Running {running}
          </span>
        ) : (
          <span className="tool-summary-done">✓ {done + errored} tool{done + errored === 1 ? "" : "s"}</span>
        )}
        {running > 0 && (done > 0 || errored > 0) && (
          <span className="tool-summary-count">· {done} done{errored > 0 ? ` · ${errored} failed` : ""}</span>
        )}
      </div>
      {tools.map((step) => (
        <ToolStepCard key={step.id} step={step} onOpenPreview={onOpenPreview} />
      ))}
    </div>
  );
}

function ThinkingCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const hasRunningTool = (message.tools ?? []).some((t) => t.status === "running");
  // Show the card while the model is reasoning (streaming, no answer text yet,
  // no tool actively running) AND/OR once reasoning text has arrived. Unlike the
  // old indicator, this is NOT suppressed just because completed tools exist —
  // the post-tool thinking gap is exactly when it matters most.
  const isThinking =
    message.status === "streaming" && !message.content && !hasRunningTool;
  const hasText = Boolean(message.thinking && message.thinking.length > 0);
  if (!isThinking && !hasText) return null;

  return (
    <div className={`thinking-card${isThinking ? " thinking-card--active" : ""}`}>
      <button
        className="thinking-card-header"
        type="button"
        onClick={() => hasText && setOpen((o) => !o)}
        aria-expanded={open}
      >
        {isThinking ? (
          <span className="tool-spinner" />
        ) : (
          <span className="thinking-card-icon">💭</span>
        )}
        <span className="thinking-card-title">Thinking</span>
        {message.thinkingTokens ? (
          <span className="thinking-card-tokens">
            {formatTokens(message.thinkingTokens)} tokens
          </span>
        ) : null}
        {hasText && <span className="tool-chevron">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasText && <pre className="thinking-card-body">{message.thinking}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers + usage stats
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function formatDuration(ms?: number): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

function formatCost(usd?: number): string {
  if (usd == null) return "";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <span className={`stat-chip${accent ? " stat-chip--accent" : ""}`} title={label}>
      <span className="stat-chip-label">{label}</span>
      <span className="stat-chip-value">{value}</span>
    </span>
  );
}

function UsageStats({ usage }: { usage: MessageUsage }) {
  const totalIn = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const chips = [
    <Stat key="in" label="input" value={formatTokens(usage.inputTokens)} />,
    usage.cacheReadTokens > 0 && (
      <Stat key="cr" label="cache read" value={formatTokens(usage.cacheReadTokens)} />
    ),
    usage.cacheCreationTokens > 0 && (
      <Stat key="cc" label="cache write" value={formatTokens(usage.cacheCreationTokens)} />
    ),
    <Stat key="out" label="output" value={formatTokens(usage.outputTokens)} accent />,
    usage.costUsd != null && <Stat key="cost" label="cost" value={formatCost(usage.costUsd)} />,
    usage.durationMs != null && (
      <Stat key="dur" label="time" value={formatDuration(usage.durationMs)} />
    ),
    usage.numTurns != null && usage.numTurns > 1 && (
      <Stat key="turns" label="turns" value={String(usage.numTurns)} />
    ),
  ].filter(Boolean);

  if (chips.length === 0) return null;
  return (
    <div className={`usage-stats${usage.live ? " usage-stats--live" : ""}`}>
      <span className="usage-stats-arrow" title={`total in: ${formatTokens(totalIn)}`}>↗</span>
      {chips}
      {usage.model && (
        <span className="usage-stats-model" title="model">{usage.model}</span>
      )}
    </div>
  );
}

export default function MessageBubble({ message, onOpenPreview }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className={`message-enter flex ${isUser ? "justify-end" : "justify-start"} mb-4`}
    >
      <div
        className={`min-w-0 max-w-[80%] overflow-hidden rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-[var(--bg-user-msg)] rounded-br-sm"
            : "bg-[var(--bg-assistant-msg)] rounded-bl-sm"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--text-primary)] text-sm leading-relaxed m-0">
            {message.content}
          </p>
        ) : (
          <>
            {message.tools && message.tools.length > 0 && (
              <ToolActivity tools={message.tools} onOpenPreview={onOpenPreview} />
            )}

            <ThinkingCard message={message} />

            <div
              className={`markdown-body text-sm text-[var(--text-primary)] ${
                message.status === "streaming" ? "streaming-cursor" : ""
              }`}
            >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a({ href, children, ...props }) {
                  if (typeof href === "string" && /^https?:\/\//i.test(href)) {
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpenPreview({ kind: "url", url: href });
                        }}
                        className="text-[var(--accent)] hover:underline"
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  }
                  return <a href={href} {...props}>{children}</a>;
                },
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const codeString = String(children).replace(/\n$/, "");

                  if (match) {
                    return (
                      <div className="code-block-wrapper">
                        <div className="code-block-header">
                          <span>{match[1]}</span>
                          <CopyButton text={codeString} />
                        </div>
                        <SyntaxHighlighter
                          style={oneDark}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{
                            margin: 0,
                            borderRadius: "0 0 8px 8px",
                            fontSize: "0.85em",
                            // Scroll long lines horizontally inside the bubble
                            // instead of stretching it past its max width.
                            overflowX: "auto",
                            maxWidth: "100%",
                          }}
                        >
                          {codeString}
                        </SyntaxHighlighter>
                      </div>
                    );
                  }

                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
              }}
            >
              {message.content || " "}
            </ReactMarkdown>
            </div>
          </>
        )}

        <div className="flex items-center gap-2 mt-2">
          <span className="text-[10px] text-[var(--text-secondary)] opacity-70">
            {time}
          </span>
          {message.status === "error" && (
            <span className="text-[10px] text-red-400">Error</span>
          )}
          {message.status === "streaming" && (
            <span className="text-[10px] text-[var(--accent)]">Streaming...</span>
          )}
        </div>

        {!isUser && message.usage && <UsageStats usage={message.usage} />}
      </div>
    </div>
  );
}
