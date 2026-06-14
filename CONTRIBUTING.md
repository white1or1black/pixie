# Contributing to Pixie

Thanks for your interest in improving Pixie! This is a small, approachable
codebase — a React/TypeScript frontend and a Rust (Tauri v2) backend that drives
the Claude Code CLI. This guide gets you set up and explains the conventions.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- A [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- The [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed
  and authenticated (`claude --version` must work on your `PATH`)

## Getting started

```bash
git clone https://github.com/white1or1black/pixie.git
cd pixie
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` launches the full app with hot reload. In debug builds the Rust
backend logs at the `info` level, which is invaluable when debugging streaming or
scheduling behavior.

## Project layout

See the [README](README.md#project-structure) for the full map. In short:

- `src/` — React frontend. Components in `src/components/`, state in `src/hooks/`,
  shared types in `src/types.ts`.
- `src-tauri/src/` — Rust backend. `claude.rs` owns CLI process + stream parsing,
  `pty.rs` owns terminals, `lib.rs` wires up Tauri commands, the scheduler, and the
  system tray.

## Code style

**Frontend**
```bash
pnpm lint
```
Match the existing style: functional components, Tailwind utility classes,
CSS variables for theming (`var(--bg-primary)` etc.), typed props.

**Backend**
```bash
cd src-tauri
cargo fmt
cargo clippy -- -D warnings
cargo test
```
Keep `unsafe` out of new code, prefer `anyhow` for fallible operations, and use
`tokio` for async subprocess work.

## Adding a Tauri command

Pixie keeps IPC typed end-to-end. To add a command:

1. **Rust** — write a `#[tauri::command] async fn ...` in `src-tauri/src/lib.rs`,
   register it in the `invoke_handler!` list at the bottom of `run()`, and use
   `serde`-derive structs for anything non-trivial.
2. **TypeScript** — mirror the payload as an interface in `src/types.ts`, then call
   it from a hook with `invoke<ReturnType>("command_name", { args })`.
3. **Events** — if the command streams progress, emit typed events with
   `app.emit(...)` and subscribe in a hook with `listen(...)`.

## Pull requests

1. Fork and branch from `main`.
2. Keep commits focused; small PRs review faster.
3. Fill in the PR template (what changed, why, how to test).
4. Make sure `pnpm lint`, `cargo fmt`, `cargo clippy`, and `cargo test` pass.

## Reporting bugs

Use the GitHub issue templates. The most useful bug reports include:

- OS and Pixie version
- Output of `claude --version`
- Exact reproduction steps
- Relevant logs (run `pnpm tauri dev` and copy the backend output)

## Security

Pixie runs Claude Code with `--dangerously-skip-permissions`, so the agent can
read/modify files and run commands in the active workspace without prompts. If
you find a way for the agent to escape the selected workspace or otherwise act
outside the user's intent, please report it privately rather than in a public
issue — see the repo's security policy or contact the maintainers directly.

## License

By contributing, you agree your contributions will be licensed under the
[MIT License](LICENSE).
