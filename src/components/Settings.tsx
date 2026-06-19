import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { EngineStatus, AgentEngineId, EngineModelConfigs } from "../types";
import { AGENT_ENGINES, ENGINE_MODEL_FIELDS } from "../types";
import { useUpdater } from "../hooks/useUpdater";

// Brand mark — same art as the app/README icon.
const iconUrl = new URL("../assets/icon.svg", import.meta.url).href;

interface SettingsProps {
  engineStatuses: EngineStatus[] | null;
  onRefreshStatus: () => void;
  defaultEngine: AgentEngineId;
  onDefaultEngineChange: (engine: AgentEngineId) => void;
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
  onClose: () => void;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  engineModelConfigs: EngineModelConfigs;
  onEngineModelConfigChange: (
    engine: AgentEngineId,
    patch: Record<string, string | undefined>,
  ) => void;
  defaultWorkspacePath: string;
  onPickDefaultWorkspace: () => void;
  onResetDefaultWorkspace: () => void;
}

export default function Settings({
  engineStatuses,
  onRefreshStatus,
  defaultEngine,
  onDefaultEngineChange,
  theme,
  onThemeChange,
  onClose,
  systemPrompt,
  onSystemPromptChange,
  engineModelConfigs,
  onEngineModelConfigChange,
  defaultWorkspacePath,
  onPickDefaultWorkspace,
  onResetDefaultWorkspace,
}: SettingsProps) {
  const [_checking, setChecking] = useState(false);
  const [expandedEngines, setExpandedEngines] = useState<Record<AgentEngineId, boolean>>({
    claude: false,
    cursor: false,
    codebuddy: false,
  });
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

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
          {/* Agent engines */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Agent Engines
            </h3>
            <div className="space-y-3">
              {engineStatuses ? (
                engineStatuses.map((status) => (
                  <div
                    key={status.id}
                    className="bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-color)]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ${
                          status.available ? "bg-green-400" : "bg-red-400"
                        }`}
                      />
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {status.display_name}
                      </span>
                    </div>
                    {status.version && (
                      <p className="text-xs text-[var(--text-secondary)]">
                        Version: {status.version}
                      </p>
                    )}
                    {status.path && (
                      <p className="text-xs text-[var(--text-secondary)] break-all">
                        Path: {status.path}
                      </p>
                    )}
                    {status.error && (
                      <p className="text-xs text-red-400">{status.error}</p>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">Checking...</p>
              )}
              <button
                onClick={handleRefresh}
                disabled={_checking}
                className="px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 text-xs text-[var(--text-primary)] transition-colors disabled:opacity-50"
              >
                {_checking ? "Checking..." : "Refresh"}
              </button>
            </div>
          </section>

          {/* Preferred engine for new sessions */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Preferred Engine
            </h3>
            <select
              value={defaultEngine}
              onChange={(e) => onDefaultEngineChange(e.target.value as AgentEngineId)}
              className="w-full text-sm rounded-xl px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]"
            >
              {AGENT_ENGINES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              New sessions use this engine. Existing sessions keep their bound engine.
            </p>
          </section>

          {/* Working directory */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Working Directory
            </h3>
            <div className="bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-color)]">
              <p className="text-xs text-[var(--text-secondary)] break-all font-mono mb-3">
                {defaultWorkspacePath || "—"}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={onPickDefaultWorkspace}
                  className="px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 text-xs text-[var(--text-primary)] transition-colors"
                >
                  Change…
                </button>
                <button
                  onClick={onResetDefaultWorkspace}
                  className="px-3 py-1.5 rounded-lg bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] border border-[var(--border-color)] transition-colors"
                >
                  Reset to ~/.pixie
                </button>
              </div>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-2">
              The folder Pixie uses when none is selected. Applied on a fresh start with no
              workspaces added — existing workspaces are not changed.
            </p>
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

          {/* Model Configuration (per engine, collapsed by default) */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Model Configuration
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              Environment overrides per engine. Leave empty to use system defaults.
            </p>
            <div className="space-y-2">
              {AGENT_ENGINES.map(({ id, label }) => {
                const expanded = expandedEngines[id];
                const fields = ENGINE_MODEL_FIELDS[id];
                const config = engineModelConfigs[id] as Record<string, string | undefined>;
                const filledCount = fields.filter((f) => config[f.key]?.trim()).length;

                return (
                  <div
                    key={id}
                    className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border-color)] overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedEngines((prev) => ({ ...prev, [id]: !prev[id] }))
                      }
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-tertiary)]/40 transition-colors"
                    >
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {label}
                        </span>
                        {!expanded && filledCount > 0 && (
                          <span className="ml-2 text-[10px] text-[var(--text-secondary)]">
                            {filledCount} override{filledCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        className={`shrink-0 text-[var(--text-secondary)] transition-transform ${
                          expanded ? "rotate-180" : ""
                        }`}
                      >
                        <path
                          d="M3 5l4 4 4-4"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>

                    {expanded && (
                      <div className="px-4 pb-4 space-y-3 border-t border-[var(--border-color)]">
                        <p className="text-[10px] text-[var(--text-secondary)] pt-3">
                          Applies only to {label} sessions.
                        </p>
                        {fields.map(({ key, label: fieldLabel, secret }) => (
                          <div key={key}>
                            <label className="block text-xs text-[var(--text-secondary)] mb-1">
                              {fieldLabel}{" "}
                              <code className="text-[10px] opacity-60">{key}</code>
                            </label>
                            <input
                              type={secret ? "password" : "text"}
                              value={config[key] ?? ""}
                              onChange={(e) =>
                                onEngineModelConfigChange(id, {
                                  [key]: e.target.value || undefined,
                                })
                              }
                              placeholder={`$${key}`}
                              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)] transition-colors font-mono"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
              placeholder="Enter a system prompt for the agent..."
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
              <p className="text-xs text-[var(--text-secondary)]">
                Version: {appVersion || "0.1.1"}
              </p>

              {/* Update check */}
              <div className="pt-2 mt-1 border-t border-[var(--border-color)]">
                {updater.status === "up-to-date" && (
                  <p className="text-xs text-[var(--text-secondary)] mb-2">
                    You&apos;re on the latest version.
                  </p>
                )}
                {updater.status === "available" && updater.newVersion && (
                  <p className="text-xs text-[var(--text-primary)] mb-2">
                    Pixie {updater.newVersion} is available.
                  </p>
                )}
                {updater.status === "downloading" &&
                  updater.contentLength > 0 && (
                    <p className="text-xs text-[var(--text-secondary)] mb-2">
                      Downloading…{" "}
                      {Math.round(
                        (updater.downloaded / updater.contentLength) * 100
                      )}
                      %
                    </p>
                  )}
                {updater.status === "installed" && (
                  <p className="text-xs text-[var(--text-primary)] mb-2">
                    Update ready. Restart to apply.
                  </p>
                )}
                {updater.status === "error" && updater.error && (
                  <p className="text-xs text-red-400 mb-2 break-all">
                    {updater.error}
                  </p>
                )}
                <button
                  onClick={
                    updater.status === "available"
                      ? updater.downloadAndInstall
                      : updater.status === "installed"
                        ? updater.restart
                        : updater.checkForUpdates
                  }
                  disabled={
                    updater.status === "checking" ||
                    updater.status === "downloading"
                  }
                  className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {updater.status === "checking"
                    ? "Checking…"
                    : updater.status === "downloading"
                      ? "Downloading…"
                      : updater.status === "available"
                        ? `Install ${updater.newVersion}`
                        : updater.status === "installed"
                          ? "Restart Now"
                          : "Check for Updates"}
                </button>
              </div>
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
