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
  timestamp: number;
  status?: "sending" | "streaming" | "done" | "error";
  tools?: ToolStep[];
  usage?: MessageUsage;
  thinkingTokens?: number;
  thinking?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ClaudeStatus {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

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

export interface WorkspaceInfo {
  path?: string | null;
  name?: string | null;
}

export interface WorkspaceState {
  id: string;
  path: string;
  name: string;
}

export interface ModelConfig {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
  CLAUDE_CODE_SUBAGENT_MODEL?: string;
  CLAUDE_CODE_EFFORT_LEVEL?: string;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** A Claude skill discovered on disk (user-, project- or plugin-level). */
export interface SkillEntry {
  name: string;
  description: string;
  source: "user" | "project" | "plugin";
  /** Text inserted into the input when picked, e.g. "/skill-name ". */
  invocation: string;
}

/** A configured Claude plugin marketplace (from `claude plugin marketplace list --json`). */
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

