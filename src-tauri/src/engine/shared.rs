use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

pub const ENV_EXACT: &[&str] = &[
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
];

async fn load_shell_env() -> HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

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

pub async fn get_shell_env() -> &'static HashMap<String, String> {
    static SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    if let Some(env) = SHELL_ENV.get() {
        return env;
    }
    let env = load_shell_env().await;
    SHELL_ENV.get_or_init(|| env)
}

static MODEL_CONFIGS: OnceLock<std::sync::Mutex<HashMap<String, HashMap<String, String>>>> =
    OnceLock::new();

fn get_model_configs() -> &'static std::sync::Mutex<HashMap<String, HashMap<String, String>>> {
    MODEL_CONFIGS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn set_engine_model_config(engine: &str, config: HashMap<String, String>) {
    if let Ok(mut guard) = get_model_configs().lock() {
        guard.insert(engine.to_string(), config);
    }
}

/// Legacy: treat as Claude engine config.
pub fn set_model_config_overrides(config: HashMap<String, String>) {
    set_engine_model_config("claude", config);
}

/// Get a single config value for an engine by key.
/// Returns None if the key is not set or the value is empty.
pub fn get_model_config_value(engine: &str, key: &str) -> Option<String> {
    if let Ok(guard) = get_model_configs().lock() {
        if let Some(overrides) = guard.get(engine) {
            if let Some(v) = overrides.get(key) {
                if !v.is_empty() {
                    return Some(v.clone());
                }
            }
        }
    }
    None
}

fn apply_engine_model_config_overrides(engine: &str, env: &mut HashMap<String, String>) {
    if let Ok(guard) = get_model_configs().lock() {
        if let Some(overrides) = guard.get(engine) {
            for (k, v) in overrides {
                if !v.is_empty() {
                    env.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

/// User home directory: `$HOME` on Unix, `%USERPROFILE%` on Windows.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn candidate_paths() -> Vec<PathBuf> {
    let mut paths = vec![];

    // OS-correct PATH splitting (`;` on Windows, `:` on Unix) via split_paths.
    // The old `split(':')` mangled Windows PATH because drive letters (`D:\`)
    // contain ':', so non-C-drive installs were never searched.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            paths.push(dir);
        }
    }

    if cfg!(windows) {
        // npm global bin (where `claude.cmd` / `cursor-agent.cmd` land) + common
        // user-local spots.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(&appdata).join("npm"));
        }
        if let Some(home) = home_dir() {
            paths.push(home.join(".local").join("bin"));
            paths.push(home.join(".cursor").join("bin"));
        }
    } else {
        for p in &[
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/snap/bin",
        ] {
            paths.push(PathBuf::from(p));
        }
        if let Some(home) = home_dir() {
            let nvm_dir = home.join(".nvm/versions/node");
            if nvm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    for entry in entries.flatten() {
                        paths.push(entry.path().join("bin"));
                    }
                }
            }
            paths.push(home.join(".local/bin"));
            paths.push(home.join(".cursor/bin"));
        }
    }

    paths
}

pub fn find_binary(names: &[&str], tool_label: &str) -> anyhow::Result<PathBuf> {
    // On Windows, match PATHEXT: npm global bins are `claude.cmd` shims (or
    // `claude.exe` for native installs), not bare `claude`. On Unix, no ext.
    let exts: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    for dir in candidate_paths() {
        for name in names {
            for ext in exts {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    anyhow::bail!(
        "{tool_label} not found. Searched in: {}",
        candidate_paths()
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Build a `Command` for an engine binary. On Windows, `.cmd`/`.bat` shims (npm
/// global bins like `claude.cmd`) can't be executed directly by `CreateProcess`
/// — they must run via `cmd.exe /c`. Real `.exe` binaries (and everything on
/// Unix) run directly. Callers still append args/stdio/env as usual.
pub fn engine_command(binary: &Path) -> tokio::process::Command {
    let needs_shell = cfg!(windows)
        && matches!(
            binary.extension().and_then(|e| e.to_str()),
            Some("cmd" | "bat")
        );
    if needs_shell {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/c").arg(binary);
        c
    } else {
        tokio::process::Command::new(binary)
    }
}

pub fn extend_path(env: &mut HashMap<String, String>) {
    // These extras are Unix-only paths; on Windows PATH uses ';' as separator
    // and these dirs don't exist, so leave PATH alone there.
    if cfg!(windows) {
        return;
    }
    if let Some(path) = env.get_mut("PATH") {
        let extras = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin"];
        let existing: Vec<&str> = path.split(':').collect();
        let missing: Vec<&str> = extras
            .iter()
            .filter(|e| !existing.contains(e))
            .copied()
            .collect();
        for extra in missing {
            path.push(':');
            path.push_str(extra);
        }
    }
}

/// Detach a spawned agent child from any controlling terminal by starting a new
/// session (`setsid`).
///
/// Agent CLIs such as CodeBuddy open `/dev/tty`. When Pixie is launched from a
/// terminal (e.g. `tauri dev`), the child inherits that controlling terminal
/// and — as a background process performing tty I/O — is repeatedly stopped by
/// SIGTTOU/SIGTTIN. A stopped process never exits but keeps its stdout pipe
/// open, so `read_child_stream` blocks forever and the turn never completes
/// (the reply hangs on "Streaming…" indefinitely). `setsid()` drops the
/// controlling terminal, so `/dev/tty` fails to open and the CLI runs fully
/// headless — exactly as it does when Pixie is launched without a terminal
/// (double-clicked app / no TTY), where it exits cleanly.
#[cfg(unix)]
pub fn detach_from_controlling_terminal(cmd: &mut tokio::process::Command) {
    // Safety: `setsid()` only changes the caller's session/process-group
    // membership; it is async-signal-safe. The closure runs in the child
    // between fork and exec, as `pre_exec` requires.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
pub fn detach_from_controlling_terminal(_cmd: &mut tokio::process::Command) {}

/// Merge process env + login-shell env, filtered by prefix/exact keys.
pub async fn collect_env(
    engine_id: &str,
    prefixes: &[&str],
    exact: &[&str],
) -> HashMap<String, String> {
    let shell_env = get_shell_env().await;
    let mut merged: HashMap<String, String> = HashMap::new();

    let should_include = |key: &str| -> bool {
        exact.contains(&key) || prefixes.iter().any(|prefix| key.starts_with(prefix))
    };

    for (k, v) in std::env::vars() {
        if should_include(&k) {
            merged.insert(k, v);
        }
    }

    for (k, v) in shell_env {
        if should_include(k) {
            merged.insert(k.clone(), v.clone());
        }
    }

    extend_path(&mut merged);
    apply_engine_model_config_overrides(engine_id, &mut merged);
    merged
}

pub async fn run_with_env(
    binary: &Path,
    args: &[&str],
    env: &HashMap<String, String>,
) -> anyhow::Result<std::process::Output> {
    let mut cmd = engine_command(binary);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output()
        .await
        .map_err(|e| anyhow::anyhow!("failed to execute {}: {e}", binary.display()))
}

/// Spawn a one-shot agent process for a readiness/auth probe. Unlike the
/// streaming spawns in each engine module, this **captures stderr** — auth
/// failures typically exit non-zero with the error on stderr before any
/// stream-json is emitted — and runs detached from the controlling terminal.
pub async fn spawn_probe_child(
    binary: PathBuf,
    args: &[String],
    message: &str,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> anyhow::Result<tokio::process::Child> {
    let mut cmd = engine_command(&binary);
    cmd.args(args)
        .arg(message)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    detach_from_controlling_terminal(&mut cmd);
    cmd.spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn probe process: {e}"))
}

/// Spawn an engine command fire-and-forget (used for the one-click login flow).
/// stdout/stderr are discarded and the `Child` handle is dropped **without**
/// `kill_on_drop`, so the process keeps running — the login command opens a
/// browser and stays alive to receive the OAuth callback and write credentials.
pub async fn spawn_detached(
    binary: PathBuf,
    args: &[String],
    env: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let mut cmd = engine_command(&binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in env {
        cmd.env(k, v);
    }
    detach_from_controlling_terminal(&mut cmd);
    cmd.spawn()
        .map_err(|e| anyhow::anyhow!("failed to spawn login process: {e}"))?;
    Ok(())
}

pub const MAX_TOOL_RESULT_CHARS: usize = 8_000;

/// Remove ANSI escape sequences (colors, cursor controls) and other control
/// characters from a string. Useful when parsing CLI output that may contain
/// terminal formatting codes (e.g. "\x1b[1m").
pub fn strip_ansi_and_controls(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // ESC sequence. Common case: CSI "\x1b[ ... <final>"
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                // Skip parameters/intermediates until a final byte (@..~).
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1; // consume final byte
                }
                continue;
            }
            // Non-CSI escape: skip one byte if present.
            if i < bytes.len() {
                i += 1;
            }
            continue;
        }
        // Drop other ASCII control chars except whitespace we may want to keep.
        if b < 0x20 && b != b'\n' && b != b'\r' && b != b'\t' {
            i += 1;
            continue;
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn truncate_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max).collect();
    format!("{truncated}… (truncated)")
}

/// Lines that are safe to ignore before JSON parsing (CodeBuddy emits many of these).
pub fn is_ignorable_stream_line(line: &str) -> bool {
    let line = line.trim();
    line.is_empty()
        || line.contains(r#""type":"file-history-snapshot""#)
        || line.contains(r#""type":"system","subtype":"status""#)
}

pub fn u64_field(obj: &serde_json::Value, key: &str) -> u64 {
    obj.get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i.max(0) as u64)))
        .unwrap_or(0)
}

pub fn extract_result_text(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::String(s)) => Some(truncate_text(s, MAX_TOOL_RESULT_CHARS)),
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
                Some(truncate_text(&buf, MAX_TOOL_RESULT_CHARS))
            }
        }
        Some(other) => Some(truncate_text(&other.to_string(), MAX_TOOL_RESULT_CHARS)),
        None => None,
    }
}
