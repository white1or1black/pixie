use super::{shared, EngineStatus, NormalizedEvent, ToolEvent, ToolEventKind, UsageInfo};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};

const CURSOR_BINARY_NAMES: &[&str] = &["cursor-agent", "agent"];

const ENV_PREFIXES: &[&str] = &["CURSOR_"];

async fn collect_env() -> HashMap<String, String> {
    shared::collect_env("cursor", ENV_PREFIXES, shared::ENV_EXACT).await
}

pub fn find_cursor_binary() -> Result<PathBuf> {
    shared::find_binary(CURSOR_BINARY_NAMES, "cursor-agent CLI")
}

pub async fn get_cursor_version() -> Result<String> {
    let binary = find_cursor_binary()?;
    let env = collect_env().await;
    let output = shared::run_with_env(&binary, &["--version"], &env).await?;
    if !output.status.success() {
        anyhow::bail!("cursor-agent --version returned non-zero exit status");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub async fn check_available() -> EngineStatus {
    match find_cursor_binary() {
        Ok(path) => {
            let path_str = path.display().to_string();
            match get_cursor_version().await {
                Ok(version) => EngineStatus {
                    id: "cursor".into(),
                    display_name: "Cursor Agent".into(),
                    available: true,
                    version: Some(version),
                    path: Some(path_str),
                    error: None,
                },
                Err(e) => EngineStatus {
                    id: "cursor".into(),
                    display_name: "Cursor Agent".into(),
                    available: true,
                    version: None,
                    path: Some(path_str),
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => EngineStatus {
            id: "cursor".into(),
            display_name: "Cursor Agent".into(),
            available: false,
            version: None,
            path: None,
            error: Some(e.to_string()),
        },
    }
}

/// Fetch available models from `cursor-agent --list-models`.
pub async fn list_models() -> Vec<(String, String)> {
    log::info!("[list_models] cursor: starting");
    let binary = match find_cursor_binary() {
        Ok(b) => b,
        Err(e) => {
            log::info!("[list_models] cursor: binary not found: {e}");
            return vec![];
        }
    };
    let env = collect_env().await;
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(["--list-models"]);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    shared::detach_from_controlling_terminal(&mut cmd);
    log::info!("[list_models] cursor: spawning --list-models");
    match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(output)) => {
            // Combine stdout and stderr in case the model list is on stderr.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}");
            let models = parse_model_list(&combined);
            log::info!("[list_models] cursor: got {} models", models.len());
            models
        }
        Ok(Err(e)) => {
            log::warn!("[list_models] cursor: spawn error: {e}");
            vec![]
        }
        Err(_) => {
            log::warn!("[list_models] cursor: timed out after 10s");
            vec![]
        }
    }
}

/// Parse output of `cursor-agent --list-models` into (id, label) pairs.
/// Format: "model-id - Human Label" per line.
fn parse_model_list(output: &str) -> Vec<(String, String)> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    for line in output.lines() {
        let line = shared::strip_ansi_and_controls(line);
        let line = line.trim();
        if line.is_empty() || line == "Available models" {
            continue;
        }
        if let Some((id, label)) = line.split_once(" - ") {
            let id = id.trim().to_string();
            let label = label.trim().to_string();
            if !id.is_empty() && seen.insert(id.clone()) {
                models.push((id, label));
            }
        } else {
            // No separator — use the whole line as both id and label.
            let id = line.to_string();
            if !id.is_empty() && seen.insert(id.clone()) {
                models.push((id.clone(), id));
            }
        }
    }
    models
}

async fn spawn_with_args(args: Vec<String>, message: &str, cwd: Option<&str>) -> Result<Child> {
    let binary = find_cursor_binary()?;
    let env = collect_env().await;

    let mut cmd = Command::new(&binary);
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

    cmd.spawn().context("failed to spawn cursor-agent process")
}

const STREAM_ARGS: &[&str] = &[
    "-p",
    "--force",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
];

fn stream_args_with_model(model: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = STREAM_ARGS.iter().map(|s| (*s).into()).collect();
    if let Some(m) = model.filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(m.to_string());
    }
    args
}

async fn stream_args_from_env(model_override: Option<&str>) -> Vec<String> {
    let env = collect_env().await;
    let model = model_override
        .filter(|s| !s.is_empty())
        .or_else(|| env.get("CURSOR_MODEL").map(String::as_str));
    stream_args_with_model(model)
}

pub async fn spawn_single(
    _conversation_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    spawn_with_args(stream_args_from_env(model).await, message, cwd).await
}

pub async fn spawn_continue(
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    let mut args = stream_args_from_env(model).await;
    args.push("--resume".into());
    args.push(session_id.into());
    spawn_with_args(args, message, cwd).await
}

// ---------------------------------------------------------------------------
// Cursor stream-json parsing
// ---------------------------------------------------------------------------

fn text_from_message(val: &serde_json::Value) -> Option<String> {
    val.get("message")?
        .get("content")?
        .as_array()?
        .iter()
        .find_map(|block| {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                block.get("text").and_then(|t| t.as_str()).map(String::from)
            } else {
                None
            }
        })
}

fn tool_name_from_call(tool_call: &serde_json::Value) -> (String, Option<String>) {
    if let Some(read) = tool_call.get("readToolCall") {
        let path = read
            .get("args")
            .and_then(|a| a.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("file");
        return ("Read".into(), Some(format!(r#"{{"path":"{path}"}}"#)));
    }
    if let Some(write) = tool_call.get("writeToolCall") {
        let path = write
            .get("args")
            .and_then(|a| a.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("file");
        return ("Write".into(), Some(format!(r#"{{"path":"{path}"}}"#)));
    }
    if let Some(shell) = tool_call.get("shellToolCall") {
        let cmd = shell
            .get("args")
            .and_then(|a| a.get("command"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        return ("Shell".into(), Some(format!(r#"{{"command":"{cmd}"}}"#)));
    }
    if let Some(func) = tool_call.get("function") {
        let name = func
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("tool")
            .to_string();
        let args = func.get("arguments").map(|v| v.to_string());
        return (name, args);
    }
    ("tool".into(), None)
}

fn tool_result_from_call(tool_call: &serde_json::Value) -> Option<String> {
    if let Some(read) = tool_call.get("readToolCall") {
        if let Some(success) = read.get("result").and_then(|r| r.get("success")) {
            return success
                .get("content")
                .and_then(|c| c.as_str())
                .map(String::from);
        }
    }
    if let Some(write) = tool_call.get("writeToolCall") {
        if let Some(success) = write.get("result").and_then(|r| r.get("success")) {
            return Some(success.to_string());
        }
    }
    if let Some(shell) = tool_call.get("shellToolCall") {
        if let Some(result) = shell.get("result") {
            return Some(result.to_string());
        }
    }
    tool_call
        .get("function")
        .and_then(|f| f.get("result"))
        .map(|v| v.to_string())
}

pub fn parse_line(line: &str) -> Vec<NormalizedEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };

    let event_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let mut out = Vec::new();

    match event_type {
        "system" if val.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
            if let Some(session_id) = val.get("session_id").and_then(|s| s.as_str()) {
                out.push(NormalizedEvent::SessionEstablished {
                    session_id: session_id.to_string(),
                });
            }
        }
        "assistant" => {
            // With --stream-partial-output: only deltas where timestamp_ms is present
            // and model_call_id is absent are new text.
            let has_ts = val.get("timestamp_ms").is_some();
            let has_model_call = val.get("model_call_id").is_some();
            if has_ts && !has_model_call {
                if let Some(text) = text_from_message(&val) {
                    if !text.is_empty() {
                        out.push(NormalizedEvent::TextDelta {
                            text,
                            event_type: "delta",
                        });
                    }
                }
            } else if !has_ts && !has_model_call {
                // Non-partial mode: full assistant segments between tool calls.
                if let Some(text) = text_from_message(&val) {
                    if !text.is_empty() {
                        out.push(NormalizedEvent::TextDelta {
                            text,
                            event_type: "assistant",
                        });
                    }
                }
            }
        }
        "tool_call" => {
            let subtype = val.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let call_id = val
                .get("call_id")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            let tool_call = val.get("tool_call").cloned().unwrap_or_default();

            match subtype {
                "started" => {
                    let (name, input) = tool_name_from_call(&tool_call);
                    out.push(NormalizedEvent::Tool(ToolEvent {
                        id: call_id,
                        kind: ToolEventKind::Start {
                            name: Some(name),
                            input,
                        },
                    }));
                }
                "completed" => {
                    let content = tool_result_from_call(&tool_call);
                    out.push(NormalizedEvent::Tool(ToolEvent {
                        id: call_id,
                        kind: ToolEventKind::Result {
                            content,
                            is_error: false,
                        },
                    }));
                }
                _ => {}
            }
        }
        "result" => {
            if let Some(text) = val.get("result").and_then(|r| r.as_str()) {
                out.push(NormalizedEvent::Final {
                    text: text.to_string(),
                });
            }
            let duration_ms = val.get("duration_ms").and_then(|v| v.as_u64());
            let model = val.get("model").and_then(|v| v.as_str()).map(String::from);
            out.push(NormalizedEvent::Usage(UsageInfo {
                kind: "final",
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cost_usd: None,
                duration_ms,
                num_turns: None,
                model,
                stop_reason: None,
            }));
        }
        "error" => {
            let message = val
                .get("message")
                .and_then(|m| m.as_str())
                .or_else(|| val.get("error").and_then(|e| e.as_str()))
                .unwrap_or("Unknown error")
                .to_string();
            out.push(NormalizedEvent::Error { message });
        }
        _ => {}
    }

    out
}
