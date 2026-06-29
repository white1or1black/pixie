# URL 协议问题快速修复指南

## 🚨 问题诊断

### 你可能遇到的问题：
```
内置引擎在 macOS x86 上直接异常返回
```

### 最常见原因：**使用了 HTTP 协议而不是 HTTPS**

## 🔍 立即检查

### 运行检查脚本
```bash
./scripts/check_url_protocol.sh
```

### 快速手动检查
```bash
# 查看日志中的 base_url
grep "\[builtin\] new session" ~/Library/Application\ Support/com.pixie.desktop/pixie.log | tail -3

# 输出示例：
# [builtin] new session: model=..., base_url=http://api.anthropic.com, ...
#                                        ^^^^^^ 问题！应该是 https://
```

## ✅ 修复方法

### 方法 1：修改环境变量（最简单）
```bash
# 设置正确的 HTTPS URL
export ANTHROPIC_BASE_URL="https://api.anthropic.com"

# 重启应用
```

### 方法 2：修改配置文件
```bash
# 编辑配置文件
nano ~/Library/Application\ Support/com.pixie.desktop/config.json

# 找到这一行：
"ANTHROPIC_BASE_URL": "http://api.anthropic.com"

# 改为：
"ANTHROPIC_BASE_URL": "https://api.anthropic.com"
```

### 方法 3：在应用内配置
1. 打开 Pixie
2. 进入 Settings -> Engine Model Configs
3. 设置 `ANTHROPIC_BASE_URL` 为 `https://api.anthropic.com`

## 🔍 验证修复

### 1. 重启应用
完全退出并重新启动 Pixie

### 2. 检查日志
```bash
tail -f ~/Library/Application\ Support/com.pixie.desktop/pixie.log | grep "\[builtin\]"
```

**预期输出：**
```
[builtin] ✅ Using HTTPS protocol: https://api.anthropic.com
[builtin] new session: model=claude-sonnet-4-6, base_url=https://api.anthropic.com, cwd=...
```

**不应该看到：**
```
[builtin] ⚠️  HTTP protocol detected in ANTHROPIC_BASE_URL: http://...
[builtin] agent loop error: connection refused
```

## 📋 协议支持总结

| 协议 | 支持 | 说明 |
|-----|------|------|
| `https://api.anthropic.com` | ✅ | 正确配置 |
| `http://api.anthropic.com` | ❌ | **会导致错误** |
| `https://custom-endpoint.com` | ✅ | 支持自定义 HTTPS 端点 |
| `http://custom-endpoint.com` | ❌ | **不支持** |

## 🛠️ 为什么不支持 HTTP？

1. **安全要求**：Anthropic API 要求加密连接
2. **TLS 后端**：使用 `rustls-tls`，强制 TLS 连接
3. **API Key 保护**：密钥需要通过加密通道传输
4. **合规性**：符合现代安全标准

## 🔧 技术细节

### reqwest 配置
```toml
reqwest = { version = "0.12", features = ["rustls-tls", ...], default-features = false }
```

### 默认端点
```rust
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
```

## 🆘 如果问题仍然存在

1. **查看完整日志**
   ```bash
   cat ~/Library/Application\ Support/com.pixie.desktop/pixie.log
   ```

2. **运行完整诊断**
   ```bash
   ./scripts/diagnose_builtin.sh
   ```

3. **检查网络连接**
   ```bash
   curl -v https://api.anthropic.com
   ```

4. **验证配置**
   ```bash
   ./scripts/check_url_protocol.sh
   ```

## 📞 获取帮助

- 📖 完整文档：`docs/builtin_engine_protocol_support.md`
- 🔧 诊断工具：`scripts/diagnose_builtin.sh`
- 🔍 URL 检查：`scripts/check_url_protocol.sh`

---

**记住**：内置引擎 **只支持 HTTPS 协议**，HTTP 配置会导致连接失败！
