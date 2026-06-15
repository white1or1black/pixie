import { useState, useEffect, useCallback, useRef, useMemo } from "react";
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

export interface ConversationEntry {
  conversation: Conversation;
  workspaceId: string;
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

function findWorkspaceForConversation(
  all: Record<string, Conversation[]>,
  convId: string,
): string | null {
  for (const [wsId, convs] of Object.entries(all)) {
    if (convs.some((c) => c.id === convId)) return wsId;
  }
  return null;
}

function patchConversation(
  prev: Record<string, Conversation[]>,
  convId: string,
  updater: (conv: Conversation) => Conversation,
): Record<string, Conversation[]> {
  const wsId = findWorkspaceForConversation(prev, convId);
  if (!wsId) return prev;
  return {
    ...prev,
    [wsId]: (prev[wsId] ?? []).map((c) => (c.id === convId ? updater(c) : c)),
  };
}

function flattenConversations(all: Record<string, Conversation[]>): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const [workspaceId, convs] of Object.entries(all)) {
    for (const conversation of convs) {
      entries.push({ conversation, workspaceId });
    }
  }
  entries.sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt);
  return entries;
}

function workspaceActivity(
  wsId: string,
  allConversations: Record<string, Conversation[]>,
  generatingIds: Set<string>,
): { latest: number; running: boolean } {
  const convs = allConversations[wsId] ?? [];
  let latest = 0;
  let running = false;
  for (const c of convs) {
    if (c.updatedAt > latest) latest = c.updatedAt;
    if (generatingIds.has(c.id)) running = true;
  }
  return { latest, running };
}

/** Most recently active first; workspaces with running agents pinned to the top. */
function sortWorkspacesByActivity(
  workspaces: WorkspaceState[],
  allConversations: Record<string, Conversation[]>,
  generatingIds: Set<string>,
): WorkspaceState[] {
  return [...workspaces].sort((a, b) => {
    const aa = workspaceActivity(a.id, allConversations, generatingIds);
    const bb = workspaceActivity(b.id, allConversations, generatingIds);
    if (aa.running !== bb.running) return aa.running ? -1 : 1;
    if (aa.latest !== bb.latest) return bb.latest - aa.latest;
    return a.name.localeCompare(b.name);
  });
}

export function useChat(modelConfig: ModelConfig) {
  const [workspaces, setWorkspaces] = useState<WorkspaceState[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [allConversations, setAllConversations] = useState<Record<string, Conversation[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  /** null = show all workspaces in the sidebar */
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [claudeStatus, setClaudeStatus] = useState<ClaudeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const unlistenRefs = useRef<Array<() => void>>([]);
  const activeIdRef = useRef<string | null>(activeId);
  const allConversationsRef = useRef(allConversations);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    allConversationsRef.current = allConversations;
  }, [allConversations]);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const sortedWorkspaces = useMemo(
    () => sortWorkspacesByActivity(workspaces, allConversations, generatingIds),
    [workspaces, allConversations, generatingIds],
  );

  const unifiedConversations = useMemo(
    () => flattenConversations(allConversations),
    [allConversations],
  );

  const activeConversation = useMemo(() => {
    if (!activeId) return null;
    for (const { conversation } of unifiedConversations) {
      if (conversation.id === activeId) return conversation;
    }
    return null;
  }, [activeId, unifiedConversations]);

  const isGenerating = activeId ? generatingIds.has(activeId) : false;

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
    if (convs.length > 0) {
      setActiveId(convs[0].id);
    } else {
      const flat = flattenConversations(conversations);
      if (flat.length > 0) {
        setActiveId(flat[0].conversation.id);
        setActiveWorkspaceId(flat[0].workspaceId);
      }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    saveData(workspaces, activeWorkspaceId, allConversations);
  }, [loaded, workspaces, activeWorkspaceId, allConversations]);

  useEffect(() => {
    if (activeWorkspace?.path) {
      invoke("set_active_workspace", { path: activeWorkspace.path }).catch(() => {});
    }
  }, [activeWorkspace?.path]);

  useEffect(() => {
    invoke<ClaudeStatus>("check_claude_available")
      .then((status) => setClaudeStatus(status))
      .catch(() =>
        setClaudeStatus({ available: false, error: "Failed to check Claude availability" })
      );
  }, []);

  // Listen to Tauri events — route updates by conversation_id, not active workspace.
  useEffect(() => {
    let mounted = true;

    async function setup() {
      const u1 = await listen<ResponseChunk>("claude-response", (event) => {
        const { conversation_id, content } = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant" && last.status === "streaming") {
              msgs[msgs.length - 1] = { ...last, content: last.content + content };
            }
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
      });

      const u2 = await listen<ResponseDone>("claude-done", (event) => {
        const done = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, done.conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, content: done.full_text, status: "done" };
            }
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
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
        setAllConversations((prev) =>
          patchConversation(prev, err.conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, status: "error" };
            }
            return { ...conv, messages: msgs };
          }),
        );
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(err.conversation_id);
          return next;
        });
      });

      const u4 = await listen<ResponseTool>("claude-tool", (event) => {
        const tool = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, tool.conversation_id, (conv) => {
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
          }),
        );
      });

      const u5 = await listen<ResponseThinking>("claude-thinking", (event) => {
        const { conversation_id, tokens } = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;
            msgs[msgs.length - 1] = { ...last, thinkingTokens: tokens };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
      });

      const u6 = await listen<ResponseUsage>("claude-usage", (event) => {
        const u = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, u.conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;

            let usage: MessageUsage;
            if (u.kind === "final") {
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
              const prevUsage = last.usage ?? {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              };
              usage = {
                inputTokens: prevUsage.inputTokens + u.input_tokens,
                outputTokens: prevUsage.outputTokens + u.output_tokens,
                cacheReadTokens: prevUsage.cacheReadTokens + u.cache_read_tokens,
                cacheCreationTokens: prevUsage.cacheCreationTokens + u.cache_creation_tokens,
                live: true,
              };
            }
            msgs[msgs.length - 1] = { ...last, usage };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
      });

      const u7 = await listen<ResponseThinkingText>("claude-thinking-text", (event) => {
        const { conversation_id, content } = event.payload;
        setAllConversations((prev) =>
          patchConversation(prev, conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return conv;
            const prevText = last.thinking ?? "";
            msgs[msgs.length - 1] = {
              ...last,
              thinking: prevText ? `${prevText}\n\n${content}` : content,
            };
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
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

  const resolveTargetWorkspace = useCallback((): string | null => {
    return workspaceFilter ?? activeWorkspaceId ?? sortedWorkspaces[0]?.id ?? null;
  }, [workspaceFilter, activeWorkspaceId, sortedWorkspaces]);

  const addWorkspace = useCallback(async () => {
    try {
      const path = await invoke<string | null>("select_workspace");
      if (!path) return;
      const name = path.split("/").pop() ?? path;
      setWorkspaces((prev) =>
        prev.some((w) => w.path === path) ? prev : [...prev, { id: path, path, name }]
      );
      setAllConversations((prev) => ({ ...prev, [path]: prev[path] ?? [] }));
      setActiveWorkspaceId(path);
    } catch { /* ignore */ }
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    if (workspaceFilter === id) setWorkspaceFilter(null);
    if (activeWorkspaceId === id) {
      const remaining = workspaces.filter((w) => w.id !== id);
      const nextActive = remaining[0] ?? null;
      setActiveWorkspaceId(nextActive?.id ?? null);
      if (activeId) {
        const ws = findWorkspaceForConversation(allConversationsRef.current, activeId);
        if (ws === id) {
          const flat = flattenConversations(allConversationsRef.current).filter(
            (e) => e.workspaceId !== id,
          );
          if (flat.length > 0) {
            setActiveId(flat[0].conversation.id);
            setActiveWorkspaceId(flat[0].workspaceId);
          } else {
            setActiveId(null);
          }
        }
      }
    }
  }, [activeWorkspaceId, activeId, workspaceFilter, workspaces]);

  const createConversation = useCallback((workspaceId?: string) => {
    const wsId = workspaceId ?? resolveTargetWorkspace();
    if (!wsId) return "";
    const id = generateId();
    const conv: Conversation = {
      id, title: "New Agent", messages: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    setAllConversations((prev) => ({
      ...prev,
      [wsId]: [conv, ...(prev[wsId] ?? [])],
    }));
    setActiveWorkspaceId(wsId);
    setActiveId(id);
    setError(null);
    return id;
  }, [resolveTargetWorkspace]);

  const switchConversation = useCallback((id: string, workspaceId?: string) => {
    const wsId =
      workspaceId ?? findWorkspaceForConversation(allConversationsRef.current, id);
    if (wsId) setActiveWorkspaceId(wsId);
    setActiveId(id);
    setError(null);
  }, []);

  const deleteConversation = useCallback((id: string, workspaceId?: string) => {
    const wsId =
      workspaceId ?? findWorkspaceForConversation(allConversationsRef.current, id);
    if (!wsId) return;
    setAllConversations((prev) => ({
      ...prev,
      [wsId]: (prev[wsId] ?? []).filter((c) => c.id !== id),
    }));
    invoke("delete_conversation", { conversationId: id }).catch(() => {});
    if (activeId === id) {
      setActiveId(null);
      setError(null);
    }
  }, [activeId]);

  const sendMessage = useCallback(
    async (content: string, convIdOverride?: string) => {
      if (!content.trim()) return;

      let convId = convIdOverride ?? activeId;
      let wsId = convId
        ? findWorkspaceForConversation(allConversationsRef.current, convId)
        : null;

      if (!convId) {
        wsId = resolveTargetWorkspace();
        if (!wsId) return;
        convId = generateId();
        const conv: Conversation = {
          id: convId, title: generateTitle(content), messages: [],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        setAllConversations((prev) => ({
          ...prev,
          [wsId!]: [conv, ...(prev[wsId!] ?? [])],
        }));
        setActiveWorkspaceId(wsId);
        setActiveId(convId);
        activeIdRef.current = convId;
      }

      if (!wsId) {
        wsId = findWorkspaceForConversation(allConversationsRef.current, convId);
      }
      if (!wsId) return;

      const userMsg: Message = {
        id: generateId(), role: "user", content,
        timestamp: Date.now(), status: "done",
      };
      const assistantMsg: Message = {
        id: generateId(), role: "assistant", content: "",
        timestamp: Date.now(), status: "streaming",
      };

      setAllConversations((prev) => ({
        ...prev,
        [wsId!]: (prev[wsId!] ?? []).map((conv) => {
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

      const currentConv = allConversationsRef.current[wsId]?.find((c) => c.id === convId);
      const isContinue = currentConv
        ? currentConv.messages.filter((m) => m.role === "user").length > 0
        : false;

      // Ensure backend cwd matches the conversation's workspace before spawning.
      await invoke("set_active_workspace", { path: wsId }).catch(() => {});

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
        setAllConversations((prev) =>
          patchConversation(prev, convId!, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, status: "error" };
            }
            return { ...conv, messages: msgs };
          }),
        );
      }
    },
    [activeId, resolveTargetWorkspace],
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
    setAllConversations((prev) =>
      patchConversation(prev, targetId, (conv) => {
        const msgs = [...conv.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.status === "streaming") {
          msgs[msgs.length - 1] = { ...last, status: "done" };
        }
        return { ...conv, messages: msgs };
      }),
    );
  }, [activeId]);

  const clearError = useCallback(() => { setError(null); }, []);

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
    setGeneratingIds((prev) => {
      const next = new Set(prev);
      next.delete(conv.id);
      return next;
    });
  }, []);

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
      setAllConversations((prev) => {
        const list = prev[opts.workspace] ?? [];
        const without = list.filter((c) => c.id !== conv.id);
        return { ...prev, [opts.workspace]: [conv, ...without] };
      });
      setGeneratingIds((prev) => new Set(prev).add(conv.id));
      setActiveWorkspaceId(opts.workspace);
      setActiveId(conv.id);
      setError(null);
    },
    [],
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
    unifiedConversations,
    activeConversation,
    activeId,
    isGenerating,
    generatingIds,
    claudeStatus,
    workspaces: sortedWorkspaces,
    activeWorkspace,
    activeWorkspaceId,
    workspaceFilter,
    setWorkspaceFilter,
    error,
    addWorkspace,
    removeWorkspace,
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
