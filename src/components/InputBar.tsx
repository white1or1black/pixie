import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import SkillsDropdown from "./SkillsDropdown";
import type { SkillEntry, AgentEngineId, EngineModelConfigs, ModelEntry } from "../types";
import { ENGINE_MODEL_ENV_KEY } from "../types";

interface InputBarProps {
  onSend: (message: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  disabledHint?: string;
  value: string;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  skills: SkillEntry[];
  /** Active workspace folder path (= Claude's CWD). Used to render @mentions
   *  relative to the project so they resolve cleanly. null when no workspace. */
  workspacePath?: string | null;
  /** Engine of the active conversation. */
  engine?: AgentEngineId;
  /** Current model override for the active conversation. */
  model?: string;
  /** Called when the user picks a different model. */
  onModelChange: (model: string | undefined) => void;
  /** Global engine model configs (for showing default model label). */
  engineModelConfigs: EngineModelConfigs;
}

const MAX_CHARS = 8000;

/** Trailing path segment (cross-platform): the part after the last separator. */
function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Express an absolute file path relative to the workspace when it lives inside
 *  it, otherwise return it unchanged (absolute). Claude Code resolves @mentions
 *  against its CWD — the workspace — so relative paths read cleanly and resolve. */
function toWorkspaceRelative(absPath: string, workspace?: string | null): string {
  if (!workspace) return absPath;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(workspace);
  const abs = norm(absPath);
  if (abs === base) return ".";
  if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
  return absPath;
}

export default function InputBar({
  onSend,
  onStop,
  isGenerating,
  disabled = false,
  disabledHint,
  value,
  onChange,
  textareaRef,
  skills,
  workspacePath,
  engine,
  model,
  onModelChange,
  engineModelConfigs,
}: InputBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [customModelInput, setCustomModelInput] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [dragActive, setDragActive] = useState(false);
  /** Absolute file paths staged as attachments. On send these become @mentions
   *  appended to the message so Claude Code pulls them in as context. */
  const [attachments, setAttachments] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close any open dropdown the moment the input becomes disabled (e.g. the
  // active workspace is removed). Adjusting state during render avoids a
  // setState-in-effect; React discards the in-progress render and re-renders.
  if (disabled && dropdownOpen) {
    setDropdownOpen(false);
  }

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 24;
    const minLines = 1;
    const maxLines = 8;
    const min = lineHeight * minLines;
    const max = lineHeight * maxLines;
    el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`;
  }, [value, textareaRef]);

  // Whether drops / picks should currently be accepted. Read from a ref so the
  // window-wide drag listener (subscribed once, below) never holds a stale
  // closure as `disabled` / `isGenerating` toggle.
  const acceptInputRef = useRef(false);
  useEffect(() => {
    acceptInputRef.current = !disabled && !isGenerating;
  }, [disabled, isGenerating]);

  const addAttachments = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setAttachments((prev) => {
      const seen = new Set(prev);
      const next = [...prev];
      for (const p of paths) {
        if (p && !seen.has(p)) {
          seen.add(p);
          next.push(p);
        }
      }
      return next;
    });
  }, []);

  const removeAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((p) => p !== path));
  }, []);

  // Native file drag-and-drop. Tauri intercepts OS-level drops and emits the
  // real file paths here (the webview's own HTML5 drop event only yields fake
  // `C:\fakepath\...` paths). Subscribed once on mount; the accept gate lives
  // in acceptInputRef so we don't resubscribe on every state change.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: UnlistenFn | undefined;
    win.onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter" || payload.type === "over") {
        setDragActive(true);
      } else if (payload.type === "leave") {
        setDragActive(false);
      } else if (payload.type === "drop") {
        setDragActive(false);
        if (!acceptInputRef.current) return;
        addAttachments(payload.paths);
      }
    }).then((un) => {
      unlisten = un;
    });
    return () => {
      unlisten?.();
    };
  }, [addAttachments]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (isGenerating || disabled) return;
    if (!trimmed && attachments.length === 0) return;
    // Compose @mentions for each staged file, relative to the workspace when
    // possible so they read cleanly and resolve against Claude's CWD.
    const mentions = attachments
      .map((p) => "@" + toWorkspaceRelative(p, workspacePath))
      .join("\n");
    const finalMessage = trimmed
      ? mentions
        ? `${trimmed}\n\n${mentions}`
        : trimmed
      : mentions;
    onSend(finalMessage);
    onChange("");
    setAttachments([]);
  }, [value, attachments, isGenerating, disabled, onSend, onChange, workspacePath]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        // While a CJK IME (e.g. pinyin) is mid-composition, Enter confirms the
        // candidate into the textarea — it must NOT submit the message. Allow
        // the default composition-confirm behavior by bailing out entirely.
        // `isComposing` is the standard signal; keyCode 229 is the legacy
        // fallback some platforms emit during composition.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Open the native multi-file picker; returned paths are staged as attachments.
  const handlePickFiles = useCallback(async () => {
    if (disabled || isGenerating) return;
    try {
      const result = await invoke<string[] | null>("pick_files");
      if (result && result.length > 0) addAttachments(result);
    } catch {
      /* ignore picker errors / cancellations */
    }
  }, [disabled, isGenerating, addAttachments]);

  // Close the skills dropdown when clicking outside of it.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dropdownOpen]);

  // Close the model dropdown when clicking outside of it.
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
        setCustomModelInput("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelDropdownOpen]);

  // Fetch available models lazily — only when the model dropdown opens.
  const fetchModels = useCallback(() => {
    if (!engine) return;
    invoke<ModelEntry[]>("list_models", { engine })
      .then((models) => {
        setAvailableModels(models);
      })
      .catch(() => {
        setAvailableModels([]);
      });
  }, [engine]);

  useEffect(() => {
    if (modelDropdownOpen && engine) {
      setCustomModelInput("");
      fetchModels();
    }
  }, [modelDropdownOpen, engine, fetchModels]);

  const handleSelectModel = useCallback((modelId: string | undefined) => {
    onModelChange(modelId);
    setModelDropdownOpen(false);
    setCustomModelInput("");
  }, [onModelChange]);

  // Insert the picked skill's invocation ("/skill-name ") into the draft.
  const handleSelectSkill = useCallback((skill: SkillEntry) => {
    const inv = skill.invocation;
    const next =
      value.trim().length === 0
        ? inv
        : value + (value.endsWith(" ") || value.endsWith("\n") ? "" : " ") + inv;
    onChange(next);
    setDropdownOpen(false);
    // Refocus the textarea and place the caret at the end. The auto-resize
    // effect (keyed on `value`) re-runs after onChange commits.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [value, onChange, textareaRef]);

  const toggleDropdown = useCallback(() => setDropdownOpen((v) => !v), []);

  const charCount = value.length;
  const nearLimit = charCount > MAX_CHARS * 0.9;
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
      <div className="max-w-4xl mx-auto w-full">
        <div ref={containerRef} className="relative">
          {dropdownOpen && (
            <SkillsDropdown
              skills={skills}
              onSelect={handleSelectSkill}
              onClose={() => setDropdownOpen(false)}
            />
          )}

          {modelDropdownOpen && engine && (
            <div className="absolute bottom-full left-2 mb-2 w-52 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 py-1 max-h-64 overflow-y-auto">
              {/* Default option */}
              <button
                type="button"
                onClick={() => handleSelectModel(undefined)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                  !model ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                }`}
              >
                Default{engineModelConfigs[engine]?.[ENGINE_MODEL_ENV_KEY[engine]] ? ` (${engineModelConfigs[engine][ENGINE_MODEL_ENV_KEY[engine]]})` : ""}
              </button>
              {/* Presets */}
              {availableModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => handleSelectModel(m.id)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                    model === m.id ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                  }`}
                >
                  {m.label}
                  {m.id !== m.label && <span className="ml-1.5 text-[var(--text-secondary)] opacity-60">{m.id}</span>}
                </button>
              ))}
              {/* Custom model input */}
              <div className="border-t border-[var(--border-color)] mt-1 pt-1 px-2">
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customModelInput.trim()) {
                        e.preventDefault();
                        handleSelectModel(customModelInput.trim());
                      }
                    }}
                    placeholder="Custom model..."
                    className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]/50 outline-none focus:border-[var(--accent)]"
                    autoFocus
                  />
                  {customModelInput.trim() && (
                    <button
                      type="button"
                      onClick={() => handleSelectModel(customModelInput.trim())}
                      className="text-[10px] text-[var(--accent)] hover:underline shrink-0"
                    >
                      Apply
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2 px-1">
              {attachments.map((path) => {
                const rel = toWorkspaceRelative(path, workspacePath);
                return (
                  <span
                    key={path}
                    className="inline-flex items-center gap-1 max-w-[240px] pl-2 pr-1 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-xs text-[var(--text-primary)]"
                    title={rel}
                  >
                    {/* File icon */}
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="shrink-0 opacity-70"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span className="truncate">{basename(path)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(path)}
                      title="Remove"
                      className="shrink-0 flex items-center justify-center w-4 h-4 rounded text-[var(--text-secondary)] hover:bg-[var(--border-color)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M1 1l8 8M9 1l-8 8" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div
            className={`flex items-end gap-1.5 bg-[var(--bg-secondary)] border rounded-2xl px-3 py-2 focus-within:border-[var(--accent)] transition-colors ${
              dragActive
                ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40 bg-[var(--bg-tertiary)]"
                : "border-[var(--border-color)]"
            }`}
          >
            {/* Left action buttons: Attach, Skills, Model */}
            <div className="flex flex-col gap-0.5 shrink-0 pb-0.5">
              {/* Attach files (native picker) */}
              <button
                type="button"
                onClick={handlePickFiles}
                disabled={disabled || isGenerating}
                title="Attach files"
                className="flex items-center justify-center w-7 h-7 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              {/* Skills */}
              <button
                type="button"
                onClick={toggleDropdown}
                disabled={disabled || isGenerating}
                title="Browse skills"
                className="flex items-center justify-center w-7 h-7 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z" />
                </svg>
              </button>
              {/* Model selection */}
              {engine && (
                <button
                  type="button"
                  onClick={() => { if (!isGenerating) setModelDropdownOpen((v) => !v); }}
                  disabled={isGenerating}
                  title="Select model"
                  className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${
                    model
                      ? "text-[var(--accent)] bg-[var(--accent)]/10"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  } ${isGenerating ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <line x1="9" y1="2" x2="9" y2="4" />
                    <line x1="15" y1="2" x2="15" y2="4" />
                    <line x1="9" y1="20" x2="9" y2="22" />
                    <line x1="15" y1="20" x2="15" y2="22" />
                    <line x1="2" y1="9" x2="4" y2="9" />
                    <line x1="2" y1="15" x2="4" y2="15" />
                    <line x1="20" y1="9" x2="22" y2="9" />
                    <line x1="20" y1="15" x2="22" y2="15" />
                  </svg>
                </button>
              )}
            </div>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                disabled
                  ? (disabledHint ?? "Type a message… (add a workspace to send)")
                  : isGenerating
                    ? "Type next message… (Enter to send, Shift+Enter for newline)"
                    : "Type a message... (Enter to send, Shift+Enter for newline)"
              }
              rows={3}
              className="flex-1 self-stretch bg-transparent text-[var(--text-primary)] placeholder-[var(--text-secondary)] resize-none outline-none text-sm leading-6 max-h-[192px]"
            />

            {isGenerating ? (
              <button
                onClick={onStop}
                className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors self-end"
                title="Stop generation (Escape)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors self-end"
                title="Send message (Enter)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 2L14 9H10V14H6V9H2L8 2Z" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="flex justify-between items-center mt-1 px-1">
          <span className="text-[10px] text-[var(--text-secondary)] opacity-60">
            {isGenerating
              ? "Generating..."
              : dragActive
                ? "Drop files to attach…"
                : disabled
                  ? (disabledHint ?? "")
                  : ""}
          </span>
          {charCount > 0 && (
            <span
              className={`text-[10px] ${
                nearLimit ? "text-red-400" : "text-[var(--text-secondary)] opacity-60"
              }`}
            >
              {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
