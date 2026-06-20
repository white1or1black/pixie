import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useDragRegion } from "./hooks/useDragRegion";
import Sidebar from "./components/Sidebar";
import InputBar from "./components/InputBar";
import { openExternal } from "./openExternal";
import { useChat } from "./hooks/useChat";
import EngineBadge from "./components/EngineBadge";

// Lazy-load heavy panels that aren't needed on initial render or during
// workspace/conversation switches.  React renders the fallback (loading
// indicator) immediately, giving the user a responsive feel while the chunk
// loads or the component re-mounts after a workspace switch.
const ChatView = lazy(() => import("./components/ChatView"));
const Settings = lazy(() => import("./components/Settings"));
const MarketplacePanel = lazy(() => import("./components/MarketplacePanel"));
const ScheduledTasksPanel = lazy(() => import("./components/ScheduledTasksPanel"));
const FileExplorer = lazy(() => import("./components/RightPanel"));
import { useScheduledTasks } from "./hooks/useScheduledTasks";
import type {
  AgentEngineId,
  AuthState,
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

/** Lightweight loading indicator shown while lazy-loaded panels mount. */
function LoadingPanel() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

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

/// Per-engine install + login commands shown on the setup screen. Cursor has no
/// official npm package — its install is the curl script from cursor.com/cli.
const ENGINE_SETUP_INFO: Record<
  AgentEngineId,
  { install: string; login: string; loginHint?: string; docs: string }
> = {
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    login: "claude auth login",
    loginHint: "浏览器完成 Anthropic 登录后回来点「重新检测」",
    docs: "https://docs.claude.com/en/docs/claude-code",
  },
  cursor: {
    install: "curl https://cursor.com/install -fsS | bash",
    login: "cursor-agent login",
    loginHint: "会打开浏览器完成 Cursor 登录",
    docs: "https://cursor.com/cli",
  },
  codebuddy: {
    install: "npm install -g @tencent-ai/codebuddy-code",
    login: "cbc login",
    loginHint: "选择登录方式，浏览器完成认证",
    docs: "https://www.codebuddy.ai/docs/cli/quickstart",
  },
};

function CommandRow({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-xs font-mono text-[var(--text-primary)] bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2 overflow-x-auto whitespace-nowrap">
        {command}
      </code>
      <button
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
        }}
        className="shrink-0 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs font-medium transition-colors hover:opacity-80"
      >
        {copied ? "已复制" : label}
      </button>
    </div>
  );
}

function EngineCard({
  engineId,
  label,
  status,
  onProbe,
  onLogin,
  onInstall,
}: {
  engineId: AgentEngineId;
  label: string;
  status: EngineStatus | undefined;
  onProbe: (id: AgentEngineId) => void;
  onLogin: (id: AgentEngineId) => void;
  onInstall: (id: AgentEngineId) => Promise<{ success: boolean; output: string }>;
}) {
  const info = ENGINE_SETUP_INFO[engineId];
  const installed = !!status?.available;
  const authState: AuthState = status?.auth_state ?? "unknown";
  const ready = installed && authState === "ready";
  const notReady = installed && !ready;
  const probing = installed && authState === "unknown";
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const handleInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const res = await onInstall(engineId);
      if (!res.success) setInstallError(res.output || "安装失败，请用下方命令手动安装");
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="border border-[var(--border-color)] rounded-xl p-4 bg-[var(--bg-primary)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate">{label}</span>
          {installed && status?.version && (
            <span className="text-[10px] text-[var(--text-secondary)] shrink-0">v{status.version}</span>
          )}
        </div>
        {installed ? (
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${
              ready
                ? "text-emerald-400 bg-emerald-500/10"
                : "text-amber-400 bg-amber-500/10"
            }`}
          >
            {ready ? "就绪" : probing ? "检测中…" : "未就绪"}
          </span>
        ) : (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full text-[var(--text-secondary)] bg-[var(--bg-tertiary)] shrink-0">
            未安装
          </span>
        )}
      </div>

      {!installed && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              onClick={handleInstall}
              disabled={installing}
              className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors disabled:opacity-50"
            >
              {installing ? "安装中…" : "一键安装"}
            </button>
            {installing && (
              <div className="w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            )}
          </div>
          {installError && (
            <p className="text-xs text-red-400 break-all whitespace-pre-wrap">{installError}</p>
          )}
          <details className="text-[11px] text-[var(--text-secondary)]">
            <summary className="cursor-pointer hover:text-[var(--text-primary)]">
              手动安装（复制命令到终端运行）
            </summary>
            <div className="mt-1">
              <CommandRow command={info.install} label="复制" />
            </div>
          </details>
        </div>
      )}

      {probing && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <div className="w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          正在发送 ping 检测就绪状态…
        </div>
      )}

      {ready && <p className="text-xs text-emerald-400">已就绪，可以使用。</p>}

      {notReady && !probing && (
        <div className="space-y-2">
          <p className="text-xs text-amber-400">未就绪。点「一键登录」在浏览器登录，完成后点「重新检测」。</p>
          <div className="flex gap-2">
            <button
              onClick={() => onLogin(engineId)}
              className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors"
            >
              一键登录
            </button>
            <button
              onClick={() => onProbe(engineId)}
              className="px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs font-medium transition-colors hover:opacity-80"
            >
              重新检测
            </button>
          </div>
          <CommandRow command={info.login} label="复制登录命令" />
          {info.loginHint && (
            <p className="text-[11px] text-[var(--text-secondary)]">{info.loginHint}</p>
          )}
          {status?.probe_error && (
            <p className="text-[11px] text-[var(--text-secondary)] break-all">
              引擎返回：{status.probe_error}
            </p>
          )}
        </div>
      )}

      {installed && ready && (
        <div className="flex justify-end mt-1">
          <button
            onClick={() => onProbe(engineId)}
            className="text-xs px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium transition-colors hover:opacity-80"
          >
            重新检测
          </button>
        </div>
      )}
    </div>
  );
}

function EngineSetup({
  statuses,
  onProbe,
  onLogin,
  onInstall,
  onClose,
}: {
  statuses: EngineStatus[];
  onProbe: (id: AgentEngineId) => void;
  onLogin: (id: AgentEngineId) => void;
  onInstall: (id: AgentEngineId) => Promise<{ success: boolean; output: string }>;
  onClose: () => void;
}) {
  const anyReady = statuses.some((s) => s.available && s.auth_state === "ready");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)] shadow-2xl">
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2">
            <img src={iconUrl} alt="Pixie" className="w-7 h-7 rounded-lg" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">配置 Agent 引擎</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
            aria-label="关闭"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <p className="text-sm text-[var(--text-secondary)] mb-2">
            Pixie 不自带模型，安装并登录一个引擎即可。检测就绪 = 能成功 ping 通该模型。
          </p>
          {AGENT_ENGINES.map((e) => (
            <EngineCard
              key={e.id}
              engineId={e.id}
              label={e.label}
              status={statuses.find((s) => s.id === e.id)}
              onProbe={onProbe}
              onLogin={onLogin}
              onInstall={onInstall}
            />
          ))}
          <p className="text-[11px] text-[var(--text-secondary)] pt-1">
            提示：检测会向引擎发送一条 ping 消息，可能产生极少量调用费用。
          </p>
        </div>

        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-[var(--border-color)]">
          <span className={`text-xs ${anyReady ? "text-emerald-400" : "text-[var(--text-secondary)]"}`}>
            {anyReady ? "已有引擎就绪" : "还没有就绪的引擎"}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors"
          >
            进入应用
          </button>
        </div>
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
  /** Engine-setup modal visibility. Auto-opens on first launch when no engine is
   *  ready; otherwise opened manually from Settings. Does NOT auto-close when an
   *  engine becomes ready — the user closes it (so they can see the state flip). */
  const [setupOpen, setSetupOpen] = useState(false);
  /** Has the first-launch "auto-open if nothing ready" check run yet. Tracked
   *  with state (not a ref) so it can drive a render-time setState — the React
   *  "adjust state during render" pattern — without tripping effect/ref rules. */
  const [initialChecked, setInitialChecked] = useState(false);

  const {
    unifiedConversations,
    activeConversation,
    activeId,
    isGenerating,
    generatingIds,
    engineStatuses,
    anyEngineReady,
    readyEngineIds,
    probeEngineStatus,
    engineLogin,
    installEngine,
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
    setConversationModel,
    deleteConversation,
    sendMessage,
    stopGeneration,
    respondPermission,
    refreshEngineStatuses,
    clearError,
    addScheduledRun,
    addRunningTask,
  } = useChat(engineModelConfigs);

  // On first launch: if no engine is ready (none installed, or none logged in),
  // pop the engine-setup modal automatically. Evaluated exactly once via the
  // React "adjust state during render" pattern — after this the modal is only
  // opened manually from Settings, and it does NOT auto-close when an engine
  // later becomes ready.
  if (!initialChecked && engineStatuses !== null) {
    setInitialChecked(true);
    if (!anyEngineReady) setSetupOpen(true);
  }

  // Probe any installed engine whose readiness is still unknown — on first load
  // and whenever the setup modal opens (so a dropped/stale probe is retried
  // instead of leaving the card stuck on "检测中"). The in-flight guard prevents
  // concurrent duplicate pings; resolved engines (auth_state != unknown) are
  // skipped, so there is no re-probe loop.
  const probingSetupRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!engineStatuses) return;
    for (const s of engineStatuses) {
      if (!s.available) continue;
      if ((s.auth_state ?? "unknown") !== "unknown") continue;
      if (probingSetupRef.current.has(s.id)) continue;
      probingSetupRef.current.add(s.id);
      void probeEngineStatus(s.id).finally(() => probingSetupRef.current.delete(s.id));
    }
  }, [engineStatuses, setupOpen, probeEngineStatus]);

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

  const handleModelChange = useCallback((model: string | undefined) => {
    if (activeConversation) setConversationModel(activeConversation.id, model);
  }, [activeConversation, setConversationModel]);

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

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {setupOpen && (
        <EngineSetup
          statuses={engineStatuses}
          onProbe={probeEngineStatus}
          onLogin={engineLogin}
          onInstall={installEngine}
          onClose={() => setSetupOpen(false)}
        />
      )}
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
        onNew={(opts) => {
          setMainView("chat");
          createConversation(opts?.workspaceId, opts?.engine ?? defaultEngine, opts?.model);
        }}
        defaultEngine={defaultEngine}
        onDefaultEngineChange={setDefaultEngine}
        engineModelConfigs={engineModelConfigs}
        readyEngineIds={readyEngineIds}
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
              className={`relative shrink-0 flex items-center px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)] ${navigator.platform?.includes("Mac") && !sidebarOpen ? "pl-20" : ""}`}
              onMouseDown={handleDragRegion}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
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
                <div className="min-w-0 flex-1">
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
                    <div className="flex items-center gap-1.5">
                      <h1 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                        {activeConversation?.title ?? "Pixie"}
                      </h1>
                      {activeConversation && (
                        <button
                          onClick={() => {
                            setHeaderEditValue(activeConversation.title);
                            setHeaderEditing(true);
                            setTimeout(() => headerEditRef.current?.select(), 0);
                          }}
                          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                          title="Edit title"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M10.5 1.5l2 2-9 9H1.5v-2l9-9zM13.5 4.5l-2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                  {(activeWorkspace || activeConversation) && (
                    <p className="text-[10px] text-[var(--text-secondary)] truncate" title={activeWorkspace?.path ?? undefined}>
                      {activeWorkspace && defaultWorkspacePath && activeWorkspace.path !== defaultWorkspacePath && (
                        <>
                          📁 {activeWorkspace.name}
                          {activeConversation && <span className="mx-1">·</span>}
                        </>
                      )}
                      {activeConversation && (
                        <EngineBadge engine={activeConversation.engine} />
                      )}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setFileExplorerOpen((prev) => !prev)}
                disabled={!activeWorkspace}
                className={`shrink-0 ml-2 p-1.5 rounded-lg bg-[var(--bg-primary)] transition-colors ${
                  fileExplorerOpen
                    ? "text-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                } disabled:opacity-30 disabled:cursor-not-allowed`}
                title={activeWorkspace ? "Toggle preview panel" : "Add a workspace first"}
              >
                {/* Right side-panel toggle */}
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <line x1="13" y1="4" x2="13" y2="16" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </header>

            {error && (
              <div className="shrink-0 px-4 py-2 bg-red-900/30 border-b border-red-800/50 text-red-300 text-xs flex items-center justify-between">
                <span>{error}</span>
                <button onClick={clearError} className="text-red-400 hover:text-red-200 transition-colors">Dismiss</button>
              </div>
            )}

            <Suspense fallback={<LoadingPanel />}>
              <ChatView conversation={activeConversation} isGenerating={isGenerating} onOpenPreview={handleOpenPreview} onRespondPermission={respondPermission} />
            </Suspense>

            <InputBar
              onSend={(msg, images) => sendMessage(msg, undefined, images)}
              onStop={() => stopGeneration()}
              isGenerating={isGenerating}
              disabled={!activeWorkspace}
              disabledHint="Add a workspace to send"
              value={draft}
              onChange={handleDraftChange}
              textareaRef={composerRef}
              skills={skills}
              workspacePath={activeWorkspace?.path ?? null}
              engine={activeConversation?.engine}
              model={activeConversation?.model}
              onModelChange={handleModelChange}
              engineModelConfigs={engineModelConfigs}
            />
          </>
        )}

        {mainView === "tasks" && (
          <Suspense fallback={<LoadingPanel />}>
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
          </Suspense>
        )}

        {mainView === "skills" && (
          <Suspense fallback={<LoadingPanel />}>
          <MarketplacePanel
            onClose={() => setMainView("chat")}
            onSkillsChanged={reloadSkills}
          />
          </Suspense>
        )}

        {mainView === "settings" && (
          <Suspense fallback={<LoadingPanel />}>
          <Settings
            engineStatuses={engineStatuses}
            readyEngineIds={readyEngineIds}
            onRefreshStatus={refreshEngineStatuses}
            onOpenSetup={() => setSetupOpen(true)}
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
          </Suspense>
        )}
      </div>

      {/* The right panel stays mounted while a workspace is active and is just
          hidden via `display` when closed, so its state survives close/reopen.
          It is NOT keyed by workspace, so the per-workspace terminals mounted
          inside it also persist across workspace switches. */}
      {activeWorkspace?.path && (
        <div className="h-full" style={{ display: fileExplorerOpen ? "block" : "none" }}>
          <Suspense fallback={<LoadingPanel />}>
          <FileExplorer
            workspacePath={activeWorkspace.path}
            previewTarget={previewTarget}
          />
          </Suspense>
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