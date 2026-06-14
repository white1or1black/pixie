import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import InputBar from "./components/InputBar";
import Settings from "./components/Settings";
import MarketplacePanel from "./components/MarketplacePanel";
import ScheduledTasksPanel from "./components/ScheduledTasksPanel";
import FileExplorer from "./components/RightPanel";
import { useChat } from "./hooks/useChat";
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import type { ModelConfig, SkillEntry, TaskRunRecord } from "./types";

function SplashScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-primary)]">
      <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center mb-6">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M16 4C9.37 4 4 9.37 4 16s5.37 12 12 12 12-5.37 12-12S22.63 4 16 4z" fill="var(--accent)" opacity="0.15" />
          <path d="M20.5 13.5c0 1.38-1.12 2.5-2.5 2.5s-2.5-1.12-2.5-2.5S16.62 11 18 11s2.5 1.12 2.5 2.5zM13 19c0-1.66 1.34-3 3-3s3 1.34 3 3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
      </div>
      <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-3">Pixie</h1>
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-[var(--text-secondary)]">Initializing...</span>
      </div>
    </div>
  );
}

function ClaudeNotAvailable({ status, onRetry }: { status: import("./types").ClaudeStatus; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-primary)] px-6">
      <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-6">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M16 4L2 28h28L16 4z" stroke="#ef4444" strokeWidth="2" fill="none" />
          <path d="M16 12v8M16 22v2" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">Claude CLI Not Found</h2>
      <p className="text-sm text-[var(--text-secondary)] text-center max-w-md mb-2">
        The Claude CLI binary could not be found. Please install it first.
      </p>
      {status.error && <p className="text-xs text-red-400 text-center max-w-md mb-4">{status.error}</p>}
      <div className="flex gap-3">
        <button onClick={onRetry} className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors">Retry</button>
        <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm font-medium transition-colors hover:opacity-80">Installation Guide</a>
      </div>
    </div>
  );
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("agent-cli-theme");
    return (stored as "dark" | "light") ?? "dark";
  });
  const [systemPrompt, setSystemPrompt] = useState(() => {
    return localStorage.getItem("agent-cli-system-prompt") ?? "";
  });
  const [modelConfig, setModelConfig] = useState<ModelConfig>(() => {
    try {
      const stored = localStorage.getItem("agent-cli-model-config");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [skills, setSkills] = useState<SkillEntry[]>([]);

  const {
    conversations,
    activeConversation,
    activeId,
    isGenerating,
    generatingIds,
    claudeStatus,
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    error,
    addWorkspace,
    removeWorkspace,
    switchWorkspace,
    createConversation,
    switchConversation,
    deleteConversation,
    sendMessage,
    stopGeneration,
    refreshClaudeStatus,
    clearError,
    addScheduledRun,
  } = useChat(modelConfig);

  const {
    tasks: scheduledTasks,
    runs: taskRuns,
    create: createTask,
    update: updateTask,
    remove: deleteTask,
    toggle: toggleTask,
    runNow: runTaskNow,
  } = useScheduledTasks();

  // Surface completed scheduled runs as conversations in their workspace, so the
  // result is viewable like any chat. On first load we seed the seen-set with all
  // existing run ids so historical runs are NOT backfilled into the sidebar — only
  // runs that complete after the app started watching get injected.
  const seenRunIds = useRef<Set<string>>(new Set());
  const runsPrimed = useRef(false);
  useEffect(() => {
    if (!runsPrimed.current) {
      taskRuns.forEach((r) => seenRunIds.current.add(r.id));
      runsPrimed.current = true;
      return;
    }
    taskRuns.forEach((r: TaskRunRecord) => {
      if (!seenRunIds.current.has(r.id)) {
        seenRunIds.current.add(r.id);
        addScheduledRun(r);
      }
    });
  }, [taskRuns, addScheduledRun]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("agent-cli-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("agent-cli-system-prompt", systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    localStorage.setItem("agent-cli-model-config", JSON.stringify(modelConfig));
  }, [modelConfig]);

  // Load skills for the skills picker: user-level always, project-level when a
  // workspace is active. `reloadSkills` is reused after a plugin install/uninstall
  // so the ✨ dropdown picks up newly added skills.
  const reloadSkills = useCallback(() => {
    invoke<SkillEntry[]>("list_skills", { workspace: activeWorkspace?.path ?? null })
      .then(setSkills)
      .catch((err) => {
        console.error("list_skills failed", err);
        setSkills([]);
      });
  }, [activeWorkspace?.path]);

  useEffect(() => {
    reloadSkills();
  }, [reloadSkills]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "n") {
        e.preventDefault();
        createConversation();
      }
      if (e.key === "Escape" && isGenerating) {
        e.preventDefault();
        stopGeneration();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createConversation, isGenerating, stopGeneration]);

  const handleThemeChange = useCallback((t: "dark" | "light") => setTheme(t), []);
  const handleSystemPromptChange = useCallback((prompt: string) => setSystemPrompt(prompt), []);
  const handleModelConfigChange = useCallback((c: ModelConfig) => setModelConfig(c), []);

  // Show splash while loading
  if (claudeStatus === null) {
    return <SplashScreen />;
  }

  if (!claudeStatus.available) {
    return <ClaudeNotAvailable status={claudeStatus} onRetry={refreshClaudeStatus} />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Sidebar
        conversations={conversations}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        activeId={activeId}
        generatingIds={generatingIds}
        onSelect={switchConversation}
        onNew={createConversation}
        onDelete={deleteConversation}
        onAddWorkspace={addWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onSwitchWorkspace={switchWorkspace}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenTasks={() => setTasksOpen(true)}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)]">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((prev) => !prev)}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
              title="Toggle sidebar (Ctrl+B)"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <h1 className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {activeConversation?.title ?? "Pixie"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMarketplaceOpen(true)}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
              title="Skills marketplace"
            >
              {/* Store icon */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l1.5-5h15L21 9" />
                <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
                <path d="M9 13h6" />
              </svg>
            </button>
            <button
              onClick={() => setFileExplorerOpen((prev) => !prev)}
              disabled={!activeWorkspace}
              className={`p-1.5 rounded-lg transition-colors ${
                fileExplorerOpen
                  ? "bg-[var(--bg-tertiary)] text-[var(--accent)]"
                  : "hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
              } disabled:opacity-30 disabled:cursor-not-allowed`}
              title={activeWorkspace ? "Toggle preview panel" : "Add a workspace first"}
            >
              {/* Right side-panel toggle */}
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <line x1="13" y1="4" x2="13" y2="16" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          </div>
        </header>

        {error && (
          <div className="shrink-0 px-4 py-2 bg-red-900/30 border-b border-red-800/50 text-red-300 text-xs flex items-center justify-between">
            <span>{error}</span>
            <button onClick={clearError} className="text-red-400 hover:text-red-200 transition-colors">Dismiss</button>
          </div>
        )}

        <ChatView conversation={activeConversation} isGenerating={isGenerating} />

        <InputBar
          onSend={sendMessage}
          onStop={() => stopGeneration()}
          isGenerating={isGenerating}
          disabled={!activeWorkspace}
          disabledHint="Add a workspace to start chatting"
          skills={skills}
        />
      </div>

      {settingsOpen && (
        <Settings
          claudeStatus={claudeStatus}
          onRefreshStatus={refreshClaudeStatus}
          theme={theme}
          onThemeChange={handleThemeChange}
          onClose={() => setSettingsOpen(false)}
          systemPrompt={systemPrompt}
          onSystemPromptChange={handleSystemPromptChange}
          modelConfig={modelConfig}
          onModelConfigChange={handleModelConfigChange}
        />
      )}

      {fileExplorerOpen && activeWorkspace?.path && (
        <FileExplorer
          workspacePath={activeWorkspace.path}
          onClose={() => setFileExplorerOpen(false)}
        />
      )}

      {tasksOpen && (
        <ScheduledTasksPanel
          workspaces={workspaces}
          tasks={scheduledTasks}
          runs={taskRuns}
          onCreate={createTask}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onToggle={toggleTask}
          onRunNow={runTaskNow}
          onClose={() => setTasksOpen(false)}
        />
      )}

      {marketplaceOpen && (
        <MarketplacePanel
          onClose={() => setMarketplaceOpen(false)}
          onSkillsChanged={reloadSkills}
        />
      )}
    </div>
  );
}