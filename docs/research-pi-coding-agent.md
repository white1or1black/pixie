# Pi Coding Agent 调研报告

> 调研日期: 2026-06-22
> 仓库: https://github.com/earendil-works/pi
> 许可证: MIT
> 版本: v0.79.9

## 1. 项目概览

Pi 是一个开源 AI Agent 工具包，采用 TypeScript monorepo 架构，包含 4 个核心包：

| 包 | 职责 |
|---|---|
| `packages/ai` | 统一 LLM API 抽象层 — 多 provider 流式调用 |
| `packages/agent` | Agent Loop 核心 — tool calling 循环 |
| `packages/coding-agent` | 编码场景特化 — tools、system prompt、session 管理 |
| `packages/tui` | 终端 UI |

## 2. 核心架构

### 2.1 `packages/ai` — LLM API 抽象层

**类型系统** (`types.ts`):
- `Model<TApi>` — 统一模型定义，泛型参数约束 API 类型
- `KnownApi` — 支持的 API 协议: `anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`, `bedrock-converse-stream` 等
- `Message` — 三种消息类型: `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- `AssistantMessage.content` — 支持 `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall`
- `AssistantMessageEvent` — 细粒度流式事件: `text_start/delta/end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done`, `error`

**Anthropic Provider** (`providers/anthropic.ts`, ~800行):
- 自实现 SSE 解码器（不依赖 SDK streaming），直接解析 `ReadableStream`
- 支持 4 种认证模式: API Key, OAuth (Claude Code), GitHub Copilot, Cloudflare Gateway
- 支持 prompt caching（`cache_control: ephemeral`），短缓存/长缓存（1h TTL）
- 支持 thinking: 两种模式
  - **Adaptive thinking** (新模型): `thinking.type: "adaptive"` + `output_config.effort`
  - **Budget-based thinking** (旧模型): `thinking.type: "enabled"` + `budget_tokens`
- 支持 `eager_input_streaming` 或 fallback 到 `fine-grained-tool-streaming-2025-05-14` beta header
- Claude Code 隐身模式: OAuth token 时自动映射 tool 名为 Claude Code 标准名

**关键流式调用链**:
```
streamSimple(model, context, options)
  → resolveApiProvider(model.api)
  → provider.streamSimple(model, context, options)
    → (Anthropic) streamAnthropic()
      → createClient() → Anthropic SDK client
      → buildParams() → MessageCreateParamsStreaming
      → client.messages.create({stream: true})
      → iterateAnthropicEvents(response)  // 自实现 SSE decoder
      → emit AssistantMessageEvent into EventStream
```

### 2.2 `packages/agent` — Agent Loop

**核心循环** (`agent-loop.ts`, ~520行):

```
agentLoop(prompts, context, config)
  → runAgentLoop()
    → emit("agent_start")
    → runLoop()  ← 主循环
      while (true):                              ← 外层: follow-up 消息
        while (hasMoreToolCalls || pendingMsgs):  ← 内层: tool calls
          1. 处理 pending/steering 消息
          2. streamAssistantResponse()            ← LLM 调用
          3. executeToolCalls()                   ← 执行 tools
          4. 将 tool results 加入 context
          5. prepareNextTurn() / shouldStopAfterTurn()
        检查 follow-up 消息, 没有则退出
      emit("agent_end")
```

**关键设计**:
- **双循环结构**: 外层处理 follow-up 消息队列，内层处理 tool calling 循环
- **Steering messages**: 用户在 agent 运行中可以插入转向消息
- **Tool 执行模式**: 支持 parallel（默认）和 sequential 两种
- **Hook 系统**: `beforeToolCall`, `afterToolCall`, `prepareNextTurn`, `shouldStopAfterTurn`
- **abort 支持**: 全链路 `AbortSignal` 传递

### 2.3 `packages/coding-agent` — 编码场景特化

**7 个核心 Tools**:

| Tool | 文件 | 功能 |
|------|------|------|
| `read` | `read.ts` | 读取文件内容 |
| `write` | `write.ts` | 写入文件 |
| `edit` | `edit.ts` | 编辑文件（差异替换） |
| `bash` | `bash.ts` | 执行 shell 命令 |
| `grep` | `grep.ts` | 内容搜索 |
| `find` | `find.ts` | 文件查找 |
| `ls` | `ls.ts` | 目录列表 |

**Tool 组织方式**:
- 每个 tool 有两个函数: `createXxxToolDefinition(cwd, options)` 和 `createXxxTool(cwd, options)`
- Definition 只包含 schema（发给 LLM），Tool 还包含 execute 实现
- 预设组合: `createCodingToolDefinitions` (read/bash/edit/write), `createReadOnlyToolDefinitions` (read/grep/find/ls)

**Session 管理** (`agent-session.ts`, 非常大):
- `AgentSession` 类管理完整会话生命周期
- 支持 model 切换、thinking level 切换
- 支持 compaction（上下文压缩）
- 支持 extension 系统
- 支持 prompt templates 和 skills

## 3. 可借鉴的设计

### 3.1 高价值借鉴

1. **EventStream 模式** — 统一的流式事件协议，`AssistantMessageEvent` 细粒度事件对前端渲染非常友好
2. **Agent Loop 双循环** — 外层 follow-up + 内层 tool-calling，优雅处理多轮交互
3. **Tool 抽象** — `ToolDefinition`（schema）和 `Tool`（schema + execute）分离，tool 可组合
4. **Anthropic SSE 解码** — 自实现比 SDK 更可控，适合 Rust 移植
5. **Cache Control** — prompt caching 的 `cache_control: ephemeral` + TTL 支持

### 3.2 不需要借鉴的

1. **TypeScript 生态依赖** — 我们用 Rust，不需要 npm/undici 那套
2. **Claude Code 隐身模式** — 我们不是伪装 Claude Code
3. **多 provider 抽象** — Beta 阶段只需支持 Anthropic 协议
4. **Extension 系统** — 太重，Beta 不需要
5. **OAuth 流程** — Beta 用 API Key 即可

## 4. 对 Pixie 内置 Engine 的启示

### 4.1 Rust 实现映射

| Pi (TypeScript) | Pixie 内置 Engine (Rust) |
|---|---|
| `packages/ai` types + anthropic provider | `engine/builtin/` — Anthropic Messages API HTTP client |
| `packages/agent` agent-loop | `engine/builtin/agent_loop.rs` — tool calling 循环 |
| `packages/coding-agent` tools | `engine/builtin/tools/` — 通用 tool 实现 |
| `AssistantMessageEvent` | 复用现有 `NormalizedEvent` |

### 4.2 关键差异

- **Pi 是 TypeScript 进程内调用**，Pixie 是 Rust 直接 HTTP → 无需 CLI 中间层
- **Pi 的 EventStream 是 TypeScript AsyncGenerator**，Pixie 需要 Rust channel/generator
- **Pi 的 tool execute 是 async function**，Pixie 需要 Rust trait + tokio spawn

### 4.3 建议的通用 Tool Set（非编码导向）

| Tool | 用途 | 说明 |
|------|------|------|
| `read_file` | 读取文件 | 通用，不仅限代码 |
| `write_file` | 写入文件 | 通用 |
| `list_directory` | 目录列表 | 通用 |
| `search_files` | 文件搜索 | find/grep 合一 |
| `shell` | 执行命令 | 通用 shell |
| `edit_file` | 差异编辑文件 | 保留编码能力，通用场景也能用（改配置等） |
| `web_fetch` | 获取网页 | 通用场景高频需求 |
| `note` | 记录笔记 | 通用知识管理 |

保留了 `edit`（差异编辑），虽然偏编码特化，但通用场景也常用（改配置文件、修 YAML 等），完全去掉会导致编码能力断崖。
