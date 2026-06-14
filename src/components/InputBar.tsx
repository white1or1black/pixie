import { useState, useRef, useEffect, useCallback } from "react";
import SkillsDropdown from "./SkillsDropdown";
import type { SkillEntry } from "../types";

interface InputBarProps {
  onSend: (message: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  disabledHint?: string;
  skills: SkillEntry[];
}

const MAX_CHARS = 8000;

export default function InputBar({
  onSend,
  onStop,
  isGenerating,
  disabled = false,
  disabledHint,
  skills,
}: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
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
    const maxLines = 8;
    const maxHeight = lineHeight * maxLines;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isGenerating || disabled) return;
    onSend(trimmed);
    setValue("");
  }, [value, isGenerating, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

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

  // Insert the picked skill's invocation ("/skill-name ") into the input.
  const handleSelectSkill = useCallback((skill: SkillEntry) => {
    setValue((prev) => {
      const inv = skill.invocation; // "/skill-name "
      if (prev.trim().length === 0) return inv;
      const sep = prev.endsWith(" ") || prev.endsWith("\n") ? "" : " ";
      return prev + sep + inv;
    });
    setDropdownOpen(false);
    // Refocus the textarea and place the caret at the end. The auto-resize
    // effect (keyed on `value`) re-runs after setValue commits.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const toggleDropdown = useCallback(() => setDropdownOpen((v) => !v), []);

  const charCount = value.length;
  const nearLimit = charCount > MAX_CHARS * 0.9;

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div ref={containerRef} className="relative">
          {dropdownOpen && (
            <SkillsDropdown
              skills={skills}
              onSelect={handleSelectSkill}
              onClose={() => setDropdownOpen(false)}
            />
          )}
          <div className="flex items-end gap-2 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl px-4 py-2 focus-within:border-[var(--accent)] transition-colors">
            <button
              type="button"
              onClick={toggleDropdown}
              disabled={disabled || isGenerating}
              title="Browse skills"
              className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors self-end mb-0.5"
            >
              {/* Sparkles icon */}
              <svg
                width="18"
                height="18"
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
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                disabled
                  ? (disabledHint ?? "Input disabled")
                  : isGenerating
                    ? "Waiting for response..."
                    : "Type a message... (Enter to send, Shift+Enter for newline)"
              }
              disabled={disabled || isGenerating}
              rows={1}
              className="flex-1 bg-transparent text-[var(--text-primary)] placeholder-[var(--text-secondary)] resize-none outline-none text-sm leading-6 py-0.5 max-h-[192px]"
            />

            {isGenerating ? (
              <button
                onClick={onStop}
                className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors"
                title="Stop generation (Escape)"
              >
                {/* Stop square icon */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!value.trim() || disabled}
                className="shrink-0 flex items-center justify-center w-9 h-9 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed text-white transition-colors"
                title="Send message (Enter)"
              >
                {/* Arrow up icon */}
                <svg
                  width="16"
                  height="16"
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
            {isGenerating ? "Generating..." : disabled ? (disabledHint ?? "") : ""}
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
