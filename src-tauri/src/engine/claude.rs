use super::{shared, EngineStatus, NormalizedEvent, ToolEvent, ToolEventKind, UsageInfo};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Child;

const CLAUDE_BINARY_NAMES: &[&str] = &["claude"];

const ENV_PREFIXES: &[&str] = &[
    "ANTHROPIC_",
    "CLAUDE",
    "AWS_",
    "GOOGLE_",
    "VERTEX_",
    "OPENAI_",
    "AZURE_",
];

pub async fn collect_env() -> HashMap<String, String> {
    shared::collect_env("claude", ENV_PREFIXES, shared::ENV_EXACT).await
}

pub fn find_claude_binary() -> Result<PathBuf> {
    shared::find_binary(CLAUDE_BINARY_NAMES, "claude CLI")
}

pub async fn get_claude_version() -> Result<String> {
    let binary = find_claude_binary()?;
    let env = collect_env().await;
    let output = shared::run_with_env(&binary, &["--version"], &env).await?;
    if !output.status.success() {
        anyhow::bail!("claude --version returned non-zero exit status");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// List known Claude models from environment variable configuration.
/// Claude CLI doesn't have `--list-models`, so we read ANTHROPIC_MODEL and
/// related env vars, plus provide well-known aliases.
pub async fn list_models() -> Vec<(String, String)> {
    log::info!("[list_models] claude: starting");
    let mut models = vec![
        ("sonnet".to_string(), "Sonnet (latest)".to_string()),
        ("opus".to_string(), "Opus (latest)".to_string()),
        ("haiku".to_string(), "Haiku (latest)".to_string()),
        (
            "claude-sonnet-4-20250514".to_string(),
            "Sonnet 4".to_string(),
        ),
        ("claude-opus-4-20250514".to_string(), "Opus 4".to_string()),
        (
            "claude-haiku-3-5-20241022".to_string(),
            "Haiku 3.5".to_string(),
        ),
    ];
    // Also include any models set in env vars that aren't already in the list.
    let env = collect_env().await;
    let env_model_keys = [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    let mut existing_ids: std::collections::HashSet<String> =
        models.iter().map(|(id, _)| id.clone()).collect();
    for key in &env_model_keys {
        if let Some(val) = env.get(*key) {
            let cleaned = shared::strip_ansi_and_controls(val).trim().to_string();
            if !cleaned.is_empty() && existing_ids.insert(cleaned.clone()) {
                models.push((cleaned.clone(), cleaned));
            }
        }
    }
    log::info!("[list_models] claude: returning {} models", models.len());
    models
}

pub async fn check_available() -> EngineStatus {
    match find_claude_binary() {
        Ok(path) => {
            let path_str = path.display().to_string();
            match get_claude_version().await {
                Ok(version) => EngineStatus::basic(
                    "claude",
                    "Claude Code",
                    true,
                    Some(version),
                    Some(path_str),
                    None,
                ),
                Err(e) => EngineStatus::basic(
                    "claude",
                    "Claude Code",
                    true,
                    None,
                    Some(path_str),
                    Some(e.to_string()),
                ),
            }
        }
        Err(e) => EngineStatus::basic(
            "claude",
            "Claude Code",
            false,
            None,
            None,
            Some(e.to_string()),
        ),
    }
}

/// Spawn a one-shot Claude process for the readiness probe. Minimal flags plus a
/// tiny prompt; stderr is captured by `shared::spawn_probe_child` so an auth
/// failure surfaces for classification. No `--session-id` — this turn is
/// throwaway and must not pollute the persistent-session map.
///
/// `--verbose` is REQUIRED: current Claude Code rejects `--print` +
/// `--output-format stream-json` without it ("requires --verbose"). The
/// persistent-session spawn uses the same combination (see `persistent.rs`).
pub async fn spawn_probe() -> Result<Child> {
    let binary = find_claude_binary()?;
    let env = collect_env().await;
    let args: Vec<String> = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        "bypassPermissions".into(),
    ];
    shared::spawn_probe_child(binary, &args, "ping", None, &env).await
}

/// Spawn the one-click login flow (`claude auth login`), which opens a browser
/// for OAuth. Fire-and-forget; the user re-probes after completing login.
pub async fn spawn_login() -> Result<()> {
    let binary = find_claude_binary()?;
    let env = collect_env().await;
    let args: Vec<String> = vec!["auth".into(), "login".into()];
    shared::spawn_detached(binary, &args, &env).await
}

pub async fn run_claude_command(args: Vec<String>) -> Result<String> {
    let binary = find_claude_binary()?;
    let env = collect_env().await;

    let mut cmd = shared::engine_command(&binary);
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

async fn spawn_with_args(
    args: Vec<String>,
    message: &str,
    cwd: Option<&str>,
    model_override: Option<&str>,
) -> Result<Child> {
    let binary = find_claude_binary()?;
    let mut env = collect_env().await;

    // Per-conversation model override takes precedence over ANTHROPIC_MODEL env var.
    if let Some(model) = model_override.filter(|s| !s.is_empty()) {
        env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
    }

    let mut cmd = shared::engine_command(&binary);
    cmd.args(args)
        .arg(message)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    for (k, v) in &env {
        cmd.env(k, v);
    }

    // Detach from the controlling terminal so the agent can't be
    // job-control-stopped when Pixie is launched from a terminal. See
    // shared::detach_from_controlling_terminal.
    shared::detach_from_controlling_terminal(&mut cmd);

    cmd.spawn().context("failed to spawn claude process")
}

/// Spawn an interactive Claude process. Uses `--permission-mode bypassPermissions`
/// so tool calls execute without per-call approval (AskUserQuestion still works).
pub async fn spawn_single(
    conversation_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    spawn_with_args(
        vec![
            "--session-id".into(),
            conversation_id.into(),
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--permission-mode".into(),
            "bypassPermissions".into(),
        ],
        message,
        cwd,
        model,
    )
    .await
}

pub async fn spawn_continue(
    conversation_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    spawn_with_args(
        vec![
            "--resume".into(),
            conversation_id.into(),
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--permission-mode".into(),
            "bypassPermissions".into(),
        ],
        message,
        cwd,
        model,
    )
    .await
}

/// Spawn a headless (auto-approved) Claude process for scheduled tasks.
/// Uses `--dangerously-skip-permissions` because there is no user to approve.
pub async fn spawn_headless(
    conversation_id: &str,
    message: &str,
    cwd: Option<&str>,
) -> Result<Child> {
    spawn_with_args(
        vec![
            "--session-id".into(),
            conversation_id.into(),
            "--disallowedTools".into(),
            "AskUserQuestion".into(),
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--dangerously-skip-permissions".into(),
        ],
        message,
        cwd,
        None,
    )
    .await
}

// ---------------------------------------------------------------------------
// Claude stream-json parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
enum ClaudeStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart {},

    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: Option<usize>, delta: Delta },

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
        #[serde(default)]
        estimated_tokens: Option<u64>,
    },

    #[serde(rename = "assistant")]
    Assistant {
        #[serde(default)]
        message: Option<serde_json::Value>,
    },

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

    #[serde(rename = "permission_request")]
    PermissionRequest {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        tool_name: Option<String>,
        #[serde(default)]
        input: Option<serde_json::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Delta {
    #[serde(default, rename = "type")]
    delta_type: Option<String>,
    text: Option<String>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    content_type: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ErrorData {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

fn event_type_label(evt: &ClaudeStreamEvent) -> &'static str {
    match evt {
        ClaudeStreamEvent::ContentBlockDelta { .. } => "delta",
        ClaudeStreamEvent::ContentBlockStart { .. } => "block_start",
        ClaudeStreamEvent::Result { .. } => "result",
        ClaudeStreamEvent::MessageStart {} => "message_start",
        ClaudeStreamEvent::MessageStop {} => "message_stop",
        ClaudeStreamEvent::System { .. } => "system",
        ClaudeStreamEvent::Error { .. } => "error",
        ClaudeStreamEvent::Assistant { .. } => "assistant",
        ClaudeStreamEvent::User { .. } => "user",
        ClaudeStreamEvent::ToolUse { .. } => "tool_use",
        ClaudeStreamEvent::ToolResult { .. } => "tool_result",
        ClaudeStreamEvent::PermissionRequest { .. } => "permission_request",
    }
}

impl ClaudeStreamEvent {
    fn streaming_text(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::ContentBlockDelta { delta, .. } => delta.text.clone(),
            ClaudeStreamEvent::ContentBlockStart { content_block, .. } => {
                content_block.text.clone()
            }
            ClaudeStreamEvent::Assistant { message } => message.as_ref().and_then(|msg| {
                msg.get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| {
                        arr.iter().find_map(|block| {
                            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                                block
                                    .get("text")
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

    fn streaming_thinking(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::Assistant { message } => message.as_ref().and_then(|msg| {
                msg.get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|arr| {
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

    fn tool_events(&self) -> Vec<ToolEvent> {
        let mut out = Vec::new();

        let starts_from_content = |content: Option<&serde_json::Value>,
                                   out: &mut Vec<ToolEvent>| {
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

        let results_from_content = |content: Option<&serde_json::Value>,
                                    out: &mut Vec<ToolEvent>| {
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
                    let content = shared::extract_result_text(block.get("content"));
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
            ClaudeStreamEvent::ToolResult {
                tool_use_id,
                content,
            } => {
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

    fn thinking_tokens(&self) -> Option<u64> {
        match self {
            ClaudeStreamEvent::System {
                subtype,
                estimated_tokens,
                ..
            } => {
                if subtype.as_deref() == Some("thinking_tokens") {
                    *estimated_tokens
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn usage(&self) -> Option<UsageInfo> {
        match self {
            ClaudeStreamEvent::Assistant { message } => {
                let usage = message.as_ref().and_then(|m| m.get("usage"))?;
                let input = shared::u64_field(usage, "input_tokens");
                let output = shared::u64_field(usage, "output_tokens");
                let cache_read = shared::u64_field(usage, "cache_read_input_tokens");
                let cache_creation = shared::u64_field(usage, "cache_creation_input_tokens");
                if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                    return None;
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
                input += shared::u64_field(m, "inputTokens");
                output += shared::u64_field(m, "outputTokens");
                cache_read += shared::u64_field(m, "cacheReadInputTokens");
                cache_creation += shared::u64_field(m, "cacheCreationInputTokens");
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

    fn final_text(&self) -> Option<String> {
        match self {
            ClaudeStreamEvent::Result { result, .. } => Some(result.clone()),
            ClaudeStreamEvent::Error { error } => error
                .message
                .clone()
                .or_else(|| Some("Unknown error".to_string())),
            _ => None,
        }
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
                stop_reason: val
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .map(String::from),
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

pub fn parse_line(line: &str) -> Vec<NormalizedEvent> {
    let Some(evt) = parse_stream_line(line) else {
        return vec![];
    };

    let mut out = Vec::new();
    let label = event_type_label(&evt);

    if let Some(text) = evt.streaming_text() {
        out.push(NormalizedEvent::TextDelta {
            text,
            event_type: label,
        });
    }

    if let Some(thinking) = evt.streaming_thinking() {
        out.push(NormalizedEvent::ThinkingText { content: thinking });
    }

    for te in evt.tool_events() {
        out.push(NormalizedEvent::Tool(te));
    }

    if let Some(tokens) = evt.thinking_tokens() {
        out.push(NormalizedEvent::ThinkingTokens { tokens });
    }

    if let Some(u) = evt.usage() {
        out.push(NormalizedEvent::Usage(u));
    }

    if let Some(text) = evt.final_text() {
        if matches!(evt, ClaudeStreamEvent::Result { .. }) {
            out.push(NormalizedEvent::Final { text });
        } else if matches!(evt, ClaudeStreamEvent::Error { .. }) {
            out.push(NormalizedEvent::Error { message: text });
        }
    }

    // Permission request: the agent wants to run a tool and needs user approval.
    if let ClaudeStreamEvent::PermissionRequest {
        id,
        tool_name,
        input,
    } = &evt
    {
        out.push(NormalizedEvent::PermissionRequest {
            id: id.clone().unwrap_or_default(),
            tool_name: tool_name.clone().unwrap_or_default(),
            input: input.clone().unwrap_or(serde_json::Value::Null),
        });
    }

    out
}
