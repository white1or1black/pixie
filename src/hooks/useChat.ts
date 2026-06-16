import { useState, useEffect, useCallback, useRef, useMemo, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Conversation,
  Message,
  EngineStatus,
  AgentEngineId,
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
  EngineModelConfigs,
  TaskRunRecord,
} from "../types";
import { AGENT_ENGINES } from "../types";

const DATA_KEY = "pixie-data";
const DEFAULT_ENGINE_KEY = "pixie-default-engine";

function normalizeConversation(conv: Conversation): Conversation {
  return {
    ...conv,
    engine: conv.engine ?? "claude",
  };
}

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

/** Coalesce high-frequency stream events before touching React state. */
interface StreamBatch {
  textParts: { content: string; eventType: string }[];
  tools: ResponseTool[];
  thinkingTokens?: number;
  thinkingText?: string;
  usage?: ResponseUsage;
}

function appendStreamingText(current: string, content: string, eventType: string): string {
  if (!content) return current;
  if (eventType === "delta" || eventType === "block_start") {
    return current + content;
  }
  if (eventType === "assistant") {
    if (!current) return content;
    if (content.startsWith(current) || content === current) return content;
    if (current.endsWith(content)) return current;
    return `${current}\n\n${content}`;
  }
  return current + content;
}

function applyToolEvent(tools: ToolStep[], tool: ResponseTool): ToolStep[] {
  const next = [...tools];
  if (tool.kind === "start") {
    if (next.some((t) => t.id === tool.tool_use_id)) return next;
    let parsedInput: unknown;
    try {
      parsedInput = tool.input ? JSON.parse(tool.input) : undefined;
    } catch {
      parsedInput = undefined;
    }
    next.push({
      id: tool.tool_use_id,
      name: tool.name ?? "tool",
      status: "running",
      input: parsedInput,
      rawInput: tool.input,
    });
    return next;
  }

  const idx = next.findIndex((t) => t.id === tool.tool_use_id);
  const status = tool.is_error ? "error" : "done";
  if (idx >= 0) {
    next[idx] = { ...next[idx], status, result: tool.content };
  } else {
    next.push({
      id: tool.tool_use_id,
      name: tool.name ?? "tool",
      status,
      result: tool.content,
    });
  }
  return next;
}

function applyUsage(last: Message, usageEvent: ResponseUsage): MessageUsage {
  if (usageEvent.kind === "final") {
    return {
      inputTokens: usageEvent.input_tokens,
      outputTokens: usageEvent.output_tokens,
      cacheReadTokens: usageEvent.cache_read_tokens,
      cacheCreationTokens: usageEvent.cache_creation_tokens,
      costUsd: usageEvent.cost_usd,
      durationMs: usageEvent.duration_ms,
      numTurns: usageEvent.num_turns,
      model: usageEvent.model,
      stopReason: usageEvent.stop_reason,
      live: false,
    };
  }
  const prevUsage = last.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  return {
    inputTokens: prevUsage.inputTokens + usageEvent.input_tokens,
    outputTokens: prevUsage.outputTokens + usageEvent.output_tokens,
    cacheReadTokens: prevUsage.cacheReadTokens + usageEvent.cache_read_tokens,
    cacheCreationTokens: prevUsage.cacheCreationTokens + usageEvent.cache_creation_tokens,
    live: true,
  };
}

function applyStreamBatch(
  prev: Record<string, Conversation[]>,
  convId: string,
  batch: StreamBatch,
): Record<string, Conversation[]> {
  return patchConversation(prev, convId, (conv) => {
    const msgs = [...conv.messages];
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "assistant") return conv;

    let updated: Message = { ...last };

    for (const { content, eventType } of batch.textParts) {
      if (updated.status === "streaming") {
        updated = {
          ...updated,
          content: appendStreamingText(updated.content, content, eventType),
        };
      }
    }

    if (batch.tools.length > 0) {
      let tools = [...(updated.tools ?? [])];
      for (const tool of batch.tools) {
        tools = applyToolEvent(tools, tool);
      }
      updated = { ...updated, tools };
    }

    if (batch.thinkingTokens !== undefined) {
      updated = { ...updated, thinkingTokens: batch.thinkingTokens };
    }

    if (batch.thinkingText) {
      const prevText = updated.thinking ?? "";
      updated = {
        ...updated,
        thinking: prevText ? `${prevText}\n\n${batch.thinkingText}` : batch.thinkingText,
      };
    }

    if (batch.usage) {
      updated = { ...updated, usage: applyUsage(updated, batch.usage) };
    }

    msgs[msgs.length - 1] = updated;
    return { ...conv, messages: msgs, updatedAt: Date.now() };
  });
}

function emptyStreamBatch(): StreamBatch {
  return { textParts: [], tools: [] };
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

export function useChat(engineModelConfigs: EngineModelConfigs) {
  const [workspaces, setWorkspaces] = useState<WorkspaceState[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [allConversations, setAllConversations] = useState<Record<string, Conversation[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  /** null = show all workspaces in the sidebar */
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [engineStatuses, setEngineStatuses] = useState<EngineStatus[] | null>(null);
  const [defaultEngine, setDefaultEngine] = useState<AgentEngineId>(() => {
    const stored = localStorage.getItem(DEFAULT_ENGINE_KEY);
    if (stored === "cursor" || stored === "codebuddy" || stored === "claude") {
      return stored;
    }
    return "claude";
  });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const unlistenRefs = useRef<Array<() => void>>([]);
  const activeIdRef = useRef<string | null>(activeId);
  const allConversationsRef = useRef(allConversations);
  const streamBatchesRef = useRef(new Map<string, StreamBatch>());
  const streamFlushScheduledRef = useRef(false);
  // Timestamp of the last streamed UI flush, for rate-limiting (see below).
  const lastStreamFlushAtRef = useRef(0);
  // Cap streamed UI updates to ~20fps. Each flush rebuilds the conversation
  // tree and re-renders the sidebar/memos + reflows the growing reply; running
  // that on every animation frame (60fps) saturates the main thread once a
  // session has history, freezing the UI. Text is perfectly readable at 20fps.
  // The terminal agent-done/agent-error flush bypasses this (immediate).
  const STREAM_FLUSH_MIN_MS = 50;
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPersistRef = useRef<{
    workspaces: WorkspaceState[];
    activeWorkspaceId: string | null;
    allConversations: Record<string, Conversation[]>;
  } | null>(null);

  const flushStreamBatches = useCallback((onlyConvId?: string) => {
    const pending = streamBatchesRef.current;
    if (pending.size === 0) return;

    const toFlush = onlyConvId
      ? (() => {
          const batch = pending.get(onlyConvId);
          if (!batch) return null;
          pending.delete(onlyConvId);
          return new Map([[onlyConvId, batch] as const]);
        })()
      : (() => {
          const all = new Map(pending);
          pending.clear();
          return all;
        })();

    if (!toFlush || toFlush.size === 0) return;

    startTransition(() => {
      setAllConversations((prev) => {
        let next = prev;
        for (const [convId, batch] of toFlush) {
          next = applyStreamBatch(next, convId, batch);
        }
        return next;
      });
    });
  }, []);

  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushScheduledRef.current) return;
    streamFlushScheduledRef.current = true;
    const tick = () => {
      if (performance.now() - lastStreamFlushAtRef.current < STREAM_FLUSH_MIN_MS) {
        // Too soon since the last flush — wait one more frame to keep the
        // update rate capped, giving the main thread room to stay responsive.
        requestAnimationFrame(tick);
        return;
      }
      streamFlushScheduledRef.current = false;
      lastStreamFlushAtRef.current = performance.now();
      flushStreamBatches();
    };
    requestAnimationFrame(tick);
  }, [flushStreamBatches]);

  const queueStreamUpdate = useCallback(
    (convId: string, mutate: (batch: StreamBatch) => void) => {
      let batch = streamBatchesRef.current.get(convId);
      if (!batch) {
        batch = emptyStreamBatch();
        streamBatchesRef.current.set(convId, batch);
      }
      mutate(batch);
      scheduleStreamFlush();
    },
    [scheduleStreamFlush],
  );

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

  // Sync per-engine model config to Rust backend
  useEffect(() => {
    for (const { id } of AGENT_ENGINES) {
      const cfg = engineModelConfigs[id];
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg)) {
        if (v) config[k] = v;
      }
      invoke("set_engine_model_config", { engine: id, config }).catch(() => {});
    }
  }, [engineModelConfigs]);

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
      conversations[w.path] = (byPath.length >= byOld.length ? byPath : byOld).map(normalizeConversation);
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

  // Persist to localStorage. During agent streaming, allConversations updates
  // ~60×/s; synchronous JSON.stringify of the full history blocks the main thread
  // and freezes the UI (especially with CodeBuddy's high event rate). Debounce
  // while generating; save immediately once idle.
  useEffect(() => {
    if (!loaded) return;

    latestPersistRef.current = { workspaces, activeWorkspaceId, allConversations };

    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }

    const persist = () => {
      const snap = latestPersistRef.current;
      if (snap) {
        saveData(snap.workspaces, snap.activeWorkspaceId, snap.allConversations);
      }
    };

    if (generatingIds.size > 0) {
      saveDebounceRef.current = setTimeout(persist, 2000);
    } else {
      persist();
    }

    return () => {
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
    };
  }, [loaded, workspaces, activeWorkspaceId, allConversations, generatingIds]);

  useEffect(() => {
    if (activeWorkspace?.path) {
      invoke("set_active_workspace", { path: activeWorkspace.path }).catch(() => {});
    }
  }, [activeWorkspace?.path]);

  useEffect(() => {
    invoke<EngineStatus[]>("check_engines_available")
      .then((statuses) => setEngineStatuses(statuses))
      .catch(() =>
        setEngineStatuses([
          { id: "claude", display_name: "Claude Code", available: false, error: "Failed to check engines" },
          { id: "cursor", display_name: "Cursor Agent", available: false, error: "Failed to check engines" },
        ])
      );
  }, []);

  useEffect(() => {
    localStorage.setItem(DEFAULT_ENGINE_KEY, defaultEngine);
  }, [defaultEngine]);

  // Listen to Tauri events — route updates by conversation_id, not active workspace.
  useEffect(() => {
    let mounted = true;

    async function setup() {
      const u1 = await listen<ResponseChunk>("agent-response", (event) => {
        const { conversation_id, content, event_type } = event.payload;
        queueStreamUpdate(conversation_id, (batch) => {
          batch.textParts.push({ content, eventType: event_type });
        });
      });

      const u2 = await listen<ResponseDone>("agent-done", (event) => {
        const done = event.payload;
        flushStreamBatches(done.conversation_id);
        setAllConversations((prev) =>
          patchConversation(prev, done.conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              msgs[msgs.length - 1] = { ...last, content: done.full_text, status: "done", timestamp: Date.now() };
            }
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          }),
        );
        setGeneratingIds((prev) => {
          const next = new Set(prev);
          next.delete(done.conversation_id);
          return next;
        });
        // Only clear the banner when the turn actually succeeded.
        setError(null);
      });

      const u3 = await listen<ResponseError>("agent-error", (event) => {
        const err = event.payload;
        flushStreamBatches(err.conversation_id);
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

      const u4 = await listen<ResponseTool>("agent-tool", (event) => {
        const tool = event.payload;
        queueStreamUpdate(tool.conversation_id, (batch) => {
          batch.tools.push(tool);
        });
      });

      const u5 = await listen<ResponseThinking>("agent-thinking", (event) => {
        const { conversation_id, tokens } = event.payload;
        queueStreamUpdate(conversation_id, (batch) => {
          batch.thinkingTokens = tokens;
        });
      });

      const u6 = await listen<ResponseUsage>("agent-usage", (event) => {
        const u = event.payload;
        queueStreamUpdate(u.conversation_id, (batch) => {
          batch.usage = u;
        });
      });

      const u7 = await listen<ResponseThinkingText>("agent-thinking-text", (event) => {
        const { conversation_id, content } = event.payload;
        queueStreamUpdate(conversation_id, (batch) => {
          batch.thinkingText = batch.thinkingText
            ? `${batch.thinkingText}\n\n${content}`
            : content;
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
      streamBatchesRef.current.clear();
      streamFlushScheduledRef.current = false;
    };
  }, [queueStreamUpdate, flushStreamBatches]);

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

  const createConversation = useCallback((workspaceId?: string, engine?: AgentEngineId) => {
    const wsId = workspaceId ?? resolveTargetWorkspace();
    if (!wsId) return "";
    const id = generateId();
    const conv: Conversation = {
      id, title: "New Agent", messages: [],
      createdAt: Date.now(), updatedAt: Date.now(),
      engine: engine ?? defaultEngine,
    };
    setAllConversations((prev) => ({
      ...prev,
      [wsId]: [conv, ...(prev[wsId] ?? [])],
    }));
    setActiveWorkspaceId(wsId);
    setActiveId(id);
    setError(null);
    return id;
  }, [resolveTargetWorkspace, defaultEngine]);

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
          engine: defaultEngine,
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
      const engine = currentConv?.engine ?? defaultEngine;
      // Only --resume when a prior turn completed successfully on the backend.
      // Using user-message count alone breaks retries: after a failed first
      // attempt (spawn error / no CodeBuddy session) we'd pass --resume and get
      // "No conversation found with session ID".
      const isContinue = currentConv
        ? currentConv.messages.some((m) => m.role === "assistant" && m.status === "done")
        : false;

      // Ensure backend cwd matches the conversation's workspace before spawning.
      await invoke("set_active_workspace", { path: wsId }).catch(() => {});

      try {
        await invoke("send_message", {
          message: content,
          conversationId: convId,
          engine,
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
    [activeId, resolveTargetWorkspace, defaultEngine],
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
          msgs[msgs.length - 1] = { ...last, status: "done", timestamp: Date.now() };
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
      engine: "claude",
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
        engine: "claude",
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

  const refreshEngineStatuses = useCallback(async () => {
    try {
      const statuses = await invoke<EngineStatus[]>("check_engines_available");
      setEngineStatuses(statuses);
    } catch {
      setEngineStatuses(null);
    }
  }, []);

  const anyEngineAvailable = (engineStatuses ?? []).some((s) => s.available);

  return {
    unifiedConversations,
    activeConversation,
    activeId,
    isGenerating,
    generatingIds,
    engineStatuses,
    anyEngineAvailable,
    defaultEngine,
    setDefaultEngine,
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
    refreshEngineStatuses,
    clearError,
    addScheduledRun,
    addRunningTask,
  };
}
