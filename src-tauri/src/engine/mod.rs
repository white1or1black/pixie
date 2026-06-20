pub mod claude;
pub mod codebuddy;
pub mod cursor;
pub mod persistent;
mod shared;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
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

/// How far an engine has been verified, beyond the cheap binary check.
///
/// `check_available` only confirms the binary exists and runs `--version`; it
/// leaves `auth_state` at `Unknown`. A real readiness probe (`probe_engine`)
/// sends a tiny "ping" turn and classifies the outcome:
/// - `Ready` — the ping returned a result; the engine is logged in and usable.
/// - `NotAuthenticated` — the ping failed with an auth-shaped error (heuristic
///   string match; not exact — see `classify_probe_error`).
/// - `Error` — the ping failed for some other reason (the raw text is in
///   `EngineStatus::probe_error`).
/// - `NoResponse` — the probe produced no terminal event before the timeout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    #[default]
    Unknown,
    Ready,
    NotAuthenticated,
    Error,
    NoResponse,
}

/// Wall-clock budget for a readiness probe before we give up as `NoResponse`.
/// Generous on purpose: the first call right after a fresh login (token
/// refresh + model/telemetry fetch) can be slow, and we'd rather wait than
/// wrongly report "not ready".
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
    /// Result of the readiness/auth probe. `Unknown` until `probe_engine` runs.
    #[serde(default)]
    pub auth_state: AuthState,
    /// Raw engine message accompanying a non-`Ready` probe outcome.
    #[serde(default)]
    pub probe_error: Option<String>,
}

impl EngineStatus {
    /// Build a status from the cheap binary/version check only (auth not probed).
    /// Centralizes the `auth_state = Unknown` default so engine modules don't
    /// repeat the new fields in every `check_available` arm.
    pub fn basic(
        id: &str,
        display_name: &str,
        available: bool,
        version: Option<String>,
        path: Option<String>,
        error: Option<String>,
    ) -> Self {
        Self {
            id: id.to_string(),
            display_name: display_name.to_string(),
            available,
            version,
            path,
            error,
            auth_state: AuthState::Unknown,
            probe_error: None,
        }
    }
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
    let display_name = engine_display_name(id);
    match id {
        "claude" => claude::check_available().await,
        "codebuddy" => codebuddy::check_available().await,
        "cursor" => cursor::check_available().await,
        _ => EngineStatus::basic(
            id,
            display_name,
            false,
            None,
            None,
            Some(format!("unknown engine: {id}")),
        ),
    }
}

pub async fn check_all_engines() -> Vec<EngineStatus> {
    let mut out = Vec::with_capacity(ENGINE_IDS.len());
    for id in ENGINE_IDS {
        out.push(check_engine(id).await);
    }
    out
}

// ---------------------------------------------------------------------------
// Readiness / auth probe
//
// Beyond the cheap binary check, we verify an engine actually works by sending
// a one-shot "ping" turn and classifying the result. This is the only reliable,
// engine-agnostic way to tell "logged in" from "not logged in": the credential
// stores differ per engine (Claude hides them in the macOS Keychain and may not
// even write `.credentials.json`), so we never inspect them — we just ask the
// engine to do something and watch what comes back.
// ---------------------------------------------------------------------------

/// Outcome of a readiness probe.
#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub state: AuthState,
    pub error: Option<String>,
}

impl ProbeOutcome {
    fn ready() -> Self {
        Self {
            state: AuthState::Ready,
            error: None,
        }
    }

    /// Classify a free-text failure message (from an `error` stream event or
    /// captured stderr) into `NotAuthenticated` vs `Error`, keeping the raw text.
    fn from_message(msg: &str) -> Self {
        let cleaned = shared::strip_ansi_and_controls(msg);
        let trimmed = cleaned.trim();
        Self {
            state: classify_probe_error(trimmed),
            error: Some(trimmed.to_string()),
        }
    }

    fn error(msg: impl Into<String>) -> Self {
        Self {
            state: AuthState::Error,
            error: Some(msg.into()),
        }
    }

    fn no_response() -> Self {
        Self {
            state: AuthState::NoResponse,
            error: Some("engine produced no response within the timeout".to_string()),
        }
    }
}

/// Heuristic: does this probe failure look like an auth/login problem?
///
/// The engines only give us free-text error messages (no structured code), so we
/// match against a keyword list. This is deliberately **best-effort** — a future
/// CLI version may rephrase an auth error, or a non-auth error may happen to
/// contain a keyword. Callers always surface the raw `probe_error` alongside the
/// label, so a misclassification stays recoverable for the user.
fn classify_probe_error(message: &str) -> AuthState {
    let lower = message.to_lowercase();
    const EN: &[&str] = &[
        "auth", "credential", "unauthorized", "forbidden", "401", "403", "api key",
        "apikey", "api-key", "access token", "not logged in", "not signed in", "log in",
        "sign in", "login", "signin",
    ];
    const ZH: &[&str] = &[
        "鉴权", "未登录", "请登录", "请先登录", "登录", "凭证", "授权失败", "身份验证", "认证",
    ];
    if EN.iter().any(|k| lower.contains(k)) || ZH.iter().any(|k| message.contains(k)) {
        AuthState::NotAuthenticated
    } else {
        AuthState::Error
    }
}

/// Read a probe child's stream until a terminal event (`Final`/`Error`) is seen,
/// the process exits, or the timeout elapses — then classify the outcome.
///
/// stderr is captured concurrently because auth failures often exit non-zero
/// with the error on stderr *before* emitting any stream-json.
pub async fn run_probe(engine_id: &str, mut child: Child) -> ProbeOutcome {
    let start = Instant::now();
    log::info!("[probe] {engine_id}: starting (pid {:?})", child.id());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout = match stdout {
        Some(s) => s,
        None => {
            log::warn!("[probe] {engine_id}: no stdout on child");
            return ProbeOutcome::error("probe produced no stdout");
        }
    };

    let stderr_task = tokio::spawn(async move {
        let Some(stderr) = stderr else {
            return String::new();
        };
        let mut reader = BufReader::new(stderr);
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf).await;
        buf
    });

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    // Scan stdout for the first terminal event. Bounded by PROBE_TIMEOUT.
    let scanned = tokio::time::timeout(PROBE_TIMEOUT, async {
        while let Some(line) = lines.next_line().await? {
            if shared::is_ignorable_stream_line(&line) {
                continue;
            }
            for evt in parse_line(engine_id, &line) {
                match evt {
                    NormalizedEvent::Final { .. } => return Ok(Some(ProbeOutcome::ready())),
                    NormalizedEvent::Error { message } => {
                        return Ok(Some(ProbeOutcome::from_message(&message)));
                    }
                    _ => {}
                }
            }
        }
        Ok::<_, std::io::Error>(None) // EOF with no terminal event
    })
    .await;

    // Reap the child regardless of outcome (we may have broken out early).
    let _ = child.kill().await;
    let _ = child.wait().await;

    let stderr_buf = match tokio::time::timeout(Duration::from_millis(500), stderr_task).await {
        Ok(Ok(s)) => s,
        _ => String::new(),
    };

    let outcome = match scanned {
        // A terminal event was seen on stdout.
        Ok(Ok(Some(outcome))) => outcome,
        // EOF with no terminal event: fall back to captured stderr (auth exits).
        Ok(Ok(None)) => {
            let msg = stderr_buf.trim();
            if !msg.is_empty() {
                ProbeOutcome::from_message(msg)
            } else {
                ProbeOutcome::error("engine produced no response")
            }
        }
        // stdout read error: fall back to stderr if we have it.
        Ok(Err(_io)) => {
            let msg = stderr_buf.trim();
            if !msg.is_empty() {
                ProbeOutcome::from_message(msg)
            } else {
                ProbeOutcome::error("failed to read engine output")
            }
        }
        // Timed out before any terminal event.
        Err(_elapsed) => ProbeOutcome::no_response(),
    };
    log::info!(
        "[probe] {engine_id}: {:?} after {}ms (stderr {} bytes, error: {:?})",
        outcome.state,
        start.elapsed().as_millis(),
        stderr_buf.len(),
        outcome.error
    );
    outcome
}

/// Probe a single engine's readiness: cheap-check first, and only if the binary
/// is present, send a real "ping" turn and classify the response.
pub async fn probe_engine(id: &str) -> EngineStatus {
    let mut status = check_engine(id).await;
    if !status.available {
        // Binary missing — nothing to probe; auth_state stays Unknown.
        return status;
    }
    let child = match id {
        "claude" => claude::spawn_probe().await,
        "codebuddy" => codebuddy::spawn_probe().await,
        "cursor" => cursor::spawn_probe().await,
        other => Err(anyhow::anyhow!("unknown engine: {other}")),
    };
    let outcome = match child {
        Ok(c) => run_probe(id, c).await,
        Err(e) => ProbeOutcome {
            state: AuthState::Error,
            error: Some(format!("failed to start probe: {e}")),
        },
    };
    status.auth_state = outcome.state;
    status.probe_error = outcome.error;
    status
}

/// Spawn the one-click login flow for an engine (opens a browser). Fire-and-
/// forget — the caller re-probes after the user completes login in the browser.
pub async fn login(id: &str) -> Result<()> {
    match id {
        "claude" => claude::spawn_login().await,
        "codebuddy" => codebuddy::spawn_login().await,
        "cursor" => cursor::spawn_login().await,
        other => anyhow::bail!("unknown engine: {other}"),
    }
}

// ---------------------------------------------------------------------------
// One-click install
// ---------------------------------------------------------------------------

/// The shell command that installs an engine CLI globally. Run via `sh -c` so
/// the cursor pipe (`curl ... | bash`) works. These mirror the commands shown
/// in the setup UI.
pub fn install_command(id: &str) -> Result<&'static str> {
    Ok(match id {
        "claude" => "npm install -g @anthropic-ai/claude-code",
        "codebuddy" => "npm install -g @tencent-ai/codebuddy-code",
        "cursor" => "curl https://cursor.com/install -fsS | bash",
        other => anyhow::bail!("unknown engine: {other}"),
    })
}

/// Result of a one-click install: whether the command exited 0, plus its
/// combined stdout/stderr (surfaced to the user on failure so they can debug —
/// e.g. missing npm/node, or a permissions error).
#[derive(Debug, Clone, Serialize)]
pub struct InstallOutcome {
    pub success: bool,
    pub output: String,
}

/// Run an engine's install command in the user's home dir, with the login-shell
/// environment (so npm/node on PATH — including nvm/homebrew — are found).
pub async fn install(id: &str) -> Result<InstallOutcome> {
    let cmd = install_command(id)?;
    let env = shared::get_shell_env().await.clone();
    let home = shared::home_dir();

    // `sh -c` on Unix (handles the cursor `curl … | bash` pipe), `cmd /C` on
    // Windows (where there's no sh and npm is `npm.cmd`). Note the cursor
    // install command is Unix-only (needs bash); on Windows it will fail and
    // surface that to the user.
    let mut c = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/C").arg(cmd);
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    if let Some(home) = &home {
        c.current_dir(home);
    }
    for (k, v) in &env {
        c.env(k, v);
    }
    log::info!("[install] {id}: running `{cmd}` in {:?}", home);
    let output = c.output().await.context("failed to run install command")?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stdout.trim().is_empty() {
        stderr
    } else if stderr.trim().is_empty() {
        stdout
    } else {
        format!("{stdout}\n{stderr}")
    };
    let success = output.status.success();
    log::info!("[install] {id}: success={success}, {} output bytes", combined.len());
    Ok(InstallOutcome { success, output: combined })
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
    pub async fn read_stream<F>(&mut self, engine_id: &str, on_events: F) -> Result<String>
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
    let entry =
        guard
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
