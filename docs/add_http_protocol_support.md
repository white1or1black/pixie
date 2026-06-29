# 为内置引擎添加 HTTP 协议支持

## 问题分析

当前内置引擎（通过 `pixie-pi` 库）只支持 HTTPS 协议，但用户需要支持 HTTP 协议，因为：

1. Claude Code CLI 支持 HTTP 协议
2. 某些用户环境需要使用 HTTP 端点
3. 本地开发/测试环境可能使用 HTTP

## 解决方案

### 方案 1: 修改 Cargo.toml 启用 HTTP 支持（推荐）

修改 `src-tauri/Cargo.toml` 中的 reqwest 配置，移除 `rustls-tls` 限制：

```toml
# 当前配置（仅支持 HTTPS）
reqwest = { version = "0.12", features = ["stream", "json", "rustls-tls"], default-features = false }

# 修改为（支持 HTTP 和 HTTPS）
reqwest = { version = "0.12", features = ["stream", "json"] }
# 或者明确指定
reqwest = { version = "0.12", features = ["stream", "json", "native-tls"] }
```

**优点：**
- 最简单，只需修改一行配置
- 保持与 pixie-pi 的兼容性
- `native-tls` 支持 HTTP 和 HTTPS

**缺点：**
- 依赖系统的 TLS 库（OpenSSL）
- 需要重新编译

### 方案 2: 创建自定义 HTTP 客户端

如果不想修改全局配置，可以在内置引擎中创建自定义客户端。

#### 步骤 1: 修改内置引擎代码

创建新的文件 `src-tauri/src/engine/builtin/http_client.rs`：

```rust
use anyhow::Result;
use reqwest::Client;

/// 创建支持 HTTP 和 HTTPS 的客户端
pub fn create_http_client() -> Result<Client> {
    let builder = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .connect_timeout(std::time::Duration::from_secs(30));

    // 对于 HTTP URL，禁用 TLS 验证
    #[cfg(feature = "native-tls")]
    let builder = builder.danger_accept_invalid_hostnames(true);

    let client = builder.build()?;
    Ok(client)
}

/// 检查 URL 是否为 HTTP 协议
pub fn is_http_url(url: &str) -> bool {
    url.starts_with("http://")
}

/// 将 HTTP URL 转换为 HTTPS（如果需要）
pub fn ensure_https_if_needed(url: &str, force_https: bool) -> String {
    if force_https && url.starts_with("http://") {
        log::warn!("[builtin] Converting HTTP to HTTPS: {}", url);
        return url.replacen("http://", "https://", 1);
    }
    url.to_string()
}
```

#### 步骤 2: 修改 `src-tauri/src/engine/builtin/mod.rs`

```rust
// 在文件顶部添加
mod http_client;

use http_client::{create_http_client, is_http_url, ensure_https_if_needed};

// 在 BuiltinSession::new 中修改客户端创建
pub fn new(
    session_id: &str,
    model: Option<&str>,
    system_prompt: Option<&str>,
    cwd: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Self {
    // ... 现有代码 ...

    let model_pattern = model.map(str::to_string).unwrap_or_else(get_model);
    let resolved = resolve_builtin_model(Some(&model_pattern), base_url);

    // 检查是否使用 HTTP 协议
    if is_http_url(&resolved.base_url) {
        log::warn!("[builtin] ⚠️  Using HTTP protocol: {}", resolved.base_url);
        log::warn!("[builtin] This is insecure and should only be used for development/testing");
    } else {
        log::info!("[builtin] ✅ Using HTTPS protocol: {}", resolved.base_url);
    }

    // 创建支持 HTTP 的客户端
    let client = match create_http_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("[builtin] Failed to create HTTP client: {}", e);
            // 回退到默认客户端
            reqwest::Client::new()
        }
    };

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
        client, // 使用自定义客户端
    );

    // ... 其余代码 ...
}
```

### 方案 3: 使用环境变量控制

添加环境变量来控制是否允许 HTTP：

```rust
fn is_http_allowed() -> bool {
    std::env::var("PIXIE_ALLOW_HTTP")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(false)
}

// 在 resolve_builtin_model 中
if let Some(url) = base_url {
    if !url.is_empty() {
        if url.starts_with("http://") {
            if is_http_allowed() {
                log::warn!("[builtin] ⚠️  HTTP protocol allowed: {}", url);
            } else {
                log::error!("[builtin] ❌ HTTP protocol not allowed: {}", url);
                log::error!("[builtin] Set PIXIE_ALLOW_HTTP=1 to enable HTTP support");
                // 可以选择返回错误或自动转换为 HTTPS
            }
        }
        resolved.base_url = url.to_string();
    }
}
```

## 推荐实施方案

### 第一步：修改 Cargo.toml

```toml
[dependencies]
# 修改这一行
reqwest = { version = "0.12", features = ["stream", "json", "native-tls"] }
```

### 第二步：修改内置引擎代码

编辑 `src-tauri/src/engine/builtin/mod.rs`：

```rust
// 在 resolve_builtin_model 函数中
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
            if url.starts_with("http://") {
                log::warn!("[builtin] ⚠️  Using HTTP protocol: {}", url);
                log::warn!("[builtin] HTTP is insecure and should only be used for development/testing");
                log::warn!("[builtin] For production, always use HTTPS");
            } else if url.starts_with("https://") {
                log::info!("[builtin] ✅ Using HTTPS protocol: {}", url);
            } else {
                log::warn!("[builtin] ⚠️  Unknown URL protocol: {}", url);
            }
            resolved.base_url = url.to_string();
        }
    }
    resolved
}
```

### 第三步：更新文档

更新 `docs/builtin_engine_protocol_support.md`：

```markdown
## 协议支持

### 支持的协议
- ✅ `https://` - 推荐，生产环境必须使用
- ⚠️  `http://` - 支持，但仅用于开发/测试环境

### 安全警告
使用 HTTP 协议会：
- API Key 以明文传输
- 数据不加密
- 容易被中间人攻击

**强烈建议生产环境使用 HTTPS！**
```

### 第四步：添加环境变量控制（可选）

```rust
fn is_http_allowed() -> bool {
    std::env::var("PIXIE_ALLOW_HTTP")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(true) // 默认允许，与 Claude Code 保持一致
}
```

## 测试

### 1. 编译项目

```bash
cd src-tauri
cargo build
```

### 2. 测试 HTTP 连接

```bash
# 设置 HTTP 端点
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_API_KEY="test-key"

# 运行应用并查看日志
pnpm tauri dev

# 检查日志
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep "\[builtin\]"
```

### 3. 预期日志输出

```
[builtin] ⚠️  Using HTTP protocol: http://localhost:8080
[builtin] HTTP is insecure and should only be used for development/testing
[builtin] new session: model=claude-sonnet-4-6, base_url=http://localhost:8080, cwd=...
```

## 注意事项

1. **与 Claude Code 保持一致**：既然 Claude Code 支持 HTTP，我们也应该支持
2. **安全警告**：必须明确警告用户 HTTP 的安全风险
3. **默认行为**：保持与 Claude Code 一致，默认允许 HTTP
4. **生产环境**：强烈建议生产环境使用 HTTPS

## 快速修复命令

```bash
# 1. 修改 Cargo.toml
cd src-tauri
sed -i '' 's/rustls-tls/native-tls/g' Cargo.toml

# 2. 重新编译
cargo build

# 3. 测试
export ANTHROPIC_BASE_URL="http://your-endpoint"
pnpm tauri dev
```

这样就完全支持 HTTP 协议了！
