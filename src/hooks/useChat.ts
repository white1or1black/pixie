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
  ResponsePermissionRequest,
  MessageUsage,
  ToolStep,
  WorkspaceState,
  EngineModelConfigs,
  TaskRunRecord,
} from "../types";
import { AGENT_ENGINES } from "../types";
import { getConfig, getHistory, setHistory, updateConfig } from "../lib/storage";

const DEFAULT_WORKSPACE_NAME = "Default";

function normalizeConversation(conv: Conversation): Conversation {
  return {
    ...conv,
    engine: conv.engine ?? "claude",
  };
}

export interface ConversationEntry {
  conversation: Conversation;
  workspaceId: string;
}

function generateId(): string {
  return crypto.randomUUID();
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
  const [defaultEngine, setDefaultEngine] = useState<AgentEngineId>(
    () => getConfig().defaultEngine,
  );
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState<string>("");

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

  const activeWorkspace = useMemo(() => {
    const fromList = workspaces.find((w) => w.id === activeWorkspaceId);
    if (fromList) return fromList;
    // Workspace was removed from list but conversations may still reference it;
    // allow continued chatting as long as the path is still valid.
    if (activeWorkspaceId) {
      const path = activeWorkspaceId;
      return { id: path, path, name: path.split("/").pop() ?? path };
    }
    return null;
  }, [workspaces, activeWorkspaceId]);

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
    // Seeded from disk via the storage module (bootstrap() already resolved
    // before this hook mounted). Group history entries back into the
    // workspaceId → Conversation[] shape the rest of this effect expects.
    const cfg = getConfig();
    const conversationsFromHistory: Record<string, Conversation[]> = {};
    for (const { workspaceId, conversation } of getHistory()) {
      (conversationsFromHistory[workspaceId] ??= []).push(conversation);
    }
    const raw = {
      workspaces: cfg.workspaces,
      activeWorkspaceId: cfg.activeWorkspaceId,
      conversations: conversationsFromHistory,
    };

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
    // Restore orphaned conversations whose workspace was removed from the list
    // but whose data still exists in storage.
    for (const [key, convs] of Object.entries(raw.conversations)) {
      if (seen.has(key)) continue;
      const normalized = convs.map(normalizeConversation);
      if (normalized.length > 0) {
        conversations[key] = normalized;
        seen.add(key);
      }
    }

    // Ensure a default workspace exists so the user can always start a conversation.
    const ensureDefault = async () => {
      let configuredDefault = "";
      try {
        configuredDefault = await invoke<string>("get_default_workspace_path");
      } catch { /* ignore */ }
      setDefaultWorkspacePath(configuredDefault);

      let wsList = workspaces;
      if (wsList.length === 0 && configuredDefault) {
        wsList = [{ id: configuredDefault, path: configuredDefault, name: DEFAULT_WORKSPACE_NAME }];
        conversations[configuredDefault] = conversations[configuredDefault] ?? [];
      }
      const legacyActivePath = raw.workspaces.find((w) => w.id === raw.activeWorkspaceId)?.path;
      const activeWorkspaceId =
        legacyActivePath ??
        (raw.activeWorkspaceId && seen.has(raw.activeWorkspaceId) ? raw.activeWorkspaceId : null) ??
        wsList[0]?.id ??
        null;

      setWorkspaces(wsList);
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
    };
    ensureDefault();
  }, []);

  // Persist history to disk. Reacts only to conversation changes (not workspace
  // selection) so switching the active session never rewrites the whole file.
  // Debounced while an agent is streaming; immediate when idle. The storage
  // module then coalesces and serializes the actual invoke.
  useEffect(() => {
    if (!loaded) return;

    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }

    const persist = () => {
      setHistory(
        flattenConversations(allConversations).map(
          ({ workspaceId, conversation }) => ({ workspaceId, conversation }),
        ),
      );
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
  }, [loaded, allConversations, generatingIds]);

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

  // Mirror session/settings state owned by this hook into config.json (merged
  // into the module singleton alongside App-owned fields, then coalesced).
  useEffect(() => {
    if (loaded) updateConfig({ workspaces });
  }, [loaded, workspaces]);

  useEffect(() => {
    if (loaded) updateConfig({ activeWorkspaceId });
  }, [loaded, activeWorkspaceId]);

  useEffect(() => {
    if (loaded) updateConfig({ defaultEngine });
  }, [loaded, defaultEngine]);

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

      // Permission request: the agent wants to run a tool and needs user approval.
      const u8 = await listen<ResponsePermissionRequest>("agent-permission-request", (event) => {
        const req = event.payload;
        flushStreamBatches(req.conversation_id);
        setAllConversations((prev) =>
          patchConversation(prev, req.conversation_id, (conv) => {
            const msgs = [...conv.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant") {
              const existing = last.pendingPermissions ?? [];
              // Avoid duplicates (same requestId)
              if (!existing.some((p) => p.requestId === req.request_id)) {
                msgs[msgs.length - 1] = {
                  ...last,
                  pendingPermissions: [
                    ...existing,
                    { requestId: req.request_id, toolName: req.tool_name, input: req.input },
                  ],
                };
              }
            }
            return { ...conv, messages: msgs };
          }),
        );
      });

      if (!mounted) { u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); return; }
      unlistenRefs.current = [u1, u2, u3, u4, u5, u6, u7, u8];
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
    // Don't switch away from the removed workspace's conversations — they remain
    // usable as long as the directory still exists on disk.
  }, [workspaceFilter]);

  // Change the configured default working directory. Config-only: it persists
  // the choice and updates what `get_default_workspace_path` returns, but does
  // NOT move existing workspaces or conversations — the new default takes
  // effect when Pixie starts fresh with no workspaces added.
  const changeDefaultWorkspace = useCallback(async (newPath: string | null) => {
    try {
      await invoke("set_default_workspace_path", { path: newPath });
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      return;
    }
    try {
      const resolved = await invoke<string>("get_default_workspace_path");
      setDefaultWorkspacePath(resolved);
    } catch { /* ignore */ }
  }, []);

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

  const renameConversation = useCallback((id: string, newTitle: string) => {
    const wsId = findWorkspaceForConversation(allConversationsRef.current, id);
    if (!wsId) return;
    setAllConversations((prev) => ({
      ...prev,
      [wsId]: (prev[wsId] ?? []).map((c) =>
        c.id === id ? { ...c, title: newTitle } : c
      ),
    }));
    // Title is persisted via the debounced history save (setHistory in the persist effect).
  }, []);

  const deleteConversation = useCallback((id: string, workspaceId?: string) => {
    const wsId =
      workspaceId ?? findWorkspaceForConversation(allConversationsRef.current, id);
    if (!wsId) return;
    setAllConversations((prev) => ({
      ...prev,
      [wsId]: (prev[wsId] ?? []).filter((c) => c.id !== id),
    }));
    // Removal is persisted via the debounced history save (setHistory in the persist effect).
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

  const respondPermission = useCallback(
    async (convId: string, requestId: string, allow: boolean) => {
      try {
        await invoke("respond_permission", {
          conversationId: convId,
          allow,
          message: allow ? undefined : "User denied",
        });
      } catch (e) {
        console.error("[respondPermission] failed:", e);
      }
      // Remove the pending permission from the message
      setAllConversations((prev) =>
        patchConversation(prev, convId, (conv) => {
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && last.pendingPermissions) {
            msgs[msgs.length - 1] = {
              ...last,
              pendingPermissions: last.pendingPermissions.filter(
                (p) => p.requestId !== requestId,
              ),
            };
          }
          return { ...conv, messages: msgs };
        }),
      );
    },
    [],
  );

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
    defaultWorkspacePath,
    changeDefaultWorkspace,
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
    renameConversation,
    deleteConversation,
    sendMessage,
    stopGeneration,
    respondPermission,
    refreshEngineStatuses,
    clearError,
    addScheduledRun,
    addRunningTask,
  };
}
