# 内置引擎跨平台问题排查指南

## 问题概述
内置引擎（builtin engine）在 macOS x86 平台上直接异常返回，需要根据日志排查问题。

## 跨平台支持情况

### ✅ 支持的平台
内置引擎（`pixie-pi` 库）是 **纯 Rust 实现**，理论上支持所有平台：
- ✅ macOS (ARM64 和 x86_64)
- ✅ Linux
- ✅ Windows

### ⚠️ 潜在的跨平台问题
虽然 Rust 代码跨平台，但可能存在以下问题：

#### 1. **网络请求相关**
内置引擎通过 `reqwest` 库发送 HTTP 请求到 Anthropic API：
```rust
// src-tauri/Cargo.toml
reqwest = { version = "0.12", features = ["stream", "json", "rustls-tls"], default-features = false }
```

**可能的问题：**
- TLS 后端选择：使用 `rustls-tls` 而非 `native-tls`，在某些平台上可能有兼容性问题
- HTTPS 证书验证问题
- 代理设置未正确传递

#### 2. **平台特定代码**
检查 `src-tauri/src/engine/shared.rs` 中的平台判断：
```rust
// Windows 特定处理
if cfg!(windows) {
    // ...
}

// Unix 特定处理
#[cfg(unix)]
pub fn detach_from_controlling_terminal(cmd: &mut tokio::process::Command) {
    // 调用 libc::setsid()
}
```

#### 3. **环境变量和路径**
```rust
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))  // Windows
        .map(PathBuf::from)
}
```

## 日志配置和位置

### 日志配置
应用启动时会配置日志输出（见 `src-tauri/src/lib.rs`）：

```rust
// 日志输出位置
let mut targets: Vec<tauri_plugin_log::Target> = Vec::new();

// 1. 文件日志（始终启用）
targets.push(tauri_plugin_log::Target::new(
    tauri_plugin_log::TargetKind::Folder {
        path: log_dir,  // 数据目录
        file_name: Some("pixie".to_string()),
    },
));

// 2. 控制台日志（仅 debug 模式）
if cfg!(debug_assertions) {
    targets.push(tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::Stdout,
    ));
}
```

### 日志文件位置
日志文件位置取决于操作系统：

#### macOS
```
~/Library/Application Support/com.pixie.desktop/pixie.log
```

#### Linux
```
~/.config/pixie/pixie.log
```

#### Windows
```
%APPDATA%\pixie\pixie.log
```

### 日志轮转策略
- **最大文件大小：** 5 MB
- **保留策略：** 保留最近 3 个日志文件
- **文件命名：** `pixie.log`, `pixie.log.1`, `pixie.log.2`

## 排查步骤

### 1. 查看日志文件
```bash
# macOS
cat ~/Library/Application\ Support/com.pixie.desktop/pixie.log

# Linux
cat ~/.config/pixie/pixie.log

# Windows (PowerShell)
Get-Content $env:APPDATA\pixie\pixie.log
```

### 2. 关键日志标识
查找以下关键日志来定位问题：

#### 内置引擎初始化
```log
[builtin] new session: model=xxx, base_url=xxx, cwd=xxx
[builtin] using API key from builtin config
[builtin] using API key from claude config
[builtin] using API key from ANTHROPIC_API_KEY env var
[builtin] no API key found: checked builtin config, claude config, and ANTHROPIC_API_KEY env var
```

#### 运行时日志
```log
[builtin] turn finished: final_text_len=xxx, had_error=true/false
[builtin] agent loop error: <error message>
[startup] logging to <path>
```

### 3. 常见错误模式

#### ❌ API Key 未配置
```log
[builtin] no API key found: checked builtin config, claude config, and ANTHROPIC_API_KEY env var
```

**解决方案：**
```bash
# 设置环境变量
export ANTHROPIC_API_KEY="sk-ant-xxx"

# 或在应用设置中配置
```

#### ❌ 网络连接错误
```log
[builtin] agent loop error: error sending request
[builtin] agent loop error: connection error
```

**排查步骤：**
1. 检查网络连接
2. 检查代理设置（如果使用）
3. 检查防火墙设置
4. 尝试手动访问 API endpoint

#### ❌ TLS/SSL 错误
```log
[builtin] agent loop error: invalid peer certificate
[builtin] agent loop error: unknown certificate authority
```

**解决方案：**
这可能是 `rustls-tls` 在某些平台上的兼容性问题，考虑：
1. 更新系统证书存储
2. 如果是 macOS x86，检查证书是否过期
3. 考虑切换到 `native-tls`（需要修改 Cargo.toml）

#### ❌ 平台特定错误
```log
Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }
```

**检查：**
1. 工作目录是否存在
2. 相关的路径配置是否正确

### 4. 启用详细日志

#### 修改日志级别
编辑 `src-tauri/src/lib.rs`，将日志级别改为 Debug：

```rust
tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Debug)  // 改为 Debug
    .targets(targets)
    // ...
```

#### 添加自定义日志
在 `src-tauri/src/engine/builtin/mod.rs` 中添加更多日志：

```rust
pub async fn run_turn(
    &mut self,
    message: &str,
    _images: &[String],
    mut emit: impl FnMut(NormalizedEvent),
) -> Result<(String, bool)> {
    log::debug!("[builtin] starting turn with message: {}", message);
    log::debug!("[builtin] current platform: {}", std::env::consts::OS);
    log::debug!("[builtin] arch: {}", std::env::consts::ARCH);

    // ... 现有代码
}
```

### 5. 平台检测日志

添加平台检测代码以确认运行环境：

```rust
// 在 builtin::run_turn 开始处添加
log::info!("[builtin] platform: {}-{}", std::env::consts::OS, std::env::consts::ARCH);
log::info!("[builtin] target triple: {}", std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string()));
```

### 6. 测试 API 连接

创建简单的测试来验证网络连接：

```rust
// 在 builtin 模块中添加测试函数
pub async fn test_api_connection(base_url: &str, api_key: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/v1/messages", base_url);

    log::info!("[builtin] testing connection to: {}", url);

    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "claude-sonnet-4-6",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "test"}]
        }))
        .send()
        .await;

    match resp {
        Ok(r) => {
            log::info!("[builtin] API response status: {}", r.status());
            Ok(())
        }
        Err(e) => {
            log::error!("[builtin] API connection failed: {}", e);
            Err(e.into())
        }
    }
}
```

### 7. 检查依赖库问题

内置引擎依赖 `pixie-pi` 库，检查其跨平台兼容性：

```bash
# 查看 pixie-pi 的依赖
cd src-tauri
cargo tree -p pixie-pi
```

### 8. macOS x86 特定检查

对于 macOS x86_64 平台，额外检查：

```bash
# 检查架构
uname -m  # 应该输出 x86_64

# 检查 Rust 工具链
rustc --version
rustup show

# 检查是否为正确的编译目标
rustup target list | grep installed
```

## 快速诊断命令

```bash
# 1. 查看最近的错误日志
tail -50 ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep -i error

# 2. 查看内置引擎相关日志
tail -100 ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep "\[builtin\]"

# 3. 查看启动日志
head -50 ~/Library/Application\ Support/com.pixie.desktop/pixie.log

# 4. 实时监控日志
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log
```

## 推荐的诊断流程

1. **第一步：检查日志文件是否存在和可访问**
   ```bash
   ls -la ~/Library/Application\ Support/com.pixie.desktop/
   ```

2. **第二步：查看最近的内置引擎日志**
   ```bash
   grep "\[builtin\]" ~/Library/Application\ Support/com.pixie.desktop/pixie.log | tail -20
   ```

3. **第三步：检查 API Key 配置**
   ```bash
   grep "API key" ~/Library/Application\ Support/com.pixie.desktop/pixie.log
   ```

4. **第四步：查看是否有网络或 TLS 错误**
   ```bash
   grep -i "connection\|tls\|certificate\|error" ~/Library/Application\ Support/com.pixie.desktop/pixie.log | tail -10
   ```

5. **第五步：如果是 release 版本，考虑重新编译为 debug 版本获取更详细日志**
   ```bash
   cd src-tauri
   cargo build
   ```

## 需要提供给开发者的问题报告模板

```
**环境信息：**
- 操作系统：macOS x86_64
- macOS 版本：
- Rust 版本：
- Pixie 版本：0.8.0-beta.3

**问题描述：**
内置引擎在 macOS x86 上直接异常返回

**日志内容：**
（粘贴 pixie.log 中的相关日志，特别是 [builtin] 标记的行）

**错误信息：**
（具体的错误消息）

**复现步骤：**
1. ...
2. ...
```

## 相关代码位置

- **内置引擎实现：** `src-tauri/src/engine/builtin/mod.rs`
- **平台相关代码：** `src-tauri/src/engine/shared.rs`
- **日志配置：** `src-tauri/src/lib.rs` （搜索 `tauri_plugin_log`）
- **依赖配置：** `src-tauri/Cargo.toml` （搜索 `pixie-pi` 和 `reqwest`）
