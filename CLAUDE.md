# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pixie is a **Tauri v2** desktop shell for pluggable agent CLIs (Claude Code, Cursor Agent, CodeBuddy). It ships no model of its own — it spawns an external agent process, streams its NDJSON output, and renders it as a native app. A React 19 + TypeScript frontend talks to a Rust (tokio) backend over the Tauri IPC bridge.

The `README.md` documents product usage and high-level architecture, but is **stale in three places** — trust this file over the README for:
1. **There are 3 engines** (`claude`, `cursor`, `codebuddy`), not 2.
2. **State is file-backed**, not in `localStorage` (see Persistence below).
3. There is a **persistent-session** process model in addition to per-message spawning.

## Commands

```bash
# Frontend (pnpm is the package manager; Node 18+, Rust stable)
pnpm install
pnpm tauri dev            # full app with hot reload (primary dev loop)
pnpm dev                  # Vite frontend only, no Tauri shell
pnpm build                # tsc -b && vite build
pnpm lint                 # ESLint (flat config, eslint.config.js)

# Backend (run from src-tauri/)
cd src-tauri
cargo check               # type-check
cargo fmt                 # format
cargo clippy -- -D warnings   # lint (treat warnings as errors per CONTRIBUTING)
cargo test                # all Rust unit tests
cargo test frontmatter    # a single test by name substring

# Bundles
pnpm tauri build                  # all formats for the host OS
pnpm tauri build --debug --bundles app   # quick debug .app / executable
```

There is **no frontend test runner** — only Rust unit tests (in `src-tauri/src/lib.rs` `#[cfg(test)]`).

Debug builds log at `info` level via `tauri-plugin-log`; backend output is essential when debugging streaming or scheduling.

## Architecture

### Engine abstraction (`src-tauri/src/engine/`)

Each agent CLI is a pluggable backend behind a single normalized interface. **To add an engine**, touch all of these:
- `engine/mod.rs`: add the id to `ENGINE_IDS`, to `normalize_engine_id` / `engine_display_name`, and to the dispatch arms in `check_engine`, `parse_line`, `spawn_single`, `spawn_continue` (and `spawn_headless`/persistent dispatch if applicable).
- `engine/<name>.rs`: implement `check_available`, `spawn_single`, `spawn_continue`, `parse_line` (and binary discovery + env collection).
- `src/types.ts`: add the id to `AgentEngineId`, `AGENT_ENGINES`, the per-engine model-config interface, and `ENGINE_MODEL_FIELDS`.

The `NormalizedEvent` enum (`mod.rs`) is the lingua franca — each engine's `parse_line` converts one NDJSON line into zero or more `NormalizedEvent`s. `lib.rs::emit_agent_events` then translates those into the unified `agent-*` Tauri events the frontend subscribes to. This is the seam that keeps engines engine-agnostic.

### Two agent process models

`send_message` (in `lib.rs`) picks one of two paths based on engine id:

- **Persistent sessions** (`engine/persistent.rs`) — Claude & CodeBuddy only. A single CLI process is kept alive with `--input-format stream-json`, and subsequent turns are piped through its stdin (`PersistentSession::send_message`). This avoids reloading session history every turn. Sessions live in the `AppState.sessions` map, are capped at `MAX_SESSIONS = 10` (LRU-evicted), and killed after `IDLE_TIMEOUT = 30 min`. `send_message` reuses a live session or spawns a new one. A background loop (`run()` setup) enforces those limits every 60s.
- **Per-message spawn** (`spawn_single` / `spawn_continue`) — Cursor, plus the headless scheduled-task path (`spawn_headless`). A fresh process is spawned each turn and reconnected via `--resume`. Cursor's external session id is tracked in `AppState.conversation_engines` (Claude/CodeBuddy reuse the conversation id directly).

### Streaming → frontend

Backend emits these events (frontend `useChat` routes each by `conversation_id`, so parallel sessions stay independent):
`agent-response` (text delta), `agent-tool` (start/result), `agent-thinking` / `agent-thinking-text`, `agent-usage`, `agent-done`, `agent-error`, `agent-permission-request`.

- `stop_generation` kills the running child by PID via the `AppState.kill_registry` (conversation→pid map) so it doesn't contend for the stream reader's lock.
- `agent-permission-request` ↔ the `respond_permission` command is the interactive approval channel (writes a permission response to the persistent session's stdin).
- Tool-result text is truncated to `MAX_TOOL_RESULT_CHARS` (8 000) before emission.

### Managed state (`AppState`, registered via `.manage()`)

`processes` (per-conversation `AgentProcess`), `conversation_engines` (engine binding + Cursor external session id), `workspace` (active working dir), `pty_map` (terminals), `kill_registry` (conv→pid), `sessions` (persistent). Every `#[tauri::command]` is registered in the single `generate_handler!` list at the bottom of `run()`.

### Persistence (file-backed, not localStorage)

`config.json` (settings + workspaces + per-engine model config) and `history.jsonl` (one conversation per line) live in the OS app-data dir, written by the `load_app_config` / `save_app_config` / `load_history` / `save_history` Tauri commands. `src/lib/storage.ts` is the frontend's single source of truth: an in-memory module singleton plus a **coalesced, serialized writer** (config debounced 300 ms, history 50 ms) that re-reads live state at flush time so two writers in the same tick never clobber each other. `localStorage` is used **only** for a one-shot migration on first launch.

Scheduled tasks and run history (`TaskRunRecord`) are persisted separately under the app-data dir.

### Scheduler & tray

- A tokio task ticks every 60s (`check_and_run_due_tasks`) and fires enabled tasks whose `next_run` is due, via the headless auto-approve path. Tasks overdue by more than ~5 min are skipped to avoid catch-up bursts.
- The window close button is intercepted (`on_window_event`) to **hide to tray** rather than quit, so scheduled tasks keep firing while the app is resident.

### Adding a Tauri command (typed end-to-end IPC convention)

Per `CONTRIBUTING.md`: write `#[tauri::command] async fn` in `lib.rs`, register it in the `generate_handler!` list, and use `serde`-derive structs. Mirror the payload as an interface in `src/types.ts`, then call it from a hook with `invoke<T>("command_name", { args })`. The Rust wire format is `snake_case`; `storage.ts` has the wire↔`camelCase` converters (follow that pattern for new persisted types).

## Security posture

Engines run headless with permissions bypassed / auto-approved within the active workspace (e.g. `--permission-mode bypassPermissions`, `--dangerously-skip-permissions`). **Only point Pixie at folders you trust the agent to read and modify.** Claude's `AskUserQuestion` tool is disabled in streaming mode (no channel to answer it). If you change anything about how permissions are approved or how the agent is confined to a workspace, treat it as security-sensitive.

## Release process

Use the `/release` skill (or follow `docs/releasing.md`). Non-obvious gotchas:
- **Bump 4 version files in sync**: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, **and** the `pixie` entry in `src-tauri/Cargo.lock`. The new version must be **strictly greater** than the last published one, or the in-app updater reports "up to date".
- Tag **`app-vX.Y.Z`** (the `app-` prefix is what triggers CI — `vX.Y.Z` alone does nothing).
- CI publishes a **draft** GitHub Release; you must run `gh release edit app-vX.Y.Z --draft=false` (or publish on the web) before users see the update.
- The updater signing key lives at `~/.tauri/pixie.key` — back it up; losing it permanently breaks updates for every already-installed copy.
