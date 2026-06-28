# Pixie 调用 Claude Code 的完整命令清单

> 调研日期: 2026-06-28
> 分支: `feature/builtin-engine`
> 范围: Claude 引擎（`engine_id == "claude"`）实际启动 `claude` CLI 时使用的命令与参数
> 相关源码: `src-tauri/src/engine/claude.rs`、`src-tauri/src/engine/persistent.rs`、`src-tauri/src/engine/shared.rs`、`src-tauri/src/lib.rs`

## 1. 概述

Pixie 本身不内置模型，而是**spawn 外部 `claude` 进程、以 NDJSON 流式读取其输出**。Claude 引擎有两条执行路径：

| 路径 | 触发场景 | 实现位置 |
|---|---|---|
| **持久会话（persistent）** | 日常聊天（默认） | `persistent.rs` → `lib.rs:594` 派发 |
| **逐消息 spawn** | 备选/fallback（当前非默认） | `claude.rs:203` / `claude.rs:226` |

此外还有探测、登录、定时任务、版本查询等辅助命令。下文逐条列出。

## 2. 主聊天路径：持久会话（默认）

派发入口 `lib.rs:594` —— 当 `engine_id == "claude"`（或 `"codebuddy"`）时走持久会话。命令在
`persistent.rs:303 build_persistent_command`（`"claude"` 分支，`persistent.rs:314`）构建：

```bash
claude \
  --print \
  --output-format stream-json \
  --verbose \
  --input-format stream-json \
  --permission-mode bypassPermissions \
  [--session-id <id> | --resume <id>]
```

- 新会话：追加 `--session-id <conversation_id>`
- 续接（`is_continue`）：追加 `--resume <conversation_id>`

**关键点：**

- **`--verbose` 是必需的**（`claude.rs:118` 注释说明）。当前 Claude Code 拒绝 `--print` + `--output-format stream-json` 但不带 `--verbose`（报 "requires --verbose"）。持久会话用的是同一组合，所以也必须带。
- 进程**只启动一次**，之后多轮对话通过 **stdin** 写入 JSONL，不再重启进程、不再 `--resume` 重载历史。
- stdin / stdout 均为 `piped()`，stdin 保持打开；stderr 为 `null`（`persistent.rs:159`）。

### 2.1 后续消息（写入 stdin）

由 `persistent.rs:86 format_user_message` 拼装，`PersistentSession::send_message`（`persistent.rs:195`）写入：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"你的消息"}]}}
```

带图片时（png/jpg/jpeg/gif/webp，`persistent.rs:66 media_type_for_ext`），原生图片以 base64 嵌入为 `image` 内容块；不支持类型 / 读取失败则降级为 `@<path>` 文本块：

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"看这张图"},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}}
]}}
```

### 2.2 权限响应（写入 stdin）

当 CLI 发出 `permission_request` 事件时，集成方须通过 stdin 回复。由 `persistent.rs:126 format_permission_response` + `PersistentSession::respond_permission`（`persistent.rs:216`）写入：

```json
{"type":"permission_response","behavior":"allow"}
{"type":"permission_response","behavior":"deny","message":"<可选原因>"}
```

## 3. 就绪/鉴权探针（probe）

`claude.rs:122 spawn_probe` —— 一次性探活进程，最小参数 + 一个小 prompt `"ping"`，stderr 被捕获以便分类鉴权失败。**不带** `--session-id`（此轮是丢弃式的，不能污染持久会话表）：

```bash
claude --print --output-format stream-json --verbose --permission-mode bypassPermissions "ping"
```

## 4. 定时任务（headless，自动批准）

`claude.rs:251 spawn_headless` —— 用于调度器的无人值守任务，因无人在场审批，用 `--dangerously-skip-permissions`，并禁用 `AskUserQuestion`：

```bash
claude \
  --session-id <id> \
  --disallowedTools AskUserQuestion \
  --print \
  --output-format stream-json \
  --dangerously-skip-permissions \
  "<message>"
```

> 注意：headless 用的是 `--dangerously-skip-permissions`，而日常聊天用的是 `--permission-mode bypassPermissions`，两者不同。

## 5. 一键登录

`claude.rs:138 spawn_login` —— fire-and-forget，打开浏览器做 OAuth，用户完成后重新探活：

```bash
claude auth login
```

## 6. 版本探测

`claude.rs:29 get_claude_version`：

```bash
claude --version
```

## 7. 备选路径：逐消息 spawn（当前非默认）

`spawn_single`（`claude.rs:203`）/ `spawn_continue`（`claude.rs:226`）—— 每轮重新拉起进程。区别于持久会话：**不带** `--input-format stream-json` / `--verbose`，消息作为末尾位置参数传入；续接用 `--resume`：

```bash
# spawn_single（新会话）
claude --session-id <id> --print --output-format stream-json --permission-mode bypassPermissions "<message>"

# spawn_continue（续接）
claude --resume <id> --print --output-format stream-json --permission-mode bypassPermissions "<message>"
```

> 当前 Claude 默认不走此路径（持久会话已取代它），代码保留作 fallback。

## 8. 环境变量、工作目录与进程设置（所有路径通用）

由 `shared.rs` 处理：

### 8.1 二进制查找

`claude.rs:25 find_claude_binary` → `shared.rs:148 find_binary`。候选名为 `["claude"]`（`claude.rs:9`），在 PATH（OS 正确切分）+ 常见目录中查找：
- macOS/Linux: `/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`、`/snap/bin`、`~/.local/bin`、`~/.cursor/bin`、`~/.nvm/versions/node/*/bin`
- Windows: `%APPDATA%\npm`、`~/.local/bin`、`~/.cursor/bin`，匹配 `.exe/.cmd/.bat` 扩展名；`.cmd/.bat` 须经 `cmd.exe /c` 运行（`shared.rs:180 engine_command`）

### 8.2 环境变量

`shared.rs:247 collect_env`，合并**进程 env** 与**登录 shell env**（`$SHELL -i -l -c env`，`shared.rs:17`），再按规则过滤：

- **前缀匹配**（`claude.rs:11 ENV_PREFIXES`）：`ANTHROPIC_`、`CLAUDE`、`AWS_`、`GOOGLE_`、`VERTEX_`、`OPENAI_`、`AZURE_`
- **精确匹配**（`shared.rs:6 ENV_EXACT`）：`HOME`、`USER`、`LANG`、`LC_ALL`、`TERM`、`TMPDIR`、`NODE_EXTRA_CA_CERTS`、`PATH`
- Unix 下 PATH 末尾补 `/usr/local/bin`、`/opt/homebrew/bin`、`/opt/homebrew/sbin`（`shared.rs:195 extend_path`）
- 引擎模型配置覆盖（`shared.rs:81`）也会合并进 env

### 8.3 模型覆盖

会话级模型通过 **`ANTHROPIC_MODEL` 环境变量**注入，优先级高于同名环境变量：
- 持久会话：`persistent.rs:334`
- 逐消息 spawn：`claude.rs:174`
- 模型变更会触发持久会话 kill + 重启（`lib.rs:615`，模型在 spawn 时烘焙进会话）

### 8.4 工作目录

`cwd` = 当前活动 workspace（`lib.rs:663` 透传 `workspace_owned`）。

### 8.5 脱离控制终端

Unix 下 `shared.rs:229 detach_from_controlling_terminal` 在 `pre_exec` 中调用 `setsid()`。原因（注释）：从终端启动 Pixie 时，子进程会继承控制终端，作为后台进程做 tty I/O 时被 SIGTTOU/SIGTTIN 反复 stop，导致永不退出但 stdout 管道不关，`read_persistent_turn` 永久阻塞、回合卡在 "Streaming…"。`setsid()` 丢掉控制终端使 CLI 完全 headless 运行。

### 8.6 会话生命周期

持久会话存于 `AppState.sessions`（`lib.rs:607`），上限 `MAX_SESSIONS = 10`（LRU 淘汰），空闲 `IDLE_TIMEOUT = 30 min` 后关闭（`persistent.rs:27` / `persistent.rs:30`），后台每 60s 巡检。PID 注册到 `AppState.kill_registry`（`lib.rs:687`），供 `stop_generation` 通过 PID 杀进程，避免与流读取锁竞争。

## 9. 流式输出 → 前端事件映射

CLI 输出 `stream-json` 每行由 `claude.rs:675 parse_line` 解析为若干 `NormalizedEvent`，再经 `lib.rs::emit_agent_events` 转成统一 `agent-*` Tauri 事件。持久会话的回合读取器在 `persistent.rs:381 read_persistent_turn`：逐行读 stdout，直到收到 `result`（`NormalizedEvent::Final`）或 `error` 事件即一回合结束。

## 10. 速查（最常用的一条）

```bash
claude --print --verbose \
  --output-format stream-json \
  --input-format stream-json \
  --permission-mode bypassPermissions \
  --session-id <conversation_id>
# 之后多轮：往 stdin 写 JSONL {"type":"user",...}
```
