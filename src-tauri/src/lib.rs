mod engine;
mod pty;

use engine::{
    bind_conversation_engine, check_all_engines, conversation_engine_id,
    init_conversation_engine_map, normalize_engine_id, read_child_stream, remember_session_id,
    resolve_session_id, spawn_continue, spawn_headless, spawn_single, AgentProcess, ConversationEngineMap,
    EngineStatus, NormalizedEvent, SharedAgentProcess,
};
use engine::persistent::{
    self as ps, PersistentSession, SessionMap,
    IDLE_TIMEOUT, MAX_SESSIONS,
    read_persistent_turn,
};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use pty::PtyMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Data types shared with the frontend
// ---------------------------------------------------------------------------

/// Frontend app settings + workspace/session state, persisted as `config.json`.
/// Each field is optional/defaults so older files (or partial writes) still load.
/// `engine_model_configs` carries per-engine env overrides (incl. API keys) as an
/// opaque JSON blob — the frontend owns that schema.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub default_engine: Option<String>,
    #[serde(default)]
    pub engine_model_configs: serde_json::Value,
    #[serde(default)]
    pub workspaces: Vec<serde_json::Value>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
}

/// One line of `history.jsonl`: a conversation (full, with messages) and the
/// workspace path it belongs to. The conversation is an opaque JSON value so the
/// frontend stays the single source of truth for the message schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub workspace_id: String,
    pub conversation: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatusResponse {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
}

impl From<EngineStatus> for EngineStatusResponse {
    fn from(s: EngineStatus) -> Self {
        Self {
            id: s.id,
            display_name: s.display_name,
            available: s.available,
            version: s.version,
            path: s.path,
            error: s.error,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseChunk {
    pub conversation_id: String,
    pub content: String,
    pub event_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseDone {
    pub conversation_id: String,
    pub full_text: String,
}

/// Live tool-use activity (a tool starting or its result arriving) for real-time progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseTool {
    pub conversation_id: String,
    pub tool_use_id: String,
    /// "start" when a tool is invoked, "result" when its output arrives.
    pub kind: String,
    pub name: Option<String>,
    /// Raw tool `input` as a JSON string (present on "start").
    pub input: Option<String>,
    /// Tool result text (present on "result").
    pub content: Option<String>,
    pub is_error: bool,
}

/// Token / cost usage for a stage. `kind` = "turn" (per assistant message, accumulate for a
/// live total) or "final" (authoritative totals + cost/duration/turns from the result event).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseUsage {
    pub conversation_id: String,
    pub kind: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: Option<f64>,
    pub duration_ms: Option<u64>,
    pub num_turns: Option<u64>,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
}

/// Live thinking-budget token estimate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseThinking {
    pub conversation_id: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseError {
    pub conversation_id: String,
    pub error: String,
}

/// Permission request from the agent (it wants to run a tool and needs user approval).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponsePermissionRequest {
    pub conversation_id: String,
    /// Unique ID of the permission request (from the CLI).
    pub request_id: String,
    /// Tool name (e.g. "Bash", "Edit", "Write").
    pub tool_name: String,
    /// Tool input as a JSON value.
    pub input: serde_json::Value,
}

/// A chunk of the model's private reasoning (extended thinking) text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseThinkingText {
    pub conversation_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub path: Option<String>,
    pub name: Option<String>,
}

// ---------------------------------------------------------------------------
// Scheduled tasks
// ---------------------------------------------------------------------------

/// A user-chosen schedule preset. Tagged so the frontend can build the literal
/// `{ type: "daily_time", hour, minute }` shape directly (mirrors ClaudeStreamEvent).
/// Fields are authored in the user's LOCAL time.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ScheduleSpec {
    /// Daily at HH:MM (24h, local).
    DailyTime { hour: u32, minute: u32 },
    /// Every N minutes.
    EveryNMinutes { minutes: u32 },
    /// Every N hours.
    EveryNHours { hours: u32 },
    /// Weekdays (Mon–Fri) at HH:MM.
    WeekdaysTime { hour: u32, minute: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    /// Workspace folder path (WorkspaceState.path). Used as the claude process CWD.
    pub workspace: String,
    pub prompt: String,
    pub schedule: ScheduleSpec,
    pub enabled: bool,
    /// ISO-8601 (UTC) of the run we are currently waiting for. None when disabled.
    #[serde(default)]
    pub next_run: Option<String>,
    /// ISO-8601 (UTC) of the last successful fire, for display.
    #[serde(default)]
    pub last_run: Option<String>,
}

/// A completed (or failed) scheduled-task execution, persisted as the durable
/// "full AI execution record". The Rust `Conversation` struct intentionally does
/// not carry messages, so the result needs its own home on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRunRecord {
    /// Same id as the conversation_id used to run the task.
    pub id: String,
    pub task_id: String,
    pub task_name: String,
    pub workspace: String,
    pub prompt: String,
    /// Final assistant text (empty on error).
    pub result: String,
    /// "ok" | "error"
    pub status: String,
    /// ISO-8601 (UTC)
    pub started_at: String,
    /// ISO-8601 (UTC)
    pub finished_at: String,
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

type ProcessMap = Arc<Mutex<HashMap<String, SharedAgentProcess>>>;
/// conversation_id → child pid, so stop_generation can kill the running agent
/// process without contending for the streaming task's lock.
type KillRegistry = Arc<Mutex<HashMap<String, u32>>>;

pub struct AppState {
    /// Per-conversation agent processes for parallel execution
    processes: ProcessMap,
    /// conversation_id → engine binding (+ external session id for Cursor, etc.)
    conversation_engines: ConversationEngineMap,
    /// User-selected workspace directory
    workspace: Arc<Mutex<Option<String>>>,
    /// PTY sessions
    pty_map: PtyMap,
    /// Running agent child pids, for immediate stop without lock contention
    kill_registry: KillRegistry,
    /// Persistent (long-lived) sessions for Claude/CodeBuddy
    sessions: SessionMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// A Claude skill discovered on disk (user- or project-level), surfaced so the
/// input bar can offer a `/skill-name` picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntry {
    /// Slash-invocable name, e.g. "skill-creator".
    pub name: String,
    /// One-line description (from SKILL.md frontmatter, or derived from the body).
    pub description: String,
    /// "user" (from ~/.claude) or "project" (from <workspace>/.claude).
    pub source: String,
    /// What gets inserted into the textarea, e.g. "/skill-creator ".
    pub invocation: String,
}

// ---------------------------------------------------------------------------
// Agent event emission (engine-agnostic)
// ---------------------------------------------------------------------------

const MAX_TOOL_RESULT_CHARS: usize = engine::MAX_TOOL_RESULT_CHARS;

fn truncate_for_ui(text: &str, max: usize) -> String {
    engine::truncate_text(text, max)
}

fn usage_is_empty(u: &engine::UsageInfo) -> bool {
    u.input_tokens == 0
        && u.output_tokens == 0
        && u.cache_read_tokens == 0
        && u.cache_creation_tokens == 0
        && u.cost_usd.is_none()
        && u.duration_ms.is_none()
        && u.num_turns.is_none()
}

fn emit_agent_events(
    app: &AppHandle,
    conversation_id: &str,
    events: &[NormalizedEvent],
    last_thinking: &mut u64,
) {
    for evt in events {
        if let Some(text) = evt.streaming_text() {
            let event_type = evt
                .streaming_text_event_type()
                .unwrap_or("delta")
                .to_string();
            let _ = app.emit(
                "agent-response",
                ResponseChunk {
                    conversation_id: conversation_id.to_string(),
                    content: text,
                    event_type,
                },
            );
        }

        if let Some(thinking) = evt.streaming_thinking() {
            let _ = app.emit(
                "agent-thinking-text",
                ResponseThinkingText {
                    conversation_id: conversation_id.to_string(),
                    content: thinking,
                },
            );
        }

        if let Some(te) = evt.tool_event() {
            let (kind, name, input, content, is_error) = match &te.kind {
                engine::ToolEventKind::Start { name, input } => {
                    ("start", name.clone(), input.clone(), None, false)
                }
                engine::ToolEventKind::Result { content, is_error } => {
                    let truncated = content.as_ref().map(|c| truncate_for_ui(c, MAX_TOOL_RESULT_CHARS));
                    ("result", None, None, truncated, *is_error)
                }
            };
            let _ = app.emit(
                "agent-tool",
                ResponseTool {
                    conversation_id: conversation_id.to_string(),
                    tool_use_id: te.id.clone(),
                    kind: kind.to_string(),
                    name,
                    input,
                    content,
                    is_error,
                },
            );
        }

        if let Some(tokens) = evt.thinking_tokens() {
            if tokens >= last_thinking.saturating_add(8) {
                *last_thinking = tokens;
                let _ = app.emit(
                    "agent-thinking",
                    ResponseThinking {
                        conversation_id: conversation_id.to_string(),
                        tokens,
                    },
                );
            }
        }

        if let Some(u) = evt.usage() {
            if u.kind == "turn" && usage_is_empty(u) {
                continue;
            }
            let _ = app.emit(
                "agent-usage",
                ResponseUsage {
                    conversation_id: conversation_id.to_string(),
                    kind: u.kind.to_string(),
                    input_tokens: u.input_tokens,
                    output_tokens: u.output_tokens,
                    cache_read_tokens: u.cache_read_tokens,
                    cache_creation_tokens: u.cache_creation_tokens,
                    cost_usd: u.cost_usd,
                    duration_ms: u.duration_ms,
                    num_turns: u.num_turns,
                    model: u.model.clone(),
                    stop_reason: u.stop_reason.clone(),
                },
            );
        }

        if let NormalizedEvent::Error { message } = evt {
            let _ = app.emit(
                "agent-error",
                ResponseError {
                    conversation_id: conversation_id.to_string(),
                    error: message.clone(),
                },
            );
        }

        if let NormalizedEvent::PermissionRequest { id, tool_name, input } = evt {
            let _ = app.emit(
                "agent-permission-request",
                ResponsePermissionRequest {
                    conversation_id: conversation_id.to_string(),
                    request_id: id.clone(),
                    tool_name: tool_name.clone(),
                    input: input.clone(),
                },
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn send_message(
    message: String,
    conversation_id: String,
    engine: Option<String>,
    is_continue: Option<bool>,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let is_continue = is_continue.unwrap_or(false);
    let engine_id = match engine.as_deref() {
        Some(e) => normalize_engine_id(e).map_err(|e| e.to_string())?,
        None => {
            if let Some(existing) =
                conversation_engine_id(&state.conversation_engines, &conversation_id).await
            {
                normalize_engine_id(&existing).map_err(|e| e.to_string())?
            } else {
                "claude"
            }
        }
    };

    bind_conversation_engine(
        &state.conversation_engines,
        &conversation_id,
        engine_id,
    )
    .await;

    log::info!(
        "[send_message] start: conv_id={}, engine={}, is_continue={}, msg_len={}",
        conversation_id,
        engine_id,
        is_continue,
        message.len()
    );

    let workspace = state.workspace.lock().await.clone();
    let session_id =
        resolve_session_id(&state.conversation_engines, &conversation_id, engine_id).await;

    // --- Persistent session path (Claude / CodeBuddy) ---
    if engine_id == "claude" || engine_id == "codebuddy" {
        let sessions = state.sessions.clone();
        let kill_registry = state.kill_registry.clone();
        let conversation_engines = state.conversation_engines.clone();
        let app_handle = app.clone();
        let conv_id = conversation_id.clone();
        let engine_id_owned = engine_id.to_string();
        let message_owned = message.clone();
        let session_id_owned = session_id.clone();
        let workspace_owned = workspace.clone();

        tokio::spawn(async move {
            let mut sessions = sessions.lock().await;

            // Try to reuse an existing live session.
            let needs_spawn = match sessions.get_mut(&conv_id) {
                Some(session) => {
                    if session.is_alive() {
                        log::info!("[send_message] reusing persistent session for {}", conv_id);
                        // Write message to the existing session's stdin.
                        if let Err(e) = session.send_message(&message_owned).await {
                            log::warn!("[send_message] stdin write failed, will respawn: {}", e);
                            session.kill().await;
                            sessions.remove(&conv_id);
                            true
                        } else {
                            false
                        }
                    } else {
                        log::info!("[send_message] persistent session dead, will respawn");
                        sessions.remove(&conv_id);
                        true
                    }
                }
                None => true,
            };

            // Spawn a new persistent session if needed.
            if needs_spawn {
                let resume = is_continue;
                log::info!(
                    "[send_message] spawning persistent session: engine={}, resume={}",
                    engine_id_owned, resume
                );
                match PersistentSession::spawn(
                    &engine_id_owned,
                    &session_id_owned,
                    resume,
                    workspace_owned.as_deref(),
                )
                .await
                {
                    Ok(mut session) => {
                        // Send the first message via stdin.
                        if let Err(e) = session.send_message(&message_owned).await {
                            log::error!("[send_message] failed to write first message: {}", e);
                            let _ = app_handle.emit(
                                "agent-error",
                                ResponseError {
                                    conversation_id: conv_id.clone(),
                                    error: format!("Failed to send message: {}", e),
                                },
                            );
                            return;
                        }
                        if let Some(pid) = session.pid() {
                            log::info!("[send_message] persistent pid {} for conv {}", pid, conv_id);
                            kill_registry.lock().await.insert(conv_id.clone(), pid);
                        }
                        sessions.insert(conv_id.clone(), session);
                    }
                    Err(e) => {
                        log::error!("[send_message] persistent spawn failed: {}", e);
                        let _ = app_handle.emit(
                            "agent-error",
                            ResponseError {
                                conversation_id: conv_id.clone(),
                                error: format!("Failed to start {}: {}", engine_id_owned, e),
                            },
                        );
                        return;
                    }
                }
            }

            // Get the stdout reader from the session.
            let stdout = sessions
                .get(&conv_id)
                .map(|s| s.stdout())
                .unwrap();

            // We must release the sessions lock before reading, so the
            // read_persistent_turn can proceed without deadlock.
            drop(sessions);

            let engines_after = conversation_engines.clone();
            let conv_id_after = conv_id.clone();
            let engine_for_stream = engine_id_owned.clone();
            let mut last_thinking: u64 = 0;
            let mut stream_had_error = false;

            let result = read_persistent_turn(&engine_for_stream, stdout, |events| {
                for evt in events {
                    if matches!(evt, NormalizedEvent::Error { .. }) {
                        stream_had_error = true;
                    }
                    if let Some(sid) = evt.session_id() {
                        let engines = engines_after.clone();
                        let conv = conv_id.clone();
                        let eng = engine_id_owned.clone();
                        tokio::spawn(async move {
                            remember_session_id(&engines, &conv, &eng, &sid).await;
                        });
                    }
                }
                emit_agent_events(&app_handle, &conv_id, events, &mut last_thinking);
            })
            .await;

            // Remove PID from kill registry (the session process stays alive
            // but we don't want stop_generation to kill it now that the turn
            // is complete).
            kill_registry.lock().await.remove(&conv_id_after);

            // If the stream failed, the persistent session is likely dead.
            // Remove it so the next message will respawn.
            if result.is_err() || stream_had_error {
                let sessions_map = state_sessions_ref(&app_handle);
                let mut sessions = sessions_map.lock().await;
                if let Some(s) = sessions.get_mut(&conv_id_after) {
                    s.kill().await;
                    sessions.remove(&conv_id_after);
                }
            }

            if stream_had_error {
                log::info!("[send_message] persistent stream ended with error for conv {}", conv_id_after);
                return;
            }

            match result {
                Ok(full_text) => {
                    log::info!("[send_message] persistent done, total_len={}", full_text.len());
                    let _ = app_handle.emit(
                        "agent-done",
                        ResponseDone {
                            conversation_id: conv_id_after,
                            full_text,
                        },
                    );
                }
                Err(e) => {
                    log::error!("[send_message] persistent stream error: {}", e);
                    let _ = app_handle.emit(
                        "agent-error",
                        ResponseError {
                            conversation_id: conv_id_after,
                            error: e.to_string(),
                        },
                    );
                }
            }
        });

        return Ok(());
    }

    // --- Legacy path (Cursor) ---
    {
        let mut processes = state.processes.lock().await;
        if !processes.contains_key(&conversation_id) {
            processes.insert(
                conversation_id.clone(),
                Arc::new(Mutex::new(AgentProcess::new())),
            );
        }
    }

    let kill_registry = state.kill_registry.clone();
    let conversation_engines = state.conversation_engines.clone();
    let app_handle = app.clone();
    let conv_id = conversation_id.clone();
    let engine_id_owned = engine_id.to_string();
    let message_owned = message.clone();

    tokio::spawn(async move {
        let spawn_result = if is_continue {
            spawn_continue(
                &engine_id_owned,
                &session_id,
                &message_owned,
                workspace.as_deref(),
            )
            .await
        } else {
            spawn_single(
                &engine_id_owned,
                &session_id,
                &message_owned,
                workspace.as_deref(),
            )
            .await
        };

        let child = match spawn_result {
            Err(e) => {
                log::error!("[send_message] spawn failed: {}", e);
                let _ = app_handle.emit(
                    "agent-error",
                    ResponseError {
                        conversation_id: conv_id.clone(),
                        error: format!("Failed to start {}: {}", engine_id_owned, e),
                    },
                );
                return;
            }
            Ok(child) => child,
        };

        if let Some(pid) = child.id() {
            log::info!("[send_message] registered pid {} for conv {}", pid, conv_id);
            kill_registry.lock().await.insert(conv_id.clone(), pid);
        }

        log::info!("[send_message] process spawned, reading stream...");

        let app_after = app_handle.clone();
        let conv_id_after = conv_id.clone();
        let engines_after = conversation_engines.clone();
        let engine_for_stream = engine_id_owned.clone();
        let mut last_thinking: u64 = 0;
        let mut stream_had_error = false;

        let result = read_child_stream(&engine_for_stream, child, |events| {
            for evt in events {
                if matches!(evt, NormalizedEvent::Error { .. }) {
                    stream_had_error = true;
                }
                if let Some(sid) = evt.session_id() {
                    let engines = engines_after.clone();
                    let conv = conv_id.clone();
                    let eng = engine_id_owned.clone();
                    tokio::spawn(async move {
                        remember_session_id(&engines, &conv, &eng, &sid).await;
                    });
                }
            }
            emit_agent_events(&app_handle, &conv_id, events, &mut last_thinking);
        })
        .await;

        kill_registry.lock().await.remove(&conv_id_after);

        if stream_had_error {
            log::info!("[send_message] stream ended with error event for conv {}", conv_id_after);
            return;
        }

        match result {
            Ok(full_text) => {
                log::info!("[send_message] done, total_len={}", full_text.len());
                let _ = app_after.emit(
                    "agent-done",
                    ResponseDone {
                        conversation_id: conv_id_after,
                        full_text,
                    },
                );
            }
            Err(e) => {
                log::error!("[send_message] stream error: {}", e);
                let _ = app_after.emit(
                    "agent-error",
                    ResponseError {
                        conversation_id: conv_id_after,
                        error: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

/// Helper to get a reference to the SessionMap from the AppHandle.
/// This is needed inside spawned tasks where `state` is not available.
fn state_sessions_ref(app: &AppHandle) -> SessionMap {
    app.state::<AppState>().sessions.clone()
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        files.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    files.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

#[tauri::command]
async fn run_command(command: String, cwd: String) -> Result<String, String> {
    let output = std::process::Command::new("sh")
        .args(["-c", &command])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run command: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(format!("{}{}", stdout, stderr))
}

/// Open a URL (or other external target) in the user's system default
/// application via the platform's native opener. The in-app browser was
/// removed, so every external link is delegated to the OS instead.
#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    // Only let through URL schemes; block anything that looks like a path or
    // a dangerous scheme such as `file://` or `javascript:`.
    let lower = target.to_ascii_lowercase();
    let ok = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:");
    if !ok {
        return Err(format!("Refusing to open non-URL target: {}", target));
    }

    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![&target])
    } else if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", "start", "", &target])
    } else {
        ("xdg-open", vec![&target])
    };

    std::process::Command::new(program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to open '{}': {}", target, e))?;
    Ok(())
}

#[tauri::command]
async fn pty_spawn(
    id: String,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    pty::spawn_pty(
        &state.pty_map,
        &id,
        cwd.as_deref(),
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        app,
    )
}

#[tauri::command]
async fn pty_write(
    id: String,
    data: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    pty::pty_write(&state.pty_map, &id, &data)
}

#[tauri::command]
async fn pty_resize(
    id: String,
    rows: u16,
    cols: u16,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    pty::pty_resize(&state.pty_map, &id, rows, cols)
}

#[tauri::command]
async fn pty_kill(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    pty::kill_pty(&state.pty_map, &id);
    Ok(())
}

#[tauri::command]
async fn git_status(path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .args(["status", "--short"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
async fn git_log(path: String, count: Option<usize>) -> Result<String, String> {
    let n = count.unwrap_or(20);
    let output = std::process::Command::new("git")
        .args(["log", "--oneline", "--graph", "--decorate", format!("-{n}").as_str()])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
async fn git_diff(path: String, commit: Option<String>, staged: Option<bool>) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged.unwrap_or(false) { args.push("--staged"); }
    if let Some(ref c) = commit { args.push(c); }
    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    if content.len() > 500_000 {
        Ok(content[..500_000].to_string() + "\n\n... (truncated)")
    } else {
        Ok(content)
    }
}

// ---------------------------------------------------------------------------
// Skill discovery (user-level ~/.claude/skills + project-level .claude/skills)
// ---------------------------------------------------------------------------

/// Parse leading `---` YAML frontmatter from a SKILL.md body.
/// Returns `(name, description, body)`. When there is no frontmatter, the
/// whole text is returned as the body and both options are `None`. Line-based
/// (no byte-offset math) so it is safe on arbitrary UTF-8.
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>, String) {
    let mut lines = text.lines();
    let first = match lines.next() {
        Some(l) => l,
        None => return (None, None, String::new()),
    };
    if first.trim() != "---" {
        // No frontmatter: re-include the first line so description derivation
        // can read the document's first heading.
        let mut body = String::from(first);
        for l in lines {
            body.push('\n');
            body.push_str(l);
        }
        return (None, None, body);
    }

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut closed = false;
    let mut body = String::new();
    for line in lines {
        if !closed {
            if line.trim() == "---" {
                closed = true;
                continue;
            }
            if let Some(v) = line.strip_prefix("name:") {
                if name.is_none() {
                    name = Some(strip_scalar(v));
                }
            } else if let Some(v) = line.strip_prefix("description:") {
                if description.is_none() {
                    description = Some(strip_scalar(v));
                }
            }
        } else if !body.is_empty() {
            body.push('\n');
            body.push_str(line);
        } else {
            body.push_str(line);
        }
    }

    if closed {
        (name, description, body)
    } else {
        // Opening fence with no closing fence: treat as no frontmatter.
        (None, None, body)
    }
}

/// Trim a YAML scalar value, stripping surrounding quotes.
fn strip_scalar(v: &str) -> String {
    v.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

/// Derive a one-line description from the first meaningful markdown line.
fn derive_description(body: &str) -> String {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let cleaned = t.trim_start_matches('#').trim().replace("**", "");
        let cleaned = cleaned.trim();
        if !cleaned.is_empty() {
            return truncate_str(cleaned, 160);
        }
    }
    String::new()
}

/// Truncate to `n` chars (UTF-8 safe) with an ellipsis.
fn truncate_str(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

/// Build a SkillEntry from a `<skills>/<name>/SKILL.md` path.
/// The skill name falls back to the parent directory's stem when the
/// frontmatter omits `name`.
fn skill_entry_from_file(skill_md: &std::path::Path, source: &str) -> Option<SkillEntry> {
    let bytes = fs::read(skill_md).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let (fm_name, fm_desc, body) = parse_frontmatter(&text);

    let name = fm_name
        .or_else(|| {
            skill_md
                .parent()
                .and_then(|p| p.file_stem())
                .and_then(|s| s.to_str())
                .map(String::from)
        })?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(SkillEntry {
        name: name.clone(),
        description: truncate_str(&fm_desc.unwrap_or_else(|| derive_description(&body)), 200),
        source: source.to_string(),
        invocation: format!("/{} ", name),
    })
}

/// Scan `<root>/skills/*/SKILL.md` and append any entries found.
fn scan_skills(root: &std::path::Path, source: &str, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(root.join("skills")) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        if let Some(skill) = skill_entry_from_file(&skill_md, source) {
            out.push(skill);
        }
    }
}

/// Recursively walk a plugin tree and collect every `SKILL.md` found.
/// Used for `~/.claude/plugins`, whose layout is
/// `marketplaces/<mp>/(plugins|external_plugins)/<plugin>/skills/<skill>/SKILL.md`.
fn scan_plugin_skills(root: &std::path::Path, out: &mut Vec<SkillEntry>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            // Skip noisy / irrelevant trees (.git, .github, node_modules, ...).
            if name == "node_modules" || name.starts_with('.') {
                continue;
            }
            scan_plugin_skills(&path, out);
        } else if path.is_file() && name == "SKILL.md" {
            if let Some(skill) = skill_entry_from_file(&path, "plugin") {
                out.push(skill);
            }
        }
    }
}

/// List all discoverable skills: user-level (`~/.claude/skills`),
/// project-level (`<workspace>/.claude/skills`) and plugin skills
/// (`~/.claude/plugins/**/SKILL.md`). When names collide, project shadows
/// user, which shadows plugin.
#[tauri::command]
fn list_skills(workspace: Option<String>) -> Result<Vec<SkillEntry>, String> {
    let mut entries: Vec<SkillEntry> = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let claude_root = std::path::Path::new(&home).join(".claude");
        scan_skills(&claude_root, "user", &mut entries);
        scan_plugin_skills(&claude_root.join("plugins"), &mut entries);
    }
    if let Some(ws) = workspace {
        let ws = ws.trim();
        if !ws.is_empty() {
            let project_root = std::path::Path::new(ws).join(".claude");
            scan_skills(&project_root, "project", &mut entries);
        }
    }

    // Rank: project (0) > user (1) > plugin (2); then alphabetical by name.
    // dedup_by keeps the first of each name, so a project skill shadows a
    // same-named user skill, which shadows a plugin one.
    let rank = |s: &str| -> i32 {
        match s {
            "project" => 0,
            "user" => 1,
            _ => 2,
        }
    };
    entries.sort_by(|a, b| {
        rank(&a.source)
            .cmp(&rank(&b.source))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Plugin / marketplace management (thin wrappers around `claude plugin ...`)
// ---------------------------------------------------------------------------

/// `claude plugin marketplace list --json` — configured marketplaces, as the
/// raw JSON string for the frontend to parse.
#[tauri::command]
async fn plugin_marketplace_list() -> Result<String, String> {
    engine::claude::run_claude_command(vec![
        "plugin".into(),
        "marketplace".into(),
        "list".into(),
        "--json".into(),
    ])
    .await
    .map_err(|e| e.to_string())
}

/// `claude plugin list --json --available` — installed + available plugins across
/// all added marketplaces, as the raw JSON string for the frontend to parse.
#[tauri::command]
async fn plugin_available() -> Result<String, String> {
    engine::claude::run_claude_command(vec![
        "plugin".into(),
        "list".into(),
        "--json".into(),
        "--available".into(),
    ])
    .await
    .map_err(|e| e.to_string())
}

/// Add a marketplace from `owner/repo`, a git URL, or a local path.
#[tauri::command]
async fn plugin_marketplace_add(source: String, scope: Option<String>) -> Result<String, String> {
    let mut args = vec!["plugin".into(), "marketplace".into(), "add".into(), source];
    if let Some(s) = scope {
        args.push("--scope".into());
        args.push(s);
    }
    engine::claude::run_claude_command(args).await.map_err(|e| e.to_string())
}

/// Remove a configured marketplace by name.
#[tauri::command]
async fn plugin_marketplace_remove(name: String) -> Result<String, String> {
    engine::claude::run_claude_command(vec![
        "plugin".into(),
        "marketplace".into(),
        "remove".into(),
        name,
    ])
    .await
    .map_err(|e| e.to_string())
}

/// Install a plugin; `plugin_id` is `name@marketplace`.
#[tauri::command]
async fn plugin_install(plugin_id: String) -> Result<String, String> {
    engine::claude::run_claude_command(vec!["plugin".into(), "install".into(), plugin_id])
        .await
        .map_err(|e| e.to_string())
}

/// Uninstall an installed plugin by name.
#[tauri::command]
async fn plugin_uninstall(name: String) -> Result<String, String> {
    engine::claude::run_claude_command(vec!["plugin".into(), "uninstall".into(), name])
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_default_workspace_path(app: AppHandle) -> Result<String, String> {
    // A user-configured override (Settings) wins; otherwise default to ~/.pixie.
    if let Some(custom) = load_default_workspace_override(&app) {
        let dir = std::path::Path::new(&custom);
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("failed to create default workspace '{custom}': {e}"))?;
        return Ok(custom);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "cannot determine home directory".to_string())?;
    let dir = std::path::Path::new(&home).join(".pixie");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create ~/.pixie: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Configure the default working directory from Settings. `None` (or an empty
/// string) clears the override so the default falls back to `~/.pixie`. The
/// chosen folder is created if needed so it is usable as an agent CWD. This is
/// config-only: it does not move or modify existing workspaces.
#[tauri::command]
async fn set_default_workspace_path(
    path: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    match path {
        Some(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                persist_default_workspace_override(&app, &None);
                return Ok(());
            }
            std::fs::create_dir_all(&trimmed)
                .map_err(|e| format!("cannot use '{trimmed}' as default workspace: {e}"))?;
            persist_default_workspace_override(&app, &Some(trimmed));
        }
        None => {
            persist_default_workspace_override(&app, &None);
        }
    }
    Ok(())
}

/// Open a native folder picker and return the chosen path, or `None` if the
/// user cancelled. Unlike `select_workspace`, it has no side effects.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app.dialog().file().blocking_pick_folder().map(|d| d.to_string()))
}

#[tauri::command]
async fn set_active_workspace(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut workspace = state.workspace.lock().await;
    *workspace = Some(path);
    Ok(())
}

#[tauri::command]
async fn set_engine_model_config(
    engine: String,
    config: HashMap<String, String>,
) -> Result<(), String> {
    engine::set_engine_model_config(&engine, config);
    Ok(())
}

#[tauri::command]
async fn set_model_config(
    config: HashMap<String, String>,
) -> Result<(), String> {
    engine::set_model_config_overrides(config);
    Ok(())
}

#[tauri::command]
async fn stop_generation(
    conversation_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // First, check if this is a persistent session (Claude/CodeBuddy).
    {
        let mut sessions = state.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&conversation_id) {
            log::info!("[stop_generation] killing persistent session for conv {}", conversation_id);
            // Kill the persistent process. The next message will respawn via --resume.
            session.kill().await;
            sessions.remove(&conversation_id);
            return Ok(());
        }
    }

    // Legacy path (Cursor / fallback).
    let pid = {
        let registry = state.kill_registry.lock().await;
        registry.get(&conversation_id).copied()
    };

    if let Some(pid) = pid {
        log::info!("[stop_generation] killing claude pid {} for conv {}", pid, conversation_id);
        // Send SIGTERM to the claude process; its stdout closes, read_stream returns,
        // and the streaming task emits claude-done with whatever was streamed so far.
        let _ = tokio::process::Command::new("kill")
            .arg(pid.to_string())
            .kill_on_drop(true)
            .output()
            .await;
    } else {
        // Fallback: nothing in the registry (e.g. not streaming) — try the old path.
        let proc_arc = {
            let processes = state.processes.lock().await;
            processes.get(&conversation_id).cloned()
        };
        if let Some(proc_arc) = proc_arc {
            let mut proc = proc_arc.lock().await;
            proc.kill().await;
        }
    }

    Ok(())
}

/// Respond to a permission request from the agent.
/// When the agent emits a `permission_request` event, the frontend shows
/// a confirmation dialog. This command writes the user's response back
/// to the persistent session's stdin.
#[tauri::command]
async fn respond_permission(
    conversation_id: String,
    allow: bool,
    message: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let sessions = state_sessions_ref(&app);
    let mut sessions = sessions.lock().await;

    match sessions.get_mut(&conversation_id) {
        Some(session) => {
            if !session.is_alive() {
                return Err("Session is no longer alive".to_string());
            }
            session
                .respond_permission(allow, message.as_deref())
                .await
                .map_err(|e| format!("Failed to send permission response: {}", e))
        }
        None => Err(format!(
            "No persistent session found for conversation {}",
            conversation_id
        )),
    }
}

#[tauri::command]
async fn select_workspace(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dir = app.dialog().file().blocking_pick_folder();
    match dir {
        Some(path) => {
            let path_str = path.to_string();
            let mut workspace = state.workspace.lock().await;
            *workspace = Some(path_str.clone());
            // Persist
            persist_workspace(&app, &path_str);
            Ok(Some(path_str))
        }
        None => Ok(None),
    }
}

/// Open a multi-select file picker and return the chosen absolute paths.
/// Used by the composer's "attach file" button. Returns `None` if the user
/// cancelled, otherwise one string per picked file (in selection order).
#[tauri::command]
async fn pick_files(app: AppHandle) -> Result<Option<Vec<String>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let files = app.dialog().file().blocking_pick_files();
    Ok(files.map(|vec| vec.into_iter().map(|f| f.to_string()).collect()))
}

#[tauri::command]
async fn get_workspace(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceInfo, String> {
    let workspace = state.workspace.lock().await;
    match workspace.as_ref() {
        Some(path) => {
            let name = PathBuf::from(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string());
            Ok(WorkspaceInfo {
                path: Some(path.clone()),
                name,
            })
        }
        None => {
            // Try loading from persisted storage
            drop(workspace);
            let loaded = load_workspace(&app);
            if let Some(ref path) = loaded {
                let mut workspace = state.workspace.lock().await;
                *workspace = Some(path.clone());
                let name = PathBuf::from(path)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string());
                Ok(WorkspaceInfo {
                    path: Some(path.clone()),
                    name,
                })
            } else {
                Ok(WorkspaceInfo {
                    path: None,
                    name: None,
                })
            }
        }
    }
}

/// Load `config.json`, or `None` when the file does not exist yet (first run).
#[tauri::command]
async fn load_app_config(app: AppHandle) -> Result<Option<AppConfig>, String> {
    let file = get_data_dir(&app)?.join("config.json");
    if !file.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&file).map_err(|e| format!("Failed to read config.json: {e}"))?;
    // Tolerate a corrupted/partial file by falling back to defaults rather than
    // bricking the app on a bad read.
    let config: AppConfig = serde_json::from_str(&content).unwrap_or_default();
    Ok(Some(config))
}

/// Persist the full app config to `config.json` atomically.
#[tauri::command]
async fn save_app_config(config: AppConfig, app: AppHandle) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data directory: {e}"))?;
    let json = serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize config: {e}"))?;
    atomic_write(&data_dir.join("config.json"), &json)
}

/// Load every conversation from `history.jsonl` (one entry per line). Malformed
/// lines are skipped so a single bad line can't prevent startup.
#[tauri::command]
async fn load_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let file = get_data_dir(&app)?.join("history.jsonl");
    if !file.exists() {
        return Ok(vec![]);
    }
    let content = fs::read_to_string(&file).map_err(|e| format!("Failed to read history.jsonl: {e}"))?;
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<HistoryEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// Overwrite `history.jsonl` with one JSON line per entry (full snapshot).
/// The frontend coalesces/debounces calls so this receives the latest state.
#[tauri::command]
async fn save_history(entries: Vec<HistoryEntry>, app: AppHandle) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data directory: {e}"))?;
    let mut out = String::new();
    for entry in &entries {
        let line = serde_json::to_string(entry).map_err(|e| format!("Failed to serialize history entry: {e}"))?;
        out.push_str(&line);
        out.push('\n');
    }
    atomic_write(&data_dir.join("history.jsonl"), &out)
}

#[tauri::command]
async fn check_engines_available() -> Result<Vec<EngineStatusResponse>, String> {
    Ok(check_all_engines()
        .await
        .into_iter()
        .map(EngineStatusResponse::from)
        .collect())
}

#[tauri::command]
async fn check_engine_available(engine: String) -> Result<EngineStatusResponse, String> {
    Ok(engine::check_engine(&engine).await.into())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "pixie", "Pixie")
        .ok_or_else(|| "Failed to determine app data directory".to_string())?;
    Ok(dirs.data_dir().to_path_buf())
}

/// Atomically replace `path` with `content`: write to a temp file in the SAME
/// directory, then rename over the target. On macOS `fs::rename` is atomic
/// within one volume (the data dir always is), so a crash mid-write leaves the
/// previous file intact instead of a truncated/corrupt one.
fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| "target path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "data".to_string());
    let tmp = dir.join(format!("{file_name}.tmp"));
    fs::write(&tmp, content).map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to finalize {}: {e}", path.display()))?;
    Ok(())
}

fn persist_workspace(app: &AppHandle, path: &str) {
    if let Ok(data_dir) = get_data_dir(app) {
        let _ = fs::create_dir_all(&data_dir);
        let _ = fs::write(data_dir.join("workspace.txt"), path);
    }
}

fn load_workspace(app: &AppHandle) -> Option<String> {
    let data_dir = get_data_dir(app).ok()?;
    let file = data_dir.join("workspace.txt");
    if file.exists() {
        fs::read_to_string(file).ok()
    } else {
        None
    }
}

/// The user-configured default working directory override (Settings), or `None`
/// when unset (fall back to `~/.pixie`). Stored next to `workspace.txt`.
fn load_default_workspace_override(app: &AppHandle) -> Option<String> {
    let data_dir = get_data_dir(app).ok()?;
    let raw = fs::read_to_string(data_dir.join("default_workspace.txt")).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Persist (`Some`) or clear (`None`) the default working directory override.
fn persist_default_workspace_override(app: &AppHandle, path: &Option<String>) {
    let Ok(data_dir) = get_data_dir(app) else {
        return;
    };
    let _ = fs::create_dir_all(&data_dir);
    let file = data_dir.join("default_workspace.txt");
    match path {
        Some(p) => {
            let _ = fs::write(file, p);
        }
        None => {
            let _ = fs::remove_file(file);
        }
    }
}

// ---------------------------------------------------------------------------
// Scheduled tasks: validation, scheduling, persistence, execution
// ---------------------------------------------------------------------------

/// In-flight task ids, so the same task is never run twice concurrently even if a
/// run outlasts the scheduler tick interval.
static RUNNING_TASKS: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
fn running_tasks() -> &'static Mutex<HashSet<String>> {
    RUNNING_TASKS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn validate_schedule(spec: &ScheduleSpec) -> Result<(), String> {
    match spec {
        ScheduleSpec::DailyTime { hour, minute } | ScheduleSpec::WeekdaysTime { hour, minute } => {
            if *hour > 23 {
                return Err("hour must be 0-23".into());
            }
            if *minute > 59 {
                return Err("minute must be 0-59".into());
            }
        }
        ScheduleSpec::EveryNMinutes { minutes } => {
            if *minutes < 1 {
                return Err("minutes must be >= 1".into());
            }
        }
        ScheduleSpec::EveryNHours { hours } => {
            if *hours < 1 {
                return Err("hours must be >= 1".into());
            }
        }
    }
    Ok(())
}

/// Find the next local HH:MM:00 occurrence strictly after `now_local` whose weekday
/// satisfies `day_ok`. Scans today first, then forward. Returns None if no valid
/// candidate exists within a bounded window (defence against hand-edited invalid JSON).
fn next_local_occurrence<F>(
    now_local: DateTime<Local>,
    hour: u32,
    minute: u32,
    day_ok: F,
) -> Option<DateTime<Local>>
where
    F: Fn(u32) -> bool,
{
    let mut date: NaiveDate = now_local.naive_local().date();
    for _ in 0..8 {
        if let Some(naive) = date.and_hms_opt(hour, minute, 0) {
            if let Some(t) = Local.from_local_datetime(&naive).single() {
                if t > now_local && day_ok(t.weekday().num_days_from_monday()) {
                    return Some(t);
                }
            }
        }
        date = date.succ_opt().unwrap_or(date);
    }
    None
}

/// Compute the next fire instant (as a UTC ISO-8601 string) for a schedule, relative to `now_utc`.
/// Schedule fields are interpreted in the user's LOCAL time.
fn compute_next_run(spec: &ScheduleSpec, now_utc: DateTime<Utc>) -> Option<String> {
    let now_local = now_utc.with_timezone(&Local);
    let next_local = match spec {
        ScheduleSpec::DailyTime { hour, minute } => {
            next_local_occurrence(now_local, *hour, *minute, |_| true)?
        }
        ScheduleSpec::WeekdaysTime { hour, minute } => {
            // Monday=1 .. Friday=5 in num_days_from_monday.
            next_local_occurrence(now_local, *hour, *minute, |wd| wd >= 1 && wd <= 5)?
        }
        ScheduleSpec::EveryNMinutes { minutes } => {
            now_local + chrono::Duration::minutes((*minutes).max(1) as i64)
        }
        ScheduleSpec::EveryNHours { hours } => {
            now_local + chrono::Duration::hours((*hours).max(1) as i64)
        }
    };
    Some(next_local.with_timezone(&Utc).to_rfc3339())
}

fn load_scheduled_tasks(app: &AppHandle) -> Vec<ScheduledTask> {
    let Ok(data_dir) = get_data_dir(app) else {
        return vec![];
    };
    let path = data_dir.join("scheduled_tasks.json");
    if !path.exists() {
        return vec![];
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_scheduled_tasks(app: &AppHandle, tasks: &[ScheduledTask]) -> Result<(), String> {
    let data_dir = get_data_dir(app)?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;
    let json = serde_json::to_string_pretty(tasks)
        .map_err(|e| format!("Failed to serialize tasks: {}", e))?;
    fs::write(data_dir.join("scheduled_tasks.json"), json)
        .map_err(|e| format!("Failed to write tasks: {}", e))
}

fn load_task_runs(app: &AppHandle) -> Vec<TaskRunRecord> {
    let Ok(data_dir) = get_data_dir(app) else {
        return vec![];
    };
    let path = data_dir.join("task_runs.json");
    if !path.exists() {
        return vec![];
    }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn record_task_run(app: &AppHandle, record: TaskRunRecord) {
    let Ok(data_dir) = get_data_dir(app) else {
        return;
    };
    let _ = fs::create_dir_all(&data_dir);
    let path = data_dir.join("task_runs.json");
    let mut runs: Vec<TaskRunRecord> = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        vec![]
    };
    // Dedupe by id (replace) then trim to the most recent 500.
    runs.retain(|r| r.id != record.id);
    runs.push(record);
    let keep_from = runs.len().saturating_sub(500);
    runs.drain(0..keep_from);
    if let Ok(json) = serde_json::to_string_pretty(&runs) {
        let _ = fs::write(&path, json);
    }
}

/// Trailing path segment, for short notification bodies.
fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Run a task's prompt against its workspace headlessly: fire a notification on start,
/// spawn a standalone ClaudeProcess (isolated from interactive chat state), read the
/// full result, record it, fire a completion notification, and emit a `task-run-complete`
/// event so an open window can refresh. Does NOT advance the schedule (the scheduler loop
/// does that before spawning, and manual run-now must not advance).
async fn run_task_headless(app: AppHandle, task: ScheduledTask, conversation_id: String) {
    use tauri_plugin_notification::NotificationExt;

    let started = Utc::now();
    let title = format!("⚡ {}", task.name);
    let dir_label = basename(&task.workspace);

    // Notify: started.
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(format!("Running in {}…", dir_label))
        .show();

    // Guard against a vanished workspace before spawning.
    if !std::path::Path::new(&task.workspace).is_dir() {
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body("Workspace no longer exists — skipped.")
            .show();
        record_task_run(
            &app,
            TaskRunRecord {
                id: conversation_id.clone(),
                task_id: task.id.clone(),
                task_name: task.name.clone(),
                workspace: task.workspace.clone(),
                prompt: task.prompt.clone(),
                result: String::new(),
                status: "error".into(),
                started_at: started.to_rfc3339(),
                finished_at: Utc::now().to_rfc3339(),
            },
        );
        let _ = app.emit(
            "task-run-complete",
            serde_json::json!({ "task_id": task.id, "conversation_id": conversation_id, "status": "error" }),
        );
        return;
    }

    let child = match spawn_headless(
        "claude",
        &conversation_id,
        &task.prompt,
        Some(&task.workspace),
    )
    .await
    {
        Ok(child) => child,
        Err(e) => {
            log::error!("[scheduled] spawn failed for '{}': {}", task.name, e);
            let _ = app
                .notification()
                .builder()
                .title(&title)
                .body(format!("Failed to start: {}", e))
                .show();
            record_task_run(
                &app,
                TaskRunRecord {
                    id: conversation_id.clone(),
                    task_id: task.id.clone(),
                    task_name: task.name.clone(),
                    workspace: task.workspace.clone(),
                    prompt: task.prompt.clone(),
                    result: String::new(),
                    status: "error".into(),
                    started_at: started.to_rfc3339(),
                    finished_at: Utc::now().to_rfc3339(),
                },
            );
            let _ = app.emit(
                "task-run-complete",
                serde_json::json!({ "task_id": task.id, "conversation_id": conversation_id, "status": "error" }),
            );
            return;
        }
    };

    // Read the stream to completion. The on_event closure is intentionally a no-op:
    // we surface scheduled runs via the recorded result + notification rather than
    // streaming into an interactive chat keyed by the same conversation_id.
    let result = read_child_stream("claude", child, |_events| {}).await;
    let finished = Utc::now();

    match result {
        Ok(full_text) => {
            let preview = if full_text.is_empty() {
                "Completed (no output).".to_string()
            } else {
                full_text.chars().take(160).collect::<String>()
            };
            let _ = app
                .notification()
                .builder()
                .title(&title)
                .body(preview)
                .show();
            record_task_run(
                &app,
                TaskRunRecord {
                    id: conversation_id.clone(),
                    task_id: task.id.clone(),
                    task_name: task.name.clone(),
                    workspace: task.workspace.clone(),
                    prompt: task.prompt.clone(),
                    result: full_text,
                    status: "ok".into(),
                    started_at: started.to_rfc3339(),
                    finished_at: finished.to_rfc3339(),
                },
            );
            let _ = app.emit(
                "task-run-complete",
                serde_json::json!({ "task_id": task.id, "conversation_id": conversation_id, "status": "ok" }),
            );
        }
        Err(e) => {
            log::error!("[scheduled] stream error for '{}': {}", task.name, e);
            let _ = app
                .notification()
                .builder()
                .title(&title)
                .body(format!("Error: {}", e))
                .show();
            record_task_run(
                &app,
                TaskRunRecord {
                    id: conversation_id.clone(),
                    task_id: task.id.clone(),
                    task_name: task.name.clone(),
                    workspace: task.workspace.clone(),
                    prompt: task.prompt.clone(),
                    result: String::new(),
                    status: "error".into(),
                    started_at: started.to_rfc3339(),
                    finished_at: finished.to_rfc3339(),
                },
            );
            let _ = app.emit(
                "task-run-complete",
                serde_json::json!({ "task_id": task.id, "conversation_id": conversation_id, "status": "error" }),
            );
        }
    }
}

/// One scheduler tick: find enabled tasks whose next_run is due and fire them.
/// Skips catch-up (a task stale by more than 5 minutes only advances, never fires)
/// and guards against overlapping runs of the same task.
async fn check_and_run_due_tasks(app: &AppHandle) {
    let now = Utc::now();
    let mut tasks = load_scheduled_tasks(app);
    let mut changed = false;

    for task in tasks.iter_mut() {
        if !task.enabled {
            continue;
        }

        // Resolve the pending fire instant, computing it lazily if missing.
        let next: Option<DateTime<Utc>> = task
            .next_run
            .as_ref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .or_else(|| {
                compute_next_run(&task.schedule, now)
                    .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                    .map(|d| d.with_timezone(&Utc))
            });

        let Some(next) = next else {
            continue;
        };

        if next > now {
            // Not due yet — keep next_run populated for the panel display.
            if task.next_run.is_none() {
                task.next_run = Some(next.to_rfc3339());
                changed = true;
            }
            continue;
        }

        // Due. If it's stale by more than 5 minutes the app was closed across the
        // scheduled time: advance without firing (skip catch-up).
        let stale = now.signed_duration_since(next);
        if stale.num_minutes() > 5 {
            task.next_run = compute_next_run(&task.schedule, now);
            changed = true;
            continue;
        }

        // Re-entrancy guard: skip if this task is already running.
        {
            let mut running = running_tasks().lock().await;
            if running.contains(&task.id) {
                continue;
            }
            running.insert(task.id.clone());
        }

        // Advance next_run (and mark last_run) BEFORE spawning, persisted before the
        // async run, so a crash or fast re-tick never double-fires.
        task.last_run = Some(now.to_rfc3339());
        task.next_run = compute_next_run(&task.schedule, now);
        changed = true;

        let task_id = task.id.clone();
        let to_run = task.clone();
        let conversation_id = uuid::Uuid::new_v4().to_string();
        let app_for_run = app.clone();
        tauri::async_runtime::spawn(async move {
            run_task_headless(app_for_run, to_run, conversation_id).await;
            running_tasks().lock().await.remove(&task_id);
        });
    }

    if changed {
        if let Err(e) = persist_scheduled_tasks(app, &tasks) {
            log::error!("[scheduler] persist failed: {}", e);
        }
    }
}

#[tauri::command]
async fn list_scheduled_tasks(app: AppHandle) -> Result<Vec<ScheduledTask>, String> {
    Ok(load_scheduled_tasks(&app))
}

#[tauri::command]
async fn create_scheduled_task(
    app: AppHandle,
    mut task: ScheduledTask,
) -> Result<ScheduledTask, String> {
    validate_schedule(&task.schedule)?;
    if task.id.is_empty() {
        task.id = uuid::Uuid::new_v4().to_string();
    }
    task.next_run = if task.enabled {
        compute_next_run(&task.schedule, Utc::now())
    } else {
        None
    };
    task.last_run = None;
    let mut tasks = load_scheduled_tasks(&app);
    tasks.push(task.clone());
    persist_scheduled_tasks(&app, &tasks)?;
    Ok(task)
}

#[tauri::command]
async fn update_scheduled_task(app: AppHandle, mut task: ScheduledTask) -> Result<(), String> {
    validate_schedule(&task.schedule)?;
    task.next_run = if task.enabled {
        compute_next_run(&task.schedule, Utc::now())
    } else {
        None
    };
    let mut tasks = load_scheduled_tasks(&app);
    if let Some(existing) = tasks.iter_mut().find(|t| t.id == task.id) {
        // Preserve last_run across edits.
        task.last_run = existing.last_run.clone();
        *existing = task;
    } else {
        return Err("Task not found".into());
    }
    persist_scheduled_tasks(&app, &tasks)
}

#[tauri::command]
async fn delete_scheduled_task(app: AppHandle, task_id: String) -> Result<(), String> {
    let mut tasks = load_scheduled_tasks(&app);
    tasks.retain(|t| t.id != task_id);
    persist_scheduled_tasks(&app, &tasks)
}

#[tauri::command]
async fn toggle_scheduled_task(
    app: AppHandle,
    task_id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut tasks = load_scheduled_tasks(&app);
    if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
        t.enabled = enabled;
        t.next_run = if enabled {
            compute_next_run(&t.schedule, Utc::now())
        } else {
            None
        };
    } else {
        return Err("Task not found".into());
    }
    persist_scheduled_tasks(&app, &tasks)
}

/// Fire a task immediately (manual "Run now"). Does not advance next_run.
#[tauri::command]
async fn run_scheduled_task_now(app: AppHandle, task_id: String) -> Result<String, String> {
    let tasks = load_scheduled_tasks(&app);
    let task = tasks
        .into_iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| "Task not found".to_string())?;
    let conversation_id = uuid::Uuid::new_v4().to_string();
    let app_for_run = app.clone();
    let conv_for_ret = conversation_id.clone();
    tauri::async_runtime::spawn(async move {
        run_task_headless(app_for_run, task, conversation_id).await;
    });
    Ok(conv_for_ret)
}

#[tauri::command]
async fn list_task_runs(app: AppHandle) -> Result<Vec<TaskRunRecord>, String> {
    Ok(load_task_runs(&app))
}

// ---------------------------------------------------------------------------
// Application entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // --- Scheduled tasks background loop ---
            // Tick every 60s and fire any enabled task whose next_run is due.
            let scheduler_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                // The first tick fires immediately — run once on startup to catch up,
                // then settle into the 60s cadence.
                loop {
                    ticker.tick().await;
                    check_and_run_due_tasks(&scheduler_handle).await;
                }
            });

            // --- Idle persistent session cleanup ---
            // Kill sessions that have been idle too long, and enforce the
            // maximum concurrent session limit.
            {
                let sessions: SessionMap = app.state::<AppState>().sessions.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
                    loop {
                        interval.tick().await;
                        let mut sessions = sessions.lock().await;
                        // Shut down idle sessions.
                        sessions.retain(|conv_id, session| {
                            if session.last_active.elapsed() > IDLE_TIMEOUT {
                                log::info!(
                                    "[cleanup] idle timeout: closing persistent session for {}",
                                    conv_id
                                );
                                // Can't call async shutdown here (retain is sync),
                                // so just kill. Drop will also send SIGTERM.
                                true // will remove below
                            } else {
                                true
                            }
                        });
                        // Actually remove and kill the idle ones.
                        let idle_keys: Vec<String> = sessions
                            .iter()
                            .filter(|(_, s)| s.last_active.elapsed() > IDLE_TIMEOUT)
                            .map(|(k, _)| k.clone())
                            .collect();
                        for key in idle_keys {
                            if let Some(mut s) = sessions.remove(&key) {
                                s.kill().await;
                            }
                        }
                        // Enforce MAX_SESSIONS: evict the least recently used.
                        if sessions.len() > MAX_SESSIONS {
                            let mut entries: Vec<(String, std::time::Instant)> = sessions
                                .iter()
                                .map(|(k, s)| (k.clone(), s.last_active))
                                .collect();
                            entries.sort_by_key(|(_, t)| *t);
                            while sessions.len() > MAX_SESSIONS {
                                if let Some((oldest_id, _)) = entries.first() {
                                    if let Some(mut s) = sessions.remove(oldest_id) {
                                        log::info!("[cleanup] evicting LRU session for {}", oldest_id);
                                        s.kill().await;
                                    }
                                }
                            }
                        }
                    }
                });
            }

            // --- System tray (keeps the app resident when the window is hidden) ---
            let show_item = MenuItem::with_id(app, "show", "Show Pixie", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Pixie", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "no default window icon for tray".to_string())?;

            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Pixie")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .manage(AppState {
            processes: Arc::new(Mutex::new(HashMap::new())),
            conversation_engines: init_conversation_engine_map(),
            workspace: Arc::new(Mutex::new(None)),
            pty_map: pty::init_pty_map(),
            kill_registry: Arc::new(Mutex::new(HashMap::new())),
            sessions: ps::init_session_map(),
        })
        .on_window_event(|window, event| {
            // Close button hides to tray instead of quitting, so scheduled tasks keep firing.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            send_message,
            set_engine_model_config,
            set_model_config,
            list_directory,
            read_file_content,
            open_external,
            list_skills,
            plugin_marketplace_list,
            plugin_available,
            plugin_marketplace_add,
            plugin_marketplace_remove,
            plugin_install,
            plugin_uninstall,
            git_status,
            git_log,
            git_diff,
            run_command,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            stop_generation,
            respond_permission,
            get_default_workspace_path,
            set_default_workspace_path,
            pick_folder,
            select_workspace,
            pick_files,
            get_workspace,
            set_active_workspace,
            load_app_config,
            save_app_config,
            load_history,
            save_history,
            check_engines_available,
            check_engine_available,
            list_scheduled_tasks,
            create_scheduled_task,
            update_scheduled_task,
            delete_scheduled_task,
            toggle_scheduled_task,
            run_scheduled_task_now,
            list_task_runs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_name_and_description() {
        let text = "---\nname: my-skill\ndescription: Does a thing.\n---\n# Body\n";
        let (name, desc, body) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(desc.as_deref(), Some("Does a thing."));
        assert!(body.contains("# Body"));
    }

    #[test]
    fn frontmatter_absent_returns_whole_body() {
        // Mirrors the project's workflows/*.md (no frontmatter).
        let text = "# AI Chat Desktop App\n\nSome content";
        let (name, desc, body) = parse_frontmatter(text);
        assert!(name.is_none());
        assert!(desc.is_none());
        assert!(body.starts_with("# AI Chat Desktop App"));
    }

    #[test]
    fn every_skill_has_name_and_invocation() {
        // Integration check against the real host. Passes on any machine
        // (just asserts invariants on whatever was found); reports the count.
        let skills = list_skills(None).unwrap_or_default();
        let plugin_count = skills.iter().filter(|s| s.source == "plugin").count();
        eprintln!("list_skills(None) -> {} skills ({} plugin)", skills.len(), plugin_count);
        for s in &skills {
            assert!(!s.name.is_empty(), "empty name: {:?}", s);
            assert!(s.invocation.starts_with('/') && s.invocation.ends_with(' '), "bad invocation: {:?}", s);
        }
    }
}
