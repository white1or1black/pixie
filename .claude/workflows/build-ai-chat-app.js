export const meta = {
  name: 'build-ai-chat-app',
  description: 'Build a Tauri-based desktop AI chat app with Claude CLI integration',
  phases: [
    { title: 'Setup', detail: 'Install Rust, scaffold Tauri project, configure dependencies' },
    { title: 'Backend', detail: 'Implement Rust backend: Claude CLI subprocess, Tauri commands, streaming' },
    { title: 'Frontend', detail: 'Build React chat UI with markdown, themes, conversation management' },
    { title: 'Integration', detail: 'Wire frontend to backend, end-to-end testing, polish' },
  ],
}

// Phase 1: Setup - Install Rust and scaffold the Tauri project
phase('Setup')

log('Installing Rust toolchain and scaffolding Tauri v2 project...')

const setupResult = await agent(`You are building a Tauri v2 desktop AI chat application called "agent-cli" in /Users/yunus/projects/agent-cli.

IMPORTANT: The directory /Users/yunus/projects/agent-cli already exists and currently only contains a .claude/ directory. Do NOT re-create the directory.

Complete these setup steps IN ORDER:

1. Install Rust toolchain:
   - Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
   - Source the env: source "$HOME/.cargo/env"
   - Verify: rustc --version && cargo --version

2. Install frontend tooling:
   - Check if Node.js/npm is available (it should be at /Users/yunus/.nvm/versions/node/v22.22.1/bin/node)
   - Install pnpm if not present: npm install -g pnpm

3. Create the Tauri v2 project:
   - cd /Users/yunus/projects/agent-cli
   - Run: pnpm create tauri-app@latest . --template react-ts
   - If the above asks interactive questions, use these defaults:
     - Project name: agent-cli
     - Frontend: React + TypeScript
     - Package manager: pnpm
   - If the command fails because directory is not empty, try: cargo create-tauri-app or manually scaffold
   - ALTERNATIVE: if create-tauri-app doesn't work well in existing dir, scaffold with:
     a. pnpm create vite . --template react-ts (if dir empty enough)
     b. pnpm add -D @tauri-apps/cli@latest
     c. pnpm tauri init (with app name "agent-cli", window title "Agent CLI", dev url "http://localhost:5173", dev path "../src")

4. Install Tauri v2 dependencies:
   - pnpm add @tauri-apps/api@latest
   - cd src-tauri && cargo add tauri tauri-build --features default
   - Ensure Cargo.toml has the right Tauri v2 dependencies

5. Install frontend dependencies:
   - pnpm add react-markdown remark-gfm react-syntax-highlighter @types/react-syntax-highlighter
   - pnpm add -D tailwindcss @tailwindcss/vite

6. Configure Tailwind CSS:
   - Add Tailwind import to src/index.css: @import "tailwindcss";
   - Configure vite.config.ts with tailwindcss plugin

7. Verify setup compiles:
   - source "$HOME/.cargo/env"
   - pnpm tauri build --debug (or at minimum pnpm tauri dev --no-watch to check compilation)
   - Fix any compilation errors

IMPORTANT: Run each step and verify it succeeds before moving to the next. If a step fails, debug and fix it before continuing.

Report what was done and any issues encountered.`, {
  label: 'setup-tauri',
  phase: 'Setup',
})

log('Setup phase complete')

// Phase 2: Backend - Rust backend with Claude CLI integration
phase('Backend')

log('Implementing Rust backend with Claude CLI subprocess management...')

const backendResult = await agent(`You are implementing the Rust backend for a Tauri v2 desktop AI chat app in /Users/yunus/projects/agent-cli.

The project should already be scaffolded with Tauri v2 + React + TypeScript.

Your task is to implement the Rust backend in src-tauri/src/. Here's what to build:

## 1. Claude CLI Integration Module (src-tauri/src/claude.rs)

Create a module that manages Claude CLI subprocess communication:

\`\`\`rust
// Key functionality:
// - Find claude CLI binary path (check common locations like /usr/local/bin, ~/.nvm/versions/node/*/bin, etc.)
// - Spawn claude process with arguments like: claude --print --output-format stream-json
// - Parse streaming JSON output line by line
// - Handle SSE/streaming responses and forward content chunks
// - Support sending messages with context/conversation history
// - Handle process lifecycle (start, stop, cleanup)
\`\`\`

Key implementation details:
- Use \`tokio::process::Command\` for async subprocess management
- Parse Claude CLI's streaming JSON output format
- Use Tauri v2 events to stream response chunks to the frontend
- Support aborting an ongoing generation
- Handle errors gracefully (CLI not found, API errors, etc.)

## 2. Tauri Commands (src-tauri/src/main.rs or lib.rs)

Implement these Tauri commands:

\`\`\`rust
#[tauri::command]
async fn send_message(message: String, conversation_id: String, app: AppHandle) -> Result<(), String> {
    // 1. Find claude CLI
    // 2. Spawn claude process with: claude --print --output-format stream-json "{message}"
    //    For multi-turn, use: echo "..." | claude --continue {conversation_id} --output-format stream-json
    // 3. Read stdout line by line
    // 4. Emit "claude-response" events to frontend with content chunks
    // 5. Emit "claude-done" when complete
}

#[tauri::command]
async fn stop_generation(app: AppHandle) -> Result<(), String> {
    // Kill the running claude process
}

#[tauri::command]
async fn get_conversations() -> Result<Vec<Conversation>, String> {
    // List conversation history (could use claude --list-sessions or local storage)
}

#[tauri::command]
async fn check_claude_available() -> Result<ClaudeStatus, String> {
    // Check if claude CLI is available and return version info
}
\`\`\`

## 3. State Management

- Use \`tauri::State\` to manage shared state (active process, conversation list)
- Store conversations in a local JSON file or SQLite
- Track the currently running claude process for abort support

## 4. Configuration (src-tauri/tauri.conf.json)

- Set app title to "Agent CLI"
- Set window size to 1200x800
- Enable necessary Tauri permissions for shell/execute

## 5. Cargo.toml Dependencies

Make sure these are in Cargo.toml:
- tauri (with features you need)
- tauri-build
- tokio (full features)
- serde + serde_json
- uuid
- chrono
- anyhow/thiserror for error handling
- directories (for app data dir)

IMPORTANT:
- Use Tauri v2 API (not v1). In Tauri v2, commands use \`#[tauri::command]\` and are registered in \`Builder::new().invoke_handler()\`.
- The main entry point in Tauri v2 is typically \`src-tauri/src/lib.rs\` with a \`run()\` function, and \`src-tauri/src/main.rs\` calls \`lib::run()\`.
- For streaming, use \`app.emit("event-name", payload)\` to send events to the frontend.
- Make sure to register all commands in the builder.
- Verify the code compiles with \`cargo check\` in the src-tauri directory.

After implementing, run \`cargo check\` in src-tauri/ to verify compilation. Fix any errors.`, {
  label: 'backend-rust',
  phase: 'Backend',
})

log('Backend implementation complete')

// Phase 3: Frontend - React chat UI
phase('Frontend')

log('Building React chat UI with Claude-like interface...')

const frontendResult = await agent(`You are building the React frontend for a Tauri v2 desktop AI chat app in /Users/yunus/projects/agent-cli.

The Rust backend should already be implemented. Now build the complete chat UI.

## Architecture

Use these files:
- src/App.tsx - Main app layout
- src/components/ChatView.tsx - Chat conversation display
- src/components/MessageBubble.tsx - Individual message with markdown
- src/components/InputBar.tsx - Message input with send button
- src/components/Sidebar.tsx - Conversation list sidebar
- src/components/Settings.tsx - Settings panel
- src/hooks/useChat.ts - Chat logic hook (Tauri event handling)
- src/types.ts - TypeScript types
- src/main.tsx - Entry point (Tauri setup)
- src/index.css - Tailwind + custom styles

## 1. Types (src/types.ts)

\`\`\`typescript
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  status?: 'sending' | 'streaming' | 'done' | 'error';
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface ClaudeStatus {
  available: boolean;
  version?: string;
  path?: string;
}
\`\`\`

## 2. Main Entry (src/main.tsx)

\`\`\`typescript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Tauri v2 setup
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
\`\`\`

## 3. Chat Hook (src/hooks/useChat.ts)

Implement a React hook that:
- Manages conversations state (stored in localStorage)
- Calls \`invoke("send_message", { message, conversationId })\` to send messages
- Listens to Tauri events \`claude-response\` for streaming chunks
- Listens to \`claude-done\` for completion
- Handles \`invoke("stop_generation")\` for abort
- Auto-generates conversation titles from first message
- Supports creating/switching/deleting conversations

## 4. Chat View (src/components/ChatView.tsx)

Build a Claude-like chat interface:
- Scrolling message list (auto-scroll to bottom on new messages)
- User messages right-aligned with blue/gray background
- Assistant messages left-aligned with markdown rendering
- Typing indicator while streaming
- Welcome screen when no messages

## 5. Message Bubble (src/components/MessageBubble.tsx)

Each message renders with:
- ReactMarkdown for assistant messages with:
  - Syntax-highlighted code blocks (using react-syntax-highlighter with OneDark theme)
  - Proper table rendering
  - Link handling
  - Copy code button on code blocks
- Clean typography with proper spacing
- Timestamp display

## 6. Input Bar (src/components/InputBar.tsx)

- Auto-expanding textarea (min 1 line, max 8 lines)
- Send button (Enter to send, Shift+Enter for newline)
- Stop button when generating
- Disabled state when generating
- Character count hint

## 7. Sidebar (src/components/Sidebar.tsx)

- Conversation list with titles and timestamps
- "New Chat" button at top
- Delete conversation option
- Currently active conversation highlighted
- Collapsible on mobile/smaller screens
- Search/filter conversations

## 8. Settings (src/components/Settings.tsx)

- Claude CLI status check display
- System prompt configuration
- Theme toggle (dark/light)
- About section

## 9. App Layout (src/App.tsx)

- Sidebar on left (280px width)
- Main chat area with header + ChatView + InputBar
- Responsive layout
- Dark theme as default (Claude-like dark UI)

## 10. Styling (src/index.css)

Create a polished, Claude-like dark theme:
- Background: #1a1a2e or similar deep blue-black
- Message bubbles: subtle contrast
- Smooth animations for new messages
- Code blocks with dark theme
- Scrollbar styling
- Loading/streaming animation (dots or pulse)
- Tailwind CSS utility classes

## Design Principles
- Make it look like Claude's web interface (clean, minimal, professional)
- Smooth animations and transitions
- Good keyboard shortcuts (Ctrl+N for new chat, Escape to stop generation)
- Responsive and performant

IMPORTANT:
- Use Tauri v2 APIs: \`invoke\` from \`@tauri-apps/api/core\`, \`listen\` from \`@tauri-apps/api/event\`
- Make sure all imports are correct
- The code should be complete and working, not pseudo-code
- Use Tailwind CSS classes for styling
- Test that the frontend compiles: run \`pnpm build\` to verify

After implementing all files, run \`pnpm build\` to verify compilation. Fix any errors.`, {
  label: 'frontend-react',
  phase: 'Frontend',
})

log('Frontend implementation complete')

// Phase 4: Integration & Polish
phase('Integration')

log('Wiring up integration, fixing issues, and polishing...')

const integrationResult = await agent(`You are finalizing a Tauri v2 desktop AI chat app in /Users/yunus/projects/agent-cli.

The backend (Rust) and frontend (React) should be implemented. Your job is to integrate everything, fix issues, and polish.

## Tasks

### 1. Verify Project Structure
Check that the project has:
- src-tauri/ with Cargo.toml, src/main.rs, src/lib.rs (or src/main.rs only for Tauri v2)
- src/ with React components
- package.json with correct scripts
- tauri.conf.json properly configured

### 2. Fix Integration Issues

a) Ensure Tauri commands are properly registered:
   - Check src-tauri/src/main.rs (and lib.rs if exists)
   - All commands must be in the invoke_handler macro
   - In Tauri v2: \`tauri::Builder::default().invoke_handler(tauri::generate_handler![cmd1, cmd2, ...])\`

b) Ensure frontend correctly calls backend:
   - Check all invoke() calls match the Rust command names exactly
   - Event names must match between Rust emit() and JS listen()

c) Fix any Tauri v2 permission issues:
   - In Tauri v2, you need to configure capabilities/permissions
   - Check src-tauri/capabilities/ or tauri.conf.json for permissions
   - Need: shell:allow-execute, dialog permissions if used, etc.

### 3. Add Missing Features

a) Keyboard shortcuts:
   - Ctrl/Cmd+N: New conversation
   - Ctrl/Cmd+Shift+N: New conversation in new window
   - Escape: Stop generation
   - Ctrl/Cmd+,: Open settings

b) Window management:
   - Remember window size and position
   - Set minimum window size (800x600)

c) Error handling:
   - Show friendly error when Claude CLI is not found
   - Handle network errors gracefully
   - Show reconnection option

### 4. Build and Test

a) Run \`source "$HOME/.cargo/env" && pnpm tauri dev\` to test the app
b) Fix any compilation errors (Rust or TypeScript)
c) Fix any runtime errors

### 5. Final Polish

a) Add app icon (can use a simple placeholder)
b) Ensure the app looks good at different window sizes
c) Add a loading/splash state while checking Claude availability
d) Make sure the chat scrolling works smoothly

### 6. Add README.md

Create a README.md with:
- Project description
- Screenshots placeholder
- Installation instructions
- Usage instructions
- Development guide
- Architecture overview

IMPORTANT:
- Fix ALL compilation errors until the project builds cleanly
- Run \`cargo check\` in src-tauri/ to verify Rust code
- Run \`pnpm build\` to verify frontend code
- If possible, run \`pnpm tauri build --debug\` to create a debug build
- Report what works and what still needs attention`, {
  label: 'integration-polish',
  phase: 'Integration',
})

log('Integration complete')

// Return final summary
return {
  status: 'complete',
  summary: 'AI Chat Desktop App built with Tauri v2 + React + Claude CLI integration',
  phases: {
    setup: 'Rust installed, Tauri v2 project scaffolded',
    backend: 'Claude CLI subprocess integration with streaming support',
    frontend: 'Claude-like chat UI with React, Tailwind, Markdown rendering',
    integration: 'End-to-end wiring, error handling, keyboard shortcuts, polish',
  },
  toRun: 'cd /Users/yunus/projects/agent-cli && pnpm tauri dev',
}
