pub mod claude;
pub mod codebuddy;
pub mod cursor;
mod shared;
pub mod persistent;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

pub use shared::{
    set_engine_model_config, set_model_config_overrides, truncate_text, MAX_TOOL_RESULT_CHARS,
};

/// Registered agent engine identifiers.
///
/// To add a new engine:
/// 1. Add its id here and in `engine_display_name`.
/// 2. Create `engine/<name>.rs` with `check_available`, `spawn_*`, `parse_line`.
/// 3. Wire dispatch in `check_engine`, `spawn_single`, `spawn_continue`, `parse_line`.
pub const ENGINE_IDS: &[&str] = &["claude", "cursor", "codebuddy"];

pub fn normalize_engine_id(id: &str) -> Result<&'static str> {
    match id {
        "claude" => Ok("claude"),
        "cursor" => Ok("cursor"),
        "codebuddy" => Ok("codebuddy"),
        other => anyhow::bail!("unknown engine: {other}"),
    }
}

pub fn engine_display_name(id: &str) -> &'static str {
    match id {
        "claude" => "Claude Code",
        "cursor" => "Cursor Agent",
        "codebuddy" => "CodeBuddy",
        _ => "Unknown",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Normalized stream events (engine-agnostic)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum ToolEventKind {
    Start {
        name: Option<String>,
        input: Option<String>,
    },
    Result {
        content: Option<String>,
        is_error: bool,
    },
}

#[derive(Debug, Clone)]
pub struct ToolEvent {
    pub id: String,
    pub kind: ToolEventKind,
}

#[derive(Debug, Clone)]
pub struct UsageInfo {
    pub kind: &'static str,
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

#[derive(Debug, Clone)]
pub enum NormalizedEvent {
    TextDelta {
        text: String,
        event_type: &'static str,
    },
    ThinkingText {
        content: String,
    },
    ThinkingTokens {
        tokens: u64,
    },
    Tool(ToolEvent),
    Usage(UsageInfo),
    /// Emitted when the CLI assigns its own session id (e.g. Cursor init).
    SessionEstablished {
        session_id: String,
    },
    Final {
        text: String,
    },
    Error {
        message: String,
    },
    /// The agent is requesting permission to run a tool (e.g. Bash command).
    PermissionRequest {
        id: String,
        tool_name: String,
        input: serde_json::Value,
    },
}

impl NormalizedEvent {
    pub fn streaming_text(&self) -> Option<String> {
        match self {
            NormalizedEvent::TextDelta { text, .. } => Some(text.clone()),
            _ => None,
        }
    }

    pub fn streaming_text_event_type(&self) -> Option<&'static str> {
        match self {
            NormalizedEvent::TextDelta { event_type, .. } => Some(event_type),
            _ => None,
        }
    }

    pub fn streaming_thinking(&self) -> Option<String> {
        match self {
            NormalizedEvent::ThinkingText { content } => Some(content.clone()),
            _ => None,
        }
    }

    pub fn tool_event(&self) -> Option<&ToolEvent> {
        match self {
            NormalizedEvent::Tool(te) => Some(te),
            _ => None,
        }
    }

    pub fn thinking_tokens(&self) -> Option<u64> {
        match self {
            NormalizedEvent::ThinkingTokens { tokens } => Some(*tokens),
            _ => None,
        }
    }

    pub fn usage(&self) -> Option<&UsageInfo> {
        match self {
            NormalizedEvent::Usage(u) => Some(u),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn final_text(&self) -> Option<String> {
        match self {
            NormalizedEvent::Final { text } => Some(text.clone()),
            NormalizedEvent::Error { message } => Some(message.clone()),
            _ => None,
        }
    }

    pub fn session_id(&self) -> Option<String> {
        match self {
            NormalizedEvent::SessionEstablished { session_id } => Some(session_id.clone()),
            _ => None,
        }
    }
}

pub fn parse_line(engine_id: &str, line: &str) -> Vec<NormalizedEvent> {
    match engine_id {
        "claude" => claude::parse_line(line),
        "codebuddy" => codebuddy::parse_line(line),
        "cursor" => cursor::parse_line(line),
        _ => vec![],
    }
}

pub async fn check_engine(id: &str) -> EngineStatus {
    let display_name = engine_display_name(id).to_string();
    match id {
        "claude" => claude::check_available().await,
        "codebuddy" => codebuddy::check_available().await,
        "cursor" => cursor::check_available().await,
        _ => EngineStatus {
            id: id.to_string(),
            display_name,
            available: false,
            version: None,
            path: None,
            error: Some(format!("unknown engine: {id}")),
        },
    }
}

pub async fn check_all_engines() -> Vec<EngineStatus> {
    let mut out = Vec::with_capacity(ENGINE_IDS.len());
    for id in ENGINE_IDS {
        out.push(check_engine(id).await);
    }
    out
}

/// Fetch available models for a given engine.
/// Returns a list of (model_id, display_label) pairs.
pub async fn list_models(engine_id: &str) -> Vec<(String, String)> {
    match engine_id {
        "claude" => claude::list_models().await,
        "codebuddy" => codebuddy::list_models().await,
        "cursor" => cursor::list_models().await,
        _ => vec![],
    }
}

pub async fn spawn_single(
    engine_id: &str,
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    match engine_id {
        "claude" => claude::spawn_single(session_id, message, cwd, model).await,
        "codebuddy" => codebuddy::spawn_single(session_id, message, cwd, model).await,
        "cursor" => cursor::spawn_single(session_id, message, cwd, model).await,
        other => anyhow::bail!("unknown engine: {other}"),
    }
}

/// Spawn a headless (auto-approved) agent process for scheduled tasks.
/// Uses `--dangerously-skip-permissions` because there is no user to approve.
pub async fn spawn_headless(
    engine_id: &str,
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
) -> Result<Child> {
    match engine_id {
        "claude" => claude::spawn_headless(session_id, message, cwd).await,
        // CodeBuddy/Cursor fall back to their regular spawn_single for now.
        other => spawn_single(other, session_id, message, cwd, None).await,
    }
}

pub async fn spawn_continue(
    engine_id: &str,
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    match engine_id {
        "claude" => claude::spawn_continue(session_id, message, cwd, model).await,
        "codebuddy" => codebuddy::spawn_continue(session_id, message, cwd, model).await,
        "cursor" => cursor::spawn_continue(session_id, message, cwd, model).await,
        other => anyhow::bail!("unknown engine: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Generic subprocess + stream reader
// ---------------------------------------------------------------------------

pub struct AgentProcess {
    child: Option<Child>,
}

impl AgentProcess {
    pub fn new() -> Self {
        Self { child: None }
    }

    #[allow(dead_code)]
    pub fn set_child(&mut self, child: Child) {
        self.child = Some(child);
    }

    #[allow(dead_code)]
    pub async fn read_stream<F>(
        &mut self,
        engine_id: &str,
        on_events: F,
    ) -> Result<String>
    where
        F: FnMut(&[NormalizedEvent]),
    {
        let child = self.child.take().context("no running agent process")?;
        read_child_stream(engine_id, child, on_events).await
    }

    pub async fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.child = None;
    }

    #[allow(dead_code)]
    pub fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(|c| c.id())
    }
}

/// Read NDJSON from a child process stdout until EOF, then wait for exit.
/// Callers should not hold per-conversation locks while this runs.
pub async fn read_child_stream<F>(
    engine_id: &str,
    mut child: Child,
    mut on_events: F,
) -> Result<String>
where
    F: FnMut(&[NormalizedEvent]),
{
    let stdout = child.stdout.take().context("stdout not captured")?;

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();
    let mut final_text = String::new();

    while let Some(line) = lines.next_line().await? {
        if shared::is_ignorable_stream_line(&line) {
            continue;
        }
        let events = parse_line(engine_id, &line);
        if events.is_empty() {
            continue;
        }
        for evt in &events {
            if let NormalizedEvent::Final { text } = evt {
                final_text = text.clone();
            }
        }
        on_events(&events);
    }

    let _ = child.wait().await;
    Ok(final_text)
}

pub type SharedAgentProcess = Arc<Mutex<AgentProcess>>;

/// Per-conversation engine binding + optional external session id (Cursor).
#[derive(Debug, Clone)]
pub struct ConversationEngineState {
    pub engine_id: String,
    pub external_session_id: Option<String>,
    /// Per-conversation model override (empty = use engine's global config).
    pub model: Option<String>,
}

pub type ConversationEngineMap = Arc<Mutex<HashMap<String, ConversationEngineState>>>;

pub fn init_conversation_engine_map() -> ConversationEngineMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn resolve_session_id(
    map: &ConversationEngineMap,
    conversation_id: &str,
    engine_id: &str,
) -> String {
    if engine_id == "claude" || engine_id == "codebuddy" {
        return conversation_id.to_string();
    }
    let guard = map.lock().await;
    guard
        .get(conversation_id)
        .and_then(|s| s.external_session_id.clone())
        .unwrap_or_else(|| conversation_id.to_string())
}

pub async fn remember_session_id(
    map: &ConversationEngineMap,
    conversation_id: &str,
    engine_id: &str,
    session_id: &str,
) {
    if engine_id == "claude" || engine_id == "codebuddy" {
        return;
    }
    let mut guard = map.lock().await;
    let entry = guard
        .entry(conversation_id.to_string())
        .or_insert_with(|| ConversationEngineState {
            engine_id: engine_id.to_string(),
            external_session_id: None,
            model: None,
        });
    entry.engine_id = engine_id.to_string();
    entry.external_session_id = Some(session_id.to_string());
}

pub async fn bind_conversation_engine(
    map: &ConversationEngineMap,
    conversation_id: &str,
    engine_id: &str,
) {
    let mut guard = map.lock().await;
    guard
        .entry(conversation_id.to_string())
        .or_insert_with(|| ConversationEngineState {
            engine_id: engine_id.to_string(),
            external_session_id: None,
            model: None,
        })
        .engine_id = engine_id.to_string();
}

pub async fn conversation_engine_id(
    map: &ConversationEngineMap,
    conversation_id: &str,
) -> Option<String> {
    let guard = map.lock().await;
    guard.get(conversation_id).map(|s| s.engine_id.clone())
}

pub async fn set_conversation_model(
    map: &ConversationEngineMap,
    conversation_id: &str,
    model: Option<String>,
) {
    let mut guard = map.lock().await;
    if let Some(entry) = guard.get_mut(conversation_id) {
        entry.model = model;
    }
}
