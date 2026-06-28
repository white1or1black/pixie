//! Builtin engine — an in-process agent loop powered by the `pixie-pi` library.
//!
//! The other engines (claude, cursor, codebuddy) spawn an external CLI process
//! and parse its NDJSON. The builtin engine instead runs the agent loop directly
//! in Rust, driving [`pixie_pi::AgentSession`] and mapping its [`AgentEvent`]s
//! onto pixie's engine-agnostic [`NormalizedEvent`]s over an mpsc channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use futures_util::StreamExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use pixie_pi::ai::stream::AssistantMessageEvent;
use pixie_pi::ai::types::ToolResultContent;
use pixie_pi::{AgentEvent, AgentSession, Message, Model, ThinkingLevel, UserMessage};

use super::{EngineStatus, NormalizedEvent, ToolEvent, ToolEventKind, UsageInfo};

/// Default model for the builtin engine — pixie-pi's first builtin model. Kept
/// as a plain const so `lib.rs` can reference it without resolving the registry.
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// BuiltinSession — wraps a pixie_pi::AgentSession
// ---------------------------------------------------------------------------

pub struct BuiltinSession {
    pub session_id: String,
    session: AgentSession,
    cancel_token: CancellationToken,
}

impl BuiltinSession {
    /// Create a new session. Signature matches the old hand-rolled builtin so
    /// `lib.rs` is unchanged.
    pub fn new(
        session_id: &str,
        model: Option<&str>,
        system_prompt: Option<&str>,
        cwd: &str,
        api_key: &str,
        base_url: Option<&str>,
    ) -> Self {
        // A caller-provided model wins; otherwise fall back to the configured
        // (ANTHROPIC_MODEL) or default model.
        let model_pattern = model.map(str::to_string).unwrap_or_else(get_model);
        let resolved = resolve_builtin_model(Some(&model_pattern), base_url);
        log::info!(
            "[builtin] new session: model={}, base_url={}, cwd={}",
            resolved.id,
            resolved.base_url,
            cwd
        );

        let tools = pixie_pi::tools::coding_tools(PathBuf::from(cwd));
        let system = system_prompt
            .unwrap_or(
                "You are a helpful coding assistant working in the user's workspace. \
                 Use the provided tools to read, edit, write, and search files and to run \
                 shell commands as needed.",
            )
            .to_string();

        let mut session = AgentSession::new(
            PathBuf::from(cwd),
            system,
            resolved,
            ThinkingLevel::Off,
            tools,
            reqwest::Client::new(),
        );
        session.api_key = if api_key.is_empty() {
            None
        } else {
            Some(api_key.to_string())
        };

        Self {
            session_id: session_id.to_string(),
            session,
            cancel_token: CancellationToken::new(),
        }
    }

    /// Run a single turn: feed the user message to the agent loop and stream its
    /// events to the frontend as `NormalizedEvent`s. Returns the turn's final text.
    pub async fn run_turn(
        &mut self,
        message: &str,
        // TODO: forward image blocks to pixie_pi::UserMessage once its API supports them.
        _images: &[String],
        mut emit: impl FnMut(NormalizedEvent),
    ) -> Result<(String, bool)> {
        // Fresh cancel token per turn (the previous one was cancelled or done).
        self.cancel_token = CancellationToken::new();

        emit(NormalizedEvent::SessionEstablished {
            session_id: self.session_id.clone(),
        });

        let model_id = self.session.model.id.clone();
        let prompts = vec![Message::User(UserMessage::text(message))];

        // `run` clones the live transcript into the loop; the loop appends to its
        // copy and ends with `AgentEnd { messages }`. We capture that final
        // transcript and write it back so the next turn has the full history.
        let mut stream = self.session.run(prompts, self.cancel_token.clone());

        let mut final_text = String::new();
        let mut had_error = false;
        let mut final_messages: Option<Vec<Message>> = None;

        // Emit each event IMMEDIATELY via the caller's closure so deltas reach
        // the frontend in real time — NOT buffered in a channel until the turn
        // ends (which caused the long "no response" gap before text appeared).
        while let Some(ev) = stream.next().await {
            map_agent_event(&ev, &model_id, &mut final_text, &mut had_error, &mut emit);
            if let AgentEvent::AgentEnd { messages } = &ev {
                final_messages = Some(messages.clone());
            }
        }

        // Write the authoritative transcript back for multi-turn continuity.
        if let Some(msgs) = final_messages {
            self.session.messages = msgs;
        }

        log::info!(
            "[builtin] turn finished: final_text_len={}, had_error={}",
            final_text.len(),
            had_error
        );

        if !had_error {
            emit(NormalizedEvent::Final {
                text: final_text.clone(),
            });
        }

        Ok((final_text, had_error))
    }

    /// Cancel the current turn.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }
}

// ---------------------------------------------------------------------------
// Session map (shared state)
// ---------------------------------------------------------------------------

pub type BuiltinSessionMap = Arc<Mutex<HashMap<String, BuiltinSession>>>;

pub fn init_builtin_sessions() -> BuiltinSessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Engine check / probe / models
// ---------------------------------------------------------------------------

/// "Available" means an API key is configured — there is no external binary.
pub async fn check_available() -> EngineStatus {
    let api_key = get_api_key();
    let available = !api_key.is_empty();
    EngineStatus::basic(
        "builtin",
        engine_display_name(),
        available,
        Some("builtin".to_string()),
        None,
        if available {
            None
        } else {
            Some("No ANTHROPIC_API_KEY configured".to_string())
        },
    )
}

/// List available models from pixie-pi's builtin registry.
pub async fn list_models() -> Vec<(String, String)> {
    pixie_pi::ai::builtin_models()
        .iter()
        .map(|m| (m.id.clone(), display_name_for(&m.id)))
        .collect()
}

pub fn engine_display_name() -> &'static str {
    "Builtin"
}

fn display_name_for(id: &str) -> String {
    if id.contains("opus") {
        "Claude Opus 4.8".to_string()
    } else if id.contains("haiku") {
        "Claude Haiku 4.5".to_string()
    } else if id.contains("sonnet") {
        "Claude Sonnet 4.6".to_string()
    } else {
        id.to_string()
    }
}

// ---------------------------------------------------------------------------
// AgentEvent → NormalizedEvent mapping
// ---------------------------------------------------------------------------

/// Map one pixie-pi [`AgentEvent`] to zero or more [`NormalizedEvent`]s, sending
/// them on `tx`. Updates `final_text` / `had_error` for the caller. Returns
/// `true` when the event is the turn terminator (`AgentEnd`).
fn map_agent_event(
    ev: &AgentEvent,
    model_id: &str,
    final_text: &mut String,
    had_error: &mut bool,
    emit: &mut impl FnMut(NormalizedEvent),
) {
    match ev {
        // Live text/thinking deltas → stream straight through.
        AgentEvent::MessageUpdate { event } => match event {
            AssistantMessageEvent::TextDelta { delta, .. } => {
                emit(NormalizedEvent::TextDelta {
                    text: delta.clone(),
                    event_type: "delta",
                });
            }
            AssistantMessageEvent::ThinkingDelta { delta, .. } => {
                emit(NormalizedEvent::ThinkingText {
                    content: delta.clone(),
                });
            }
            _ => {}
        },

        // Tool call starts (the result content arrives later in TurnEnd).
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => {
            emit(NormalizedEvent::Tool(ToolEvent {
                id: tool_call_id.clone(),
                kind: ToolEventKind::Start {
                    name: Some(tool_name.clone()),
                    input: Some(args.to_string()),
                },
            }));
        }

        // End of an assistant turn: emit a Result event per tool call, carrying
        // its content. (ToolExecutionEnd only has is_error, no content.)
        AgentEvent::TurnEnd { tool_results, .. } => {
            for r in tool_results {
                let text = r
                    .content
                    .iter()
                    .filter_map(|c| match c {
                        ToolResultContent::Text { text } => Some(text.as_str()),
                        ToolResultContent::Image { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                emit(NormalizedEvent::Tool(ToolEvent {
                    id: r.tool_call_id.clone(),
                    kind: ToolEventKind::Result {
                        content: Some(text),
                        is_error: r.is_error,
                    },
                }));
            }
        }

        AgentEvent::Usage(u) => {
            emit(NormalizedEvent::Usage(UsageInfo {
                kind: "turn",
                input_tokens: u.input,
                output_tokens: u.output,
                cache_read_tokens: u.cache_read,
                cache_creation_tokens: u.cache_write,
                cost_usd: None,
                duration_ms: None,
                num_turns: None,
                model: Some(model_id.to_string()),
                stop_reason: None,
            }));
        }

        // Remember the latest assistant text as the turn's final answer.
        AgentEvent::MessageEnd(Message::Assistant(a)) => {
            let t = a.text_content();
            if !t.is_empty() {
                *final_text = t;
            }
        }

        AgentEvent::Error(msg) => {
            log::error!("[builtin] agent loop error: {}", msg);
            *had_error = true;
            emit(NormalizedEvent::Error {
                message: msg.clone(),
            });
        }

        // Turn terminator — nothing to emit; the caller writes the carried
        // transcript back from the event itself.
        AgentEvent::AgentEnd { .. } => {}

        // AgentStart / TurnStart / MessageStart / ToolExecutionEnd — nothing to emit.
        _ => {}
    }
}

/// Resolve the model from an optional override pattern + base URL, falling back
/// to pixie-pi's first builtin model.
fn resolve_builtin_model(model: Option<&str>, base_url: Option<&str>) -> Model {
    let registry = pixie_pi::ai::builtin_models();
    let mut resolved = match model {
        Some(pattern) => {
            pixie_pi::ai::resolve_model(&registry, pattern).unwrap_or_else(|| registry[0].clone())
        }
        None => registry[0].clone(),
    };
    if let Some(url) = base_url {
        if !url.is_empty() {
            resolved.base_url = url.to_string();
        }
    }
    resolved
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/// API key priority: builtin config → claude config → ANTHROPIC_API_KEY env.
pub fn get_api_key() -> String {
    use super::shared::get_model_config_value;

    if let Some(v) = get_model_config_value("builtin", "ANTHROPIC_API_KEY") {
        log::info!("[builtin] using API key from builtin config");
        return v;
    }
    if let Some(v) = get_model_config_value("claude", "ANTHROPIC_API_KEY") {
        log::info!("[builtin] using API key from claude config");
        return v;
    }
    if let Ok(v) = std::env::var("ANTHROPIC_API_KEY") {
        if !v.is_empty() {
            log::info!("[builtin] using API key from ANTHROPIC_API_KEY env var");
            return v;
        }
    }
    log::warn!(
        "[builtin] no API key found: checked builtin config, claude config, and ANTHROPIC_API_KEY env var"
    );
    String::new()
}

/// Base URL priority: builtin config → claude config → ANTHROPIC_BASE_URL env.
pub fn get_base_url() -> Option<String> {
    use super::shared::get_model_config_value;
    get_model_config_value("builtin", "ANTHROPIC_BASE_URL")
        .or_else(|| get_model_config_value("claude", "ANTHROPIC_BASE_URL"))
        .or_else(|| {
            std::env::var("ANTHROPIC_BASE_URL")
                .ok()
                .filter(|v| !v.is_empty())
        })
}

/// Model priority: builtin config → claude config → ANTHROPIC_MODEL env → default.
pub fn get_model() -> String {
    use super::shared::get_model_config_value;
    get_model_config_value("builtin", "ANTHROPIC_MODEL")
        .or_else(|| get_model_config_value("claude", "ANTHROPIC_MODEL"))
        .or_else(|| {
            std::env::var("ANTHROPIC_MODEL")
                .ok()
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_MODEL.to_string())
}
