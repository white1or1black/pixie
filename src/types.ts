export interface ToolStep {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: unknown;
  rawInput?: string;
  result?: string;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  model?: string;
  stopReason?: string;
  /** true while still streaming (running totals), false once authoritative final arrives */
  live?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Absolute paths of image attachments sent with this user message. Rendered
   *  as thumbnails in the bubble; sent to the engine as image content blocks. */
  images?: string[];
  timestamp: number;
  status?: "sending" | "streaming" | "done" | "error";
  tools?: ToolStep[];
  usage?: MessageUsage;
  thinkingTokens?: number;
  thinking?: string;
  /** Pending permission requests from the agent (tool calls needing user approval). */
  pendingPermissions?: PendingPermission[];
}

/** A pending permission request from the agent. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /** Agent engine bound to this session. Defaults to claude for legacy data. */
  engine: AgentEngineId;
  /** Per-conversation model override. When empty/undefined, uses the engine's global config. */
  model?: string;
}

export type AgentEngineId = "claude" | "cursor" | "codebuddy";

/** Env key that each engine uses for its model override in global config. */
export const ENGINE_MODEL_ENV_KEY: Record<AgentEngineId, string> = {
  claude: "ANTHROPIC_MODEL",
  cursor: "CURSOR_MODEL",
  codebuddy: "CODEBUDDY_MODEL",
};

/** A model entry returned by the backend's list_models command. */
export interface ModelEntry {
  id: string;
  label: string;
}

export const AGENT_ENGINES: { id: AgentEngineId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "cursor", label: "Cursor Agent" },
  { id: "codebuddy", label: "CodeBuddy" },
];

/** Readiness/auth state of an engine, set by the backend probe. Mirrors the
 *  Rust `AuthState` enum (serde `snake_case`). `unknown` until a probe runs. */
export type AuthState =
  | "unknown"
  | "ready"
  | "not_authenticated"
  | "error"
  | "no_response";

export interface EngineStatus {
  id: AgentEngineId;
  display_name: string;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
  /** Result of the readiness ping probe. Absent on older cached values. */
  auth_state?: AuthState;
  /** Raw engine message for a non-`ready` probe outcome. */
  probe_error?: string | null;
}

/** @deprecated Use EngineStatus — kept for gradual migration */
export type ClaudeStatus = Pick<EngineStatus, "available" | "version" | "path" | "error">;

export interface ResponseChunk {
  conversation_id: string;
  content: string;
  event_type: string;
}

export interface ResponseDone {
  conversation_id: string;
  full_text: string;
}

export interface ResponseTool {
  conversation_id: string;
  tool_use_id: string;
  kind: "start" | "result";
  name?: string;
  input?: string;
  content?: string;
  is_error: boolean;
}

export interface ResponseUsage {
  conversation_id: string;
  kind: "turn" | "final";
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  model?: string;
  stop_reason?: string;
}

export interface ResponseThinking {
  conversation_id: string;
  tokens: number;
}

export interface ResponseThinkingText {
  conversation_id: string;
  content: string;
}

export interface ResponseError {
  conversation_id: string;
  error: string;
}

/** Permission request from the agent (it wants to run a tool and needs user approval). */
export interface ResponsePermissionRequest {
  conversation_id: string;
  /** Unique ID of the permission request (from the CLI). */
  request_id: string;
  /** Tool name (e.g. "Bash", "Edit", "Write"). */
  tool_name: string;
  /** Tool input as a JSON value. */
  input: unknown;
}

export interface WorkspaceInfo {
  path?: string | null;
  name?: string | null;
}

export interface WorkspaceState {
  id: string;
  path: string;
  name: string;
}

export interface ClaudeModelConfig {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  CLAUDE_CODE_EFFORT_LEVEL?: string;
}

export interface CursorModelConfig {
  CURSOR_API_KEY?: string;
  /** Passed to cursor-agent as --model when set */
  CURSOR_MODEL?: string;
}

export interface CodebuddyModelConfig {
  /** Passed to codebuddy as --model when set */
  CODEBUDDY_MODEL?: string;
}

/** Per-engine model/env overrides. */
export type EngineModelConfigs = {
  claude: ClaudeModelConfig;
  cursor: CursorModelConfig;
  codebuddy: CodebuddyModelConfig;
};

/** @deprecated Use EngineModelConfigs */
export type ModelConfig = ClaudeModelConfig;

export const DEFAULT_ENGINE_MODEL_CONFIGS: EngineModelConfigs = {
  claude: {},
  cursor: {},
  codebuddy: {},
};

export const ENGINE_MODEL_FIELDS: Record<
  AgentEngineId,
  { key: string; label: string; secret?: boolean }[]
> = {
  claude: [
    { key: "ANTHROPIC_API_KEY", label: "API Key", secret: true },
    { key: "ANTHROPIC_BASE_URL", label: "Base URL" },
    { key: "ANTHROPIC_MODEL", label: "Model" },
    { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus Model" },
    { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet Model" },
    { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku Model" },
    { key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent Model" },
    { key: "CLAUDE_CODE_EFFORT_LEVEL", label: "Effort Level" },
  ],
  cursor: [
    { key: "CURSOR_API_KEY", label: "API Key", secret: true },
    { key: "CURSOR_MODEL", label: "Model" },
  ],
  codebuddy: [{ key: "CODEBUDDY_MODEL", label: "Model" }],
};

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** An agent skill discovered on disk (user-, project- or plugin-level). Uses the Claude agent skills standard (SKILL.md + frontmatter). */
export interface SkillEntry {
  name: string;
  description: string;
  source: "user" | "project" | "plugin";
  /** Text inserted into the input when picked, e.g. "/skill-name ". */
  invocation: string;
}

/** A configured plugin marketplace (Claude agent standard; `claude plugin marketplace list --json`). */
export interface MarketplaceInfo {
  name: string;
  source: string;
  repo: string;
  installLocation: string;
}

/** A plugin entry from `claude plugin list --json --available`. Fields beyond
 *  name/pluginId/marketplaceName/description are optional for resilience. */
export interface PluginInfo {
  pluginId: string;
  name: string;
  description: string;
  marketplaceName: string;
  version?: string;
  source?: string;
  installCount?: number;
}

export interface PluginCatalog {
  installed: PluginInfo[];
  available: PluginInfo[];
}

/** A preview-open request (what callers pass to the handler). */
export type PreviewRequest =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

/** PreviewRequest plus a nonce so the panel can re-open the same target. */
export type PreviewTarget = PreviewRequest & { nonce: number };

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

/** A schedule preset. `type` discriminant matches the Rust `#[serde(tag="type")]` enum.
 * Fields are authored in the user's LOCAL time. */
export type ScheduleSpec =
  | { type: "daily_time"; hour: number; minute: number }
  | { type: "every_n_minutes"; minutes: number }
  | { type: "every_n_hours"; hours: number }
  | { type: "weekdays_time"; hour: number; minute: number };

export interface ScheduledTask {
  id: string;
  name: string;
  /** Workspace folder path (= WorkspaceState.id/path). Used as the claude CWD. */
  workspace: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  /** ISO-8601 (UTC) of the next pending fire, or null when disabled. */
  next_run: string | null;
  /** ISO-8601 (UTC) of the last fire. */
  last_run: string | null;
}

/** A completed (or failed) scheduled-task execution record. */
export interface TaskRunRecord {
  id: string;
  task_id: string;
  task_name: string;
  workspace: string;
  prompt: string;
  result: string;
  status: "ok" | "error";
  started_at: string;
  finished_at: string;
}

// ---------------------------------------------------------------------------
// Structured git diff (parsed from raw `git diff` unified output)
// ---------------------------------------------------------------------------

export type DiffLineType = "context" | "add" | "delete";

export interface DiffLine {
  type: DiffLineType;
  /** Line content with the leading +/-/space prefix already stripped. */
  text: string;
  /** 1-based line number in the NEW file (undefined on pure deletions). */
  newNumber?: number;
  /** 1-based line number in the OLD file (undefined on pure additions). */
  oldNumber?: number;
  /** True when the original line had no trailing newline ("\ No newline..."). */
  noNewline?: boolean;
}

export interface DiffHunk {
  /** Header, e.g. "@@ -10,5 +10,7 @@". */
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  /** Display path (the new path, or the old path for deletions). */
  path: string;
  /** Previous path when the file was renamed/moved. */
  oldPath?: string;
  status: DiffFileStatus;
  /** True for binary changes (no textual hunks). */
  binary: boolean;
  hunks: DiffHunk[];
  /** Added line count across all hunks. */
  additions: number;
  /** Removed line count across all hunks. */
  deletions: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  /** True when no `diff --git` blocks could be parsed. */
  empty: boolean;
}

/** Render mode for the diff viewer. */
export type DiffViewMode = "unified" | "split";

