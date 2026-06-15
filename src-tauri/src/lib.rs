mod claude;
mod pty;

use claude::{ClaudeProcess, SharedClaudeProcess};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
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

type ProcessMap = Arc<Mutex<HashMap<String, SharedClaudeProcess>>>;
/// conversation_id → child pid, so stop_generation can kill the running claude
/// process without contending for the streaming task's lock.
type KillRegistry = Arc<Mutex<HashMap<String, u32>>>;

pub struct AppState {
    /// Per-conversation claude processes for parallel execution
    processes: ProcessMap,
    /// User-selected workspace directory
    workspace: Arc<Mutex<Option<String>>>,
    /// PTY sessions
    pty_map: PtyMap,
    /// Running claude child pids, for immediate stop without lock contention
    kill_registry: KillRegistry,
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
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn send_message(
    message: String,
    conversation_id: String,
    is_continue: Option<bool>,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let is_continue = is_continue.unwrap_or(false);
    log::info!("[send_message] start: conv_id={}, is_continue={}, msg_len={}",
        conversation_id, is_continue, message.len());

    // Get or create per-conversation process
    {
        let mut processes = state.processes.lock().await;
        if !processes.contains_key(&conversation_id) {
            processes.insert(conversation_id.clone(), Arc::new(Mutex::new(ClaudeProcess::new())));
        }
    }

    // Get workspace for CWD
    let workspace = state.workspace.lock().await.clone();

    // Clone references for the spawned task
    let processes = state.processes.clone();
    let kill_registry = state.kill_registry.clone();
    let app_handle = app.clone();
    let conv_id = conversation_id.clone();

    // Spawn a background task so the command returns immediately
    // and other conversations can run in parallel
    tokio::spawn(async move {
        let proc_arc = {
            let processes = processes.lock().await;
            processes.get(&conv_id).cloned()
        };

        let Some(proc_arc) = proc_arc else { return; };
        let mut proc = proc_arc.lock().await;

        // Spawn the appropriate claude process
        // The conversation_id doubles as the Claude CLI --session-id for context continuity
        let spawn_result = if is_continue {
            proc.spawn_continue(&conv_id, &message, workspace.as_deref()).await
        } else {
            proc.spawn_single(&conv_id, &message, workspace.as_deref()).await
        };

        if let Err(e) = spawn_result {
            log::error!("[send_message] spawn failed: {}", e);
            let _ = app_handle.emit(
                "claude-error",
                ResponseError {
                    conversation_id: conv_id.clone(),
                    error: format!("Failed to start claude: {}", e),
                },
            );
            return;
        }

        // Register the child pid so stop_generation can kill it immediately without
        // contending for `proc_arc` (which this task holds for the whole stream read).
        if let Some(pid) = proc.child_pid() {
            log::info!("[send_message] registered pid {} for conv {}", pid, conv_id);
            kill_registry.lock().await.insert(conv_id.clone(), pid);
        }

        log::info!("[send_message] process spawned, reading stream...");

        // Clone for use after the stream closure
        let app_after = app_handle.clone();
        let conv_id_after = conv_id.clone();

        // Throttle thinking-token updates: only emit when the estimate jumps by >= 8.
        let mut last_thinking: u64 = 0;

        let result = proc
            .read_stream(move |evt| {
                let evt_type = match evt {
                    claude::ClaudeStreamEvent::ContentBlockDelta { .. } => "delta",
                    claude::ClaudeStreamEvent::ContentBlockStart { .. } => "block_start",
                    claude::ClaudeStreamEvent::Result { .. } => "result",
                    claude::ClaudeStreamEvent::MessageStart {} => "message_start",
                    claude::ClaudeStreamEvent::MessageStop {} => "message_stop",
                    claude::ClaudeStreamEvent::System { .. } => "system",
                    claude::ClaudeStreamEvent::Error { .. } => "error",
                    claude::ClaudeStreamEvent::Assistant { .. } => "assistant",
                    claude::ClaudeStreamEvent::User { .. } => "user",
                    claude::ClaudeStreamEvent::ToolUse { .. } => "tool_use",
                    claude::ClaudeStreamEvent::ToolResult { .. } => "tool_result",
                };

                // Emit streaming text for real-time display (assistant, deltas)
                if let Some(text) = evt.streaming_text() {
                    log::info!("[stream] streaming: event_type={}, text_len={}", evt_type, text.len());
                    let _ = app_handle.emit(
                        "claude-response",
                        ResponseChunk {
                            conversation_id: conv_id.clone(),
                            content: text,
                            event_type: evt_type.to_string(),
                        },
                    );
                }

                // Emit the model's reasoning (thinking) text so the UI can show
                // what it is reasoning about during the "thinking" gap.
                if let Some(thinking) = evt.streaming_thinking() {
                    let _ = app_handle.emit(
                        "claude-thinking-text",
                        ResponseThinkingText {
                            conversation_id: conv_id.clone(),
                            content: thinking,
                        },
                    );
                }

                // Emit live tool-use activity so the UI can show what Claude is doing
                for te in evt.tool_events() {
                    let (kind, name, input, content, is_error) = match te.kind {
                        claude::ToolEventKind::Start { name, input } => {
                            ("start", name, input, None, false)
                        }
                        claude::ToolEventKind::Result { content, is_error } => {
                            ("result", None, None, content, is_error)
                        }
                    };
                    let _ = app_handle.emit(
                        "claude-tool",
                        ResponseTool {
                            conversation_id: conv_id.clone(),
                            tool_use_id: te.id,
                            kind: kind.to_string(),
                            name,
                            input,
                            content,
                            is_error,
                        },
                    );
                }

                // Emit live thinking-token estimate (throttled)
                if let Some(tokens) = evt.thinking_tokens() {
                    if tokens >= last_thinking.saturating_add(8) {
                        last_thinking = tokens;
                        let _ = app_handle.emit(
                            "claude-thinking",
                            ResponseThinking {
                                conversation_id: conv_id.clone(),
                                tokens,
                            },
                        );
                    }
                }

                // Emit per-turn and final usage for token/cost display
                if let Some(u) = evt.usage() {
                    let _ = app_handle.emit(
                        "claude-usage",
                        ResponseUsage {
                            conversation_id: conv_id.clone(),
                            kind: u.kind.to_string(),
                            input_tokens: u.input_tokens,
                            output_tokens: u.output_tokens,
                            cache_read_tokens: u.cache_read_tokens,
                            cache_creation_tokens: u.cache_creation_tokens,
                            cost_usd: u.cost_usd,
                            duration_ms: u.duration_ms,
                            num_turns: u.num_turns,
                            model: u.model,
                            stop_reason: u.stop_reason,
                        },
                    );
                }

                // Capture final text from result event only
                if let Some(text) = evt.final_text() {
                    log::info!("[stream] final: event_type={}, text_len={}", evt_type, text.len());
                }
            })
            .await;

        // Stream finished (naturally or because stop killed the pid): clear the registry entry.
        kill_registry.lock().await.remove(&conv_id_after);

        match result {
            Ok(full_text) => {
                log::info!("[send_message] done, total_len={}", full_text.len());
                let _ = app_after.emit(
                    "claude-done",
                    ResponseDone {
                        conversation_id: conv_id_after,
                        full_text,
                    },
                );
            }
            Err(e) => {
                log::error!("[send_message] stream error: {}", e);
                let _ = app_after.emit(
                    "claude-error",
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
    claude::run_claude_command(vec![
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
    claude::run_claude_command(vec![
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
    claude::run_claude_command(args).await.map_err(|e| e.to_string())
}

/// Remove a configured marketplace by name.
#[tauri::command]
async fn plugin_marketplace_remove(name: String) -> Result<String, String> {
    claude::run_claude_command(vec![
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
    claude::run_claude_command(vec!["plugin".into(), "install".into(), plugin_id])
        .await
        .map_err(|e| e.to_string())
}

/// Uninstall an installed plugin by name.
#[tauri::command]
async fn plugin_uninstall(name: String) -> Result<String, String> {
    claude::run_claude_command(vec!["plugin".into(), "uninstall".into(), name])
        .await
        .map_err(|e| e.to_string())
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
async fn set_model_config(
    config: HashMap<String, String>,
) -> Result<(), String> {
    claude::set_model_config_overrides(config);
    Ok(())
}

#[tauri::command]
async fn stop_generation(
    conversation_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Kill the running claude process by pid. We deliberately do NOT lock `proc_arc`
    // here, because the streaming task holds that lock for the whole stream read —
    // acquiring it would block until the response finishes naturally (i.e. never stop).
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

#[tauri::command]
async fn get_conversations(app: AppHandle) -> Result<Vec<Conversation>, String> {
    let data_dir = get_data_dir(&app)?;
    let conversations_file = data_dir.join("conversations.json");

    if !conversations_file.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&conversations_file)
        .map_err(|e| format!("Failed to read conversations: {}", e))?;

    let conversations: Vec<Conversation> = serde_json::from_str(&content)
        .unwrap_or_default();

    Ok(conversations)
}

#[tauri::command]
async fn save_conversation(
    conversation: Conversation,
    app: AppHandle,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let conversations_file = data_dir.join("conversations.json");

    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    let mut conversations: Vec<Conversation> = if conversations_file.exists() {
        let content = fs::read_to_string(&conversations_file)
            .map_err(|e| format!("Failed to read conversations: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    if let Some(existing) = conversations.iter_mut().find(|c| c.id == conversation.id) {
        *existing = conversation.clone();
    } else {
        conversations.push(conversation);
    }

    let json = serde_json::to_string_pretty(&conversations)
        .map_err(|e| format!("Failed to serialize conversations: {}", e))?;

    fs::write(&conversations_file, json)
        .map_err(|e| format!("Failed to write conversations: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn delete_conversation(
    conversation_id: String,
    app: AppHandle,
) -> Result<(), String> {
    let data_dir = get_data_dir(&app)?;
    let conversations_file = data_dir.join("conversations.json");

    if !conversations_file.exists() {
        return Ok(());
    }

    let content = fs::read_to_string(&conversations_file)
        .map_err(|e| format!("Failed to read conversations: {}", e))?;

    let mut conversations: Vec<Conversation> = serde_json::from_str(&content)
        .unwrap_or_default();

    conversations.retain(|c| c.id != conversation_id);

    let json = serde_json::to_string_pretty(&conversations)
        .map_err(|e| format!("Failed to serialize conversations: {}", e))?;

    fs::write(&conversations_file, json)
        .map_err(|e| format!("Failed to write conversations: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn check_claude_available() -> Result<ClaudeStatus, String> {
    match claude::find_claude_binary() {
        Ok(path) => {
            let path_str = path.display().to_string();
            match claude::get_claude_version().await {
                Ok(version) => Ok(ClaudeStatus {
                    available: true,
                    version: Some(version),
                    path: Some(path_str),
                    error: None,
                }),
                Err(e) => Ok(ClaudeStatus {
                    available: true,
                    version: None,
                    path: Some(path_str),
                    error: Some(e.to_string()),
                }),
            }
        }
        Err(e) => Ok(ClaudeStatus {
            available: false,
            version: None,
            path: None,
            error: Some(e.to_string()),
        }),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    let dirs = directories::ProjectDirs::from("com", "pixie", "Pixie")
        .ok_or_else(|| "Failed to determine app data directory".to_string())?;
    Ok(dirs.data_dir().to_path_buf())
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

    let mut proc = ClaudeProcess::new();
    let spawn_result = proc
        .spawn_single(&conversation_id, &task.prompt, Some(&task.workspace))
        .await;

    if let Err(e) = spawn_result {
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

    // Read the stream to completion. The on_event closure is intentionally a no-op:
    // we surface scheduled runs via the recorded result + notification rather than
    // streaming into an interactive chat keyed by the same conversation_id.
    let result = proc.read_stream(|_evt| {}).await;
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
            workspace: Arc::new(Mutex::new(None)),
            pty_map: pty::init_pty_map(),
            kill_registry: Arc::new(Mutex::new(HashMap::new())),
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
            select_workspace,
            pick_files,
            get_workspace,
            set_active_workspace,
            get_conversations,
            save_conversation,
            delete_conversation,
            check_claude_available,
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
