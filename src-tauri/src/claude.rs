use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Possible locations to search for the claude CLI binary.
const CLAUDE_BINARY_NAMES: &[&str] = &["claude"];

// ---------------------------------------------------------------------------
// Shell environment inheritance
// ---------------------------------------------------------------------------

const ENV_PREFIXES: &[&str] = &[
    "ANTHROPIC_",
    "CLAUDE",
    "AWS_",
    "GOOGLE_",
    "VERTEX_",
    "OPENAI_",
    "AZURE_",
];

const ENV_EXACT: &[&str] = &[
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "NODE_EXTRA_CA_CERTS",
];

async fn load_shell_env() -> HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    // Use interactive + login shell to source BOTH .zprofile AND .zshrc.
    // When launched from .app bundle, there's no terminal so only this
    // combination guarantees user-defined env vars (ANTHROPIC_*, etc.) are loaded.
    let output = tokio::process::Command::new(&shell)
        .args(["-i", "-l", "-c", "env"])
        .output()
        .await;

    let env_str = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return HashMap::new(),
    };

    let mut env = HashMap::new();
    for line in env_str.lines() {
        if let Some((k, v)) = line.split_once('=') {
            env.insert(k.to_string(), v.to_string());
        }
    }
    env
}

async fn get_shell_env() -> &'static HashMap<String, String> {
    static SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    if let Some(env) = SHELL_ENV.get() {
        return env;
    }
    let env = load_shell_env().await;
    SHELL_ENV.get_or_init(|| env)
}

static MODEL_CONFIG: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();

fn get_model_config() -> &'static std::sync::Mutex<HashMap<String, String>> {
    MODEL_CONFIG.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn set_model_config_overrides(config: HashMap<String, String>) {
    if let Ok(mut guard) = get_model_config().lock() {
        *guard = config;
    }
}

fn apply_model_config_overrides(env: &mut HashMap<String, String>) {
    if let Ok(guard) = get_model_config().lock() {
        for (k, v) in guard.iter() {
            if !v.is_empty() {
                env.insert(k.clone(), v.clone());
            }
        }
    }
}

async fn collect_env_for_claude() -> HashMap<String, String> {
    let shell_env = get_shell_env().await;
    let mut merged: HashMap<String, String> = HashMap::new();

    let should_include = |key: &str| -> bool {
        ENV_EXACT.contains(&key)
            || ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
    };

    for (k, v) in std::env::vars() {
        if should_include(&k) || k == "PATH" {
            merged.insert(k, v);
        }
    }

    for (k, v) in shell_env {
        if should_include(&k) || k == "PATH" {
            merged.insert(k.clone(), v.clone());
        }
    }

    if let Some(path) = merged.get_mut("PATH") {
        let extras = [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
        ];
        let existing: Vec<&str> = path.split(':').collect();
        let missing: Vec<&str> = extras.iter().filter(|e| !existing.contains(e)).copied().collect();
        for extra in missing {
            path.push(':');
            path.push_str(extra);
        }
    }

    apply_model_config_overrides(&mut merged);

    merged
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = vec![];

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            paths.push(PathBuf::from(dir));
        }
    }

    for p in &["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/snap/bin"] {
        paths.push(PathBuf::from(p));
    }

    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                for entry in entries.flatten() {
                    paths.push(entry.path().join("bin"));
                }
            }
        }
        paths.push(home.join(".local/bin"));
    }

    paths
}

pub fn find_claude_binary() -> Result<PathBuf> {
    for dir in candidate_paths() {
        for name in CLAUDE_BINARY_NAMES {
            let candidate = dir.join(name);
            if candidate.exists() && candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    anyhow::bail!(
        "claude CLI not found. Searched in: {}",
        candidate_paths()
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

pub async fn get_claude_version() -> Result<String> {
    let binary = find_claude_binary()?;
    let env = collect_env_for_claude().await;

    let mut cmd = Command::new(&binary);
    cmd.arg("--version");
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let output = cmd.output().await.context("failed to execute claude --version")?;
    if !output.status.success() {
        anyhow::bail!("claude --version returned non-zero exit status");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run `claude <args>` and return its stdout. Used by the plugin/marketplace
/// commands (`claude plugin ...`), which are fully scriptable headless. On a
/// non-zero exit the CLI's stderr (falling back to stdout) becomes the error.
pub async fn run_claude_command(args: Vec<String>) -> Result<String> {
    let binary = find_claude_binary()?;
    let env = collect_env_for_claude().await;

    let mut cmd = Command::new(&binary);
    cmd.args(&args);
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let output = cmd.output().await.context("failed to execute claude")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        anyhow::bail!("{}", if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ---------------------------------------------------------------------------
// Streaming JSON types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClaudeStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart {},

    #[serde(rename = "content_block_delta")]
    ContentBlockDelta {
        index: Option<usize>,
        delta: Delta,
    },

    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: Option<usize>,
        content_block: ContentBlock,
    },

    #[serde(rename = "message_stop")]
    MessageStop {},

    #[serde(rename = "error")]
    Error { error: ErrorData },

    #[serde(rename = "result")]
    Result {
        result: String,
        #[serde(default)]
        total_cost_usd: Option<f64>,
        #[serde(default)]
        duration_ms: Option<u64>,
        #[serde(default)]
        num_turns: Option<u64>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        stop_reason: Option<String>,
        #[serde(default, rename = "modelUsage")]
        model_usage: Option<serde_json::Value>,
    },

    #[serde(rename = "system")]
    System {
        #[serde(default)]
        subtype: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        /// Present on `thinking_tokens` subtype events: live thinking budget estimate.
        #[serde(default)]
        estimated_tokens: Option<u64>,
    },

    #[serde(rename = "assistant")]
    Assistant {
        #[serde(default)]
        message: Option<serde_json::Value>,
    },

    /// Tool results arrive inside a `user`-typed message (content blocks of type `tool_result`).
    #[serde(rename = "user")]
    User {
        #[serde(default)]
        message: Option<serde_json::Value>,
    },

    #[serde(rename = "tool_use")]
    ToolUse {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        input: Option<serde_json::Value>,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        #[serde(default)]
        tool_use_id: Option<String>,
        #[serde(default)]
        content: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Tool activity extraction (tool_use / tool_result) for live progress display
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum ToolEventKind {
    /// A tool was invoked: its name and raw `input` object (as a JSON string).
    Start {
        name: Option<String>,
        input: Option<String>,
    },
    /// A tool finished: its textual result and whether it errored.
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delta {
    #[serde(default, rename = "type")]
    pub delta_type: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub content_type: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorData {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}

impl ClaudeStreamEvent {
    /// Text to emit for streaming display (claude-response events).
    /// Includes assistant message text for real-time display.
    pub fn streaming_text(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::ContentBlockDelta { delta, .. } => delta.text.clone(),
            ClaudeStreamEvent::ContentBlockStart { content_block, .. } => content_block.text.clone(),
            ClaudeStreamEvent::Assistant { message } => {
                message.as_ref().and_then(|msg| {
                    msg.get("content")
                        .and_then(|c| c.as_array())
                        .and_then(|arr| arr.iter().find_map(|block| {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                block.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                            } else {
                                None
                            }
                        }))
                })
            }
            _ => None,
        }
    }

    /// The model's private reasoning text. Surfaces `thinking` content blocks
    /// from `assistant` messages so the UI can show what the model is reasoning
    /// about — the long "thinking" gap between a tool result and the answer
    /// otherwise looks like a freeze.
    pub fn streaming_thinking(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::Assistant { message } => message.as_ref().and_then(|msg| {
                msg.get("content").and_then(|c| c.as_array()).and_then(|arr| {
                    arr.iter().find_map(|block| {
                        if block.get("type").and_then(|t| t.as_str()) == Some("thinking") {
                            block
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
                })
            }),
            _ => None,
        }
    }

    /// Text for the final result only (claude-done event).
    /// Only the `result` event provides the definitive final text.
    pub fn final_text(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::Result { result, .. } => Some(result.clone()),
            ClaudeStreamEvent::Error { error } => {
                error.message.clone().or_else(|| Some("Unknown error".to_string()))
            }
            _ => None,
        }
    }

    /// Extract tool activity (tool_use starts / tool_result completions) from this event.
    ///
    /// Tool calls live inside `assistant` message content blocks, and their results inside
    /// `user` message content blocks. There are no top-level `tool_use`/`tool_result` events
    /// in practice, but we handle those variants defensively too.
    pub fn tool_events(&self) -> Vec<ToolEvent> {
        let mut out = Vec::new();

        let starts_from_content = |content: Option<&serde_json::Value>, out: &mut Vec<ToolEvent>| {
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let id = block
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).map(String::from);
                    let input = block.get("input").map(|v| v.to_string());
                    out.push(ToolEvent {
                        id,
                        kind: ToolEventKind::Start { name, input },
                    });
                }
            }
        };

        let results_from_content = |content: Option<&serde_json::Value>, out: &mut Vec<ToolEvent>| {
            if let Some(arr) = content.and_then(|c| c.as_array()) {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let id = block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    // result content may be a string or an array of blocks; coerce to text
                    let content = extract_result_text(block.get("content"));
                    let is_error = block
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    out.push(ToolEvent {
                        id,
                        kind: ToolEventKind::Result { content, is_error },
                    });
                }
            }
        };

        match self {
            ClaudeStreamEvent::Assistant { message } => {
                starts_from_content(message.as_ref().and_then(|m| m.get("content")), &mut out);
            }
            ClaudeStreamEvent::User { message } => {
                results_from_content(message.as_ref().and_then(|m| m.get("content")), &mut out);
            }
            ClaudeStreamEvent::ToolUse { id, name, input } => {
                out.push(ToolEvent {
                    id: id.clone().unwrap_or_default(),
                    kind: ToolEventKind::Start {
                        name: name.clone(),
                        input: input.as_ref().map(|v| v.to_string()),
                    },
                });
            }
            ClaudeStreamEvent::ToolResult { tool_use_id, content } => {
                out.push(ToolEvent {
                    id: tool_use_id.clone().unwrap_or_default(),
                    kind: ToolEventKind::Result {
                        content: content.clone(),
                        is_error: false,
                    },
                });
            }
            _ => {}
        }

        out
    }

    /// Live thinking-token estimate, present on `thinking_tokens` system events.
    pub fn thinking_tokens(&self) -> Option<u64> {
        match self {
            ClaudeStreamEvent::System { subtype, estimated_tokens, .. } => {
                if subtype.as_deref() == Some("thinking_tokens") {
                    *estimated_tokens
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Usage / cost extraction
// ---------------------------------------------------------------------------

/// Token + cost information for a stage of the response.
/// `Turn` is per assistant message (accumulated client-side for a live total);
/// `Final` is the authoritative total from the `result` event.
#[derive(Debug, Clone)]
pub struct UsageInfo {
    pub kind: &'static str, // "turn" | "final"
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

impl ClaudeStreamEvent {
    /// Extract usage. `Assistant` messages carry per-turn token counts (kind = "turn");
    /// the `Result` event carries authoritative totals aggregated from `modelUsage`
    /// plus cost/duration/turns (kind = "final"). Zero-token turns are skipped.
    pub fn usage(&self) -> Option<UsageInfo> {
        match self {
            ClaudeStreamEvent::Assistant { message } => {
                let usage = message.as_ref().and_then(|m| m.get("usage"))?;
                let input = u64_field(usage, "input_tokens");
                let output = u64_field(usage, "output_tokens");
                let cache_read = u64_field(usage, "cache_read_input_tokens");
                let cache_creation = u64_field(usage, "cache_creation_input_tokens");
                if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                    return None; // thinking-only / placeholder messages
                }
                Some(UsageInfo {
                    kind: "turn",
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cache_read,
                    cache_creation_tokens: cache_creation,
                    cost_usd: None,
                    duration_ms: None,
                    num_turns: None,
                    model: None,
                    stop_reason: None,
                })
            }
            ClaudeStreamEvent::Result { .. } => self.final_usage(),
            _ => None,
        }
    }

    /// Build the authoritative final usage from the stored `result` fields.
    /// The result event's top-level `usage` is often zeroed in this CLI, so we
    /// aggregate token totals from `modelUsage` (per model) instead.
    fn final_usage(&self) -> Option<UsageInfo> {
        let ClaudeStreamEvent::Result {
            total_cost_usd,
            duration_ms,
            num_turns,
            model,
            stop_reason,
            model_usage,
            ..
        } = self
        else {
            return None;
        };

        let mut input = 0u64;
        let mut output = 0u64;
        let mut cache_read = 0u64;
        let mut cache_creation = 0u64;
        if let Some(models) = model_usage.as_ref().and_then(|m| m.as_object()) {
            for (_name, m) in models {
                input += u64_field(m, "inputTokens");
                output += u64_field(m, "outputTokens");
                cache_read += u64_field(m, "cacheReadInputTokens");
                cache_creation += u64_field(m, "cacheCreationInputTokens");
            }
        }

        Some(UsageInfo {
            kind: "final",
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            cost_usd: *total_cost_usd,
            duration_ms: *duration_ms,
            num_turns: *num_turns,
            model: model.clone(),
            stop_reason: stop_reason.clone(),
        })
    }
}

fn u64_field(obj: &serde_json::Value, key: &str) -> u64 {
    obj.get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i.max(0) as u64)))
        .unwrap_or(0)
}

/// Coerce a `tool_result` content field into display text.
/// It may be a plain string or an array of content blocks (e.g. `[{type:"text", text:"..."}]`).
fn extract_result_text(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => {
            let mut buf = String::new();
            for block in arr {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(text);
                }
            }
            if buf.is_empty() {
                None
            } else {
                Some(buf)
            }
        }
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

fn parse_stream_line(line: &str) -> Option<ClaudeStreamEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    if let Ok(evt) = serde_json::from_str::<ClaudeStreamEvent>(line) {
        return Some(evt);
    }
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
        if let Some(result) = val.get("result").and_then(|r| r.as_str()) {
            return Some(ClaudeStreamEvent::Result {
                result: result.to_string(),
                total_cost_usd: val.get("total_cost_usd").and_then(|v| v.as_f64()),
                duration_ms: val.get("duration_ms").and_then(|v| v.as_u64()),
                num_turns: val.get("num_turns").and_then(|v| v.as_u64()),
                model: val.get("model").and_then(|v| v.as_str()).map(String::from),
                stop_reason: val.get("stop_reason").and_then(|v| v.as_str()).map(String::from),
                model_usage: val.get("modelUsage").cloned(),
            });
        }
        if val.get("type").is_some() {
            if let Ok(evt) = serde_json::from_value::<ClaudeStreamEvent>(val) {
                return Some(evt);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Claude process manager
// ---------------------------------------------------------------------------

pub struct ClaudeProcess {
    child: Option<Child>,
}

impl ClaudeProcess {
    pub fn new() -> Self {
        Self { child: None }
    }

    /// Spawn a new claude process for a single-turn message.
    pub async fn spawn_single(
        &mut self,
        conversation_id: &str,
        message: &str,
        cwd: Option<&str>,
    ) -> Result<()> {
        self.kill().await;

        let binary = find_claude_binary()?;
        let env = collect_env_for_claude().await;

        let mut cmd = Command::new(&binary);
        cmd.args([
                "--session-id",
                conversation_id,
                // AskUserQuestion blocks on a human answer this headless runner can't supply
                // (we only read stdout; --print mode has no channel to feed a tool_result back
                // in). Without this, the model hangs forever on "Streaming…". Disabling it makes
                // Claude ask the question as plain prose instead, which the user answers normally.
                "--disallowedTools",
                "AskUserQuestion",
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",
            ])
            .arg(message)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        for (k, v) in &env {
            cmd.env(k, v);
        }

        let child = cmd.spawn().context("failed to spawn claude process")?;
        self.child = Some(child);
        Ok(())
    }

    /// Spawn a continuation of an existing conversation.
    pub async fn spawn_continue(
        &mut self,
        conversation_id: &str,
        message: &str,
        cwd: Option<&str>,
    ) -> Result<()> {
        self.kill().await;

        let binary = find_claude_binary()?;
        let env = collect_env_for_claude().await;

        let mut cmd = Command::new(&binary);
        cmd.args([
                "--resume",
                conversation_id,
                "--disallowedTools",
                "AskUserQuestion",
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",
            ])
            .arg(message)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        for (k, v) in &env {
            cmd.env(k, v);
        }

        let child = cmd.spawn().context("failed to spawn claude process for continuation")?;
        self.child = Some(child);
        Ok(())
    }

    pub async fn read_stream<F>(&mut self, mut on_event: F) -> Result<String>
    where
        F: FnMut(&ClaudeStreamEvent),
    {
        let child = self.child.take().context("no running claude process")?;
        let stdout = child.stdout.context("stdout not captured")?;

        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut final_text = String::new();

        while let Some(line) = lines.next_line().await? {
            if let Some(evt) = parse_stream_line(&line) {
                // Only accumulate text from the final result event
                if let Some(text) = evt.final_text() {
                    final_text = text;
                }
                on_event(&evt);
            }
        }

        Ok(final_text)
    }

    pub async fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.child = None;
    }

    /// OS pid of the running child, if any. Used to kill the process from a
    /// separate task without acquiring the streaming lock.
    pub fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(|c| c.id())
    }
}

pub type SharedClaudeProcess = Arc<Mutex<ClaudeProcess>>;
