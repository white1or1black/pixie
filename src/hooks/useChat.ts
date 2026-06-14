import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Conversation,
  Message,
  ClaudeStatus,
  ResponseChunk,
  ResponseDone,
  ResponseError,
  ResponseTool,
  ResponseUsage,
  ResponseThinking,
  ResponseThinkingText,
  MessageUsage,
  ToolStep,
  WorkspaceState,
  ModelConfig,
  TaskRunRecord,
} from "../types";

const DATA_KEY = "pixie-data";

interface AppData {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string | null;
  conversations: Record<string, Conversation[]>; // workspaceId → conversations
}

function generateId(): string {
  return crypto.randomUUID();
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { workspaces: [], activeWorkspaceId: null, conversations: {} };
}

function saveData(workspaces: WorkspaceState[], activeWorkspaceId: string | null, conversations: Record<string, Conversation[]>): void {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify({ workspaces, activeWorkspaceId, conversations }));
  } catch { /* ignore */ }
}

function generateTitle(content: string): string {
  const trimmed = content.trim().replace(/\n/g, " ");
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + "...";
}

export function useChat(modelConfig: ModelConfig) {
  const [workspaces, setWorkspaces] = useState<WorkspaceState[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [allConversations, setAllConversations] = useState<Record<string, Conversation[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards the persist effect: never save the empty initial state before the
  // initial load has restored saved data. Without this, under React StrictMode
  // (dev) the mount-time persist run writes empty state and wipes localStorage
  // before the load re-reads it — losing all chat history on every refresh.
  const [loaded, setLoaded] = useState(false);

  const unlistenRefs = useRef<Array<() => void>>([]);
  const activeIdRef = useRef<string | null>(activeId);
  const activeWorkspaceRef = useRef<WorkspaceState | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace;
  }, [activeWorkspace]);

  // Sync model config to Rust backend
  useEffect(() => {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(modelConfig)) {
      if (v) config[k] = v;
    }
    invoke("set_model_config", { config }).catch(() => {});
  }, [modelConfig]);

  // Load data
  useEffect(() => {
    const raw = loadData();

    // Normalize workspace identity to the folder path. Legacy entries used random
    // UUIDs, which made "delete + re-add the same folder" lose all its chats
    // (re-adding minted a new id). Keying by path lets re-adding restore them.
    const conversations: Record<string, Conversation[]> = {};
    const seen = new Set<string>();
    const workspaces: WorkspaceState[] = [];
    for (const w of raw.workspaces) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      workspaces.push({ ...w, id: w.path });
      const byOld = raw.conversations[w.id] ?? [];
      const byPath = raw.conversations[w.path] ?? [];
      conversations[w.path] = byPath.length >= byOld.length ? byPath : byOld;
    }
    const legacyActivePath = raw.workspaces.find((w) => w.id === raw.activeWorkspaceId)?.path;
    const activeWorkspaceId =
      legacyActivePath ??
      (raw.activeWorkspaceId && seen.has(raw.activeWorkspaceId) ? raw.activeWorkspaceId : null) ??
      workspaces[0]?.id ??
      null;

    setWorkspaces(workspaces);
    setActiveWorkspaceId(activeWorkspaceId);
    setAllConversations(conversations);
    const convs = activeWorkspaceId ? (conversations[activeWorkspaceId] ?? []) : [];
    setConversations(convs);
    if (convs.length > 0) {
      setActiveId(convs[0].id);
    }
    setLoaded(true);
  }, []);

  // Persist data — only after the initial load completes, so we never overwrite
  // saved history with the empty initial state.
  useEffect(() => {
    if (!loaded) return;
    saveData(workspaces, activeWorkspaceId, allConversations);
  }, [loaded, workspaces, activeWorkspaceId, allConversations]);

  // Sync active workspace to Rust backend
  useEffect(() => {
    if (activeWorkspace?.path) {
      invoke("set_active_workspace", { path: activeWorkspace.path }).catch(() => {});
    }
  }, [activeWorkspace?.path]);

  // Check Claude availability
  useEffect(() => {
    invoke<ClaudeStatus>("check_claude_available")
      .then((status) => setClaudeStatus(status))
      .catch(() =>
        setClaudeStatus({ available: false, error: "Failed to check Claude availability" })
      );
  }, []);

  // Listen to Tauri events
  useEffect(() => {
    let mounted = true;

    async function setup() {
      const u1 = await listen<ResponseChunk>("claude-response", (event) => {
        const chunk = event.payload;
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== chunk.conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant" && last.status === "streaming") {
              msgs[msgs.length - 1] = { ...last, content: last.content + chunk.content };
            }
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          })
        );
        // Also update allConversations
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          const convs = prev[wsId] ?? [];
          return {
            ...prev,
            [wsId]: convs.map((conv) => {
              if (conv.id !== chunk.conversation_id) return conv;
              const msgs = [...conv.messages];
              const last = msgs[msgs.length - 1];
              if (last && last.role === "assistant" && last.status === "streaming") {
                msgs[msgs.length - 1] = { ...last, content: last.content + chunk.content };
              }
              return { ...conv, messages: msgs, updatedAt: Date.now() };
            }),
          };
        });
      });

      const u2 = await listen<ResponseDone>("claude-done", (event) => {
        const done = event.payload;
        const updateConv = (convs: Conversation[]) =>
          convs.map((conv) => {
            if (conv.id !== done.conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, content: done.full_text, status: "done" };
            }
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          });

        setConversations((prev) => updateConv(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: updateConv(prev[wsId] ?? []) };
        });
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(done.conversation_id);
          return next;
        });
        setError(null);
      });

      const u3 = await listen<ResponseError>("claude-error", (event) => {
        const err = event.payload;
        setError(err.error);
        const errConv = (convs: Conversation[]) =>
          convs.map((conv) => {
            if (conv.id !== err.conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, status: "error" };
            }
            return { ...conv, messages: msgs };
          });

        setConversations((prev) => errConv(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: errConv(prev[wsId] ?? []) };
        });
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(err.conversation_id);
          return next;
        });
      });

      const u4 = await listen<ResponseTool>("claude-tool", (event) => {
        const tool = event.payload;
        // Apply a tool-step update to the last assistant message of the target conversation
        const applyTool = (convs: Conversation[]): Conversation[] =>
          convs.map((conv) => {
            if (conv.id !== tool.conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;
            const tools: ToolStep[] = [...(last.tools ?? [])];

            if (tool.kind === "start") {
              if (!tools.some((t) => t.id === tool.tool_use_id)) {
                let parsedInput: unknown;
                try {
                  parsedInput = tool.input ? JSON.parse(tool.input) : undefined;
                } catch {
                  parsedInput = undefined;
                }
                tools.push({
                  id: tool.tool_use_id,
                  name: tool.name ?? "tool",
                  status: "running",
                  input: parsedInput,
                  rawInput: tool.input,
                });
              }
            } else {
              const idx = tools.findIndex((t) => t.id === tool.tool_use_id);
              const status = tool.is_error ? "error" : "done";
              if (idx >= 0) {
                tools[idx] = { ...tools[idx], status, result: tool.content };
              } else {
                tools.push({
                  id: tool.tool_use_id,
                  name: tool.name ?? "tool",
                  status,
                  result: tool.content,
                });
              }
            }

            msgs[msgs.length - 1] = { ...last, tools };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          });

        setConversations((prev) => applyTool(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: applyTool(prev[wsId] ?? []) };
        });
      });

      const u5 = await listen<ResponseThinking>("claude-thinking", (event) => {
        const { conversation_id, tokens } = event.payload;
        const applyThink = (convs: Conversation[]): Conversation[] =>
          convs.map((conv) => {
            if (conv.id !== conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;
            msgs[msgs.length - 1] = { ...last, thinkingTokens: tokens };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          });
        setConversations((prev) => applyThink(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: applyThink(prev[wsId] ?? []) };
        });
      });

      const u6 = await listen<ResponseUsage>("claude-usage", (event) => {
        const u = event.payload;
        const applyUsage = (convs: Conversation[]): Conversation[] =>
          convs.map((conv) => {
            if (conv.id !== u.conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;

            let usage: MessageUsage;
            if (u.kind === "final") {
              // Authoritative totals from the result event
              usage = {
                inputTokens: u.input_tokens,
                outputTokens: u.output_tokens,
                cacheReadTokens: u.cache_read_tokens,
                cacheCreationTokens: u.cache_creation_tokens,
                costUsd: u.cost_usd,
                durationMs: u.duration_ms,
                numTurns: u.num_turns,
                model: u.model,
                stopReason: u.stop_reason,
                live: false,
              };
            } else {
              // Per-turn: accumulate into a running total
              const prev = last.usage ?? {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              };
              usage = {
                inputTokens: prev.inputTokens + u.input_tokens,
                outputTokens: prev.outputTokens + u.output_tokens,
                cacheReadTokens: prev.cacheReadTokens + u.cache_read_tokens,
                cacheCreationTokens: prev.cacheCreationTokens + u.cache_creation_tokens,
                live: true,
              };
            }
            msgs[msgs.length - 1] = { ...last, usage };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          });
        setConversations((prev) => applyUsage(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: applyUsage(prev[wsId] ?? []) };
        });
      });

      const u7 = await listen<ResponseThinkingText>("claude-thinking-text", (event) => {
        const { conversation_id, content } = event.payload;
        const applyThinkText = (convs: Conversation[]): Conversation[] =>
          convs.map((conv) => {
            if (conv.id !== conversation_id) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;
            const prev = last.thinking ?? "";
            msgs[msgs.length - 1] = {
              ...last,
              thinking: prev ? `${prev}\n\n${content}` : content,
            };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          });
        setConversations((prev) => applyThinkText(prev));
        setAllConversations((prev) => {
          const wsId = activeWorkspaceRef.current?.id;
          if (!wsId) return prev;
          return { ...prev, [wsId]: applyThinkText(prev[wsId] ?? []) };
        });
      });

      if (!mounted) { u1(); u2(); u3(); u4(); u5(); u6(); u7(); return; }
      unlistenRefs.current = [u1, u2, u3, u4, u5, u6, u7];
    }

    setup();
    return () => {
      mounted = false;
      for (const fn of unlistenRefs.current) fn();
      unlistenRefs.current = [];
    };
  }, []);

  // Derived state
  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;
  const isGenerating = activeId ? generatingIds.has(activeId) : false;

  // --- Workspace actions ---
  const addWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string | null>("select_workspace");
      if (!path) return;
      const name = path.split("/").pop() ?? path;
      // Identity is the folder path, so re-adding the same folder restores its
      // chats. Skip duplicating if it's already in the sidebar.
      setWorkspaces((prev) =>
        prev.some((w) => w.path === path) ? prev : [...prev, { id: path, path, name }]
      );
      setActiveWorkspaceId(path);
      // Preserve any conversations previously stored for this path.
      setAllConversations((prev) => ({ ...prev, [path]: prev[path] ?? [] }));
      const existing = allConversations[path] ?? [];
      setConversations(existing);
      setActiveId(existing.length > 0 ? existing[0].id : null);
    } catch { /* ignore */ }
  }, [allConversations]);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    // Intentionally KEEP allConversations[id] (now keyed by folder path) so that
    // re-adding the same folder restores its chat history instead of wiping it.
    if (activeWorkspaceId === id) {
      const remaining = workspaces.filter((w) => w.id !== id);
      const nextActive = remaining[0] ?? null;
      setActiveWorkspaceId(nextActive?.id ?? null);
      const convs = nextActive ? (allConversations[nextActive.id] ?? []) : [];
      setConversations(convs);
      setActiveId(convs.length > 0 ? convs[0].id : null);
    }
  }, [activeWorkspaceId, workspaces, allConversations]);

  const switchWorkspace = useCallback((id: string) => {
    setActiveWorkspaceId(id);
    setAllConversations((prev) => ({ ...prev, [activeWorkspaceId ?? ""]: conversations }));
    const convs = allConversations[id] ?? [];
    setConversations(convs);
    setActiveId(convs.length > 0 ? convs[0].id : null);
    setError(null);
  }, [activeWorkspaceId, conversations, allConversations]);

  // --- Conversation actions ---
  const createConversation = useCallback(() => {
    if (!activeWorkspaceId) return "";
    const id = generateId();
    const conv: Conversation = {
      id, title: "New Agent", messages: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setConversations((prev) => [conv, ...prev]);
    setAllConversations((prev) => ({
      ...prev,
      [activeWorkspaceId]: [conv, ...(prev[activeWorkspaceId] ?? [])],
    }));
    setActiveId(id);
    setError(null);
    return id;
  }, [activeWorkspaceId]);

  const switchConversation = useCallback((id: string) => {
    setActiveId(id);
    setError(null);
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    setAllConversations((prev) => ({
      ...prev,
      [activeWorkspaceId ?? ""]: (prev[activeWorkspaceId ?? ""] ?? []).filter((c) => c.id !== id),
    }));
    invoke("delete_conversation", { conversationId: id }).catch(() => {});
    if (activeId === id) { setActiveId(null); setError(null); }
  }, [activeId, activeWorkspaceId]);

  const sendMessage = useCallback(
    async (content: string, convIdOverride?: string) => {
      if (!content.trim()) return;

      let convId = convIdOverride ?? activeId;

      // Create conversation if none is active
      if (!convId) {
        if (!activeWorkspaceId) return;
        convId = generateId();
        const conv: Conversation = {
          id: convId, title: generateTitle(content), messages: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        setConversations((prev) => [conv, ...prev]);
        setAllConversations((prev) => ({
          ...prev,
          [activeWorkspaceId]: [conv, ...(prev[activeWorkspaceId] ?? [])],
        }));
        setActiveId(convId);
        activeIdRef.current = convId;
      }

      const userMsg: Message = {
        id: generateId(), role: "user", content,
        timestamp: Date.now(), status: "done",
      };
      const assistantMsg: Message = {
        id: generateId(), role: "assistant", content: "",
        timestamp: Date.now(), status: "streaming",
      };

      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== convId) return conv;
          const isFirst = conv.messages.length === 0;
          return {
            ...conv,
            title: isFirst ? generateTitle(content) : conv.title,
            messages: [...conv.messages, userMsg, assistantMsg],
            updatedAt: Date.now(),
          };
        })
      );
      setAllConversations((prev) => ({
        ...prev,
        [activeWorkspaceId ?? ""]: (prev[activeWorkspaceId ?? ""] ?? []).map((conv) => {
          if (conv.id !== convId) return conv;
          const isFirst = conv.messages.length === 0;
          return {
            ...conv,
            title: isFirst ? generateTitle(content) : conv.title,
            messages: [...conv.messages, userMsg, assistantMsg],
            updatedAt: Date.now(),
          };
        }),
      }));

      setGeneratingIds((prev) => new Set(prev).add(convId!));
      setError(null);

      const currentConv = conversations.find((c) => c.id === convId);
      const isContinue = currentConv ? currentConv.messages.filter((m) => m.role === "user").length > 0 : false;

      try {
        await invoke("send_message", {
          message: content,
          conversationId: convId,
          isContinue,
        });
      } catch (e) {
        setError(String(e));
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(convId!);
          return next;
        });
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== convId) return conv;
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, status: "error" };
            }
            return { ...conv, messages: msgs };
          })
        );
      }
    },
    [activeId, conversations, activeWorkspaceId]
  );

  const stopGeneration = useCallback(async (convId?: string) => {
    const targetId = convId ?? activeId;
    if (!targetId) return;
    try {
      await invoke("stop_generation", { conversationId: targetId });
    } catch { /* ignore */ }
    setGeneratingIds((prev) => {
      const next = new Set(prev);
      next.delete(targetId);
      return next;
    });
    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id !== targetId) return conv;
        const msgs = [...conv.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.status === "streaming") {
          msgs[msgs.length - 1] = { ...last, status: "done" };
        }
        return { ...conv, messages: msgs };
      })
    );
  }, [activeId]);

  const clearError = useCallback(() => { setError(null); }, []);

  // Inject a completed scheduled-task run as a Conversation in its workspace, so the
  // result is viewable in the sidebar like any chat (deduped by run id; idempotent).
  const addScheduledRun = useCallback((run: TaskRunRecord) => {
    const startedMs = Date.parse(run.started_at) || Date.now();
    const finishedMs = Date.parse(run.finished_at) || startedMs;
    const conv: Conversation = {
      id: run.id,
      title: run.task_name || generateTitle(run.prompt),
      createdAt: startedMs,
      updatedAt: finishedMs,
      messages: [
        { id: generateId(), role: "user", content: run.prompt, timestamp: startedMs },
        {
          id: generateId(),
          role: "assistant",
          content:
            run.result ||
            (run.status === "error" ? "(task failed)" : "(no output)"),
          timestamp: finishedMs,
          status: run.status === "error" ? "error" : "done",
        },
      ],
    };
    const wsId = run.workspace;
    setAllConversations((prev) => {
      const list = prev[wsId] ?? [];
      const without = list.filter((c) => c.id !== conv.id);
      return { ...prev, [wsId]: [conv, ...without] };
    });
    if (wsId === activeWorkspaceId) {
      setConversations((prev) => {
        const without = prev.filter((c) => c.id !== conv.id);
        return [conv, ...without];
      });
    }
  }, [activeWorkspaceId]);

  // Optimistically surface a just-kicked-off scheduled run as a "Running…"
  // placeholder conversation in its workspace and navigate there. Keyed by the
  // conversation_id the backend returns synchronously from run-now, so the
  // placeholder is seamlessly replaced when addScheduledRun fires on completion.
  const addRunningTask = useCallback(
    (opts: { id: string; taskName: string; prompt: string; workspace: string }) => {
      const now = Date.now();
      const conv: Conversation = {
        id: opts.id,
        title: opts.taskName || generateTitle(opts.prompt),
        createdAt: now,
        updatedAt: now,
        messages: [
          { id: generateId(), role: "user", content: opts.prompt, timestamp: now, status: "done" },
          { id: generateId(), role: "assistant", content: "Running…", timestamp: now, status: "streaming" },
        ],
      };
      // Save the current workspace's conversations, switch to the task's
      // workspace, and surface the placeholder there.
      setAllConversations((prev) => {
        const saved = { ...prev, [activeWorkspaceId ?? ""]: conversations };
        const list = saved[opts.workspace] ?? [];
        const without = list.filter((c) => c.id !== conv.id);
        return { ...saved, [opts.workspace]: [conv, ...without] };
      });
      const targetList = (allConversations[opts.workspace] ?? []).filter((c) => c.id !== conv.id);
      setConversations([conv, ...targetList]);
      setActiveWorkspaceId(opts.workspace);
      setActiveId(conv.id);
      setError(null);
    },
    [activeWorkspaceId, conversations, allConversations]
  );

  const refreshClaudeStatus = useCallback(async () => {
    try {
      const status = await invoke<ClaudeStatus>("check_claude_available");
      setClaudeStatus(status);
    } catch {
      setClaudeStatus({ available: false, error: "Failed to check" });
    }
  }, []);

  return {
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
    addRunningTask,
  };
}