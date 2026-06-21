import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import SkillsDropdown from "./SkillsDropdown";
import type { SkillEntry, AgentEngineId, EngineModelConfigs, ModelEntry } from "../types";
import { ENGINE_MODEL_ENV_KEY } from "../types";
import { getExtension, IMAGE_EXTENSIONS } from "../preview";

interface InputBarProps {
  onSend: (message: string, images?: string[]) => void;
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
  /** Whether knowledge base context is enabled for the next message. */
  kbEnabled: boolean;
  /** Toggle knowledge base context on/off. */
  onToggleKb: () => void;
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

/** Map an image MIME type to a file extension for the saved paste file. */
function mimeToExt(mime: string): string {
  const sub = mime.split("/")[1] ?? "";
  if (sub === "jpeg") return "jpg";
  return sub || "png";
}

/** Whether a staged attachment points at an image — previewable inline and
 *  eligible for a native image content block. Shares `IMAGE_EXTENSIONS` with the
 *  right-side preview panel so "image" means the same thing app-wide. */
const isImagePath = (path: string) => IMAGE_EXTENSIONS.has(getExtension(basename(path)));

/** Read a Blob as a bare base64 string (the data: URL prefix is stripped) so it
 *  can be sent compactly over IPC and decoded back to bytes by the backend. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read image"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
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
  kbEnabled,
  onToggleKb,
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
  const skillsWrapperRef = useRef<HTMLDivElement>(null);
  const modelWrapperRef = useRef<HTMLDivElement>(null);
  const modelDropdownListRef = useRef<HTMLDivElement>(null);

  const configuredDefaultModelId = useCallback((): string | undefined => {
    if (!engine) return undefined;
    const cfg = engineModelConfigs[engine] as Record<string, string | undefined>;
    const v = cfg?.[ENGINE_MODEL_ENV_KEY[engine]];
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed || undefined;
  }, [engine, engineModelConfigs]);

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
    // Image attachments are handed to the backend as paths (`images`): Claude/
    // CodeBuddy embed them as native image content blocks, Cursor as @mentions.
    // Other files still become @mentions relative to the workspace.
    const imagePaths = attachments.filter(isImagePath);
    const mentions = attachments
      .filter((p) => !isImagePath(p))
      .map((p) => "@" + toWorkspaceRelative(p, workspacePath))
      .join("\n");
    const finalMessage = trimmed
      ? mentions
        ? `${trimmed}\n\n${mentions}`
        : trimmed
      : mentions;
    onSend(finalMessage, imagePaths.length > 0 ? imagePaths : undefined);
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

  // Paste a screenshot / copied image. The clipboard image Blob is base64-encoded
  // and written to disk by the backend; the returned path is staged as an
  // attachment, so it ships to the agent as an absolute @mention just like a
  // dragged-in file. Honors the same accept gate as drag-and-drop.
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!acceptInputRef.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      // Array.from: DataTransferItemList is not iterable (no Symbol.iterator)
      // on some webviews (e.g. macOS WebKit).
      let sawImage = false;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          sawImage = true;
          try {
            const base64 = await blobToBase64(file);
            const path = await invoke<string>("save_pasted_image", {
              data: base64,
              ext: mimeToExt(item.type),
            });
            addAttachments([path]);
          } catch {
            /* ignore decode/write failures — paste silently no-ops */
          }
        }
      }
      // Swallow the default paste ONLY when there was an image, so plain text
      // pastes still land in the textarea and raw image bytes never leak in.
      if (sawImage) e.preventDefault();
    },
    [addAttachments]
  );

  // Close the skills dropdown when clicking outside of it.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // Close if click is outside the skills dropdown wrapper
      if (skillsWrapperRef.current && !skillsWrapperRef.current.contains(target)) {
        setDropdownOpen(false);
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", onDown);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [dropdownOpen]);

  // Close the model dropdown when clicking outside of it.
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (modelWrapperRef.current && !modelWrapperRef.current.contains(target)) {
        setModelDropdownOpen(false);
        setCustomModelInput("");
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", onDown);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [modelDropdownOpen]);

  // Ensure the model dropdown always opens scrolled to the top (avoid focusing
  // the custom input at the bottom auto-scrolling the list).
  useEffect(() => {
    if (!modelDropdownOpen) return;
    requestAnimationFrame(() => {
      modelDropdownListRef.current?.scrollTo({ top: 0 });
    });
  }, [modelDropdownOpen]);

  const fetchModelsForEngine = useCallback((engineId: AgentEngineId) => {
    invoke<ModelEntry[]>("list_models", { engine: engineId })
      .then((models) => {
        const seen = new Set<string>();
        const deduped: ModelEntry[] = [];
        for (const m of models) {
          const id = (m.id ?? "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          deduped.push({ ...m, id });
        }
        setAvailableModels(deduped);
      })
      .catch(() => {
        setAvailableModels([]);
      });
  }, []);

  // Keep a model list for the active engine so the default model label can be
  // shown even when the dropdown is closed.
  useEffect(() => {
    if (!engine) return;
    fetchModelsForEngine(engine);
  }, [engine, fetchModelsForEngine]);

  useEffect(() => {
    if (modelDropdownOpen && engine) {
      fetchModelsForEngine(engine);
    }
  }, [modelDropdownOpen, engine, fetchModelsForEngine]);

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

  const defaultModelLabel = (() => {
    if (!engine) return "Auto";
    const configured = configuredDefaultModelId();
    const fallback = availableModels[0]?.id;
    const id = configured ?? fallback;
    if (!id) return "Auto";
    return availableModels.find((m) => m.id === id)?.label ?? id;
  })();

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
      <div ref={containerRef} className="max-w-4xl mx-auto w-full">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 px-1">
            {attachments.map((path) => {
              const rel = toWorkspaceRelative(path, workspacePath);
              const isImg = isImagePath(path);
              return (
                <span
                  key={path}
                  className="inline-flex items-center gap-1 max-w-[240px] pl-2 pr-1 py-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-xs text-[var(--text-primary)]"
                  title={rel}
                >
                  {isImg ? (
                    // convertFileSrc routes through the Tauri asset protocol
                    // (enabled in tauri.conf.json) — a raw file:// <img> is
                    // blocked by the webview as cross-origin, which is why the
                    // thumbnail was blank before.
                    <img
                      src={convertFileSrc(path)}
                      alt={basename(path)}
                      className="shrink-0 w-6 h-6 rounded object-cover border border-[var(--border-color)]"
                    />
                  ) : (
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
                  )}
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
          className={`flex items-end bg-[var(--bg-secondary)] border rounded-2xl focus-within:border-[var(--accent)] transition-colors ${
            dragActive
              ? "border-[var(--accent)] ring-2 ring-[var(--accent)]/40 bg-[var(--bg-tertiary)]"
              : "border-[var(--border-color)]"
          }`}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              disabled
                ? (disabledHint ?? "Type a message… (add a workspace to send)")
                : isGenerating
                  ? "Type next message… (Enter to send, Shift+Enter for newline)"
                  : "Type a message... (Enter to send, Shift+Enter for newline)"
            }
            rows={3}
            className="flex-1 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-secondary)] resize-none outline-none text-sm leading-6 max-h-[192px] px-4 py-2.5"
          />

          {isGenerating ? (
            <button
              onClick={onStop}
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors mr-2 self-end mb-2"
              title="Stop generation (Escape)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors mr-2 self-end mb-2"
              title="Send message (Enter)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 2L14 9H10V14H6V9H2L8 2Z" />
              </svg>
            </button>
          )}
        </div>

        {/* Bottom action bar: Attach, Skills, Model */}
        <div className="flex items-center gap-0.5 mt-1 px-1">
          <button
            type="button"
            onClick={handlePickFiles}
            disabled={disabled || isGenerating}
            title="Attach files"
            className="flex items-center justify-center w-7 h-6 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Skills button + dropdown */}
          <div ref={skillsWrapperRef} className="relative">
            <button
              type="button"
              onClick={toggleDropdown}
              disabled={disabled || isGenerating}
              title="Browse skills"
              className="flex items-center justify-center w-7 h-6 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z" />
              </svg>
            </button>
            {dropdownOpen && (
              <SkillsDropdown
                skills={skills}
                onSelect={handleSelectSkill}
                onClose={() => setDropdownOpen(false)}
              />
            )}
          </div>

          {/* KB context toggle */}
          <button
            type="button"
            onClick={onToggleKb}
            disabled={disabled || isGenerating}
            title={kbEnabled ? "Knowledge base active — click to disable" : "Include knowledge base context"}
            className={`flex items-center justify-center w-7 h-6 rounded-md transition-colors ${
              kbEnabled
                ? "text-[var(--accent)] bg-[var(--accent)]/15"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            } disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            {/* Database icon — knowledge base retrieval */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="6" rx="8" ry="3" />
              <path d="M4 6v6c0 1.5 3.5 3 8 3s8-1.5 8-3V6" />
              <path d="M4 12v6c0 1.5 3.5 3 8 3s8-1.5 8-3v-6" />
            </svg>
          </button>
          {engine && (
            <div ref={modelWrapperRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (isGenerating) return;
                  setModelDropdownOpen((v) => {
                    const next = !v;
                    if (next) setCustomModelInput("");
                    return next;
                  });
                }}
                disabled={isGenerating}
                title="Select model"
                className={`flex items-center gap-1 h-6 px-1.5 rounded-md text-[11px] transition-colors ${
                  model
                    ? "text-[var(--accent)] bg-[var(--accent)]/10"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                } ${isGenerating ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                <span className="truncate max-w-[100px]">
                  {model
                    ? (availableModels.find((m) => m.id === model)?.label ?? model)
                    : defaultModelLabel}
                </span>
              </button>
              {modelDropdownOpen && (
                <div
                  ref={modelDropdownListRef}
                  className="absolute bottom-full left-0 mb-1 w-52 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 py-1 max-h-64 overflow-y-auto"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectModel(undefined)}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                      !model ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                    }`}
                  >
                    {defaultModelLabel} (auto)
                  </button>
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
            </div>
          )}

          <span className="flex-1" />
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
