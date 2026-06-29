# HTTP 协议支持 - 快速修复指南

## ✅ 已完成修复

内置引擎现在**支持 HTTP 和 HTTPS 协议**，与 Claude Code CLI 保持一致。

## 🔄 主要变更

### 1. Cargo.toml 配置更新
```toml
# 之前：仅支持 HTTPS
reqwest = { version = "0.12", features = ["stream", "json", "rustls-tls"], default-features = false }

# 现在：支持 HTTP 和 HTTPS
reqwest = { version = "0.12", features = ["stream", "json", "native-tls"] }
```

### 2. 日志警告优化
```
[builtin] ⚠️  Using HTTP protocol: http://localhost:8080
[builtin] HTTP is insecure - API keys and data will be sent unencrypted
[builtin] Only use HTTP for local development/testing, never in production
[builtin] For production, always use HTTPS (https://localhost:8080)
```

## 🚀 使用 HTTP 协议

### 配置 HTTP 端点
```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:8080",
  "ANTHROPIC_API_KEY": "your-key"
}
```

### 或使用环境变量
```bash
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_API_KEY="your-key"
```

## ⚠️ 安全警告

### HTTP 协议的风险：
- ❌ API Key 明文传输
- ❌ 数据不加密
- ❌ 容易被拦截

### ✅ 推荐使用场景：
- 本地开发环境
- 测试环境
- 内网环境

### ❌ 不推荐：
- 生产环境（必须用 HTTPS）

## 🧪 测试验证

### 1. 重新编译
```bash
cd src-tauri
cargo build
```

### 2. 配置 HTTP 端点
```bash
export ANTHROPIC_BASE_URL="http://your-endpoint"
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
[builtin] ⚠️  Using HTTP protocol: http://your-endpoint
[builtin] HTTP is insecure - API keys and data will be sent unencrypted
[builtin] Only use HTTP for local development/testing, never in production
[builtin] For production, always use HTTPS (https://your-endpoint)
[builtin] new session: model=claude-sonnet-4-6, base_url=http://your-endpoint, cwd=...
```

## 📊 协议支持对比

| 协议 | 支持 | 使用场景 | 安全性 |
|-----|------|---------|--------|
| `https://` | ✅ | 生产环境（推荐） | ⭐⭐⭐⭐⭐ |
| `http://` | ✅ | 开发/测试 | ⭐（不安全） |

## 🔧 与 Claude Code 的一致性

现在内置引擎与 Claude Code CLI 完全一致：
- ✅ 支持 HTTP 协议
- ✅ 支持 HTTPS 协议
- ✅ 使用 native-tls 后端
- ✅ 相同的安全警告

## 📋 最佳实践

### 生产环境配置
```json
{
  "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
  "ANTHROPIC_API_KEY": "sk-ant-xxx"
}
```

### 开发环境配置
```json
{
  "ANTHROPIC_BASE_URL": "http://localhost:8080",
  "ANTHROPIC_API_KEY": "dev-key"
}
```

## 🔗 相关文档

- 完整协议说明：`docs/builtin_engine_protocol_support_updated.md`
- 迁移指南：`docs/add_http_protocol_support.md`

---

**重要**：HTTP 协议已支持，但请在生产环境始终使用 HTTPS！
