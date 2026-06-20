//! Persistent (long-lived) agent sessions.
//!
//! Instead of spawning a new CLI process for every user message and reconnecting
//! via `--resume`, we keep the CLI process alive and pipe subsequent messages
//! through its stdin using `--input-format stream-json`. This eliminates the
//! overhead of re-loading session history on every turn.
//!
//! Only Claude and CodeBuddy support `--input-format stream-json`. Cursor Agent
//! falls back to the per-message `--resume` model.

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use super::shared::{self, detach_from_controlling_terminal};
use super::{parse_line, NormalizedEvent};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Idle sessions are shut down after this duration.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(1800); // 30 minutes

/// Maximum number of persistent sessions kept alive simultaneously.
pub const MAX_SESSIONS: usize = 10;

// ---------------------------------------------------------------------------
// PersistentSession
// ---------------------------------------------------------------------------

/// A long-lived CLI agent process whose stdin stays open for multi-turn input.
#[allow(dead_code)]
pub struct PersistentSession {
    pub session_id: String,
    pub engine_id: String,
    pub last_active: Instant,
    /// The model override used when spawning this session. Used to detect when
    /// the per-conversation model has changed and the session must be respawned.
    pub model_override: Option<String>,

    child: Child,
    stdin: ChildStdin,
    /// The stdout reader is stored behind a Mutex so that the streaming task
    /// (which reads lines) can run independently of `send_message` (which
    /// writes to stdin).
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
}

/// Lowercase extension of `path` ("" when none).
fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
}

/// MIME type for extensions Claude/CodeBuddy accept as **native** image content
/// blocks. Returns `None` for everything else (incl. svg/bmp/ico) so those fall
/// back to a `@mention` text block instead of an invalid image block.
fn media_type_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// JSONL message format for `--input-format stream-json`.
///
/// Builds the `content` array from the text and any image attachments. Images
/// whose extension maps to a native block are read from disk and embedded as
/// `{"type":"image",...}` base64 blocks — the most reliable vision path, since
/// it bypasses the engine's `@`-mention→read resolution. Images we can't send
/// natively (unsupported type, or unreadable) degrade to a `@<path>` text block
/// so the engine still gets them via the existing mention behavior. A text block
/// is omitted when the body is empty (image-only turns are valid); the array is
/// never left empty.
fn format_user_message(text: &str, images: &[String]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::{json, Value};

    let mut content: Vec<Value> = Vec::new();
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    for path in images {
        match media_type_for_ext(&ext_of(path)) {
            Some(media_type) => match std::fs::read(path) {
                Ok(bytes) => {
                    let data = STANDARD.encode(&bytes);
                    content.push(json!({
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": data}
                    }));
                }
                Err(e) => {
                    log::warn!(
                        "[persistent] failed to read image {path}: {e}; sending as @mention"
                    );
                    content.push(json!({"type": "text", "text": format!("@{path}")}));
                }
            },
            None => {
                // Unsupported native-image type — keep the current @mention behavior.
                content.push(json!({"type": "text", "text": format!("@{path}")}));
            }
        }
    }
    if content.is_empty() {
        content.push(json!({"type": "text", "text": ""}));
    }
    json!({"type": "user", "message": {"role": "user", "content": content}}).to_string()
}

/// Format a permission response for `--input-format stream-json`.
/// When the agent emits a `permission_request`, the integrator must respond
/// with either `allow` or `deny`.
fn format_permission_response(allow: bool, message: Option<&str>) -> String {
    let behavior = if allow { "allow" } else { "deny" };
    match message {
        Some(msg) => {
            let escaped = msg
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n");
            format!(
                r#"{{"type":"permission_response","behavior":"{behavior}","message":"{escaped}"}}"#
            )
        }
        None => format!(r#"{{"type":"permission_response","behavior":"{behavior}"}}"#),
    }
}

impl PersistentSession {
    /// Spawn a persistent CLI process with `--input-format stream-json`.
    ///
    /// If `resume` is true, the session is reconnected via `--resume`.
    /// If `resume` is false, a new session is created via `--session-id`.
    pub async fn spawn(
        engine_id: &str,
        session_id: &str,
        resume: bool,
        cwd: Option<&str>,
        model_override: Option<&str>,
    ) -> Result<Self> {
        let (binary, args, env) =
            build_persistent_command(engine_id, session_id, resume, model_override).await?;

        let mut cmd = shared::engine_command(&binary);
        cmd.args(&args)
            .stdin(std::process::Stdio::piped()) // stdin stays open
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        for (k, v) in &env {
            cmd.env(k, v);
        }

        detach_from_controlling_terminal(&mut cmd);

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn persistent {engine_id} process"))?;

        let stdin = child.stdin.take().context("stdin not captured")?;
        let stdout = child.stdout.take().context("stdout not captured")?;
        let stdout = Arc::new(Mutex::new(BufReader::new(stdout)));

        Ok(Self {
            session_id: session_id.to_string(),
            engine_id: engine_id.to_string(),
            last_active: Instant::now(),
            model_override: model_override.map(|s| s.to_string()),
            child,
            stdin,
            stdout,
        })
    }

    /// Write a user message (plus any image attachments) to the process stdin.
    /// `images` are absolute paths embedded as native image content blocks when
    /// supported (see `format_user_message`).
    pub async fn send_message(&mut self, message: &str, images: &[String]) -> Result<()> {
        let jsonl = format_user_message(message, images);
        self.stdin
            .write_all(jsonl.as_bytes())
            .await
            .with_context(|| "failed to write message to stdin")?;
        self.stdin
            .write_all(b"\n")
            .await
            .with_context(|| "failed to write newline to stdin")?;
        self.stdin
            .flush()
            .await
            .with_context(|| "failed to flush stdin")?;
        self.last_active = Instant::now();
        Ok(())
    }

    /// Write a permission response to the process stdin (approve or deny a
    /// tool permission request). The CLI emits a `permission_request` event
    /// and blocks until it receives this response via stdin.
    pub async fn respond_permission(&mut self, allow: bool, message: Option<&str>) -> Result<()> {
        let jsonl = format_permission_response(allow, message);
        log::info!(
            "[respond_permission] writing permission response: allow={}",
            allow
        );
        self.stdin
            .write_all(jsonl.as_bytes())
            .await
            .with_context(|| "failed to write permission response to stdin")?;
        self.stdin
            .write_all(b"\n")
            .await
            .with_context(|| "failed to write newline to stdin")?;
        self.stdin
            .flush()
            .await
            .with_context(|| "failed to flush stdin")?;
        self.last_active = Instant::now();
        Ok(())
    }

    /// Check if the child process is still alive (non-blocking).
    pub fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_status)) => false, // exited
            Ok(None) => true,           // still running
            Err(_) => false,            // error → assume dead
        }
    }

    /// Get the PID of the child process.
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Gracefully shut down the session by closing stdin (the CLI exits when
    /// stdin closes in `--print` mode).
    #[allow(dead_code)]
    pub async fn shutdown(&mut self) {
        // Drop stdin → the CLI sees EOF on stdin and exits.
        let _ = self.stdin.shutdown().await;
        // Wait briefly for the process to exit.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
    }

    /// Kill the process immediately (SIGKILL).
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }

    /// Get a reference to the shared stdout reader for streaming reads.
    pub fn stdout(&self) -> Arc<Mutex<BufReader<ChildStdout>>> {
        Arc::clone(&self.stdout)
    }
}

impl Drop for PersistentSession {
    fn drop(&mut self) {
        // Best-effort: try to kill on drop if still running.
        // We can't do async here, so we just signal intent.
        if let Some(id) = self.child.id() {
            // Send SIGTERM on Unix. The process will be reaped by the OS
            // when the parent (us) exits, or by the next wait().
            #[cfg(unix)]
            unsafe {
                libc::kill(id as i32, libc::SIGTERM);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SessionMap — global state
// ---------------------------------------------------------------------------

pub type SessionMap = Arc<Mutex<HashMap<String, PersistentSession>>>;

pub fn init_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Build the CLI command for a persistent session
// ---------------------------------------------------------------------------

async fn build_persistent_command(
    engine_id: &str,
    session_id: &str,
    resume: bool,
    model_override: Option<&str>,
) -> Result<(
    std::path::PathBuf,
    Vec<String>,
    std::collections::HashMap<String, String>,
)> {
    match engine_id {
        "claude" => {
            let binary = super::claude::find_claude_binary()?;
            let mut env = super::claude::collect_env().await;
            let mut args = vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--input-format".into(),
                "stream-json".into(),
                "--permission-mode".into(),
                "bypassPermissions".into(),
            ];
            if resume {
                args.push("--resume".into());
            } else {
                args.push("--session-id".into());
            }
            args.push(session_id.into());
            // Per-conversation model override takes precedence over ANTHROPIC_MODEL env var.
            if let Some(model) = model_override.filter(|s| !s.is_empty()) {
                env.insert("ANTHROPIC_MODEL".to_string(), model.to_string());
            }
            Ok((binary, args, env))
        }
        "codebuddy" => {
            let binary = super::codebuddy::find_codebuddy_binary()?;
            let env = super::codebuddy::collect_env().await;
            let mut args = vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--input-format".into(),
                "stream-json".into(),
                "--include-partial-messages".into(),
                "--permission-mode".into(),
                "bypassPermissions".into(),
            ];
            if resume {
                args.push("--resume".into());
            } else {
                args.push("--session-id".into());
            }
            args.push(session_id.into());
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
            Ok((binary, args, env))
        }
        other => anyhow::bail!("persistent sessions not supported for engine: {other}"),
    }
}

// ---------------------------------------------------------------------------
// Stream reading for persistent sessions
// ---------------------------------------------------------------------------

/// Read from a persistent session's stdout until a `result` event is received
/// (which signals the end of one turn). The reader is shared via Arc<Mutex<>>,
/// so multiple turns can be read sequentially.
pub async fn read_persistent_turn<F>(
    engine_id: &str,
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
    mut on_events: F,
) -> Result<String>
where
    F: FnMut(&[NormalizedEvent]),
{
    let mut guard = stdout.lock().await;
    let mut final_text = String::new();

    loop {
        let mut line = String::new();
        match guard.read_line(&mut line).await {
            Ok(0) => {
                // EOF — the process has closed stdout (likely died).
                anyhow::bail!("persistent session stdout closed unexpectedly");
            }
            Ok(_) => {}
            Err(e) => {
                anyhow::bail!("error reading persistent session stdout: {e}");
            }
        }

        let line = line.trim();
        if line.is_empty() || shared::is_ignorable_stream_line(line) {
            continue;
        }

        let events = parse_line(engine_id, line);
        if events.is_empty() {
            continue;
        }

        let mut is_final = false;
        for evt in &events {
            match evt {
                NormalizedEvent::Final { text } => {
                    final_text = text.clone();
                    is_final = true;
                }
                NormalizedEvent::Error { message: _ } => {
                    is_final = true;
                }
                _ => {}
            }
        }

        on_events(&events);

        if is_final {
            break;
        }
    }

    Ok(final_text)
}
