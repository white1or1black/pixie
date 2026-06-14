# Pixie

A desktop AI chat application powered by the Claude CLI. Built with Tauri v2, React, TypeScript, and Tailwind CSS.

![Pixie](src/assets/hero.png)

## Features

- **Chat Interface** -- Clean, modern chat UI with markdown rendering, syntax highlighting, and streaming responses
- **Conversation Management** -- Create, search, and delete conversations with sidebar navigation
- **Dark & Light Themes** -- Toggle between dark and light modes with persistent preference
- **Keyboard Shortcuts** -- Efficient workflow with `Ctrl+N` (new chat), `Ctrl+B` (toggle sidebar), `Ctrl+,` (settings), `Escape` (stop generation)
- **Streaming Responses** -- Real-time streaming of Claude CLI output with auto-scrolling
- **Code Blocks** -- Syntax-highlighted code blocks with one-click copy
- **Responsive Layout** -- Works well at different window sizes with collapsible sidebar

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd pixie

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

## Usage

1. **Start the app** -- Run `pnpm tauri dev` for development, or launch the built `.app` / binary
2. **Start chatting** -- Type a message in the input bar and press Enter
3. **Manage conversations** -- Use the sidebar to switch between or delete conversations
4. **Configure** -- Open Settings (`Ctrl+,`) to check Claude CLI status or change theme

## Development

### Project Structure

```
pixie/
├── src/                          # Frontend (React + TypeScript)
│   ├── components/
│   │   ├── ChatView.tsx          # Message list with auto-scroll
│   │   ├── InputBar.tsx          # Message input with auto-resize
│   │   ├── MessageBubble.tsx     # Markdown rendering with code blocks
│   │   ├── Settings.tsx          # Settings panel
│   │   └── Sidebar.tsx           # Conversation list with search
│   ├── hooks/
│   │   └── useChat.ts            # Chat state management + Tauri IPC
│   ├── App.tsx                   # Root component with layout
│   ├── index.css                 # Tailwind + custom styles + CSS vars
│   ├── main.tsx                  # React entry point
│   └── types.ts                  # TypeScript interfaces
├── src-tauri/                    # Backend (Rust + Tauri v2)
│   ├── src/
│   │   ├── main.rs               # Binary entry point
│   │   ├── lib.rs                # Tauri commands + app setup
│   │   └── claude.rs             # Claude CLI process management
│   ├── capabilities/
│   │   └── default.json          # Tauri v2 permission capabilities
│   ├── icons/                    # App icons (all sizes)
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri configuration
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### Architecture

```
┌──────────────────────────────────────────────┐
│                  Frontend                     │
│           React + TypeScript + Tailwind       │
│                                              │
│  useChat hook ──invoke()──> Tauri IPC        │
│  useChat hook <──listen()── Tauri Events     │
└──────────────────────┬───────────────────────┘
                       │ Tauri IPC bridge
┌──────────────────────┴───────────────────────┐
│                  Backend (Rust)               │
│                                              │
│  Tauri Commands                              │
│  ├── send_message     → spawn Claude CLI     │
│  ├── stop_generation  → kill Claude process  │
│  └── check_claude_available → verify CLI     │
│                                              │
│  Tauri Events (emitted to frontend)          │
│  ├── claude-response  → streaming chunks     │
│  ├── claude-done      → generation complete  │
│  └── claude-error     → error notification   │
└──────────────────────┬───────────────────────┘
                       │ tokio::process::Command
┌──────────────────────┴───────────────────────┐
│              Claude CLI (external)            │
│      `claude --print --output-format          │
│       stream-json --verbose "<message>"`      │
└──────────────────────────────────────────────┘
```

The app uses Tauri v2's IPC system for frontend-backend communication:
- **Frontend** calls `invoke()` to send commands to the Rust backend
- **Backend** spawns Claude CLI as a subprocess and reads its JSON-stream output
- **Backend** emits events (`claude-response`, `claude-done`, `claude-error`) back to the frontend
- **Frontend** listens to these events via `listen()` to update the UI in real-time

Conversations are persisted in the browser's localStorage on the frontend side. The backend is stateless with respect to chat history -- it only manages the Claude CLI subprocess lifecycle.

### Available Commands

```bash
# Development
pnpm dev              # Start Vite dev server
pnpm tauri dev        # Start Tauri in development mode (hot reload)

# Building
pnpm build            # Build frontend only
pnpm tauri build      # Build production app (all bundles)
pnpm tauri build --debug --bundles app  # Build debug .app only

# Linting
pnpm lint             # Run ESLint

# Rust checks
cd src-tauri && cargo check    # Check Rust compilation
cd src-tauri && cargo clippy   # Run Rust linter
```

### Key Technologies

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri v2 |
| Frontend | React 19, TypeScript 6 |
| Styling | Tailwind CSS 4 |
| Build Tool | Vite 8 |
| Backend | Rust (tokio async runtime) |
| Markdown | react-markdown + remark-gfm |
| Syntax Highlighting | react-syntax-highlighter (Prism) |
| Process Management | tokio::process (async subprocess) |

## Troubleshooting

### Claude CLI Not Found

The app searches for the `claude` binary in your `PATH` and common installation directories. If it cannot find it:

1. Verify Claude CLI is installed: `claude --version`
2. If installed via npm, ensure the npm bin directory is in your PATH
3. Use the Settings panel to check the detected path
4. Restart the app after installing Claude CLI

### Build Errors

- Ensure Rust is up to date: `rustup update`
- Clear the Rust build cache: `cd src-tauri && cargo clean`
- Reinstall frontend deps: `rm -rf node_modules && pnpm install`

## License

MIT
