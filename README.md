# Pixie

> A native desktop workspace for **pluggable AI agents** — run autonomous agents against any folder, swap engines per session, and watch them work in real time. Built with Tauri v2, React, TypeScript, and Rust.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-blue.svg)
![Agents](https://img.shields.io/badge/engines-Claude%20%7C%20Cursor-orange.svg)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)

![Pixie](src/assets/hero.svg)

Pixie is a thin, fast desktop shell for **agent CLIs you already have installed**. It does not ship its own model or API client — it spawns an external agent process, streams its JSON output, and renders it as a polished native app.

Each conversation binds to an **engine** (today: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Cursor Agent](https://cursor.com/docs/cli/overview)). You can mix engines across workspaces and sessions: one chat on Claude, another on Cursor, both running in parallel.

Use Pixie for research, writing, ops, personal automation, or software work — wherever a headless agent CLI can act on files and tools in a folder you choose.

---

## Highlights

- **Pluggable engines** — Pick an engine per session. Claude Code and Cursor Agent are supported today; the backend is built to add more.
- **Multi-workspace agents** — Add any number of folders as workspaces. Each becomes the agent's working directory, and many sessions can stream in parallel.
- **Live agent activity** — Streaming markdown with syntax highlighting, real-time tool-call cards, extended-thinking text (engine-dependent), and token / cost / duration readouts.
- **Conversation continuity** — Follow-up messages resume the same CLI session so context carries across turns.
- **Per-engine model config** — Override API keys, models, and env vars separately for each engine in Settings.
- **Scheduled tasks** — Run prompts on a schedule (daily, weekdays, or every N minutes / hours) headlessly against a workspace. Results appear in the sidebar with desktop notifications.
- **Workspace panel** — A resizable side panel with **Files**, **Preview**, **Git**, **Browser**, and a real **Terminal** (PTY-backed). Handy for code; optional for non-code workflows.
- **Skills & plugin marketplace** — Discover skills on disk, insert `/skill` invocations from the composer, and browse or install plugins from marketplaces. Pixie follows the **Claude agent standard** for skills and plugins (`.claude/skills`, `.claude-plugin/`, etc.) — a de-facto convention shared by Claude Code, Cursor Agent, and other compatible engines.
- **System-tray resident** — Closing the window hides to the tray so scheduled tasks keep firing.
- **Dark & light themes**, system prompt, keyboard shortcuts.

---

## Supported engines

| Engine | CLI | Notes |
| --- | --- | --- |
| **Claude Code** | `claude` | Reference implementation; skills, plugins, MCP |
| **Cursor Agent** | `cursor-agent` / `agent` | Multi-model loops; supports the same skills & plugin ecosystem |

Both engines speak the same **skills / marketplace conventions** (Claude-format `SKILL.md`, plugin marketplaces, `/skill-name` invocations). Pixie surfaces them engine-agnostically in the UI.

Install **at least one** engine and authenticate it before using Pixie. See [Prerequisites](#prerequisites).

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- A [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- **One or more agent CLIs**, installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — `claude` on your `PATH`
  - [Cursor Agent CLI](https://cursor.com/docs/cli/overview) — `cursor-agent` or `agent` on your `PATH`

Pixie searches `PATH` plus common locations (`/usr/local/bin`, Homebrew, `~/.local/bin`, nvm, `~/.cursor/bin`) for engine binaries. It sources your interactive login shell so env vars (`ANTHROPIC_*`, `CURSOR_*`, etc.) are picked up even when launched from a `.app` bundle.

## Installation

```bash
git clone https://github.com/white1or1black/pixie.git
cd pixie

pnpm install      # frontend dependencies
```

## Running

```bash
pnpm tauri dev   # development mode with hot reload
```

To produce a distributable bundle:

```bash
pnpm tauri build                       # all bundle formats for your OS
pnpm tauri build --debug --bundles app # a quick debug .app / executable
```

> **Note** — Engines run in headless mode with permission prompts skipped (`--dangerously-skip-permissions` for Claude, `--force` for Cursor) so agents can act autonomously within the selected workspace. Only point Pixie at folders you trust the agent to read and modify. See [Security & data](#security--data).

---

## Usage

1. **Add a workspace** — Sidebar → workspace switcher → *Add workspace*, then pick a folder. This is the agent's working directory (project, notes, ops scripts, anything on disk).
2. **Choose an engine** — Use the **Engine** dropdown in the sidebar (default for new sessions) or rely on each conversation's bound engine.
3. **Start an agent** — Type a message and press `Enter`. The first message starts a new session; later messages resume it.
4. **Watch it work** — Tool calls, results, thinking text, and usage update live beneath the reply.
5. **Open the workspace panel** — Toggle the panel in the header for files, diffs, terminal, and previews when you need them.
6. **Skills & plugins** — Click ✨ in the composer to pick a `/skill` invocation, or open **Skills** in the sidebar to manage plugin marketplaces. Works with any engine that follows the Claude agent skills standard (Claude Code, Cursor, etc.).
7. **Automate** — **Scheduled Tasks** runs prompts on a timer. Completed runs appear in the sidebar and notify you.

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New chat | `Ctrl/Cmd + N` |
| Toggle sidebar | `Ctrl/Cmd + B` |
| Toggle settings | `Ctrl/Cmd + ,` |
| Send message | `Enter` |
| New line | `Shift + Enter` |
| Stop generation | `Esc` |

---

## Architecture

Pixie is a Tauri v2 app: a Rust backend that owns process and PTY lifecycle, plus a React frontend over the IPC bridge.

```
┌───────────────────────────────────────────────────────┐
│  Frontend  ·  React + TypeScript + Tailwind CSS        │
│                                                        │
│  hooks (useChat / useScheduledTasks)                   │
│      │  invoke()  ────────►  Tauri commands            │
│      │  listen()  ◄────────  Tauri events (streaming)  │
└──────────────────────────┬────────────────────────────┘
                           │  Tauri IPC bridge
┌──────────────────────────┴────────────────────────────┐
│  Backend  ·  Rust (tokio)                              │
│                                                        │
│  Chat         send_message(engine) / stop_generation   │
│  Engines      check_engines_available / model config   │
│  Workspaces   select / set_active / list_directory     │
│  Git / Files / Terminal / Skills / Plugins / Schedules │
│                                                        │
│  Events: agent-response · agent-tool · agent-done · …    │
└──────────────────────────┬────────────────────────────┘
                           │  tokio::process (one child per conversation)
┌──────────────────────────┴────────────────────────────┐
│  engine/  ·  pluggable agent backends                  │
│    claude.rs   Claude Code  (--print stream-json)      │
│    cursor.rs   Cursor Agent (--print stream-json)      │
│    mod.rs      NormalizedEvent · spawn · parse_line    │
└───────────────────────────────────────────────────────┘
```

How a message flows:

- The frontend calls `invoke("send_message", { engine, conversationId, … })`. The backend picks the engine, spawns one process **per conversation**, and returns immediately.
- Each NDJSON line is parsed into a **normalized event** (text delta, tool start/result, usage, done). The backend emits unified `agent-*` Tauri events.
- `useChat` routes updates by `conversation_id` so parallel sessions stay independent.
- `stop_generation` kills the child by PID without blocking the stream reader.

**Where state lives:** conversations (including per-session `engine`), workspaces, theme, and per-engine model config live in `localStorage`. Scheduled tasks and run history are persisted under the OS app-data directory. Session history is owned by each engine's CLI (`--session-id` / `--resume` for Claude; Cursor session ids tracked by Pixie).

### Adding a new engine

1. Add the engine id to `ENGINE_IDS` in `src-tauri/src/engine/mod.rs` and `AGENT_ENGINES` in `src/types.ts`.
2. Implement `engine/<name>.rs`: `check_available`, `spawn_single`, `spawn_continue`, `parse_line`.
3. Wire dispatch in `engine/mod.rs`.
4. Add model-config fields in `ENGINE_MODEL_FIELDS` if the engine needs env overrides.

---

## Project structure

```
pixie/
├── src/                         # Frontend (React + TypeScript)
│   ├── components/              # ChatView, Sidebar, Settings, RightPanel, …
│   ├── hooks/                   # useChat, useScheduledTasks
│   ├── App.tsx
│   └── types.ts                 # EngineModelConfigs, AgentEngineId, …
├── src-tauri/
│   ├── src/
│   │   ├── engine/              # Pluggable agent backends
│   │   │   ├── mod.rs           # NormalizedEvent, AgentProcess, dispatch
│   │   │   ├── claude.rs
│   │   │   ├── cursor.rs
│   │   │   └── shared.rs        # Shell env, binary discovery
│   │   ├── lib.rs               # Tauri commands, scheduler, tray
│   │   └── pty.rs
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

---

## Development

```bash
pnpm dev                  # Vite dev server only (no Tauri shell)
pnpm tauri dev            # Full app with hot reload

pnpm lint                 # ESLint

cd src-tauri
cargo check               # Type-check Rust
cargo clippy              # Lint Rust
cargo test                # Unit tests
```

### Key technologies

| Layer | Technology |
| --- | --- |
| Desktop framework | Tauri v2 |
| Frontend | React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Build tool | Vite |
| Backend | Rust, tokio |
| Markdown | react-markdown + remark-gfm |
| Terminal | xterm.js + portable-pty |
| Scheduling | chrono |

### Configuration

Open **Settings** (`Ctrl/Cmd + ,`):

- **Agent engines** — availability, version, and binary path for each engine.
- **Default engine** — used when creating new sessions.
- **Model configuration** — per-engine env overrides (collapsed by default). Claude: `ANTHROPIC_*`, `CLAUDE_CODE_*`. Cursor: `CURSOR_API_KEY`, `CURSOR_MODEL`.
- **System prompt** — optional prompt for agent sessions.
- **Theme** — dark or light.

---

## Security & data

- Engines run headless with auto-approved tool execution within the active workspace. Only add workspaces you trust the agent to operate on.
- Claude's `AskUserQuestion` tool is disabled in streaming mode (no channel to answer it); the model is steered to ask in plain prose instead.
- Chat content, workspaces, and settings stay local. Scheduled tasks and run history live in the app-data directory. Nothing is sent anywhere except through the agent CLI you configure.

---

## Troubleshooting

**No engine available** — Install at least one CLI (`claude` or `cursor-agent`). Check Settings → *Refresh*. Verify with `claude --version` or `cursor-agent --version`.

**Env vars not picked up** — Pixie sources your login shell (`$SHELL -i -l -c env`). Restart the app after editing `.zprofile` / `.zshrc`.

**Wrong engine on a session** — Each conversation keeps its bound engine. Start a new session or pick a different default engine for new chats.

**Build errors** — `rustup update`, `cd src-tauri && cargo clean`, `rm -rf node_modules && pnpm install`.

**Scheduled task didn't fire** — Pixie must be running (tray is fine). Overdue tasks more than 5 minutes are skipped to avoid catch-up bursts. Use *Run now* to test.

---

## Contributing

Contributions are welcome — especially new **engines** and general-agent UX improvements:

1. Fork the repo and create a feature branch.
2. Rust: `cargo fmt` / `cargo clippy`. Frontend: `pnpm lint`.
3. Keep Tauri commands typed end-to-end (Rust ↔ `src/types.ts`).
4. Open a pull request describing the change.

## License

Released under the [MIT License](LICENSE).
