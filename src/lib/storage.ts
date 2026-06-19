// Disk-backed persistence for Pixie: chat history (history.jsonl, one
// conversation per line) and app config (config.json). Both files live in the
// app data dir and are written by Rust commands; this module is the frontend's
// single source of truth for what gets written.
//
// Why a module singleton + coalesced writers:
//  - Both App.tsx and useChat.ts mutate config (different fields). updateConfig
//    MERGES into one in-memory object, so two writers in the same tick never
//    clobber each other.
//  - The flush re-reads the live state at drain time (not a snapshot queued
//    earlier), so an update landing between queue and flush is never lost.
//  - Only one invoke is ever in flight per file; the drain loop guarantees the
//    NEWEST snapshot is written last, closing the out-of-order-completion race
//    where an older save resolves after a newer one.

import { invoke } from "@tauri-apps/api/core";
import type {
  AgentEngineId,
  Conversation,
  EngineModelConfigs,
  WorkspaceState,
} from "../types";
import { DEFAULT_ENGINE_MODEL_CONFIGS } from "../types";

export interface AppConfig {
  theme: "dark" | "light";
  systemPrompt: string;
  defaultEngine: AgentEngineId;
  engineModelConfigs: EngineModelConfigs;
  workspaces: WorkspaceState[];
  activeWorkspaceId: string | null;
  /** Engine ids that have passed a readiness probe before, so returning users
   *  skip a billable ping on launch. Cleared for an engine when a probe fails. */
  knownReadyEngines: AgentEngineId[];
}

export interface HistoryEntry {
  workspaceId: string;
  conversation: Conversation;
}

const EMPTY_CONFIG: AppConfig = {
  theme: "dark",
  systemPrompt: "",
  defaultEngine: "claude",
  engineModelConfigs: {
    claude: { ...DEFAULT_ENGINE_MODEL_CONFIGS.claude },
    cursor: { ...DEFAULT_ENGINE_MODEL_CONFIGS.cursor },
    codebuddy: { ...DEFAULT_ENGINE_MODEL_CONFIGS.codebuddy },
  },
  workspaces: [],
  activeWorkspaceId: null,
  knownReadyEngines: [],
};

let config: AppConfig = EMPTY_CONFIG;
let history: HistoryEntry[] = [];
let bootstrapped = false;

const LEGACY_KEYS = [
  "pixie-data",
  "pixie-theme",
  "pixie-system-prompt",
  "pixie-engine-model-configs",
  "pixie-default-engine",
  "pixie-model-config",
] as const;

// ---------------------------------------------------------------------------
// Coalesced, serialized writer (one in flight; newest wins)
// ---------------------------------------------------------------------------

function makeWriter(save: () => Promise<void>, delayMs: number): () => void {
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    running = true;
    try {
      // Re-reads live module state inside `save()`. Drains until no new writes
      // arrive during the await, so the last snapshot written is the latest.
      while (dirty) {
        dirty = false;
        await save();
      }
    } catch (e) {
      console.error("[storage] save failed", e);
    } finally {
      running = false;
      if (dirty) {
        // A write arrived during the final await — re-arm instead of dropping it.
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, delayMs);
      }
    }
  }

  return function markDirty(): void {
    dirty = true;
    if (running) return; // the drain loop will pick this up
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };
}

const markConfigDirty = makeWriter(
  () => invoke("save_app_config", { config: configToWire(config) }),
  300,
);

const markHistoryDirty = makeWriter(
  () => invoke("save_history", { entries: historyToWire(history) }),
  50,
);

// ---------------------------------------------------------------------------
// Wire (Rust serde snake_case) <-> internal (camelCase)
// ---------------------------------------------------------------------------

interface ConfigWire {
  theme?: string | null;
  system_prompt?: string | null;
  default_engine?: string | null;
  engine_model_configs?: unknown;
  workspaces?: unknown;
  active_workspace_id?: string | null;
  known_ready_engines?: unknown;
}

function isValidEngine(v: unknown): v is AgentEngineId {
  return v === "claude" || v === "cursor" || v === "codebuddy";
}

/** Coerce a persisted `known_ready_engines` blob into a valid engine-id list. */
function coerceEngineIds(raw: unknown): AgentEngineId[] {
  return Array.isArray(raw) ? raw.filter(isValidEngine) : [];
}

/** Merge a possibly-null/partial per-engine config blob over the defaults. */
function coerceEngineModelConfigs(raw: unknown): EngineModelConfigs {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Partial<EngineModelConfigs>;
    return {
      claude: { ...DEFAULT_ENGINE_MODEL_CONFIGS.claude, ...r.claude },
      cursor: { ...DEFAULT_ENGINE_MODEL_CONFIGS.cursor, ...r.cursor },
      codebuddy: { ...DEFAULT_ENGINE_MODEL_CONFIGS.codebuddy, ...r.codebuddy },
    };
  }
  return {
    claude: { ...DEFAULT_ENGINE_MODEL_CONFIGS.claude },
    cursor: { ...DEFAULT_ENGINE_MODEL_CONFIGS.cursor },
    codebuddy: { ...DEFAULT_ENGINE_MODEL_CONFIGS.codebuddy },
  };
}

function coerceWorkspaces(raw: unknown): WorkspaceState[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WorkspaceState[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const path = (w as { path?: unknown }).path;
    if (typeof path !== "string" || seen.has(path)) continue;
    seen.add(path);
    const nameRaw = (w as { name?: unknown }).name;
    const segment = path.split("/").pop();
    const name = typeof nameRaw === "string" && nameRaw ? nameRaw : segment || path;
    out.push({ id: path, path, name });
  }
  return out;
}

function wireToConfig(w: ConfigWire | null): AppConfig {
  if (!w) return { ...EMPTY_CONFIG };
  return {
    theme: w.theme === "light" ? "light" : "dark",
    systemPrompt: typeof w.system_prompt === "string" ? w.system_prompt : "",
    defaultEngine: isValidEngine(w.default_engine) ? w.default_engine : "claude",
    engineModelConfigs: coerceEngineModelConfigs(w.engine_model_configs),
    workspaces: coerceWorkspaces(w.workspaces),
    activeWorkspaceId:
      typeof w.active_workspace_id === "string" ? w.active_workspace_id : null,
    knownReadyEngines: coerceEngineIds(w.known_ready_engines),
  };
}

function configToWire(c: AppConfig): ConfigWire {
  return {
    theme: c.theme,
    system_prompt: c.systemPrompt,
    default_engine: c.defaultEngine,
    engine_model_configs: c.engineModelConfigs,
    workspaces: c.workspaces,
    active_workspace_id: c.activeWorkspaceId,
    known_ready_engines: c.knownReadyEngines,
  };
}

interface HistoryWire {
  workspace_id: string;
  conversation: Conversation;
}

function historyToWire(entries: HistoryEntry[]): HistoryWire[] {
  return entries.map((e) => ({ workspace_id: e.workspaceId, conversation: e.conversation }));
}

// ---------------------------------------------------------------------------
// One-shot migration from localStorage (this origin only)
// ---------------------------------------------------------------------------

interface LegacyAppData {
  workspaces?: { id?: string; path?: string; name?: string }[];
  activeWorkspaceId?: string | null;
  conversations?: Record<string, Conversation[]>;
}

function migrateFromLocalStorage(): { config: AppConfig; history: HistoryEntry[] } | null {
  const raw = localStorage.getItem("pixie-data");
  if (!raw) return null;
  let data: LegacyAppData;
  try {
    data = JSON.parse(raw) as LegacyAppData;
  } catch {
    return null;
  }

  const workspaces: WorkspaceState[] = [];
  const seen = new Set<string>();
  for (const w of data.workspaces ?? []) {
    const path = w.path ?? w.id;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    workspaces.push({
      id: path,
      path,
      name: w.name ?? path.split("/").pop() ?? path,
    });
  }

  // Flatten conversations, keyed by workspace path (preferring path keys, then
  // falling back to legacy id keys whose workspace we map to its path).
  const history: HistoryEntry[] = [];
  const conversations = data.conversations ?? {};
  const keyToPath = new Map<string, string>();
  for (const w of workspaces) {
    keyToPath.set(w.id, w.path);
    keyToPath.set(w.path, w.path);
  }
  for (const [key, convs] of Object.entries(conversations)) {
    const wsPath = keyToPath.get(key) ?? key;
    if (!Array.isArray(convs)) continue;
    for (const conv of convs) {
      if (!conv || typeof conv !== "object" || !conv.id) continue;
      history.push({
        workspaceId: wsPath,
        conversation: { ...conv, engine: conv.engine ?? "claude" },
      });
    }
  }

  // Engine model configs: prefer the multi-engine key, fall back to legacy single.
  let engineModelConfigs = EMPTY_CONFIG.engineModelConfigs;
  try {
    const multi = localStorage.getItem("pixie-engine-model-configs");
    if (multi) {
      engineModelConfigs = coerceEngineModelConfigs(JSON.parse(multi));
    } else {
      const legacy = localStorage.getItem("pixie-model-config");
      if (legacy) {
        engineModelConfigs = {
          ...EMPTY_CONFIG.engineModelConfigs,
          claude: { ...DEFAULT_ENGINE_MODEL_CONFIGS.claude, ...JSON.parse(legacy) },
        };
      }
    }
  } catch {
    /* keep defaults */
  }

  const storedEngine = localStorage.getItem("pixie-default-engine");
  const config: AppConfig = {
    theme: localStorage.getItem("pixie-theme") === "light" ? "light" : "dark",
    systemPrompt: localStorage.getItem("pixie-system-prompt") ?? "",
    defaultEngine: isValidEngine(storedEngine) ? storedEngine : "claude",
    engineModelConfigs,
    workspaces,
    activeWorkspaceId: typeof data.activeWorkspaceId === "string" ? data.activeWorkspaceId : null,
    knownReadyEngines: [],
  };

  return { config, history };
}

function clearLegacyKeys(): void {
  for (const key of LEGACY_KEYS) localStorage.removeItem(key);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Load config + history from disk, migrating from localStorage on first run.
 *  Must resolve before any React state is seeded from getConfig()/getHistory(). */
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return;

  const [loadedConfig, loadedHistory] = await Promise.all([
    invoke<ConfigWire | null>("load_app_config"),
    invoke<HistoryWire[]>("load_history"),
  ]);

  const hasFiles = loadedConfig !== null || loadedHistory.length > 0;

  if (!hasFiles) {
    // No disk state yet — try a one-shot migration from this origin's localStorage.
    const migrated = migrateFromLocalStorage();
    if (migrated) {
      config = migrated.config;
      history = migrated.history;
      try {
        // Bypass the debounce: persist now and confirm before we trust the files.
        await invoke("save_app_config", { config: configToWire(config) });
        await invoke("save_history", { entries: historyToWire(history) });
        // Defer clearing the legacy keys one launch — only clear once the files
        // are confirmed loadable, so a failed write never leaves us with nothing.
        localStorage.setItem("pixie-migrated", "1");
      } catch (e) {
        console.error("[storage] migration write failed; keeping localStorage", e);
      }
    } else {
      config = { ...EMPTY_CONFIG };
      history = [];
    }
  } else {
    config = wireToConfig(loadedConfig);
    history = loadedHistory.map((e) => ({ workspaceId: e.workspace_id, conversation: e.conversation }));
    // Files loaded cleanly — if a prior launch migrated, it's now safe to drop localStorage.
    if (localStorage.getItem("pixie-migrated") === "1") {
      clearLegacyKeys();
      localStorage.removeItem("pixie-migrated");
    }
  }

  bootstrapped = true;
}

/** Synchronous read of the current config. Only valid after bootstrap(). */
export function getConfig(): AppConfig {
  return config;
}

/** Merge a partial config into the singleton and schedule a debounced save. */
export function updateConfig(patch: Partial<AppConfig>): void {
  config = { ...config, ...patch };
  markConfigDirty();
}

/** Synchronous read of the current history. Only valid after bootstrap(). */
export function getHistory(): HistoryEntry[] {
  return history;
}

/** Replace history wholesale and schedule a coalesced save. The caller (useChat)
 *  owns the streaming debounce; this only serializes/coalesces bursts. */
export function setHistory(entries: HistoryEntry[]): void {
  history = entries;
  markHistoryDirty();
}
