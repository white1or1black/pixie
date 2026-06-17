import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDragRegion } from "./hooks/useDragRegion";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import InputBar from "./components/InputBar";
import Settings from "./components/Settings";
import MarketplacePanel from "./components/MarketplacePanel";
import ScheduledTasksPanel from "./components/ScheduledTasksPanel";
import FileExplorer from "./components/RightPanel";
import { openExternal } from "./openExternal";
import { useChat } from "./hooks/useChat";
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import type {
  EngineModelConfigs,
  PreviewRequest,
  PreviewTarget,
  SkillEntry,
  TaskRunRecord,
  EngineStatus,
} from "./types";
import { AGENT_ENGINES } from "./types";
import { bootstrap, getConfig, updateConfig } from "./lib/storage";

// Brand mark — same art as the app/README icon.
const iconUrl = new URL("./assets/icon.svg", import.meta.url).href;

function SplashScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-primary)]">
      <img
        src={iconUrl}
        alt="Pixie"
        className="w-16 h-16 rounded-2xl mb-6"
      />
      <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-3">Pixie</h1>
      <div className="flex items-center gap-2">
        <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <span className="text-sm text-[var(--text-secondary)]">Initializing...</span>
      </div>
    </div>
  );
}

function NoEngineAvailable({
  statuses,
  onRetry,
}: {
  statuses: EngineStatus[];
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-screen bg-[var(--bg-primary)] px-6">
      <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-6">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <path d="M16 4L2 28h28L16 4z" stroke="#ef4444" strokeWidth="2" fill="none" />
          <path d="M16 12v8M16 22v2" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">No Agent Engine Available</h2>
      <p className="text-sm text-[var(--text-secondary)] text-center max-w-md mb-4">
        Install at least one agent CLI (Claude Code or Cursor Agent) to use Pixie.
      </p>
      <div className="w-full max-w-md space-y-2 mb-4">
        {statuses.map((s) => (
          <div key={s.id} className="text-xs text-[var(--text-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2">
            <span className="font-medium text-[var(--text-primary)]">{s.display_name}</span>
            {" — "}
            {s.available ? "available" : s.error ?? "not found"}
          </div>
        ))}
      </div>
      <div className="flex gap-3">
        <button onClick={onRetry} className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors">Retry</button>
        <a href="https://docs.anthropic.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm font-medium transition-colors hover:opacity-80">Claude Code</a>
        <a href="https://cursor.com/docs/cli/overview" target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm font-medium transition-colors hover:opacity-80">Cursor CLI</a>
      </div>
    </div>
  );
}

function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [headerEditing, setHeaderEditing] = useState(false);
  const [headerEditValue, setHeaderEditValue] = useState("");
  const headerEditRef = useRef<HTMLInputElement>(null);
  const handleDragRegion = useDragRegion();
  // Externally-requested preview target (a path/URL clicked in a chat message).
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  // Which full-page view the main column shows. The sidebar buttons switch
  // this; New Agent / selecting a conversation returns to "chat".
  const [mainView, setMainView] = useState<"chat" | "tasks" | "skills" | "settings">("chat");
  const [theme, setTheme] = useState<"dark" | "light">(() => getConfig().theme);
  const [systemPrompt, setSystemPrompt] = useState(() => getConfig().systemPrompt);
  const [engineModelConfigs, setEngineModelConfigs] = useState<EngineModelConfigs>(
    () => getConfig().engineModelConfigs,
  );
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Composer drafts are kept per conversation (keyed by conversation id, derived
  // below once activeId is known) so each session binds its own input and
  // switching between them never clears what you've typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const {
    unifiedConversations,
    activeConversation,
    activeId,
    isGenerating,
    generatingIds,
    engineStatuses,
    anyEngineAvailable,
    defaultEngine,
    setDefaultEngine,
    defaultWorkspacePath,
    changeDefaultWorkspace,
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    workspaceFilter,
    setWorkspaceFilter,
    error,
    addWorkspace,
    removeWorkspace,
    createConversation,
    switchConversation,
    renameConversation,
    deleteConversation,
    sendMessage,
    stopGeneration,
    respondPermission,
    refreshEngineStatuses,
    clearError,
    addScheduledRun,
    addRunningTask,
  } = useChat(engineModelConfigs);

  // Per-conversation composer draft. Keyed by the active conversation id so each
  // session keeps its own input; a workspace-level scratch key covers the brief
  // window before any conversation exists (e.g. a brand-new workspace).
  const draftKey = activeId ?? `ws:${activeWorkspaceId ?? ""}`;
  const draft = drafts[draftKey] ?? "";
  const handleDraftChange = useCallback(
    (value: string) => setDrafts((prev) => ({ ...prev, [draftKey]: value })),
    [draftKey]
  );

  const commitHeaderEdit = useCallback(() => {
    const trimmed = headerEditValue.trim();
    if (trimmed && activeConversation && trimmed !== activeConversation.title) {
      renameConversation(activeConversation.id, trimmed);
    }
    setHeaderEditing(false);
  }, [headerEditValue, activeConversation, renameConversation]);

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
    updateConfig({ theme });
  }, [theme]);

  useEffect(() => {
    updateConfig({ systemPrompt });
  }, [systemPrompt]);

  useEffect(() => {
    updateConfig({ engineModelConfigs });
  }, [engineModelConfigs]);

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
        setMainView("chat");
        createConversation(undefined, defaultEngine);
      }
      if (e.key === "Escape" && isGenerating) {
        e.preventDefault();
        stopGeneration();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setMainView((prev) => (prev === "settings" ? "chat" : "settings"));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createConversation, defaultEngine, isGenerating, stopGeneration]);

  const handleThemeChange = useCallback((t: "dark" | "light") => setTheme(t), []);
  const handleSystemPromptChange = useCallback((prompt: string) => setSystemPrompt(prompt), []);
  const handleEngineModelConfigChange = useCallback(
    (engine: keyof EngineModelConfigs, patch: Record<string, string | undefined>) => {
      setEngineModelConfigs((prev) => ({
        ...prev,
        [engine]: { ...prev[engine], ...patch },
      }));
    },
    [],
  );

  const handlePickDefaultWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string | null>("pick_folder");
      if (path) await changeDefaultWorkspace(path);
    } catch { /* ignore */ }
  }, [changeDefaultWorkspace]);
  const handleResetDefaultWorkspace = useCallback(() => {
    changeDefaultWorkspace(null);
  }, [changeDefaultWorkspace]);

  // Open a file path or URL in the right-side preview panel (clicked in a chat
  // message). The nonce lets the same target be re-opened.
  // Open a file path or URL from a chat message. URLs are delegated to the
  // system default browser (Pixie no longer embeds a browser); file paths open
  // in the right-side preview panel. The nonce lets the same file be re-opened.
  const handleOpenPreview = useCallback((t: PreviewRequest) => {
    if (t.kind === "url") {
      void openExternal(t.url);
      return;
    }
    const nonce = Date.now();
    setPreviewTarget({ kind: "file", path: t.path, nonce });
    setFileExplorerOpen(true);
  }, []);

  // Show splash while loading
  if (engineStatuses === null) {
    return <SplashScreen />;
  }

  if (!anyEngineAvailable) {
    return <NoEngineAvailable statuses={engineStatuses} onRetry={refreshEngineStatuses} />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Sidebar
        entries={unifiedConversations}
        workspaces={workspaces}
        defaultWorkspacePath={defaultWorkspacePath}
        workspaceFilter={workspaceFilter}
        activeId={activeId}
        generatingIds={generatingIds}
        onSelect={(id, workspaceId) => {
          setMainView("chat");
          switchConversation(id, workspaceId);
        }}
        onNew={(workspaceId) => {
          setMainView("chat");
          createConversation(workspaceId, defaultEngine);
        }}
        defaultEngine={defaultEngine}
        onDefaultEngineChange={setDefaultEngine}
        engineStatuses={engineStatuses}
        onDelete={deleteConversation}
        onRename={renameConversation}
        onAddWorkspace={addWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onSetWorkspaceFilter={setWorkspaceFilter}
        onOpenSettings={() => setMainView("settings")}
        onOpenTasks={() => setMainView("tasks")}
        onOpenSkills={() => setMainView("skills")}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {mainView === "chat" && (
          <>
            {/* Header — drag empty areas to move window */}
            <header
              className={`shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)] ${navigator.platform?.includes("Mac") && !sidebarOpen ? "pl-20" : ""}`}
              onMouseDown={handleDragRegion}
            >
              <div className="flex items-center gap-3">
                {!sidebarOpen && (
                  <button
                    onClick={() => {
                      setMainView("chat");
                      createConversation(undefined, defaultEngine);
                    }}
                    disabled={!activeWorkspace}
                    className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="New session (Ctrl+N)"
                  >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => setSidebarOpen((prev) => !prev)}
                  className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
                  title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
                >
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
                <div className="min-w-0">
                  {headerEditing ? (
                    <input
                      ref={headerEditRef}
                      type="text"
                      value={headerEditValue}
                      onChange={(e) => setHeaderEditValue(e.target.value)}
                      onBlur={commitHeaderEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitHeaderEdit();
                        if (e.key === "Escape") setHeaderEditing(false);
                      }}
                      className="text-sm font-semibold text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--accent)] rounded px-1 py-0 outline-none w-full"
                    />
                  ) : (
                    <h1
                      className="text-sm font-semibold text-[var(--text-primary)] truncate"
                      onDoubleClick={() => {
                        if (activeConversation) {
                          setHeaderEditValue(activeConversation.title);
                          setHeaderEditing(true);
                          setTimeout(() => headerEditRef.current?.select(), 0);
                        }
                      }}
                    >
                      {activeConversation?.title ?? "Pixie"}
                    </h1>
                  )}
                  {(activeConversation ||
                    (activeWorkspace && activeWorkspace.path !== defaultWorkspacePath)) && (
                    <p className="text-[10px] text-[var(--text-secondary)] truncate" title={activeWorkspace?.path}>
                      {activeWorkspace && activeWorkspace.path !== defaultWorkspacePath && (
                        <>
                          📁 {activeWorkspace.name}
                          {activeConversation && <span className="mx-1">·</span>}
                        </>
                      )}
                      {activeConversation && (
                        <span className="text-[var(--accent)]/80">
                          {AGENT_ENGINES.find((e) => e.id === activeConversation.engine)?.label ?? activeConversation.engine}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
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

            <ChatView conversation={activeConversation} isGenerating={isGenerating} onOpenPreview={handleOpenPreview} onRespondPermission={respondPermission} />

            <InputBar
              onSend={sendMessage}
              onStop={() => stopGeneration()}
              isGenerating={isGenerating}
              disabled={!activeWorkspace}
              disabledHint="Add a workspace to send"
              value={draft}
              onChange={handleDraftChange}
              textareaRef={composerRef}
              skills={skills}
              workspacePath={activeWorkspace?.path ?? null}
            />
          </>
        )}

        {mainView === "tasks" && (
          <ScheduledTasksPanel
            workspaces={workspaces}
            tasks={scheduledTasks}
            runs={taskRuns}
            onCreate={createTask}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onToggle={toggleTask}
            onRunNow={async (taskId) => {
              try {
                const convId = await runTaskNow(taskId);
                const task = scheduledTasks.find((t) => t.id === taskId);
                if (task && convId) {
                  addRunningTask({
                    id: convId,
                    taskName: task.name,
                    prompt: task.prompt,
                    workspace: task.workspace,
                  });
                  setMainView("chat");
                }
              } catch (e) {
                console.error("run now failed", e);
              }
            }}
            onClose={() => setMainView("chat")}
          />
        )}

        {mainView === "skills" && (
          <MarketplacePanel
            onClose={() => setMainView("chat")}
            onSkillsChanged={reloadSkills}
          />
        )}

        {mainView === "settings" && (
          <Settings
            engineStatuses={engineStatuses}
            onRefreshStatus={refreshEngineStatuses}
            defaultEngine={defaultEngine}
            onDefaultEngineChange={setDefaultEngine}
            theme={theme}
            onThemeChange={handleThemeChange}
            onClose={() => setMainView("chat")}
            systemPrompt={systemPrompt}
            onSystemPromptChange={handleSystemPromptChange}
            engineModelConfigs={engineModelConfigs}
            onEngineModelConfigChange={handleEngineModelConfigChange}
            defaultWorkspacePath={defaultWorkspacePath}
            onPickDefaultWorkspace={handlePickDefaultWorkspace}
            onResetDefaultWorkspace={handleResetDefaultWorkspace}
          />
        )}
      </div>

      {/* The right panel stays mounted while a workspace is active and is just
          hidden via `display` when closed, so its state survives close/reopen.
          It is NOT keyed by workspace, so the per-workspace terminals mounted
          inside it also persist across workspace switches. */}
      {activeWorkspace?.path && (
        <div className="h-full" style={{ display: fileExplorerOpen ? "block" : "none" }}>
          <FileExplorer
            workspacePath={activeWorkspace.path}
            previewTarget={previewTarget}
          />
        </div>
      )}
    </div>
  );
}

/** Outer shell: load/migrate persisted state from disk before mounting AppShell.
 *  The real tree (including useChat, which seeds React state from getConfig()/
 *  getHistory()) only mounts once bootstrap() has resolved, so those reads see
 *  populated data instead of defaults. Shows the splash while loading. */
export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    bootstrap()
      .then(() => {
        if (alive) setReady(true);
      })
      .catch((e) => {
        // Don't hang on the splash forever — proceed with defaults so the app
        // is usable even if disk I/O fails.
        console.error("[storage] bootstrap failed", e);
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!ready) return <SplashScreen />;
  return <AppShell />;
}