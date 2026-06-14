# Pixie

> A native desktop workspace for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — multi-workspace agentic chat, skills, a plugin marketplace, scheduled autonomous tasks, and an integrated file / Git / terminal / browser panel. Built with Tauri v2, React, TypeScript, and Rust.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-blue.svg)
![Claude Code](https://img.shields.io/badge/Claude%20Code-CLI-orange.svg)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)

![Pixie](src/assets/hero.svg)

Pixie is a thin, fast desktop UI that drives the `claude` CLI you already have installed and authenticated. It does **not** ship its own model or API client — it spawns the Claude Code CLI as a subprocess, streams its JSON output, and renders it as a polished native app. That means everything your Claude Code session can do (tools, MCP servers, skills, plugins, context) works here too.

---

## Highlights

- **Multi-workspace chat** — Add any number of project folders. Each workspace becomes the working directory for its own set of conversations, and several chats can stream in parallel.
- **Live agent activity** — Streaming markdown with syntax highlighting, plus real-time cards for every tool call and its result, extended-thinking text, and a running token / cost / duration readout.
- **Conversation continuity** — Follow-up messages resume the same Claude Code session, so context carries across turns.
- **Skills picker** — A ✨ picker in the composer lists your user, project, and plugin skills and inserts a `/skill-name` invocation.
- **Plugin marketplace** — Browse, add, and remove marketplaces and install / uninstall plugins, all through the official `claude plugin` commands.
- **Scheduled tasks** — Run prompts on a schedule (daily, weekdays, or every N minutes / hours) headlessly against a workspace. Results land back in the sidebar like any chat, with desktop notifications.
- **Workspace dev panel** — A resizable side panel with five tabs: **Files**, **Preview** (code, markdown, images, rendered HTML), **Git** (status, history, diffs), **Browser** (preview a dev server), and a real **Terminal** (PTY-backed, your `$SHELL`).
- **System-tray resident** — Closing the window hides to the tray so scheduled tasks keep firing.
- **Dark & light themes**, configurable model overrides, custom system prompt, and a full set of keyboard shortcuts.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or newer
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- A [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- The [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed **and authenticated** (`claude` on your `PATH`)

Pixie searches `PATH` plus a few common locations (`/usr/local/bin`, Homebrew, `~/.local/bin`, nvm directories) for the `claude` binary, and it sources your interactive login shell so that env vars such as `ANTHROPIC_API_KEY` are picked up even when launched from a `.app` bundle.

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

> **Note** — Pixie launches Claude Code with `--dangerously-skip-permissions` so it can act fully autonomously within the selected workspace. Only point it at projects you trust it to read and modify. See [Security & data](#security--data).

---

## Usage

1. **Add a workspace** — Click the workspace switcher in the sidebar (top-left) → *Add workspace*, then pick a project folder. This folder is the working directory Claude Code runs in.
2. **Start chatting** — Type a message in the composer and press `Enter`. The first message starts a new session; later messages resume it.
3. **Watch it work** — Tool calls, their results, the model's extended thinking, and token/cost totals update live beneath the reply.
4. **Open the dev panel** — Toggle the panel button in the header to browse files, read a diff, run commands in the terminal, or preview a running dev server.
5. **Use skills** — Click the ✨ button in the composer to browse and insert `/skill` invocations, or open **Skills** from the sidebar to install plugins from a marketplace.
6. **Automate** — Open **Scheduled Tasks** to register a prompt that runs on a schedule. Completed runs appear in the sidebar and trigger a desktop notification.

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

Pixie is a standard Tauri v2 app: a Rust backend that owns process and PTY lifecycle, plus a React frontend that talks to it over Tauri's IPC bridge.

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
│  Chat         send_message / stop_generation           │
│  Workspaces   select / set_active / list_directory     │
│  Git          git_status / git_log / git_diff          │
│  Files        read_file_content                        │
│  Terminal     pty_spawn / pty_write / pty_resize / …   │
│  Skills       list_skills                              │
│  Plugins      plugin_marketplace_* / plugin_install /… │
│  Schedules    create / update / delete / toggle / run  │
│                                                        │
│  Events emitted to the frontend                        │
│    claude-response · claude-done · claude-error        │
│    claude-tool · claude-thinking · claude-thinking-text│
│    claude-usage · task-run-complete · pty-output       │
└──────────────────────────┬────────────────────────────┘
                           │  tokio::process / portable-pty
┌──────────────────────────┴────────────────────────────┐
│  Claude Code CLI (external)                            │
│  claude --print --output-format stream-json --verbose  │
│         --session-id <id> --dangerously-skip-permissions│
└───────────────────────────────────────────────────────┘
```

How a message flows:

- The frontend calls `invoke("send_message", …)`. The backend spawns one Claude Code process **per conversation** (so multiple chats run concurrently) and returns immediately.
- Each streamed JSON line is parsed into an event: assistant text deltas, tool-use starts / results, thinking text, usage, and the final `result`. The backend re-emits each as a typed Tauri event.
- The frontend's `useChat` hook subscribes to those events and patches the active conversation in real time.
- `stop_generation` sends `SIGTERM` to the child process via a pid registry, so stopping never has to wait on the streaming lock.

**Where state lives:** conversations, workspaces, theme, system prompt, and model config are stored in the browser's `localStorage`. Scheduled tasks and run history are persisted by the backend to the app data directory. The backend is otherwise stateless about chat content — Claude Code itself owns session history via `--session-id` / `--resume`.

---

## Project structure

```
pixie/
├── src/                         # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── ChatView.tsx         # Message list with auto-scroll
│   │   ├── MessageBubble.tsx    # Markdown + code + tool/thinking/usage
│   │   ├── InputBar.tsx         # Composer with skill picker
│   │   ├── SkillsDropdown.tsx   # Filterable /skill picker
│   │   ├── Sidebar.tsx          # Workspaces + conversations
│   │   ├── RightPanel.tsx       # Files / Preview / Git / Browser / Terminal
│   │   ├── Terminal.tsx         # xterm.js over a Tauri PTY
│   │   ├── MarketplacePanel.tsx # Plugin marketplaces + install
│   │   ├── ScheduledTasksPanel.tsx
│   │   └── Settings.tsx
│   ├── hooks/
│   │   ├── useChat.ts           # Chat state + Tauri IPC event wiring
│   │   └── useScheduledTasks.ts # Scheduled-task CRUD + refresh
│   ├── preview.ts               # Shared "is this previewable?" helpers
│   ├── App.tsx                  # Root layout + view routing
│   ├── main.tsx                 # React entry
│   ├── index.css                # Tailwind + theme CSS variables
│   └── types.ts                 # Shared TS interfaces
├── src-tauri/                   # Backend (Rust + Tauri v2)
│   ├── src/
│   │   ├── main.rs              # Binary entry point
│   │   ├── lib.rs               # Tauri commands, scheduler, tray, state
│   │   ├── claude.rs            # Claude CLI process + stream parsing
│   │   └── pty.rs               # PTY sessions (portable-pty)
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
├── vite.config.ts
└── tsconfig.json
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
cargo test                # Unit tests (frontmatter / skill discovery)
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
| Syntax highlighting | react-syntax-highlighter (Prism) |
| Terminal | xterm.js + portable-pty |
| Scheduling | chrono (local-time presets) |

### Configuration

Open **Settings** (`Ctrl/Cmd + ,`) to configure:

- **Claude CLI status** — detected path, version, and any error.
- **Model configuration** — override env vars passed to the CLI: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, and `CLAUDE_CODE_EFFORT_LEVEL`. Leave a field blank to inherit the system default.
- **System prompt** — an optional prompt prepended to every session.
- **Theme** — dark or light.

---

## Security & data

- Pixie runs Claude Code with `--dangerously-skip-permissions`, so the model can read and modify files and run commands in the active workspace **without per-action prompts**. Only add workspaces you are comfortable letting the agent operate on.
- The `AskUserQuestion` tool is disabled in streaming mode because the headless runner has no channel to answer it; Claude is asked to phrase such questions as ordinary prose instead.
- Chat content, workspaces, and settings are kept locally in `localStorage`; scheduled tasks and run history live in the OS app-data directory. Nothing is sent anywhere except to the Claude Code CLI you already run.

## Troubleshooting

**Claude CLI not found** — The app shows a dedicated screen if it can't locate `claude`. Verify with `claude --version`; if you installed via nvm or Homebrew, make sure that bin directory is on your `PATH`. Pixie also probes Homebrew and nvm locations directly. Reopen Settings → *Refresh* after installing.

**`ANTHROPIC_API_KEY` / env vars not picked up** — Pixie sources your interactive login shell (`$SHELL -i -l -c env`) so vars defined in `.zprofile` / `.zshrc` (or the Bash equivalents) are inherited. Restart the app after editing those files.

**Build errors** — Update Rust (`rustup update`), clear the build cache (`cd src-tauri && cargo clean`), and reinstall frontend deps (`rm -rf node_modules && pnpm install`).

**Scheduled task didn't fire** — Tasks more than 5 minutes overdue are advanced rather than caught up (to avoid a burst after sleep/close). Tasks only run while Pixie is open (closing to the tray keeps it resident). Use *Run now* to fire one immediately.

---

## Contributing

Contributions are welcome! The codebase is small and approachable:

1. Fork the repo and create a feature branch.
2. Follow the existing style — Rust via `cargo fmt` / `cargo clippy`, frontend via `pnpm lint`.
3. Keep new Tauri commands typed end-to-end (Rust struct ↔ `src/types.ts` interface).
4. Open a pull request describing the change.

## License

Released under the [MIT License](LICENSE).
