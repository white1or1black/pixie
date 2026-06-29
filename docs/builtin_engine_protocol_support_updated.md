# 内置引擎 URL 协议支持说明

## 📋 协议支持情况

### ✅ 支持的协议：HTTP 和 HTTPS

内置引擎（通过 `pixie-pi` 库）**同时支持 HTTP 和 HTTPS 协议**，与 Claude Code CLI 保持一致。

### ⚠️ 安全警告

**HTTP 协议仅用于开发/测试环境，生产环境必须使用 HTTPS！**

## 🔧 技术实现

### 1. **reqwest 库配置**
```toml
# src-tauri/Cargo.toml (已更新)
reqwest = { version = "0.12", features = ["stream", "json", "native-tls"] }
```

**关键变更：**
- 从 `rustls-tls` 切换到 `native-tls`
- `native-tls` 支持 HTTP 和 HTTPS 协议
- 与 Claude Code CLI 保持一致

### 2. **URL 处理逻辑**
```rust
// pixie-pi/src/ai/anthropic.rs
let url = format!("{}/v1/messages", model.base_url.trim_end_matches('/'));
let req = client.post(&url).headers(headers).json(&body);
```

## ⚠️ HTTP 协议的安全风险

### 使用 HTTP 的风险：
1. **API Key 明文传输**：容易被拦截
2. **数据不加密**：请求和响应内容可见
3. **中间人攻击**：容易遭受数据篡改
4. **合规性问题**：不符合安全合规要求

### 什么时候可以使用 HTTP：
- ✅ 本地开发环境
- ✅ 本地测试环境
- ✅ 内网隔离环境
- ❌ 生产环境（必须用 HTTPS）

## ✅ 推荐配置

### 生产环境（必须 HTTPS）
```json
{
  "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
  "ANTHROPIC_API_KEY": "sk-ant-xxx"
}
```

### 开发/测试环境（可以用 HTTP）
```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:8080",
  "ANTHROPIC_API_KEY": "test-key"
}
```

### 自定义端点
```json
{
  "ANTHROPIC_BASE_URL": "http://your-proxy.example.com/anthropic",
  "ANTHROPIC_API_KEY": "your-key"
}
```

## 🔍 日志输出

### HTTP 协议警告
```
[builtin] ⚠️  Using HTTP protocol: http://localhost:8080
[builtin] HTTP is insecure - API keys and data will be sent unencrypted
[builtin] Only use HTTP for local development/testing, never in production
[builtin] For production, always use HTTPS (https://localhost:8080)
```

### HTTPS 协议确认
```
[builtin] ✅ Using HTTPS protocol: https://api.anthropic.com
[builtin] new session: model=claude-sonnet-4-6, base_url=https://api.anthropic.com, cwd=...
```

## 🛠️ 从 rustls-tls 迁移到 native-tls

### 为什么要切换？
1. **与 Claude Code 保持一致**：Claude Code 支持HTTP
2. **用户需求**：某些环境需要使用 HTTP
3. **兼容性**：`native-tls` 支持更广泛的场景

### 变更内容：
```toml
# 之前（仅支持 HTTPS）
reqwest = { version = "0.12", features = ["stream", "json", "rustls-tls"], default-features = false }

# 现在（支持 HTTP 和 HTTPS）
reqwest = { version = "0.12", features = ["stream", "json", "native-tls"] }
```

### TLS 后端对比：

| 特性 | rustls-tls | native-tls |
|-----|-----------|-------------|
| HTTP 支持 | ❌ 不支持 | ✅ 支持 |
| HTTPS 支持 | ✅ 支持 | ✅ 支持 |
| 依赖 | 纯 Rust | 系统 TLS 库 |
| 安全性 | 高 | 高（依赖系统） |
| 跨平台 | 优秀 | 优秀 |
| 与 Claude 一致 | ❌ | ✅ |

## 📊 协议支持对比表

| 协议 | 支持 | 使用场景 | 安全性 |
|-----|------|---------|--------|
| `https://` | ✅ | 生产环境 | ⭐⭐⭐⭐⭐ |
| `http://` | ✅ | 开发/测试 | ⭐（不安全） |
| `https://` + 自定义端口 | ✅ | 自定义端点 | ⭐⭐⭐⭐⭐ |
| `http://` + 自定义端口 | ✅ | 本地代理 | ⭐（不安全） |

## 🧪 测试 HTTP 支持

### 1. 编译新版本
```bash
cd src-tauri
cargo build
```

### 2. 配置 HTTP 端点
```bash
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_API_KEY="test-key"
```

### 3. 启动应用
```bash
pnpm tauri dev
```

### 4. 查看日志
```bash
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep "\[builtin\]"
```

### 5. 预期输出
```
[builtin] ⚠️  Using HTTP protocol: http://localhost:8080
[builtin] HTTP is insecure - API keys and data will be sent unencrypted
[builtin] Only use HTTP for local development/testing, never in production
[builtin] For production, always use HTTPS (https://localhost:8080)
[builtin] new session: model=claude-sonnet-4-6, base_url=http://localhost:8080, cwd=...
```

## 🔒 安全最佳实践

### 1. **默认使用 HTTPS**
```json
{
  "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
}
```

### 2. **仅在必要时使用 HTTP**
- 本地开发
- 内网环境
- 测试环境

### 3. **监控和审计**
- 检查日志中的协议使用
- 定期审计配置
- 生产环境强制 HTTPS

### 4. **环境隔离**
- 开发环境：可以使用 HTTP
- 预发环境：建议 HTTPS
- 生产环境：必须 HTTPS

## 🆘 故障排查

### HTTP 连接失败
```
[builtin] agent loop error: connection refused
```
**解决**：
1. 确认端点可访问
2. 检查防火墙设置
3. 验证 URL 正确性

### HTTPS 证书错误
```
[builtin] agent loop error: invalid peer certificate
```
**解决**：
1. 检查系统证书
2. 更新证书存储
3. 验证端点证书

### 混合使用问题
同时配置 HTTP 和 HTTPS 时，优先使用配置中的值。

## 📝 总结

1. **现在支持 HTTP 和 HTTPS**
2. **从 rustls-tls 切换到 native-tls**
3. **与 Claude Code CLI 保持一致**
4. **生产环境必须使用 HTTPS**
5. **开发/测试可以使用 HTTP，但有安全警告**
6. **日志中会明确提示协议类型和风险**

## 🔗 相关文件

| 文件 | 变更 |
|-----|------|
| `src-tauri/Cargo.toml` | 切换到 native-tls |
| `src-tauri/src/engine/builtin/mod.rs` | 更新协议检查逻辑 |
| `docs/builtin_engine_protocol_support.md` | 更新文档 |
| `docs/add_http_protocol_support.md` | 新增迁移指南 |

---

**重要**：虽然现在支持 HTTP，但请务必在非生产环境谨慎使用！
