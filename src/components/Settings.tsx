import { useState } from "react";
import type { ClaudeStatus, ModelConfig } from "../types";

// Brand mark — same art as the app/README icon.
const iconUrl = new URL("../assets/icon.svg", import.meta.url).href;

interface SettingsProps {
  claudeStatus: ClaudeStatus | null;
  onRefreshStatus: () => void;
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
  onClose: () => void;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  modelConfig: ModelConfig;
  onModelConfigChange: (config: ModelConfig) => void;
}

export default function Settings({
  claudeStatus,
  onRefreshStatus,
  theme,
  onThemeChange,
  onClose,
  systemPrompt,
  onSystemPromptChange,
  modelConfig,
  onModelConfigChange,
}: SettingsProps) {
  const [_checking, setChecking] = useState(false);

  const handleRefresh = async () => {
    setChecking(true);
    await onRefreshStatus();
    setChecking(false);
  };

  return (
    <div className="settings-enter flex flex-col flex-1 min-h-0 bg-[var(--bg-secondary)]">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="currentColor"
            >
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Claude CLI Status */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Claude CLI
            </h3>
            <div className="bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-color)]">
              {claudeStatus ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        claudeStatus.available ? "bg-green-400" : "bg-red-400"
                      }`}
                    />
                    <span className="text-sm text-[var(--text-primary)]">
                      {claudeStatus.available ? "Available" : "Not Found"}
                    </span>
                  </div>
                  {claudeStatus.version && (
                    <p className="text-xs text-[var(--text-secondary)]">
                      Version: {claudeStatus.version}
                    </p>
                  )}
                  {claudeStatus.path && (
                    <p className="text-xs text-[var(--text-secondary)] break-all">
                      Path: {claudeStatus.path}
                    </p>
                  )}
                  {claudeStatus.error && (
                    <p className="text-xs text-red-400">{claudeStatus.error}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                  Checking...
                </p>
              )}
              <button
                onClick={handleRefresh}
                disabled={_checking}
                className="mt-3 px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 text-xs text-[var(--text-primary)] transition-colors disabled:opacity-50"
              >
                {_checking ? "Checking..." : "Refresh"}
              </button>
            </div>
          </section>

          {/* Theme */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Theme
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => onThemeChange("dark")}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                  theme === "dark"
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--bg-primary)] text-[var(--text-secondary)] border border-[var(--border-color)]"
                }`}
              >
                Dark
              </button>
              <button
                onClick={() => onThemeChange("light")}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                  theme === "light"
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--bg-primary)] text-[var(--text-secondary)] border border-[var(--border-color)]"
                }`}
              >
                Light
              </button>
            </div>
          </section>

          {/* Model Configuration */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Model Configuration
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              Set environment variables to override the default Claude model.
              Leave empty to use system defaults.
            </p>
            <div className="space-y-3">
              {([
                { key: "ANTHROPIC_API_KEY", label: "API Key" },
                { key: "ANTHROPIC_BASE_URL", label: "Base URL" },
                { key: "ANTHROPIC_MODEL", label: "Default Model" },
                { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus Model" },
                { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet Model" },
                { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku Model" },
                { key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent Model" },
                { key: "CLAUDE_CODE_EFFORT_LEVEL", label: "Effort Level" },
              ] as { key: keyof ModelConfig; label: string }[]).map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
                    {label} <code className="text-[10px] opacity-60">{key}</code>
                  </label>
                  <input
                    type={key === "ANTHROPIC_API_KEY" ? "password" : "text"}
                    value={modelConfig[key] ?? ""}
                    onChange={(e) =>
                      onModelConfigChange({ ...modelConfig, [key]: e.target.value || undefined })
                    }
                    placeholder={`$` + key}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)] transition-colors font-mono"
                  />
                </div>
              ))}
            </div>
          </section>

          {/* System Prompt */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              System Prompt
            </h3>
            <textarea
              value={systemPrompt}
              onChange={(e) => onSystemPromptChange(e.target.value)}
              placeholder="Enter a system prompt for Claude..."
              rows={4}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] resize-none outline-none focus:border-[var(--accent)] transition-colors"
            />
          </section>

          {/* About */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              About
            </h3>
            <div className="bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-color)] space-y-1">
              <div className="flex items-center gap-2">
                <img src={iconUrl} alt="Pixie" className="w-8 h-8 rounded-lg" />
                <p className="text-sm text-[var(--text-primary)]">Pixie</p>
              </div>
              <p className="text-xs text-[var(--text-secondary)]">
                A desktop AI chat application powered by the Claude CLI.
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Built with Tauri v2 + React + TypeScript
              </p>
            </div>
          </section>

          {/* Keyboard shortcuts */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Keyboard Shortcuts
            </h3>
            <div className="space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex justify-between">
                <span>New chat</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+N
                </kbd>
              </div>
              <div className="flex justify-between">
                <span>Stop generation</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  Escape
                </kbd>
              </div>
              <div className="flex justify-between">
                <span>Send message</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  Enter
                </kbd>
              </div>
              <div className="flex justify-between">
                <span>New line</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  Shift+Enter
                </kbd>
              </div>
              <div className="flex justify-between">
                <span>Toggle sidebar</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+B
                </kbd>
              </div>
              <div className="flex justify-between">
                <span>Settings</span>
                <kbd className="px-2 py-0.5 rounded bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]">
                  {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+,
                </kbd>
              </div>
            </div>
          </section>
        </div>
    </div>
  );
}
