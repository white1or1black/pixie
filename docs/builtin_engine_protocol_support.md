# 内置引擎 URL 协议支持说明

## 📋 协���支持情况

### ✅ 支持的协议：HTTPS

内置引擎（通过 `pixie-pi` 库）**只支持 HTTPS 协议**，不支持 HTTP 协议。

### 🔧 技术原因

#### 1. **reqwest 库的 TLS 配置**
```toml
# src-tauri/Cargo.toml
reqwest = { version = "0.12", features = ["stream", "json", "rustls-tls"], default-features = false }

# pixie-pi/Cargo.toml
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls", "http2"] }
```

**关键点：**
- 使用 `rustls-tls` 特性，这是纯 Rust 实现的 TLS 后端
- 启用了 `http2` 特性
- `default-features = false` - 禁用了默认特性，只启用指定的特性

#### 2. **默认 API 端点**
```rust
// pixie-pi/src/ai/mod.rs
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
```

#### 3. **URL 构造逻辑**
```rust
// pixie-pi/src/ai/anthropic.rs
let url = format!("{}/v1/messages", model.base_url.trim_end_matches('/'));
let req = client.post(&url).headers(headers).json(&body);
```

## ⚠️ HTTP 协议不支持的原因

### 1. **安全考虑**
- Anthropic API 要求 HTTPS 连接
- API Key 需要通过加密通道传输
- 符合安全最佳实践

### 2. **TLS 后端限制**
使用 `rustls-tls` 意味着：
- 所有连接都强制使用 TLS/SSL
- 不支持明文 HTTP 连接
- 即使配置 `http://` URL，reqwest 也会尝试建立 TLS 连接

### 3. **API 要求**
Anthropic API 明确要求：
- 使用 HTTPS 协议
- 提供 TLS 1.2 或更高版本
- 使用有效的证书

## 🚫 使用 HTTP 会导致的问题

### 错误示例 1：连接被拒绝
```
[builtin] agent loop error: error sending request
[builtin] agent loop error: connection refused
```

### 错误示例 2：协议错误
```
[builtin] agent loop error: unknown scheme
[builtin] agent loop error: Invalid URI scheme
```

### 错误示例 3：TLS 握手失败
```
[builtin] agent loop error: TLS handshake failed
[builtin] agent loop error: invalid peer certificate
```

## ✅ 正确的配置方式

### 1. **使用 HTTPS**
```json
{
  "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
}
```

### 2. **自定义端点（必须 HTTPS）**
```json
{
  "ANTHROPIC_BASE_URL": "https://your-custom-endpoint.com"
}
```

### 3. **代理端点（必须 HTTPS）**
```json
{
  "ANTHROPIC_BASE_URL": "https://your-proxy.example.com/anthropic"
}
```

## 🔍 如何检测协议问题

### 检查日志中的 URL
```bash
# 查看实际使用的 URL
grep "\[builtin\] new session" ~/Library/Application\ Support/com.pixie.desktop/pixie.log

# 输出示例��
# [builtin] new session: model=claude-sonnet-4-6, base_url=http://api.anthropic.com, cwd=/Users/...
# ❌ 注意：如果是 http:// 就会出错！
```

### 检查连接错误
```bash
# 查看网络相关错误
grep -i "connection\|tls\|scheme" ~/Library/Application\ Support/com.pixie.desktop/pixie.log
```

## 🛠️ 修复 HTTP 配置问题

### 方法 1：修改环境变量
```bash
# 错误配置
export ANTHROPIC_BASE_URL="http://api.anthropic.com"

# 正确配置
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

### 方法 2：修改应用配置
```json
{
  "engine_model_configs": {
    "builtin": {
      "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
      "ANTHROPIC_API_KEY": "sk-ant-xxx"
    }
  }
}
```

### 方法 3：使用代码验证
在代码中添加 URL 验证：

```rust
// 在 src-tauri/src/engine/builtin/mod.rs 的 resolve_builtin_model 函数中添加
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
            // 验证 URL 协议
            if url.starts_with("http://") {
                log::warn!("[builtin] ⚠️  HTTP protocol detected, but only HTTPS is supported");
                log::warn!("[builtin] Please use HTTPS for ANTHROPIC_BASE_URL");
                log::warn!("[builtin] Attempting to use HTTP URL, but this will likely fail");
            }
            resolved.base_url = url.to_string();
        }
    }
    resolved
}
```

## 🌐 HTTPS 端口支持

虽然只支持 HTTPS，但可以使用非标准端口：

```json
{
  "ANTHROPIC_BASE_URL": "https://api.example.com:8443"
}
```

## 🔒 TLS 配置详情

### 支持的 TLS 版本
- TLS 1.2
- TLS 1.3

### 证书验证
- 使用 `rustls` 进行证书验证
- 依赖系统证书存储
- 不支持自签名证书（除非特殊配置）

### HTTP/2 支持
`pixie-pi` 启用了 HTTP/2：
```toml
features = ["json", "stream", "rustls-tls", "http2"]
```

## 🧪 测试连接

### 测试 HTTPS 连接
```bash
# 测试 Anthropic API
curl -v https://api.anthropic.com

# 测试自定义端点
curl -v https://your-custom-endpoint.com
```

### 测试 HTTP 连接（预期失败）
```bash
# 这会失败或被重定向
curl -v http://api.anthropic.com
```

## 📊 协议支持对比表

| 协议 | 支持 | 说明 |
|-----|------|------|
| `https://` | ✅ | 完全支持 |
| `http://` | ❌ | 不支持，会导致连接失败 |
| `https://` + 自定义端口 | ✅ | 支持，如 `https://api.example.com:8443` |
| `http://` + 自定义端口 | ❌ | 不支持 |

## 🎯 推荐配置

### 生产环境
```json
{
  "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
  "ANTHROPIC_API_KEY": "sk-ant-your-key-here"
}
```

### 开发/测试环境（如果支持）
```json
{
  "ANTHROPIC_BASE_URL": "https://test-api.example.com",
  "ANTHROPIC_API_KEY": "test-key-here"
}
```

### 代理环境
```json
{
  "ANTHROPIC_BASE_URL": "https://proxy.example.com/anthropic",
  "ANTHROPIC_API_KEY": "your-proxy-key-here"
}
```

## 🔗 相关代码位置

| 文件 | 位置 |
|-----|------|
| URL 构造 | `pixie-pi/src/ai/anthropic.rs:75` |
| 默认 URL | `pixie-pi/src/ai/mod.rs` |
| Model 定义 | `pixie-pi/src/ai/types.rs:318` |
| reqwest 配置 | `src-tauri/Cargo.toml` |
| 内置引擎 | `src-tauri/src/engine/builtin/mod.rs` |

## 📝 总结

1. **只支持 HTTPS 协议**
2. **使用 `rustls-tls` 作为 TLS 后端**
3. **不支持 HTTP 协议，配置会导致错误**
4. **Anthropic API 本身就要求 HTTPS**
5. **检查日志中的 `base_url` 配置是否正确**

如果你在日志中看到 `base_url=http://` 开头的配置，这就是问题的根源！
