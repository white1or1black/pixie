use super::{shared, EngineStatus, NormalizedEvent, UsageInfo};
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Child;

/// Binary names installed by `@tencent-ai/codebuddy-code`.
const CODEBUDDY_BINARY_NAMES: &[&str] = &["codebuddy", "cbc"];

/// Env-var prefixes forwarded to the CodeBuddy process (auth/config + model).
const ENV_PREFIXES: &[&str] = &["CODEBUDDY_", "CBC_"];

pub async fn collect_env() -> HashMap<String, String> {
    shared::collect_env("codebuddy", ENV_PREFIXES, shared::ENV_EXACT).await
}

pub fn find_codebuddy_binary() -> Result<PathBuf> {
    shared::find_binary(CODEBUDDY_BINARY_NAMES, "codebuddy CLI")
}

pub async fn get_codebuddy_version() -> Result<String> {
    let binary = find_codebuddy_binary()?;
    let env = collect_env().await;
    let output = shared::run_with_env(&binary, &["--version"], &env).await?;
    if !output.status.success() {
        anyhow::bail!("codebuddy --version returned non-zero exit status");
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Fetch available models from `codebuddy --help`.
/// The `--model` option description lists supported models in parentheses.
/// Note: `codebuddy --help` writes the model list to **stderr**, not stdout,
/// so we capture both streams.
pub async fn list_models() -> Vec<(String, String)> {
    log::info!("[list_models] codebuddy: starting");
    let binary = match find_codebuddy_binary() {
        Ok(b) => b,
        Err(e) => {
            log::info!("[list_models] codebuddy: binary not found: {e}");
            return vec![];
        }
    };
    let env = collect_env().await;
    let mut cmd = shared::engine_command(&binary);
    cmd.arg("--help");
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    shared::detach_from_controlling_terminal(&mut cmd);
    log::info!("[list_models] codebuddy: spawning --help");
    match tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output()).await {
        Ok(Ok(output)) => {
            // codebuddy --help writes to both stdout and stderr; combine them.
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}");
            let models = parse_model_list_from_help(&combined);
            log::info!("[list_models] codebuddy: got {} models", models.len());
            models
        }
        Ok(Err(e)) => {
            log::warn!("[list_models] codebuddy: spawn error: {e}");
            vec![]
        }
        Err(_) => {
            log::warn!("[list_models] codebuddy: timed out after 10s");
            vec![]
        }
    }
}

/// Parse model IDs from the `--model` help line.
/// Format: `--model <model>  ... Currently supported: (id1, id2, id3)`
fn parse_model_list_from_help(help: &str) -> Vec<(String, String)> {
    for line in help.lines() {
        let line = shared::strip_ansi_and_controls(line);
        if line.contains("--model")
            && (line.contains("Currently supported") || line.contains("supported:"))
        {
            if let Some(start) = line.rfind('(') {
                if let Some(end) = line[start..].find(')') {
                    let inner = &line[start + 1..start + end];
                    let mut seen = std::collections::HashSet::<String>::new();
                    return inner
                        .split(',')
                        .filter_map(|s| {
                            let id = shared::strip_ansi_and_controls(s).trim().to_string();
                            if id.is_empty() || !seen.insert(id.clone()) {
                                None
                            } else {
                                Some((id.clone(), id))
                            }
                        })
                        .collect();
                }
            }
        }
    }
    vec![]
}

pub async fn check_available() -> EngineStatus {
    match find_codebuddy_binary() {
        Ok(path) => {
            let path_str = path.display().to_string();
            match get_codebuddy_version().await {
                Ok(version) => EngineStatus::basic(
                    "codebuddy",
                    "CodeBuddy",
                    true,
                    Some(version),
                    Some(path_str),
                    None,
                ),
                Err(e) => EngineStatus::basic(
                    "codebuddy",
                    "CodeBuddy",
                    true,
                    None,
                    Some(path_str),
                    Some(e.to_string()),
                ),
            }
        }
        Err(e) => EngineStatus::basic(
            "codebuddy",
            "CodeBuddy",
            false,
            None,
            None,
            Some(e.to_string()),
        ),
    }
}

/// Spawn a one-shot CodeBuddy process for the readiness probe. Reuses the base
/// stream flags (no session id needed for a throwaway turn); stderr is captured
/// by `spawn_probe_child` so an auth failure surfaces for classification.
pub async fn spawn_probe() -> Result<Child> {
    let binary = find_codebuddy_binary()?;
    let env = collect_env().await;
    let args = base_stream_args();
    shared::spawn_probe_child(binary, &args, "ping", None, &env).await
}

/// Spawn the one-click login flow (`cbc login`), which opens a browser.
/// Fire-and-forget; the user re-probes after completing login.
pub async fn spawn_login() -> Result<()> {
    let binary = find_codebuddy_binary()?;
    let env = collect_env().await;
    let args: Vec<String> = vec!["login".into()];
    shared::spawn_detached(binary, &args, &env).await
}

// ---------------------------------------------------------------------------
// Process spawning (non-interactive / headless stream-json mode)
// ---------------------------------------------------------------------------

/// Flags common to every CodeBuddy run.
///
/// `--include-partial-messages` is what makes CodeBuddy stream token-by-token
/// (the `stream_event` deltas). `--verbose` is deliberately **omitted**: with it
/// CodeBuddy emits tool-result / result text containing *raw, unescaped
/// newlines*, which shatters one JSON object across many physical lines and
/// breaks line-delimited parsing (tool results vanish, and a long final result
/// can fail to parse so the run looks stuck). Without `--verbose` the output is
/// clean NDJSON and streaming still works.
fn base_stream_args() -> Vec<String> {
    vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--permission-mode".into(),
        "bypassPermissions".into(),
    ]
}

/// Build the full argument list for one turn.
///
/// CodeBuddy accepts `--session-id` (undocumented but honored) to pin a
/// session id to our conversation id; `--resume <id>` continues that session
/// on later turns. This mirrors how the Claude engine is driven, so the shared
/// session-id plumbing in `mod.rs` needs no special-casing for CodeBuddy.
fn stream_args(
    session_id: &str,
    resume: bool,
    env: &HashMap<String, String>,
    model_override: Option<&str>,
) -> Vec<String> {
    let mut args = base_stream_args();
    args.push(if resume { "--resume" } else { "--session-id" }.into());
    args.push(session_id.to_string());
    // Per-conversation model override takes precedence over CODEBUDDY_MODEL env var.
    let model = model_override.filter(|s| !s.is_empty()).or_else(|| {
        env.get("CODEBUDDY_MODEL")
            .filter(|s| !s.is_empty())
            .map(String::as_str)
    });
    if let Some(model) = model {
        args.push("--model".into());
        args.push(model.to_string());
    }
    args
}

async fn spawn(
    args: Vec<String>,
    message: &str,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<Child> {
    let binary = find_codebuddy_binary()?;

    let mut cmd = shared::engine_command(&binary);
    cmd.args(args)
        .arg(message)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    for (k, v) in env {
        cmd.env(k, v);
    }

    // Detach from the controlling terminal: CodeBuddy opens /dev/tty and would
    // otherwise be job-control-stopped (SIGTTOU/SIGTTIN) when spawned in the
    // background by a terminal-launched app, hanging the turn forever.
    shared::detach_from_controlling_terminal(&mut cmd);

    cmd.spawn().context("failed to spawn codebuddy process")
}

pub async fn spawn_single(
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    let env = collect_env().await;
    spawn(
        stream_args(session_id, false, &env, model),
        message,
        cwd,
        &env,
    )
    .await
}

pub async fn spawn_continue(
    session_id: &str,
    message: &str,
    cwd: Option<&str>,
    model: Option<&str>,
) -> Result<Child> {
    let env = collect_env().await;
    spawn(
        stream_args(session_id, true, &env, model),
        message,
        cwd,
        &env,
    )
    .await
}

// ---------------------------------------------------------------------------
// stream-json parsing
//
// CodeBuddy's stream-json is Anthropic's streaming format with one twist:
// every streaming event (message_start, content_block_delta, …) is wrapped in
//   {"type":"stream_event","event":{ …anthropic event… }}
// The top-level `assistant` / `user` / `result` / `system` messages are emitted
// as-is and are already Claude-compatible. So we unwrap the envelope and
// delegate the inner event to the Claude parser, which knows Anthropic's event
// shapes (text deltas, tool blocks, thinking, usage, …).
// ---------------------------------------------------------------------------

/// CodeBuddy emits `{"type":"error","error":"…"}` (string) or Claude's
/// `{"type":"error","error":{"message":"…"}}` (object). The shared Claude
/// deserializer only accepts the object form, so we normalize both here.
fn parse_top_level_error(val: &serde_json::Value) -> Vec<NormalizedEvent> {
    let message = val
        .get("error")
        .and_then(|e| {
            e.as_str()
                .map(String::from)
                .or_else(|| e.get("message").and_then(|m| m.as_str()).map(String::from))
        })
        .or_else(|| {
            val.get("message")
                .and_then(|m| m.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "CodeBuddy reported an unknown error".to_string());
    vec![NormalizedEvent::Error { message }]
}

/// A `result` with `is_error: true` carries an `errors` array; surface it as an
/// error so the UI shows it as a failure rather than as ordinary result text.
fn parse_error_result(val: &serde_json::Value) -> Vec<NormalizedEvent> {
    if val.get("type").and_then(|t| t.as_str()) != Some("result") {
        return vec![];
    }
    if !val
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return vec![];
    }
    let message = val
        .get("errors")
        .and_then(|e| e.as_array())
        .and_then(|arr| arr.first())
        .and_then(|e| e.as_str())
        .or_else(|| val.get("result").and_then(|r| r.as_str()))
        .unwrap_or("CodeBuddy reported an unknown error")
        .to_string();
    vec![NormalizedEvent::Error { message }]
}

/// Parse CodeBuddy's terminal `result` message into a Final event and the
/// authoritative (final) Usage.
///
/// Unlike Claude Code, CodeBuddy does not emit a `modelUsage` map; it puts the
/// token totals directly under a flat `usage` object (`usage.input_tokens`,
/// `usage.output_tokens`, …). The shared Claude parser reads `modelUsage`, so
/// delegating `result` to it would lose the token counts. We parse the
/// CodeBuddy shape ourselves and also fold in `total_cost_usd` / `duration_ms`
/// / `num_turns` / `model`.
fn parse_result(val: &serde_json::Value) -> Vec<NormalizedEvent> {
    let mut out = Vec::new();

    if let Some(text) = val.get("result").and_then(|r| r.as_str()) {
        out.push(NormalizedEvent::Final {
            text: text.to_string(),
        });
    }

    let usage = val.get("usage");
    let tokens = |key: &str| usage.map(|u| shared::u64_field(u, key)).unwrap_or(0);
    let input = tokens("input_tokens");
    let output = tokens("output_tokens");
    let cache_read = tokens("cache_read_input_tokens");
    let cache_creation = tokens("cache_creation_input_tokens");

    out.push(NormalizedEvent::Usage(UsageInfo {
        kind: "final",
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_creation,
        cost_usd: val.get("total_cost_usd").and_then(|v| v.as_f64()),
        duration_ms: val.get("duration_ms").and_then(|v| v.as_u64()),
        num_turns: val.get("num_turns").and_then(|v| v.as_u64()),
        model: val.get("model").and_then(|v| v.as_str()).map(String::from),
        stop_reason: None,
    }));

    out
}

pub fn parse_line(line: &str) -> Vec<NormalizedEvent> {
    if shared::is_ignorable_stream_line(line) {
        return vec![];
    }
    let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
        return vec![];
    };

    match val.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        // Unwrap the Anthropic event and let the Claude parser handle text
        // deltas, tool blocks, thinking deltas, etc.
        "stream_event" => match val.get("event") {
            Some(event) => super::claude::parse_line(&event.to_string()),
            None => vec![],
        },
        // Top-level error (e.g. resume with unknown session id).
        "error" => parse_top_level_error(&val),
        // CodeBuddy's terminal result: Final text + final Usage (parsed from the
        // CodeBuddy `usage` shape), or an Error when `is_error` is true.
        "result" => {
            if val
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                parse_error_result(&val)
            } else {
                parse_result(&val)
            }
        }
        // assistant / user / system / tool_* → Claude parser.
        _ => super::claude::parse_line(line),
    }
}

#[cfg(test)]
mod tests {
    //! These feed *real* lines captured from `codebuddy -p --output-format
    //! stream-json --include-partial-messages` through `parse_line` and assert
    //! the normalized events the UI relies on.

    use super::super::{NormalizedEvent, ToolEventKind};
    use super::parse_line;

    /// Helper: does `events` contain a streaming text delta with this text?
    fn has_text(events: &[NormalizedEvent], needle: &str) -> bool {
        events
            .iter()
            .any(|e| e.streaming_text().is_some_and(|t| t == needle))
    }

    /// `stream_event` wrapping a `content_block_delta` text_delta → a streaming
    /// TextDelta carrying exactly that token.
    #[test]
    fn parses_stream_event_text_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}},"session_id":"mt-1","parent_tool_use_id":null,"uuid":"x","__timestamp":"t","_requestId":"r"}"#;
        let events = parse_line(line);
        assert!(
            has_text(&events, "Done"),
            "expected a 'Done' text delta, got {events:?}"
        );
    }

    /// A top-level `assistant` message with a tool_use block → a tool Start
    /// (name + input) plus a per-turn Usage.
    #[test]
    fn parses_assistant_tool_use() {
        let line = r#"{"type":"assistant","uuid":"a","session_id":"mt-1","message":{"id":"a","content":[{"type":"tool_use","id":"call_1","name":"Bash","input":{"command":"mkdir -p /tmp/x"}}],"model":"ep","role":"assistant","stop_reason":"tool_use","stop_sequence":null,"type":"message","usage":{"input_tokens":10,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"parent_tool_use_id":null}"#;
        let events = parse_line(line);
        let tool = events.iter().find_map(|e| match e {
            NormalizedEvent::Tool(t) => Some(t),
            _ => None,
        });
        let tool = tool.expect("expected a Tool event");
        match &tool.kind {
            ToolEventKind::Start { name, input } => {
                assert_eq!(name.as_deref(), Some("Bash"));
                assert!(input
                    .as_deref()
                    .is_some_and(|i| i.contains("mkdir -p /tmp/x")));
            }
            other => panic!("expected Tool Start, got {other:?}"),
        }
        assert_eq!(tool.id, "call_1");
        assert!(events
            .iter()
            .any(|e| e.usage().is_some_and(|u| u.kind == "turn")));
    }

    /// A top-level `user` message with a tool_result block → a tool Result.
    #[test]
    fn parses_user_tool_result() {
        let line = r#"{"type":"user","uuid":"u","session_id":"mt-1","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"Exit Code: 0"}],"is_error":false}],"role":"user"},"parent_tool_use_id":"call_1"}"#;
        let events = parse_line(line);
        let tool = events.iter().find_map(|e| match e {
            NormalizedEvent::Tool(t) => Some(t),
            _ => None,
        });
        let tool = tool.expect("expected a Tool event");
        match &tool.kind {
            ToolEventKind::Result { content, is_error } => {
                assert!(!is_error);
                assert!(content
                    .as_deref()
                    .is_some_and(|c| c.contains("Exit Code: 0")));
            }
            other => panic!("expected Tool Result, got {other:?}"),
        }
        assert_eq!(tool.id, "call_1");
    }

    /// A successful `result` → a Final event with the result text + final Usage.
    /// Token counts live under CodeBuddy's flat `usage` object (not `modelUsage`),
    /// so this guards against regressing to 0 tokens.
    #[test]
    fn parses_success_result() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"Done. Created hello.txt.","uuid":"r","session_id":"mt-1","duration_ms":13081,"duration_api_ms":13078,"num_turns":6,"total_cost_usd":0,"model":null,"usage":{"input_tokens":66926,"output_tokens":72,"cache_creation_input_tokens":18478,"cache_read_input_tokens":48448}}"#;
        let events = parse_line(line);
        assert_eq!(
            events.iter().find_map(|e| e.final_text()).as_deref(),
            Some("Done. Created hello.txt.")
        );
        let usage = events.iter().find_map(|e| e.usage());
        let usage = usage.expect("expected final usage");
        assert_eq!(usage.kind, "final");
        assert_eq!(usage.input_tokens, 66926);
        assert_eq!(usage.output_tokens, 72);
        assert_eq!(usage.cache_read_tokens, 48448);
        assert_eq!(usage.cache_creation_tokens, 18478);
        assert_eq!(usage.duration_ms, Some(13081));
        assert_eq!(usage.num_turns, Some(6));
    }

    /// An error `result` → an Error event (not treated as success text).
    #[test]
    fn parses_error_result() {
        let line = r#"{"type":"result","subtype":"error","is_error":true,"result":"","errors":["boom"],"uuid":"r","session_id":"mt-1"}"#;
        let events = parse_line(line);
        assert!(events
            .iter()
            .any(|e| matches!(e, NormalizedEvent::Error { message } if message == "boom")));
    }

    /// CodeBuddy top-level `error` with a string payload (not Claude's object shape).
    #[test]
    fn parses_top_level_string_error() {
        let line = r#"{"type":"error","error":"No conversation found with session ID: abc"}"#;
        let events = parse_line(line);
        let msg = events.iter().find_map(|e| match e {
            NormalizedEvent::Error { message } => Some(message.as_str()),
            _ => None,
        });
        assert!(
            msg.is_some_and(|m| m.contains("No conversation found")),
            "expected Error event, got {events:?}"
        );
    }

    /// CodeBuddy `message_delta` stream events carry turn usage under `event.usage`.
    #[test]
    fn parses_stream_event_message_delta_usage() {
        let line = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":100,"output_tokens":2,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}},"session_id":"mt-1"}"#;
        let events = parse_line(line);
        // message_delta is not in ClaudeStreamEvent; usage is ignored for now (no crash).
        assert!(
            events.is_empty()
                || events
                    .iter()
                    .all(|e| e.usage().is_none() || e.usage().is_some_and(|u| u.input_tokens > 0))
        );
    }

    /// Noise lines CodeBuddy emits between events must be ignored.
    #[test]
    fn ignores_noise_lines() {
        assert!(parse_line(
            r#"{"type":"system","subtype":"status","status":null,"session_id":"mt-1"}"#
        )
        .is_empty());
        assert!(parse_line(
            r#"{"type":"file-history-snapshot","id":"f","timestamp":1,"isSnapshotUpdate":false}"#
        )
        .is_empty());
        assert!(parse_line("").is_empty());
    }
}
